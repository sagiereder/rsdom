//! Native HTML parsing for jsdom.
//!
//! html5ever (vendored and patched for parse5 parity, see native/vendor/) drives a TreeSink that keeps a tiny
//! arena (just enough structure to answer the tree builder's questions) and records every tree mutation as a flat
//! u32 instruction stream. JS (lib/jsdom/browser/parser/html-native.js) replays the stream in one tight loop,
//! performing exactly the operations jsdom's parse5 tree adapter performs.
//!
//! Wire format (all u32):
//!   ops[0] = index T of the name table, then instructions (see the OP_* constants, mirrored in html-native.js) up to
//!   T; ops[T] = name count N, then N pairs (offset, length) into `strings` (UTF-16 code units).
//! Free-form strings (text, comments, attribute values) are referenced as (offset, length) pairs into `strings`.

use std::borrow::Cow;
use std::cell::{Cell, RefCell};
use std::collections::HashMap;
use std::hash::{BuildHasherDefault, Hasher};

use html5ever::interface::{ElemName, ElementFlags, NodeOrText, QuirksMode, TreeSink};
use html5ever::tendril::{StrTendril, TendrilSink};
use html5ever::tokenizer::TokenizerOpts;
use html5ever::tree_builder::TreeBuilderOpts;
use html5ever::{local_name, ns, Attribute, LocalName, Namespace, ParseOpts, QualName};
use napi::bindgen_prelude::*;
use napi_derive::napi;

pub const OP_ELEMENT: u32 = 1; // id, ns, nameId, nattrs, nattrs * (nameId, ns, prefixId, valOff, valLen)
pub const OP_COMMENT: u32 = 2; // id, off, len
pub const OP_APPEND: u32 = 3; // parent, child
pub const OP_APPEND_TEXT: u32 = 4; // parent, off, len
pub const OP_INSERT_BEFORE: u32 = 5; // reference, child
pub const OP_INSERT_TEXT_BEFORE: u32 = 6; // reference, off, len
pub const OP_DETACH: u32 = 7; // node
pub const OP_REPARENT: u32 = 8; // from, to
pub const OP_PUSH: u32 = 9; // node
pub const OP_POP: u32 = 10; // node, newTop (NONE if empty)
pub const OP_DOCTYPE: u32 = 11; // nameOff, nameLen, pubOff, pubLen, sysOff, sysLen
pub const OP_MODE: u32 = 12; // 0 no-quirks, 1 quirks, 2 limited-quirks
pub const OP_ADD_ATTRS: u32 = 13; // target, nattrs, attrs...

pub const NONE: u32 = u32::MAX;

// Fixed node ids.
const DOCUMENT_ID: u32 = 0;

fn ns_code(ns: &Namespace) -> u32 {
  match *ns {
    ns!() => 0,
    ns!(html) => 1,
    ns!(svg) => 2,
    ns!(mathml) => 3,
    ns!(xlink) => 4,
    ns!(xml) => 5,
    ns!(xmlns) => 6,
    _ => 7, // never produced by the HTML parser
  }
}

#[derive(Clone, Copy, PartialEq)]
enum Kind {
  Document,
  Element,
  Comment,
  Text,
  Fragment,
  Doctype,
}

struct Node {
  kind: Kind,
  name: Option<QualName>,
  parent: u32,
  prev: u32,
  next: u32,
  first: u32,
  last: u32,
  template_contents: u32,
  aip: bool,
}

impl Node {
  fn new(kind: Kind) -> Node {
    Node {
      kind,
      name: None,
      parent: NONE,
      prev: NONE,
      next: NONE,
      first: NONE,
      last: NONE,
      template_contents: NONE,
      aip: false,
    }
  }
}

// Atoms hash to a precomputed 32-bit value, so a trivial multiplicative hasher beats the default SipHash here.
#[derive(Default)]
struct AtomHasher(u64);

impl Hasher for AtomHasher {
  fn finish(&self) -> u64 {
    self.0
  }
  fn write(&mut self, bytes: &[u8]) {
    for &b in bytes {
      self.0 = (self.0.rotate_left(5) ^ b as u64).wrapping_mul(0x51_7c_c1_b7_27_22_0a_95);
    }
  }
  fn write_u32(&mut self, n: u32) {
    self.0 = (self.0.rotate_left(5) ^ n as u64).wrapping_mul(0x51_7c_c1_b7_27_22_0a_95);
  }
  fn write_u64(&mut self, n: u64) {
    self.0 = (self.0.rotate_left(5) ^ n).wrapping_mul(0x51_7c_c1_b7_27_22_0a_95);
  }
}

// Appends `s` to `strings`, returning its (offset, length) in UTF-16 code units.
fn append_string(strings: &mut String, utf16_len: &Cell<u32>, s: &str) -> (u32, u32) {
  let off = utf16_len.get();
  let len = if s.is_ascii() {
    s.len() as u32
  } else {
    s.encode_utf16().count() as u32
  };
  strings.push_str(s);
  utf16_len.set(off + len);
  (off, len)
}

pub struct Sink {
  nodes: RefCell<Vec<Node>>,
  ops: RefCell<Vec<u32>>,
  // Every string the ops reference, and its length in UTF-16 code units.
  strings: RefCell<String>,
  utf16_len: Cell<u32>,
  // The open text node's data, which may still grow (merging), and the index in `ops` of the (off, len) pair that
  // references it; it is appended to `strings` and the pair patched once another text node is created, or at the end.
  pending_text: RefCell<String>,
  pending_ref: Cell<usize>,
  names: RefCell<HashMap<LocalName, u32, BuildHasherDefault<AtomHasher>>>,
  // (offset, length) of each name in `strings`, indexed by name id.
  name_table: RefCell<Vec<u32>>,
  stack: RefCell<Vec<u32>>,
  // Fragment mode: the root <html> element is virtual (it stands for the DocumentFragment, which JS supplies).
  fragment: bool,
  virtual_root: Cell<u32>,
  // Text node that may still be extended in place (reset when anything observable might interleave).
  open_text: Cell<u32>,
  // While set, created elements are parser-internal placeholders (fragment context / form pointer) and not emitted.
  placeholder: Cell<bool>,
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub struct Handle(u32);

pub struct Name<'a>(std::cell::Ref<'a, QualName>);

impl std::fmt::Debug for Name<'_> {
  fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
    self.0.fmt(f)
  }
}

impl ElemName for Name<'_> {
  fn ns(&self) -> &Namespace {
    &self.0.ns
  }
  fn local_name(&self) -> &LocalName {
    &self.0.local
  }
}

impl Sink {
  // `input_len` (in bytes) sizes the buffers, to avoid most reallocations.
  fn new(fragment: bool, input_len: usize) -> Sink {
    let mut names = HashMap::default();
    // Name id 0 is the empty string (used for "no prefix").
    names.insert(LocalName::from(""), 0);
    Sink {
      nodes: RefCell::new(vec![Node::new(Kind::Document)]),
      // ops[0] is reserved for the index of the name table.
      ops: RefCell::new({
        let mut ops = Vec::with_capacity(1024 + input_len / 3);
        ops.push(0);
        ops
      }),
      strings: RefCell::new(String::with_capacity(input_len)),
      utf16_len: Cell::new(0),
      pending_text: RefCell::new(String::new()),
      pending_ref: Cell::new(usize::MAX),
      names: RefCell::new(names),
      name_table: RefCell::new(vec![0, 0]),
      stack: RefCell::new(Vec::new()),
      fragment,
      virtual_root: Cell::new(NONE),
      open_text: Cell::new(NONE),
      placeholder: Cell::new(false),
    }
  }

  fn alloc(&self, node: Node) -> u32 {
    let mut nodes = self.nodes.borrow_mut();
    nodes.push(node);
    (nodes.len() - 1) as u32
  }

  fn name_id(&self, name: &LocalName) -> u32 {
    if let Some(&id) = self.names.borrow().get(name) {
      return id;
    }
    let mut table = self.name_table.borrow_mut();
    let id = (table.len() / 2) as u32;
    let (off, len) = append_string(&mut self.strings.borrow_mut(), &self.utf16_len, name);
    table.push(off);
    table.push(len);
    self.names.borrow_mut().insert(name.clone(), id);
    id
  }

  // Pushes the (off, len) pair of the open text node, patched by `flush_pending_text()`.
  fn push_text_ref(&self, ops: &mut Vec<u32>) {
    self.pending_ref.set(ops.len());
    ops.push(0);
    ops.push(0);
  }

  fn flush_pending_text(&self, ops: &mut [u32]) {
    let idx = self.pending_ref.replace(usize::MAX);
    if idx == usize::MAX {
      return;
    }
    let mut pending = self.pending_text.borrow_mut();
    let (off, len) = append_string(&mut self.strings.borrow_mut(), &self.utf16_len, &pending);
    pending.clear();
    ops[idx] = off;
    ops[idx + 1] = len;
  }

  fn push_str(&self, ops: &mut Vec<u32>, s: &str) {
    let (off, len) = append_string(&mut self.strings.borrow_mut(), &self.utf16_len, s);
    ops.push(off);
    ops.push(len);
  }

  fn push_attrs(&self, ops: &mut Vec<u32>, attrs: &[Attribute]) {
    ops.push(attrs.len() as u32);
    for attr in attrs {
      ops.push(self.name_id(&attr.name.local));
      ops.push(ns_code(&attr.name.ns));
      ops.push(match attr.name.prefix {
        Some(ref p) => self.name_id(&LocalName::from(&**p)),
        None => 0,
      });
      self.push_str(ops, &attr.value);
    }
  }

  // --- arena tree maintenance ---

  fn detach_arena(&self, id: u32) {
    let mut nodes = self.nodes.borrow_mut();
    let (parent, prev, next) = {
      let n = &nodes[id as usize];
      (n.parent, n.prev, n.next)
    };
    if parent == NONE {
      return;
    }
    if prev != NONE {
      nodes[prev as usize].next = next;
    } else {
      nodes[parent as usize].first = next;
    }
    if next != NONE {
      nodes[next as usize].prev = prev;
    } else {
      nodes[parent as usize].last = prev;
    }
    let n = &mut nodes[id as usize];
    n.parent = NONE;
    n.prev = NONE;
    n.next = NONE;
  }

  fn append_arena(&self, parent: u32, child: u32) {
    let mut nodes = self.nodes.borrow_mut();
    let last = nodes[parent as usize].last;
    {
      let c = &mut nodes[child as usize];
      c.parent = parent;
      c.prev = last;
      c.next = NONE;
    }
    if last != NONE {
      nodes[last as usize].next = child;
    } else {
      nodes[parent as usize].first = child;
    }
    nodes[parent as usize].last = child;
  }

  fn insert_before_arena(&self, reference: u32, child: u32) {
    let mut nodes = self.nodes.borrow_mut();
    let parent = nodes[reference as usize].parent;
    let prev = nodes[reference as usize].prev;
    {
      let c = &mut nodes[child as usize];
      c.parent = parent;
      c.prev = prev;
      c.next = reference;
    }
    nodes[reference as usize].prev = child;
    if prev != NONE {
      nodes[prev as usize].next = child;
    } else {
      nodes[parent as usize].first = child;
    }
  }

  // Extends the text node `id` if it is still open for in-place merging; returns whether it did.
  fn try_merge_text(&self, id: u32, text: &str) -> bool {
    if id == NONE || id != self.open_text.get() {
      return false;
    }
    if self.nodes.borrow()[id as usize].kind != Kind::Text {
      return false;
    }
    // The open text node is always the pending one (see `new_text()`).
    self.pending_text.borrow_mut().push_str(text);
    true
  }

  // Creates a text node, which becomes the open (pending) one; the caller must then push its reference with
  // `push_text_ref()`.
  fn new_text(&self, text: &str) -> u32 {
    self.flush_pending_text(&mut self.ops.borrow_mut());
    self.pending_text.borrow_mut().push_str(text);
    let id = self.alloc(Node::new(Kind::Text));
    self.open_text.set(id);
    id
  }

  fn is_virtual(&self, id: u32) -> bool {
    id == self.virtual_root.get()
  }

  fn finish_buffers(self) -> (Vec<u32>, String) {
    self.flush_pending_text(&mut self.ops.borrow_mut());
    let mut ops = self.ops.into_inner();
    let name_table = self.name_table.into_inner();
    ops[0] = ops.len() as u32;
    ops.push((name_table.len() / 2) as u32);
    ops.extend_from_slice(&name_table);
    (ops, self.strings.into_inner())
  }
}

impl TreeSink for Sink {
  type Handle = Handle;
  type Output = Self;
  type ElemName<'a> = Name<'a>;

  fn finish(self) -> Self {
    self
  }

  fn parse_error(&self, _msg: Cow<'static, str>) {}

  fn get_document(&self) -> Handle {
    Handle(DOCUMENT_ID)
  }

  fn elem_name<'a>(&'a self, target: &'a Handle) -> Name<'a> {
    let nodes = self.nodes.borrow();
    Name(std::cell::Ref::map(nodes, |nodes| {
      nodes[target.0 as usize].name.as_ref().expect("not an element")
    }))
  }

  fn create_element(&self, name: QualName, attrs: Vec<Attribute>, flags: ElementFlags) -> Handle {
    let mut node = Node::new(Kind::Element);
    node.aip = flags.mathml_annotation_xml_integration_point;
    let is_template = flags.template;
    let ns = ns_code(&name.ns);
    let name_id = self.name_id(&name.local);
    let placeholder = self.placeholder.get();
    let is_virtual_root = self.fragment
      && !placeholder
      && self.virtual_root.get() == NONE
      && name.ns == ns!(html)
      && name.local == local_name!("html");
    node.name = Some(name);
    let id = self.alloc(node);
    if is_template {
      let contents = self.alloc(Node::new(Kind::Fragment));
      self.nodes.borrow_mut()[id as usize].template_contents = contents;
    }
    if is_virtual_root {
      self.virtual_root.set(id);
      return Handle(id);
    }
    if placeholder {
      return Handle(id);
    }
    let mut ops = self.ops.borrow_mut();
    ops.push(OP_ELEMENT);
    ops.push(id);
    ops.push(ns);
    ops.push(name_id);
    self.push_attrs(&mut ops, &attrs);
    Handle(id)
  }

  fn create_comment(&self, text: StrTendril) -> Handle {
    let id = self.alloc(Node::new(Kind::Comment));
    let mut ops = self.ops.borrow_mut();
    ops.push(OP_COMMENT);
    ops.push(id);
    self.push_str(&mut ops, &text);
    Handle(id)
  }

  fn create_pi(&self, _target: StrTendril, _data: StrTendril) -> Handle {
    // The HTML tree builder never creates processing instructions.
    unreachable!("processing instructions are not produced by the HTML parser")
  }

  fn append(&self, parent: &Handle, child: NodeOrText<Handle>) {
    let parent = parent.0;
    match child {
      NodeOrText::AppendNode(child) => {
        let child = child.0;
        self.detach_arena(child);
        self.append_arena(parent, child);
        if self.is_virtual(child) {
          return;
        }
        let mut ops = self.ops.borrow_mut();
        ops.push(OP_APPEND);
        ops.push(parent);
        ops.push(child);
      }
      NodeOrText::AppendText(text) => {
        let last = self.nodes.borrow()[parent as usize].last;
        if last != NONE && self.nodes.borrow()[last as usize].kind == Kind::Text {
          if self.try_merge_text(last, &text) {
            return;
          }
        }
        let id = self.new_text(&text);
        self.append_arena(parent, id);
        let mut ops = self.ops.borrow_mut();
        ops.push(OP_APPEND_TEXT);
        ops.push(parent);
        self.push_text_ref(&mut ops);
      }
    }
  }

  fn append_based_on_parent_node(&self, element: &Handle, prev_element: &Handle, child: NodeOrText<Handle>) {
    let has_parent = self.nodes.borrow()[element.0 as usize].parent != NONE;
    if has_parent {
      self.append_before_sibling(element, child);
    } else {
      self.append(prev_element, child);
    }
  }

  fn append_doctype_to_document(&self, name: StrTendril, public_id: StrTendril, system_id: StrTendril) {
    let id = self.alloc(Node::new(Kind::Doctype));
    self.append_arena(DOCUMENT_ID, id);
    let mut ops = self.ops.borrow_mut();
    ops.push(OP_DOCTYPE);
    self.push_str(&mut ops, &name);
    self.push_str(&mut ops, &public_id);
    self.push_str(&mut ops, &system_id);
  }

  fn pop(&self, node: &Handle) {
    let id = node.0;
    let new_top = {
      let mut stack = self.stack.borrow_mut();
      if let Some(pos) = stack.iter().rposition(|&x| x == id) {
        stack.remove(pos);
      }
      stack.last().copied().unwrap_or(NONE)
    };
    if self.is_virtual(id) {
      return;
    }
    // The root <html> element of a document is never popped by parse5.
    if !self.fragment && new_top == NONE {
      return;
    }
    // A script runs when popped; never let later text merge into nodes it could have observed.
    self.open_text.set(NONE);
    let mut ops = self.ops.borrow_mut();
    ops.push(OP_POP);
    ops.push(id);
    ops.push(new_top);
  }

  fn push(&self, node: &Handle) {
    let id = node.0;
    self.stack.borrow_mut().push(id);
    if self.is_virtual(id) {
      return;
    }
    let mut ops = self.ops.borrow_mut();
    ops.push(OP_PUSH);
    ops.push(id);
  }

  fn stack_replace(&self, old: &Handle, new: &Handle) {
    let mut stack = self.stack.borrow_mut();
    if let Some(pos) = stack.iter().rposition(|&x| x == old.0) {
      stack[pos] = new.0;
    }
  }

  fn stack_insert_after(&self, reference: &Handle, new: &Handle) {
    let mut stack = self.stack.borrow_mut();
    if let Some(pos) = stack.iter().rposition(|&x| x == reference.0) {
      stack.insert(pos + 1, new.0);
    }
  }

  fn get_template_contents(&self, target: &Handle) -> Handle {
    Handle(self.nodes.borrow()[target.0 as usize].template_contents)
  }

  fn same_node(&self, x: &Handle, y: &Handle) -> bool {
    x.0 == y.0
  }

  fn set_quirks_mode(&self, mode: QuirksMode) {
    if self.fragment {
      return;
    }
    let mut ops = self.ops.borrow_mut();
    ops.push(OP_MODE);
    ops.push(match mode {
      QuirksMode::NoQuirks => 0,
      QuirksMode::Quirks => 1,
      QuirksMode::LimitedQuirks => 2,
    });
  }

  fn append_before_sibling(&self, sibling: &Handle, new_node: NodeOrText<Handle>) {
    let sibling = sibling.0;
    match new_node {
      NodeOrText::AppendNode(child) => {
        let child = child.0;
        let had_parent = self.nodes.borrow()[child as usize].parent != NONE;
        self.detach_arena(child);
        self.insert_before_arena(sibling, child);
        let mut ops = self.ops.borrow_mut();
        if had_parent {
          ops.push(OP_DETACH);
          ops.push(child);
        }
        ops.push(OP_INSERT_BEFORE);
        ops.push(sibling);
        ops.push(child);
      }
      NodeOrText::AppendText(text) => {
        let prev = self.nodes.borrow()[sibling as usize].prev;
        if prev != NONE && self.nodes.borrow()[prev as usize].kind == Kind::Text {
          if self.try_merge_text(prev, &text) {
            return;
          }
        }
        let id = self.new_text(&text);
        self.insert_before_arena(sibling, id);
        let mut ops = self.ops.borrow_mut();
        ops.push(OP_INSERT_TEXT_BEFORE);
        ops.push(sibling);
        self.push_text_ref(&mut ops);
      }
    }
  }

  fn add_attrs_if_missing(&self, target: &Handle, attrs: Vec<Attribute>) {
    // jsdom's parse5 adapter (adoptAttributes) sets every attribute, so pass them all through. In fragment mode the
    // virtual root stands in for parse5's throwaway <html> element, so attributes adopted onto it are invisible.
    if self.is_virtual(target.0) {
      return;
    }
    let mut ops = self.ops.borrow_mut();
    ops.push(OP_ADD_ATTRS);
    ops.push(target.0);
    self.push_attrs(&mut ops, &attrs);
  }

  fn remove_from_parent(&self, target: &Handle) {
    let id = target.0;
    if self.nodes.borrow()[id as usize].parent == NONE {
      return;
    }
    self.detach_arena(id);
    let mut ops = self.ops.borrow_mut();
    ops.push(OP_DETACH);
    ops.push(id);
  }

  fn reparent_children(&self, node: &Handle, new_parent: &Handle) {
    loop {
      let first = self.nodes.borrow()[node.0 as usize].first;
      if first == NONE {
        break;
      }
      self.detach_arena(first);
      self.append_arena(new_parent.0, first);
    }
    let mut ops = self.ops.borrow_mut();
    ops.push(OP_REPARENT);
    ops.push(node.0);
    ops.push(new_parent.0);
  }

  fn is_mathml_annotation_xml_integration_point(&self, handle: &Handle) -> bool {
    self.nodes.borrow()[handle.0 as usize].aip
  }

  fn allow_declarative_shadow_roots(&self, _intended_parent: &Handle) -> bool {
    false
  }
}

#[napi(object)]
pub struct ParsedHtml {
  pub ops: Uint32Array,
  pub strings: String,
  /// Fragment parsing: id of the virtual root <html> element, which stands for the DocumentFragment.
  pub root: u32,
}

fn tree_builder_opts(scripting_enabled: bool) -> ParseOpts {
  ParseOpts {
    tree_builder: TreeBuilderOpts {
      scripting_enabled,
      ..Default::default()
    },
    // jsdom strips any BOM while decoding bytes; a U+FEFF that reaches the parser is content, as in parse5.
    tokenizer: TokenizerOpts {
      discard_bom: false,
      ..Default::default()
    },
  }
}

fn finish(sink: Sink) -> ParsedHtml {
  let root = sink.virtual_root.get();
  let (ops, strings) = sink.finish_buffers();
  ParsedHtml {
    ops: Uint32Array::new(ops),
    strings,
    root,
  }
}

/// Parses a whole HTML document.
#[napi]
pub fn parse_html_document(markup: String, scripting_enabled: bool) -> ParsedHtml {
  let sink = Sink::new(false, markup.len());
  let parser = html5ever::parse_document(sink, tree_builder_opts(scripting_enabled));
  let sink = parser.one(StrTendril::from(markup));
  finish(sink)
}

/// Parses an HTML fragment for the given context element.
/// `context_ns` uses the same namespace codes as the instruction stream. `context_aip` tells whether the context is
/// a MathML annotation-xml HTML integration point; `has_form` whether the parser form element pointer is set.
#[napi]
pub fn parse_html_fragment(
  markup: String,
  context_local_name: String,
  context_ns: u32,
  context_aip: bool,
  has_form: bool,
  scripting_enabled: bool,
) -> ParsedHtml {
  let sink = Sink::new(true, markup.len());
  sink.placeholder.set(true);
  let ns = match context_ns {
    1 => ns!(html),
    2 => ns!(svg),
    3 => ns!(mathml),
    _ => ns!(),
  };
  let context = sink.create_element(
    QualName::new(None, ns, LocalName::from(context_local_name)),
    vec![],
    ElementFlags::default(),
  );
  sink.nodes.borrow_mut()[context.0 as usize].aip = context_aip;
  let form = if has_form {
    Some(sink.create_element(
      QualName::new(None, ns!(html), local_name!("form")),
      vec![],
      ElementFlags::default(),
    ))
  } else {
    None
  };
  sink.placeholder.set(false);
  // parse5 always tokenizes <noscript> fragment contents as RAWTEXT, regardless of the scripting flag.
  let parser =
    html5ever::driver::parse_fragment_for_element(sink, tree_builder_opts(scripting_enabled), context, true, form);
  let sink = parser.one(StrTendril::from(markup));
  finish(sink)
}
