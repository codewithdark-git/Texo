//! HTML to readable text, hand-written (no HTML parser dependency): drops
//! scripts, styles, navigation and forms, keeps headings, paragraphs, list
//! items and table cells on their own lines, decodes entities, and prefers
//! the page's `<main>` or `<article>` when it holds the bulk of the text.
//! Good enough for a model to read a page; not a browser.


/// Elements whose content is never text for the reader.
const RAW_SKIP: &[&str] = &["script", "style", "template", "svg", "math", "canvas", "object", "iframe", "noscript"];
/// Page furniture, skipped as long as the page has real content elsewhere.
const FURNITURE: &[&str] = &["nav", "footer", "aside", "form", "button", "select", "head", "dialog"];
const BLOCKS: &[&str] = &[
    "p", "div", "br", "tr", "table", "section", "article", "main", "blockquote", "pre", "ul", "ol", "dl", "dd",
    "dt", "hr", "figure", "figcaption", "header", "address", "caption", "tbody", "thead", "details", "summary",
];
const VOID: &[&str] = &["br", "hr", "img", "meta", "link", "input", "area", "base", "col", "embed", "source", "track", "wbr"];

#[derive(Debug, Clone, PartialEq)]
pub struct Extracted {
    pub title: Option<String>,
    pub text: String,
}

pub fn html_to_text(html: &str) -> Extracted {
    let first = extract(html, true);
    // Malformed markup can leave a "furniture" element open to the end of
    // the page; then fall back to skipping only scripts and styles.
    if first.text.chars().count() < 200 {
        let second = extract(html, false);
        if second.text.chars().count() > first.text.chars().count() * 2 {
            return Extracted { title: first.title.or(second.title), text: second.text };
        }
    }
    first
}

fn extract(html: &str, skip_furniture: bool) -> Extracted {
    let mut out = Out::default();
    let mut title: Option<String> = None;
    let mut skip_stack: Vec<String> = Vec::new();
    let mut main_depth = 0usize;
    let mut pre_depth = 0usize;
    let bytes = html.as_bytes();
    let mut i = 0;
    let mut text_start = 0;
    while i < bytes.len() {
        if bytes[i] != b'<' {
            i += 1;
            continue;
        }
        // Flush the text before this tag.
        if skip_stack.is_empty() && text_start < i {
            out.text(&html[text_start..i], pre_depth > 0, main_depth > 0);
        }
        let rest = &html[i..];
        if rest.starts_with("<!--") {
            i += rest.find("-->").map(|e| e + 3).unwrap_or(rest.len());
            text_start = i;
            continue;
        }
        if rest.starts_with("<!") || rest.starts_with("<?") {
            i += rest.find('>').map(|e| e + 1).unwrap_or(rest.len());
            text_start = i;
            continue;
        }
        let Some(tag) = parse_tag(rest) else {
            // A lone "<" in text.
            if skip_stack.is_empty() {
                out.text("<", pre_depth > 0, main_depth > 0);
            }
            i += 1;
            text_start = i;
            continue;
        };
        i += tag.len;
        text_start = i;
        let name = tag.name.as_str();

        // Raw text elements: jump to their end tag.
        if !tag.closing && (RAW_SKIP.contains(&name) || name == "title" || name == "textarea") && !tag.self_closing {
            let end = find_close(&html[i..], name);
            let inner = &html[i..i + end.0];
            if name == "title" && title.is_none() {
                let t = collapse(&decode_entities(inner));
                if !t.is_empty() {
                    title = Some(t);
                }
            }
            i += end.1;
            text_start = i;
            continue;
        }

        let furniture = skip_furniture && FURNITURE.contains(&name);
        if !skip_stack.is_empty() || furniture {
            if furniture || skip_stack.last().is_some_and(|s| s == name) {
                if tag.closing {
                    if let Some(pos) = skip_stack.iter().rposition(|s| s == name) {
                        skip_stack.truncate(pos);
                    }
                } else if !tag.self_closing && !VOID.contains(&name) {
                    skip_stack.push(name.to_string());
                }
            }
            continue;
        }

        let in_main = main_depth > 0;
        match name {
            "main" | "article" => {
                if tag.closing {
                    main_depth = main_depth.saturating_sub(1);
                } else {
                    main_depth += 1;
                }
                out.newline(1, in_main || main_depth > 0);
            }
            "pre" => {
                if tag.closing {
                    pre_depth = pre_depth.saturating_sub(1);
                } else {
                    pre_depth += 1;
                }
                out.newline(1, in_main);
            }
            "h1" | "h2" | "h3" | "h4" | "h5" | "h6" => {
                out.newline(2, in_main);
                if !tag.closing {
                    let level = name[1..].parse::<usize>().unwrap_or(1);
                    out.raw(&format!("{} ", "#".repeat(level)), in_main);
                }
            }
            "li" if !tag.closing => {
                out.newline(1, in_main);
                out.raw("- ", in_main);
            }
            "td" | "th" if !tag.closing => out.raw(" | ", in_main),
            "img" => {
                if let Some(alt) = tag.attr("alt").map(|a| collapse(&decode_entities(a))).filter(|a| !a.is_empty()) {
                    out.raw(&format!(" [image: {alt}] "), in_main);
                }
            }
            "p" | "blockquote" | "table" | "ul" | "ol" | "dl" | "figure" | "section" | "header" => out.newline(2, in_main),
            n if BLOCKS.contains(&n) => out.newline(1, in_main),
            _ => {}
        }
    }
    if skip_stack.is_empty() && text_start < bytes.len() {
        out.text(&html[text_start..], pre_depth > 0, main_depth > 0);
    }
    let all = tidy(&out.all);
    let main = tidy(&out.main);
    let use_main = main.chars().count() >= 500 && main.chars().count() * 10 >= all.chars().count() * 3;
    Extracted { title, text: if use_main { main } else { all } }
}

#[derive(Default)]
struct Out {
    all: String,
    main: String,
}

impl Out {
    fn push(&mut self, s: &str, main: bool) {
        self.all.push_str(s);
        if main {
            self.main.push_str(s);
        }
    }

    fn text(&mut self, raw: &str, pre: bool, main: bool) {
        let decoded = decode_entities(raw);
        if pre {
            self.push(&decoded, main);
            return;
        }
        let mut s = String::with_capacity(decoded.len());
        let mut space = false;
        for c in decoded.chars() {
            if c.is_whitespace() {
                space = true;
            } else {
                if space {
                    s.push(' ');
                    space = false;
                }
                s.push(c);
            }
        }
        if space {
            s.push(' ');
        }
        self.push(&s, main);
    }

    fn raw(&mut self, s: &str, main: bool) {
        self.push(s, main);
    }

    fn newline(&mut self, n: usize, main: bool) {
        self.push(&"\n".repeat(n), main);
    }
}

/// Trims every line, drops empty runs beyond one blank line.
fn tidy(text: &str) -> String {
    let mut out = String::new();
    let mut blank = 0;
    for line in text.lines() {
        // One leading space is left over from collapsed source whitespace;
        // more is indentation inside <pre>, which is kept.
        let line = line.trim_end();
        let line = match line.strip_prefix(' ') {
            Some(rest) if !rest.starts_with(char::is_whitespace) => rest,
            _ if line.trim().is_empty() => "",
            _ => line,
        };
        let line = line.trim_start_matches("| ").trim_end_matches(" |");
        if line.is_empty() || line == "-" || line == "|" {
            blank += 1;
            continue;
        }
        if !out.is_empty() {
            out.push_str(if blank > 0 { "\n\n" } else { "\n" });
        }
        blank = 0;
        out.push_str(line);
    }
    out
}

struct Tag {
    name: String,
    closing: bool,
    self_closing: bool,
    /// Bytes from `<` to `>` inclusive.
    len: usize,
    attrs: Vec<(String, String)>,
}

impl Tag {
    fn attr(&self, name: &str) -> Option<&str> {
        self.attrs.iter().find(|(k, _)| k == name).map(|(_, v)| v.as_str())
    }
}

/// Parses `<name attr="v" ...>` at the start of `s`.
fn parse_tag(s: &str) -> Option<Tag> {
    let b = s.as_bytes();
    let mut i = 1;
    let closing = b.get(i) == Some(&b'/');
    if closing {
        i += 1;
    }
    let start = i;
    while i < b.len() && (b[i].is_ascii_alphanumeric() || b[i] == b'-' || b[i] == b':') {
        i += 1;
    }
    if i == start || !b[start].is_ascii_alphabetic() {
        return None;
    }
    let name = s[start..i].to_ascii_lowercase();
    let mut attrs = Vec::new();
    let mut self_closing = false;
    loop {
        while i < b.len() && b[i].is_ascii_whitespace() {
            i += 1;
        }
        match b.get(i) {
            None => return Some(Tag { name, closing, self_closing, len: b.len(), attrs }),
            Some(b'>') => {
                return Some(Tag { name, closing, self_closing, len: i + 1, attrs });
            }
            Some(b'/') => {
                self_closing = true;
                i += 1;
            }
            Some(_) => {
                let ks = i;
                while i < b.len() && !b[i].is_ascii_whitespace() && !matches!(b[i], b'=' | b'>' | b'/') {
                    i += 1;
                }
                let key = s[ks..i].to_ascii_lowercase();
                while i < b.len() && b[i].is_ascii_whitespace() {
                    i += 1;
                }
                let mut value = String::new();
                if b.get(i) == Some(&b'=') {
                    i += 1;
                    while i < b.len() && b[i].is_ascii_whitespace() {
                        i += 1;
                    }
                    match b.get(i) {
                        Some(&q) if q == b'"' || q == b'\'' => {
                            let vs = i + 1;
                            let end = s[vs..].find(q as char).map(|e| vs + e).unwrap_or(b.len());
                            value = s[vs..end].to_string();
                            i = (end + 1).min(b.len());
                        }
                        _ => {
                            let vs = i;
                            while i < b.len() && !b[i].is_ascii_whitespace() && b[i] != b'>' {
                                i += 1;
                            }
                            value = s[vs..i].to_string();
                        }
                    }
                }
                if !key.is_empty() {
                    self_closing = false;
                    attrs.push((key, value));
                } else {
                    i += 1;
                }
            }
        }
    }
}

/// Finds `</name` (any case) in `s`: (start of the end tag, end of it).
fn find_close(s: &str, name: &str) -> (usize, usize) {
    let lower = s.to_ascii_lowercase();
    let needle = format!("</{name}");
    match lower.find(&needle) {
        Some(start) => {
            let end = lower[start..].find('>').map(|e| start + e + 1).unwrap_or(s.len());
            (start, end)
        }
        None => (s.len(), s.len()),
    }
}

fn collapse(s: &str) -> String {
    s.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// Decodes `&amp;`, `&#123;`, `&#x1F;` and the common named entities.
/// Unknown ones are left as written.
pub fn decode_entities(s: &str) -> String {
    if !s.contains('&') {
        return s.to_string();
    }
    let mut out = String::with_capacity(s.len());
    let mut rest = s;
    while let Some(pos) = rest.find('&') {
        out.push_str(&rest[..pos]);
        rest = &rest[pos..];
        let end = rest[1..].find(|c: char| c == ';' || c == '&' || c.is_whitespace()).map(|e| e + 1);
        match end {
            Some(e) if e <= 12 && rest.as_bytes().get(e) == Some(&b';') => {
                let name = &rest[1..e];
                if let Some(c) = entity(name) {
                    out.push_str(&c);
                    rest = &rest[e + 1..];
                    continue;
                }
                out.push('&');
                rest = &rest[1..];
            }
            _ => {
                out.push('&');
                rest = &rest[1..];
            }
        }
    }
    out.push_str(rest);
    out
}

fn entity(name: &str) -> Option<String> {
    if let Some(num) = name.strip_prefix('#') {
        let code = match num.strip_prefix(['x', 'X']) {
            Some(hex) => u32::from_str_radix(hex, 16).ok()?,
            None => num.parse::<u32>().ok()?,
        };
        return char::from_u32(code).filter(|c| *c != '\0').map(|c| c.to_string());
    }
    let c = match name {
        "amp" => "&",
        "lt" => "<",
        "gt" => ">",
        "quot" => "\"",
        "apos" => "'",
        "nbsp" => " ",
        "ensp" | "emsp" | "thinsp" => " ",
        "ndash" => "–",
        "mdash" => "—",
        "hellip" => "…",
        "lsquo" => "‘",
        "rsquo" => "’",
        "ldquo" => "“",
        "rdquo" => "”",
        "laquo" => "«",
        "raquo" => "»",
        "bull" => "•",
        "middot" => "·",
        "copy" => "©",
        "reg" => "®",
        "trade" => "™",
        "deg" => "°",
        "plusmn" => "±",
        "times" => "×",
        "divide" => "÷",
        "minus" => "−",
        "le" => "≤",
        "ge" => "≥",
        "ne" => "≠",
        "asymp" => "≈",
        "infin" => "∞",
        "micro" => "µ",
        "para" => "¶",
        "sect" => "§",
        "euro" => "€",
        "pound" => "£",
        "yen" => "¥",
        "cent" => "¢",
        "alpha" => "α",
        "beta" => "β",
        "gamma" => "γ",
        "delta" => "δ",
        "epsilon" => "ε",
        "lambda" => "λ",
        "mu" => "μ",
        "pi" => "π",
        "sigma" => "σ",
        "theta" => "θ",
        "omega" => "ω",
        "auml" => "ä",
        "ouml" => "ö",
        "uuml" => "ü",
        "Auml" => "Ä",
        "Ouml" => "Ö",
        "Uuml" => "Ü",
        "szlig" => "ß",
        "eacute" => "é",
        "egrave" => "è",
        "ecirc" => "ê",
        "aacute" => "á",
        "agrave" => "à",
        "acirc" => "â",
        "iacute" => "í",
        "oacute" => "ó",
        "uacute" => "ú",
        "ccedil" => "ç",
        "ntilde" => "ñ",
        "oslash" => "ø",
        "aring" => "å",
        "Eacute" => "É",
        "zwj" | "zwnj" | "shy" | "lrm" | "rlm" => "",
        _ => return None,
    };
    Some(c.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keeps_content_and_drops_furniture() {
        let html = r#"<!doctype html><html><head><title>My &amp; Page</title>
            <style>body{color:red}</style><script>var x = "<p>no</p>";</script></head>
            <body><nav><a href="/">Home</a> | <a href="/x">Menu</a></nav>
            <h1>Main   heading</h1><p>First <b>bold</b> paragraph&nbsp;here.</p>
            <ul><li>one</li><li>two &lt;3</li></ul>
            <!-- a comment <p>hidden</p> -->
            <table><tr><td>a</td><td>b</td></tr></table>
            <img src="x.png" alt="A plot">
            <footer>Copyright</footer></body></html>"#;
        let e = html_to_text(html);
        assert_eq!(e.title.as_deref(), Some("My & Page"));
        let t = e.text;
        assert!(t.contains("# Main heading"), "{t}");
        assert!(t.contains("First bold paragraph here."), "{t}");
        assert!(t.contains("- one\n- two <3"), "{t}");
        assert!(t.contains("a | b"), "{t}");
        assert!(t.contains("[image: A plot]"), "{t}");
        for gone in ["color:red", "var x", "Menu", "Copyright", "hidden"] {
            assert!(!t.contains(gone), "{gone} in {t}");
        }
    }

    #[test]
    fn prefers_the_article_when_it_has_the_content() {
        let body = "Real sentence of the article. ".repeat(30);
        let html = format!(
            "<div class=side>{}</div><article><h2>Title</h2><p>{body}</p></article><div>Related links</div>",
            "sidebar words ".repeat(5)
        );
        let t = html_to_text(&html).text;
        assert!(t.starts_with("## Title"), "{t}");
        assert!(!t.contains("sidebar"));
        assert!(!t.contains("Related links"));
    }

    #[test]
    fn pre_keeps_whitespace() {
        let t = html_to_text("<p>Code:</p><pre>a  = 1\n  b = 2</pre>").text;
        assert!(t.contains("a  = 1\n  b = 2"), "{t}");
    }

    #[test]
    fn survives_broken_markup() {
        let t = html_to_text("<p>ok <b unclosed <nav>never closed <p>still here").text;
        assert!(t.contains("ok"));
        let t = html_to_text("a < b and c > d").text;
        assert_eq!(t, "a < b and c > d");
        let t = html_to_text("<div><form>").text;
        assert_eq!(t, "");
        // An unclosed furniture element doesn't hide the page.
        let long = "word ".repeat(100);
        let t = html_to_text(&format!("<aside>{long}")).text;
        assert!(t.contains("word word"));
    }

    #[test]
    fn decodes_entities() {
        assert_eq!(decode_entities("&#65;&#x42;&eacute;&unknown;&amp;"), "ABé&unknown;&");
        assert_eq!(decode_entities("AT&T and & more"), "AT&T and & more");
        assert_eq!(decode_entities("&#0;x"), "&#0;x");
    }
}
