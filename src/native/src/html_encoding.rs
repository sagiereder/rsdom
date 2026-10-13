//! Decoding HTML bytes for jsdom: encoding sniffing and decoding (with encoding_rs), so that bytes go to the native
//! HTML parser without first becoming a JS string.
//!
//! The sniffing is a port of html-encoding-sniffer (what jsdom uses without the addon), quirks included, so both give
//! the same `document.characterSet`: https://html.spec.whatwg.org/multipage/parsing.html#encoding-sniffing-algorithm
//! (BOM, then the transport-layer label, then the prescan; the caller supplies the default). Decoding follows
//! https://encoding.spec.whatwg.org/#decode (a BOM overrides the given encoding and is stripped), like
//! @exodus/bytes's legacyHookDecode.

use std::borrow::Cow;

use encoding_rs::Encoding;
use napi::bindgen_prelude::*;
use napi_derive::napi;

use crate::html_parser::{parse_document_str, ParsedHtml};

const MAX_PRESCAN_BYTES: usize = 1024;

fn bom_encoding(b: &[u8]) -> Option<&'static Encoding> {
  if b.starts_with(b"\xEF\xBB\xBF") {
    Some(encoding_rs::UTF_8)
  } else if b.starts_with(b"\xFF\xFE") {
    Some(encoding_rs::UTF_16LE)
  } else if b.starts_with(b"\xFE\xFF") {
    Some(encoding_rs::UTF_16BE)
  } else {
    None
  }
}

fn is_space(c: Option<u8>) -> bool {
  matches!(c, Some(0x09 | 0x0A | 0x0C | 0x0D | 0x20))
}

fn lower(c: u8) -> u8 {
  c.to_ascii_lowercase()
}

struct Attr {
  name: Vec<u8>,
  value: Vec<u8>,
}

// https://html.spec.whatwg.org/multipage/syntax.html#concept-get-attributes-when-sniffing, as html-encoding-sniffer
// implements it. Returns the attribute (if any) and the new position; positions at or past `l` are all equivalent.
fn get_attribute(b: &[u8], mut i: usize, l: usize) -> (Option<Attr>, usize) {
  let at = |i: usize| b.get(i).copied().filter(|_| i < l);
  while i < l {
    let mut c = b[i];
    if is_space(Some(c)) || c == b'/' {
      i += 1;
      continue;
    }
    if c == b'>' {
      break;
    }
    let mut name = Vec::new();
    let mut value = Vec::new();
    'name: while i < l {
      c = b[i];
      if c == b'=' && !name.is_empty() {
        i += 1;
        break;
      }
      if is_space(Some(c)) {
        i += 1;
        while i < l {
          c = b[i];
          if is_space(Some(c)) {
            i += 1;
            continue;
          }
          if c != b'=' {
            return (Some(Attr { name, value }), i);
          }
          i += 1;
          break 'name;
        }
        break;
      }
      if c == b'/' || c == b'>' {
        return (Some(Attr { name, value }), i);
      }
      name.push(lower(c));
      i += 1;
    }
    let mut c = at(i);
    if is_space(c) {
      i += 1;
      while i < l {
        c = Some(b[i]);
        if is_space(c) {
          i += 1;
        } else {
          break;
        }
      }
      if i >= l {
        c = None;
      }
    }
    if let Some(quote @ (b'"' | b'\'')) = c {
      i += 1;
      while i < l {
        let c = b[i];
        if c == quote {
          i += 1;
          return (Some(Attr { name, value }), i);
        }
        value.push(lower(c));
        i += 1;
      }
      // Unterminated quote: html-encoding-sniffer goes on with the (absent) byte at the end.
      return (None, i + 1);
    }
    match c {
      Some(b'>') => return (Some(Attr { name, value }), i),
      Some(c) => value.push(lower(c)),
      None => return (None, i + 1),
    }
    i += 1;
    while i < l {
      let c = b[i];
      if is_space(Some(c)) || c == b'>' {
        return (Some(Attr { name, value }), i);
      }
      value.push(lower(c));
      i += 1;
    }
    return (None, i + 1);
  }
  (None, i)
}

// https://html.spec.whatwg.org/multipage/urls-and-fetching.html#algorithm-for-extracting-a-character-encoding-from-a-meta-element
// `s` is already ASCII-lowercased.
fn extract_from_meta(s: &[u8]) -> Option<&'static Encoding> {
  let mut position = 0;
  loop {
    let idx = s[position..].windows(7).position(|w| w == b"charset")?;
    let mut sub = position + idx + 7;
    while is_space(s.get(sub).copied()) {
      sub += 1;
    }
    if s.get(sub) != Some(&b'=') {
      position = sub - 1;
      continue;
    }
    sub += 1;
    while is_space(s.get(sub).copied()) {
      sub += 1;
    }
    position = sub;
    break;
  }
  if let Some(&quote @ (b'"' | b'\'')) = s.get(position) {
    let rest = &s[position + 1..];
    let end = rest.iter().position(|&c| c == quote)?;
    return Encoding::for_label(&rest[..end]);
  }
  if s.len() == position + 1 {
    return None;
  }
  let start = (position + 1).min(s.len());
  let end = s[start..]
    .iter()
    .position(|&c| matches!(c, 0x09 | 0x0A | 0x0C | 0x0D | 0x20 | b';'))
    .map_or(s.len(), |p| start + p);
  Encoding::for_label(&s[position.min(s.len())..end])
}

// https://html.spec.whatwg.org/multipage/parsing.html#prescan-a-byte-stream-to-determine-its-encoding
fn prescan_meta_charset(b: &[u8]) -> Option<&'static Encoding> {
  let l = b.len();
  let at = |i: usize| b.get(i).copied();
  let mut i = 0;
  while i < l {
    if b[i] == b'<' {
      let (c1, c2, c3, c4, c5) = (at(i + 1), at(i + 2), at(i + 3), at(i + 4), at(i + 5));
      if c1 == Some(b'!') && c2 == Some(b'-') && c3 == Some(b'-') {
        i += 4;
        while i < l {
          if b[i] == b'>' && at(i - 1) == Some(b'-') && at(i - 2) == Some(b'-') {
            break;
          }
          i += 1;
        }
      } else if c1.map(lower) == Some(b'm')
        && c2.map(lower) == Some(b'e')
        && c3.map(lower) == Some(b't')
        && c4.map(lower) == Some(b'a')
        && (is_space(c5) || c5 == Some(b'/'))
      {
        i += 6;
        let mut names: Vec<Vec<u8>> = Vec::new();
        let mut got_pragma = false;
        let mut need_pragma: Option<bool> = None;
        let mut charset: Option<&'static Encoding> = None;
        loop {
          let (attr, next) = get_attribute(b, i, l);
          // Reaching the prescan limit aborts the entire prescan, including attribute processing.
          if next >= l {
            return None;
          }
          i = next;
          let Some(attr) = attr else { break };
          if names.contains(&attr.name) {
            continue;
          }
          match attr.name.as_slice() {
            b"http-equiv" => got_pragma = attr.value == b"content-type",
            b"content" if charset.is_none() => {
              charset = extract_from_meta(&attr.value);
              if charset.is_some() {
                need_pragma = Some(true);
              }
            }
            b"charset" => {
              charset = Encoding::for_label(&attr.value);
              need_pragma = Some(false);
            }
            _ => {}
          }
          names.push(attr.name);
        }
        let pragma_ok = match need_pragma {
          None => false,
          Some(true) => got_pragma,
          Some(false) => true,
        };
        if let (true, Some(enc)) = (pragma_ok, charset) {
          return Some(if enc == encoding_rs::UTF_16LE || enc == encoding_rs::UTF_16BE {
            encoding_rs::UTF_8
          } else if enc == encoding_rs::X_USER_DEFINED {
            encoding_rs::WINDOWS_1252
          } else {
            enc
          });
        }
      } else if c1.is_some_and(|c| c.is_ascii_alphabetic()) {
        i += 2;
        while i < l {
          if is_space(Some(b[i])) || b[i] == b'>' {
            break;
          }
          i += 1;
        }
        loop {
          let (attr, next) = get_attribute(b, i, l);
          i = next;
          if attr.is_none() {
            break;
          }
        }
      } else if matches!(c1, Some(b'!' | b'/' | b'?')) {
        i += 2;
        while i < l {
          if b[i] == b'>' {
            break;
          }
          i += 1;
        }
      }
    }
    i += 1;
  }
  None
}

// https://html.spec.whatwg.org/multipage/parsing.html#concept-get-xml-encoding-when-sniffing
fn xml_declaration_encoding(b: &[u8]) -> Option<&'static Encoding> {
  if !b.starts_with(b"<?xml") {
    return None;
  }
  let end = 5 + b[5..].iter().position(|&c| c == b'>')?;
  let mut i = 5;
  while i + 7 < end {
    if &b[i..i + 8] == b"encoding" {
      break;
    }
    i += 1;
  }
  if i + 7 >= end {
    return None;
  }
  i += 8;
  while i < end && b[i] <= 0x20 {
    i += 1;
  }
  if i >= end || b[i] != b'=' {
    return None;
  }
  i += 1;
  while i < end && b[i] <= 0x20 {
    i += 1;
  }
  if i >= end || (b[i] != b'"' && b[i] != b'\'') {
    return None;
  }
  let quote = b[i];
  let start = i + 1;
  for j in start..end {
    let c = b[j];
    if c == quote {
      let enc = Encoding::for_label(&b[start..j])?;
      return Some(if enc == encoding_rs::UTF_16LE || enc == encoding_rs::UTF_16BE {
        encoding_rs::UTF_8
      } else {
        enc
      });
    }
    if c <= 0x20 {
      return None;
    }
  }
  None
}

fn prescan(b: &[u8]) -> Option<&'static Encoding> {
  // Six-byte UTF-16 `<?x` signatures.
  if b.starts_with(b"<\0?\0x\0") {
    return Some(encoding_rs::UTF_16LE);
  }
  if b.starts_with(b"\0<\0?\0x") {
    return Some(encoding_rs::UTF_16BE);
  }
  // The XML declaration scan is not subject to the meta prescan's byte limit.
  prescan_meta_charset(&b[..b.len().min(MAX_PRESCAN_BYTES)]).or_else(|| xml_declaration_encoding(b))
}

/// Sniffs the encoding of an HTML byte stream: the BOM, then the transport-layer encoding label (if it is a valid
/// label), then the prescan. Returns the encoding's name, or null if the caller's default applies.
#[napi]
pub fn sniff_html_encoding(bytes: Uint8ArraySlice, transport_label: Option<String>) -> Option<&'static str> {
  let b: &[u8] = &bytes;
  bom_encoding(b)
    .or_else(|| transport_label.and_then(|label| Encoding::for_label(label.as_bytes())))
    .or_else(|| prescan(b))
    .map(Encoding::name)
}

// https://encoding.spec.whatwg.org/#decode. None if `encoding` is not a label.
fn decode<'a>(b: &'a [u8], encoding: &str) -> Option<Cow<'a, str>> {
  let enc = Encoding::for_label(encoding.as_bytes())?;
  Some(enc.decode(b).0)
}

/// Decodes HTML bytes as `encoding` (an encoding name or label); a BOM overrides it. Null if it is not a label.
#[napi]
pub fn decode_html_bytes(bytes: Uint8ArraySlice, encoding: String) -> Option<String> {
  decode(&bytes, &encoding).map(Cow::into_owned)
}

// The scripts jsdom's parseIntoDocument() looks for, as /<(?:script|iframe|frame|object|embed)/i.
fn scripts_may_run(s: &str) -> bool {
  const NAMES: [&[u8]; 5] = [b"script", b"iframe", b"frame", b"object", b"embed"];
  let b = s.as_bytes();
  memchr_iter(b'<', b).any(|i| {
    let rest = &b[i + 1..];
    NAMES
      .iter()
      .any(|name| rest.len() >= name.len() && rest[..name.len()].eq_ignore_ascii_case(name))
  })
}

fn memchr_iter(needle: u8, b: &[u8]) -> impl Iterator<Item = usize> + '_ {
  b.iter().enumerate().filter(move |(_, &c)| c == needle).map(|(i, _)| i)
}

/// Decodes HTML bytes as `encoding` (a BOM overrides it) and parses the result as a document, in one call.
/// Returns the decoded text instead of parsing when the caller must parse it some other way: when it is empty, or,
/// with `decline_if_scripts`, when it may contain scripts. Null if `encoding` is not a label.
#[napi]
pub fn parse_html_document_bytes(
  bytes: Uint8ArraySlice,
  encoding: String,
  scripting_enabled: bool,
  decline_if_scripts: bool,
) -> Option<Either<ParsedHtml, String>> {
  let text = decode(&bytes, &encoding)?;
  if text.is_empty() || (decline_if_scripts && scripts_may_run(&text)) {
    return Some(Either::B(text.into_owned()));
  }
  Some(Either::A(parse_document_str(&text, scripting_enabled)))
}
