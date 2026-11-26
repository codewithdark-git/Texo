//! Page count of the last compiled PDF, without a PDF library: TeX's
//! "Output written on … (N pages, …)" log line, else the PDF's page tree
//! (also inside compressed object streams, which pdfTeX writes by default).

use std::collections::BTreeMap;
use std::io::Read;

use regex::bytes::Regex as BytesRegex;
use regex::Regex;

/// Inflated bytes looked at in total, so a hostile PDF can't eat memory.
const MAX_INFLATED: usize = 64 * 1024 * 1024;
/// Bigger PDFs aren't read (the log line covers them).
pub const MAX_PDF_BYTES: u64 = 200 * 1024 * 1024;

/// Pages from a TeX log: the last "Output written on" line, or 0 for "No
/// pages of output.". TeX wraps lines at 79 characters, so line breaks are
/// removed first.
pub fn from_log(log: &str) -> Option<u32> {
    let flat: String = log.chars().filter(|c| *c != '\n' && *c != '\r').collect();
    let re = Regex::new(r"Output written on .{0,1000}?\((\d+) pages?,").expect("regex");
    let written = re
        .captures_iter(&flat)
        .last()
        .and_then(|c| c[1].parse().ok());
    match written {
        Some(n) => {
            // A later run that produced nothing wins.
            let last_out = flat.rfind("Output written on").unwrap_or(0);
            match flat.rfind("No pages of output") {
                Some(at) if at > last_out => Some(0),
                _ => Some(n),
            }
        }
        None if flat.contains("No pages of output") => Some(0),
        None => None,
    }
}

/// One PDF object: number and body (dictionary, maybe with stream data).
struct Obj {
    num: u32,
    body: Vec<u8>,
}

fn find(hay: &[u8], needle: &[u8], from: usize) -> Option<usize> {
    if from >= hay.len() || needle.is_empty() {
        return None;
    }
    hay[from..]
        .windows(needle.len())
        .position(|w| w == needle)
        .map(|p| p + from)
}

/// Objects written plainly: `12 0 obj … endobj`.
fn plain_objects(pdf: &[u8]) -> Vec<Obj> {
    let re = BytesRegex::new(r"(\d{1,10})\s+\d{1,5}\s+obj\b").expect("regex");
    let mut out = Vec::new();
    let mut pos = 0;
    while let Some(m) = re.captures_at(pdf, pos) {
        let whole = m.get(0).expect("match");
        let num = std::str::from_utf8(&m[1])
            .ok()
            .and_then(|s| s.parse().ok())
            .unwrap_or(0);
        let start = whole.end();
        let end = find(pdf, b"endobj", start).unwrap_or(pdf.len());
        out.push(Obj {
            num,
            body: pdf[start..end].to_vec(),
        });
        pos = end.max(start);
    }
    out
}

fn dict_int(dict: &[u8], key: &str) -> Option<usize> {
    let re = BytesRegex::new(&format!(r"/{key}\s+(\d+)")).ok()?;
    let c = re.captures(dict)?;
    std::str::from_utf8(&c[1]).ok()?.parse().ok()
}

fn inflate(raw: &[u8], cap: usize) -> Option<Vec<u8>> {
    let mut out = Vec::new();
    let mut dec = flate2::read::ZlibDecoder::new(raw).take(cap as u64);
    match dec.read_to_end(&mut out) {
        Ok(_) => Some(out),
        Err(_) if !out.is_empty() => Some(out),
        Err(_) => None,
    }
}

/// The objects packed in an `/ObjStm` stream object.
fn stream_objects(obj: &Obj, budget: &mut usize) -> Vec<Obj> {
    let body = &obj.body;
    let Some(s) = find(body, b"stream", 0) else {
        return Vec::new();
    };
    let dict = &body[..s];
    if find(dict, b"/ObjStm", 0).is_none() || *budget == 0 {
        return Vec::new();
    }
    let mut data_start = s + b"stream".len();
    if body.get(data_start) == Some(&b'\r') {
        data_start += 1;
    }
    if body.get(data_start) == Some(&b'\n') {
        data_start += 1;
    }
    let data_end = find(body, b"endstream", data_start).unwrap_or(body.len());
    let raw = &body[data_start.min(data_end)..data_end];
    let data = if find(dict, b"/FlateDecode", 0).is_some() {
        match inflate(raw, *budget) {
            Some(d) => d,
            None => return Vec::new(),
        }
    } else if find(dict, b"/Filter", 0).is_some() {
        return Vec::new();
    } else {
        raw.to_vec()
    };
    *budget = budget.saturating_sub(data.len());
    let (Some(n), Some(first)) = (dict_int(dict, "N"), dict_int(dict, "First")) else {
        return Vec::new();
    };
    if first > data.len() {
        return Vec::new();
    }
    let header = String::from_utf8_lossy(&data[..first]);
    let nums: Vec<usize> = header
        .split_ascii_whitespace()
        .filter_map(|t| t.parse().ok())
        .collect();
    let pairs: Vec<(usize, usize)> = (0..nums.len() / 2)
        .take(n)
        .map(|i| (nums[2 * i], nums[2 * i + 1]))
        .collect();
    let mut out = Vec::new();
    for (i, (num, off)) in pairs.iter().enumerate() {
        let start = first + off;
        let end = pairs
            .get(i + 1)
            .map(|(_, o)| first + o)
            .unwrap_or(data.len());
        if start <= end && end <= data.len() {
            out.push(Obj {
                num: *num as u32,
                body: data[start..end].to_vec(),
            });
        }
    }
    out
}

/// Pages in a PDF: the root page tree's `/Count`, else the number of page
/// objects. `None` when it doesn't look like a PDF with pages.
pub fn from_pdf(pdf: &[u8]) -> Option<u32> {
    if !pdf.starts_with(b"%PDF") {
        return None;
    }
    let mut budget = MAX_INFLATED;
    let plain = plain_objects(pdf);
    // Later definitions (incremental updates) replace earlier ones.
    let mut objects: BTreeMap<u32, Vec<u8>> = BTreeMap::new();
    let mut packed = Vec::new();
    for o in &plain {
        packed.extend(stream_objects(o, &mut budget));
    }
    for o in packed.into_iter().chain(plain) {
        objects.insert(o.num, o.body);
    }
    let pages_re = BytesRegex::new(r"/Type\s*/Pages\b").expect("regex");
    let page_re = BytesRegex::new(r"/Type\s*/Page(?:[^A-Za-z]|$)").expect("regex");
    let mut root_count: Option<u32> = None;
    let mut page_objects = 0u32;
    for body in objects.values() {
        // Only the dictionary, not stream data.
        let dict = match find(body, b"stream", 0) {
            Some(s) => &body[..s],
            None => &body[..],
        };
        if pages_re.is_match(dict) {
            if find(dict, b"/Parent", 0).is_none() {
                if let Some(c) = dict_int(dict, "Count") {
                    root_count = Some(root_count.unwrap_or(0).max(c as u32));
                }
            }
        } else if page_re.is_match(dict) {
            page_objects += 1;
        }
    }
    match (root_count, page_objects) {
        (Some(c), _) if c > 0 => Some(c),
        (_, n) if n > 0 => Some(n),
        (Some(0), 0) => Some(0),
        _ => None,
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use std::io::Write;

    /// A plain (uncompressed) PDF with `n` pages.
    pub fn plain_pdf(n: u32) -> Vec<u8> {
        let mut s = String::from("%PDF-1.4\n1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n");
        let kids: Vec<String> = (0..n).map(|i| format!("{} 0 R", 3 + i)).collect();
        s.push_str(&format!(
            "2 0 obj\n<< /Type /Pages /Kids [{}] /Count {n} >>\nendobj\n",
            kids.join(" ")
        ));
        for i in 0..n {
            s.push_str(&format!(
                "{} 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] >>\nendobj\n",
                3 + i
            ));
        }
        s.push_str("trailer\n<< /Root 1 0 R >>\n%%EOF\n");
        s.into_bytes()
    }

    /// A PDF whose page tree sits in a Flate-compressed object stream, like
    /// pdfTeX writes by default.
    pub fn objstm_pdf(n: u32) -> Vec<u8> {
        let mut objs: Vec<(u32, String)> = vec![(1, "<< /Type /Catalog /Pages 2 0 R >>".into())];
        // An intermediate node, as in big documents.
        objs.push((2, format!("<< /Type /Pages /Kids [10 0 R] /Count {n} >>")));
        let kids: Vec<String> = (0..n).map(|i| format!("{} 0 R", 20 + i)).collect();
        objs.push((
            10,
            format!(
                "<< /Type /Pages /Parent 2 0 R /Kids [{}] /Count {n} >>",
                kids.join(" ")
            ),
        ));
        for i in 0..n {
            objs.push((
                20 + i,
                "<< /Type/Page/Parent 10 0 R/MediaBox[0 0 612 792] >>".into(),
            ));
        }
        let mut header = String::new();
        let mut body = String::new();
        for (num, text) in &objs {
            header.push_str(&format!("{num} {} ", body.len()));
            body.push_str(text);
            body.push('\n');
        }
        let content = format!("{header}{body}");
        let mut enc = flate2::write::ZlibEncoder::new(Vec::new(), flate2::Compression::default());
        enc.write_all(content.as_bytes()).unwrap();
        let data = enc.finish().unwrap();
        let mut pdf = b"%PDF-1.5\n".to_vec();
        pdf.extend_from_slice(
            format!(
                "5 0 obj\n<< /Type /ObjStm /N {} /First {} /Length {} /Filter /FlateDecode >>\nstream\n",
                objs.len(),
                header.len(),
                data.len()
            )
            .as_bytes(),
        );
        pdf.extend_from_slice(&data);
        pdf.extend_from_slice(b"\nendstream\nendobj\n%%EOF\n");
        pdf
    }

    #[test]
    fn counts_pages_in_plain_and_compressed_pdfs() {
        assert_eq!(from_pdf(&plain_pdf(1)), Some(1));
        assert_eq!(from_pdf(&plain_pdf(12)), Some(12));
        assert_eq!(from_pdf(&objstm_pdf(7)), Some(7));
        assert_eq!(from_pdf(b"not a pdf"), None);
        assert_eq!(from_pdf(b"%PDF-1.4\n"), None);
        // Garbage in a Flate stream doesn't panic.
        let mut bad =
            b"%PDF-1.5\n5 0 obj\n<< /Type /ObjStm /N 3 /First 10 /Filter /FlateDecode >>\nstream\n"
                .to_vec();
        bad.extend_from_slice(&[0x78, 0x9c, 0xff, 0x00, 0x13]);
        bad.extend_from_slice(b"\nendstream\nendobj\n");
        assert_eq!(from_pdf(&bad), None);
    }

    #[test]
    fn page_objects_count_when_the_tree_has_no_count() {
        let s = "%PDF-1.4\n1 0 obj\n<< /Type /Pages /Kids [2 0 R 3 0 R] >>\nendobj\n2 0 obj\n<< /Type /Page /Parent 1 0 R >>\nendobj\n3 0 obj\n<< /Type /Page /Parent 1 0 R >>\nendobj\n";
        assert_eq!(from_pdf(s.as_bytes()), Some(2));
    }

    #[test]
    fn reads_the_output_line_even_when_wrapped() {
        assert_eq!(
            from_log("Output written on main.pdf (12 pages, 345678 bytes).\n"),
            Some(12)
        );
        assert_eq!(
            from_log("Output written on main.pdf (1 page, 3456 bytes).\n"),
            Some(1)
        );
        let long = format!(
            "Output written on C:/Users/someone/Documents/{}/main.pdf (1\n4 pages, 1234 bytes).\n",
            "x".repeat(40)
        );
        assert_eq!(from_log(&long), Some(14));
        // Folder names with parentheses.
        assert_eq!(
            from_log("Output written on /home/a/Paper (v2)/build/main.pdf (9 pages, 1 bytes)."),
            Some(9)
        );
        assert_eq!(from_log("No pages of output.\n"), Some(0));
        assert_eq!(from_log("! Emergency stop.\n"), None);
        // The last run counts.
        assert_eq!(from_log("Output written on a.pdf (3 pages, 1 bytes).\nOutput written on a.pdf (4 pages, 1 bytes)."), Some(4));
    }
}
