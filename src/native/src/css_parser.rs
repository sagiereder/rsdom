// A port of the subset of css-tree 3.2.1 (https://github.com/csstree/csstree) that jsdom's CSSOM parsing uses: its
// tokenizer, token stream, and the StyleSheet / DeclarationList parsers with the options jsdom passes (rule and
// at-rule preludes and property values kept as Raw nodes, custom property values optionally parsed as Value nodes),
// plus the generator for the nodes those produce.
//
// The port is deliberately literal, quirks included, as its output has to be identical to css-tree's: it works on
// UTF-16 code units, so offsets are JavaScript string offsets. It recovers from parse errors as css-tree does (with Raw
// nodes, see with_fallback()) and returns the errors css-tree reports. On constructs it does not port (unicode ranges,
// IE expression()), it gives up and the caller parses the input with css-tree instead.
//
// The result is a flat u32 instruction buffer (see `Out`) referencing the source by offsets, plus a UTF-16 string
// table for the generated text of Value nodes and of Raw nodes whose generated text css-tree would compute.

use napi::bindgen_prelude::*;
use napi_derive::napi;
use std::collections::HashSet;
use std::sync::OnceLock;

// Token types (css-tree tokenizer/types).
const EOF: u8 = 0;
const IDENT: u8 = 1;
const FUNCTION: u8 = 2;
const AT_KEYWORD: u8 = 3;
const HASH: u8 = 4;
const STRING: u8 = 5;
const BAD_STRING: u8 = 6;
const URL: u8 = 7;
const BAD_URL: u8 = 8;
const DELIM: u8 = 9;
const NUMBER: u8 = 10;
const PERCENTAGE: u8 = 11;
const DIMENSION: u8 = 12;
const WHITESPACE: u8 = 13;
const CDO: u8 = 14;
const CDC: u8 = 15;
const COLON: u8 = 16;
const SEMICOLON: u8 = 17;
const COMMA: u8 = 18;
const LEFT_SQUARE: u8 = 19;
const RIGHT_SQUARE: u8 = 20;
const LEFT_PAREN: u8 = 21;
const RIGHT_PAREN: u8 = 22;
const LEFT_CURLY: u8 = 23;
const RIGHT_CURLY: u8 = 24;
const COMMENT: u8 = 25;

// css-tree packs token end offsets into 24 bits.
const MAX_SOURCE_LENGTH: usize = 0x00FF_FFFF;

enum Fail {
    /// Parsing gave up: css-tree has to parse the input.
    Bail,
    /// css-tree's parser throws a SyntaxError: a message (see MESSAGES in native-css-parser.js) and the offset of its
    /// location.
    Error(u32, usize),
}
use Fail::Bail;
type R<T> = std::result::Result<T, Fail>;

// Error messages, by their index in MESSAGES in native-css-parser.js.
const MSG_UNEXPECTED_INPUT: u32 = 0;
const MSG_IDENTIFIER: u32 = 1;
const MSG_IDENTIFIER_FUNCTION: u32 = 2;
const MSG_COLON: u32 = 3;
const MSG_LEFT_CURLY: u32 = 4;
const MSG_RIGHT_PAREN: u32 = 5;
const MSG_RIGHT_SQUARE: u32 = 6;
const MSG_STRING: u32 = 7;
const MSG_HEX_OR_IDENTIFIER: u32 = 8;

// --- char-code-definitions ---------------------------------------------------------------------------------------

// Code units are widened to u32; offsets past the end read as 0, which every predicate below treats like the NaN
// that String.prototype.charCodeAt returns there.
#[inline]
fn at(s: &[u16], i: usize) -> u32 {
    if i < s.len() {
        s[i] as u32
    } else {
        0
    }
}
#[inline]
fn is_digit(c: u32) -> bool {
    (0x30..=0x39).contains(&c)
}
#[inline]
fn is_hex_digit(c: u32) -> bool {
    is_digit(c) || (0x41..=0x46).contains(&c) || (0x61..=0x66).contains(&c)
}
#[inline]
fn is_uppercase_letter(c: u32) -> bool {
    (0x41..=0x5A).contains(&c)
}
#[inline]
fn is_letter(c: u32) -> bool {
    is_uppercase_letter(c) || (0x61..=0x7A).contains(&c)
}
#[inline]
fn is_name_start(c: u32) -> bool {
    is_letter(c) || c >= 0x80 || c == 0x5F
}
#[inline]
fn is_name(c: u32) -> bool {
    is_name_start(c) || is_digit(c) || c == 0x2D
}
#[inline]
fn is_non_printable(c: u32) -> bool {
    c <= 0x08 || c == 0x0B || (0x0E..=0x1F).contains(&c) || c == 0x7F
}
#[inline]
fn is_newline(c: u32) -> bool {
    c == 0x0A || c == 0x0D || c == 0x0C
}
#[inline]
fn is_white_space(c: u32) -> bool {
    is_newline(c) || c == 0x20 || c == 0x09
}
#[inline]
fn is_valid_escape(first: u32, second: u32) -> bool {
    first == 0x5C && !is_newline(second) && second != 0
}
fn is_identifier_start(first: u32, second: u32, third: u32) -> bool {
    if first == 0x2D {
        return is_name_start(second) || second == 0x2D || is_valid_escape(second, third);
    }
    if is_name_start(first) {
        return true;
    }
    if first == 0x5C {
        return is_valid_escape(first, second);
    }
    false
}
fn is_number_start(first: u32, second: u32, third: u32) -> bool {
    if first == 0x2B || first == 0x2D {
        return is_digit(second) || (second == 0x2E && is_digit(third));
    }
    if first == 0x2E {
        return is_digit(second);
    }
    is_digit(first)
}

const EOF_CATEGORY: u32 = 0x80;
const WHITE_SPACE_CATEGORY: u32 = 0x82;
const DIGIT_CATEGORY: u32 = 0x83;
const NAME_START_CATEGORY: u32 = 0x84;
const NON_PRINTABLE_CATEGORY: u32 = 0x85;

#[inline]
fn char_code_category(c: u32) -> u32 {
    if c >= 0x80 {
        NAME_START_CATEGORY
    } else if is_white_space(c) {
        WHITE_SPACE_CATEGORY
    } else if is_digit(c) {
        DIGIT_CATEGORY
    } else if is_name_start(c) {
        NAME_START_CATEGORY
    } else if is_non_printable(c) {
        NON_PRINTABLE_CATEGORY
    } else if c == 0 {
        EOF_CATEGORY
    } else {
        c
    }
}

// --- tokenizer/utils ---------------------------------------------------------------------------------------------

#[inline]
fn get_newline_length(s: &[u16], offset: usize, c: u32) -> usize {
    if c == 13 && at(s, offset + 1) == 10 {
        2
    } else {
        1
    }
}

#[inline]
fn lower_ascii_upper(c: u32) -> u32 {
    if is_uppercase_letter(c) {
        c | 32
    } else {
        c
    }
}

fn cmp_char(s: &[u16], offset: usize, reference: u32) -> bool {
    lower_ascii_upper(at(s, offset)) == reference
}

fn cmp_str(s: &[u16], start: usize, end: usize, reference: &[u8]) -> bool {
    if end - start != reference.len() || end > s.len() {
        return false;
    }
    (start..end).all(|i| lower_ascii_upper(s[i] as u32) == reference[i - start] as u32)
}

fn find_white_space_end(s: &[u16], mut offset: usize) -> usize {
    while offset < s.len() && is_white_space(s[offset] as u32) {
        offset += 1;
    }
    offset
}

fn find_decimal_number_end(s: &[u16], mut offset: usize) -> usize {
    while offset < s.len() && is_digit(s[offset] as u32) {
        offset += 1;
    }
    offset
}

fn consume_escaped(s: &[u16], mut offset: usize) -> usize {
    offset += 2;
    if is_hex_digit(at(s, offset - 1)) {
        let max = s.len().min(offset + 5);
        while offset < max {
            if !is_hex_digit(at(s, offset)) {
                break;
            }
            offset += 1;
        }
        let c = at(s, offset);
        if is_white_space(c) {
            offset += get_newline_length(s, offset, c);
        }
    }
    offset
}

fn consume_name(s: &[u16], mut offset: usize) -> usize {
    while offset < s.len() {
        let c = s[offset] as u32;
        if is_name(c) {
            offset += 1;
            continue;
        }
        if is_valid_escape(c, at(s, offset + 1)) {
            offset = consume_escaped(s, offset);
            continue;
        }
        break;
    }
    offset
}

fn consume_number(s: &[u16], mut offset: usize) -> usize {
    let mut c = at(s, offset);
    if c == 0x2B || c == 0x2D {
        offset += 1;
        c = at(s, offset);
    }
    if is_digit(c) {
        offset = find_decimal_number_end(s, offset + 1);
        c = at(s, offset);
    }
    if c == 0x2E && is_digit(at(s, offset + 1)) {
        offset += 2;
        offset = find_decimal_number_end(s, offset);
    }
    if cmp_char(s, offset, 101) {
        let mut sign = 0;
        c = at(s, offset + 1);
        if c == 0x2D || c == 0x2B {
            sign = 1;
            c = at(s, offset + 2);
        }
        if is_digit(c) {
            offset = find_decimal_number_end(s, offset + 1 + sign + 1);
        }
    }
    offset
}

fn consume_bad_url_remnants(s: &[u16], mut offset: usize) -> usize {
    while offset < s.len() {
        let c = s[offset] as u32;
        if c == 0x29 {
            offset += 1;
            break;
        }
        if is_valid_escape(c, at(s, offset + 1)) {
            offset = consume_escaped(s, offset);
        }
        // The JS loop's increment applies after an escape too.
        offset += 1;
    }
    offset
}

fn push_code_point(out: &mut Vec<u16>, cp: u32) {
    if cp >= 0x10000 {
        let v = cp - 0x10000;
        out.push((0xD800 + (v >> 10)) as u16);
        out.push((0xDC00 + (v & 0x3FF)) as u16);
    } else {
        out.push(cp as u16);
    }
}

fn decode_escaped(escaped: &[u16], out: &mut Vec<u16>) {
    if escaped.len() == 1 && !is_hex_digit(escaped[0] as u32) {
        out.push(escaped[0]);
        return;
    }
    // parseInt(escaped, 16): the leading hex digits (at most 6, so no overflow).
    let mut code: u32 = 0;
    for &u in escaped {
        let c = u as u32;
        let d = match c {
            0x30..=0x39 => c - 0x30,
            0x41..=0x46 => c - 0x41 + 10,
            0x61..=0x66 => c - 0x61 + 10,
            _ => break,
        };
        code = code * 16 + d;
    }
    if code == 0 || (0xD800..=0xDFFF).contains(&code) || code > 0x10FFFF {
        code = 0xFFFD;
    }
    push_code_point(out, code);
}

// --- tokenizer ---------------------------------------------------------------------------------------------------

fn tokenize(s: &[u16], mut on_token: impl FnMut(u8, usize, usize)) {
    let len = s.len();
    let mut start = if matches!(at(s, 0), 0xFEFF | 0xFFFE) { 1 } else { 0 };
    let mut offset = start;
    let mut ty: u8;

    fn consume_numeric(s: &[u16], offset: &mut usize, ty: &mut u8) {
        *offset = consume_number(s, *offset);
        if is_identifier_start(at(s, *offset), at(s, *offset + 1), at(s, *offset + 2)) {
            *ty = DIMENSION;
            *offset = consume_name(s, *offset);
            return;
        }
        if at(s, *offset) == 0x25 {
            *ty = PERCENTAGE;
            *offset += 1;
            return;
        }
        *ty = NUMBER;
    }

    fn consume_url(s: &[u16], offset: &mut usize, ty: &mut u8) {
        *ty = URL;
        *offset = find_white_space_end(s, *offset);
        while *offset < s.len() {
            let c = s[*offset] as u32;
            match char_code_category(c) {
                0x29 => {
                    *offset += 1;
                    return;
                }
                WHITE_SPACE_CATEGORY => {
                    *offset = find_white_space_end(s, *offset);
                    if at(s, *offset) == 0x29 || *offset >= s.len() {
                        if *offset < s.len() {
                            *offset += 1;
                        }
                        return;
                    }
                    *offset = consume_bad_url_remnants(s, *offset);
                    *ty = BAD_URL;
                    return;
                }
                0x22 | 0x27 | 0x28 | NON_PRINTABLE_CATEGORY => {
                    *offset = consume_bad_url_remnants(s, *offset);
                    *ty = BAD_URL;
                    return;
                }
                0x5C => {
                    if is_valid_escape(c, at(s, *offset + 1)) {
                        *offset = consume_escaped(s, *offset);
                        continue;
                    }
                    *offset = consume_bad_url_remnants(s, *offset);
                    *ty = BAD_URL;
                    return;
                }
                _ => {}
            }
            *offset += 1;
        }
    }

    fn consume_ident_like(s: &[u16], offset: &mut usize, ty: &mut u8) {
        let name_start = *offset;
        *offset = consume_name(s, *offset);
        if cmp_str(s, name_start, *offset, b"url") && at(s, *offset) == 0x28 {
            *offset = find_white_space_end(s, *offset + 1);
            if at(s, *offset) == 0x22 || at(s, *offset) == 0x27 {
                *ty = FUNCTION;
                *offset = name_start + 4;
                return;
            }
            consume_url(s, offset, ty);
            return;
        }
        if at(s, *offset) == 0x28 {
            *ty = FUNCTION;
            *offset += 1;
            return;
        }
        *ty = IDENT;
    }

    fn consume_string(s: &[u16], offset: &mut usize, ty: &mut u8) {
        let ending = at(s, *offset);
        *offset += 1;
        *ty = STRING;
        while *offset < s.len() {
            let c = s[*offset] as u32;
            let cat = char_code_category(c);
            if cat == ending {
                *offset += 1;
                return;
            }
            if cat == WHITE_SPACE_CATEGORY {
                if is_newline(c) {
                    *offset += get_newline_length(s, *offset, c);
                    *ty = BAD_STRING;
                    return;
                }
            } else if cat == 0x5C && *offset != s.len() - 1 {
                let next = at(s, *offset + 1);
                if is_newline(next) {
                    *offset += get_newline_length(s, *offset + 1, next);
                } else if is_valid_escape(c, next) {
                    *offset = consume_escaped(s, *offset) - 1;
                }
            }
            *offset += 1;
        }
    }

    while offset < len {
        let c = s[offset] as u32;
        ty = DELIM;
        match char_code_category(c) {
            WHITE_SPACE_CATEGORY => {
                ty = WHITESPACE;
                offset = find_white_space_end(s, offset + 1);
            }
            0x22 | 0x27 => consume_string(s, &mut offset, &mut ty),
            0x23 => {
                if is_name(at(s, offset + 1)) || is_valid_escape(at(s, offset + 1), at(s, offset + 2)) {
                    ty = HASH;
                    offset = consume_name(s, offset + 1);
                } else {
                    offset += 1;
                }
            }
            0x28 => {
                ty = LEFT_PAREN;
                offset += 1;
            }
            0x29 => {
                ty = RIGHT_PAREN;
                offset += 1;
            }
            0x2B | 0x2E => {
                if is_number_start(c, at(s, offset + 1), at(s, offset + 2)) {
                    consume_numeric(s, &mut offset, &mut ty);
                } else {
                    offset += 1;
                }
            }
            0x2C => {
                ty = COMMA;
                offset += 1;
            }
            0x2D => {
                if is_number_start(c, at(s, offset + 1), at(s, offset + 2)) {
                    consume_numeric(s, &mut offset, &mut ty);
                } else if at(s, offset + 1) == 0x2D && at(s, offset + 2) == 0x3E {
                    ty = CDC;
                    offset += 3;
                } else if is_identifier_start(c, at(s, offset + 1), at(s, offset + 2)) {
                    consume_ident_like(s, &mut offset, &mut ty);
                } else {
                    offset += 1;
                }
            }
            0x2F => {
                if at(s, offset + 1) == 0x2A {
                    ty = COMMENT;
                    let mut i = offset + 2;
                    offset = len;
                    while i + 1 < len {
                        if s[i] == 0x2A && s[i + 1] == 0x2F {
                            offset = i + 2;
                            break;
                        }
                        i += 1;
                    }
                } else {
                    offset += 1;
                }
            }
            0x3A => {
                ty = COLON;
                offset += 1;
            }
            0x3B => {
                ty = SEMICOLON;
                offset += 1;
            }
            0x3C => {
                if at(s, offset + 1) == 0x21 && at(s, offset + 2) == 0x2D && at(s, offset + 3) == 0x2D {
                    ty = CDO;
                    offset += 4;
                } else {
                    offset += 1;
                }
            }
            0x40 => {
                if is_identifier_start(at(s, offset + 1), at(s, offset + 2), at(s, offset + 3)) {
                    ty = AT_KEYWORD;
                    offset = consume_name(s, offset + 1);
                } else {
                    offset += 1;
                }
            }
            0x5B => {
                ty = LEFT_SQUARE;
                offset += 1;
            }
            0x5C => {
                if is_valid_escape(c, at(s, offset + 1)) {
                    consume_ident_like(s, &mut offset, &mut ty);
                } else {
                    offset += 1;
                }
            }
            0x5D => {
                ty = RIGHT_SQUARE;
                offset += 1;
            }
            0x7B => {
                ty = LEFT_CURLY;
                offset += 1;
            }
            0x7D => {
                ty = RIGHT_CURLY;
                offset += 1;
            }
            DIGIT_CATEGORY => consume_numeric(s, &mut offset, &mut ty),
            NAME_START_CATEGORY => consume_ident_like(s, &mut offset, &mut ty),
            _ => offset += 1,
        }
        // A bad URL ending in an escape can end past the input; slicing it clamps in JavaScript.
        on_token(ty, start, offset.min(len));
        start = offset;
    }
}

// --- utils/string, utils/url -------------------------------------------------------------------------------------

// Shared tail of string.decode and url.decode, over str[start..=end] (`end` may be start - 1 for an empty range).
fn decode_range(s: &[u16], start: usize, end: isize, out: &mut Vec<u16>) {
    let len = s.len();
    let mut i = start;
    while (i as isize) <= end {
        let c = s[i] as u32;
        if c == 0x5C {
            if i as isize == end {
                if i != len - 1 {
                    // css-tree replaces what was decoded so far with the rest of the string.
                    out.clear();
                    out.extend_from_slice(&s[i + 1..]);
                }
                break;
            }
            i += 1;
            let c2 = s[i] as u32;
            if is_valid_escape(0x5C, c2) {
                let escape_start = i - 1;
                let escape_end = consume_escaped(s, escape_start);
                i = escape_end - 1;
                decode_escaped(&s[escape_start + 1..escape_end.min(len)], out);
            } else if c2 == 0x0D && at(s, i + 1) == 0x0A {
                i += 1;
            }
        } else {
            out.push(s[i]);
        }
        i += 1;
    }
}

fn decode_string(s: &[u16]) -> Vec<u16> {
    let len = s.len();
    let first = at(s, 0);
    let start = if first == 0x22 || first == 0x27 { 1 } else { 0 };
    let end = if start == 1 && len > 1 && s[len - 1] as u32 == first {
        len as isize - 2
    } else {
        len as isize - 1
    };
    let mut out = Vec::with_capacity(len);
    decode_range(s, start, end, &mut out);
    out
}

fn decode_url(s: &[u16]) -> Vec<u16> {
    let len = s.len();
    let mut start: isize = 4;
    let mut end: isize = if at(s, len - 1) == 0x29 { len as isize - 2 } else { len as isize - 1 };
    while start < end && is_white_space(s[start as usize] as u32) {
        start += 1;
    }
    while start < end && is_white_space(s[end as usize] as u32) {
        end -= 1;
    }
    let mut out = Vec::with_capacity(len);
    decode_range(s, start as usize, end, &mut out);
    out
}

fn push_hex(out: &mut Vec<u16>, code: u32) {
    // code.toString(16) for a control character (< 0x80).
    let digits = b"0123456789abcdef";
    if code >= 16 {
        out.push(digits[(code >> 4) as usize] as u16);
    }
    out.push(digits[(code & 15) as usize] as u16);
}

fn encode_string(s: &[u16], out: &mut Vec<u16>) {
    let quote = 0x22u32;
    out.push(quote as u16);
    let mut ws_before_hex = false;
    for &u in s {
        let c = u as u32;
        if c == 0 {
            out.push(0xFFFD);
            continue;
        }
        if c <= 0x1F || c == 0x7F {
            out.push(0x5C);
            push_hex(out, c);
            ws_before_hex = true;
            continue;
        }
        if c == quote || c == 0x5C {
            out.push(0x5C);
            out.push(u);
            ws_before_hex = false;
        } else {
            if ws_before_hex && (is_hex_digit(c) || is_white_space(c)) {
                out.push(0x20);
            }
            out.push(u);
            ws_before_hex = false;
        }
    }
    out.push(quote as u16);
}

fn encode_url(s: &[u16], out: &mut Vec<u16>) {
    out.extend("url(".encode_utf16());
    let mut ws_before_hex = false;
    for &u in s {
        let c = u as u32;
        if c == 0 {
            out.push(0xFFFD);
            continue;
        }
        if c <= 0x1F || c == 0x7F {
            out.push(0x5C);
            push_hex(out, c);
            ws_before_hex = true;
            continue;
        }
        if matches!(c, 0x20 | 0x5C | 0x22 | 0x27 | 0x28 | 0x29) {
            out.push(0x5C);
            out.push(u);
            ws_before_hex = false;
        } else {
            if ws_before_hex && is_hex_digit(c) {
                out.push(0x20);
            }
            out.push(u);
            ws_before_hex = false;
        }
    }
    out.push(0x29);
}

// --- generator ---------------------------------------------------------------------------------------------------

enum PairItem {
    T(u8),
    C(u8),
}

fn pair_code(item: &PairItem) -> u32 {
    match *item {
        PairItem::T(t) => (t as u32) << 1,
        PairItem::C(c) => (c as u32).min(0x80) << 7,
    }
}

// generator/token-before.cjs `safe` pairs: specPairs followed by the extra safePairs.
fn ws_required_set() -> &'static HashSet<u32> {
    static SET: OnceLock<HashSet<u32>> = OnceLock::new();
    SET.get_or_init(|| {
        use PairItem::{C, T};
        let follow_common = |prev: PairItem, with_minus: bool, extra: &[PairItem]| {
            let mut v: Vec<(PairItem, PairItem)> = Vec::new();
            let p = || match prev {
                T(t) => T(t),
                C(c) => C(c),
            };
            for n in [IDENT, FUNCTION, URL, BAD_URL] {
                v.push((p(), T(n)));
            }
            if with_minus {
                v.push((p(), C(b'-')));
            }
            for n in extra {
                v.push((
                    p(),
                    match *n {
                        T(t) => T(t),
                        C(c) => C(c),
                    },
                ));
            }
            v
        };
        let num_cdc = [T(NUMBER), T(PERCENTAGE), T(DIMENSION), T(CDC)];
        let mut pairs: Vec<(PairItem, PairItem)> = Vec::new();
        pairs.extend(follow_common(
            T(IDENT),
            true,
            &[T(NUMBER), T(PERCENTAGE), T(DIMENSION), T(CDC), T(LEFT_PAREN)],
        ));
        pairs.extend(follow_common(T(AT_KEYWORD), true, &num_cdc));
        pairs.extend(follow_common(T(HASH), true, &num_cdc));
        pairs.extend(follow_common(T(DIMENSION), true, &num_cdc));
        pairs.extend(follow_common(C(b'#'), true, &num_cdc));
        pairs.extend(follow_common(C(b'-'), true, &num_cdc));
        pairs.extend(follow_common(
            T(NUMBER),
            false,
            &[T(NUMBER), T(PERCENTAGE), T(DIMENSION), C(b'%'), T(CDC)],
        ));
        pairs.extend(follow_common(C(b'@'), true, &[T(CDC)]));
        for n in [NUMBER, PERCENTAGE, DIMENSION] {
            pairs.push((C(b'.'), T(n)));
            pairs.push((C(b'+'), T(n)));
        }
        pairs.push((C(b'/'), C(b'*')));
        // safePairs
        pairs.push((T(IDENT), T(HASH)));
        pairs.push((T(DIMENSION), T(HASH)));
        pairs.push((T(HASH), T(HASH)));
        pairs.push((T(AT_KEYWORD), T(LEFT_PAREN)));
        pairs.push((T(AT_KEYWORD), T(STRING)));
        pairs.push((T(AT_KEYWORD), T(COLON)));
        pairs.push((T(PERCENTAGE), T(PERCENTAGE)));
        pairs.push((T(PERCENTAGE), T(DIMENSION)));
        pairs.push((T(PERCENTAGE), T(FUNCTION)));
        pairs.push((T(PERCENTAGE), C(b'-')));
        pairs.push((T(RIGHT_PAREN), T(IDENT)));
        pairs.push((T(RIGHT_PAREN), T(FUNCTION)));
        pairs.push((T(RIGHT_PAREN), T(PERCENTAGE)));
        pairs.push((T(RIGHT_PAREN), T(DIMENSION)));
        pairs.push((T(RIGHT_PAREN), T(HASH)));
        pairs.push((T(RIGHT_PAREN), C(b'-')));
        pairs.iter().map(|(a, b)| (pair_code(a) << 16) | pair_code(b)).collect()
    })
}

struct Generator<'a> {
    out: &'a mut Vec<u16>,
    prev_code: u32,
    set: &'static HashSet<u32>,
}

impl Generator<'_> {
    fn token_before(&self, ty: u8, value: &[u16]) -> u32 {
        let first = value.first().map_or(0, |&u| u as u32);
        let next_code = if ty == DELIM { first.min(0x80) << 7 } else { (ty as u32) << 1 };
        let prev = (self.prev_code & 0xFFFE) << 16;
        let emit_ws = if (first == 0x2D && ty != IDENT && ty != FUNCTION && ty != CDC) || first == 0x2B {
            self.set.contains(&(prev | (first << 7)))
        } else {
            self.set.contains(&(prev | next_code))
        };
        next_code | emit_ws as u32
    }

    fn token(&mut self, ty: u8, value: &[u16], suppress_auto_white_space: bool) {
        self.prev_code = self.token_before(ty, value);
        if !suppress_auto_white_space && self.prev_code & 1 != 0 {
            self.out.push(0x20);
        }
        self.out.extend_from_slice(value);
        if ty == DELIM && value.first() == Some(&0x5C) {
            self.out.push(0x0A);
        }
    }

    fn tokenize(&mut self, raw: &[u16]) {
        tokenize(raw, |ty, start, end| self.token(ty, &raw[start..end], start != 0));
    }

    fn node(&mut self, src: &[u16], node: &VNode) {
        match node {
            VNode::Token(ty, start, end) => self.token(*ty, &src[*start..*end], false),
            VNode::Str(value) => {
                let mut encoded = Vec::with_capacity(value.len() + 2);
                encode_string(value, &mut encoded);
                self.token(STRING, &encoded, false);
            }
            VNode::Url(value) => {
                let mut encoded = Vec::with_capacity(value.len() + 5);
                encode_url(value, &mut encoded);
                self.token(URL, &encoded, false);
            }
            VNode::Function(start, end, children) => {
                self.token(FUNCTION, &src[*start..*end], false);
                self.children(src, children);
                self.token(RIGHT_PAREN, &[0x29], false);
            }
            VNode::Parentheses(children) => {
                self.token(LEFT_PAREN, &[0x28], false);
                self.children(src, children);
                self.token(RIGHT_PAREN, &[0x29], false);
            }
            VNode::Brackets(children) => {
                self.token(DELIM, &[0x5B], false);
                self.children(src, children);
                self.token(DELIM, &[0x5D], false);
            }
            VNode::Operator(value) => self.tokenize(value),
            VNode::WhiteSpace => self.token(WHITESPACE, &[0x20], false),
            VNode::Value(children) => self.children(src, children),
        }
    }

    fn children(&mut self, src: &[u16], children: &[VNode]) {
        for child in children {
            self.node(src, child);
        }
    }
}

// css-tree's generated text for a Raw node: its tokens, with a newline after each backslash delimiter (and without a
// leading BOM, which the tokenizer skips).
fn generate_raw(raw: &[u16]) -> Vec<u16> {
    let mut out = Vec::with_capacity(raw.len() + 2);
    Generator {
        out: &mut out,
        prev_code: 0,
        set: ws_required_set(),
    }
    .tokenize(raw);
    out
}

// --- AST of Value nodes (custom property values) -----------------------------------------------------------------

enum VNode {
    // Identifier, Number, Dimension, Percentage, Hash: generated as the source token.
    Token(u8, usize, usize),
    Str(Vec<u16>),
    Url(Vec<u16>),
    // Function name token (with the parenthesis) and children.
    Function(usize, usize, Vec<VNode>),
    Parentheses(Vec<VNode>),
    Brackets(Vec<VNode>),
    Operator(Vec<u16>),
    WhiteSpace,
    Value(Vec<VNode>),
}

fn is_plus_minus_operator(node: Option<&VNode>) -> bool {
    match node {
        Some(VNode::Operator(value)) => matches!(value.last(), Some(0x2D | 0x2B)),
        _ => false,
    }
}

// --- output ------------------------------------------------------------------------------------------------------

// Instruction buffer layout (u32 words). It starts with the number of top-level nodes, followed by the nodes in
// document order, each followed by its children:
//   RULE        1, preludeStart, preludeEnd, gen, genEnd, childCount
//   ATRULE      2, nameStart, nameEnd, preludeStart (NONE: no prelude), preludeEnd, gen, genEnd,
//               childCount (NONE: no block)
//   DECLARATION 3, propertyStart, propertyEnd, important (0 false, 1 true, 2 the identifier at importantStart..End),
//               importantStart, importantEnd, valueKind (0 Raw, 1 Value), valueStart, valueEnd, gen, genEnd
//   RAW         4, valueStart, valueEnd, gen, genEnd
//   COMMENT 5, CDO 6, CDC 7
// Raw values are source ranges; `gen`..`genEnd` is a range of the string table holding css-tree's generated text for
// those containing a backslash (else gen is NONE), and for Value nodes.
const OP_RULE: u32 = 1;
const OP_ATRULE: u32 = 2;
const OP_DECLARATION: u32 = 3;
const OP_RAW: u32 = 4;
const OP_COMMENT: u32 = 5;
const OP_CDO: u32 = 6;
const OP_CDC: u32 = 7;
const NONE: u32 = u32::MAX;

// --- parser ------------------------------------------------------------------------------------------------------

struct Parser<'a> {
    src: &'a [u16],
    types: Vec<u8>,
    ends: Vec<u32>,
    balance: Vec<u32>,
    token_count: usize,
    first_char_offset: usize,

    eof: bool,
    token_index: usize,
    token_type: u8,
    token_start: usize,
    token_end: usize,

    parse_custom_property: bool,
    ops: Vec<u32>,
    strings: Vec<u16>,
    // The parse errors css-tree reports through onParseError, in order: message, location offset.
    errors: Vec<(u32, usize)>,
}

#[inline]
fn balance_pair(ty: u8) -> u8 {
    match ty {
        FUNCTION | LEFT_PAREN => RIGHT_PAREN,
        LEFT_SQUARE => RIGHT_SQUARE,
        LEFT_CURLY => RIGHT_CURLY,
        _ => 0,
    }
}
#[inline]
fn is_block_opener(ty: u8) -> bool {
    matches!(ty, FUNCTION | LEFT_PAREN | LEFT_SQUARE | LEFT_CURLY)
}
#[inline]
fn is_block_closer(ty: u8) -> bool {
    matches!(ty, RIGHT_PAREN | RIGHT_SQUARE | RIGHT_CURLY)
}

#[derive(Clone, Copy)]
enum Until {
    LeftCurly,
    LeftCurlyOrSemicolon,
    ExclamationOrSemicolon,
    SemicolonIncluded,
    // consumeUntilBalanceEnd, the default of Raw()
    BalanceEnd,
}

impl<'a> Parser<'a> {
    fn new(src: &'a [u16], parse_custom_property: bool) -> R<Parser<'a>> {
        if src.len() > MAX_SOURCE_LENGTH {
            return Err(Bail);
        }
        let len = src.len();
        let mut types: Vec<u8> = Vec::with_capacity(len / 3 + 16);
        let mut ends: Vec<u32> = Vec::with_capacity(len / 3 + 16);
        let mut balance: Vec<u32> = Vec::with_capacity(len / 3 + 16);
        let mut first_char_offset: isize = -1;
        let mut balance_close_type: u8 = 0;
        let top = len as u32;
        let mut balance_start: u32 = top;
        // TokenStream reads the type of the token at index source.length when an outermost block closes, from a buffer it
        // reuses across parses, so a stray closing token after that may balance depending on what was parsed before.
        let mut outermost_closed = false;
        let mut bail = false;
        tokenize(src, |ty, start, end| {
            let index = types.len() as u32;
            types.push(ty);
            ends.push(end as u32);
            if first_char_offset == -1 {
                first_char_offset = start as isize;
            }
            balance.push(balance_start);
            if ty == balance_close_type {
                let prev = balance[balance_start as usize];
                balance[balance_start as usize] = index;
                balance_start = prev;
                if prev == top {
                    outermost_closed = true;
                    balance_close_type = 0;
                } else {
                    balance_close_type = balance_pair(types[prev as usize]);
                }
            } else if is_block_opener(ty) {
                balance_start = index;
                balance_close_type = balance_pair(ty);
            } else if balance_start == top && outermost_closed && is_block_closer(ty) {
                bail = true;
            }
        });
        if bail {
            return Err(Bail);
        }
        let token_count = types.len();
        balance.push(token_count as u32);
        for i in 0..token_count {
            let bs = balance[i] as usize;
            if bs <= i {
                let be = balance[bs];
                if be as usize != i {
                    balance[i] = be;
                }
            } else if bs > token_count {
                balance[i] = token_count as u32;
            }
        }
        let first_char_offset = if first_char_offset == -1 { 0 } else { first_char_offset as usize };
        let mut parser = Parser {
            src,
            types,
            ends,
            balance,
            token_count,
            first_char_offset,
            eof: false,
            token_index: 0,
            token_type: 0,
            token_start: first_char_offset,
            token_end: first_char_offset,
            parse_custom_property,
            ops: Vec::with_capacity(len / 4 + 16),
            strings: Vec::new(),
            errors: Vec::new(),
        };
        // reset() then next(), from token index -1.
        if token_count > 0 {
            parser.token_index = 0;
            parser.token_type = parser.types[0];
            parser.token_end = parser.ends[0] as usize;
        } else {
            parser.set_eof();
        }
        Ok(parser)
    }

    fn set_eof(&mut self) {
        self.eof = true;
        self.token_index = self.token_count;
        self.token_type = EOF;
        self.token_start = self.src.len();
        self.token_end = self.src.len();
    }

    #[inline]
    fn next(&mut self) {
        let next = self.token_index + 1;
        if next < self.token_count {
            self.token_index = next;
            self.token_start = self.token_end;
            self.token_type = self.types[next];
            self.token_end = self.ends[next] as usize;
        } else {
            self.set_eof();
        }
    }

    fn skip(&mut self, count: usize) {
        let next = self.token_index + count;
        if next < self.token_count {
            self.token_index = next;
            // offsetAndType[-1] reads as 0.
            self.token_start = if next == 0 { 0 } else { self.ends[next - 1] as usize };
            self.token_type = self.types[next];
            self.token_end = self.ends[next] as usize;
        } else {
            self.set_eof();
        }
    }

    #[inline]
    fn skip_sc(&mut self) {
        while self.token_type == WHITESPACE || self.token_type == COMMENT {
            self.next();
        }
    }

    // lookupType(offset) for offset >= -tokenIndex.
    #[inline]
    fn lookup_type(&self, offset: isize) -> u8 {
        let index = self.token_index as isize + offset;
        if index < self.token_count as isize {
            self.types[index as usize]
        } else {
            EOF
        }
    }

    fn get_token_start(&self, token_index: usize) -> usize {
        if token_index == self.token_index {
            return self.token_start;
        }
        if token_index > 0 {
            return if token_index < self.token_count {
                self.ends[token_index - 1] as usize
            } else {
                self.src.len()
            };
        }
        self.first_char_offset
    }

    #[inline]
    fn char_at(&self, offset: usize) -> u32 {
        at(self.src, offset)
    }

    #[inline]
    fn is_delim(&self, code: u32) -> bool {
        self.token_type == DELIM && self.char_at(self.token_start) == code
    }

    #[inline]
    fn is_balance_edge(&self, token_index: usize) -> bool {
        (self.balance[self.token_index] as usize) < token_index
    }

    #[inline]
    fn eat(&mut self, ty: u8) -> R<()> {
        if self.token_type != ty {
            return Err(self.eat_error(ty));
        }
        self.next();
        Ok(())
    }

    // The error eat(tokenType) throws when the current token is of another type.
    #[cold]
    fn eat_error(&self, ty: u8) -> Fail {
        let (message, offset) = match ty {
            IDENT if self.token_type == FUNCTION || self.token_type == URL => (MSG_IDENTIFIER_FUNCTION, self.token_end - 1),
            IDENT => (MSG_IDENTIFIER, self.token_start),
            COLON => (MSG_COLON, self.token_start),
            LEFT_CURLY => (MSG_LEFT_CURLY, self.token_start),
            RIGHT_PAREN => (MSG_RIGHT_PAREN, self.token_start),
            RIGHT_SQUARE => (MSG_RIGHT_SQUARE, self.token_start),
            STRING => (MSG_STRING, self.token_start),
            _ => return Bail,
        };
        self.error(message, Some(offset))
    }

    // error(message, offset): the error with the location css-tree reports.
    #[cold]
    fn error(&self, message: u32, offset: Option<usize>) -> Fail {
        let len = self.src.len();
        let location = match offset {
            Some(offset) if offset < len => offset,
            _ if self.eof => {
                // findWhiteSpaceStart(source, source.length - 1)
                let mut end = len;
                while end > 0 && matches!(self.src[end - 1], 0x0A | 0x0D | 0x0C | 0x20 | 0x09) {
                    end -= 1;
                }
                end
            }
            _ => self.token_start,
        };
        Fail::Error(message, location)
    }

    // skip(index - tokenIndex), which leaves `eof` as it is.
    fn seek(&mut self, index: usize) {
        if index < self.token_count {
            self.token_index = index;
            self.token_start = if index == 0 { 0 } else { self.ends[index - 1] as usize };
            self.token_type = self.types[index];
            self.token_end = self.ends[index] as usize;
        } else {
            self.set_eof();
        }
    }

    // parseWithFallback(consumer, () => this.Raw(until, excludeWhiteSpace)) for a consumer that writes one node.
    fn with_fallback(&mut self, consumer: impl FnOnce(&mut Self) -> R<()>, until: Until, exclude_white_space: bool) -> R<()> {
        let start_index = self.token_index;
        let ops_len = self.ops.len();
        match consumer(self) {
            Err(Fail::Error(message, location)) => {
                self.ops.truncate(ops_len);
                self.seek(start_index);
                self.ops.push(OP_RAW);
                let raw = self.raw(until, exclude_white_space);
                self.push_raw(raw);
                self.errors.push((message, location));
                Ok(())
            }
            result => result,
        }
    }

    fn skip_until_balanced(&mut self, start_token: usize, until: Until) {
        let mut cursor = start_token;
        while cursor < self.token_count {
            let balance_end = self.balance[cursor] as usize;
            if balance_end < start_token {
                break;
            }
            let offset = if cursor > 0 { self.ends[cursor - 1] as usize } else { self.first_char_offset };
            let c = self.char_at(offset);
            let stop = match until {
                Until::LeftCurly => (c == 0x7B) as u8,
                Until::LeftCurlyOrSemicolon => (c == 0x7B || c == 0x3B) as u8,
                Until::ExclamationOrSemicolon => (c == 0x21 || c == 0x3B) as u8,
                Until::SemicolonIncluded => (c == 0x3B) as u8 * 2,
                Until::BalanceEnd => 0,
            };
            if stop == 1 {
                break;
            }
            if stop == 2 {
                cursor += 1;
                break;
            }
            if is_block_opener(self.types[cursor]) {
                cursor = balance_end;
            }
            cursor += 1;
        }
        self.skip(cursor - self.token_index);
    }

    // Raw(consumeUntil, excludeWhiteSpace): the value's source range.
    fn raw(&mut self, until: Until, exclude_white_space: bool) -> (usize, usize) {
        let start_offset = self.get_token_start(self.token_index);
        self.skip_until_balanced(self.token_index, until);
        let end_offset = if exclude_white_space && self.token_start > start_offset {
            // getOffsetExcludeWS()
            if self.token_index > 0 && self.lookup_type(-1) == WHITESPACE {
                if self.token_index > 1 {
                    self.get_token_start(self.token_index - 1)
                } else {
                    self.first_char_offset
                }
            } else {
                self.token_start
            }
        } else {
            self.token_start
        };
        (start_offset, end_offset)
    }

    fn push_gen(&mut self, text: &[u16]) -> (u32, u32) {
        let start = self.strings.len() as u32;
        self.strings.extend_from_slice(text);
        (start, self.strings.len() as u32)
    }

    // Pushes a Raw value's start, end, gen, genEnd.
    fn push_raw(&mut self, (start, end): (usize, usize)) {
        // css-tree takes the value with String#substring(), which swaps reversed bounds. They happen when the input starts
        // with a BOM: skipping to token 0 sets tokenStart to 0, before firstCharOffset.
        let (start, end) = if start > end { (end, start) } else { (start, end) };
        self.ops.push(start as u32);
        self.ops.push(end as u32);
        // jsdom only runs css-tree's generator for Raw values with a backslash; others serialize as their value.
        let raw = &self.src[start..end];
        if raw.contains(&0x5C) {
            let text = generate_raw(raw);
            let (gs, ge) = self.push_gen(&text);
            self.ops.push(gs);
            self.ops.push(ge);
        } else {
            self.ops.push(NONE);
            self.ops.push(NONE);
        }
    }

    // Reserves a child count slot; returns its index.
    fn reserve(&mut self) -> usize {
        self.ops.push(0);
        self.ops.len() - 1
    }

    fn style_sheet(&mut self) -> R<u32> {
        let mut count = 0;
        while !self.eof {
            match self.token_type {
                WHITESPACE => {
                    self.next();
                    continue;
                }
                COMMENT => {
                    if self.char_at(self.token_start + 2) != 0x21 {
                        self.next();
                        continue;
                    }
                    self.next();
                    self.ops.push(OP_COMMENT);
                }
                CDO => {
                    self.next();
                    self.ops.push(OP_CDO);
                }
                CDC => {
                    self.next();
                    self.ops.push(OP_CDC);
                }
                AT_KEYWORD => self.with_fallback(|p| p.atrule(false), Until::BalanceEnd, false)?,
                _ => self.with_fallback(|p| p.rule(), Until::BalanceEnd, false)?,
            }
            count += 1;
        }
        Ok(count)
    }

    fn declaration_list(&mut self) -> R<u32> {
        let mut count = 0;
        while !self.eof {
            match self.token_type {
                WHITESPACE | COMMENT | SEMICOLON => {
                    self.next();
                    continue;
                }
                AT_KEYWORD => self.with_fallback(|p| p.atrule(true), Until::SemicolonIncluded, true)?,
                _ => {
                    if self.is_delim(0x26) {
                        self.with_fallback(|p| p.rule(), Until::SemicolonIncluded, true)?;
                    } else {
                        self.with_fallback(|p| p.declaration(), Until::SemicolonIncluded, true)?;
                    }
                }
            }
            count += 1;
        }
        Ok(count)
    }

    fn rule(&mut self) -> R<()> {
        self.ops.push(OP_RULE);
        let prelude = self.raw(Until::LeftCurly, true);
        self.push_raw(prelude);
        self.block(true)
    }

    fn block(&mut self, is_style_block: bool) -> R<()> {
        let count_slot = self.reserve();
        let mut count = 0;
        self.eat(LEFT_CURLY)?;
        while !self.eof {
            match self.token_type {
                RIGHT_CURLY => break,
                WHITESPACE | COMMENT => {
                    self.next();
                    continue;
                }
                AT_KEYWORD => self.with_fallback(|p| p.atrule(is_style_block), Until::BalanceEnd, true)?,
                _ => {
                    if is_style_block && !self.is_delim(0x26) {
                        // consumeDeclaration()
                        if self.token_type == SEMICOLON {
                            self.ops.push(OP_RAW);
                            let raw = self.raw(Until::SemicolonIncluded, true);
                            self.push_raw(raw);
                        } else {
                            self.with_fallback(|p| p.declaration(), Until::SemicolonIncluded, true)?;
                            if self.token_type == SEMICOLON {
                                self.next();
                            }
                        }
                    } else {
                        self.with_fallback(|p| p.rule(), Until::BalanceEnd, true)?;
                    }
                }
            }
            count += 1;
        }
        if !self.eof {
            self.eat(RIGHT_CURLY)?;
        }
        self.ops[count_slot] = count;
        Ok(())
    }

    fn is_declaration_block_atrule(&self) -> bool {
        let mut offset = 1;
        loop {
            match self.lookup_type(offset) {
                EOF => return false,
                RIGHT_CURLY => return true,
                LEFT_CURLY | AT_KEYWORD => return false,
                _ => offset += 1,
            }
        }
    }

    fn atrule(&mut self, is_declaration: bool) -> R<()> {
        let start = self.token_start;
        self.eat(AT_KEYWORD)?;
        let name = (start + 1, self.token_start);
        self.ops.push(OP_ATRULE);
        self.ops.push(name.0 as u32);
        self.ops.push(name.1 as u32);
        self.skip_sc();
        if !self.eof && self.token_type != LEFT_CURLY && self.token_type != SEMICOLON {
            let prelude = self.raw(Until::LeftCurlyOrSemicolon, true);
            self.push_raw(prelude);
            self.skip_sc();
        } else {
            self.ops.extend_from_slice(&[NONE, NONE, NONE, NONE]);
        }
        match self.token_type {
            SEMICOLON => {
                self.next();
                self.ops.push(NONE);
            }
            LEFT_CURLY => {
                let is_style_block = match self.atrule_block_kind(name.0, name.1) {
                    AtruleBlock::Nested => is_declaration,
                    AtruleBlock::Declarations => true,
                    AtruleBlock::Rules => false,
                    AtruleBlock::Default => self.is_declaration_block_atrule(),
                };
                self.block(is_style_block)?;
            }
            _ => self.ops.push(NONE),
        }
        Ok(())
    }

    // The `block` of css-tree's at-rule definitions, by lowercased name.
    fn atrule_block_kind(&self, start: usize, end: usize) -> AtruleBlock {
        let name = &self.src[start..end];
        // String.prototype.toLowerCase() only maps U+212A KELVIN SIGN from outside ASCII into it, to "k", which none of
        // the names contain.
        let is = |reference: &str| {
            name.len() == reference.len() && name.iter().zip(reference.bytes()).all(|(&u, b)| lower_ascii_upper(u as u32) == b as u32)
        };
        if is("container") || is("media") || is("scope") || is("starting-style") || is("supports") {
            AtruleBlock::Nested
        } else if is("font-face") || is("nest") || is("page") {
            AtruleBlock::Declarations
        } else if is("layer") {
            AtruleBlock::Rules
        } else {
            AtruleBlock::Default
        }
    }

    fn declaration(&mut self) -> R<()> {
        let start = self.token_start;
        let start_token = self.token_index;
        // readProperty()
        if self.token_type == DELIM {
            match self.char_at(self.token_start) {
                0x2A | 0x24 | 0x2B | 0x23 | 0x26 => self.next(),
                0x2F => {
                    self.next();
                    if self.is_delim(0x2F) {
                        self.next();
                    }
                }
                _ => {}
            }
        }
        if self.token_type == HASH {
            self.eat(HASH)?;
        } else {
            self.eat(IDENT)?;
        }
        let property = (start, self.token_start);
        let custom_property = property.1 - property.0 >= 2 && self.src[property.0] == 0x2D && self.src[property.0 + 1] == 0x2D;
        self.skip_sc();
        self.eat(COLON)?;
        let value_start = self.token_index;
        if !custom_property {
            self.skip_sc();
        }

        self.ops.push(OP_DECLARATION);
        self.ops.push(property.0 as u32);
        self.ops.push(property.1 as u32);
        let important_slot = self.ops.len();
        self.ops.extend_from_slice(&[0, 0, 0]);

        if custom_property && self.parse_custom_property {
            // parseWithFallback(consumeValue, consumeCustomPropertyRaw)
            let start_value_token = self.token_index;
            let consumed = self.read_sequence().and_then(|children| {
                if !self.eof && self.token_type != SEMICOLON && !self.is_delim(0x21) && !self.is_balance_edge(start_value_token) {
                    Err(self.error(MSG_UNEXPECTED_INPUT, None))
                } else {
                    Ok(children)
                }
            });
            let mut children = match consumed {
                Ok(children) => children,
                Err(Fail::Error(message, location)) => {
                    self.seek(start_value_token);
                    self.ops.push(0);
                    let raw = self.raw(Until::ExclamationOrSemicolon, false);
                    self.push_raw(raw);
                    self.errors.push((message, location));
                    return self.declaration_end(start_token, important_slot);
                }
                Err(bail) => return Err(bail),
            };
            if children.is_empty() {
                let mut offset = value_start as isize - self.token_index as isize;
                while offset <= 0 {
                    if self.lookup_type(offset) == WHITESPACE {
                        children.push(VNode::WhiteSpace);
                        break;
                    }
                    offset += 1;
                }
            }
            let mut text = Vec::new();
            Generator {
                out: &mut text,
                prev_code: 0,
                set: ws_required_set(),
            }
            .children(self.src, &children);
            let (gs, ge) = self.push_gen(&text);
            self.ops.extend_from_slice(&[1, NONE, NONE, gs, ge]);
        } else {
            self.ops.push(0);
            let raw = self.raw(Until::ExclamationOrSemicolon, !custom_property);
            self.push_raw(raw);
        }
        self.declaration_end(start_token, important_slot)
    }

    // The rest of Declaration(), after the value.
    fn declaration_end(&mut self, start_token: usize, important_slot: usize) -> R<()> {
        if self.is_delim(0x21) {
            // getImportant()
            self.eat(DELIM)?;
            self.skip_sc();
            let important_start = self.token_start;
            self.eat(IDENT)?;
            let important = &self.src[important_start..self.token_start];
            if important.iter().copied().eq("important".encode_utf16()) {
                self.ops[important_slot] = 1;
            } else {
                self.ops[important_slot] = 2;
                self.ops[important_slot + 1] = important_start as u32;
                self.ops[important_slot + 2] = self.token_start as u32;
            }
            self.skip_sc();
        }
        if !self.eof && self.token_type != SEMICOLON && !self.is_balance_edge(start_token) {
            return Err(self.error(MSG_UNEXPECTED_INPUT, None));
        }
        Ok(())
    }

    // readSequence() with the Value scope recognizer.
    fn read_sequence(&mut self) -> R<Vec<VNode>> {
        let mut children: Vec<VNode> = Vec::new();
        let mut space = false;
        while !self.eof {
            match self.token_type {
                COMMENT => {
                    self.next();
                    continue;
                }
                WHITESPACE => {
                    space = true;
                    self.next();
                    continue;
                }
                _ => {}
            }
            let Some(mut child) = self.value_node()? else {
                break;
            };
            if space {
                // onWhiteSpace()
                if is_plus_minus_operator(Some(&child)) {
                    if let VNode::Operator(value) = &mut child {
                        value.insert(0, 0x20);
                    }
                }
                if is_plus_minus_operator(children.last()) {
                    if let Some(VNode::Operator(value)) = children.last_mut() {
                        value.push(0x20);
                    }
                }
                space = false;
            }
            children.push(child);
        }
        if space && is_plus_minus_operator(children.last()) {
            if let Some(VNode::Operator(value)) = children.last_mut() {
                value.push(0x20);
            }
        }
        Ok(children)
    }

    fn token_node(&mut self) -> VNode {
        let node = VNode::Token(self.token_type, self.token_start, self.token_end);
        self.next();
        node
    }

    fn operator(&mut self) -> VNode {
        let value = self.src[self.token_start..self.token_end].to_vec();
        self.next();
        VNode::Operator(value)
    }

    // The default recognizer (syntax/scope/default.cjs); None where it returns undefined.
    fn value_node(&mut self) -> R<Option<VNode>> {
        Ok(Some(match self.token_type {
            HASH | DIMENSION | PERCENTAGE | NUMBER => self.token_node(),
            COMMA => self.operator(),
            LEFT_PAREN => {
                self.next();
                let children = self.read_sequence()?;
                if !self.eof {
                    self.eat(RIGHT_PAREN)?;
                }
                VNode::Parentheses(children)
            }
            LEFT_SQUARE => {
                self.next();
                let children = self.read_sequence()?;
                if !self.eof {
                    self.eat(RIGHT_SQUARE)?;
                }
                VNode::Brackets(children)
            }
            STRING => {
                let value = decode_string(&self.src[self.token_start..self.token_end]);
                self.next();
                VNode::Str(value)
            }
            FUNCTION => {
                if cmp_str(self.src, self.token_start, self.token_end, b"url(") {
                    // Url(), function form: url( <string> )
                    self.next();
                    self.skip_sc();
                    if self.token_type != STRING {
                        return Err(self.eat_error(STRING));
                    }
                    let value = decode_string(&self.src[self.token_start..self.token_end]);
                    self.next();
                    self.skip_sc();
                    if !self.eof {
                        self.eat(RIGHT_PAREN)?;
                    }
                    VNode::Url(value)
                } else {
                    self.function()?
                }
            }
            URL => {
                let value = decode_url(&self.src[self.token_start..self.token_end]);
                self.next();
                VNode::Url(value)
            }
            IDENT => {
                if cmp_char(self.src, self.token_start, 0x75) && cmp_char(self.src, self.token_start + 1, 0x2B) {
                    // UnicodeRange: not ported.
                    return Err(Bail);
                }
                self.token_node()
            }
            DELIM => match self.char_at(self.token_start) {
                0x2F | 0x2A | 0x2B | 0x2D => self.operator(),
                // "Hex or identifier is expected"
                0x23 => return Err(self.error(MSG_HEX_OR_IDENTIFIER, Some(self.token_start + 1))),
                _ => return Ok(None),
            },
            _ => return Ok(None),
        }))
    }

    fn function(&mut self) -> R<VNode> {
        let (name_start, name_end) = (self.token_start, self.token_end);
        let name = &self.src[name_start..name_end - 1];
        let lower_is = |reference: &str| {
            name.len() == reference.len() && name.iter().zip(reference.bytes()).all(|(&u, b)| lower_ascii_upper(u as u32) == b as u32)
        };
        let is_var = lower_is("var");
        if lower_is("expression") {
            return Err(Bail);
        }
        self.next();
        let children = if is_var {
            // syntax/function/var.cjs
            let mut children = Vec::new();
            self.skip_sc();
            if self.token_type != IDENT {
                return Err(self.eat_error(IDENT));
            }
            children.push(self.token_node());
            self.skip_sc();
            if self.token_type == COMMA {
                children.push(self.operator());
                let start_index = self.token_index;
                let mut value = self.read_sequence()?;
                if value.is_empty() {
                    let mut offset = start_index as isize - self.token_index as isize;
                    while offset <= 0 {
                        if self.lookup_type(offset) == WHITESPACE {
                            value.push(VNode::WhiteSpace);
                            break;
                        }
                        offset += 1;
                    }
                }
                children.push(VNode::Value(value));
            }
            children
        } else {
            self.read_sequence()?
        };
        if !self.eof {
            self.eat(RIGHT_PAREN)?;
        }
        Ok(VNode::Function(name_start, name_end, children))
    }
}

enum AtruleBlock {
    // block(nested = false) { return this.Block(nested); }
    Nested,
    Declarations,
    Rules,
    // No block function: Block(isDeclarationBlockAtrule())
    Default,
}

#[napi(object)]
pub struct ParsedCss {
    pub ops: Uint32Array,
    pub strings: Utf16String,
    /// The parse errors, as message (see MESSAGES in native-css-parser.js), offset, line, column.
    pub errors: Uint32Array,
}

// The line and column of each error location, as OffsetToLocation computes them with its default start line and
// column of 1. None when one of them would read the entry for offset 0 of a source starting with a BOM, which
// OffsetToLocation leaves as it was in its buffer from earlier parses.
fn error_records(src: &[u16], errors: &[(u32, usize)]) -> Option<Vec<u32>> {
    let start = if src.first() == Some(&0xFEFF) { 1 } else { 0 };
    let mut order: Vec<usize> = (0..errors.len()).collect();
    order.sort_by_key(|&n| errors[n].1);
    let mut records = vec![0u32; errors.len() * 4];
    let (mut line, mut column) = (1u32, 1u32);
    let mut i = start;
    let mut next = 0;
    while next < order.len() {
        let (message, offset) = errors[order[next]];
        if offset < start {
            return None;
        }
        // Advance to `offset`, where lines[offset] and columns[offset] are line and column.
        while i < offset {
            let code = src[i];
            column += 1;
            if code == 0x0A || code == 0x0D || code == 0x0C {
                if code == 0x0D && i + 1 < src.len() && src[i + 1] == 0x0A {
                    i += 1;
                    if i == offset {
                        // lines[i] = line, columns[i] = column (not incremented past the \r)
                        break;
                    }
                }
                line += 1;
                column = 1;
            }
            i += 1;
        }
        let record = &mut records[order[next] * 4..order[next] * 4 + 4];
        record[0] = message;
        record[1] = offset as u32;
        record[2] = line;
        record[3] = column;
        next += 1;
    }
    Some(records)
}

/// Parses CSS as css-tree does with jsdom's options. `mode` 0: a stylesheet (context "stylesheet",
/// parseCustomProperty); 1: a declaration list with parseCustomProperty; 2: a declaration list without it. Returns
/// null when css-tree has to parse the input instead.
#[napi]
pub fn parse_css(source: Utf16String, mode: u32) -> Option<ParsedCss> {
    let src: &[u16] = &source;
    let mut parser = Parser::new(src, mode != 2).ok()?;
    parser.ops.push(0);
    let count = if mode == 0 { parser.style_sheet() } else { parser.declaration_list() }.ok()?;
    parser.ops[0] = count;
    let errors = error_records(src, &parser.errors)?;
    Some(ParsedCss {
        ops: Uint32Array::new(parser.ops),
        strings: Utf16String::from(parser.strings),
        errors: Uint32Array::new(errors),
    })
}
