//! Best-effort text from a PDF, without a PDF library: inflates the
//! (Flate-compressed or plain) content streams and reads the strings shown by
//! the text operators (`Tj`, `TJ`, `'`, `"`). It works for many PDFs made by
//! LaTeX and office tools. PDFs whose fonts use custom glyph codes (common
//! with embedded subset fonts) come out as noise; those are detected and
//! reported as "not readable" rather than passed on to the model.


use std::io::Read;

/// Total inflated bytes looked at, so a "zip bomb" can't eat memory.
const MAX_INFLATED: usize = 24 * 1024 * 1024;
const MAX_STREAM: usize = 8 * 1024 * 1024;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PdfText {
    Text(String),
    /// Why there's no text, in plain words.
    NotReadable(&'static str),
}

pub fn extract(bytes: &[u8]) -> PdfText {
    if !bytes.starts_with(b"%PDF-") {
        return PdfText::NotReadable("The file isn't a valid PDF.");
    }
    if find(bytes, b"/Encrypt", 0).is_some() {
        return PdfText::NotReadable("The PDF is protected, so its text can't be read.");
    }
    let mut out = String::new();
    let mut inflated_total = 0usize;
    let mut pos = 0;
    while let Some(s) = find(bytes, b"stream", pos) {
        // `endstream` also contains "stream".
        if s >= 3 && &bytes[s - 3..s] == b"end" {
            pos = s + 6;
            continue;
        }
        let dict_start = rfind(&bytes[pos.min(s)..s], b"obj").map(|o| pos + o + 3).unwrap_or(pos).min(s);
        let dict = &bytes[dict_start..s];
        let mut data_start = s + 6;
        if bytes.get(data_start) == Some(&b'\r') {
            data_start += 1;
        }
        if bytes.get(data_start) == Some(&b'\n') {
            data_start += 1;
        }
        let Some(end) = find(bytes, b"endstream", data_start) else { break };
        pos = end + 9;
        let raw = &bytes[data_start..end];
        if skip_stream(dict) {
            continue;
        }
        let content: Vec<u8> = if contains(dict, b"/FlateDecode") || contains(dict, b"/Fl ") || contains(dict, b"/Fl]") {
            if has_other_filter(dict) {
                continue;
            }
            match inflate(raw, MAX_STREAM.min(MAX_INFLATED.saturating_sub(inflated_total))) {
                Some(c) => c,
                None => continue,
            }
        } else if contains(dict, b"/Filter") {
            continue;
        } else {
            raw.to_vec()
        };
        inflated_total += content.len();
        if !contains(&content, b"BT") {
            continue;
        }
        let text = content_text(&content);
        if !text.trim().is_empty() {
            out.push_str(&text);
            out.push_str("\n\n");
        }
        if inflated_total >= MAX_INFLATED {
            break;
        }
    }
    let text = tidy(&out);
    if text.chars().count() < 40 {
        return PdfText::NotReadable("The PDF has no text Texo can read (it may be scanned images).");
    }
    if !looks_like_language(&text) {
        return PdfText::NotReadable("The PDF's text is stored in a way Texo can't read.");
    }
    PdfText::Text(text)
}

fn skip_stream(dict: &[u8]) -> bool {
    [&b"/Image"[..], b"/XRef", b"/ObjStm", b"/Length1", b"/Length2", b"/Length3", b"/FontFile", b"/Metadata", b"/EmbeddedFile", b"/CMap"]
        .iter()
        .any(|k| contains(dict, k))
}

fn has_other_filter(dict: &[u8]) -> bool {
    [&b"/DCTDecode"[..], b"/JPXDecode", b"/CCITTFax", b"/JBIG2", b"/LZWDecode", b"/RunLength", b"/ASCII85", b"/ASCIIHex"]
        .iter()
        .any(|k| contains(dict, k))
}

fn inflate(raw: &[u8], cap: usize) -> Option<Vec<u8>> {
    if cap == 0 {
        return None;
    }
    let mut out = Vec::new();
    let mut dec = flate2::read::ZlibDecoder::new(raw).take(cap as u64);
    match dec.read_to_end(&mut out) {
        Ok(_) => Some(out),
        // Truncated streams still yield what was inflated.
        Err(_) if !out.is_empty() => Some(out),
        Err(_) => None,
    }
}

/// Reads the shown strings of one content stream.
fn content_text(c: &[u8]) -> String {
    let mut out = String::new();
    let mut operands: Vec<Operand> = Vec::new();
    let mut in_text = false;
    let mut last_y: Option<f64> = None;
    let mut i = 0;
    while i < c.len() {
        let b = c[i];
        match b {
            b'%' => {
                while i < c.len() && c[i] != b'\n' && c[i] != b'\r' {
                    i += 1;
                }
            }
            b'(' => {
                let (s, next) = literal_string(c, i);
                operands.push(Operand::Str(s));
                i = next;
                continue;
            }
            b'<' if c.get(i + 1) == Some(&b'<') => {
                // Inline dictionary: skip to ">>".
                i = find(c, b">>", i + 2).map(|e| e + 2).unwrap_or(c.len());
                operands.clear();
                continue;
            }
            b'<' => {
                let end = c[i..].iter().position(|&x| x == b'>').map(|e| i + e).unwrap_or(c.len());
                operands.push(Operand::Str(hex_string(&c[i + 1..end])));
                i = end + 1;
                continue;
            }
            b'[' => {
                // A TJ array: strings and kerning numbers.
                let mut parts = Vec::new();
                i += 1;
                while i < c.len() && c[i] != b']' {
                    match c[i] {
                        b'(' => {
                            let (s, next) = literal_string(c, i);
                            parts.push(Operand::Str(s));
                            i = next;
                        }
                        b'<' => {
                            let end = c[i..].iter().position(|&x| x == b'>').map(|e| i + e).unwrap_or(c.len());
                            parts.push(Operand::Str(hex_string(&c[i + 1..end])));
                            i = end + 1;
                        }
                        x if x == b'-' || x == b'.' || x.is_ascii_digit() => {
                            let s = i;
                            while i < c.len() && (c[i] == b'-' || c[i] == b'.' || c[i].is_ascii_digit()) {
                                i += 1;
                            }
                            parts.push(Operand::Num(std::str::from_utf8(&c[s..i]).ok().and_then(|t| t.parse().ok()).unwrap_or(0.0)));
                        }
                        _ => i += 1,
                    }
                }
                operands.push(Operand::Array(parts));
                i += 1;
                continue;
            }
            x if x == b'-' || x == b'+' || x == b'.' || x.is_ascii_digit() => {
                let s = i;
                i += 1;
                while i < c.len() && (c[i] == b'.' || c[i].is_ascii_digit()) {
                    i += 1;
                }
                let n = std::str::from_utf8(&c[s..i]).ok().and_then(|t| t.parse().ok()).unwrap_or(0.0);
                operands.push(Operand::Num(n));
                continue;
            }
            b'/' => {
                i += 1;
                while i < c.len() && !is_delim(c[i]) {
                    i += 1;
                }
                operands.push(Operand::Other);
                continue;
            }
            x if x.is_ascii_alphabetic() || x == b'\'' || x == b'"' || x == b'*' => {
                let s = i;
                i += 1;
                while i < c.len() && (c[i].is_ascii_alphabetic() || c[i] == b'*' || c[i] == b'\'' || c[i] == b'"') {
                    i += 1;
                }
                let op = &c[s..i];
                match op {
                    b"BT" => in_text = true,
                    b"ET" => {
                        in_text = false;
                        out.push(' ');
                    }
                    b"Tj" | b"'" | b"\"" if in_text => {
                        if op != b"Tj" {
                            out.push('\n');
                        }
                        if let Some(Operand::Str(s)) = operands.last() {
                            out.push_str(&decode_bytes(s));
                        }
                    }
                    b"TJ" if in_text => {
                        if let Some(Operand::Array(parts)) = operands.last() {
                            for p in parts {
                                match p {
                                    Operand::Str(s) => out.push_str(&decode_bytes(s)),
                                    Operand::Num(n) if *n < -180.0 => out.push(' '),
                                    _ => {}
                                }
                            }
                        }
                    }
                    b"Td" | b"TD" => {
                        let ty = match operands.as_slice() {
                            [.., Operand::Num(_), Operand::Num(y)] => *y,
                            _ => 0.0,
                        };
                        out.push(if ty.abs() > 0.01 { '\n' } else { ' ' });
                    }
                    b"T*" => out.push('\n'),
                    b"Tm" => {
                        let y = match operands.as_slice() {
                            [.., Operand::Num(y)] => Some(*y),
                            _ => None,
                        };
                        let new_line = match (last_y, y) {
                            (Some(a), Some(b)) => (a - b).abs() > 0.5,
                            _ => true,
                        };
                        last_y = y;
                        out.push(if new_line { '\n' } else { ' ' });
                    }
                    _ => {}
                }
                operands.clear();
                continue;
            }
            _ => {}
        }
        i += 1;
    }
    out
}

enum Operand {
    Str(Vec<u8>),
    Num(f64),
    Array(Vec<Operand>),
    Other,
}

fn is_delim(b: u8) -> bool {
    b.is_ascii_whitespace() || matches!(b, b'(' | b')' | b'<' | b'>' | b'[' | b']' | b'{' | b'}' | b'/' | b'%')
}

/// `( ... )` with nesting and escapes, from `start` (the `(`).
fn literal_string(c: &[u8], start: usize) -> (Vec<u8>, usize) {
    let mut out = Vec::new();
    let mut depth = 0;
    let mut i = start;
    while i < c.len() {
        let b = c[i];
        match b {
            b'(' => {
                if depth > 0 {
                    out.push(b);
                }
                depth += 1;
            }
            b')' => {
                depth -= 1;
                if depth == 0 {
                    return (out, i + 1);
                }
                out.push(b);
            }
            b'\\' => {
                i += 1;
                let Some(&e) = c.get(i) else { break };
                match e {
                    b'n' => out.push(b'\n'),
                    b'r' => out.push(b'\r'),
                    b't' => out.push(b'\t'),
                    b'b' | b'f' => {}
                    b'0'..=b'7' => {
                        let mut v: u32 = 0;
                        let mut n = 0;
                        while n < 3 && i < c.len() && (b'0'..=b'7').contains(&c[i]) {
                            v = v * 8 + u32::from(c[i] - b'0');
                            i += 1;
                            n += 1;
                        }
                        out.push((v & 0xff) as u8);
                        continue;
                    }
                    b'\r' | b'\n' => {}
                    other => out.push(other),
                }
            }
            _ => out.push(b),
        }
        i += 1;
    }
    (out, c.len())
}

fn hex_string(h: &[u8]) -> Vec<u8> {
    let digits: Vec<u8> = h.iter().copied().filter(u8::is_ascii_hexdigit).collect();
    digits
        .chunks(2)
        .map(|p| {
            let hi = (p[0] as char).to_digit(16).unwrap_or(0);
            let lo = p.get(1).and_then(|d| (*d as char).to_digit(16)).unwrap_or(0);
            (hi * 16 + lo) as u8
        })
        .collect()
}

/// Bytes of a shown string as text: UTF-16BE when it has a BOM, otherwise
/// Latin-1 with the TeX ligature slots mapped.
fn decode_bytes(s: &[u8]) -> String {
    if s.starts_with(&[0xFE, 0xFF]) {
        let units: Vec<u16> = s[2..].chunks(2).map(|p| u16::from_be_bytes([p[0], *p.get(1).unwrap_or(&0)])).collect();
        return String::from_utf16_lossy(&units);
    }
    let mut out = String::with_capacity(s.len());
    for &b in s {
        match b {
            // OT1 and T1 ligature slots used by TeX fonts.
            0x0B | 0x1B => out.push_str("ff"),
            0x0C | 0x1C => out.push_str("fi"),
            0x0D | 0x1D => out.push_str("fl"),
            0x0E | 0x1E => out.push_str("ffi"),
            0x0F | 0x1F => out.push_str("ffl"),
            // 0x0D (CR) is the fl slot above.
            b'\n' | b'\t' => out.push(' '),
            0x00..=0x1F => out.push('\u{FFFD}'),
            0x93 => out.push('“'),
            0x94 => out.push('”'),
            0x91 => out.push('‘'),
            0x92 => out.push('’'),
            0x96 => out.push('–'),
            0x97 => out.push('—'),
            b => out.push(b as char),
        }
    }
    out
}

fn tidy(text: &str) -> String {
    let mut out = String::new();
    let mut blank = 0;
    for line in text.lines() {
        let line = line.split_whitespace().collect::<Vec<_>>().join(" ");
        if line.is_empty() {
            blank += 1;
            continue;
        }
        if !out.is_empty() {
            out.push_str(if blank > 0 { "\n\n" } else { "\n" });
        }
        blank = 0;
        out.push_str(&line);
    }
    out
}

/// Real text is mostly letters and spaces, with word lengths people use.
fn looks_like_language(text: &str) -> bool {
    let total = text.chars().filter(|c| !c.is_whitespace()).count().max(1);
    let letters = text.chars().filter(|c| c.is_alphabetic()).count();
    let junk = text.chars().filter(|c| *c == '\u{FFFD}' || (c.is_control() && *c != '\n')).count();
    let words: Vec<&str> = text.split_whitespace().collect();
    let avg = if words.is_empty() { 0.0 } else { total as f64 / words.len() as f64 };
    letters * 100 / total >= 60 && junk * 100 / total < 5 && (2.0..=14.0).contains(&avg)
}

fn find(hay: &[u8], needle: &[u8], from: usize) -> Option<usize> {
    if from >= hay.len() || needle.is_empty() {
        return None;
    }
    hay[from..].windows(needle.len()).position(|w| w == needle).map(|p| p + from)
}

fn rfind(hay: &[u8], needle: &[u8]) -> Option<usize> {
    hay.windows(needle.len()).rposition(|w| w == needle)
}

fn contains(hay: &[u8], needle: &[u8]) -> bool {
    find(hay, needle, 0).is_some()
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use std::io::Write;

    /// A one-page PDF whose page content is `content`, Flate-compressed.
    pub fn sample_pdf(content: &str) -> Vec<u8> {
        let mut enc = flate2::write::ZlibEncoder::new(Vec::new(), flate2::Compression::default());
        enc.write_all(content.as_bytes()).unwrap();
        let data = enc.finish().unwrap();
        let mut pdf = b"%PDF-1.5\n1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n".to_vec();
        pdf.extend_from_slice(b"2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n");
        pdf.extend_from_slice(b"3 0 obj\n<< /Type /Page /Parent 2 0 R /Contents 4 0 R >>\nendobj\n");
        pdf.extend_from_slice(format!("4 0 obj\n<< /Length {} /Filter /FlateDecode >>\nstream\n", data.len()).as_bytes());
        pdf.extend_from_slice(&data);
        pdf.extend_from_slice(b"\nendstream\nendobj\ntrailer\n<< /Root 1 0 R >>\n%%EOF\n");
        pdf
    }

    /// The same with an uncompressed content stream (ASCII only).
    pub fn sample_pdf_plain(content: &str) -> Vec<u8> {
        let mut pdf = b"%PDF-1.4
1 0 obj
<< /Type /Catalog /Pages 2 0 R >>
endobj
".to_vec();
        pdf.extend_from_slice(format!("4 0 obj
<< /Length {} >>
stream
{content}
endstream
endobj
%%EOF
", content.len()).as_bytes());
        pdf
    }

    #[test]
    fn reads_text_operators() {
        let content = "BT /F1 12 Tf 72 700 Td (Deep learning allows computational models) Tj 0 -14 Td \
            [(that are com) 20 (posed of multiple) -250 (processing layers)] TJ T* (to learn \\(rep\\)resentations of data.) Tj \
            0 -14 Td <48656c6c6f> Tj ( with the e\\016cient \\014nd) Tj ET";
        let PdfText::Text(t) = extract(&sample_pdf(content)) else { panic!("not readable") };
        assert!(t.contains("Deep learning allows computational models"), "{t}");
        assert!(t.contains("that are composed of multiple processing layers"), "{t}");
        assert!(t.contains("to learn (rep)resentations of data."), "{t}");
        assert!(t.contains("Hello with the efficient find"), "{t}");
        assert!(t.lines().count() >= 3, "{t}");
    }

    #[test]
    fn glyph_codes_are_reported_not_passed_on() {
        let content = format!("BT {} ET", "<0012003400560078001200AB> Tj ".repeat(30));
        assert!(matches!(extract(&sample_pdf(&content)), PdfText::NotReadable(_)));
    }

    #[test]
    fn non_pdf_encrypted_and_empty() {
        assert!(matches!(extract(b"<html>"), PdfText::NotReadable(_)));
        let mut enc = sample_pdf("BT (Some words here that are long enough to count for something.) Tj ET");
        enc.extend_from_slice(b"<< /Encrypt 9 0 R >>");
        assert_eq!(extract(&enc), PdfText::NotReadable("The PDF is protected, so its text can't be read."));
        assert!(matches!(extract(&sample_pdf("0 0 m 10 10 l S")), PdfText::NotReadable(_)));
        // Garbage in a Flate stream doesn't panic.
        let mut bad = b"%PDF-1.4\n1 0 obj\n<< /Filter /FlateDecode >>\nstream\n".to_vec();
        bad.extend_from_slice(&[0x78, 0x9c, 0xff, 0x00, 0x13]);
        bad.extend_from_slice(b"\nendstream\nendobj\n");
        assert!(matches!(extract(&bad), PdfText::NotReadable(_)));
    }
}
