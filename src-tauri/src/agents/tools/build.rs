//! Build tools: `compile_check` (a shadow compile) and `explain_log`.
//!
//! The shadow compile copies the project (Texo's exclude list: no `.texo/`,
//! no build outputs, no compiled PDF) plus the run's overlay and editor
//! buffers into [`shadow_root`]`/<run>` (`%TEMP%/texo-shadow` on Windows, a
//! private per-user cache folder elsewhere) and runs [`compile::compile`]
//! there. The user's files and PDF are never touched.
//!
//! Shadow compiles always use the untrusted compile flags (no shell escape,
//! no project latexmkrc), even in a trusted project: the files compiled are
//! partly written by the model, and text it read (a web page, a paper) could
//! have told it to plant code. The copy is made once per run and updated
//! with the overlay before each check; it is removed when the run ends, and
//! copies left by a crash are swept at the next start
//! ([`sweep_old_shadows`]).

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use walkdir::WalkDir;

use crate::compile::{self, CompileResult, Compiler, Status};
use crate::error::{AppError, AppResult};
use crate::history::walk::Excludes;
use crate::project;
use crate::texlog::{Issue, Severity};

use super::super::overlay::Overlay;

/// What a shadow compile needs from the app.
#[derive(Debug, Clone)]
pub struct BuildEnv {
    /// Where Texo keeps downloaded tools (Tectonic).
    pub tools_dir: PathBuf,
    pub compiler: Compiler,
    /// The user trusts this project (its latexmkrc, shell escape rules).
    /// Shadow compiles run untrusted anyway; this only changes the note the
    /// model gets about the skipped latexmkrc.
    pub trusted: bool,
}

#[derive(Default)]
struct Inner {
    copied: bool,
    last: Option<CompileResult>,
    rounds: u32,
}

/// Per-run build state (shared by sub-runs).
pub struct BuildState {
    env: Option<BuildEnv>,
    shadow: PathBuf,
    inner: Mutex<Inner>,
}

const MAX_ISSUES_SHOWN: usize = 10;

impl BuildState {
    /// `env: None` makes `compile_check` say compiling isn't available.
    pub fn new(run_id: &str, env: Option<BuildEnv>) -> Self {
        BuildState { env, shadow: shadow_root().join(run_id), inner: Mutex::new(Inner::default()) }
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, Inner> {
        self.inner.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// Compile checks made so far in this run.
    pub fn rounds(&self) -> u32 {
        self.lock().rounds
    }

    /// The latest shadow compile.
    pub fn last(&self) -> Option<CompileResult> {
        self.lock().last.clone()
    }

    #[allow(dead_code)]
    pub fn shadow_dir(&self) -> &Path {
        &self.shadow
    }

    /// Removes the shadow copy.
    pub fn cleanup(&self) {
        let _ = fs::remove_dir_all(&self.shadow);
    }

    /// Runs one shadow compile (blocking). `files` are the overlay's view
    /// ([`Overlay::shadow_files`]).
    pub fn compile(&self, root: &Path, files: &[(String, Option<String>)], cancel: Arc<AtomicBool>) -> AppResult<CompileResult> {
        let Some(env) = &self.env else {
            return Err(AppError::msg("Compiling isn't available in this run."));
        };
        let meta = project::read_meta(root).ok_or_else(|| AppError::msg("This project's settings can't be read."))?;
        let Some(main) = meta.main_document.clone() else {
            return Err(AppError::msg("This project has no main document set, so it can't be compiled."));
        };
        {
            let mut inner = self.lock();
            if !inner.copied {
                let _ = fs::remove_dir_all(&self.shadow);
                mirror(root, &self.shadow)?;
                // compile::compile only needs the project's own folder; it
                // creates `.texo/build` in the shadow copy itself.
                inner.copied = true;
            }
            for (rel, text) in files {
                let dest = self.shadow.join(rel);
                match text {
                    Some(t) => {
                        if let Some(parent) = dest.parent() {
                            fs::create_dir_all(parent)?;
                        }
                        fs::write(&dest, t)?;
                    }
                    None => {
                        let _ = fs::remove_file(&dest);
                    }
                }
            }
            inner.rounds += 1;
        }
        let tools = compile::detect(&env.tools_dir);
        let result = match tools.choose(env.compiler, meta.engine) {
            None => CompileResult {
                status: Status::NoEngine,
                compiler: None,
                engine: meta.engine,
                pdf_path: None,
                duration_ms: 0,
                issues: Vec::new(),
                hints: Vec::new(),
                log: String::new(),
                output: String::new(),
                rc_ignored: false,
                saved_pdf: None,
            },
            Some(compiler) => {
                let quiet = |_: Vec<String>| {};
                compile::compile(&compile::Job {
                    root: &self.shadow,
                    main: &main,
                    engine: meta.engine,
                    compiler,
                    tools: &tools,
                    cancel: cancel.clone(),
                    // Never trusted: see the module docs.
                    trusted: false,
                    on_output: &quiet,
                })
            }
        };
        if cancel.load(Ordering::SeqCst) {
            return Err(AppError::msg("Stopped."));
        }
        let mut result = result;
        if env.trusted && result.rc_ignored {
            // Tells `compile_text` the rc was skipped on purpose here.
            result.hints.push(SAFE_MODE_HINT.to_string());
        }
        self.lock().last = Some(result.clone());
        Ok(result)
    }
}

const SAFE_MODE_HINT: &str = "[safe-mode] Compile checks run in safe mode: the project's latexmkrc and shell escape are off, so a problem that only appears here (for example with minted) isn't caused by your edits. Don't change the source to work around it; tell the user.";

/// Where shadow copies go. `%TEMP%/texo-shadow` on Windows (a per-user
/// folder). Elsewhere the system temp folder is shared by every user
/// (`/tmp`), so the copies go to the user's own cache folder
/// (`~/.cache/texo/shadow`, `~/Library/Caches/texo/shadow`).
pub fn shadow_root() -> PathBuf {
    #[cfg(windows)]
    {
        std::env::temp_dir().join("texo-shadow")
    }
    #[cfg(not(windows))]
    {
        match dirs::cache_dir() {
            Some(c) => c.join("texo").join("shadow"),
            // No home folder: a per-user name in the temp folder, made private below.
            None => std::env::temp_dir().join(format!("texo-shadow-{}", whoami())),
        }
    }
}

#[cfg(not(windows))]
fn whoami() -> String {
    let name = std::env::var("USER").or_else(|_| std::env::var("LOGNAME")).unwrap_or_else(|_| "user".into());
    name.chars().filter(|c| c.is_ascii_alphanumeric() || *c == '-' || *c == '_').collect()
}

/// Creates `dir` (and the shadow root) readable only by this user.
fn create_private_dir(dir: &Path) -> AppResult<()> {
    fs::create_dir_all(dir)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let root = shadow_root();
        for d in [root.as_path(), dir] {
            if d.starts_with(&root) {
                fs::set_permissions(d, fs::Permissions::from_mode(0o700))?;
            }
        }
    }
    Ok(())
}

/// Removes shadow copies older than `max_age` (left by a crash or by
/// quitting Texo during a run). Runs once at start; errors are ignored.
pub fn sweep_old_shadows(max_age: std::time::Duration) {
    sweep_dir(&shadow_root(), max_age);
}

fn sweep_dir(root: &Path, max_age: std::time::Duration) {
    let Ok(entries) = fs::read_dir(root) else { return };
    let now = std::time::SystemTime::now();
    for e in entries.filter_map(Result::ok) {
        let old = e
            .metadata()
            .and_then(|m| m.modified())
            .ok()
            .and_then(|t| now.duration_since(t).ok())
            .is_some_and(|age| age >= max_age);
        if old {
            let p = e.path();
            let _ = if p.is_dir() { fs::remove_dir_all(&p) } else { fs::remove_file(&p) };
        }
    }
}

/// Copies the project into `dest` with Texo's exclude list (links skipped).
fn mirror(root: &Path, dest: &Path) -> AppResult<()> {
    let ex = Excludes::for_project(root);
    create_private_dir(dest)?;
    let walker = WalkDir::new(root)
        .min_depth(1)
        .follow_links(false)
        .into_iter()
        .filter_entry(|e| !(e.file_type().is_dir() && e.file_name().to_str().is_some_and(|n| ex.skip_dir(n))));
    let mut count = 0usize;
    for entry in walker.filter_map(Result::ok) {
        if !entry.file_type().is_file() {
            continue;
        }
        let Ok(rel) = entry.path().strip_prefix(root) else { continue };
        let rel_s = project::to_slash(rel);
        if ex.skip_file(&rel_s) {
            continue;
        }
        count += 1;
        if count > crate::history::walk::MAX_FILES {
            return Err(crate::history::walk::too_many_files());
        }
        let target = dest.join(rel);
        if let Some(parent) = target.parent() {
            fs::create_dir_all(parent)?;
        }
        fs::copy(entry.path(), &target)?;
    }
    Ok(())
}

fn status_words(s: Status) -> &'static str {
    match s {
        Status::Success => "Compiled successfully.",
        Status::Failed => "The compile failed.",
        Status::Aborted => "The compile was stopped.",
        Status::Timeout => "The compile took too long and was stopped.",
        Status::NoEngine => "No TeX installation was found, so the project can't be compiled here.",
        Status::NoMainDocument => "The main document can't be found.",
    }
}

fn location(i: &Issue) -> String {
    match (&i.file, i.line) {
        (Some(f), Some(l)) => format!("{}:{l}", f.trim_start_matches("./")),
        (Some(f), None) => f.trim_start_matches("./").to_string(),
        _ => "(no file)".into(),
    }
}

/// Packages the compile says are missing (from the log and the hints).
pub fn missing_packages(r: &CompileResult) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for h in &r.hints {
        if let Some(rest) = h.strip_prefix("[fix:install-package:") {
            if let Some((pkg, _)) = rest.split_once(']') {
                out.push(pkg.to_string());
            }
        }
    }
    for i in &r.issues {
        if let Some(f) = &i.missing_file {
            let name = f.rsplit_once('.').map(|(n, _)| n).unwrap_or(f);
            if !out.iter().any(|p| p == name) && (f.ends_with(".sty") || f.ends_with(".cls")) {
                out.push(name.to_string());
            }
        }
    }
    out.dedup();
    out
}

fn strip_marker(h: &str) -> &str {
    if h.starts_with("[fix:") || h.starts_with("[safe-mode]") {
        h.split_once("] ").map(|x| x.1).unwrap_or(h)
    } else {
        h
    }
}

/// The text `compile_check` returns to the model.
pub fn compile_text(r: &CompileResult, round: u32) -> String {
    let mut out = format!("Compile check {round}: {}\n", status_words(r.status));
    let errors: Vec<&Issue> = r.issues.iter().filter(|i| i.severity == Severity::Error).collect();
    let warnings = r.issues.iter().filter(|i| i.severity == Severity::Warning).count();
    if !r.issues.is_empty() {
        out.push_str(&format!("{} error(s), {warnings} warning(s).\n", errors.len()));
    }
    for (n, i) in r.issues.iter().filter(|i| i.severity != Severity::Badbox).take(MAX_ISSUES_SHOWN).enumerate() {
        let kind = if i.severity == Severity::Error { "error" } else { "warning" };
        out.push_str(&format!("{}. [{kind}] {} {}\n", n + 1, location(i), crate::agents::types::one_line(&i.message, 200)));
    }
    let missing = missing_packages(r);
    if !missing.is_empty() {
        out.push_str(&format!(
            "Missing package(s): {}. Don't change the source to work around this: tell the user to install it (Texo offers a one-click install).\n",
            missing.join(", ")
        ));
    }
    let safe_mode = r.hints.iter().any(|h| h == SAFE_MODE_HINT);
    for h in r.hints.iter().filter(|h| *h != SAFE_MODE_HINT).take(3) {
        out.push_str(&format!("Hint: {}\n", crate::agents::types::one_line(strip_marker(h), 300)));
    }
    if safe_mode {
        out.push_str(&format!("Note: {}\n", strip_marker(SAFE_MODE_HINT)));
    } else if r.rc_ignored {
        out.push_str("Note: the project's latexmkrc was not used because the project isn't trusted.\n");
    }
    if r.status != Status::Success && !r.issues.is_empty() {
        out.push_str("Use explain_log with an issue number for what it means and how to fix it.\n");
    }
    out
}

/// `explain_log`: the deterministic explanation of one issue (1-based, as
/// numbered by `compile_check`), or the first error.
pub fn explain_text(last: Option<&CompileResult>, index: Option<u64>) -> AppResult<String> {
    let Some(r) = last else {
        return Err(AppError::msg("There's no compile result yet. Call compile_check first."));
    };
    let shown: Vec<&Issue> = r.issues.iter().filter(|i| i.severity != Severity::Badbox).collect();
    let issue = match index {
        Some(n) => shown
            .get((n as usize).saturating_sub(1))
            .copied()
            .ok_or_else(|| AppError::msg(format!("There is no issue {n}; the last compile listed {}.", shown.len().min(MAX_ISSUES_SHOWN))))?,
        None => match shown.iter().find(|i| i.fatal).or_else(|| shown.iter().find(|i| i.severity == Severity::Error)) {
            Some(i) => i,
            None => return Ok(format!("{} There are no errors to explain.", status_words(r.status))),
        },
    };
    let mut out = format!("{} {}\n", location(issue), issue.message.trim());
    if let Some(ctx) = &issue.context {
        out.push_str(&format!("Log context:\n{}\n", crate::agents::types::cap(ctx.trim(), 1500)));
    }
    match &issue.explanation {
        Some(e) => out.push_str(&format!("What it means: {e}\n")),
        None => out.push_str("Texo has no stored explanation for this message; read the lines around it and the log context.\n"),
    }
    if issue.fatal {
        out.push_str("This is the error that stopped TeX; fix it first, the others may follow from it.\n");
    }
    if issue.consequence {
        out.push_str("This only appears because the compile stopped early; it usually goes away once the first error is fixed.\n");
    }
    for h in r.hints.iter().filter(|h| *h != SAFE_MODE_HINT).take(2) {
        out.push_str(&format!("Hint: {}\n", strip_marker(h)));
    }
    Ok(out)
}

/// Runs `compile_check` for a tool call: updates the shadow copy from the
/// overlay and compiles off the async runtime; cancelling stops TeX.
pub async fn compile_check(
    state: Arc<BuildState>,
    root: PathBuf,
    overlay: Arc<Mutex<Overlay>>,
    cancel: &crate::ai::http::Cancel,
) -> AppResult<String> {
    let files = overlay.lock().unwrap_or_else(|e| e.into_inner()).shadow_files();
    let flag = Arc::new(AtomicBool::new(false));
    let worker_flag = flag.clone();
    let worker_state = state.clone();
    let mut handle = tokio::task::spawn_blocking(move || worker_state.compile(&root, &files, worker_flag));
    let res = cancel
        .run(async {
            (&mut handle).await.map_err(|_| crate::ai::error::AiError::new(crate::ai::error::Kind::Other, "The compile crashed."))
        })
        .await;
    match res {
        Ok(r) => {
            let r = r?;
            Ok(compile_text(&r, state.rounds()))
        }
        Err(e) => {
            flag.store(true, Ordering::SeqCst);
            // TeX is told to stop; wait for the worker so the run's cleanup
            // doesn't race it (it may still hold files in the copy).
            if !handle.is_finished() {
                let _ = handle.await;
            }
            Err(AppError::msg(e.message))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::texlog::Issue;

    fn result(status: Status, issues: Vec<Issue>, hints: Vec<String>) -> CompileResult {
        CompileResult {
            status,
            compiler: None,
            engine: Default::default(),
            pdf_path: None,
            duration_ms: 1,
            issues,
            hints,
            log: String::new(),
            output: String::new(),
            rc_ignored: false,
            saved_pdf: None,
        }
    }

    #[test]
    fn compile_text_lists_issues_and_missing_packages() {
        let issues = vec![Issue {
            severity: Severity::Error,
            message: "Missing } inserted.".into(),
            file: Some("./main.tex".into()),
            line: Some(12),
            explanation: Some("A { has no matching }.".into()),
            fatal: true,
            ..Default::default()
        }];
        let r = result(Status::Failed, issues, vec!["[fix:install-package:cm-super] TeX stopped at main.tex line 13".into()]);
        let t = compile_text(&r, 2);
        assert!(t.starts_with("Compile check 2: The compile failed."), "{t}");
        assert!(t.contains("1. [error] main.tex:12 Missing } inserted."));
        assert!(t.contains("Missing package(s): cm-super"));
        assert!(t.contains("Hint: TeX stopped") && !t.contains("[fix:"));
        let e = explain_text(Some(&r), None).unwrap();
        assert!(e.contains("What it means: A { has no matching }.") && e.contains("stopped TeX"));
        assert!(explain_text(Some(&r), Some(5)).is_err());
        assert!(explain_text(None, None).unwrap_err().to_string().contains("compile_check"));
        let ok = result(Status::Success, Vec::new(), Vec::new());
        assert!(explain_text(Some(&ok), None).unwrap().contains("no errors"));
    }

    #[test]
    fn shadow_copy_mirrors_project_plus_overlay_without_touching_it() {
        let d = tempfile::tempdir().unwrap();
        let root = d.path();
        project::adopt(root, "p", Some("main.tex".into()), Default::default()).unwrap();
        fs::write(root.join("main.tex"), "on disk\n").unwrap();
        fs::write(root.join("main.aux"), "aux").unwrap();
        fs::create_dir_all(root.join("sec")).unwrap();
        fs::write(root.join("sec/a.tex"), "a\n").unwrap();
        fs::write(root.join("old.tex"), "old\n").unwrap();
        let run = format!("test-shadow-{}", uuid::Uuid::new_v4().simple());
        // Tectonic from an empty tools folder: normally "no TeX", so the test
        // doesn't run a real compile.
        let env = BuildEnv { tools_dir: root.join("no-tools"), compiler: Compiler::Tectonic, trusted: false };
        let state = BuildState::new(&run, Some(env));
        let files = vec![("main.tex".to_string(), Some("from overlay\n".to_string())), ("old.tex".to_string(), None)];
        // Whatever TeX is installed, the copy is made first.
        let _ = state.compile(root, &files, Arc::new(AtomicBool::new(false)));
        let shadow = state.shadow_dir().to_path_buf();
        assert_eq!(fs::read_to_string(shadow.join("main.tex")).unwrap(), "from overlay\n");
        assert_eq!(fs::read_to_string(shadow.join("sec/a.tex")).unwrap(), "a\n");
        assert!(!shadow.join("old.tex").exists());
        assert!(!shadow.join("main.aux").exists());
        assert!(!shadow.join(".texo/project.json").exists());
        assert_eq!(fs::read_to_string(root.join("main.tex")).unwrap(), "on disk\n");
        assert!(root.join("old.tex").exists());
        assert_eq!(state.rounds(), 1);
        state.cleanup();
        assert!(!shadow.exists());
    }

    #[test]
    fn old_shadow_copies_are_swept() {
        let d = tempfile::tempdir().unwrap();
        fs::create_dir_all(d.path().join("run-a/sub")).unwrap();
        fs::write(d.path().join("run-a/sub/main.tex"), "x").unwrap();
        sweep_dir(d.path(), std::time::Duration::from_secs(3600));
        assert!(d.path().join("run-a").exists(), "a fresh copy is kept");
        sweep_dir(d.path(), std::time::Duration::ZERO);
        assert!(!d.path().join("run-a").exists());
        sweep_dir(&d.path().join("missing"), std::time::Duration::ZERO);
        assert!(shadow_root().ends_with("texo-shadow") || shadow_root().ends_with("shadow"));
    }

    #[test]
    fn safe_mode_note_replaces_the_untrusted_note() {
        let mut r = result(Status::Success, Vec::new(), Vec::new());
        r.rc_ignored = true;
        assert!(compile_text(&r, 1).contains("isn't trusted"));
        r.hints.push(SAFE_MODE_HINT.to_string());
        let t = compile_text(&r, 1);
        assert!(t.contains("Note: Compile checks run in safe mode") && !t.contains("[safe-mode]") && !t.contains("Hint:"), "{t}");
        assert!(!t.contains("isn't trusted"));
    }

    /// SEC: a latexmkrc in the shadow copy (planted, or the project's own)
    /// never runs during an agent's compile check, even in a trusted
    /// project, and the overlay refuses to write one at all. Needs latexmk.
    #[test]
    #[ignore]
    fn trusted_project_shadow_compile_never_runs_a_latexmkrc() {
        let tools = compile::detect(Path::new("."));
        if tools.choose(Compiler::Latexmk, crate::project::Engine::Pdflatex).is_none() {
            eprintln!("skipping: latexmk not installed");
            return;
        }
        let d = tempfile::tempdir().unwrap();
        let root = d.path();
        project::adopt(root, "p", Some("main.tex".into()), Default::default()).unwrap();
        fs::write(root.join("main.tex"), "\\documentclass{article}\n\\begin{document}\nHi\n\\end{document}\n").unwrap();
        let marker = root.join("rc-ran.txt");
        let rc = format!("open(my $f, '>', '{}'); close($f);\n", marker.to_string_lossy().replace('\\', "/"));
        // The model's write_file is refused...
        let mut o = Overlay::new(root, Vec::new());
        assert!(o.write("latexmkrc", &rc, "planted").is_err());
        assert!(o.write(".latexmkrc", &rc, "planted").is_err());
        // ...and even a latexmkrc in the copy doesn't run.
        let files = vec![("latexmkrc".to_string(), Some(rc.clone()))];
        let run = format!("test-rc-{}", uuid::Uuid::new_v4().simple());
        let env = BuildEnv { tools_dir: root.join("no-tools"), compiler: Compiler::Latexmk, trusted: true };
        let state = BuildState::new(&run, Some(env));
        let r = state.compile(root, &files, Arc::new(AtomicBool::new(false))).unwrap();
        state.cleanup();
        assert_eq!(r.status, Status::Success, "{}", r.output);
        assert!(!marker.exists(), "the latexmkrc ran");
        assert!(compile_text(&r, 1).contains("safe mode"));
    }
}
