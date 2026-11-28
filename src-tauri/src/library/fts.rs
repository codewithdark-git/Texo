//! Turning what the user typed into a safe FTS5 query, and the markers that
//! snippets use for highlighted words.

/// Starts a highlighted match in a snippet. Snippets carry these control
/// characters instead of HTML, so the UI never renders library text as markup.
pub const MARK_START: char = '\u{2}';
/// Ends a highlighted match in a snippet.
pub const MARK_END: char = '\u{3}';

/// Most words of a query that are kept.
const MAX_TOKENS: usize = 16;

/// Each word becomes a quoted FTS5 string (`"word"`, inner quotes doubled),
/// so `NOT`, `(`, `*`, `-x` and `a"b` are always plain text, never
/// operators. The last word gets a `*` so results show while typing. Words
/// with no letter or digit are dropped; an empty result means "no text
/// filter".
pub fn sanitize_query(user: &str) -> String {
    let tokens: Vec<String> = user
        .split_whitespace()
        .filter(|t| t.chars().any(char::is_alphanumeric))
        .take(MAX_TOKENS)
        .map(|t| format!("\"{}\"", t.replace('"', "\"\"")))
        .collect();
    match tokens.split_last() {
        None => String::new(),
        Some((last, rest)) => {
            let mut out: Vec<String> = rest.to_vec();
            out.push(format!("{last}*"));
            out.join(" ")
        }
    }
}
