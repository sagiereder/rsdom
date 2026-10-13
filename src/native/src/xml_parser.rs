//! Native XML parsing for jsdom.
//!
//! jsdom parses XML with saxes (src/jsdom/browser/parser/xml.js) and turns the first well-formedness error into an
//! exception whose message (with line and column) is observable, e.g. in DOMParser's parsererror document. This parser
//! does not reproduce saxes's error reporting. Instead it accepts a subset of the documents saxes accepts, and for those
//! produces exactly the events saxes produces. Anything else (any input on which saxes would report an error, but also
//! constructs this parser does not handle, such as line breaks in entity references) makes it return null, and the caller parses the
//! input with saxes again. So the requirement is one-sided: whatever is accepted here must be accepted by saxes, with
//! identical events. Comments below reference the saxes code paths (saxes 6) whose behavior they mirror.
//!
//! saxes options assumed (see xml.js): xmlns: true, XML 1.0 forced, the document or fragment mode, and for fragments
//! a resolvePrefix callback consulted for prefixes not bound inside the fragment.
//!
//! Wire format (all u32): ops[0] = index T of the name table, then instructions (OP_* below, mirrored in
//! xml-native.js) up to T; ops[T] = name count N, then N pairs (offset, length). Name 0 stands for null.
//! Strings are (offset, length) pairs in UTF-16 code units: offsets below the input length refer to the input itself
//! (unmodified slices), the others to `extra` (at offset - input length), which holds strings that had line endings
//! normalized or references expanded, and namespace URIs that do not occur in the input.

use std::collections::HashMap;
use std::hash::{BuildHasherDefault, Hasher};

use napi::bindgen_prelude::*;
use napi_derive::napi;

pub const OP_TEXT: u32 = 1; // off, len
pub const OP_CDATA: u32 = 2; // off, len
pub const OP_COMMENT: u32 = 3; // off, len
pub const OP_PI: u32 = 4; // targetOff, targetLen, off, len
pub const OP_DOCTYPE: u32 = 5; // off, len (the doctype text saxes reports)
pub const OP_OPEN: u32 = 6; // localId, nsId, prefixId, nattrs, nattrs * (localId, nsId, prefixId, valOff, valLen)
pub const OP_CLOSE: u32 = 7;

const XML_NAMESPACE: &str = "http://www.w3.org/XML/1998/namespace";
const XMLNS_NAMESPACE: &str = "http://www.w3.org/2000/xmlns/";

const TAB: u16 = 0x9;
const NL: u16 = 0xA;
const CR: u16 = 0xD;
const SPACE: u16 = 0x20;

#[derive(Default)]
struct FxHasher(u64);

impl Hasher for FxHasher {
  fn finish(&self) -> u64 {
    self.0
  }
  fn write(&mut self, bytes: &[u8]) {
    for &b in bytes {
      self.write_u64(b as u64);
    }
  }
  fn write_u16(&mut self, n: u16) {
    self.write_u64(n as u64);
  }
  fn write_usize(&mut self, n: usize) {
    self.write_u64(n as u64);
  }
  fn write_u64(&mut self, n: u64) {
    self.0 = (self.0.rotate_left(5) ^ n).wrapping_mul(0x51_7c_c1_b7_27_22_0a_95);
  }
}

fn hash_u16(s: &[u16]) -> u64 {
  let mut h: u64 = s.len() as u64;
  for &c in s {
    h = (h.rotate_left(5) ^ c as u64).wrapping_mul(0x51_7c_c1_b7_27_22_0a_95);
  }
  h ^ (h >> 29)
}

type FxMap<K, V> = HashMap<K, V, BuildHasherDefault<FxHasher>>;

// Any failure: saxes would report an error, or this parser does not handle the input.
struct Bail;

type PResult<T> = std::result::Result<T, Bail>;

#[inline]
fn is_s(c: u16) -> bool {
  c == SPACE || c == NL || c == CR || c == TAB
}

// xmlchars/xml/1.0/ed5 isNameStartChar (code points).
fn is_name_start_char(c: u32) -> bool {
  (0x61..=0x7A).contains(&c)
    || (0x41..=0x5A).contains(&c)
    || c == 0x3A
    || c == 0x5F
    || c == 0x200C
    || c == 0x200D
    || (0xC0..=0xD6).contains(&c)
    || (0xD8..=0xF6).contains(&c)
    || (0xF8..=0x2FF).contains(&c)
    || (0x370..=0x37D).contains(&c)
    || (0x37F..=0x1FFF).contains(&c)
    || (0x2070..=0x218F).contains(&c)
    || (0x2C00..=0x2FEF).contains(&c)
    || (0x3001..=0xD7FF).contains(&c)
    || (0xF900..=0xFDCF).contains(&c)
    || (0xFDF0..=0xFFFD).contains(&c)
    || (0x10000..=0xEFFFF).contains(&c)
}

// xmlchars/xml/1.0/ed5 isNameChar.
fn is_name_char(c: u32) -> bool {
  is_name_start_char(c)
    || (0x30..=0x39).contains(&c)
    || c == 0x2D
    || c == 0x2E
    || c == 0xB7
    || (0x300..=0x36F).contains(&c)
    || (0x203F..=0x2040).contains(&c)
}

// xmlchars/xmlns/1.0/ed3 isNCNameStartChar / isNCNameChar: the same without ":".
fn is_ncname_start_char(c: u32) -> bool {
  c != 0x3A && is_name_start_char(c)
}

fn is_ncname_char(c: u32) -> bool {
  c != 0x3A && is_name_char(c)
}

// String.prototype.trim()'s whitespace: WhiteSpace and LineTerminator.
fn is_js_whitespace(c: u16) -> bool {
  matches!(
    c,
    0x9 | 0xA | 0xB | 0xC | 0xD | 0x20 | 0xA0 | 0x1680 | 0x2000..=0x200A | 0x2028 | 0x2029 | 0x202F | 0x205F | 0x3000 | 0xFEFF
  )
}

fn utf16(s: &str) -> Vec<u16> {
  s.encode_utf16().collect()
}

fn eq_ascii(s: &[u16], ascii: &str) -> bool {
  s.len() == ascii.len() && s.iter().zip(ascii.bytes()).all(|(&a, b)| a == b as u16)
}

// The entities saxes predefines.
fn predefined_entity(name: &[u16]) -> Option<u32> {
  if eq_ascii(name, "amp") {
    Some(0x26)
  } else if eq_ascii(name, "lt") {
    Some(0x3C)
  } else if eq_ascii(name, "gt") {
    Some(0x3E)
  } else if eq_ascii(name, "quot") {
    Some(0x22)
  } else if eq_ascii(name, "apos") {
    Some(0x27)
  } else {
    None
  }
}

#[derive(Clone, Copy)]
struct Str {
  off: u32,
  len: u32,
}

struct Binding {
  // The prefix, as a range of the input (empty for the default namespace).
  prefix_start: u32,
  prefix_len: u32,
  // Name id of the URI (0 for the empty string, which undeclares the default namespace).
  uri: u32,
}

struct OpenTag {
  qname_start: u32,
  qname_len: u32,
  bindings_start: usize,
}

struct Attr {
  name_start: u32,
  name_len: u32,
  // Offset of the colon within the name, if any.
  colon: Option<u32>,
  value: Str,
  // Filled in by namespace processing.
  uri: u32,
}

struct Parser<'a, 'f> {
  s: &'a [u16],
  pos: usize,
  fragment: bool,
  resolve_prefix: Option<&'f Function<'f, Utf16String, Option<Utf16String>>>,
  ops: Vec<u32>,
  extra: Vec<u16>,
  // Open addressing hash table of name ids (0: empty slot), keyed by the names' contents; its length is a power of
  // two, at least twice the name count.
  name_slots: Vec<u32>,
  names: Vec<Str>,
  tags: Vec<OpenTag>,
  bindings: Vec<Binding>,
  resolved: FxMap<Box<[u16]>, Option<u32>>,
  attrs: Vec<Attr>,
  xml_ns: u32,
  xmlns_ns: u32,
  saw_root: bool,
  closed_root: bool,
  saw_doctype: bool,
  // Entities defined in the doctype (see define_entities()).
  entities: FxMap<Box<[u16]>, Box<[u16]>>,
}

impl<'a, 'f> Parser<'a, 'f> {
  fn new(s: &'a [u16], resolve_prefix: Option<&'f Function<'f, Utf16String, Option<Utf16String>>>) -> Self {
    let mut parser = Parser {
      s,
      pos: 0,
      fragment: resolve_prefix.is_some(),
      resolve_prefix,
      ops: Vec::with_capacity(s.len() / 4 + 16),
      extra: Vec::new(),
      name_slots: vec![0; 64],
      // Name 0 is null.
      names: vec![Str { off: 0, len: 0 }],
      tags: Vec::new(),
      bindings: Vec::new(),
      resolved: FxMap::default(),
      attrs: Vec::new(),
      xml_ns: 0,
      xmlns_ns: 0,
      // saxes initializes these to true for fragments.
      saw_root: false,
      closed_root: false,
      saw_doctype: false,
      entities: FxMap::default(),
    };
    parser.saw_root = parser.fragment;
    parser.closed_root = parser.fragment;
    parser.ops.push(0); // name table index, patched at the end
    parser
  }

  #[inline]
  fn content(&self, str: Str) -> &[u16] {
    let n = self.s.len();
    let off = str.off as usize;
    if off < n {
      &self.s[off..off + str.len as usize]
    } else {
      &self.extra[off - n..off - n + str.len as usize]
    }
  }

  fn push_extra(&mut self, data: &[u16]) -> Str {
    let off = (self.s.len() + self.extra.len()) as u32;
    self.extra.extend_from_slice(data);
    Str { off, len: data.len() as u32 }
  }

  fn intern(&mut self, str: Str) -> u32 {
    let hash = hash_u16(self.content(str));
    let mask = self.name_slots.len() - 1;
    let mut slot = hash as usize & mask;
    loop {
      let id = self.name_slots[slot];
      if id == 0 {
        break;
      }
      if self.content(self.names[id as usize]) == self.content(str) {
        return id;
      }
      slot = (slot + 1) & mask;
    }
    let id = self.names.len() as u32;
    self.names.push(str);
    self.name_slots[slot] = id;
    if self.names.len() * 2 > self.name_slots.len() {
      self.grow_name_slots();
    }
    id
  }

  fn grow_name_slots(&mut self) {
    let mut slots = vec![0u32; self.name_slots.len() * 2];
    let mask = slots.len() - 1;
    for id in 1..self.names.len() as u32 {
      let mut slot = hash_u16(self.content(self.names[id as usize])) as usize & mask;
      while slots[slot] != 0 {
        slot = (slot + 1) & mask;
      }
      slots[slot] = id;
    }
    self.name_slots = slots;
  }

  // Name ids of the XML and XMLNS namespace URIs, interned on first use.
  fn xml_ns(&mut self) -> u32 {
    if self.xml_ns == 0 {
      let xml = self.push_extra(&utf16(XML_NAMESPACE));
      self.xml_ns = self.intern(xml);
    }
    self.xml_ns
  }

  fn xmlns_ns(&mut self) -> u32 {
    if self.xmlns_ns == 0 {
      let xmlns = self.push_extra(&utf16(XMLNS_NAMESPACE));
      self.xmlns_ns = self.intern(xmlns);
    }
    self.xmlns_ns
  }

  fn intern_input(&mut self, start: u32, len: u32) -> u32 {
    if len == 0 {
      return 0;
    }
    self.intern(Str { off: start, len })
  }

  #[inline]
  fn peek(&self) -> PResult<u16> {
    self.s.get(self.pos).copied().ok_or(Bail)
  }

  // The code point at the current position (inputs with lone surrogates are rejected up front).
  #[inline]
  fn code_point(&self) -> PResult<(u32, usize)> {
    let c = self.peek()? as u32;
    if (0xD800..0xDC00).contains(&c) {
      let low = self.s[self.pos + 1] as u32;
      Ok((0x10000 + ((c - 0xD800) << 10) + (low - 0xDC00), 2))
    } else {
      Ok((c, 1))
    }
  }

  fn skip_spaces(&mut self) {
    while self.pos < self.s.len() && is_s(self.s[self.pos]) {
      self.pos += 1;
    }
  }

  // Consumes name characters; returns the end position. `first` checks the first one.
  fn name(&mut self, first: fn(u32) -> bool, rest: fn(u32) -> bool) -> PResult<usize> {
    let (c, w) = self.code_point()?;
    if !first(c) {
      return Err(Bail);
    }
    self.pos += w;
    self.name_rest(rest);
    Ok(self.pos)
  }

  fn name_rest(&mut self, rest: fn(u32) -> bool) {
    let s = self.s;
    while self.pos < s.len() {
      let c = s[self.pos];
      // Fast path for ASCII name characters.
      if c < 0x80 {
        let b = c as u8;
        if b.is_ascii_alphanumeric() || b == b'-' || b == b'.' || b == b'_' || (b == b':' && rest(0x3A)) {
          self.pos += 1;
          continue;
        }
        return;
      }
      let (cp, w) = match self.code_point() {
        Ok(v) => v,
        Err(_) => return,
      };
      if !rest(cp) {
        return;
      }
      self.pos += w;
    }
  }

  // Characters saxes's getCode10 rejects ("disallowed character."), and lone surrogates, which saxes does not reject
  // but decodes inconsistently (and which cannot be represented in the output anyway).
  fn check_chars(&self) -> PResult<()> {
    let s = self.s;
    let mut i = 0;
    while i < s.len() {
      let c = s[i];
      if c < SPACE {
        if c != TAB && c != NL && c != CR {
          return Err(Bail);
        }
      } else if c >= 0xD800 {
        if c < 0xDC00 {
          if i + 1 >= s.len() || !(0xDC00..0xE000).contains(&s[i + 1]) {
            return Err(Bail);
          }
          i += 1;
        } else if c < 0xE000 || c >= 0xFFFE {
          return Err(Bail);
        }
      }
      i += 1;
    }
    Ok(())
  }

  fn parse(mut self) -> PResult<(Vec<u32>, Vec<u16>)> {
    self.check_chars()?;
    let s = self.s;
    if !self.fragment {
      // sBegin
      if s.first() == Some(&0xFEFF) {
        self.pos = 1;
      }
      // An XML declaration is possible only right at the start (xmlDeclPossible).
      if s.len() >= self.pos + 6 && eq_ascii(&s[self.pos..self.pos + 5], "<?xml") {
        let c = s[self.pos + 5];
        if c == b'?' as u16 || is_s(c) {
          self.pos += 5;
          self.xml_decl()?;
        }
      }
    }
    loop {
      self.text()?;
      if self.pos >= s.len() {
        break;
      }
      // At "<" (sOpenWaka).
      self.pos += 1;
      match self.peek()? {
        0x2F => {
          self.pos += 1;
          self.close_tag()?;
        }
        0x21 => {
          self.pos += 1;
          self.bang()?;
        }
        0x3F => {
          self.pos += 1;
          self.processing_instruction()?;
        }
        _ => self.open_tag()?,
      }
    }
    // end()
    if !self.saw_root || !self.tags.is_empty() {
      return Err(Bail);
    }
    let table = self.ops.len() as u32;
    self.ops[0] = table;
    self.ops.push(self.names.len() as u32);
    for name in &self.names {
      self.ops.push(name.off);
      self.ops.push(name.len);
    }
    Ok((self.ops, self.extra))
  }

  // Character data up to the next "<" or the end (handleTextInRoot / handleTextOutsideRoot). saxes reports it as
  // one text event when it reaches "<" or the end, if non-empty.
  fn text(&mut self) -> PResult<()> {
    let s = self.s;
    let in_root = !self.tags.is_empty();
    // Outside the root element of a document, only white space is allowed ("text data outside of root node."), and
    // jsdom ignores it.
    if !in_root && !self.fragment {
      while self.pos < s.len() {
        let c = s[self.pos];
        if c == b'<' as u16 {
          return Ok(());
        }
        if !is_s(c) {
          return Err(Bail);
        }
        self.pos += 1;
      }
      return Ok(());
    }
    let start = self.pos;
    // Start of the not yet copied raw segment, once the text is being built in `extra`.
    let mut built: Option<usize> = None;
    let mut seg = start;
    // Consecutive "]" just seen, for the "]]>" check (in the root element only).
    let mut brackets = 0u32;
    while self.pos < s.len() {
      let c = s[self.pos];
      match c {
        0x3C => break,
        0x26 => {
          built.get_or_insert(self.extra.len());
          self.extra.extend_from_slice(&s[seg..self.pos]);
          self.entity()?;
          seg = self.pos;
          brackets = 0;
        }
        CR => {
          built.get_or_insert(self.extra.len());
          self.extra.extend_from_slice(&s[seg..self.pos]);
          self.extra.push(NL);
          self.pos += 1;
          if self.pos < s.len() && s[self.pos] == NL {
            self.pos += 1;
          }
          seg = self.pos;
          brackets = 0;
        }
        0x5D => {
          brackets += 1;
          self.pos += 1;
        }
        0x3E => {
          if in_root && brackets >= 2 {
            return Err(Bail);
          }
          brackets = 0;
          self.pos += 1;
        }
        _ => {
          brackets = 0;
          self.pos += 1;
        }
      }
    }
    let str = match built {
      None => Str { off: start as u32, len: (self.pos - start) as u32 },
      Some(b) => {
        self.extra.extend_from_slice(&s[seg..self.pos]);
        Str { off: (s.len() + b) as u32, len: (self.extra.len() - b) as u32 }
      }
    };
    if str.len != 0 {
      self.ops.extend_from_slice(&[OP_TEXT, str.off, str.len]);
    }
    Ok(())
  }

  // At "&": appends the expansion to `extra` (sEntity, parseEntity).
  fn entity(&mut self) -> PResult<()> {
    let s = self.s;
    let start = self.pos + 1;
    let mut end = start;
    while end < s.len() && s[end] != b';' as u16 {
      end += 1;
    }
    if end >= s.len() {
      return Err(Bail);
    }
    let name = &s[start..end];
    self.pos = end + 1;
    if name.contains(&CR) {
      // saxes would normalize the line ending in the name.
      return Err(Bail);
    }
    let ch: u32 = if let Some(ch) = predefined_entity(name) {
      ch
    } else if name.len() >= 2 && name[0] == b'#' as u16 {
      // /^#x[0-9a-f]+$/i (with a lowercase x, checked first) or /^#[0-9]+$/.
      let (digits, radix) = if name[1] == b'x' as u16 { (&name[2..], 16) } else { (&name[1..], 10) };
      if digits.is_empty() {
        return Err(Bail);
      }
      let mut value: u32 = 0;
      for &d in digits {
        let digit = (d < 0x80).then(|| (d as u8 as char).to_digit(radix)).flatten().ok_or(Bail)?;
        value = value.saturating_mul(radix).saturating_add(digit);
      }
      // isChar10
      let ok = value == 0x9
        || value == 0xA
        || value == 0xD
        || (0x20..=0xD7FF).contains(&value)
        || (0xE000..=0xFFFD).contains(&value)
        || (0x10000..=0x10FFFF).contains(&value);
      if !ok {
        return Err(Bail);
      }
      value
    } else if name.first() == Some(&(b'#' as u16)) {
      return Err(Bail);
    } else if let Some(value) = self.entities.get(name) {
      // Inserted as is: saxes does not parse entity values.
      self.extra.extend_from_slice(value);
      return Ok(());
    } else {
      return Err(Bail);
    };
    if ch >= 0x10000 {
      let v = ch - 0x10000;
      self.extra.push(0xD800 + (v >> 10) as u16);
      self.extra.push(0xDC00 + (v & 0x3FF) as u16);
    } else {
      self.extra.push(ch as u16);
    }
    Ok(())
  }

  // The input range with line endings normalized (CR LF and lone CR become LF), as saxes's getCode does.
  fn normalized(&mut self, start: usize, end: usize) -> Str {
    let s = self.s;
    let raw = &s[start..end];
    let Some(first_cr) = raw.iter().position(|&c| c == CR) else {
      return Str { off: start as u32, len: (end - start) as u32 };
    };
    let b = self.extra.len();
    self.extra.extend_from_slice(&raw[..first_cr]);
    let mut i = first_cr;
    while i < raw.len() {
      let c = raw[i];
      if c == CR {
        self.extra.push(NL);
        if i + 1 < raw.len() && raw[i + 1] == NL {
          i += 1;
        }
      } else {
        self.extra.push(c);
      }
      i += 1;
    }
    Str { off: (s.len() + b) as u32, len: (self.extra.len() - b) as u32 }
  }

  fn find(&self, from: usize, pattern: &[u16]) -> PResult<usize> {
    let s = self.s;
    let first = pattern[0];
    let mut i = from;
    while i + pattern.len() <= s.len() {
      if s[i] == first && &s[i..i + pattern.len()] == pattern {
        return Ok(i);
      }
      i += 1;
    }
    Err(Bail)
  }

  // After "<!" (sOpenWakaBang).
  fn bang(&mut self) -> PResult<()> {
    let s = self.s;
    let rest = &s[self.pos..];
    let starts = |p: &str| rest.len() >= p.len() && eq_ascii(&rest[..p.len()], p);
    if starts("--") {
      // sComment: the comment ends at the first "--", which must be followed by ">".
      let start = self.pos + 2;
      let end = self.find(start, &[0x2D, 0x2D])?;
      if s.get(end + 2) != Some(&(b'>' as u16)) {
        return Err(Bail);
      }
      let str = self.normalized(start, end);
      self.ops.extend_from_slice(&[OP_COMMENT, str.off, str.len]);
      self.pos = end + 3;
    } else if starts("[CDATA[") {
      // CDATA outside the root element of a document: "text data outside of root node."
      if self.tags.is_empty() && !self.fragment {
        return Err(Bail);
      }
      let start = self.pos + 7;
      let end = self.find(start, &[0x5D, 0x5D, 0x3E])?;
      let str = self.normalized(start, end);
      self.ops.extend_from_slice(&[OP_CDATA, str.off, str.len]);
      self.pos = end + 3;
    } else if starts("DOCTYPE") {
      // "inappropriately located doctype declaration." (sawRoot is always true for fragments)
      if self.saw_doctype || self.saw_root {
        return Err(Bail);
      }
      self.saw_doctype = true;
      let start = self.pos + 7;
      let end = self.doctype_end(start)?;
      let str = self.normalized(start, end);
      self.define_entities(str);
      self.ops.extend_from_slice(&[OP_DOCTYPE, str.off, str.len]);
      self.pos = end + 1;
    } else {
      return Err(Bail);
    }
    Ok(())
  }

  // Returns the position of the ">" ending a doctype declaration whose text starts at `start`, following saxes's
  // states (sDoctype, sDoctypeQuote, sDTD, sDTDQuoted, sDTDOpenWaka, sDTDOpenWakaBang, sDTDComment*, sDTDPI*). The
  // internal subset is not parsed, only skipped with these rules. Line ending normalization does not affect them: a
  // CR LF pair consumed as one character where a CR alone is consumed here leaves an LF that changes no state.
  fn doctype_end(&self, start: usize) -> PResult<usize> {
    let s = self.s;
    let at = |i: usize| s.get(i).copied().ok_or(Bail);
    let mut i = start;
    loop {
      // sDoctype
      let c = at(i)?;
      i += 1;
      match c {
        0x3E => return Ok(i - 1),
        0x22 | 0x27 => {
          while at(i)? != c {
            i += 1;
          }
          i += 1;
        }
        0x5B => {
          // sDTD, until "]".
          loop {
            let c = at(i)?;
            i += 1;
            match c {
              0x5D => break,
              0x22 | 0x27 => {
                while at(i)? != c {
                  i += 1;
                }
                i += 1;
              }
              0x3C => {
                // sDTDOpenWaka: the next character is consumed whatever it is.
                let c = at(i)?;
                i += 1;
                if c == b'!' as u16 {
                  // sDTDOpenWakaBang: one character, or two after "-".
                  let c = at(i)?;
                  i += 1;
                  if c == b'-' as u16 {
                    let c = at(i)?;
                    i += 1;
                    if c == b'-' as u16 {
                      // sDTDComment: up to "--", which must be followed by ">" ("malformed comment.").
                      loop {
                        while at(i)? != b'-' as u16 {
                          i += 1;
                        }
                        i += 1;
                        let c = at(i)?;
                        i += 1;
                        if c == b'-' as u16 {
                          if at(i)? != b'>' as u16 {
                            return Err(Bail);
                          }
                          i += 1;
                          break;
                        }
                      }
                    }
                  }
                } else if c == b'?' as u16 {
                  // sDTDPI, sDTDPIEnding: up to "?", then up to ">".
                  while at(i)? != b'?' as u16 {
                    i += 1;
                  }
                  while at(i)? != b'>' as u16 {
                    i += 1;
                  }
                  i += 1;
                }
              }
              _ => {}
            }
          }
        }
        _ => {}
      }
    }
  }

  // xml.js defines an entity for each match of /<!ENTITY ([^ ]+) "([^"]+)">/g in the doctype text, unless an entity
  // of that name exists (the predefined ones, or an earlier definition).
  fn define_entities(&mut self, text: Str) {
    let text = self.content(text).to_vec();
    let pattern = utf16("<!ENTITY ");
    let mut i = 0;
    while i + pattern.len() <= text.len() {
      if text[i..i + pattern.len()] != pattern[..] {
        i += 1;
        continue;
      }
      let name_start = i + pattern.len();
      let mut j = name_start;
      while j < text.len() && text[j] != SPACE {
        j += 1;
      }
      let name_end = j;
      if name_end > name_start && text.get(j) == Some(&SPACE) && text.get(j + 1) == Some(&(b'"' as u16)) {
        let value_start = j + 2;
        let mut k = value_start;
        while k < text.len() && text[k] != b'"' as u16 {
          k += 1;
        }
        if k > value_start && text.get(k + 1) == Some(&(b'>' as u16)) {
          let name = &text[name_start..name_end];
          if predefined_entity(name).is_none() && !self.entities.contains_key(name) {
            self.entities.insert(name.into(), text[value_start..k].into());
          }
          i = k + 2;
          continue;
        }
      }
      i += 1;
    }
  }

  // After "<?" (sPIFirstChar, sPIRest, sPIBody, sPIEnding).
  fn processing_instruction(&mut self) -> PResult<()> {
    let s = self.s;
    let target_start = self.pos;
    let target_end = self.name(is_ncname_start_char, is_ncname_char)?;
    let c = self.peek()?;
    if c != b'?' as u16 && !is_s(c) {
      return Err(Bail);
    }
    let target = &s[target_start..target_end];
    // "xml" here is a misplaced XML declaration; any case variant of it is rejected when the PI ends. Rejecting every
    // short target with a non-ASCII character too keeps this independent of toLowerCase()'s Unicode mappings.
    if target.len() <= 3
      && (target.iter().any(|&c| c >= 0x80)
        || target.iter().map(|&c| (c as u8).to_ascii_lowercase()).eq("xml".bytes()))
    {
      return Err(Bail);
    }
    // The body starts at the first non-space character after the target and ends at the first "?>" from there.
    self.skip_spaces();
    let body_start = self.pos;
    let body_end = self.find(body_start, &[0x3F, 0x3E])?;
    let body = self.normalized(body_start, body_end);
    self.ops.extend_from_slice(&[
      OP_PI,
      target_start as u32,
      (target_end - target_start) as u32,
      body.off,
      body.len,
    ]);
    self.pos = body_end + 2;
    Ok(())
  }

  // After "<?xml", followed by white space or "?" (sXMLDeclNameStart ... sXMLDeclEnding). Accepts
  //   S version Eq "1.x" (S encoding Eq "enc")? (S standalone Eq "yes|no")? S? ?>
  // with either quote; Eq is S? = S?.
  fn xml_decl(&mut self) -> PResult<()> {
    let s = self.s;
    // 0: expecting version, 1: encoding or standalone, 2: standalone, 3: nothing more.
    let mut expects = 0;
    loop {
      self.skip_spaces();
      if self.peek()? == b'?' as u16 {
        self.pos += 1;
        if self.peek()? != b'>' as u16 || expects == 0 {
          return Err(Bail);
        }
        self.pos += 1;
        return Ok(());
      }
      let name_start = self.pos;
      while self.pos < s.len() {
        let c = s[self.pos];
        if c == b'=' as u16 || c == b'?' as u16 || is_s(c) {
          break;
        }
        self.pos += 1;
      }
      let name = &s[name_start..self.pos];
      let which = if eq_ascii(name, "version") {
        0
      } else if eq_ascii(name, "encoding") {
        1
      } else if eq_ascii(name, "standalone") {
        2
      } else {
        return Err(Bail);
      };
      let allowed = match expects {
        0 => which == 0,
        1 => which == 1 || which == 2,
        2 => which == 2,
        _ => false,
      };
      if !allowed {
        return Err(Bail);
      }
      self.skip_spaces();
      if self.peek()? != b'=' as u16 {
        return Err(Bail);
      }
      self.pos += 1;
      self.skip_spaces();
      let q = self.peek()?;
      if q != b'"' as u16 && q != b'\'' as u16 {
        return Err(Bail);
      }
      self.pos += 1;
      let value_start = self.pos;
      while self.peek()? != q {
        self.pos += 1;
      }
      let value: Vec<u8> = s[value_start..self.pos]
        .iter()
        .map(|&c| if c < 0x80 { c as u8 } else { 0 })
        .collect();
      self.pos += 1;
      let valid = match which {
        // /^1\.[0-9]+$/
        0 => value.len() >= 3 && value[0] == b'1' && value[1] == b'.' && value[2..].iter().all(u8::is_ascii_digit),
        // /^[A-Za-z][A-Za-z0-9._-]*$/
        1 => {
          !value.is_empty()
            && value[0].is_ascii_alphabetic()
            && value.iter().all(|&b| b.is_ascii_alphanumeric() || b == b'.' || b == b'_' || b == b'-')
        }
        _ => value == b"yes" || value == b"no",
      };
      if !valid {
        return Err(Bail);
      }
      expects = which + 1;
      // sXMLDeclSeparator: "?" or white space.
      let c = self.peek()?;
      if c != b'?' as u16 && !is_s(c) {
        return Err(Bail);
      }
    }
  }

  // At the first character of a start tag's name (sOpenTag, sAttrib*, processAttribsNS, openTag).
  fn open_tag(&mut self) -> PResult<()> {
    let s = self.s;
    let qname_start = self.pos;
    let qname_end = self.name(is_name_start_char, is_name_char)?;
    let c = self.peek()?;
    if c != b'>' as u16 && c != b'/' as u16 && !is_s(c) {
      return Err(Bail);
    }
    // "documents may contain only one root."
    if !self.fragment && self.closed_root {
      return Err(Bail);
    }
    self.saw_root = true;

    self.attrs.clear();
    let self_closing;
    loop {
      self.skip_spaces();
      let c = self.peek()?;
      if c == b'>' as u16 {
        self.pos += 1;
        self_closing = false;
        break;
      }
      if c == b'/' as u16 {
        self.pos += 1;
        if self.peek()? != b'>' as u16 {
          return Err(Bail);
        }
        self.pos += 1;
        self_closing = true;
        break;
      }
      let name_start = self.pos;
      let name_end = self.name(is_name_start_char, is_name_char)?;
      self.skip_spaces();
      if self.peek()? != b'=' as u16 {
        return Err(Bail);
      }
      self.pos += 1;
      self.skip_spaces();
      let q = self.peek()?;
      if q != b'"' as u16 && q != b'\'' as u16 {
        return Err(Bail);
      }
      self.pos += 1;
      let value = self.attribute_value(q)?;
      // sAttribValueClosed: white space, ">" or "/" must follow.
      let c = self.peek()?;
      if c != b'>' as u16 && c != b'/' as u16 && !is_s(c) {
        return Err(Bail);
      }
      let name = &s[name_start..name_end];
      let colon = name.iter().position(|&c| c == b':' as u16).map(|i| i as u32);
      self.attrs.push(Attr {
        name_start: name_start as u32,
        name_len: (name_end - name_start) as u32,
        colon,
        value,
        uri: 0,
      });
    }

    let bindings_start = self.bindings.len();
    self.process_namespaces(qname_start as u32, (qname_end - qname_start) as u32)?;

    if self_closing {
      self.ops.push(OP_CLOSE);
      self.bindings.truncate(bindings_start);
      if self.tags.is_empty() {
        self.closed_root = true;
      }
    } else {
      self.tags.push(OpenTag {
        qname_start: qname_start as u32,
        qname_len: (qname_end - qname_start) as u32,
        bindings_start,
      });
    }
    Ok(())
  }

  // After the opening quote (sAttribValueQuoted): TAB, LF and CR (LF) become a space; "<" is not allowed.
  fn attribute_value(&mut self, q: u16) -> PResult<Str> {
    let s = self.s;
    let start = self.pos;
    let mut built: Option<usize> = None;
    let mut seg = start;
    loop {
      let c = self.peek()?;
      if c == q {
        break;
      }
      match c {
        0x26 => {
          built.get_or_insert(self.extra.len());
          self.extra.extend_from_slice(&s[seg..self.pos]);
          self.entity()?;
          seg = self.pos;
        }
        TAB | NL | CR => {
          built.get_or_insert(self.extra.len());
          self.extra.extend_from_slice(&s[seg..self.pos]);
          self.extra.push(SPACE);
          self.pos += 1;
          if c == CR && self.pos < s.len() && s[self.pos] == NL {
            self.pos += 1;
          }
          seg = self.pos;
        }
        0x3C => return Err(Bail),
        _ => self.pos += 1,
      }
    }
    let str = match built {
      None => Str { off: start as u32, len: (self.pos - start) as u32 },
      Some(b) => {
        self.extra.extend_from_slice(&s[seg..self.pos]);
        Str { off: (s.len() + b) as u32, len: (self.extra.len() - b) as u32 }
      }
    };
    self.pos += 1;
    Ok(str)
  }

  // saxes's qname(): splits at the first colon; fails if either part is empty or the local part has another colon.
  fn split_qname(name: &[u16]) -> PResult<Option<usize>> {
    match name.iter().position(|&c| c == b':' as u16) {
      None => Ok(None),
      Some(i) => {
        if i == 0 || i + 1 == name.len() || name[i + 1..].contains(&(b':' as u16)) {
          Err(Bail)
        } else {
          Ok(Some(i))
        }
      }
    }
  }

  // nsPairCheck
  fn ns_pair_check(&self, prefix: &[u16], uri: &[u16]) -> PResult<()> {
    let is_xml_uri = eq_ascii(uri, XML_NAMESPACE);
    let is_xmlns_uri = eq_ascii(uri, XMLNS_NAMESPACE);
    if eq_ascii(prefix, "xml") && !is_xml_uri {
      return Err(Bail);
    }
    if eq_ascii(prefix, "xmlns") && !is_xmlns_uri {
      return Err(Bail);
    }
    if is_xmlns_uri {
      return Err(Bail);
    }
    if is_xml_uri && !eq_ascii(prefix, "xml") {
      return Err(Bail);
    }
    Ok(())
  }

  // saxes's resolve(): the current tag's declarations, then the open tags' (innermost first), then the xml and xmlns
  // prefixes, then (fragments) the resolvePrefix option. Returns a name id (0 for the empty string).
  fn resolve(&mut self, prefix_start: u32, prefix_len: u32) -> PResult<Option<u32>> {
    let s = self.s;
    let prefix = &s[prefix_start as usize..(prefix_start + prefix_len) as usize];
    for binding in self.bindings.iter().rev() {
      if binding.prefix_len == prefix_len
        && &s[binding.prefix_start as usize..(binding.prefix_start + binding.prefix_len) as usize] == prefix
      {
        return Ok(Some(binding.uri));
      }
    }
    if eq_ascii(prefix, "xml") {
      return Ok(Some(self.xml_ns()));
    }
    if eq_ascii(prefix, "xmlns") {
      return Ok(Some(self.xmlns_ns()));
    }
    let Some(resolve_prefix) = self.resolve_prefix else {
      return Ok(None);
    };
    if let Some(&cached) = self.resolved.get(prefix) {
      return Ok(cached);
    }
    let result = resolve_prefix.call(Utf16String::from(prefix.to_vec())).map_err(|_| Bail)?;
    let id = match result {
      // jsdom's resolvePrefix returns a non-empty string or undefined.
      Some(uri) if !uri.is_empty() => {
        let str = self.push_extra(&uri);
        Some(self.intern(str))
      }
      _ => None,
    };
    self.resolved.insert(prefix.into(), id);
    Ok(id)
  }

  // pushAttribNS for the namespace declarations, then processAttribsNS; emits the start tag.
  fn process_namespaces(&mut self, qname_start: u32, qname_len: u32) -> PResult<()> {
    let s = self.s;
    let attrs = std::mem::take(&mut self.attrs);
    for attr in &attrs {
      let name = &s[attr.name_start as usize..(attr.name_start + attr.name_len) as usize];
      Self::split_qname(name)?;
      let is_prefixed_decl = attr.colon == Some(5) && eq_ascii(&name[..5], "xmlns");
      if is_prefixed_decl || eq_ascii(name, "xmlns") {
        let value = self.content(attr.value);
        let first = value.iter().position(|&c| !is_js_whitespace(c)).unwrap_or(value.len());
        let last = value.iter().rposition(|&c| !is_js_whitespace(c)).map_or(first, |i| i + 1);
        let trimmed = &value[first..last];
        let (prefix_start, prefix_len) = if is_prefixed_decl {
          // "invalid attempt to undefine prefix in XML 1.0"
          if trimmed.is_empty() {
            return Err(Bail);
          }
          (attr.name_start + 6, attr.name_len - 6)
        } else {
          (attr.name_start, 0)
        };
        let prefix = &s[prefix_start as usize..(prefix_start + prefix_len) as usize];
        self.ns_pair_check(prefix, trimmed)?;
        let uri = if trimmed.is_empty() {
          0
        } else {
          self.intern(Str { off: attr.value.off + first as u32, len: (last - first) as u32 })
        };
        self.bindings.push(Binding { prefix_start, prefix_len, uri });
      }
    }

    let qname = &s[qname_start as usize..(qname_start + qname_len) as usize];
    let (local_start, local_len, prefix_len) = match Self::split_qname(qname)? {
      None => (qname_start, qname_len, 0),
      Some(i) => (qname_start + i as u32 + 1, qname_len - i as u32 - 1, i as u32),
    };
    let uri = self.resolve(qname_start, prefix_len)?;
    if prefix_len != 0 {
      // "tags may not have "xmlns" as prefix." / "unbound namespace prefix"
      if eq_ascii(&qname[..prefix_len as usize], "xmlns") || uri.unwrap_or(0) == 0 {
        return Err(Bail);
      }
    }
    let ns = uri.unwrap_or(0);
    let local = self.intern_input(local_start, local_len);
    let prefix = self.intern_input(qname_start, prefix_len);
    self.ops.extend_from_slice(&[OP_OPEN, local, ns, prefix, attrs.len() as u32]);

    let mut attrs = attrs;
    for a in 0..attrs.len() {
      let attr = &attrs[a];
      let uri = match attr.colon {
        None => {
          if eq_ascii(&s[attr.name_start as usize..(attr.name_start + attr.name_len) as usize], "xmlns") {
            self.xmlns_ns()
          } else {
            0
          }
        }
        Some(colon) => self.resolve(attr.name_start, colon)?.ok_or(Bail)?,
      };
      attrs[a].uri = uri;
      // "duplicate attribute": by name without a prefix, by {uri}local with one.
      let attr = &attrs[a];
      let name = &s[attr.name_start as usize..(attr.name_start + attr.name_len) as usize];
      for other in &attrs[..a] {
        let other_name = &s[other.name_start as usize..(other.name_start + other.name_len) as usize];
        let duplicate = match (attr.colon, other.colon) {
          (None, None) => name == other_name,
          (Some(c1), Some(c2)) => other.uri == uri && name[c1 as usize + 1..] == other_name[c2 as usize + 1..],
          _ => false,
        };
        if duplicate {
          return Err(Bail);
        }
      }
      let (local_start, local_len, prefix_len) = match attr.colon {
        None => (attr.name_start, attr.name_len, 0),
        Some(c) => (attr.name_start + c + 1, attr.name_len - c - 1, c),
      };
      let value = attr.value;
      let local = self.intern_input(local_start, local_len);
      let prefix = self.intern_input(attr.name_start, prefix_len);
      self.ops.extend_from_slice(&[local, uri, prefix, value.off, value.len]);
    }
    self.attrs = attrs;
    Ok(())
  }

  // After "</" (sCloseTag, sCloseTagSawWhite, closeTag): the name must match the innermost open element's.
  fn close_tag(&mut self) -> PResult<()> {
    let s = self.s;
    let start = self.pos;
    self.name_rest(is_name_char);
    let end = self.pos;
    self.skip_spaces();
    if self.peek()? != b'>' as u16 {
      return Err(Bail);
    }
    self.pos += 1;
    let tag = self.tags.pop().ok_or(Bail)?;
    let open = &s[tag.qname_start as usize..(tag.qname_start + tag.qname_len) as usize];
    if start == end || open != &s[start..end] {
      return Err(Bail);
    }
    self.bindings.truncate(tag.bindings_start);
    self.ops.push(OP_CLOSE);
    if self.tags.is_empty() {
      self.closed_root = true;
    }
    Ok(())
  }
}

thread_local! {
  // The instruction stream of the last parse, when it did not fit in the caller's buffer; see take_xml_ops().
  static OVERFLOW: std::cell::RefCell<Vec<u32>> = const { std::cell::RefCell::new(Vec::new()) };
}

/// Parses an XML document, or with `resolve_prefix`, a fragment. Returns null when the input must be parsed by saxes
/// instead (see the module comment). Otherwise, returns the extra strings, and writes the instruction stream to `out`
/// if it fits; if not, `out[0]` is set to 0 (unless `out` is empty) and the stream is returned by the next take_xml_ops()
/// call. Reusing the caller's buffer avoids creating a typed array per parse, which dominates the cost of parsing small
/// inputs. The caller sizes `out` with xml_ops_buffer_length().
#[napi]
pub fn parse_xml(
  markup: Utf16String,
  resolve_prefix: Option<Function<Utf16String, Option<Utf16String>>>,
  mut out: Uint32ArraySlice,
) -> Option<Utf16String> {
  let parser = Parser::new(&markup, resolve_prefix.as_ref());
  match parser.parse() {
    Ok((ops, extra)) => {
      // SAFETY: the slice is the caller's typed array, which no other code accesses during this call.
      let out = unsafe { out.as_mut() };
      if ops.len() <= out.len() {
        out[..ops.len()].copy_from_slice(&ops);
      } else {
        if let Some(first) = out.first_mut() {
          *first = 0;
        }
        OVERFLOW.with(|overflow| *overflow.borrow_mut() = ops);
      }
      Some(Utf16String::from(extra))
    }
    Err(Bail) => None,
  }
}

/// The length of the buffer to pass to parse_xml(). In the WebAssembly build it is 0, so that every stream is returned
/// by take_xml_ops(): there, a typed array argument is a copy in the module's memory (emnapi copies it in), and writes
/// to it never reach the caller's array.
#[napi]
pub fn xml_ops_buffer_length() -> u32 {
  if cfg!(target_family = "wasm") { 0 } else { 8192 }
}

/// The instruction stream of the last parse_xml() call whose stream did not fit in its buffer.
#[napi]
pub fn take_xml_ops() -> Uint32Array {
  Uint32Array::new(OVERFLOW.with(|overflow| std::mem::take(&mut *overflow.borrow_mut())))
}
