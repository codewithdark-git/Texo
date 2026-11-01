//! Reads the `.synctex.gz` file TeX writes next to the PDF, to jump between a
//! source line and its position in the PDF.
//!
//! The format is line-based. After a header (`Input:3:./intro.tex`, `Unit:`,
//! offsets, `Magnification:`), the `Content:` section lists each page between
//! `{n` and `}n` as records like `(3,42:x,y:W,H,D` (an hbox from input 3,
//! line 42, at baseline position x,y with width, height, depth) or
//! `k3,42:x,y` (a kern, glue, math node, …). Positions are in scaled points
//! from the top-left of the page.
//!
//! All results use PDF points ("big points") from the page's top-left corner.

use std::collections::HashMap;
use std::io::Read;
use std::path::Path;

use serde::Serialize;

/// Scaled points per big point (1 bp = 65536 × 72.27 / 72 sp).
const SP_PER_BP: f64 = 65781.76;

#[derive(Debug, Clone, Copy, PartialEq)]
enum Kind {
    /// `(` hbox or `[` vbox, with a size.
    Box,
    /// `h`/`v` void boxes, `k` kern, `g` glue, `$` math, `x` current: a point.
    Point,
}

#[derive(Debug, Clone)]
struct Record {
    kind: Kind,
    input: u32,
    line: u32,
    x: f64,
    /// Baseline.
    y: f64,
    w: f64,
    h: f64,
    d: f64,
}

#[derive(Debug, Default)]
pub struct SyncTex {
    /// Input tag → project-relative file. Inputs outside the project (classes,
    /// packages) are dropped, and so are their records.
    inputs: HashMap<u32, String>,
    /// Records for each page, 1-based (index 0 unused).
    pages: Vec<Vec<Record>>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Rect {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ForwardResult {
    pub page: usize,
    /// Areas to highlight on that page; never empty.
    pub rects: Vec<Rect>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct InverseResult {
    pub file: String,
    pub line: u32,
}

/// Parses `tag,line:x,y` or `tag,line:x,y:W,H,D` after the record letter.
fn parse_fields(s: &str) -> Option<(u32, u32, [f64; 5], bool)> {
    let mut parts = s.split(':');
    let (tag, line) = parts.next()?.split_once(',')?;
    let (x, y) = parts.next()?.split_once(',')?;
    let mut nums = [0.0; 5];
    nums[0] = x.trim().parse().ok()?;
    nums[1] = y.trim().parse().ok()?;
    let sized = match parts.next() {
        Some(size) => {
            let mut it = size.split(',');
            for slot in nums.iter_mut().skip(2) {
                *slot = it.next()?.trim().parse().ok()?;
            }
            true
        }
        None => false,
    };
    Some((tag.trim().parse().ok()?, line.trim().parse().ok()?, nums, sized))
}

impl SyncTex {
    /// `map_input` turns a path from the file into a project-relative path,
    /// or None for files outside the project.
    pub fn parse(text: &str, map_input: impl Fn(&str) -> Option<String>) -> SyncTex {
        let mut st = SyncTex::default();
        let mut unit = 1.0;
        let mut mag = 1000.0;
        let (mut x_off, mut y_off) = (0.0, 0.0);
        let mut in_content = false;
        let mut page: Option<usize> = None;

        for raw in text.lines() {
            let line = raw.trim_end_matches('\r');
            if !in_content {
                if let Some(rest) = line.strip_prefix("Input:") {
                    if let Some((tag, path)) = rest.split_once(':') {
                        if let (Ok(tag), Some(file)) = (tag.parse(), map_input(path)) {
                            st.inputs.insert(tag, file);
                        }
                    }
                } else if let Some(v) = line.strip_prefix("Unit:") {
                    unit = v.trim().parse().unwrap_or(1.0);
                } else if let Some(v) = line.strip_prefix("Magnification:") {
                    mag = v.trim().parse().unwrap_or(1000.0);
                } else if let Some(v) = line.strip_prefix("X Offset:") {
                    x_off = v.trim().parse().unwrap_or(0.0);
                } else if let Some(v) = line.strip_prefix("Y Offset:") {
                    y_off = v.trim().parse().unwrap_or(0.0);
                } else if line == "Content:" {
                    in_content = true;
                }
                continue;
            }
            // Inputs can also appear inside the content (files opened later).
            if let Some(rest) = line.strip_prefix("Input:") {
                if let Some((tag, path)) = rest.split_once(':') {
                    if let (Ok(tag), Some(file)) = (tag.parse(), map_input(path)) {
                        st.inputs.insert(tag, file);
                    }
                }
                continue;
            }
            let Some(first) = line.chars().next() else { continue };
            match first {
                '{' => {
                    let n: usize = line[1..].trim().parse().unwrap_or(0);
                    if n > 0 {
                        if st.pages.len() <= n {
                            st.pages.resize_with(n + 1, Vec::new);
                        }
                        page = Some(n);
                    }
                }
                '}' => page = None,
                '(' | '[' | 'h' | 'v' | 'k' | 'g' | '$' | 'x' => {
                    let Some(p) = page else { continue };
                    let Some((input, line_no, n, sized)) = parse_fields(&line[1..]) else { continue };
                    if !st.inputs.contains_key(&input) {
                        continue;
                    }
                    let scale = unit * mag / 1000.0 / SP_PER_BP;
                    let kind = if matches!(first, '(' | '[') && sized { Kind::Box } else { Kind::Point };
                    st.pages[p].push(Record {
                        kind,
                        input,
                        line: line_no,
                        x: n[0] * scale + x_off / SP_PER_BP,
                        y: n[1] * scale + y_off / SP_PER_BP,
                        w: n[2] * scale,
                        h: n[3] * scale,
                        d: n[4] * scale,
                    });
                }
                _ => {}
            }
        }
        st
    }

    pub fn load(path: &Path, map_input: impl Fn(&str) -> Option<String>) -> std::io::Result<SyncTex> {
        let file = std::fs::File::open(path)?;
        let mut bytes = Vec::new();
        flate2::read::GzDecoder::new(file).read_to_end(&mut bytes)?;
        Ok(SyncTex::parse(&String::from_utf8_lossy(&bytes), map_input))
    }

    fn input_tag(&self, file: &str) -> Option<u32> {
        let want = file.to_lowercase();
        self.inputs.iter().find(|(_, f)| f.to_lowercase() == want).map(|(t, _)| *t)
    }

    /// Where `file:line` appears in the PDF. Falls back to the nearest line
    /// that produced output (blank lines and comments produce none).
    pub fn forward(&self, file: &str, line: u32) -> Option<ForwardResult> {
        let tag = self.input_tag(file)?;
        // Closest line with output, preferring the line itself, then later lines.
        let best_line = self
            .pages
            .iter()
            .flatten()
            .filter(|r| r.input == tag)
            .map(|r| r.line)
            .min_by_key(|&l| (l.abs_diff(line), l < line))?;
        let (page, records) = self
            .pages
            .iter()
            .enumerate()
            .find(|(_, recs)| recs.iter().any(|r| r.input == tag && r.line == best_line))?;
        let hits: Vec<&Record> = records.iter().filter(|r| r.input == tag && r.line == best_line).collect();

        let mut rects: Vec<Rect> = hits
            .iter()
            .filter(|r| r.kind == Kind::Box && r.w > 0.0 && r.h + r.d > 0.0)
            .map(|r| Rect { x: r.x, y: r.y - r.h, width: r.w, height: r.h + r.d })
            .collect();
        // Drop boxes that contain another hit box: keep the tightest areas.
        let all = rects.clone();
        rects.retain(|a| !all.iter().any(|b| b != a && contains(a, b)));
        if rects.is_empty() {
            // Only point records: mark a line-height area at the first one.
            let p = hits[0];
            rects.push(Rect { x: p.x, y: p.y - 10.0, width: 40.0, height: 12.0 });
        }
        Some(ForwardResult { page, rects })
    }

    /// The source line behind a point on a page.
    pub fn inverse(&self, page: usize, x: f64, y: f64) -> Option<InverseResult> {
        let records = self.pages.get(page)?;
        // The smallest box under the point…
        let container = records
            .iter()
            .filter(|r| r.kind == Kind::Box && x >= r.x && x <= r.x + r.w && y >= r.y - r.h && y <= r.y + r.d)
            .min_by(|a, b| (a.w * (a.h + a.d)).total_cmp(&(b.w * (b.h + b.d))));
        // …then the closest text record on that baseline, which is more
        // precise when a paragraph spans several source lines (the box itself
        // carries the line where the paragraph ended). Records left of the
        // point win ties, since a record marks where its text starts.
        let reach = |r: &Record| if r.x <= x + 0.5 { x - r.x } else { (r.x - x) * 1.5 };
        let best = match container {
            Some(b) => {
                let on_line: Vec<&Record> = records
                    .iter()
                    .filter(|r| r.kind == Kind::Point && r.input == b.input && (r.y - b.y).abs() < 0.5)
                    .collect();
                // Some records near the paragraph's start also carry the
                // paragraph-end line; skip them when the words say otherwise.
                let text: Vec<&Record> = on_line.iter().copied().filter(|r| r.line != b.line).collect();
                let pool = if text.is_empty() { on_line } else { text };
                pool.into_iter().min_by(|p, q| reach(p).total_cmp(&reach(q))).unwrap_or(b)
            }
            None => records.iter().min_by(|a, b| dist(a, x, y).total_cmp(&dist(b, x, y)))?,
        };
        Some(InverseResult { file: self.inputs.get(&best.input)?.clone(), line: best.line })
    }
}

fn contains(outer: &Rect, inner: &Rect) -> bool {
    outer.x <= inner.x
        && outer.y <= inner.y
        && outer.x + outer.width >= inner.x + inner.width
        && outer.y + outer.height >= inner.y + inner.height
}

fn dist(r: &Record, x: f64, y: f64) -> f64 {
    // Distance to the record's area (zero inside a box).
    let (left, right) = (r.x, r.x + r.w);
    let (top, bottom) = (r.y - r.h, r.y + r.d);
    let dx = if x < left { left - x } else if x > right { x - right } else { 0.0 };
    let dy = if y < top { top - y } else if y > bottom { y - bottom } else { 0.0 };
    dx.hypot(dy)
}

#[cfg(test)]
mod tests {
    use super::*;

    // One inch (72 bp) in scaled points, for readable fixtures.
    const IN: i64 = 4_736_286;

    fn sample() -> SyncTex {
        let bp = |v: f64| (v * SP_PER_BP).round() as i64;
        let text = format!(
            "SyncTeX Version:1\nInput:1:./main.tex\nInput:2:C:/MiKTeX/article.cls\nOutput:pdf\n\
             Magnification:1000\nUnit:1\nX Offset:0\nY Offset:0\nContent:\n!100\n{{1\n\
             [2,5:{IN},{IN}:1000,1000,0\n\
             (1,12:{IN},{y1}:{w},{h},{d}\n\
             x1,10:{IN},{y1}\nk1,11:{x2},{y1}\n)\n\
             (1,20:{IN},{y2}:{w},{h},{d}\n)\n]\n}}1\n{{2\n(1,30:{IN},{y1}:{w},{h},{d}\n)\n}}2\n",
            y1 = bp(100.0),
            y2 = bp(200.0),
            x2 = bp(250.0),
            w = bp(400.0),
            h = bp(8.0),
            d = bp(2.0),
        );
        SyncTex::parse(&text, |p| p.starts_with("./").then(|| p[2..].to_string()))
    }

    #[test]
    fn converts_units_and_skips_outside_files() {
        let st = sample();
        assert_eq!(st.inputs.len(), 1);
        let r = &st.pages[1][0];
        assert!((r.x - 72.0).abs() < 0.01 && (r.y - 100.0).abs() < 0.01);
        // The article.cls vbox was dropped.
        assert!(st.pages[1].iter().all(|r| r.input == 1));
    }

    #[test]
    fn forward_finds_the_line_box() {
        let st = sample();
        let f = st.forward("main.tex", 20).unwrap();
        assert_eq!(f.page, 1);
        assert_eq!(f.rects.len(), 1);
        let r = &f.rects[0];
        assert!((r.y - 192.0).abs() < 0.01 && (r.height - 10.0).abs() < 0.01 && (r.width - 400.0).abs() < 0.01);
        // Line 25 produced nothing; the nearest line with output is 20 or 30
        // (both 5 away), and the later one wins.
        assert_eq!(st.forward("main.tex", 25).unwrap().page, 2);
        assert_eq!(st.forward("MAIN.TEX", 30).unwrap().page, 2);
        assert!(st.forward("other.tex", 1).is_none());
    }

    #[test]
    fn inverse_picks_the_precise_line() {
        let st = sample();
        // Inside the paragraph line (its box carries the paragraph-end line,
        // 12), right of the kern from line 11.
        assert_eq!(st.inverse(1, 300.0, 99.0).unwrap(), InverseResult { file: "main.tex".into(), line: 11 });
        // Near the start of that box: line 10.
        assert_eq!(st.inverse(1, 80.0, 99.0).unwrap().line, 10);
        // Outside every box: the nearest record.
        assert_eq!(st.inverse(1, 80.0, 230.0).unwrap().line, 20);
        assert_eq!(st.inverse(2, 100.0, 100.0).unwrap().line, 30);
        assert!(st.inverse(9, 0.0, 0.0).is_none());
    }

    #[test]
    fn inverse_skips_paragraph_end_tags_on_text_lines() {
        // Real pdfTeX output: the text sits on line 73, the paragraph ends at
        // the blank line 74, and the first word's record carries 74 too.
        let text = "SyncTeX Version:1\nInput:1:./main.tex\nUnit:1\nX Offset:0\nY Offset:0\nContent:\n{1\n\
                    (1,74:4736286,47209025:30785865,494239,139502\n\
                    x1,74:7164281,47209025\ng1,73:7402212,47209025\nx1,73:8555970,47209025\n\
                    k1,74:35522151,47209025:18799510\n)\n}1\n";
        let st = SyncTex::parse(text, |p| p.strip_prefix("./").map(str::to_string));
        // A click on the first word ("Replace", x ≈ 76 bp).
        assert_eq!(st.inverse(1, 76.0, 716.0).unwrap().line, 73);
    }
}
