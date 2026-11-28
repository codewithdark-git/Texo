//! The literature tools with the paper library (WP-06): what a search
//! finds is saved and cached across restarts, the library is searched
//! offline, whole bibliographies are checked and remembered, BibTeX goes in
//! through the overlay with a free key, and everything still works when
//! there is no library.

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use serde_json::{json, Value};

use super::*;
use crate::agents::overlay::Overlay;
use crate::agents::tools::build::BuildState;
use crate::agents::tools::literature::SourceSet;
use crate::agents::tools::registry::{self, Builtin, Tool, ToolCx, ToolOutput};
use crate::ai::http::Cancel;
use crate::ai::mock::{runtime, Canned, MockServer};
use crate::library::online::{self, LibraryProgress, OnlineOpts};

/// Nothing listens here: a request to it fails at once.
const NOWHERE: &str = "http://127.0.0.1:9";

struct Env {
    _dir: tempfile::TempDir,
    lib_dir: PathBuf,
    project: PathBuf,
}

fn env() -> Env {
    let dir = tempfile::tempdir().unwrap();
    let lib_dir = dir.path().join("library");
    let project = dir.path().join("paper");
    fs::create_dir_all(&project).unwrap();
    fs::write(project.join("main.tex"), "\\documentclass{article}\n\\begin{document}\nHi\n\\end{document}\n").unwrap();
    Env { _dir: dir, lib_dir, project }
}

fn open(dir: &Path) -> Arc<Library> {
    let (lib, warning) = Library::open(dir).unwrap();
    assert!(warning.is_none(), "{warning:?}");
    Arc::new(lib)
}

#[derive(Default)]
struct Servers {
    s2: Option<String>,
    crossref: Option<String>,
    doi: Option<String>,
    arxiv: Option<String>,
}

/// A context that reaches only the given mock services.
fn ctx(s: Servers, lib: Option<Arc<Library>>) -> NetCtx {
    let mut c = NetCtx::new(Cancel::default());
    c.services.pacing = false;
    c.services.semantic_scholar = format!("{}/graph/v1", s.s2.clone().unwrap_or_else(|| NOWHERE.into()));
    c.services.crossref = s.crossref.clone().unwrap_or_else(|| NOWHERE.into());
    c.services.doi = s.doi.unwrap_or_else(|| NOWHERE.into());
    c.services.arxiv_api = format!("{}/api/query", s.arxiv.clone().unwrap_or_else(|| NOWHERE.into()));
    c.services.arxiv_bibtex = NOWHERE.into();
    c.services.openalex = NOWHERE.into();
    c.sources = SourceSet { s2: s.s2.is_some(), crossref: s.crossref.is_some(), arxiv: s.arxiv.is_some(), openalex: false };
    attach(&mut c, lib);
    c
}

fn tool_cx(root: &Path, net: NetCtx) -> ToolCx {
    ToolCx {
        root: root.to_path_buf(),
        run_id: "run-1".into(),
        kind: "task".into(),
        overlay: Arc::new(Mutex::new(Overlay::new(root, Vec::<(String, String)>::new()))),
        build: Arc::new(BuildState::new("run-1", None)),
        net: Some(net),
        cancel: Cancel::default(),
        progress: None,
    }
}

fn call(cx: &ToolCx, name: &str, args: Value) -> ToolOutput {
    let tool = Builtin::from_name(name).unwrap();
    runtime().block_on(tool.call(cx, &args))
}

fn s2_search() -> Canned {
    Canned::json(
        200,
        json!({"total": 2, "data": [
            {"paperId": "p1", "title": "Deep Learning", "year": 2015, "venue": "Nature", "externalIds": {"DOI": "10.1038/nature14539"},
             "authors": [{"name": "Yann LeCun"}], "abstract": "Deep learning allows computational models to learn.", "citationCount": 50000,
             "tldr": {"text": "Deep nets learn representations."}},
            {"paperId": "p2", "title": "Attention Is All You Need", "year": 2017, "venue": "NeurIPS", "externalIds": {"ArXiv": "1706.03762"},
             "authors": [{"name": "Ashish Vaswani"}], "abstract": "The dominant sequence transduction models.", "citationCount": 90000}
        ]}),
    )
}

fn csl(title: &str, family: &str, year: i32) -> Canned {
    Canned::json(200, json!({"title": title, "author": [{"given": "A", "family": family}], "issued": {"date-parts": [[year]]}, "container-title": "Journal"}))
}

fn empty_feed() -> Canned {
    let mut c = Canned::json(200, Value::Null);
    c.body = r#"<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom"><title>x</title></feed>"#.into();
    c.content_type = "application/atom+xml";
    c
}

fn count(lib: &Library, sql: &str) -> i64 {
    lib.read(|c| Ok(c.query_row(sql, [], |r| r.get(0))?)).unwrap()
}

#[test]
fn a_search_saves_its_papers_and_reports_them_as_step_data() {
    let e = env();
    let s2 = MockServer::start(vec![s2_search()]);
    let lib = open(&e.lib_dir);
    let cx = tool_cx(&e.project, ctx(Servers { s2: Some(s2.base_url.clone()), ..Default::default() }, Some(lib.clone())));
    let out = call(&cx, "search_papers", json!({"query": "deep learning", "limit": 5, "sort": "cited", "year_from": 2010}));
    assert!(out.ok, "{}", out.content);
    assert!(out.summary.contains("2 found, 2 new"), "{}", out.summary);
    let papers = out.data.as_ref().unwrap()["papers"].as_array().unwrap().clone();
    assert_eq!(papers.len(), 2);
    assert!(papers.len() <= crate::agents::types::MAX_DATA_PAPERS);
    for p in &papers {
        assert!(!p["uid"].as_str().unwrap().starts_with("online:"), "{p}");
        assert!(p.get("snippet").is_none());
    }
    // Cited first.
    assert_eq!(papers[0]["title"], "Attention Is All You Need");
    assert_eq!(count(&lib, "SELECT count(*) FROM papers"), 2);
    assert_eq!(count(&lib, "SELECT count(*) FROM run_finds WHERE run_id = 'run-1' AND tool = 'search_papers'"), 2);
    let path = &s2.recorded()[0].path;
    assert!(path.contains("year=2010-"), "{path}");
    // The model never sees step data.
    assert!(!out.content.contains("\"uid\""));
}

#[test]
fn the_same_search_after_a_restart_sends_no_request() {
    let e = env();
    let s2 = MockServer::start(vec![s2_search()]);
    let servers = || Servers { s2: Some(s2.base_url.clone()), ..Default::default() };
    {
        let lib = open(&e.lib_dir);
        let cx = tool_cx(&e.project, ctx(servers(), Some(lib.clone())));
        assert!(call(&cx, "search_papers", json!({"query": "deep learning"})).ok);
        lib.close();
    }
    assert_eq!(s2.recorded().len(), 1);
    let lib = open(&e.lib_dir);
    let cx = tool_cx(&e.project, ctx(servers(), Some(lib)));
    let out = call(&cx, "search_papers", json!({"query": "Deep   Learning"}));
    assert!(out.ok, "{}", out.content);
    assert!(out.summary.contains("2 found"), "{}", out.summary);
    assert!(!out.summary.contains("new"), "{}", out.summary);
    assert_eq!(s2.recorded().len(), 1, "the second search came from the library's cache");
}

#[test]
fn library_search_works_offline_and_names_the_projects_keys() {
    let e = env();
    let lib = open(&e.lib_dir);
    fs::write(
        e.project.join("refs.bib"),
        "@article{vaswani2017, title={Attention Is All You Need}, author={Vaswani, Ashish}, year={2017}, eprint={1706.03762}, archiveprefix={arXiv}}\n",
    )
    .unwrap();
    let project = e.project.to_string_lossy().to_string();
    lib.write(|c| bibsync::sync(c, &e.project, &project, now_ms())).unwrap();
    let other = PaperInput { title: "Transformers for graphs".into(), year: Some(2021), ..Default::default() };
    lib.write(|c| store::upsert_papers(c, &[other], &Provenance::default(), now_ms())).unwrap();

    // No service is reachable.
    let cx = tool_cx(&e.project, ctx(Servers::default(), Some(lib)));
    let out = call(&cx, "library_search", json!({"query": "attention"}));
    assert!(out.ok, "{}", out.content);
    assert!(out.content.contains("Attention Is All You Need"), "{}", out.content);
    assert!(out.content.contains("\\cite{vaswani2017}"), "{}", out.content);
    assert_eq!(out.data.as_ref().unwrap()["papers"].as_array().unwrap().len(), 1);
    let out = call(&cx, "library_search", json!({"query": "quantum gravity"}));
    assert!(out.ok && out.content.contains("search_papers"), "{}", out.content);
}

fn three_entries(dir: &Path) {
    fs::write(
        dir.join("refs.bib"),
        "@article{lecun2015, title={Deep learning}, author={LeCun, Yann and Bengio, Yoshua}, year={2015}, doi={10.1038/nature14539}}\n\n\
         @article{wrongyear, title={Attention is all you need}, author={Vaswani, Ashish}, year={2001}, doi={10.5555/attention}}\n\n\
         @misc{ghost, title={A paper that does not exist}, author={Nobody, Anne}, year={2020}, eprint={2101.99999}, archiveprefix={arXiv}}\n",
    )
    .unwrap();
}

#[test]
fn verify_bibliography_checks_every_key_saves_the_results_and_caches_the_lookups() {
    let e = env();
    three_entries(&e.project);
    let doi = MockServer::start(vec![csl("Deep learning", "LeCun", 2015), csl("Attention is all you need", "Vaswani", 2017)]);
    let arxiv = MockServer::start(vec![empty_feed()]);
    let lib = open(&e.lib_dir);
    let servers = || Servers { doi: Some(doi.base_url.clone()), arxiv: Some(arxiv.base_url.clone()), ..Default::default() };
    let cx = tool_cx(&e.project, ctx(servers(), Some(lib.clone())));
    let out = call(&cx, "verify_bibliography", json!({}));
    assert!(out.ok, "{}", out.content);
    assert!(out.content.starts_with("Checked 3 entries: 1 verified, 1 mismatch, 1 not found, 0 unchecked."), "{}", out.content);
    assert!(out.content.contains("lecun2015: Verified"), "{}", out.content);
    assert!(out.content.contains("wrongyear: Mismatch"), "{}", out.content);
    assert!(out.content.contains("ghost: NotFound"), "{}", out.content);
    assert_eq!(out.summary, "Checked 3 citation(s): 1 verified, 2 to look at");

    let saved: Vec<(String, String)> = lib
        .read(|c| {
            let mut stmt = c.prepare("SELECT cite_key, verify_status FROM project_refs WHERE verified_at IS NOT NULL ORDER BY cite_key")?;
            let rows = stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?;
            Ok(rows.collect::<Result<Vec<_>, _>>()?)
        })
        .unwrap();
    assert_eq!(
        saved,
        vec![("ghost".into(), "notFound".into()), ("lecun2015".into(), "verified".into()), ("wrongyear".into(), "mismatch".into())]
    );
    let project = e.project.to_string_lossy().to_string();
    let refs = lib.read(|c| store::project_refs(c, &project)).unwrap();
    let lecun = refs.iter().find(|p| p.in_project.as_ref().and_then(|r| r.cite_key.as_deref()) == Some("lecun2015")).unwrap();
    assert_eq!(lecun.in_project.as_ref().unwrap().verify.as_deref(), Some("verified"));

    // Again (one key): the DOI lookup comes from the cache.
    assert_eq!(doi.recorded().len(), 2);
    let bib = fs::read_to_string(e.project.join("refs.bib")).unwrap();
    let rec = bibtex::find_entry(&bib, "wrongyear").unwrap();
    let again = runtime().block_on(verify_entry(&cx.net.clone().unwrap(), "refs.bib", &rec)).unwrap();
    assert!(again.cached);
    assert_eq!(again.check.status, CitationStatus::Mismatch);
    assert!(again.check.differences.iter().any(|d| d.contains("2001")), "{:?}", again.check.differences);
    let out = call(&cx, "verify_bibliography", json!({"keys": ["lecun2015", "LECUN2015", "nope"]}));
    assert!(out.ok, "{}", out.content);
    assert!(out.content.starts_with("Checked 1 entry: 1 verified"), "{}", out.content);
    assert!(out.content.contains("Not in any .bib file: nope."), "{}", out.content);
    assert_eq!(doi.recorded().len(), 2, "no new DOI request");
    assert_eq!(arxiv.recorded().len(), 1);
}

#[test]
fn verify_bibliography_records_only_entries_on_disk() {
    let e = env();
    let lecun = "@article{lecun2015, title={Deep learning}, author={LeCun, Yann}, year={2015}, doi={10.1038/nature14539}}\n";
    fs::write(e.project.join("refs.bib"), lecun).unwrap();
    let doi = MockServer::start(vec![csl("Deep learning", "LeCun", 2015), csl("Deep nets for everything", "Smith", 2020)]);
    let lib = open(&e.lib_dir);
    let cx = tool_cx(&e.project, ctx(Servers { doi: Some(doi.base_url.clone()), ..Default::default() }, Some(lib.clone())));
    // The run added an entry that only its overlay holds so far.
    {
        let mut o = cx.overlay();
        o.write("refs.bib", &format!("{lecun}\n{SMITH}\n"), "Added Smith_2020").unwrap();
    }
    let out = call(&cx, "verify_bibliography", json!({}));
    assert!(out.ok, "{}", out.content);
    assert!(out.content.starts_with("Checked 2 entries:"), "{}", out.content);
    assert!(out.content.contains("Smith_2020"), "the overlay entry is checked: {}", out.content);
    let keys: Vec<String> = lib
        .read(|c| {
            let mut stmt = c.prepare("SELECT cite_key FROM project_refs WHERE cite_key IS NOT NULL ORDER BY cite_key")?;
            let rows = stmt.query_map([], |r| r.get(0))?;
            Ok(rows.collect::<Result<Vec<_>, _>>()?)
        })
        .unwrap();
    assert_eq!(keys, vec!["lecun2015".to_string()], "the overlay-only entry is not \"in this project\"");

    // An entry the run changed is checked against the overlay, not recorded.
    let checks = vec![(
        bibtex::parse_entries("@article{lecun2015, title={Deep learning}, author={LeCun, Yann}, year={2016}}")[0].clone(),
        BibCheck { file: "refs.bib".into(), check: CitationCheck { key: "lecun2015".into(), status: CitationStatus::Verified, message: String::new(), differences: vec![], found: None }, cached: false, failed: false },
    )];
    assert!(on_disk(checks.clone(), &online::bib_texts(&e.project)).is_empty());
    let same = vec![(bibtex::parse_entries(lecun)[0].clone(), checks[0].1.clone())];
    assert_eq!(on_disk(same, &online::bib_texts(&e.project)).len(), 1);
}

#[test]
fn step_data_leaves_out_the_users_own_library_data() {
    let e = env();
    let lib = open(&e.lib_dir);
    let p = Paper { title: "Deep Learning".into(), doi: Some("10.1038/nature14539".into()), sources: vec!["Crossref".into()], ..Default::default() };
    let (saved, _) = store_papers(&lib, std::slice::from_ref(&p), &Provenance { save: true, ..Default::default() }).unwrap();
    let uid = saved[0].uid.clone();
    lib.write(|c| store::set_tags(c, &uid, &["private".into()], now_ms()).map(|_| ())).unwrap();
    lib.write(|c| store::set_note(c, &uid, Some("reviewer 2 wrote this; don't cite"), now_ms())).unwrap();
    let mut paper = lib.read(|c| store::get(c, &uid, None)).unwrap().unwrap();
    paper.found_by.push(store::RunFind { run_id: "other-run".into(), tool: Some("search_papers".into()), at: 1 });
    assert_eq!(paper.note.as_deref(), Some("reviewer 2 wrote this; don't cite"));
    assert_eq!(paper.tags, vec!["private".to_string()]);

    let data = step_data(std::slice::from_ref(&paper));
    let text = data.to_string();
    assert!(!text.contains("reviewer 2") && !text.contains("private") && !text.contains("other-run"), "{text}");
    let v = &data["papers"][0];
    assert_eq!(v["uid"], json!(uid));
    assert_eq!(v["note"], Value::Null);
    assert_eq!(v["tags"], json!([]), "kept as an empty list so the card still reads the paper");
    assert_eq!(v["foundBy"], json!([]));
    assert_eq!(v["saved"], json!(true));
}

fn bibtex_reply(body: &str) -> Canned {
    let mut c = Canned::json(200, Value::Null);
    c.body = body.into();
    c.content_type = "application/x-bibtex";
    c
}

const SMITH: &str = "@article{Smith_2020, title={Deep nets for everything}, author={Smith, Jane}, year={2020}, journal={J. Tests}, doi={10.1000/new}}";

#[test]
fn insert_bibtex_picks_a_free_key_and_goes_through_the_overlay() {
    let e = env();
    let base = bibtex::normalise(&bibtex::parse_entries(SMITH)[0]).key;
    let existing = format!("@article{{{base},\r\n  title = {{Another paper}},\r\n  author = {{Smith, Jane}},\r\n  year = {{2020}},\r\n  doi = {{10.1000/old}}\r\n}}\r\n");
    fs::write(e.project.join("refs.bib"), &existing).unwrap();
    let doi = MockServer::start(vec![bibtex_reply(SMITH)]);
    let cx = tool_cx(&e.project, ctx(Servers { doi: Some(doi.base_url.clone()), ..Default::default() }, Some(open(&e.lib_dir))));
    let out = call(&cx, "insert_bibtex", json!({"id": "10.1000/new"}));
    assert!(out.ok, "{}", out.content);
    let key = format!("{base}a");
    assert!(out.content.contains(&format!("as {key} ({base} was taken)")), "{}", out.content);
    assert_eq!(out.summary, format!("Added {key} to refs.bib"));

    // On disk nothing changed; the change waits in the overlay for review.
    assert_eq!(fs::read_to_string(e.project.join("refs.bib")).unwrap(), existing);
    let changes = cx.overlay().changes();
    assert_eq!(changes.len(), 1);
    let text = cx.overlay().peek("refs.bib").unwrap().unwrap();
    assert!(text.starts_with(existing.trim_end()));
    assert!(text.contains(&format!("@article{{{key},")), "{text}");
    assert!(!text.replace("\r\n", "").contains('\n'), "the file keeps its CRLF line endings");

    // The same paper twice is refused, naming where it is.
    let out = call(&cx, "insert_bibtex", json!({"id": "10.1000/old"}));
    assert!(!out.ok);
    assert!(out.content.contains(&format!("already in refs.bib as {base}")), "{}", out.content);
    // Several .bib files: it asks which one.
    fs::write(e.project.join("more.bib"), "").unwrap();
    let cx2 = tool_cx(&e.project, ctx(Servers::default(), None));
    let out = call(&cx2, "insert_bibtex", json!({"id": "10.1000/x"}));
    assert!(!out.ok && out.content.contains("bib_file"), "{}", out.content);
}

#[test]
fn every_new_tool_brings_outside_text_and_chat_mirrors_them() {
    let new = [registry::LIBRARY_SEARCH, registry::PAPER_DETAILS, registry::VERIFY_BIBLIOGRAPHY, registry::INSERT_BIBTEX];
    for name in new {
        assert!(registry::brings_outside_text(name), "{name}");
        assert!(registry::all_names().contains(&name));
    }
    let net = NetCtx::new(Cancel::default());
    let names = |tools: Vec<Arc<dyn Tool>>| tools.iter().map(|t| t.spec().name).collect::<Vec<_>>();
    let read_only = names(registry::tools_by_name(&[registry::LITERATURE, registry::BIB_WRITE].concat(), Some(&net)));
    assert!(read_only.contains(&"verify_bibliography".to_string()));
    assert!(!read_only.contains(&"insert_bibtex".to_string()), "only kinds that change files get insert_bibtex");
    let writer = names(registry::tools_by_name(&[registry::FS_WRITE, registry::BIB_WRITE].concat(), Some(&net)));
    assert!(writer.contains(&"insert_bibtex".to_string()));
    assert!(!Builtin::InsertBibtex.read_only() && Builtin::VerifyBibliography.read_only());

    let chat: Vec<String> = crate::chat::tools::specs(false).into_iter().map(|s| s.name).collect();
    for name in [registry::LIBRARY_SEARCH, registry::PAPER_DETAILS, registry::VERIFY_BIBLIOGRAPHY] {
        assert!(chat.contains(&name.to_string()), "{name}");
    }
    assert!(!chat.contains(&"insert_bibtex".to_string()), "chat can't change files");
    let with_web: Vec<String> = crate::chat::tools::specs(true).into_iter().map(|s| s.name).collect();
    let at = with_web.iter().position(|n| n == "web_search").unwrap();
    assert_eq!(with_web[at - 1], "fetch_url");
}

#[test]
fn the_online_search_reports_each_source_pending_then_ok() {
    let e = env();
    let s2 = MockServer::start(vec![s2_search()]);
    let crossref = MockServer::start(vec![Canned::json(
        200,
        json!({"message": {"items": [{"DOI": "10.1038/nature14539", "title": ["Deep learning"], "author": [{"given": "Yann", "family": "LeCun"}], "issued": {"date-parts": [[2015]]}, "container-title": ["Nature"]}]}}),
    )]);
    let c = ctx(Servers { s2: Some(s2.base_url.clone()), crossref: Some(crossref.base_url.clone()), ..Default::default() }, Some(open(&e.lib_dir)));
    let seen: Arc<Mutex<Vec<LibraryProgress>>> = Arc::default();
    let sink = seen.clone();
    let emit: online::Emit = Arc::new(move |p| sink.lock().unwrap().push(p));
    let opts = OnlineOpts { limit: Some(20), ..Default::default() };
    let r = runtime().block_on(online::search_online(&c, "req-7", "deep learning", &opts, None, emit)).unwrap();
    assert!(r.stored && r.warning.is_none());
    assert_eq!(r.items.len(), 2, "the DOI match merged");
    assert!(r.items.iter().all(|p| !p.uid.starts_with("online:")));
    let events = seen.lock().unwrap().clone();
    assert!(events.iter().all(|p| p.request_id == "req-7"));
    let states = |source: &str| events.iter().filter(|p| p.source == source).map(|p| p.state).collect::<Vec<_>>();
    assert_eq!(states("s2"), vec!["pending", "ok"]);
    assert_eq!(states("crossref"), vec!["pending", "ok"]);
    assert_eq!(states("arxiv"), vec!["skipped"]);
    let ok = events.iter().find(|p| p.source == "s2" && p.state == "ok").unwrap();
    assert_eq!(ok.detail.as_deref(), Some("2 results"));
}

fn details_replies() -> Vec<Canned> {
    vec![
        Canned::json(
            200,
            json!({"paperId": "abc", "title": "Deep learning", "year": 2015, "externalIds": {"DOI": "10.1038/nature14539"},
                   "authors": [{"name": "Yann LeCun"}], "abstract": "A long abstract about deep learning.", "tldr": {"text": "Deep nets work."},
                   "citationCount": 100, "influentialCitationCount": 7, "openAccessPdf": {"url": "https://example.org/dl.pdf"}}),
        ),
        Canned::json(200, json!({"data": [{"citedPaper": {"paperId": "r1", "title": "Learning representations by back-propagating errors", "year": 1986, "authors": [{"name": "David Rumelhart"}]}}]})),
        Canned::json(200, json!({"data": [{"citingPaper": {"paperId": "c1", "title": "Deep residual learning", "year": 2016, "authors": [{"name": "Kaiming He"}], "externalIds": {"ArXiv": "1512.03385"}}}]})),
    ]
}

#[test]
fn paper_details_lists_references_and_citations_and_is_cached() {
    let e = env();
    let s2 = MockServer::start(details_replies());
    let lib = open(&e.lib_dir);
    let cx = tool_cx(&e.project, ctx(Servers { s2: Some(s2.base_url.clone()), ..Default::default() }, Some(lib.clone())));
    let out = call(&cx, "paper_details", json!({"id": "https://doi.org/10.1038/nature14539"}));
    assert!(out.ok, "{}", out.content);
    for want in ["TL;DR: Deep nets work.", "Cited by 100 (7 influential)", "Free PDF: https://example.org/dl.pdf", "References (first 1):", "back-propagating", "Deep residual learning", "arXiv: 1512.03385"] {
        assert!(out.content.contains(want), "{want}: {}", out.content);
    }
    let paths: Vec<String> = s2.recorded().iter().map(|r| r.path.clone()).collect();
    assert!(paths[0].starts_with("/graph/v1/paper/DOI:10.1038/nature14539?fields="), "{paths:?}");
    assert!(paths[1].starts_with("/graph/v1/paper/DOI:10.1038/nature14539/references?"), "{paths:?}");
    assert!(paths[2].contains("/citations?"), "{paths:?}");
    assert_eq!(count(&lib, "SELECT count(*) FROM run_finds WHERE tool = 'paper_details'"), 1);
    // By its library id now, from the cache.
    let uid = out.data.as_ref().unwrap()["papers"][0]["uid"].as_str().unwrap().to_string();
    let again = call(&cx, "paper_details", json!({"id": uid}));
    assert!(again.ok, "{}", again.content);
    assert_eq!(s2.recorded().len(), 3);
}

#[test]
fn without_a_library_every_tool_still_works() {
    let e = env();
    three_entries(&e.project);
    let mut replies = vec![s2_search()];
    replies.extend(details_replies());
    let s2 = MockServer::start(replies);
    let doi = MockServer::start(vec![
        csl("Deep learning", "LeCun", 2015),
        csl("Attention is all you need", "Vaswani", 2017),
        bibtex_reply(SMITH),
    ]);
    let arxiv = MockServer::start(vec![empty_feed()]);
    let c = ctx(
        Servers { s2: Some(s2.base_url.clone()), doi: Some(doi.base_url.clone()), arxiv: Some(arxiv.base_url.clone()), ..Default::default() },
        None,
    );
    // arXiv only answers the citation check.
    let mut c = c;
    c.sources.arxiv = false;
    assert!(c.library.is_none());
    let cx = tool_cx(&e.project, c);
    let out = call(&cx, "search_papers", json!({"query": "unique words for the memory cache test"}));
    assert!(out.ok, "{}", out.content);
    let papers = out.data.as_ref().unwrap()["papers"].as_array().unwrap().clone();
    assert!(papers.iter().all(|p| p["uid"].as_str().unwrap().starts_with("online:")));
    let out = call(&cx, "paper_details", json!({"id": "10.1038/nature14539"}));
    assert!(out.ok, "{}", out.content);
    let out = call(&cx, "library_search", json!({"query": "deep"}));
    assert!(out.ok && out.content.contains("isn't available"), "{}", out.content);
    let out = call(&cx, "verify_bibliography", json!({}));
    assert!(out.ok, "{}", out.content);
    assert!(out.content.starts_with("Checked 3 entries: 1 verified, 1 mismatch, 1 not found"), "{}", out.content);
    let out = call(&cx, "insert_bibtex", json!({"id": "10.1000/new", "bib_file": "refs.bib"}));
    assert!(out.ok, "{}", out.content);
    // The in-memory cache answers a repeat.
    let out = call(&cx, "search_papers", json!({"query": "unique words for the memory cache test"}));
    assert!(out.ok, "{}", out.content);
    assert_eq!(s2.recorded().len(), 4);
}

#[test]
fn keys_and_entries_are_built_safely() {
    assert_eq!(suffix(0), "a");
    assert_eq!(suffix(25), "z");
    assert_eq!(suffix(26), "aa");
    assert_eq!(append_entry("", "@misc{a,\n}"), "@misc{a,\n}\n");
    assert_eq!(append_entry("@misc{a,\n}\n\n\n", "@misc{b,\n}"), "@misc{a,\n}\n\n@misc{b,\n}\n");
    assert_eq!(pick_bib(&[], None).unwrap(), "references.bib");
    assert_eq!(pick_bib(&[("a.bib".into(), String::new())], None).unwrap(), "a.bib");
    assert!(pick_bib(&[], Some("notes.txt")).is_err());
    assert_eq!(pick_bib(&[], Some("refs\\x.bib")).unwrap(), "refs/x.bib");
    assert_eq!(s2_id_for(None, "arXiv:1706.03762v2").unwrap(), "ARXIV:1706.03762");
    assert_eq!(s2_id_for(None, "CorpusId:123").unwrap(), "CorpusId:123");
    assert!(s2_id_for(None, "not an id").is_err());
    let chipped = chip(&SourceEvent { source: Source::OpenAlex, state: SourceState::Skipped("Key not set".into()) }).unwrap();
    assert_eq!((chipped.source.as_str(), chipped.detail.as_deref()), ("OpenAlex", Some("Key not set")));
    assert!(chip(&SourceEvent { source: Source::Arxiv, state: SourceState::Skipped("Turned off in Settings".into()) }).is_none());
}

fn library_uid(lib: &Library, title: &str) -> String {
    lib.read(|c| Ok(c.query_row("SELECT uid FROM papers WHERE title = ?1", [title], |r| r.get(0))?)).unwrap()
}

#[test]
fn insert_bibtex_builds_from_the_library_only_when_it_is_safe() {
    let e = env();
    let existing = "@article{old2020,\n  title = {Old paper},\n  author = {Smith, Jane},\n  year = {2020},\n  doi = {10.1000/old}\n}\n";
    fs::write(e.project.join("refs.bib"), existing).unwrap();
    let lib = open(&e.lib_dir);
    let found = |title: &str, doi: Option<&str>| Paper {
        title: title.into(),
        authors: vec!["Jane Smith".into()],
        year: Some(2021),
        venue: Some("J. Tests".into()),
        doi: doi.map(str::to_string),
        sources: vec!["Crossref".into()],
        ..Default::default()
    };
    let papers = [
        found("Old paper", Some("10.1000/old")),
        found("Gone paper", Some("10.1000/gone")),
        found("Offline paper", Some("10.1000/offline")),
        found("No id paper", None),
    ];
    store_papers(&lib, &papers, &Provenance::default()).unwrap();
    // A paper that only came from some project's .bib file.
    let rec = bibtex::parse_entries("@misc{fake1999, title={Made up paper}, author={Nobody, A.}, year={1999}}").remove(0);
    lib.write(|c| {
        let tx = c.transaction()?;
        store::upsert_one(&tx, &bibsync::entry_input(&rec), &Provenance::default(), now_ms())?;
        tx.commit()?;
        Ok(())
    })
    .unwrap();

    // The service says the DOI doesn't exist: refused, not built from the library.
    let doi = MockServer::start(vec![Canned::json(404, json!({}))]);
    let cx = tool_cx(&e.project, ctx(Servers { doi: Some(doi.base_url.clone()), ..Default::default() }, Some(lib.clone())));
    let out = call(&cx, "insert_bibtex", json!({"id": library_uid(&lib, "Gone paper")}));
    assert!(!out.ok, "{}", out.content);
    assert!(cx.overlay().changes().is_empty());

    // Offline: the library's entry, marked unchecked.
    let cx = tool_cx(&e.project, ctx(Servers::default(), Some(lib.clone())));
    let out = call(&cx, "insert_bibtex", json!({"id": library_uid(&lib, "Offline paper")}));
    assert!(out.ok, "{}", out.content);
    assert!(out.content.contains("couldn't reach the service"), "{}", out.content);
    assert!(out.content.contains("10.1000/offline"), "{}", out.content);

    // A library paper the .bib file already cites is refused before any
    // request, even offline, instead of a second copy under a new key.
    let out = call(&cx, "insert_bibtex", json!({"id": library_uid(&lib, "Old paper")}));
    assert!(!out.ok);
    assert!(out.content.contains("already in refs.bib as old2020"), "{}", out.content);

    // No DOI or arXiv id but a service found it: built, marked unchecked.
    let out = call(&cx, "insert_bibtex", json!({"id": library_uid(&lib, "No id paper")}));
    assert!(out.ok, "{}", out.content);
    assert!(out.content.contains("couldn't be checked"), "{}", out.content);

    // Only from a .bib file, with nothing to check it against: refused.
    let before = cx.overlay().changes().len();
    let out = call(&cx, "insert_bibtex", json!({"id": library_uid(&lib, "Made up paper")}));
    assert!(!out.ok);
    assert!(out.content.contains("only came from a .bib file"), "{}", out.content);
    assert_eq!(cx.overlay().changes().len(), before);
}

#[test]
fn hooks_never_wait_for_a_busy_library() {
    let e = env();
    let lib = open(&e.lib_dir);
    let hooks = PipelineHooks::new(Some(lib.clone()), None, None);
    hooks.store(Source::Crossref, "k1", "body", Duration::from_secs(60));
    assert_eq!(hooks.cached(Source::Crossref, "k1").as_deref(), Some("body"));
    let p = Paper { title: "Deep Learning".into(), doi: Some("10.1038/nature14539".into()), sources: vec!["Crossref".into()], ..Default::default() };
    let (saved, _) = store_papers(&lib, std::slice::from_ref(&p), &Provenance { save: true, ..Default::default() }).unwrap();
    assert_eq!(saved.len(), 1);
    assert_eq!(hooks.boost(&p), 0.04);

    // Hold both connections, as a backup or a long read would: the hooks
    // answer at once (a miss, no boost) and the store goes to memory.
    let (tx, rx) = std::sync::mpsc::channel();
    let (done_tx, done_rx) = std::sync::mpsc::channel::<()>();
    let held = lib.clone();
    let t = std::thread::spawn(move || {
        held.write(|_| {
            held.read(|_| {
                tx.send(()).unwrap();
                done_rx.recv().unwrap();
                Ok(())
            })
        })
        .unwrap();
    });
    rx.recv().unwrap();
    assert_eq!(hooks.cached(Source::Crossref, "k1"), None);
    assert_eq!(hooks.boost(&p), 0.0);
    hooks.store(Source::Crossref, "busy-key-wp06", "later", Duration::from_secs(60));
    assert_eq!(hooks.cached(Source::Crossref, "busy-key-wp06").as_deref(), Some("later"), "kept in memory meanwhile");
    done_tx.send(()).unwrap();
    t.join().unwrap();
    assert_eq!(hooks.cached(Source::Crossref, "k1").as_deref(), Some("body"));
    // With the library free again, a body kept in memory is still found:
    // the database misses it, the memory doesn't.
    assert_eq!(hooks.cached(Source::Crossref, "busy-key-wp06").as_deref(), Some("later"), "a database miss falls back to memory");
}
