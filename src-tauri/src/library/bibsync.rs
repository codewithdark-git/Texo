//! Links a project's `.bib` entries to library rows ("In this project"):
//! finds the databases the document uses, reads every entry, matches it to
//! a paper by DOI, then arXiv id, then title, and records the cite key.

use std::collections::HashSet;
use std::path::{Path, PathBuf};

use rusqlite::{params, Connection};
use serde::Serialize;
use walkdir::WalkDir;

use super::store::{self, PaperInput, Provenance};
use super::LibResult;
use crate::agents::tools::bibtex::{self, BibRecord};
use crate::bibinputs::{self, BibInputs};

/// Most `.bib` files read when the document names none.
const MAX_BIB_FILES: usize = 50;
/// Most entries linked in one scan.
const MAX_ENTRIES: usize = 5000;
/// How deep the fallback search for `.bib` files goes below the project.
const MAX_WALK_DEPTH: usize = 4;
/// Folders the fallback search never enters (besides hidden ones).
const SKIP_DIRS: [&str; 10] = ["node_modules", "target", "build", "dist", "out", "venv", "env", "__pycache__", "data", "datasets"];

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BibSyncReport {
    /// Project-relative paths, with forward slashes.
    pub files: Vec<String>,
    pub entries: usize,
    /// Entries matched to a paper already in the library.
    pub matched: usize,
    /// Entries that became new library rows.
    pub added: usize,
    /// Links dropped because their entry left the `.bib` files.
    pub removed: usize,
}

/// The `.bib` files of a project: the ones its main document uses, or, when
/// it names none that exist, every `.bib` file in the folder.
pub fn bib_files(root: &Path) -> Vec<PathBuf> {
    let main = crate::project::read_meta(root).and_then(|m| m.main_document);
    let mut out: Vec<PathBuf> = Vec::new();
    if let Some(main) = main {
        let found = BibInputs::find(root, &root.join(main));
        for p in found.entries.into_iter().filter_map(|(_, p)| p) {
            if bibinputs::is_inside(root, &p) && !out.contains(&p) {
                out.push(p);
            }
        }
    }
    if out.is_empty() {
        out = WalkDir::new(root)
            .max_depth(MAX_WALK_DEPTH)
            .into_iter()
            .filter_entry(|e| e.depth() == 0 || !e.file_type().is_dir() || !skipped_dir(&e.file_name().to_string_lossy()))
            .filter_map(Result::ok)
            .filter(|e| e.file_type().is_file())
            .filter(|e| e.path().extension().is_some_and(|x| x.eq_ignore_ascii_case("bib")))
            .map(|e| e.into_path())
            .take(MAX_BIB_FILES)
            .collect();
        out.sort();
    }
    out
}

/// A folder the fallback search leaves out: hidden ones (`.texo`, `.git`)
/// and build output, packages and data.
fn skipped_dir(name: &str) -> bool {
    name.starts_with('.') || name == crate::project::META_DIR || SKIP_DIRS.iter().any(|d| d.eq_ignore_ascii_case(name))
}

/// "Last, First" → "First Last", without TeX markup.
fn display_name(name: &str) -> String {
    let plain = bibtex::plain(name);
    match plain.split_once(',') {
        Some((last, first)) if !first.trim().is_empty() => format!("{} {}", first.trim(), last.trim()),
        _ => plain.trim().to_string(),
    }
}

/// A `.bib` entry as library input (no source: it isn't a service hit).
pub fn entry_input(rec: &BibRecord) -> PaperInput {
    let get = |name: &str| rec.get(name).map(bibtex::plain).map(|s| s.trim().to_string()).filter(|s| !s.is_empty());
    let authors = rec.get("author").map(bibtex::split_names).unwrap_or_default();
    PaperInput {
        title: get("title").unwrap_or_default(),
        authors: authors.iter().map(|a| display_name(a)).filter(|a| !a.is_empty()).collect(),
        year: rec.year(),
        venue: get("journal").or_else(|| get("booktitle")),
        volume: get("volume"),
        issue: get("number"),
        pages: get("pages").map(|p| p.replace("--", "–")),
        publisher: get("publisher"),
        doi: rec.doi(),
        arxiv: rec.arxiv_id(),
        landing_url: get("url"),
        work_type: Some(rec.entry_type.clone()),
        ..Default::default()
    }
}

fn rel_path(root: &Path, file: &Path) -> String {
    file.strip_prefix(root).unwrap_or(file).to_string_lossy().replace('\\', "/")
}

/// What [`scan`] read from a project, ready for [`apply`].
#[derive(Debug, Clone, Default)]
pub struct BibScan {
    /// Project-relative paths, with forward slashes.
    files: Vec<String>,
    /// (file, entry) in file order.
    entries: Vec<(String, BibRecord)>,
    /// The project's display name.
    name: Option<String>,
}

/// Finds, reads and parses the project's `.bib` files. Only file I/O: run
/// it before taking the library's writer.
pub fn scan(root: &Path) -> BibScan {
    let files = bib_files(root);
    let mut entries: Vec<(String, BibRecord)> = Vec::new();
    for f in &files {
        let Some(text) = bibinputs::read_text(f) else { continue };
        let rel = rel_path(root, f);
        for rec in bibtex::parse_entries(&text) {
            if entries.len() >= MAX_ENTRIES {
                break;
            }
            entries.push((rel.clone(), rec));
        }
    }
    BibScan {
        files: files.iter().map(|f| rel_path(root, f)).collect(),
        entries,
        name: crate::project::read_meta(root).map(|m| m.name),
    }
}

/// [`scan`] then [`apply`] on one connection. Tests only: the app scans
/// before it takes the writer (`library_sync_bib`).
#[cfg(test)]
pub fn sync(conn: &mut Connection, root: &Path, project: &str, now: i64) -> LibResult<BibSyncReport> {
    apply(conn, &scan(root), project, now)
}

/// Links every scanned entry to a library row (`project_refs`,
/// `in_bib = 1`, `added_by = 'bib-scan'`), all in one transaction. Links the
/// scan made earlier whose entry is gone are dropped; links made another way
/// are kept but marked as not in the `.bib`.
pub fn apply(conn: &mut Connection, scan: &BibScan, project: &str, now: i64) -> LibResult<BibSyncReport> {
    let mut report = BibSyncReport { files: scan.files.clone(), entries: scan.entries.len(), ..Default::default() };
    let tx = conn.transaction()?;
    let project_id = store::project_id(&tx, project, scan.name.as_deref())?;
    let prov = Provenance::default();
    let mut linked: HashSet<i64> = HashSet::new();
    for (file, rec) in &scan.entries {
        let Some(up) = store::upsert_one(&tx, &entry_input(rec), &prov, now)? else { continue };
        if up.created {
            report.added += 1;
        } else {
            report.matched += 1;
        }
        // A key moves to the paper it now names.
        tx.execute(
            "UPDATE project_refs SET cite_key = NULL WHERE project_id = ?1 AND cite_key = ?2 AND paper_id <> ?3",
            params![project_id, rec.key, up.id],
        )?;
        tx.execute(
            "INSERT INTO project_refs(project_id, paper_id, cite_key, bib_file, in_bib, added_by, added_at) \
             VALUES (?1, ?2, ?3, ?4, 1, 'bib-scan', ?5) \
             ON CONFLICT(project_id, paper_id) DO UPDATE SET cite_key = excluded.cite_key, bib_file = excluded.bib_file, in_bib = 1",
            params![project_id, up.id, rec.key, file, now],
        )?;
        linked.insert(up.id);
    }
    let stale: Vec<(i64, Option<String>)> = {
        let mut stmt = tx.prepare("SELECT paper_id, added_by FROM project_refs WHERE project_id = ?1")?;
        let rows = stmt.query_map(params![project_id], |r| Ok((r.get(0)?, r.get(1)?)))?;
        rows.collect::<Result<Vec<_>, _>>()?.into_iter().filter(|(id, _)| !linked.contains(id)).collect()
    };
    for (paper_id, added_by) in stale {
        if added_by.as_deref() == Some("bib-scan") {
            tx.execute("DELETE FROM project_refs WHERE project_id = ?1 AND paper_id = ?2", params![project_id, paper_id])?;
            report.removed += 1;
        } else {
            tx.execute("UPDATE project_refs SET in_bib = 0 WHERE project_id = ?1 AND paper_id = ?2", params![project_id, paper_id])?;
        }
    }
    tx.commit()?;
    Ok(report)
}

/// TeX's special characters in plain text, escaped for a `.bib` value.
/// Braces become text commands rather than `\{`, because BibTeX counts
/// every brace, escaped or not, and an unbalanced one ends the value early.
fn tex_escape(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for c in s.chars() {
        match c {
            '&' | '%' | '#' | '_' | '$' => {
                out.push('\\');
                out.push(c);
            }
            '\\' => out.push_str("\\textbackslash{}"),
            '{' => out.push_str("\\textbraceleft{}"),
            '}' => out.push_str("\\textbraceright{}"),
            '^' => out.push_str("\\textasciicircum{}"),
            '~' => out.push_str("\\textasciitilde{}"),
            _ => out.push(c),
        }
    }
    out
}

/// A value BibTeX takes as it is (DOI, eprint, URL): braces and backslashes
/// can't be escaped there, so they are dropped to keep the entry balanced.
fn verbatim(s: &str) -> String {
    s.chars().filter(|c| !matches!(c, '{' | '}' | '\\')).collect()
}

/// A library paper as a BibTeX entry with an `authorYEARword` key that is
/// not in `used` (`smith2020`, then `smith2020a`, ...). The key is added to
/// `used`.
pub fn paper_record(p: &store::LibraryPaper, used: &mut HashSet<String>) -> BibRecord {
    let field = |name: &str, value: &str| bibtex::BibField { name: name.to_string(), raw: format!("{{{value}}}") };
    let mut fields = vec![field("title", &format!("{{{}}}", tex_escape(&p.title)))];
    if !p.authors.is_empty() {
        fields.push(field("author", &p.authors.iter().map(|a| tex_escape(a)).collect::<Vec<_>>().join(" and ")));
    }
    let kind = p.work_type.as_deref().unwrap_or_default().to_lowercase();
    let proceedings = kind.contains("proceedings") || kind.contains("conference");
    let entry_type = if proceedings {
        "inproceedings"
    } else if p.venue.is_none() {
        "misc"
    } else {
        "article"
    };
    if let Some(v) = &p.venue {
        fields.push(field(if proceedings { "booktitle" } else { "journal" }, &tex_escape(v)));
    }
    if let Some(y) = p.year {
        fields.push(field("year", &y.to_string()));
    }
    for (name, value) in [("volume", &p.volume), ("number", &p.issue), ("pages", &p.pages), ("publisher", &p.publisher)] {
        if let Some(v) = value {
            fields.push(field(name, &tex_escape(&v.replace('–', "--"))));
        }
    }
    if let Some(d) = &p.ids.doi {
        fields.push(field("doi", &verbatim(d)));
    }
    if let Some(a) = &p.ids.arxiv {
        fields.push(field("eprint", &verbatim(a)));
        fields.push(field("archiveprefix", "arXiv"));
    }
    if let Some(u) = &p.url {
        fields.push(field("url", &verbatim(u)));
    }
    let mut rec = bibtex::normalise(&BibRecord { entry_type: entry_type.to_string(), key: String::new(), fields, line: 0 });
    let base = rec.key.clone();
    let mut key = base.clone();
    let mut n = 0u32;
    while used.contains(&key.to_lowercase()) {
        key = format!("{base}{}", suffix(n));
        n += 1;
    }
    used.insert(key.to_lowercase());
    rec.key = key;
    rec
}

/// a, b, ..., z, aa, ab, ...
fn suffix(mut n: u32) -> String {
    let mut out = Vec::new();
    loop {
        out.push((b'a' + (n % 26) as u8) as char);
        if n < 26 {
            break;
        }
        n = n / 26 - 1;
    }
    out.iter().rev().collect()
}

/// The papers as one `.bib` text.
pub fn to_bibtex(papers: &[store::LibraryPaper]) -> String {
    let mut used = HashSet::new();
    let mut out = String::new();
    for p in papers {
        out.push_str(&bibtex::format(&paper_record(p, &mut used)));
        out.push_str("\n\n");
    }
    out
}
