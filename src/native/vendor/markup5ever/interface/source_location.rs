//! jsdom: source locations of tokens, and the tree construction events needed to attribute them to nodes the way
//! parse5 does (its `sourceCodeLocationInfo` option). Only produced when `TokenizerOpts::source_locations` is set.
//!
//! The tokenizer knows positions only as counts of consumed input bytes; converting them to lines, columns and
//! offsets (which parse5 counts in UTF-16 code units, with its own newline rules) is left to the sink, which has the
//! source text.

use crate::LocalName;

/// A position in the input, relative to the tokenizer's current input character when it was taken.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct SourcePoint {
    /// The number of bytes of input consumed when the position was taken, so that the current input character is the
    /// one ending there. One more than the input length stands for the end of the input.
    pub consumed: usize,
    /// How many characters (or UTF-16 code units, for parse5) before the current input character the position is;
    /// -1 is just after it.
    pub back: i32,
}

/// The kind of token a location belongs to.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum SourceTokenKind {
    StartTag(LocalName),
    EndTag(LocalName),
    /// A run of characters of one parse5 character token type (whitespace, NULL or other characters). It is delivered
    /// to the token sink as one token.
    Characters,
    Comment,
    Doctype,
    Eof,
}

/// The location of a token, reported right before the token is processed.
#[derive(Clone, Debug)]
pub struct SourceTokenLocation {
    pub kind: SourceTokenKind,
    pub start: SourcePoint,
    pub end: SourcePoint,
    /// For tags: the name, start and end of each attribute that is kept (not a duplicate), in source order.
    pub attrs: Vec<(LocalName, SourcePoint, SourcePoint)>,
}

/// Events a tree sink needs to give nodes the source locations parse5 gives them.
pub enum SourceLocationEvent<'a, Handle> {
    /// The location of the token about to be processed.
    Token(&'a SourceTokenLocation),
    /// The next element created is not created for the current token (an implied element: parse5's "fake" ones).
    CreateImplied,
    /// The next element created replaces the given one in the adoption agency algorithm (it has no location, but
    /// remembers the token the given element was created for).
    CreateRecreated(&'a Handle),
    /// The next element created reconstructs the given active formatting element (for the token it was created for).
    CreateReopened(&'a Handle),
    /// An end tag in foreign content matched the given element (parse5 then takes the element's name for the tag's).
    ForeignEndTagMatched(&'a Handle),
    /// The given element was inserted for the current token and immediately popped, without being pushed (parse5
    /// pushes and pops it, which ends its location at the start of the token).
    PushedAndPopped(&'a Handle),
    /// `</body>` closed the body; the argument is the body element, if it is the second element on the stack.
    CloseBody(Option<&'a Handle>),
    /// `</html>` after the body.
    CloseHtml,
    /// Parsing stopped at the end of the input.
    StopParsing,
    /// A character token was added to the pending table character tokens.
    TableTextPushed,
    /// The given pending table character token is about to be inserted.
    TableTextFlushEntry(usize),
    /// The pending table character tokens were all inserted.
    TableTextFlushDone,
    /// parse5 counts one line more from the given position on: it is where a line starts, in addition to where the
    /// input's newlines start lines. This happens when a character reference is started ("&") right before a newline:
    /// parse5 consumes the newline (which makes the next character start a line), finds that there is no character
    /// reference, and goes back to the "&" without undoing that, so the newline is counted twice.
    ExtraLine(SourcePoint),
}
