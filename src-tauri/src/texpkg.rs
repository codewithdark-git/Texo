//! Installs a missing TeX package with the distribution's own package
//! manager, after the user confirmed it in the Issues panel:
//! `miktex packages install <name>` (or the older `mpm --install=<name>`) for
//! MiKTeX, `tlmgr install <name>` for TeX Live.
//!
//! The package name is checked against a strict pattern and passed as a
//! single argument, never through a shell. Output streams to the UI as
//! `tex-package-output` events; the run is bounded by a timeout.

use std::io::{BufRead, BufReader, Read};
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{mpsc, Mutex};
use std::time::{Duration, Instant};

use serde::Serialize;
use tauri::{AppHandle, Emitter, State};

use crate::compile::{self, Compiler, Toolchains};
use crate::error::{AppError, AppResult};
use crate::AppState;

pub const OUTPUT_EVENT: &str = "tex-package-output";
const TIMEOUT: Duration = Duration::from_secs(10 * 60);
const MAX_OUTPUT: usize = 8_000;

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Manager {
    Miktex,
    Texlive,
}

impl Manager {
    /// The manager for the TeX distribution Texo found, if it has one.
    /// Tectonic fetches packages by itself, so nothing is offered for it.
    pub fn for_tools(tools: &Toolchains, compiler: Option<Compiler>) -> Option<Manager> {
        if compiler == Some(Compiler::Tectonic) {
            return None;
        }
        match tools.distribution.as_deref() {
            Some("MiKTeX") => Some(Manager::Miktex),
            Some("TeX Live") => Some(Manager::Texlive),
            _ => None,
        }
    }

    fn label(self) -> &'static str {
        match self {
            Manager::Miktex => "MiKTeX",
            Manager::Texlive => "TeX Live",
        }
    }
}

/// `^[A-Za-z0-9._-]+$`, and not starting with `-` or `.` so it can never be
/// read as an option.
pub fn valid_package(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 64
        && !name.starts_with(['-', '.'])
        && name.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-'))
}

/// Files whose package isn't named after them: (file, TeX Live name, MiKTeX
/// name when it differs).
const KNOWN_FILES: &[(&str, &str, Option<&str>)] = &[
    ("tikz.sty", "pgf", None),
    ("pgf.sty", "pgf", None),
    ("pgfcore.sty", "pgf", None),
    ("graphicx.sty", "graphics", None),
    ("graphics.sty", "graphics", None),
    ("color.sty", "graphics", None),
    ("lscape.sty", "graphics", None),
    ("amssymb.sty", "amsfonts", None),
    ("amsfonts.sty", "amsfonts", None),
    ("amsthm.sty", "amscls", None),
    ("amstext.sty", "amsmath", None),
    ("tabularx.sty", "tools", Some("latex-tools")),
    ("array.sty", "tools", Some("latex-tools")),
    ("longtable.sty", "tools", Some("latex-tools")),
    ("multicol.sty", "tools", Some("latex-tools")),
    ("xspace.sty", "tools", Some("latex-tools")),
    ("verbatim.sty", "tools", Some("latex-tools")),
    ("calc.sty", "tools", Some("latex-tools")),
    ("afterpage.sty", "tools", Some("latex-tools")),
    ("bm.sty", "tools", Some("latex-tools")),
    ("dcolumn.sty", "tools", Some("latex-tools")),
    ("enumerate.sty", "tools", Some("latex-tools")),
    ("varioref.sty", "tools", Some("latex-tools")),
    ("hhline.sty", "tools", Some("latex-tools")),
    ("indentfirst.sty", "tools", Some("latex-tools")),
    ("algorithm.sty", "algorithms", None),
    ("algorithmic.sty", "algorithms", None),
    ("algpseudocode.sty", "algorithmicx", None),
    ("algcompatible.sty", "algorithmicx", None),
    ("subcaption.sty", "caption", None),
    ("nameref.sty", "hyperref", None),
    ("plainnat.bst", "natbib", None),
    ("abbrvnat.bst", "natbib", None),
    ("unsrtnat.bst", "natbib", None),
    ("elsarticle-num.bst", "elsarticle", None),
    ("elsarticle-num-names.bst", "elsarticle", None),
    ("elsarticle-harv.bst", "elsarticle", None),
    ("cas-dc.cls", "els-cas-templates", None),
    ("cas-sc.cls", "els-cas-templates", None),
    ("cas-common.sty", "els-cas-templates", None),
    ("cas-model2-names.bst", "els-cas-templates", None),
    ("model1-num-names.bst", "els-cas-templates", None),
    ("ieeetran.cls", "ieeetran", None),
    ("ieeetran.bst", "ieeetran", None),
    ("acm-reference-format.bst", "acmart", None),
    ("revtex4-2.cls", "revtex", None),
    ("epstopdf.sty", "epstopdf-pkg", None),
    ("lmodern.sty", "lm", None),
    ("times.sty", "psnfss", None),
    ("helvet.sty", "psnfss", None),
    ("courier.sty", "psnfss", None),
    ("mathptmx.sty", "psnfss", None),
    ("mathpazo.sty", "psnfss", None),
    ("pifont.sty", "psnfss", None),
    ("newtxtext.sty", "newtx", None),
    ("newtxmath.sty", "newtx", None),
    ("mathrsfs.sty", "jknapltx", Some("jknappen")),
];

/// The package that provides a missing `file`, for the given manager. Style
/// and class files are usually named after their package; bibliography
/// styles only when Texo knows them, since a custom `.bst` usually belongs in
/// the project instead. None for anything else (a figure, a chapter).
pub fn package_for_file(file: &str, manager: Manager) -> Option<String> {
    let base = file.rsplit(['/', '\\']).next().unwrap_or(file);
    let lower = base.to_ascii_lowercase();
    if let Some((_, tl, mk)) = KNOWN_FILES.iter().find(|(f, _, _)| *f == lower) {
        let name = match manager {
            Manager::Miktex => mk.unwrap_or(tl),
            Manager::Texlive => tl,
        };
        return Some(name.to_string());
    }
    let (stem, ext) = lower.rsplit_once('.')?;
    // Package names are lower case in both distributions.
    (matches!(ext, "sty" | "cls") && valid_package(stem)).then(|| stem.to_string())
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InstallOutcome {
    pub ok: bool,
    /// What happened, in plain words.
    pub message: String,
    /// The end of the package manager's output.
    pub output: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OutputChunk {
    pub package: String,
    pub lines: Vec<String>,
}

fn exe(name: &str) -> String {
    if cfg!(windows) {
        format!("{name}.exe")
    } else {
        name.to_string()
    }
}

/// How to run the package manager: the program and its arguments.
#[derive(Debug, PartialEq)]
pub struct Plan {
    pub program: PathBuf,
    pub args: Vec<String>,
}

/// The package manager that sits next to the TeX programs Texo found.
pub fn plan(tools: &Toolchains, manager: Manager, package: &str) -> Option<Plan> {
    if !valid_package(package) {
        return None;
    }
    let bin = tools.pdflatex.as_ref().or(tools.kpsewhich.as_ref())?.parent()?.to_path_buf();
    let first = |names: &[String]| names.iter().map(|n| bin.join(n)).find(|p| p.is_file());
    match manager {
        Manager::Miktex => {
            if let Some(program) = first(&[exe("miktex")]) {
                return Some(Plan { program, args: vec!["packages".into(), "install".into(), package.into()] });
            }
            // MiKTeX before the `miktex` tool (2021 and older).
            first(&[exe("mpm")]).map(|program| Plan { program, args: vec![format!("--install={package}")] })
        }
        Manager::Texlive => {
            // `tlmgr.bat` on Windows, a script without extension elsewhere.
            first(&["tlmgr.bat".into(), exe("tlmgr"), "tlmgr".into()])
                .map(|program| Plan { program, args: vec!["install".into(), package.into()] })
        }
    }
}

/// The outcome in plain words, from the exit status and what the tool printed.
pub fn outcome_message(manager: Manager, package: &str, ok: bool, timed_out: bool, output: &str) -> String {
    let lower = output.to_ascii_lowercase();
    if timed_out {
        return format!(
            "Installing \"{package}\" took longer than {} minutes and was stopped. Try again, or install it with {}.",
            TIMEOUT.as_secs() / 60,
            match manager {
                Manager::Miktex => "MiKTeX Console",
                Manager::Texlive => "tlmgr in a terminal",
            }
        );
    }
    if ok {
        return format!("Installed \"{package}\". Texo compiles again to check.");
    }
    let admin = ["administrator", "permission", "access is denied", "not writable", "elevated", "you don't have permission"];
    if admin.iter().any(|w| lower.contains(w)) {
        return match manager {
            Manager::Miktex => format!(
                "MiKTeX needs administrator rights to install packages on this computer. Open MiKTeX Console as administrator (right-click it, \"Run as administrator\") and install \"{package}\", then compile again."
            ),
            Manager::Texlive => format!(
                "TeX Live needs administrator rights to install packages. In a terminal, run: sudo tlmgr install {package}, then compile again."
            ),
        };
    }
    // Debian/Ubuntu/Fedora TeX Live: tlmgr can't change the system install.
    if manager == Manager::Texlive && (lower.contains("user mode not initialized") || lower.contains("debian") || lower.contains("distribution")) {
        let apt = if package == "cm-super" { "cm-super" } else { "texlive-latex-extra" };
        return format!(
            "This TeX Live came with your Linux system, so its packages are installed with the system's package manager (for example: sudo apt install {apt}). Then compile again."
        );
    }
    if lower.contains("unknown") || lower.contains("not present in repository") || lower.contains("cannot find package") {
        return format!(
            "{} doesn't have a package called \"{package}\". If the missing file came with your template, copy it into the project folder instead.",
            manager.label()
        );
    }
    if ["resolve host", "connect", "network", "timed out", "download"].iter().any(|w| lower.contains(w)) {
        return format!("Couldn't download \"{package}\". Check the internet connection and try again.");
    }
    format!("{} couldn't install \"{package}\". The details below show what it said.", manager.label())
}

fn tail(s: &str, max: usize) -> String {
    if s.len() <= max {
        return s.to_string();
    }
    let mut start = s.len() - max;
    while !s.is_char_boundary(start) {
        start += 1;
    }
    format!("[...]\n{}", &s[start..])
}

/// How long to keep reading output once the tool has exited, or after it was
/// stopped. Bounded, because a process it started can keep the pipes open.
const DRAIN_AFTER_EXIT: Duration = Duration::from_secs(10);
const DRAIN_AFTER_KILL: Duration = Duration::from_secs(2);

/// The lines still to come, until both readers finish or `wait` runs out.
fn drain(rx: &mpsc::Receiver<String>, wait: Duration) -> Vec<String> {
    let until = Instant::now() + wait;
    let mut rest = Vec::new();
    loop {
        let left = until.saturating_duration_since(Instant::now());
        match rx.recv_timeout(left) {
            Ok(line) => rest.push(line),
            Err(_) => break,
        }
    }
    rest
}

/// Runs the plan, passing output lines to `on_lines` as they arrive.
pub fn run(plan: &Plan, manager: Manager, package: &str, timeout: Duration, on_lines: &dyn Fn(Vec<String>)) -> InstallOutcome {
    let mut cmd = Command::new(&plan.program);
    cmd.args(&plan.args).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
    // tlmgr and miktex never need the project folder; run them from their own.
    if let Some(dir) = plan.program.parent() {
        cmd.current_dir(dir);
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    // Its own process group, so a timeout stops everything it started.
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        cmd.process_group(0);
    }
    let echo = format!("$ {} {}", plan.program.file_name().unwrap_or_default().to_string_lossy(), plan.args.join(" "));
    on_lines(vec![echo.clone()]);
    let mut child = match cmd.spawn() {
        Ok(c) => c,
        Err(e) => {
            return InstallOutcome {
                ok: false,
                message: format!("Texo couldn't start {}'s package manager: {e}", manager.label()),
                output: echo,
            }
        }
    };
    let (tx, rx) = mpsc::channel::<String>();
    let pipe = |stream: Box<dyn Read + Send>, tx: mpsc::Sender<String>| {
        std::thread::spawn(move || {
            let mut reader = BufReader::new(stream);
            let mut buf = Vec::new();
            while reader.read_until(b'\n', &mut buf).unwrap_or(0) > 0 {
                if tx.send(String::from_utf8_lossy(&buf).trim_end().to_string()).is_err() {
                    break;
                }
                buf.clear();
            }
        })
    };
    let out = pipe(Box::new(child.stdout.take().expect("piped")), tx.clone());
    let err = pipe(Box::new(child.stderr.take().expect("piped")), tx);
    let mut all = vec![echo];
    let deadline = Instant::now() + timeout;
    let status = loop {
        let batch: Vec<String> = rx.try_iter().collect();
        if !batch.is_empty() {
            all.extend(batch.iter().cloned());
            on_lines(batch);
        }
        match child.try_wait() {
            Ok(Some(status)) => break Some(status),
            Ok(None) if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(100)),
            _ => {
                // `tlmgr.bat` runs perl through cmd.exe: killing cmd.exe
                // alone would leave perl running and holding the pipes.
                compile::kill_tree(child.id());
                let _ = child.kill();
                let _ = child.wait();
                break None;
            }
        }
    };
    let rest = drain(&rx, if status.is_some() { DRAIN_AFTER_EXIT } else { DRAIN_AFTER_KILL });
    // The reader threads end once every holder of the pipes is gone; one
    // that outlived the kill mustn't keep this install from returning, so
    // they are left to finish on their own.
    drop((out, err));
    if !rest.is_empty() {
        all.extend(rest.iter().cloned());
        on_lines(rest);
    }
    let output = all.join("\n");
    let ok = status.is_some_and(|s| s.success());
    InstallOutcome {
        ok,
        message: outcome_message(manager, package, ok, status.is_none(), &output),
        output: tail(&output, MAX_OUTPUT),
    }
}

/// One install at a time: package managers lock their database.
static BUSY: AtomicBool = AtomicBool::new(false);

/// The message when another install is still running.
pub const BUSY_MESSAGE: &str = "Another package is being installed. Wait for it to finish.";

/// Held while a package manager runs; every install path (this module's
/// one-click install and the AI fix suggestion) takes it, so two never run
/// at once. Released when dropped, also on a panic.
pub struct InstallLock(());

impl InstallLock {
    /// `None` while another install holds the lock.
    pub fn try_take() -> Option<InstallLock> {
        (!BUSY.swap(true, Ordering::SeqCst)).then_some(InstallLock(()))
    }
}

impl Drop for InstallLock {
    fn drop(&mut self) {
        BUSY.store(false, Ordering::SeqCst);
    }
}

/// Installs one TeX package with the installed distribution's package
/// manager. The UI asks the user to confirm first. Output streams as
/// `tex-package-output` events.
#[tauri::command]
pub async fn install_tex_package(app: AppHandle, state: State<'_, Mutex<AppState>>, package: String) -> AppResult<InstallOutcome> {
    if !valid_package(&package) {
        return Err(AppError::msg("That isn't a valid package name."));
    }
    let Some(_lock) = InstallLock::try_take() else {
        return Err(AppError::msg(BUSY_MESSAGE));
    };
    let tools_dir = state.lock().unwrap_or_else(|e| e.into_inner()).tools_dir.clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        let tools = compile::detect(&tools_dir);
        let Some(manager) = Manager::for_tools(&tools, None) else {
            return Err(AppError::msg(
                "Texo didn't find MiKTeX or TeX Live, so it can't install packages. The built-in engine downloads packages by itself.",
            ));
        };
        let Some(plan) = plan(&tools, manager, &package) else {
            return Err(AppError::msg(match manager {
                Manager::Miktex => "Texo couldn't find MiKTeX's package manager. Install the package with MiKTeX Console.",
                Manager::Texlive => "Texo couldn't find TeX Live's package manager (tlmgr). Install the package with your system's package manager.",
            }));
        };
        let emit = |lines: Vec<String>| {
            let _ = app.emit(OUTPUT_EVENT, OutputChunk { package: package.clone(), lines });
        };
        Ok(run(&plan, manager, &package, TIMEOUT, &emit))
    })
    .await
    .map_err(|e| AppError::msg(e.to_string()));
    result?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn one_install_lock_at_a_time() {
        let first = InstallLock::try_take().expect("free at start");
        assert!(InstallLock::try_take().is_none());
        drop(first);
        let again = InstallLock::try_take();
        assert!(again.is_some());
    }
    use std::path::Path;

    fn inside(path: &Path, dir: &Path) -> bool {
        path.parent() == Some(dir)
    }

    #[test]
    fn package_names_are_strict() {
        for ok in ["cm-super", "lm", "els-cas-templates", "l3kernel", "a_b.c"] {
            assert!(valid_package(ok), "{ok}");
        }
        for bad in ["", "-rf", "--admin", ".hidden", "a b", "a;b", "a/b", "a\\b", "$(x)", "x&y", "ä", &"a".repeat(65)] {
            assert!(!valid_package(bad), "{bad}");
        }
    }

    #[test]
    fn finds_the_package_for_a_missing_file() {
        assert_eq!(package_for_file("siunitx.sty", Manager::Miktex).as_deref(), Some("siunitx"));
        assert_eq!(package_for_file("tikz.sty", Manager::Texlive).as_deref(), Some("pgf"));
        assert_eq!(package_for_file("tabularx.sty", Manager::Texlive).as_deref(), Some("tools"));
        assert_eq!(package_for_file("tabularx.sty", Manager::Miktex).as_deref(), Some("latex-tools"));
        assert_eq!(package_for_file("cas-dc.cls", Manager::Miktex).as_deref(), Some("els-cas-templates"));
        assert_eq!(package_for_file("IEEEtran.cls", Manager::Texlive).as_deref(), Some("ieeetran"));
        assert_eq!(package_for_file("plainnat.bst", Manager::Texlive).as_deref(), Some("natbib"));
        // Unknown bibliography styles, figures and chapters aren't packages.
        assert_eq!(package_for_file("mystyle.bst", Manager::Texlive), None);
        assert_eq!(package_for_file("figs/plot.png", Manager::Texlive), None);
        assert_eq!(package_for_file("chapters/intro.tex", Manager::Texlive), None);
        assert_eq!(package_for_file("bad name.sty", Manager::Texlive), None);
    }

    #[test]
    fn plans_the_right_command() {
        let dir = tempfile::tempdir().unwrap();
        let bin = dir.path();
        std::fs::write(bin.join(exe("pdflatex")), "").unwrap();
        let tools = Toolchains { pdflatex: Some(bin.join(exe("pdflatex"))), distribution: Some("MiKTeX".into()), ..Default::default() };
        assert_eq!(Manager::for_tools(&tools, Some(Compiler::Latexmk)), Some(Manager::Miktex));
        assert_eq!(Manager::for_tools(&tools, Some(Compiler::Tectonic)), None);
        assert_eq!(plan(&tools, Manager::Miktex, "cm-super"), None);
        std::fs::write(bin.join(exe("mpm")), "").unwrap();
        let p = plan(&tools, Manager::Miktex, "cm-super").unwrap();
        assert_eq!(p.args, ["--install=cm-super"]);
        std::fs::write(bin.join(exe("miktex")), "").unwrap();
        let p = plan(&tools, Manager::Miktex, "cm-super").unwrap();
        assert!(inside(&p.program, bin));
        assert_eq!(p.args, ["packages", "install", "cm-super"]);
        // A bad name never gets a plan, so it can never reach the tool.
        assert_eq!(plan(&tools, Manager::Miktex, "--admin"), None);
        std::fs::write(bin.join("tlmgr"), "").unwrap();
        assert_eq!(plan(&tools, Manager::Texlive, "lm").unwrap().args, ["install", "lm"]);
    }

    #[test]
    fn explains_failures_in_plain_words() {
        let m = outcome_message(Manager::Texlive, "cm-super", false, false, "tlmgr: You don't have permission to change the installation in any way");
        assert!(m.contains("administrator") && m.contains("sudo tlmgr install cm-super"), "{m}");
        let m = outcome_message(Manager::Miktex, "x", false, false, "Sorry, but: Access is denied.");
        assert!(m.contains("MiKTeX Console as administrator"), "{m}");
        let m = outcome_message(Manager::Miktex, "nopkg", false, false, "Sorry, but: The requested package is unknown.");
        assert!(m.contains("doesn't have a package called \"nopkg\""), "{m}");
        let m = outcome_message(Manager::Texlive, "cm-super", false, false, "(running on Debian, switching to user mode!)\ntlmgr: user mode not initialized");
        assert!(m.contains("sudo apt install cm-super"), "{m}");
        assert!(outcome_message(Manager::Miktex, "x", false, true, "").contains("took longer"));
        assert!(outcome_message(Manager::Miktex, "x", true, false, "").starts_with("Installed"));
    }

    #[test]
    fn streams_output_and_reports_failure() {
        // A program that surely exists and fails: `cmd /C exit 3` style
        // commands need a shell, so use a missing program instead.
        let plan = Plan { program: PathBuf::from("definitely-not-a-real-program-texo"), args: vec!["install".into(), "x".into()] };
        let seen = std::sync::Mutex::new(Vec::new());
        let out = run(&plan, Manager::Texlive, "x", Duration::from_secs(5), &|l| seen.lock().unwrap().extend(l));
        assert!(!out.ok);
        assert!(out.message.contains("couldn't start"), "{}", out.message);
        assert_eq!(seen.lock().unwrap()[0], "$ definitely-not-a-real-program-texo install x");
    }

    /// A tool that starts a child of its own (like tlmgr.bat → perl) and
    /// stalls: the timeout must stop both and return, not wait on the pipes.
    #[test]
    fn a_stalled_install_with_a_child_process_still_returns() {
        #[cfg(windows)]
        let plan = Plan {
            program: PathBuf::from(std::env::var("COMSPEC").unwrap_or_else(|_| r"C:\Windows\System32\cmd.exe".into())),
            args: vec!["/C".into(), "ping -n 60 127.0.0.1".into()],
        };
        #[cfg(not(windows))]
        let plan = Plan { program: PathBuf::from("/bin/sh"), args: vec!["-c".into(), "sleep 60; true".into()] };
        let started = Instant::now();
        let out = run(&plan, Manager::Texlive, "x", Duration::from_secs(1), &|_| {});
        assert!(started.elapsed() < Duration::from_secs(20), "took {:?}", started.elapsed());
        assert!(!out.ok);
        assert!(out.message.contains("took longer"), "{}", out.message);
    }

    #[test]
    fn tail_keeps_the_end() {
        assert_eq!(tail("abc", 10), "abc");
        assert!(tail(&"é".repeat(100), 11).starts_with("[...]\n"));
    }
}
