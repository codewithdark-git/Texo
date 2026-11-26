use std::fs;
use std::path::Path;
use std::time::Duration;

use super::apply::{self, ApplyRequest, ChangeFile, RunNote};
use super::query::{self, AuthorFilter, LogFilter};
use super::repo::{self, Prefs};
use super::snapshot::{self, AiAuthor, Meta, Reason};
use super::{lock, restore};

fn project() -> tempfile::TempDir {
    tempfile::tempdir().unwrap()
}

fn put(dir: &Path, rel: &str, text: &str) {
    let p = dir.join(rel);
    fs::create_dir_all(p.parent().unwrap()).unwrap();
    fs::write(p, text).unwrap();
}

fn snap(dir: &Path) -> Option<String> {
    repo::with_repo(dir, repo::WAIT, |ctx| Ok(snapshot::snapshot(ctx, Meta::you(Reason::Manual))?.map(|i| i.to_string())))
        .unwrap()
}

fn files(dir: &Path) -> Vec<String> {
    repo::with_repo(dir, repo::WAIT, |ctx| Ok(snapshot::head_entries(&ctx.repo)?.keys().cloned().collect())).unwrap()
}

fn log(dir: &Path, filter: LogFilter) -> Vec<query::LogEntry> {
    repo::with_repo(dir, repo::WAIT, |ctx| query::log(ctx, &filter)).unwrap()
}

fn ai() -> AiAuthor {
    AiAuthor { profile_name: "Fix compile errors".into(), model: "nvidia/nemotron-3-ultra-550b-a55b".into(), kind: "fixer".into() }
}

fn request(run: &str, files: Vec<ChangeFile>) -> ApplyRequest {
    ApplyRequest {
        run_id: run.into(),
        author: ai(),
        step: Some(3),
        summary: "Fixed a missing brace".into(),
        files,
        note: RunNote {
            prompt: "Fix it".into(),
            tool_calls: vec!["read_file main.tex".into(), "edit_file main.tex".into()],
            journal: Some(format!(".texo/ai/runs/{run}.json")),
            ..Default::default()
        },
    }
}

fn change(file: &str, base: Option<&str>, new: Option<&str>) -> ChangeFile {
    ChangeFile { file: file.into(), base_text: base.map(Into::into), new_text: new.map(Into::into) }
}

#[test]
fn snapshot_uses_texo_exclude_list_and_skips_unchanged() {
    let d = project();
    let dir = d.path();
    put(dir, "main.tex", "\\documentclass{article}");
    put(dir, "refs.bib", "@article{a}");
    put(dir, "sections/intro.tex", "Intro");
    put(dir, "main.aux", "x");
    put(dir, "main.log", "x");
    put(dir, "main.synctex.gz", "x");
    put(dir, ".main.tex.texo-tmp", "x");
    put(dir, ".texo/project.json", "{}");
    put(dir, ".git/config", "x");
    put(dir, "node_modules/a.js", "x");
    put(dir, ".texo-import-123/a.tex", "x");
    // A .gitignore is just a file: history never reads it.
    put(dir, ".gitignore", "*.tex\n");
    assert!(snap(dir).is_some());
    assert_eq!(files(dir), vec![".gitignore", "main.tex", "refs.bib", "sections/intro.tex"]);
    assert!(snap(dir).is_none(), "nothing changed, so no commit");
    put(dir, "main.tex", "\\documentclass{book}");
    assert!(snap(dir).is_some());
    assert_eq!(log(dir, LogFilter::default()).len(), 2);
    // The user's own repo was never touched.
    assert_eq!(fs::read_to_string(dir.join(".git/config")).unwrap(), "x");
    assert!(!dir.join(".git/HEAD").exists());
}

#[test]
fn compiled_pdf_is_excluded() {
    let d = project();
    let dir = d.path();
    put(
        dir,
        ".texo/project.json",
        r#"{"id":"1","name":"p","mainDocument":"paper/main.tex","createdAt":"2026-01-01T00:00:00Z","formatVersion":1}"#,
    );
    put(dir, "paper/main.tex", "x");
    put(dir, "paper/main.pdf", "%PDF");
    put(dir, "figures/plot.pdf", "%PDF");
    snap(dir);
    assert_eq!(files(dir), vec!["figures/plot.pdf", "paper/main.tex"]);
}

#[test]
fn unicode_names_and_crlf_bytes_round_trip() {
    let d = project();
    let dir = d.path();
    let name = "chapitres/résumé ü 中文.tex";
    let original = "Ligne un\r\nLigne deux\r\n\u{00e9}\r\n";
    put(dir, name, original);
    let first = snap(dir).unwrap();
    assert_eq!(files(dir), vec![name]);
    put(dir, name, "changed\n");
    snap(dir).unwrap();
    let r = repo::with_repo(dir, repo::WAIT, |ctx| restore::restore_file(ctx, &first, name)).unwrap();
    assert_eq!(r.written, vec![name]);
    assert_eq!(fs::read(dir.join(name)).unwrap(), original.as_bytes());
    let stored = repo::with_repo(dir, repo::WAIT, |ctx| restore::file_at(ctx, &first, name)).unwrap().unwrap();
    assert_eq!(stored, original.as_bytes());
    let entries = log(dir, LogFilter::default());
    assert_eq!(entries.len(), 3);
    assert_eq!(entries[0].reason.as_deref(), Some("restore"));
    assert!(entries[0].summary.starts_with("Restored chapitres/résumé ü 中文.tex"));
}

#[test]
fn large_files_are_left_out_and_noted() {
    let d = project();
    let dir = d.path();
    put(dir, "main.tex", "x");
    let big = fs::File::create(dir.join("data.bin")).unwrap();
    big.set_len(super::walk::MAX_FILE_BYTES + 1).unwrap();
    drop(big);
    snap(dir).unwrap();
    assert_eq!(files(dir), vec!["main.tex"]);
    let e = &log(dir, LogFilter::default())[0];
    assert_eq!(e.note.as_ref().unwrap()["untrackedLarge"], serde_json::json!(["data.bin"]));
}

#[test]
fn stat_cache_is_used_and_still_sees_changes() {
    let d = project();
    let dir = d.path();
    put(dir, "a.tex", "one");
    let f = fs::File::options().write(true).open(dir.join("a.tex")).unwrap();
    f.set_modified(std::time::SystemTime::now() - Duration::from_secs(60)).unwrap();
    drop(f);
    snap(dir).unwrap();
    let cache = super::walk::StatCache::load(&repo::git_dir(dir));
    assert!(cache.files.contains_key("a.tex"));
    put(dir, "a.tex", "two!");
    assert!(snap(dir).is_some());
}

#[test]
fn log_filters_trailers_and_notes() {
    let d = project();
    let dir = d.path();
    put(dir, "main.tex", "a\nb\nc\n");
    put(dir, "refs.bib", "@a{}");
    snap(dir).unwrap();
    let start = apply::start_run(dir, "run-1").unwrap();
    let out = apply::apply_changeset(dir, &request("run-1", vec![change("main.tex", Some("a\nb\nc\n"), Some("a\nB\nc\n"))]))
        .unwrap();
    assert_eq!(out.written, vec!["main.tex"]);
    assert!(out.conflicts.is_empty() && out.history_error.is_none());
    let ai_commit = out.commit.clone().unwrap();
    put(dir, "refs.bib", "@b{}");
    snap(dir).unwrap();

    let all = log(dir, LogFilter::default());
    assert_eq!(all.len(), 3);
    let a = &all[1];
    assert_eq!(a.id, ai_commit);
    assert_eq!(a.author, "ai");
    assert_eq!(a.author_name, "Texo AI · Fix compile errors (nvidia/nemotron-3-ultra-550b-a55b)");
    assert_eq!(a.summary, "Fixed a missing brace");
    assert_eq!(a.run_id.as_deref(), Some("run-1"));
    assert_eq!(a.step, Some(3));
    assert_eq!(a.agent.as_deref(), Some("Fix compile errors"));
    assert_eq!(a.model.as_deref(), Some("nvidia/nemotron-3-ultra-550b-a55b"));
    assert_eq!(a.kind.as_deref(), Some("fixer"));
    assert_eq!(a.reason.as_deref(), Some("agent-apply"));
    let note = a.note.as_ref().unwrap();
    assert_eq!(note["prompt"], "Fix it");
    assert_eq!(note["toolCalls"][1], "edit_file main.tex");
    assert_eq!(note["accepted"], serde_json::json!(["main.tex"]));
    assert_eq!(note["journal"], ".texo/ai/runs/run-1.json");
    assert_eq!(a.parent_id.as_deref(), Some(start.as_str()));

    let you = log(dir, LogFilter { author: AuthorFilter::You, ..Default::default() });
    assert_eq!(you.len(), 2);
    assert!(you.iter().all(|e| e.author == "you" && e.author_name == "You"));
    let only_ai = log(dir, LogFilter { author: AuthorFilter::Ai, ..Default::default() });
    assert_eq!(only_ai.len(), 1);
    let run = log(dir, LogFilter { run_id: Some("run-1".into()), ..Default::default() });
    assert_eq!(run.len(), 1);
    let bib = log(dir, LogFilter { path: Some("refs.bib".into()), ..Default::default() });
    assert_eq!(bib.len(), 2);
    let paged = log(dir, LogFilter { before: Some(all[0].id.clone()), limit: Some(1), ..Default::default() });
    assert_eq!(paged.len(), 1);
    assert_eq!(paged[0].id, ai_commit);

    // Run refs.
    repo::with_repo(dir, repo::WAIT, |ctx| {
        assert_eq!(ctx.repo.refname_to_id(&apply::run_ref("run-1", "start")).unwrap().to_string(), start);
        assert_eq!(ctx.repo.refname_to_id(&apply::run_ref("run-1", "end")).unwrap().to_string(), ai_commit);
        // Committer is Texo.
        let c = ctx.repo.find_commit(git2::Oid::from_str(&ai_commit).unwrap()).unwrap();
        assert_eq!(c.committer().name().ok(), Some("Texo"));
        assert_eq!(c.author().email().ok(), Some("agent@texo.invalid"));
        Ok(())
    })
    .unwrap();
}

#[test]
fn changes_and_diff() {
    let d = project();
    let dir = d.path();
    put(dir, "main.tex", "one\ntwo\nthree\n");
    put(dir, "old.tex", "x\n");
    let first = snap(dir).unwrap();
    put(dir, "main.tex", "one\n2\nthree\nfour\n");
    fs::remove_file(dir.join("old.tex")).unwrap();
    put(dir, "new.tex", "n\n");
    fs::write(dir.join("img.png"), [0x89u8, b'P', 0, 1, 2]).unwrap();
    let second = snap(dir).unwrap();
    let ch = repo::with_repo(dir, repo::WAIT, |ctx| query::changes(ctx, &second)).unwrap();
    let get = |f: &str| ch.iter().find(|c| c.file == f).unwrap().clone();
    assert_eq!(ch.len(), 4);
    let m = get("main.tex");
    assert_eq!((m.status.as_str(), m.additions, m.deletions), ("modified", 2, 1));
    assert_eq!(get("old.tex").status, "deleted");
    assert_eq!(get("new.tex").status, "added");
    assert!(get("img.png").binary);

    let diff = repo::with_repo(dir, repo::WAIT, |ctx| query::diff(ctx, None, &second, "main.tex")).unwrap();
    assert_eq!(diff.old_text.as_deref(), Some("one\ntwo\nthree\n"));
    assert_eq!(diff.new_text.as_deref(), Some("one\n2\nthree\nfour\n"));
    let explicit = repo::with_repo(dir, repo::WAIT, |ctx| query::diff(ctx, Some(&first), &second, "old.tex")).unwrap();
    assert_eq!(explicit.old_text.as_deref(), Some("x\n"));
    assert_eq!(explicit.new_text, None);
    put(dir, "main.tex", "on disk\n");
    let disk = repo::with_repo(dir, repo::WAIT, |ctx| query::diff(ctx, None, query::DISK, "main.tex")).unwrap();
    assert_eq!(disk.old_text.as_deref(), Some("one\n2\nthree\nfour\n"));
    assert_eq!(disk.new_text.as_deref(), Some("on disk\n"));
    let bin = repo::with_repo(dir, repo::WAIT, |ctx| query::diff(ctx, None, &second, "img.png")).unwrap();
    assert!(bin.binary && bin.new_text.is_none());
    assert!(repo::with_repo(dir, repo::WAIT, |ctx| query::diff(ctx, None, &second, "../x")).is_err());
}

#[test]
fn restore_all_brings_back_files_and_removes_new_ones() {
    let d = project();
    let dir = d.path();
    put(dir, "main.tex", "v1");
    put(dir, "keep.tex", "same");
    let first = snap(dir).unwrap();
    put(dir, "main.tex", "v2");
    put(dir, "added.tex", "new");
    fs::remove_file(dir.join("keep.tex")).unwrap();
    put(dir, "main.log", "build output is never touched");
    let r = repo::with_repo(dir, repo::WAIT, |ctx| restore::restore_all(ctx, &first)).unwrap();
    assert!(r.commit.is_some());
    assert_eq!(fs::read_to_string(dir.join("main.tex")).unwrap(), "v1");
    assert_eq!(fs::read_to_string(dir.join("keep.tex")).unwrap(), "same");
    assert!(!dir.join("added.tex").exists());
    assert!(dir.join("main.log").exists());
    // The state before restoring is in the history, and so is the restore.
    let entries = log(dir, LogFilter::default());
    assert_eq!(entries[0].reason.as_deref(), Some("restore"));
    let ch = repo::with_repo(dir, repo::WAIT, |ctx| query::changes(ctx, &entries[1].id)).unwrap();
    assert!(ch.iter().any(|c| c.file == "added.tex" && c.status == "added"));
    let missing = repo::with_repo(dir, repo::WAIT, |ctx| restore::restore_file(ctx, &first, "added.tex"));
    assert!(missing.unwrap_err().to_string().contains("didn't exist"));
}

#[test]
fn apply_merges_with_base_text_and_reports_conflicts() {
    let d = project();
    let dir = d.path();
    let base = "alpha\nbeta\ngamma\ndelta\n";
    put(dir, "a.tex", base);
    put(dir, "b.tex", base);
    put(dir, "c.tex", base);
    put(dir, "gone.tex", "x\n");
    snap(dir).unwrap();
    // The user edits while the AI works.
    put(dir, "a.tex", "ALPHA\nbeta\ngamma\ndelta\n");
    put(dir, "b.tex", "alpha\nBETA (you)\ngamma\ndelta\n");
    let req = request(
        "run-merge",
        vec![
            change("a.tex", Some(base), Some("alpha\nbeta\ngamma\nDELTA\n")),
            change("b.tex", Some(base), Some("alpha\nBETA (ai)\ngamma\ndelta\n")),
            change("c.tex", Some(base), Some("alpha\nbeta\ngamma\ndelta\nepsilon\n")),
            change("new.tex", None, Some("brand new\n")),
            change("gone.tex", Some("x\n"), None),
        ],
    );
    let out = apply::apply_changeset(dir, &req).unwrap();
    assert_eq!(fs::read_to_string(dir.join("a.tex")).unwrap(), "ALPHA\nbeta\ngamma\nDELTA\n");
    assert_eq!(fs::read_to_string(dir.join("b.tex")).unwrap(), "alpha\nBETA (you)\ngamma\ndelta\n");
    assert_eq!(fs::read_to_string(dir.join("new.tex")).unwrap(), "brand new\n");
    assert!(!dir.join("gone.tex").exists());
    assert_eq!(out.written, vec!["a.tex", "c.tex", "new.tex"]);
    assert_eq!(out.deleted, vec!["gone.tex"]);
    assert_eq!(out.conflicts.len(), 1);
    let c = &out.conflicts[0];
    assert_eq!(c.file, "b.tex");
    assert_eq!(c.ours_text.as_deref(), Some("alpha\nBETA (you)\ngamma\ndelta\n"));
    assert!(c.merged_text.as_deref().unwrap().contains("<<<<<<<"));
    // The user's edits got their own commit before the AI's.
    let entries = log(dir, LogFilter::default());
    assert_eq!(entries[0].author, "ai");
    assert_eq!(entries[1].author, "you");
    let ai_files = repo::with_repo(dir, repo::WAIT, |ctx| query::changes(ctx, &entries[0].id)).unwrap();
    let mut names: Vec<_> = ai_files.iter().map(|c| c.file.as_str()).collect();
    names.sort();
    assert_eq!(names, vec!["a.tex", "c.tex", "gone.tex", "new.tex"]);
    // Resolving: apply the user's resolution against the current text.
    let resolved = request("run-merge", vec![change("b.tex", c.ours_text.as_deref(), Some("alpha\nBETA (both)\ngamma\ndelta\n"))]);
    let out = apply::apply_changeset(dir, &resolved).unwrap();
    assert_eq!(out.written, vec!["b.tex"]);
    assert!(apply::apply_changeset(dir, &request("../bad", vec![])).is_err());
    assert!(apply::apply_changeset(dir, &request("r", vec![change(".texo/x", None, Some("x"))])).is_err());
}

#[test]
fn apply_conflict_cases_for_created_and_deleted_files() {
    let d = project();
    let dir = d.path();
    put(dir, "exists.tex", "mine\n");
    put(dir, "edited.tex", "edited by you\n");
    let out = apply::apply_changeset(
        dir,
        &request(
            "run-cases",
            vec![
                change("exists.tex", None, Some("ai's\n")),
                change("vanished.tex", Some("x\n"), Some("y\n")),
                change("edited.tex", Some("original\n"), None),
                change("same.tex", None, None),
            ],
        ),
    )
    .unwrap();
    let mut files: Vec<_> = out.conflicts.iter().map(|c| c.file.as_str()).collect();
    files.sort();
    assert_eq!(files, vec!["edited.tex", "exists.tex", "vanished.tex"]);
    assert!(out.written.is_empty() && out.commit.is_none());
    assert_eq!(fs::read_to_string(dir.join("edited.tex")).unwrap(), "edited by you\n");
}

#[test]
fn undo_run_without_conflict() {
    let d = project();
    let dir = d.path();
    put(dir, "main.tex", "one\ntwo\nthree\nfour\nfive\n");
    put(dir, "other.tex", "o\n");
    snap(dir).unwrap();
    apply::start_run(dir, "run-u").unwrap();
    apply::apply_changeset(
        dir,
        &request(
            "run-u",
            vec![
                change("main.tex", Some("one\ntwo\nthree\nfour\nfive\n"), Some("one\nTWO\nthree\nfour\nfive\n")),
                change("added.tex", None, Some("new\n")),
                change("other.tex", Some("o\n"), None),
            ],
        ),
    )
    .unwrap();
    // The user edits another part of the file afterwards (not next to the
    // AI's line: adjacent edits conflict, as in git): undo keeps it.
    put(dir, "main.tex", "one\nTWO\nthree\nfour\nFIVE\n");
    let r = repo::with_repo(dir, repo::WAIT, |ctx| restore::undo_run(ctx, "run-u")).unwrap();
    assert!(r.ok, "{r:?}");
    assert!(r.conflicts.is_empty());
    assert_eq!(fs::read_to_string(dir.join("main.tex")).unwrap(), "one\ntwo\nthree\nfour\nFIVE\n");
    assert!(!dir.join("added.tex").exists());
    assert_eq!(fs::read_to_string(dir.join("other.tex")).unwrap(), "o\n");
    let e = &log(dir, LogFilter::default())[0];
    assert_eq!(e.undo_of.as_deref(), Some("run-u"));
    assert_eq!(e.author, "you");
    let again = repo::with_repo(dir, repo::WAIT, |ctx| restore::undo_run(ctx, "run-u"));
    assert!(again.unwrap_err().to_string().contains("already undone"));
    let none = repo::with_repo(dir, repo::WAIT, |ctx| restore::undo_run(ctx, "never-ran"));
    assert!(none.unwrap_err().to_string().contains("nothing to undo"));
}

#[test]
fn undo_run_with_conflict_keeps_your_version() {
    let d = project();
    let dir = d.path();
    put(dir, "main.tex", "one\ntwo\nthree\n");
    put(dir, "b.tex", "b\n");
    snap(dir).unwrap();
    apply::start_run(dir, "run-c").unwrap();
    apply::apply_changeset(
        dir,
        &request(
            "run-c",
            vec![
                change("main.tex", Some("one\ntwo\nthree\n"), Some("one\nTWO (ai)\nthree\n")),
                change("b.tex", Some("b\n"), Some("B\n")),
            ],
        ),
    )
    .unwrap();
    // Two AI commits in the same run.
    apply::apply_changeset(dir, &request("run-c", vec![change("b.tex", Some("B\n"), Some("B2\n"))])).unwrap();
    put(dir, "main.tex", "one\nTWO (you, on top)\nthree\n");
    let r = repo::with_repo(dir, repo::WAIT, |ctx| restore::undo_run(ctx, "run-c")).unwrap();
    assert!(!r.ok);
    assert_eq!(r.conflicts, vec!["main.tex"]);
    assert_eq!(fs::read_to_string(dir.join("main.tex")).unwrap(), "one\nTWO (you, on top)\nthree\n");
    assert_eq!(fs::read_to_string(dir.join("b.tex")).unwrap(), "b\n");
    assert!(r.commit.is_some());
}

#[test]
fn merge3_cases() {
    let m = apply::merge3("a\nb\nc\n", "A\nb\nc\n", "a\nb\nC\n").unwrap();
    assert_eq!(m, apply::Merged { text: "A\nb\nC\n".into(), conflict: false });
    let m = apply::merge3("a\nb\nc\n", "a\nX\nc\n", "a\nY\nc\n").unwrap();
    assert!(m.conflict && m.text.contains("your version") && m.text.contains("AI version"));
    let crlf = apply::merge3("a\r\nb\r\nc\r\n", "A\r\nb\r\nc\r\n", "a\r\nb\r\nC\r\n").unwrap();
    assert_eq!(crlf.text, "A\r\nb\r\nC\r\n");
    assert_eq!(apply::merge3("x", "y", "y").unwrap().text, "y");
}

#[test]
fn labels_and_compiled_ok_throttle() {
    let d = project();
    let dir = d.path();
    put(dir, "main.tex", "x");
    let c1 = snap(dir).unwrap();
    put(dir, "main.tex", "y");
    let c2 = snap(dir).unwrap();
    repo::with_repo(dir, repo::WAIT, |ctx| {
        query::add_label(ctx, &c1, "  Submitted to   NeurIPS ")?;
        query::add_label(ctx, &c1, "Second label")?;
        assert!(query::add_label(ctx, &c1, "   ").is_err());
        assert!(query::mark_compiled_ok(ctx, git2::Oid::from_str(&c1).unwrap())?);
        // Within 10 minutes: no second automatic label.
        assert!(!query::mark_compiled_ok(ctx, git2::Oid::from_str(&c2).unwrap())?);
        Ok(())
    })
    .unwrap();
    let entries = log(dir, LogFilter::default());
    let old = entries.iter().find(|e| e.id == c1).unwrap();
    let mut names: Vec<_> = old.labels.iter().map(|l| (l.name.as_str(), l.auto)).collect();
    names.sort();
    assert_eq!(names, vec![("Compiled OK", true), ("Second label", false), ("Submitted to NeurIPS", false)]);
    assert!(entries.iter().find(|e| e.id == c2).unwrap().labels.is_empty());
}

#[test]
fn lock_contention_between_threads_and_processes() {
    let d = project();
    let dir = d.path().to_path_buf();
    put(&dir, "main.tex", "x");
    snap(&dir);
    // Another thread holds the project's mutex.
    let m = lock::project_mutex(&dir);
    let guard = m.lock().unwrap();
    let other = dir.clone();
    let res = std::thread::spawn(move || repo::with_repo(&other, Duration::from_millis(100), |_| Ok(())))
        .join()
        .unwrap();
    assert!(res.unwrap_err().to_string().contains("busy"));
    drop(guard);
    // Another process holds texo.lock.
    fs::write(repo::git_dir(&dir).join(lock::LOCK_FILE), "4000000000\nnow\nanother-pc\n").unwrap();
    let res = repo::with_repo(&dir, Duration::from_millis(100), |_| Ok(()));
    assert!(res.unwrap_err().to_string().contains("Another Texo window"));
    // Automatic snapshots give up quietly.
    put(&dir, "main.tex", "y");
    let started = std::time::Instant::now();
    assert!(super::snapshot_quietly(&dir, Reason::Idle).is_none());
    assert!(started.elapsed() < Duration::from_secs(10));
    fs::remove_file(repo::git_dir(&dir).join(lock::LOCK_FILE)).unwrap();
    assert!(super::snapshot_quietly(&dir, Reason::Idle).is_some());
    // Parallel writers in one process are serialised, not lost.
    let handles: Vec<_> = (0..4)
        .map(|i| {
            let dir = dir.clone();
            std::thread::spawn(move || {
                put(&dir, &format!("t{i}.tex"), "x");
                repo::with_repo(&dir, repo::WAIT, |ctx| snapshot::snapshot(ctx, Meta::you(Reason::Manual))).unwrap();
            })
        })
        .collect();
    for h in handles {
        h.join().unwrap();
    }
    assert_eq!(files(&dir).len(), 5);
}

#[test]
fn corrupt_repo_is_set_aside_and_recreated() {
    let d = project();
    let dir = d.path();
    put(dir, "main.tex", "x");
    snap(dir).unwrap();
    let gd = repo::git_dir(dir);
    // HEAD points at an object that doesn't exist.
    fs::write(gd.join("refs/heads/main"), "1234567890123456789012345678901234567890\n").unwrap();
    let st = super::status(dir);
    assert!(st.active, "{st:?}");
    assert!(st.notice.as_deref().unwrap().contains("damaged"));
    assert_eq!(st.count, 1, "a fresh snapshot of the current files");
    assert_eq!(files(dir), vec!["main.tex"]);
    let broken: Vec<_> = fs::read_dir(dir.join(".texo"))
        .unwrap()
        .flatten()
        .filter(|e| e.file_name().to_string_lossy().starts_with("history.broken-"))
        .collect();
    assert_eq!(broken.len(), 1);
    // The notice is shown once.
    assert!(super::status(dir).notice.is_none());
}

#[test]
fn garbage_head_file_is_recovered() {
    let d = project();
    let dir = d.path();
    put(dir, "main.tex", "x");
    snap(dir).unwrap();
    fs::write(repo::git_dir(dir).join("HEAD"), "garbage").unwrap();
    assert!(snap(dir).is_some());
    assert!(Prefs::load(dir).notice.is_some());
}

#[test]
fn disabled_history_still_applies_changesets() {
    let d = project();
    let dir = d.path();
    put(dir, "main.tex", "a\n");
    let st = super::set_enabled(dir, false).unwrap();
    assert!(!st.enabled && !st.active);
    assert!(super::snapshot_quietly(dir, Reason::BeforeCompile).is_none());
    assert!(apply::start_run(dir, "run-off").is_none());
    let out = apply::apply_changeset(dir, &request("run-off", vec![change("main.tex", Some("a\n"), Some("b\n"))])).unwrap();
    assert_eq!(out.written, vec!["main.tex"]);
    assert!(out.commit.is_none());
    assert!(super::snapshot_now(dir, "x").is_err());
    let st = super::set_enabled(dir, true).unwrap();
    assert!(st.enabled && st.active && st.count == 1);
}

#[test]
fn git_exclude_offer() {
    let d = project();
    let dir = d.path();
    put(dir, "main.tex", "x");
    assert!(!super::status(dir).offer_git_exclude);
    fs::create_dir_all(dir.join(".git/info")).unwrap();
    fs::write(dir.join(".git/info/exclude"), "# git ls-files --others\n*.swp").unwrap();
    assert!(super::status(dir).offer_git_exclude);
    let st = super::answer_git_exclude(dir, true).unwrap();
    assert!(!st.offer_git_exclude);
    let text = fs::read_to_string(dir.join(".git/info/exclude")).unwrap();
    assert!(text.starts_with("# git ls-files --others\n*.swp\n"));
    assert!(text.lines().any(|l| l == ".texo/"));
    // Saying no is remembered too.
    let d2 = project();
    fs::create_dir_all(d2.path().join(".git")).unwrap();
    assert!(!super::answer_git_exclude(d2.path(), false).unwrap().offer_git_exclude);
    assert!(!d2.path().join(".git/info/exclude").exists());
}

#[test]
fn idle_snapshot_after_saves() {
    let d = project();
    let dir = d.path();
    put(dir, "main.tex", "x");
    super::auto::note_save_with(dir, Duration::from_millis(150));
    super::auto::note_save_with(dir, Duration::from_millis(150));
    assert!(super::auto::is_pending(dir));
    let start = std::time::Instant::now();
    while super::auto::is_pending(dir) && start.elapsed() < Duration::from_secs(10) {
        std::thread::sleep(Duration::from_millis(20));
    }
    // The snapshot runs right after the entry is cleared.
    let mut n = 0;
    while n == 0 && start.elapsed() < Duration::from_secs(10) {
        std::thread::sleep(Duration::from_millis(20));
        n = log(dir, LogFilter::default()).len();
    }
    assert_eq!(n, 1);
    assert_eq!(log(dir, LogFilter::default())[0].reason.as_deref(), Some("idle"));
    super::auto::note_save_with(dir, Duration::from_secs(60));
    super::auto::cancel(dir);
    assert!(!super::auto::is_pending(dir));
}

#[test]
fn packing_keeps_everything_readable() {
    let d = project();
    let dir = d.path();
    for i in 0..5 {
        put(dir, "main.tex", &format!("v{i}"));
        snap(dir).unwrap();
    }
    let first = log(dir, LogFilter::default()).last().unwrap().id.clone();
    let removed = repo::with_repo(dir, repo::WAIT, repo::pack).unwrap();
    assert!(removed >= 10, "removed {removed}");
    assert!(fs::read_dir(repo::git_dir(dir).join("objects/pack")).unwrap().count() >= 2);
    assert_eq!(log(dir, LogFilter::default()).len(), 5);
    let bytes = repo::with_repo(dir, repo::WAIT, |ctx| restore::file_at(ctx, &first, "main.tex")).unwrap();
    assert_eq!(bytes.as_deref(), Some(&b"v0"[..]));
    put(dir, "main.tex", "after pack");
    assert!(snap(dir).is_some());
}

#[test]
fn too_many_files_is_refused() {
    let d = project();
    let dir = d.path();
    for i in 0..4 {
        put(dir, &format!("f{i}.tex"), "x");
    }
    // Building 20k real files is slow; the same code path with a cap of 3.
    let ex = super::walk::Excludes::default();
    let e = super::walk::scan_capped(dir, &ex, 3).unwrap_err();
    assert!(e.to_string().contains("more than 20000 files"));
    assert_eq!(super::walk::scan_capped(dir, &ex, 4).unwrap().files.len(), 4);
}

#[test]
fn trailers_survive_odd_names() {
    let meta = Meta {
        who: snapshot::Who::Ai(AiAuthor { profile_name: "My <evil>\nagent".into(), model: "m".into(), kind: "task".into() }),
        reason: Reason::AgentApply,
        summary: "line one\nline two".into(),
        run_id: Some("r1".into()),
        step: None,
        undo_of: None,
        note: None,
    };
    let msg = snapshot::message(&meta);
    assert!(msg.starts_with("line one line two\n\n"));
    let t = query::trailers(&msg);
    assert_eq!(t.get("texo-agent").map(String::as_str), Some("My <evil> agent"));
    assert_eq!(t.get("texo-run").map(String::as_str), Some("r1"));
    assert_eq!(snapshot::ai_name(&ai()), "Texo AI · Fix compile errors (nvidia/nemotron-3-ultra-550b-a55b)");
    assert_eq!(Reason::parse("before-compile"), Some(Reason::BeforeCompile));
}

#[cfg(unix)]
#[test]
fn read_only_folder_turns_history_off() {
    use std::os::unix::fs::PermissionsExt;
    let d = project();
    let dir = d.path();
    put(dir, "main.tex", "x");
    fs::set_permissions(dir, fs::Permissions::from_mode(0o555)).unwrap();
    let st = super::status(dir);
    // Checked while the folder is still read-only.
    let snap = super::snapshot_quietly(dir, Reason::Idle);
    fs::set_permissions(dir, fs::Permissions::from_mode(0o755)).unwrap();
    // Root ignores permissions (some CI containers).
    if st.active {
        return;
    }
    assert!(st.read_only, "{st:?}");
    assert!(snap.is_none(), "{snap:?}");
}

#[test]
fn restore_never_overwrites_a_file_whose_current_version_is_not_in_history() {
    let d = project();
    let dir = d.path();
    put(dir, "main.tex", "v1");
    put(dir, "figures/scan.pdf", "small old scan");
    let first = snap(dir).unwrap();
    put(dir, "main.tex", "v2");
    // Replaced by a version too large for the history.
    let big = fs::File::create(dir.join("figures/scan.pdf")).unwrap();
    big.set_len(super::walk::MAX_FILE_BYTES + 1).unwrap();
    drop(big);
    let r = repo::with_repo(dir, repo::WAIT, |ctx| restore::restore_all(ctx, &first)).unwrap();
    assert_eq!(fs::read_to_string(dir.join("main.tex")).unwrap(), "v1");
    assert_eq!(fs::metadata(dir.join("figures/scan.pdf")).unwrap().len(), super::walk::MAX_FILE_BYTES + 1);
    assert_eq!(r.failed, vec!["figures/scan.pdf"]);
    assert!(!r.written.contains(&"figures/scan.pdf".to_string()));
    let one = repo::with_repo(dir, repo::WAIT, |ctx| restore::restore_file(ctx, &first, "figures/scan.pdf"));
    assert!(one.unwrap_err().to_string().contains("left as it is"));
    assert_eq!(fs::metadata(dir.join("figures/scan.pdf")).unwrap().len(), super::walk::MAX_FILE_BYTES + 1);
}

#[test]
fn restore_after_a_case_only_rename_keeps_the_file() {
    let d = project();
    let dir = d.path();
    put(dir, "Main.tex", "old text");
    let first = snap(dir).unwrap();
    fs::rename(dir.join("Main.tex"), dir.join("tmp.tex")).unwrap();
    fs::rename(dir.join("tmp.tex"), dir.join("main.tex")).unwrap();
    put(dir, "main.tex", "new text");
    snap(dir).unwrap();
    assert_eq!(files(dir), vec!["main.tex"]);
    let r = repo::with_repo(dir, repo::WAIT, |ctx| restore::restore_all(ctx, &first)).unwrap();
    assert!(r.failed.is_empty(), "{r:?}");
    let on_disk: Vec<String> = fs::read_dir(dir)
        .unwrap()
        .flatten()
        .map(|e| e.file_name().to_string_lossy().to_string())
        .filter(|n| n.ends_with(".tex"))
        .collect();
    assert_eq!(on_disk.len(), 1, "{on_disk:?}");
    assert_eq!(fs::read_to_string(dir.join(&on_disk[0])).unwrap(), "old text");
    assert_eq!(files(dir).len(), 1);
}

#[test]
fn packing_again_replaces_the_old_pack() {
    let d = project();
    let dir = d.path();
    let packs = || {
        fs::read_dir(repo::git_dir(dir).join("objects/pack"))
            .unwrap()
            .flatten()
            .filter(|e| e.file_name().to_string_lossy().ends_with(".pack"))
            .count()
    };
    for round in 0..3 {
        for i in 0..3 {
            put(dir, "main.tex", &format!("round {round} v{i}"));
            snap(dir).unwrap();
        }
        repo::with_repo(dir, repo::WAIT, repo::pack).unwrap();
        // On Windows the old pack file goes once no repo has it open.
        repo::with_repo(dir, repo::WAIT, |_| Ok(())).unwrap();
        assert_eq!(packs(), 1, "round {round}");
    }
    let all = log(dir, LogFilter::default());
    assert_eq!(all.len(), 9);
    let first = all.last().unwrap().id.clone();
    let bytes = repo::with_repo(dir, repo::WAIT, |ctx| restore::file_at(ctx, &first, "main.tex")).unwrap();
    assert_eq!(bytes.as_deref(), Some(&b"round 0 v0"[..]));
}

#[cfg(windows)]
#[test]
fn apply_with_a_delete_that_fails_still_records_the_ai_commit() {
    let d = project();
    let dir = d.path();
    put(dir, "a.tex", "old a");
    put(dir, "old.tex", "old file");
    snap(dir).unwrap();
    // Another app has old.tex open without letting it be deleted.
    let held = {
        use std::os::windows::fs::OpenOptionsExt;
        const FILE_SHARE_READ: u32 = 1;
        fs::File::options().read(true).share_mode(FILE_SHARE_READ).open(dir.join("old.tex")).unwrap()
    };
    let out = apply::apply_changeset(
        dir,
        &request("run-ro", vec![change("a.tex", Some("old a"), Some("new a")), change("old.tex", Some("old file"), None)]),
    )
    .unwrap();
    drop(held);
    assert_eq!(out.written, vec!["a.tex"]);
    assert!(out.deleted.is_empty());
    assert_eq!(out.conflicts.len(), 1);
    assert_eq!(out.conflicts[0].file, "old.tex");
    assert!(out.history_error.is_none(), "{:?}", out.history_error);
    assert!(out.commit.is_some(), "the AI commit is made for what was written");
    assert_eq!(fs::read_to_string(dir.join("a.tex")).unwrap(), "new a");
    assert!(dir.join("old.tex").exists());
}

#[test]
fn shipped_bbl_edited_by_ai_is_recorded_and_can_be_undone() {
    let d = project();
    let dir = d.path();
    put(dir, "main.tex", "cite refs");
    put(dir, "main.bbl", "bibitem a old");
    snap(dir).unwrap();
    assert_eq!(files(dir), vec!["main.bbl", "main.tex"]);
    apply::start_run(dir, "run-bbl").unwrap();
    let out = apply::apply_changeset(
        dir,
        &request("run-bbl", vec![change("main.bbl", Some("bibitem a old"), Some("bibitem a new"))]),
    )
    .unwrap();
    assert!(out.commit.is_some());
    let undo = repo::with_repo(dir, repo::WAIT, |ctx| restore::undo_run(ctx, "run-bbl")).unwrap();
    assert!(undo.ok);
    assert_eq!(fs::read_to_string(dir.join("main.bbl")).unwrap(), "bibitem a old");
}

#[test]
fn read_errors_are_not_treated_as_a_damaged_history() {
    let io = git2::Error::new(git2::ErrorCode::GenericError, git2::ErrorClass::Os, "sharing violation");
    assert!(repo::is_transient(&io));
    let fs_err = git2::Error::new(git2::ErrorCode::GenericError, git2::ErrorClass::Filesystem, "cloud file unavailable");
    assert!(repo::is_transient(&fs_err));
    let corrupt = git2::Error::new(git2::ErrorCode::GenericError, git2::ErrorClass::Zlib, "bad data");
    assert!(!repo::is_transient(&corrupt));
    let missing = git2::Error::new(git2::ErrorCode::NotFound, git2::ErrorClass::Odb, "object not found");
    assert!(!repo::is_transient(&missing));
}
