use std::fs;
use std::path::Path;
use std::time::Duration;

use rusqlite::Connection;

use super::cache;
use super::db;
use super::dedupe::{self, MatchKind, Probe};
use super::fts::{sanitize_query, MARK_END, MARK_START};
use super::ids::{normalise_arxiv, normalise_doi, PaperKey};
use super::store::{self, LibraryFilters, PaperInput, Provenance, Scope, SourceHit, Sort};
use super::{bibsync, Library, LibraryState, FILE};

const DAY: i64 = 24 * 60 * 60 * 1000;
const NOW: i64 = 1_800_000_000_000;

fn open(dir: &Path) -> Library {
    let (lib, warning) = Library::open(dir).unwrap();
    assert!(warning.is_none(), "{warning:?}");
    lib
}

fn hit(source: &str) -> Vec<SourceHit> {
    vec![SourceHit { source: source.into(), ..Default::default() }]
}

fn paper(title: &str) -> PaperInput {
    PaperInput { title: title.into(), authors: vec!["Jane Smith".into()], year: Some(2020), ..Default::default() }
}

fn upsert(lib: &Library, papers: &[PaperInput]) -> Vec<String> {
    lib.write(|c| store::upsert_papers(c, papers, &Provenance::default(), NOW)).unwrap()
}

fn count(lib: &Library, sql: &str) -> i64 {
    lib.read(|c| Ok(c.query_row(sql, [], |r| r.get(0))?)).unwrap()
}

// ---- Schema and lifecycle ------------------------------------------------

#[test]
fn migrates_a_fresh_database_once() {
    let dir = tempfile::tempdir().unwrap();
    let lib = open(dir.path());
    assert_eq!(lib.read(db::user_version).unwrap(), 1);
    upsert(&lib, &[paper("Attention is all you need")]);
    lib.close();
    drop(lib);

    // Reopening runs nothing again and keeps the data.
    let lib = open(dir.path());
    assert_eq!(lib.read(db::user_version).unwrap(), 1);
    assert_eq!(count(&lib, "SELECT count(*) FROM papers"), 1);
    // No backup for a database that had no schema before.
    assert!(!dir.path().join("backups").exists());

    // FTS5 is compiled in.
    lib.write(|c| Ok(c.execute_batch("CREATE VIRTUAL TABLE probe USING fts5(x); DROP TABLE probe;")?)).unwrap();
}

#[test]
fn backs_up_before_a_migration() {
    let dir = tempfile::tempdir().unwrap();
    drop(Library::open_with(dir.path(), &db::MIGRATIONS[..1]).unwrap());
    let next = "CREATE TABLE extra(x INTEGER);";
    let (lib, _) = Library::open_with(dir.path(), &[db::MIGRATIONS[0], next]).unwrap();
    assert_eq!(lib.read(db::user_version).unwrap(), 2);
    let backup = dir.path().join("backups").join("library.pre-v2.sqlite");
    assert!(backup.is_file());
    let old = Connection::open(&backup).unwrap();
    assert_eq!(db::user_version(&old).unwrap(), 1);
}

#[test]
fn a_damaged_file_is_set_aside() {
    let dir = tempfile::tempdir().unwrap();
    let mut junk = Vec::new();
    let mut x: u32 = 12345;
    for _ in 0..8192 {
        x = x.wrapping_mul(1_103_515_245).wrapping_add(12345);
        junk.push((x >> 16) as u8);
    }
    fs::write(dir.path().join(FILE), &junk).unwrap();

    let state = LibraryState::open(dir.path());
    assert!(state.0.is_some());
    let warning = state.1.clone().unwrap();
    assert!(warning.contains("damaged"), "{warning}");
    let status = state.status();
    assert!(status.available);
    assert_eq!(status.warning.as_deref(), Some(warning.as_str()));
    assert_eq!(status.papers, 0);

    let aside: Vec<_> = fs::read_dir(dir.path())
        .unwrap()
        .filter_map(Result::ok)
        .map(|e| e.file_name().to_string_lossy().to_string())
        .filter(|n| n.starts_with("library.corrupt-") && n.ends_with(".sqlite"))
        .collect();
    assert_eq!(aside.len(), 1);
    assert_eq!(fs::read(dir.path().join(&aside[0])).unwrap(), junk);
}

#[test]
fn an_unclean_shutdown_runs_the_integrity_check() {
    let dir = tempfile::tempdir().unwrap();
    let lib = open(dir.path());
    upsert(&lib, &[paper("Attention is all you need")]);
    // Dropped without `close`: the marker stays, as after a crash.
    drop(lib);
    assert!(dir.path().join(".open").exists());
    let lib = open(dir.path());
    assert_eq!(count(&lib, "SELECT count(*) FROM papers"), 1);
    lib.close();
    assert!(!dir.path().join(".open").exists());
}

#[test]
fn readers_work_while_a_write_is_open() {
    let dir = tempfile::tempdir().unwrap();
    let lib = open(dir.path());
    lib.write(|c| {
        let tx = c.transaction()?;
        tx.execute(
            "INSERT INTO papers(uid, title, title_norm, created_at, updated_at, last_seen_at) VALUES ('u', 'T', 't', 1, 1, 1)",
            [],
        )?;
        let seen = std::thread::scope(|s| s.spawn(|| count(&lib, "SELECT count(*) FROM papers")).join().unwrap());
        assert_eq!(seen, 0, "the reader sees the last committed state");
        tx.commit()?;
        Ok(())
    })
    .unwrap();
    assert_eq!(count(&lib, "SELECT count(*) FROM papers"), 1);
}

#[test]
fn library_files_stay_in_the_data_folder() {
    let root = tempfile::tempdir().unwrap();
    let dir = root.path().join("library");
    fs::create_dir_all(&dir).unwrap();
    fs::write(dir.join(FILE), b"not a database at all, just some text").unwrap();
    let (lib, warning) = Library::open(&dir).unwrap();
    assert!(warning.is_some());
    upsert(&lib, &[paper("Attention is all you need")]);
    let backup = lib.backup().unwrap();
    assert!(backup.starts_with(&dir));
    lib.write(|c| cache::put(c, "s2", "k", "body", cache::SEARCH_TTL, NOW)).unwrap();
    lib.close();
    drop(lib);
    drop(Library::open_with(&dir, &[db::MIGRATIONS[0], "CREATE TABLE extra(x);"]).unwrap());

    for entry in walkdir::WalkDir::new(root.path()).into_iter().filter_map(Result::ok) {
        if entry.file_type().is_file() {
            assert!(entry.path().starts_with(&dir), "{} is outside the library folder", entry.path().display());
        }
    }
}

// ---- Identifiers and matching --------------------------------------------

#[test]
fn identifiers_are_normalised() {
    assert_eq!(normalise_doi("10.1000/ABC").as_deref(), Some("10.1000/abc"));
    assert_eq!(normalise_doi("https://doi.org/10.1000/abc.").as_deref(), Some("10.1000/abc"));
    assert_eq!(normalise_doi("doi: 10.1000/abc").as_deref(), Some("10.1000/abc"));
    assert_eq!(normalise_doi("not a doi"), None);
    assert_eq!(normalise_arxiv("2401.01234v3").as_deref(), Some("2401.01234"));
    assert_eq!(normalise_arxiv("arXiv:2401.01234").as_deref(), Some("2401.01234"));
    assert_eq!(normalise_arxiv("https://arxiv.org/pdf/2401.01234v2.pdf").as_deref(), Some("2401.01234"));
    assert_eq!(normalise_arxiv("10.48550/arXiv.2401.01234").as_deref(), Some("2401.01234"));
    assert_eq!(normalise_arxiv("hep-th/9901001v2").as_deref(), Some("hep-th/9901001"));
    assert_eq!(normalise_arxiv("1234"), None);
    assert_eq!(PaperKey::new("doi", "10.48550/arXiv.2401.01234"), Some(PaperKey::Arxiv("2401.01234".into())));
    assert_eq!(PaperKey::parse("https://doi.org/10.1000/xyz"), Some(PaperKey::Doi("10.1000/xyz".into())));
}

#[test]
fn upsert_merges_on_identifiers() {
    let dir = tempfile::tempdir().unwrap();
    let lib = open(dir.path());
    let a = PaperInput { doi: Some("10.1000/ABC".into()), sources: hit("crossref"), ..paper("A study of things") };
    let b = PaperInput { doi: Some("https://doi.org/10.1000/abc.".into()), sources: hit("s2"), ..paper("Totally different words here") };
    let c = PaperInput { arxiv: Some("2401.01234v3".into()), ..paper("Preprint one") };
    let d = PaperInput { arxiv: Some("2401.01234".into()), ..paper("Yet another title entirely") };
    let e = PaperInput { doi: Some("10.48550/arXiv.2401.01234".into()), ..paper("Third spelling of nothing") };
    let uids = upsert(&lib, &[a, b, c, d, e]);
    assert_eq!(uids.len(), 5);
    assert_eq!(uids[0], uids[1]);
    assert_eq!(uids[2], uids[3]);
    assert_eq!(uids[2], uids[4]);
    assert_ne!(uids[0], uids[2]);
    assert_eq!(count(&lib, "SELECT count(*) FROM papers"), 2);
    // The Crossref title outranks Semantic Scholar's.
    let p = lib.read(|c| store::get(c, &uids[0], None)).unwrap().unwrap();
    assert_eq!(p.title, "A study of things");
    assert_eq!(p.ids.doi.as_deref(), Some("10.1000/abc"));
    assert_eq!(p.sources.iter().map(|s| s.source.as_str()).collect::<Vec<_>>(), vec!["crossref", "s2"]);
    // The same paper can be looked up by any of its ids.
    let q = lib.read(|c| store::get(c, "arXiv:2401.01234v1", None)).unwrap().unwrap();
    assert_eq!(q.uid, uids[2]);
}

#[test]
fn jaro_winkler_scores() {
    assert_eq!(dedupe::jaro_winkler("abc", "abc"), 1.0);
    assert_eq!(dedupe::jaro_winkler("", "abc"), 0.0);
    let martha = dedupe::jaro_winkler("martha", "marhta");
    assert!((martha - 0.9611).abs() < 1e-3, "{martha}");
    assert_eq!(dedupe::fold("Déjà Vu: Über-Straße!"), "dejavuuberstrasse");
    let probe = |t: &'static str, y| Probe { title_norm: t, year: Some(y), first_author: Some("smith") };
    assert_eq!(dedupe::match_kind(&probe("deepresiduallearning", 2016), &probe("deepresiduallearning", 2018)), MatchKind::None);
}

const BASE: &str = "Deep residual learning for image recognition";
const STRONG_TITLE: &str = "Deep residual learning for image recognitions";
const PROBABLE_TITLE: &str = "Deep residual learning in image classification";

#[test]
fn fuzzy_matches_merge_link_or_stay_apart() {
    let sim = |t: &str| dedupe::jaro_winkler(&dedupe::fold(BASE), &dedupe::fold(t));
    assert!(sim(STRONG_TITLE) >= dedupe::STRONG);
    let p = sim(PROBABLE_TITLE);
    assert!((0.91..0.93).contains(&p), "{p}");

    let dir = tempfile::tempdir().unwrap();
    let lib = open(dir.path());
    let base = upsert(&lib, &[PaperInput { year: Some(2016), ..paper(BASE) }])[0].clone();
    // Strong: same paper, merged.
    let strong = upsert(&lib, &[PaperInput { year: Some(2017), ..paper(STRONG_TITLE) }])[0].clone();
    assert_eq!(strong, base);
    // Probable (0.92): a new row linked as a possible duplicate.
    let probable = upsert(&lib, &[PaperInput { year: Some(2016), ..paper(PROBABLE_TITLE) }])[0].clone();
    assert_ne!(probable, base);
    let p = lib.read(|c| store::get(c, &probable, None)).unwrap().unwrap();
    assert_eq!(p.dup_of.as_deref(), Some(base.as_str()));
    // Two years apart: not the same paper, not even a possible duplicate.
    let later = upsert(&lib, &[PaperInput { year: Some(2018), ..paper(STRONG_TITLE) }])[0].clone();
    assert_ne!(later, base);
    let p = lib.read(|c| store::get(c, &later, None)).unwrap().unwrap();
    assert_eq!(p.dup_of, None);
    // A different first author never merges.
    let other = PaperInput { authors: vec!["Ann Other".into()], year: Some(2016), ..paper(STRONG_TITLE) };
    let other = upsert(&lib, &[other])[0].clone();
    assert_ne!(other, base);
    assert_eq!(count(&lib, "SELECT count(*) FROM papers"), 4);
}

#[test]
fn fuzzy_matches_never_merge_numbered_parts_or_different_ids() {
    let dir = tempfile::tempdir().unwrap();
    let lib = open(dir.path());
    let papers = |n: usize| count(&lib, "SELECT count(*) FROM papers") as usize == n;

    // Part I and Part II: same author, same year, nearly the same title.
    let one = upsert(&lib, &[PaperInput { doi: Some("10.1/a".into()), ..paper("Convergence of gradient methods, Part I") }])[0].clone();
    let two = upsert(&lib, &[PaperInput { doi: Some("10.1/b".into()), ..paper("Convergence of gradient methods, Part II") }])[0].clone();
    assert_ne!(one, two);
    let p = lib.read(|c| store::get(c, "10.1/b", None)).unwrap().unwrap();
    assert_eq!(p.uid, two, "Part II's DOI stays with Part II");
    assert_eq!(p.dup_of, None, "not even a possible duplicate");
    // Part II again (no DOI this time) merges with Part II, not Part I.
    let again = upsert(&lib, &[paper("Convergence of gradient methods, Part II.")])[0].clone();
    assert_eq!(again, two);
    assert!(papers(2));

    // Two publisher DOIs: two papers, however alike the titles.
    let a = upsert(&lib, &[PaperInput { doi: Some("10.1000/first".into()), ..paper(BASE) }])[0].clone();
    let b = upsert(&lib, &[PaperInput { doi: Some("10.1000/second".into()), ..paper(STRONG_TITLE) }])[0].clone();
    assert_ne!(a, b);
    let p = lib.read(|c| store::get(c, &b, None)).unwrap().unwrap();
    assert_eq!(p.dup_of, None);
    assert_eq!(p.ids.doi.as_deref(), Some("10.1000/second"));
    // Two arXiv ids likewise.
    let c1 = upsert(&lib, &[PaperInput { arxiv: Some("2401.00001".into()), ..paper("Sparse attention for long documents") }])[0].clone();
    let c2 = upsert(&lib, &[PaperInput { arxiv: Some("2401.00002".into()), ..paper("Sparse attention for long document") }])[0].clone();
    assert_ne!(c1, c2);
    // A preprint DOI and the published DOI are the same paper.
    let pre = upsert(&lib, &[PaperInput { doi: Some("10.1101/2020.01.01.123".into()), ..paper("Protein folding with deep networks") }])[0].clone();
    let publ = upsert(&lib, &[PaperInput { doi: Some("10.1038/s41586-020".into()), ..paper("Protein folding with deep networks.") }])[0].clone();
    assert_eq!(pre, publ);
    assert!(papers(7));
}

#[test]
fn fuzzy_matches_without_authors_need_the_exact_title() {
    let dir = tempfile::tempdir().unwrap();
    let lib = open(dir.path());
    let anon = |t: &str| PaperInput { title: t.into(), ..Default::default() };
    let y2020 = upsert(&lib, &[anon("Proceedings of the 2020 Workshop on Foo")])[0].clone();
    let y2021 = upsert(&lib, &[anon("Proceedings of the 2021 Workshop on Foo")])[0].clone();
    assert_ne!(y2020, y2021);
    // No numbers to tell them apart, no authors: a possible duplicate only.
    let near = upsert(&lib, &[anon("Notes on the theory of foo spaces")])[0].clone();
    let nearer = upsert(&lib, &[anon("Notes on the theory of foo space")])[0].clone();
    assert_ne!(near, nearer);
    let p = lib.read(|c| store::get(c, &nearer, None)).unwrap().unwrap();
    assert_eq!(p.dup_of.as_deref(), Some(near.as_str()));
    // The same entry synced again is the same row.
    assert_eq!(upsert(&lib, &[anon("Proceedings of the 2020 Workshop on Foo")])[0], y2020);
    assert_eq!(count(&lib, "SELECT count(*) FROM papers"), 4);
}

#[test]
fn a_bib_sync_keeps_two_authorless_entries_apart() {
    let dir = tempfile::tempdir().unwrap();
    let lib = open(&dir.path().join("library"));
    let project = dir.path().join("paper");
    fs::create_dir_all(&project).unwrap();
    fs::write(
        project.join("refs.bib"),
        "@misc{k1, title={Proceedings of the 2020 Workshop on Foo}}\n@misc{k2, title={Proceedings of the 2021 Workshop on Foo}}\n",
    )
    .unwrap();
    let name = project.to_string_lossy().to_string();
    for _ in 0..2 {
        let report = lib.write(|c| bibsync::sync(c, &project, &name, NOW)).unwrap();
        assert_eq!(report.entries, 2);
    }
    let keys: Vec<String> = lib
        .read(|c| {
            let mut stmt = c.prepare("SELECT cite_key FROM project_refs WHERE in_bib = 1 ORDER BY cite_key")?;
            let rows = stmt.query_map([], |r| r.get(0))?;
            Ok(rows.collect::<Result<Vec<_>, _>>()?)
        })
        .unwrap();
    assert_eq!(keys, vec!["k1".to_string(), "k2".to_string()]);
    assert_eq!(count(&lib, "SELECT count(*) FROM papers"), 2);
}

#[test]
fn field_priority_keeps_crossref_venue_and_longest_abstract() {
    let dir = tempfile::tempdir().unwrap();
    let lib = open(dir.path());
    let long = "A much longer abstract that says a great deal more about the method and its results.";
    let crossref = PaperInput {
        doi: Some("10.1/x".into()),
        venue: Some("Journal of Things".into()),
        abstract_text: Some("Short.".into()),
        sources: hit("crossref"),
        ..paper("Merging fields from many places")
    };
    let arxiv = PaperInput {
        doi: Some("10.1/X".into()),
        venue: Some("arXiv".into()),
        abstract_text: Some(long.into()),
        tldr: Some("From arXiv, ignored when S2 has one.".into()),
        citations: Some(5),
        sources: hit("arXiv"),
        ..paper("Merging fields from many places")
    };
    let s2 = PaperInput {
        doi: Some("10.1/x".into()),
        venue: Some("J. Things".into()),
        tldr: Some("The S2 summary.".into()),
        influential: Some(2),
        sources: vec![SourceHit { source: "Semantic Scholar".into(), source_id: "abc".into(), citations: Some(40) }],
        ..paper("Merging fields from many places")
    };
    // In either order the result is the same.
    let uid = upsert(&lib, &[arxiv.clone(), crossref.clone(), s2.clone()])[0].clone();
    let p = lib.read(|c| store::get(c, &uid, None)).unwrap().unwrap();
    assert_eq!(p.venue.as_deref(), Some("Journal of Things"));
    assert_eq!(p.abstract_text.as_deref(), Some(long));
    assert_eq!(p.tldr.as_deref(), Some("The S2 summary."));
    assert_eq!(p.citations, Some(40));
    assert_eq!(p.influential, Some(2));

    let dir2 = tempfile::tempdir().unwrap();
    let lib2 = open(dir2.path());
    let uid = upsert(&lib2, &[crossref, s2, arxiv])[0].clone();
    let q = lib2.read(|c| store::get(c, &uid, None)).unwrap().unwrap();
    assert_eq!(q.venue.as_deref(), Some("Journal of Things"));
    assert_eq!(q.abstract_text.as_deref(), Some(long));
    assert_eq!(q.tldr.as_deref(), Some("The S2 summary."));
}

// ---- Full-text search ----------------------------------------------------

#[test]
fn sanitized_queries_never_break_fts() {
    assert_eq!(sanitize_query(""), "");
    assert_eq!(sanitize_query("  ( * "), "");
    assert_eq!(sanitize_query("deep learn"), "\"deep\" \"learn\"*");
    assert_eq!(sanitize_query("a\"b"), "\"a\"\"b\"*");
    assert_eq!(sanitize_query("NOT x"), "\"NOT\" \"x\"*");

    let dir = tempfile::tempdir().unwrap();
    let lib = open(dir.path());
    upsert(&lib, &[paper("Attention is all you need")]);
    for q in ["a\"b", "NOT", "(", "*", "-x", "", "\"", "NEAR(a b)", "title:x", "a AND OR b", "x^2", "{a b}"] {
        let page = lib.read(|c| store::search_local(c, q, &LibraryFilters::default(), Sort::Relevance, 10, 0, NOW));
        assert!(page.is_ok(), "query {q:?} failed: {:?}", page.err());
    }
    let page = lib.read(|c| store::search_local(c, "atten", &LibraryFilters::default(), Sort::Relevance, 10, 0, NOW)).unwrap();
    assert_eq!(page.total, 1, "the last word matches as a prefix");
}

#[test]
fn title_matches_rank_first_and_snippets_use_markers() {
    let dir = tempfile::tempdir().unwrap();
    let lib = open(dir.path());
    let in_abstract = PaperInput {
        abstract_text: Some("We compare several methods, including quantum widgets, on sorting benchmarks.".into()),
        ..paper("A survey of sorting benchmarks")
    };
    let in_title = PaperInput {
        abstract_text: Some("We present a new approach to ordering lists.".into()),
        ..paper("Quantum widgets for sorting")
    };
    upsert(&lib, &[in_abstract, in_title]);
    let page = lib.read(|c| store::search_local(c, "quantum widgets", &LibraryFilters::default(), Sort::Relevance, 10, 0, NOW)).unwrap();
    assert_eq!(page.total, 2);
    assert_eq!(page.items[0].title, "Quantum widgets for sorting");
    for item in &page.items {
        let s = item.snippet.as_deref().unwrap();
        assert!(s.contains(MARK_START) && s.contains(MARK_END), "{s:?}");
    }
    // Markers come only from the library, never as HTML.
    let page = lib.read(|c| store::search_local(c, "ordering", &LibraryFilters::default(), Sort::Relevance, 10, 0, NOW)).unwrap();
    let s = page.items[0].snippet.as_deref().unwrap();
    assert!(s.contains(MARK_START));
    assert!(!s.contains('<'), "{s:?}");
}

#[test]
fn filters_scopes_and_sorts() {
    let dir = tempfile::tempdir().unwrap();
    let lib = open(dir.path());
    let old = PaperInput { year: Some(2001), citations: Some(900), ..paper("Old but widely cited paper") };
    let new = PaperInput { year: Some(2024), citations: Some(3), is_oa: Some(true), ..paper("New open access paper") };
    let uids = upsert(&lib, &[old, new]);
    lib.write(|c| store::save(c, &uids[1], NOW)).unwrap();
    let run = Provenance { run_id: Some("run-1".into()), tool: Some("search_papers".into()), ..Default::default() };
    lib.write(|c| store::upsert_papers(c, &[paper("Found by an agent run")], &run, NOW)).unwrap();

    let search = |filters: LibraryFilters, sort: Sort| {
        lib.read(|c| store::search_local(c, "", &filters, sort, 10, 0, NOW)).unwrap().items.into_iter().map(|p| p.title).collect::<Vec<_>>()
    };
    assert_eq!(search(LibraryFilters::default(), Sort::Cited)[0], "Old but widely cited paper");
    assert_eq!(search(LibraryFilters::default(), Sort::Newest)[0], "New open access paper");
    assert_eq!(search(LibraryFilters { scope: Scope::Saved, ..Default::default() }, Sort::Relevance), vec!["New open access paper"]);
    assert_eq!(search(LibraryFilters { oa_only: true, ..Default::default() }, Sort::Relevance), vec!["New open access paper"]);
    assert_eq!(search(LibraryFilters { year_to: Some(2010), ..Default::default() }, Sort::Relevance), vec!["Old but widely cited paper"]);
    assert_eq!(search(LibraryFilters { min_citations: Some(100), ..Default::default() }, Sort::Relevance), vec!["Old but widely cited paper"]);
    assert_eq!(search(LibraryFilters { scope: Scope::Agents, ..Default::default() }, Sort::Relevance), vec!["Found by an agent run"]);
}

// ---- User changes and retention ------------------------------------------

#[test]
fn tags_notes_and_removal() {
    let dir = tempfile::tempdir().unwrap();
    let lib = open(dir.path());
    let uid = upsert(&lib, &[paper("Tagged paper about things")])[0].clone();
    let tags = lib.write(|c| store::set_tags(c, &uid, &["ml".into(), " ML ".into(), "to read".into()], NOW)).unwrap();
    assert_eq!(tags, vec!["ml", "to read"]);
    lib.write(|c| store::set_note(c, &uid, Some("  check eq. 3 "), NOW)).unwrap();
    let p = lib.read(|c| store::get(c, &uid, None)).unwrap().unwrap();
    assert_eq!(p.note.as_deref(), Some("check eq. 3"));
    lib.write(|c| store::remove(c, &uid)).unwrap();
    assert!(lib.read(|c| store::get(c, &uid, None)).unwrap().is_none());
    assert_eq!(count(&lib, "SELECT count(*) FROM tags"), 0);
    let err = lib.write(|c| store::save(c, &uid, NOW)).unwrap_err();
    assert!(err.plain().contains("isn't in your library"));
}

#[test]
fn purge_forgets_only_old_unused_papers() {
    let dir = tempfile::tempdir().unwrap();
    let lib = open(dir.path());
    let uids = lib
        .write(|c| store::upsert_papers(c, &[paper("Old unsaved paper here"), paper("Old saved paper here")], &Provenance::default(), NOW - 100 * DAY))
        .unwrap();
    lib.write(|c| store::save(c, &uids[1], NOW)).unwrap();
    lib.write(|c| store::upsert_papers(c, &[paper("Recently seen paper")], &Provenance::default(), NOW - DAY)).unwrap();
    lib.write(|c| db::purge(c, NOW)).unwrap();
    let left: Vec<String> = lib
        .read(|c| {
            let mut s = c.prepare("SELECT title FROM papers ORDER BY title")?;
            let rows = s.query_map([], |r| r.get(0))?.collect::<Result<_, _>>()?;
            Ok(rows)
        })
        .unwrap();
    assert_eq!(left, vec!["Old saved paper here", "Recently seen paper"]);
}

// ---- Cache ---------------------------------------------------------------

#[test]
fn cache_honours_ttl_lru_and_clear() {
    let dir = tempfile::tempdir().unwrap();
    let lib = open(dir.path());
    let key = cache::cache_key("s2", "  Deep   Learning ", "limit=5");
    assert_eq!(key, cache::cache_key("s2", "deep learning", "limit=5"));
    assert_ne!(key, cache::cache_key("crossref", "deep learning", "limit=5"));
    lib.write(|c| {
        cache::put(c, "s2", &key, "body", Duration::from_secs(60), NOW)?;
        assert_eq!(cache::get(c, "s2", &key, NOW + 1000)?.as_deref(), Some("body"));
        assert_eq!(cache::get(c, "s2", &key, NOW + 61_000)?, None, "expired");

        // Size cap: the least recently used entry goes first.
        let ttl = Duration::from_secs(3600);
        cache::put_capped(c, "s2", "a", &"a".repeat(40), ttl, NOW, 100)?;
        cache::put_capped(c, "s2", "b", &"b".repeat(40), ttl, NOW + 1, 100)?;
        assert!(cache::get(c, "s2", "a", NOW + 2)?.is_some());
        cache::put_capped(c, "s2", "c", &"c".repeat(40), ttl, NOW + 3, 100)?;
        assert!(cache::get(c, "s2", "a", NOW + 4)?.is_some());
        assert!(cache::get(c, "s2", "b", NOW + 4)?.is_none(), "b was used least recently");
        assert!(cache::get(c, "s2", "c", NOW + 4)?.is_some());
        assert!(cache::size(c)?.1 <= 100);

        cache::clear(c)?;
        assert_eq!(cache::size(c)?, (0, 0));
        Ok(())
    })
    .unwrap();
}

// ---- .bib files ----------------------------------------------------------

const BIB: &str = r#"
@article{lecun2015,
  title = {Deep learning},
  author = {LeCun, Yann and Bengio, Yoshua and Hinton, Geoffrey},
  journal = {Nature},
  year = {2015},
  doi = {10.1038/NATURE14539}
}
@inproceedings{he2016,
  title = {Deep Residual Learning for Image Recognition},
  author = {He, Kaiming and Zhang, Xiangyu},
  booktitle = {CVPR},
  year = {2016}
}
@misc{new2023,
  title = {Something not in the library yet},
  author = {Doe, Jane},
  year = {2023}
}
"#;

#[test]
fn bibsync_links_entries_by_doi_and_title() {
    let project = tempfile::tempdir().unwrap();
    fs::write(project.path().join("refs.bib"), BIB).unwrap();
    let dir = tempfile::tempdir().unwrap();
    let lib = open(dir.path());
    let by_doi = PaperInput {
        doi: Some("https://doi.org/10.1038/nature14539".into()),
        authors: vec!["Yann LeCun".into()],
        year: Some(2015),
        sources: hit("crossref"),
        ..paper("Deep learning")
    };
    let by_title = PaperInput { authors: vec!["Kaiming He".into()], year: Some(2016), sources: hit("s2"), ..paper(BASE) };
    let uids = upsert(&lib, &[by_doi, by_title]);
    let key = project.path().to_string_lossy().to_string();

    let report = lib.write(|c| bibsync::sync(c, project.path(), &key, NOW)).unwrap();
    assert_eq!(report.files, vec!["refs.bib"]);
    assert_eq!((report.entries, report.matched, report.added), (3, 2, 1));

    let refs = lib.read(|c| store::project_refs(c, &key)).unwrap();
    let keyed = |k: &str| refs.iter().find(|p| p.in_project.as_ref().and_then(|r| r.cite_key.as_deref()) == Some(k)).unwrap();
    assert_eq!(keyed("lecun2015").uid, uids[0]);
    assert_eq!(keyed("he2016").uid, uids[1]);
    let r = keyed("he2016").in_project.clone().unwrap();
    assert!(r.in_bib);
    assert_eq!(r.added_by.as_deref(), Some("bib-scan"));
    assert_eq!(r.bib_file.as_deref(), Some("refs.bib"));
    // The library's better metadata wins over the .bib entry.
    assert_eq!(keyed("lecun2015").venue, Some("Nature".to_string()));
    assert_eq!(keyed("new2023").authors, vec!["Jane Doe"]);
    let scoped = lib
        .read(|c| store::search_local(c, "", &LibraryFilters { scope: Scope::Project, project: Some(key.clone()), ..Default::default() }, Sort::Relevance, 10, 0, NOW))
        .unwrap();
    assert_eq!(scoped.total, 3);

    // An entry removed from the .bib loses its link on the next scan.
    fs::write(project.path().join("refs.bib"), &BIB[..BIB.find("@misc").unwrap()]).unwrap();
    let report = lib.write(|c| bibsync::sync(c, project.path(), &key, NOW)).unwrap();
    assert_eq!(report.removed, 1);
    assert_eq!(lib.read(|c| store::project_refs(c, &key)).unwrap().len(), 2);
}

#[test]
fn export_gives_collision_free_keys() {
    let dir = tempfile::tempdir().unwrap();
    let lib = open(dir.path());
    let a = PaperInput { doi: Some("10.1/a".into()), venue: Some("Nature".into()), ..paper("Learning things & stuff") };
    let b = PaperInput { doi: Some("10.1/b".into()), ..paper("Learning other things") };
    let uids = upsert(&lib, &[a, b]);
    let papers = lib.read(|c| store::many(c, &uids)).unwrap();
    let text = bibsync::to_bibtex(&papers);
    assert!(text.contains("@article{smith2020learning,"), "{text}");
    assert!(text.contains("@misc{smith2020learninga,"), "{text}");
    assert!(text.contains("things \\& stuff"), "{text}");
    assert!(text.contains("doi = {10.1/a}"), "{text}");
    let parsed = crate::agents::tools::bibtex::parse_entries(&text);
    assert_eq!(parsed.len(), 2);
    let json = super::commands::export_text(&papers, super::commands::ExportFormat::Json).unwrap();
    assert!(json.contains("\"uid\""));
}

#[test]
fn fuzzy_finds_a_twin_behind_a_crowded_block() {
    let dir = tempfile::tempdir().unwrap();
    let lib = open(dir.path());
    // 250 rows that open like the twin but are much longer, inserted first
    // so they come before it in row order.
    lib.write(|c| {
        let tx = c.transaction()?;
        for i in 0..250 {
            let title = format!(
                "Large language models for task number {i} with a long subtitle about evaluation, benchmarks, data and many other things"
            );
            tx.execute(
                "INSERT INTO papers(uid, title, title_norm, first_author_norm, year, created_at, updated_at, last_seen_at) \
                 VALUES (?1, ?2, ?3, 'smith', 2022, ?4, ?4, ?4)",
                rusqlite::params![format!("filler-{i}"), title, dedupe::fold(&title), NOW],
            )?;
        }
        tx.commit()?;
        Ok(())
    })
    .unwrap();
    let twin = upsert(&lib, &[PaperInput { year: Some(2022), ..paper("Large language models are zero-shot reasoners") }])[0].clone();
    assert_eq!(count(&lib, "SELECT count(*) FROM papers"), 251);
    // A strong match merges, with or without a year.
    let again = upsert(&lib, &[PaperInput { year: Some(2022), ..paper("Large language models are zero shot reasoner") }])[0].clone();
    assert_eq!(again, twin);
    let no_year = upsert(&lib, &[PaperInput { year: None, ..paper("Large Language Models are Zero-Shot Reasoners.") }])[0].clone();
    assert_eq!(no_year, twin);
    assert_eq!(count(&lib, "SELECT count(*) FROM papers"), 251);
}

#[test]
fn the_published_doi_beats_a_preprint_doi() {
    let preprint = PaperInput {
        doi: Some("10.1101/2020.01.01.900001".into()),
        s2: Some("abc123".into()),
        sources: hit("s2"),
        ..paper("Single cell atlas of the developing heart")
    };
    let journal = PaperInput {
        doi: Some("10.1371/journal.pbio.3000001".into()),
        s2: Some("abc123".into()),
        venue: Some("PLOS Biology".into()),
        sources: hit("crossref"),
        ..paper("Single cell atlas of the developing heart")
    };
    // Either order: one row, the journal DOI shown and exported.
    for batch in [[preprint.clone(), journal.clone()], [journal, preprint]] {
        let dir = tempfile::tempdir().unwrap();
        let lib = open(dir.path());
        let uids = upsert(&lib, &batch);
        assert_eq!(uids[0], uids[1]);
        assert_eq!(count(&lib, "SELECT count(*) FROM paper_ids WHERE scheme = 'doi'"), 2);
        let p = lib.read(|c| store::get(c, &uids[0], None)).unwrap().unwrap();
        assert_eq!(p.ids.doi.as_deref(), Some("10.1371/journal.pbio.3000001"));
        let text = bibsync::to_bibtex(&[p]);
        assert!(text.contains("doi = {10.1371/journal.pbio.3000001}"), "{text}");
        assert!(!text.contains("10.1101"), "{text}");
    }

    // Two published DOIs: the better source's wins, in either order.
    let s2 = PaperInput { doi: Some("10.9999/s2.copy".into()), s2: Some("def456".into()), sources: hit("s2"), ..paper("Another paper with two dois") };
    let crossref = PaperInput { doi: Some("10.1000/crossref.copy".into()), s2: Some("def456".into()), sources: hit("crossref"), ..paper("Another paper with two dois") };
    for batch in [[s2.clone(), crossref.clone()], [crossref, s2]] {
        let dir = tempfile::tempdir().unwrap();
        let lib = open(dir.path());
        let uids = upsert(&lib, &batch);
        let p = lib.read(|c| store::get(c, &uids[0], None)).unwrap().unwrap();
        assert_eq!(p.ids.doi.as_deref(), Some("10.1000/crossref.copy"));
    }
}

#[test]
fn export_escapes_text_from_services() {
    use crate::agents::tools::bibtex;
    let dir = tempfile::tempdir().unwrap();
    let lib = open(dir.path());
    let a = PaperInput {
        doi: Some("10.1/a".into()),
        venue: Some("Journal of {Odd} Names}".into()),
        ..paper(r"Sets {A} and B} with \ and $x^2$ ~ approx")
    };
    let b = PaperInput { doi: Some("10.1/b".into()), ..paper("Learning other things") };
    let uids = upsert(&lib, &[a, b]);
    let papers = lib.read(|c| store::many(c, &uids)).unwrap();
    let text = bibsync::to_bibtex(&papers);
    assert_eq!(text.matches('{').count(), text.matches('}').count(), "{text}");
    let parsed = bibtex::parse_entries(&text);
    assert_eq!(parsed.len(), 2, "{text}");
    let title = parsed[0].get("title").unwrap();
    assert_eq!(
        title,
        r"{Sets \textbraceleft{}A\textbraceright{} and B\textbraceright{} with \textbackslash{} and \$x\textasciicircum{}2\$ \textasciitilde{} approx}"
    );
    assert_eq!(parsed[0].get("journal"), Some(r"Journal of \textbraceleft{}Odd\textbraceright{} Names\textbraceright{}"));
    assert_eq!(parsed[0].get("doi"), Some("10.1/a"));
    assert_eq!(bibtex::plain(parsed[1].get("title").unwrap()).trim(), "Learning other things");
    assert_eq!(parsed[1].get("doi"), Some("10.1/b"));
}

#[test]
fn the_bib_fallback_search_skips_deep_and_package_folders() {
    let project = tempfile::tempdir().unwrap();
    let root = project.path();
    fs::write(root.join("refs.bib"), BIB).unwrap();
    for sub in ["node_modules/pkg", ".cache", "data", "a/b/c/d/e"] {
        fs::create_dir_all(root.join(sub)).unwrap();
        fs::write(root.join(sub).join("skip.bib"), BIB).unwrap();
    }
    fs::create_dir_all(root.join("chapters")).unwrap();
    fs::write(root.join("chapters").join("more.bib"), BIB).unwrap();
    let found: Vec<String> = bibsync::bib_files(root)
        .iter()
        .map(|p| p.strip_prefix(root).unwrap().to_string_lossy().replace('\\', "/"))
        .collect();
    assert_eq!(found, vec!["chapters/more.bib", "refs.bib"]);
}
