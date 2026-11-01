//! Compiles a project's main document to PDF with whatever TeX toolchain is
//! available, streams the console output to the UI, and turns the logs into
//! issues.
//!
//! Toolchains, in the order "Automatic" tries them:
//! - **latexmk** (MiKTeX or TeX Live): runs the engine, BibTeX/Biber, and
//!   reruns as needed, and honours a project's `.latexmkrc`.
//! - **direct**: the engine itself, plus BibTeX/Biber and reruns. For MiKTeX
//!   installs without Perl, which latexmk needs.
//! - **Tectonic**: a self-contained XeTeX-based engine that fetches packages
//!   on demand.
//!
//! Build output goes to `.texo/build/` so the project folder stays clean.

use std::collections::HashMap;
use std::io::{BufRead, BufReader, Read};
use std::path::{Component, Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};

use crate::project::{Engine, META_DIR};
use crate::texlog::{self, Issue};

pub const OUTPUT_EVENT: &str = "compile-output";
const BUILD_DIR: &str = "build";

/// The folder build output goes to.
pub fn build_dir(root: &Path) -> PathBuf {
    root.join(META_DIR).join(BUILD_DIR)
}
const TIMEOUT: Duration = Duration::from_secs(240);
/// Tectonic downloads the packages a document needs the first time they're
/// used (about 90 MB for a typical paper), which can take a long while on a
/// slow connection. Later runs use its cache and finish in seconds.
const TECTONIC_TIMEOUT: Duration = Duration::from_secs(30 * 60);

fn timeout_for(compiler: Compiler) -> Duration {
    if compiler == Compiler::Tectonic {
        TECTONIC_TIMEOUT
    } else {
        TIMEOUT
    }
}
const MAX_LOG_BYTES: usize = 2 * 1024 * 1024;

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// Which toolchain to use; stored in app settings.
#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Compiler {
    #[default]
    Auto,
    Latexmk,
    Direct,
    Tectonic,
}

/// TeX programs found on this machine.
#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Toolchains {
    pub latexmk: Option<PathBuf>,
    pub perl: Option<PathBuf>,
    pub pdflatex: Option<PathBuf>,
    pub xelatex: Option<PathBuf>,
    pub lualatex: Option<PathBuf>,
    pub bibtex: Option<PathBuf>,
    pub biber: Option<PathBuf>,
    pub makeindex: Option<PathBuf>,
    pub kpsewhich: Option<PathBuf>,
    pub tectonic: Option<PathBuf>,
    /// "MiKTeX", "TeX Live", or None.
    pub distribution: Option<String>,
    /// The Tectonic that ships with Texo is the one in use.
    pub tectonic_bundled: bool,
}

fn exe(name: &str) -> String {
    if cfg!(windows) {
        format!("{name}.exe")
    } else {
        name.to_string()
    }
}

/// Folders to search besides PATH: apps started from the Start menu may not
/// see a PATH change made after login.
/// Folder of the running app. Tauri installs bundled programs (Texo's own
/// Tectonic) right next to the app's executable.
pub fn app_dir() -> Option<PathBuf> {
    std::env::current_exe().ok()?.parent().map(Path::to_path_buf)
}

fn extra_dirs(tools_dir: &Path) -> Vec<PathBuf> {
    let mut dirs = vec![tools_dir.to_path_buf()];
    // TeX Live on Linux: /usr/local/texlive/<year>/bin/x86_64-linux.
    #[cfg(target_os = "linux")]
    if let Ok(entries) = std::fs::read_dir("/usr/local/texlive") {
        let mut years: Vec<PathBuf> = entries.filter_map(Result::ok).map(|e| e.path()).collect();
        years.sort();
        for year in years.into_iter().rev() {
            dirs.push(year.join("bin/x86_64-linux"));
        }
    }
    if let Some(local) = std::env::var_os("LOCALAPPDATA") {
        dirs.push(PathBuf::from(local).join("Programs/MiKTeX/miktex/bin/x64"));
    }
    for base in ["C:/Program Files/MiKTeX/miktex/bin/x64", "C:/Program Files (x86)/MiKTeX/miktex/bin"] {
        dirs.push(PathBuf::from(base));
    }
    // TeX Live installs to C:\texlive\<year>\bin\windows (or win32 before 2023).
    if let Ok(entries) = std::fs::read_dir("C:/texlive") {
        let mut years: Vec<PathBuf> = entries.filter_map(Result::ok).map(|e| e.path()).collect();
        years.sort();
        for year in years.into_iter().rev() {
            dirs.push(year.join("bin/windows"));
            dirs.push(year.join("bin/win64"));
            dirs.push(year.join("bin/win32"));
        }
    }
    dirs
}

fn find(name: &str, dirs: &[PathBuf]) -> Option<PathBuf> {
    let file = exe(name);
    std::env::var_os("PATH")
        .map(|p| std::env::split_paths(&p).collect::<Vec<_>>())
        .unwrap_or_default()
        .iter()
        .chain(dirs)
        .map(|d| d.join(&file))
        .find(|p| p.is_file())
}

pub fn detect(tools_dir: &Path) -> Toolchains {
    let dirs = extra_dirs(tools_dir);
    // Prefer Texo's own copy of Tectonic over one found on PATH: it's the
    // version Texo is tested with.
    let bundled = app_dir().map(|d| d.join(exe("tectonic"))).filter(|p| p.is_file());
    let pdflatex = find("pdflatex", &dirs);
    let distribution = pdflatex.as_ref().map(|p| {
        let s = p.to_string_lossy().to_lowercase();
        if s.contains("miktex") {
            "MiKTeX".to_string()
        } else if s.contains("texlive") {
            "TeX Live".to_string()
        } else {
            "TeX".to_string()
        }
    });
    Toolchains {
        latexmk: find("latexmk", &dirs),
        perl: find("perl", &dirs),
        pdflatex,
        xelatex: find("xelatex", &dirs),
        lualatex: find("lualatex", &dirs),
        bibtex: find("bibtex", &dirs),
        biber: find("biber", &dirs),
        makeindex: find("makeindex", &dirs),
        kpsewhich: find("kpsewhich", &dirs),
        tectonic: bundled.clone().or_else(|| find("tectonic", &dirs)),
        tectonic_bundled: bundled.is_some(),
        distribution,
    }
}

impl Toolchains {
    fn engine(&self, engine: Engine) -> Option<&PathBuf> {
        match engine {
            Engine::Pdflatex => self.pdflatex.as_ref(),
            Engine::Xelatex => self.xelatex.as_ref(),
            Engine::Lualatex => self.lualatex.as_ref(),
        }
    }

    /// latexmk is a Perl script; MiKTeX's wrapper fails without Perl.
    fn latexmk_usable(&self) -> bool {
        self.latexmk.is_some() && (self.perl.is_some() || self.distribution.as_deref() == Some("TeX Live"))
    }

    /// The toolchain to run, or None if nothing suitable is installed.
    pub fn choose(&self, pref: Compiler, engine: Engine) -> Option<Compiler> {
        let has_engine = self.engine(engine).is_some();
        match pref {
            Compiler::Latexmk => self.latexmk_usable().then_some(Compiler::Latexmk),
            Compiler::Direct => has_engine.then_some(Compiler::Direct),
            Compiler::Tectonic => self.tectonic.is_some().then_some(Compiler::Tectonic),
            Compiler::Auto => {
                if self.latexmk_usable() && has_engine {
                    Some(Compiler::Latexmk)
                } else if has_engine {
                    Some(Compiler::Direct)
                } else if self.tectonic.is_some() {
                    Some(Compiler::Tectonic)
                } else {
                    None
                }
            }
        }
    }
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum Status {
    Success,
    /// TeX reported errors; a PDF may still have been produced.
    Failed,
    Aborted,
    Timeout,
    NoEngine,
    NoMainDocument,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CompileResult {
    pub status: Status,
    pub compiler: Option<Compiler>,
    pub engine: Engine,
    /// Absolute path of the PDF, when this run produced one.
    pub pdf_path: Option<String>,
    pub duration_ms: u64,
    pub issues: Vec<Issue>,
    pub hints: Vec<String>,
    /// The main TeX log (truncated).
    pub log: String,
    /// Everything the tools printed to the console.
    pub output: String,
    /// The project has a latexmkrc that was skipped because the project isn't trusted.
    pub rc_ignored: bool,
    /// Where the PDF was saved in the project folder (successful compiles only).
    pub saved_pdf: Option<String>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OutputChunk {
    pub project: String,
    pub lines: Vec<String>,
}

/// Cancel flags for running compiles, keyed by project folder.
#[derive(Default)]
pub struct Running(pub Mutex<HashMap<String, Arc<AtomicBool>>>);

pub struct Job<'a> {
    pub root: &'a Path,
    pub main: &'a str,
    pub engine: Engine,
    pub compiler: Compiler,
    pub tools: &'a Toolchains,
    pub cancel: Arc<AtomicBool>,
    /// Whether the user trusts this project to run its own latexmk config.
    pub trusted: bool,
    /// Receives console output in batches as the tools run.
    pub on_output: &'a (dyn Fn(Vec<String>) + Sync),
}

enum RunEnd {
    /// Success is judged from the logs and PDF, not the exit code:
    /// latexmk -f exits non-zero for warnings it considers fatal.
    Exited,
    Aborted,
    Timeout,
}

/// Kills a process and everything it started (latexmk → perl → pdflatex).
#[cfg(windows)]
fn kill_tree(pid: u32) {
    use std::os::windows::process::CommandExt;
    let _ = Command::new("taskkill")
        .args(["/PID", &pid.to_string(), "/T", "/F"])
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .creation_flags(CREATE_NO_WINDOW)
        .status();
}

/// Each tool runs in its own process group (see `run`), so killing the group
/// stops everything it started.
#[cfg(not(windows))]
fn kill_tree(pid: u32) {
    let _ = Command::new("kill")
        .args(["-KILL", &format!("-{pid}")])
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status();
}

fn run(
    program: &Path,
    args: &[String],
    cwd: &Path,
    env: &[(&str, String)],
    job: &Job,
    deadline: Instant,
    output: &mut Vec<String>,
) -> std::io::Result<RunEnd> {
    let mut cmd = Command::new(program);
    cmd.args(args)
        .current_dir(cwd)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    for (k, v) in env {
        cmd.env(k, v);
    }
    // Extra layer: tools that start programs through cmd.exe won't look in
    // the current folder (the project). Native Perl ignores this, which is
    // why latexmk is also given absolute tool paths.
    cmd.env("NoDefaultCurrentDirectoryInExePath", "1");
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        cmd.process_group(0);
    }
    let echo = format!("$ {} {}", program.file_name().unwrap_or_default().to_string_lossy(), args.join(" "));
    output.push(echo.clone());
    (job.on_output)(vec![echo]);

    let mut child = cmd.spawn()?;
    let (tx, rx) = mpsc::channel::<String>();
    let pipe = |stream: Box<dyn Read + Send>, tx: mpsc::Sender<String>| {
        std::thread::spawn(move || {
            // TeX output isn't always valid UTF-8; read bytes and convert lossily.
            let mut reader = BufReader::new(stream);
            let mut buf = Vec::new();
            while reader.read_until(b'\n', &mut buf).unwrap_or(0) > 0 {
                let line = String::from_utf8_lossy(&buf).trim_end().to_string();
                if tx.send(line).is_err() {
                    break;
                }
                buf.clear();
            }
        })
    };
    let out_thread = pipe(Box::new(child.stdout.take().expect("piped")), tx.clone());
    let err_thread = pipe(Box::new(child.stderr.take().expect("piped")), tx);

    let end = loop {
        let batch: Vec<String> = rx.try_iter().collect();
        if !batch.is_empty() {
            output.extend(batch.iter().cloned());
            (job.on_output)(batch);
        }
        if child.try_wait()?.is_some() {
            break RunEnd::Exited;
        }
        if job.cancel.load(Ordering::SeqCst) {
            kill_tree(child.id());
            let _ = child.wait();
            break RunEnd::Aborted;
        }
        if Instant::now() > deadline {
            kill_tree(child.id());
            let _ = child.wait();
            break RunEnd::Timeout;
        }
        std::thread::sleep(Duration::from_millis(60));
    };
    let _ = out_thread.join();
    let _ = err_thread.join();
    let rest: Vec<String> = rx.try_iter().collect();
    if !rest.is_empty() {
        output.extend(rest.iter().cloned());
        (job.on_output)(rest);
    }
    Ok(end)
}

/// latexmk config files it reads from the folder it runs in. They contain
/// Perl code, so they only run for projects the user trusts.
const PROJECT_RC_NAMES: &[&str] = &["latexmkrc", ".latexmkrc"];

/// The user's own latexmk config, which stays in effect for untrusted projects.
fn user_latexmkrc() -> Option<PathBuf> {
    let home = std::env::var_os("USERPROFILE").or_else(|| std::env::var_os("HOME"))?;
    let home = PathBuf::from(home);
    [home.join(".latexmkrc"), home.join(".config/latexmk/latexmkrc")]
        .into_iter()
        .find(|p| p.is_file())
}

/// A file name that starts with `-` would be read as an option; `./` avoids that.
fn safe_file_arg(name: &str) -> String {
    if name.starts_with('-') {
        format!("./{name}")
    } else {
        name.to_string()
    }
}

/// A program path for a latexmk command string: forward slashes, quoted.
fn quoted_tool(path: &Path) -> String {
    format!("\"{}\"", path.to_string_lossy().replace('\\', "/"))
}

fn latexmk_args(
    engine: Engine,
    build: &str,
    main_file: &str,
    trusted: bool,
    user_rc: Option<&Path>,
    tools: &Toolchains,
) -> Vec<String> {
    let mut args = Vec::new();
    if !trusted {
        // `-norc` skips every rc file, including the project's; add the user's back.
        args.push("-norc".to_string());
        if let Some(rc) = user_rc {
            args.push("-r".to_string());
            args.push(rc.to_string_lossy().into_owned());
        }
    }
    // latexmk starts these tools by bare name, and Windows looks in the
    // current folder (the project) first, so a project could ship its own
    // `pdflatex.exe`. Give latexmk the absolute paths instead.
    let no_shell = if trusted { "" } else { " -no-shell-escape" };
    if let Some(path) = tools.engine(engine) {
        let option = match engine {
            Engine::Pdflatex => "pdflatex",
            Engine::Xelatex => "xelatex",
            Engine::Lualatex => "lualatex",
        };
        args.push(format!("-{option}={}{no_shell} %O %S", quoted_tool(path)));
    }
    let helpers = [
        ("bibtex", &tools.bibtex, "%O %S"),
        ("biber", &tools.biber, "%O %S"),
        ("makeindex", &tools.makeindex, "%O -o %D %S"),
        ("kpsewhich", &tools.kpsewhich, "%S"),
    ];
    for (var, path, rest) in helpers {
        // Set through Perl's q{…}; a path with braces can't be quoted that way.
        if let Some(path) = path.as_ref().filter(|p| !p.to_string_lossy().contains(['{', '}'])) {
            args.push("-e".to_string());
            args.push(format!("${var}=q{{{} {rest}}}", quoted_tool(path)));
        }
    }
    args.extend([
        engine_flag(engine).to_string(),
        "-f".to_string(),
        "-interaction=nonstopmode".to_string(),
        "-file-line-error".to_string(),
        "-synctex=1".to_string(),
        format!("-outdir={build}"),
        main_file.to_string(),
    ]);
    args
}

fn engine_flag(engine: Engine) -> &'static str {
    match engine {
        Engine::Pdflatex => "-pdf",
        Engine::Xelatex => "-xelatex",
        Engine::Lualatex => "-lualatex",
    }
}

fn read_lossy(path: &Path) -> Option<String> {
    std::fs::read(path).ok().map(|b| String::from_utf8_lossy(&b).into_owned())
}

/// Maps a path from a log (relative to the main file's folder, or absolute)
/// to a project-relative path; None for files outside the project, such as
/// classes from the TeX distribution.
pub fn project_relative(root: &Path, main_dir: &Path, logged: &str) -> Option<String> {
    let p = Path::new(logged);
    let joined = if p.is_absolute() { p.to_path_buf() } else { main_dir.join(p) };
    // Resolve `.` and `..` without touching the disk.
    let mut parts: Vec<Component> = Vec::new();
    for c in joined.components() {
        match c {
            Component::CurDir => {}
            Component::ParentDir => {
                parts.pop();
            }
            other => parts.push(other),
        }
    }
    let normal: PathBuf = parts.iter().collect();
    let norm = |p: &Path| p.to_string_lossy().replace('\\', "/").to_lowercase();
    let (n, r) = (norm(&normal), norm(root));
    let rel = n.strip_prefix(&r)?.trim_start_matches('/');
    // Build output (e.g. `.texo/build/main.bbl`) isn't something to open.
    if rel.is_empty() || rel == META_DIR || rel.starts_with(&format!("{META_DIR}/")) {
        return None;
    }
    // Return the original casing from the normalised path.
    let original = normal.to_string_lossy().replace('\\', "/");
    Some(original[original.len() - rel.len()..].to_string())
}

pub fn compile(job: &Job) -> CompileResult {
    let started = Instant::now();
    let timeout = timeout_for(job.compiler);
    let deadline = started + timeout;
    let mut output: Vec<String> = Vec::new();
    let mut result = CompileResult {
        status: Status::Failed,
        compiler: Some(job.compiler),
        engine: job.engine,
        pdf_path: None,
        duration_ms: 0,
        issues: Vec::new(),
        hints: Vec::new(),
        log: String::new(),
        output: String::new(),
        rc_ignored: false,
        saved_pdf: None,
    };

    let main_path = job.root.join(job.main);
    if !main_path.is_file() {
        result.status = Status::NoMainDocument;
        return result;
    }
    let main_dir = main_path.parent().unwrap_or(job.root).to_path_buf();
    let main_file = safe_file_arg(&main_path.file_name().unwrap_or_default().to_string_lossy());
    let stem = main_path.file_stem().unwrap_or_default().to_string_lossy().into_owned();
    result.rc_ignored = !job.trusted
        && job.compiler == Compiler::Latexmk
        && PROJECT_RC_NAMES.iter().any(|n| main_dir.join(n).is_file());
    // A real folder inside the project, with no planted links for TeX to
    // write through.
    let build = match crate::project::meta_subdir(job.root, Some(BUILD_DIR))
        .and_then(|b| crate::project::remove_links(&b).map(|()| b))
    {
        Ok(b) => b,
        Err(e) => {
            result.output = format!("Couldn't prepare the build folder: {e}");
            return result;
        }
    };
    let build_str = build.to_string_lossy().into_owned();
    let mut common = vec![
        "-interaction=nonstopmode".to_string(),
        "-file-line-error".to_string(),
        "-synctex=1".to_string(),
    ];
    if !job.trusted {
        // Even TeX's restricted shell escape runs tools such as bibtex by name.
        common.push("-no-shell-escape".to_string());
    }

    let finish = |end: RunEnd, output: &mut Vec<String>, result: &mut CompileResult| -> bool {
        match end {
            RunEnd::Exited => true,
            RunEnd::Aborted => {
                result.status = Status::Aborted;
                output.push("Compile stopped.".into());
                false
            }
            RunEnd::Timeout => {
                result.status = Status::Timeout;
                output.push(format!("Compile took longer than {} seconds and was stopped.", timeout.as_secs()));
                false
            }
        }
    };

    // BibTeX runs inside the build folder, so point it back at the sources.
    // The trailing `;` keeps the distribution's default search path too.
    let search = format!("{};", main_dir.to_string_lossy());
    let bib_env = [("BIBINPUTS", search.clone()), ("BSTINPUTS", search.clone())];

    let ran = (|| -> std::io::Result<bool> {
        match job.compiler {
            Compiler::Latexmk => {
                let args = latexmk_args(job.engine, &build_str, &main_file, job.trusted, user_latexmkrc().as_deref(), job.tools);
                let latexmk = job.tools.latexmk.as_ref().expect("checked by choose");
                let end = run(latexmk, &args, &main_dir, &bib_env, job, deadline, &mut output)?;
                Ok(finish(end, &mut output, &mut result))
            }
            Compiler::Tectonic => {
                let mut args = vec![
                    main_file.clone(),
                    "--outdir".into(),
                    build_str.clone(),
                    "--synctex".into(),
                    "--keep-logs".into(),
                    "--keep-intermediates".into(),
                ];
                if !job.trusted {
                    // Disables features that could run programs or read outside the project.
                    args.push("--untrusted".into());
                }
                let tectonic = job.tools.tectonic.as_ref().expect("checked by choose");
                let end = run(tectonic, &args, &main_dir, &[], job, deadline, &mut output)?;
                Ok(finish(end, &mut output, &mut result))
            }
            Compiler::Direct | Compiler::Auto => {
                let engine = job.tools.engine(job.engine).expect("checked by choose").clone();
                let mut args = common.clone();
                args.push(format!("-output-directory={build_str}"));
                args.push(main_file.clone());
                let pass = |output: &mut Vec<String>| run(&engine, &args, &main_dir, &[], job, deadline, output);

                let end = pass(&mut output)?;
                if !finish(end, &mut output, &mut result) {
                    return Ok(false);
                }
                // Bibliography: Biber if biblatex wrote a .bcf, else BibTeX if the .aux asks for it.
                let aux = read_lossy(&build.join(format!("{stem}.aux"))).unwrap_or_default();
                let mut bib_ran = false;
                if build.join(format!("{stem}.bcf")).is_file() {
                    if let Some(biber) = &job.tools.biber {
                        let args = vec![format!("--input-directory={}", main_dir.to_string_lossy()), format!("--output-directory={build_str}"), stem.clone()];
                        let end = run(biber, &args, &build, &[], job, deadline, &mut output)?;
                        if !finish(end, &mut output, &mut result) {
                            return Ok(false);
                        }
                        bib_ran = true;
                    }
                } else if aux.contains("\\bibdata") {
                    if let Some(bibtex) = &job.tools.bibtex {
                        let end = run(bibtex, std::slice::from_ref(&stem), &build, &bib_env, job, deadline, &mut output)?;
                        if !finish(end, &mut output, &mut result) {
                            return Ok(false);
                        }
                        bib_ran = true;
                    }
                }
                // Rerun until references settle, at most twice more.
                for _ in 0..2 {
                    let log = read_lossy(&build.join(format!("{stem}.log"))).unwrap_or_default();
                    let wants_rerun = log.contains("Rerun to get") || log.contains("Label(s) may have changed") || log.contains("Please rerun LaTeX");
                    if !bib_ran && !wants_rerun {
                        break;
                    }
                    bib_ran = false;
                    let end = pass(&mut output)?;
                    if !finish(end, &mut output, &mut result) {
                        return Ok(false);
                    }
                }
                Ok(true)
            }
        }
    })();

    let completed = match ran {
        Ok(done) => done,
        Err(e) => {
            output.push(format!("Couldn't start the compiler: {e}"));
            false
        }
    };

    // Collect logs and issues even after a failed or stopped run.
    let log = read_lossy(&build.join(format!("{stem}.log"))).unwrap_or_default();
    let mut issues = texlog::parse_tex_log(&log);
    if let Some(blg) = read_lossy(&build.join(format!("{stem}.blg"))) {
        issues.extend(if blg.contains("Biber") { texlog::parse_biber_log(&blg) } else { texlog::parse_bibtex_log(&blg) });
    }
    for issue in &mut issues {
        issue.file = issue.file.as_deref().and_then(|f| project_relative(job.root, &main_dir, f));
    }
    result.hints = texlog::hints(&log, &issues);
    result.issues = issues;

    // latexmk skips work when the PDF is already up to date, so an existing
    // PDF counts even if this run didn't rewrite it.
    let pdf = build.join(format!("{stem}.pdf"));
    if pdf.is_file() {
        result.pdf_path = Some(pdf.to_string_lossy().into_owned());
    }
    if completed {
        let has_errors = result.issues.iter().any(|i| i.severity == texlog::Severity::Error);
        result.status = if result.pdf_path.is_some() && !has_errors { Status::Success } else { Status::Failed };
    }
    result.log = if log.len() > MAX_LOG_BYTES {
        let mut cut = log.len() - MAX_LOG_BYTES;
        while !log.is_char_boundary(cut) {
            cut += 1;
        }
        format!("[log truncated]\n{}", &log[cut..])
    } else {
        log
    };
    result.output = output.join("\n");
    result.duration_ms = started.elapsed().as_millis() as u64;
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn untrusted_projects_skip_their_latexmkrc() {
        let tools = Toolchains::default();
        let trusted = latexmk_args(Engine::Pdflatex, "B", "main.tex", true, None, &tools);
        assert!(!trusted.contains(&"-norc".to_string()));
        let rc = PathBuf::from("C:/Users/me/.latexmkrc");
        let untrusted = latexmk_args(Engine::Xelatex, "B", "main.tex", false, Some(&rc), &tools);
        assert_eq!(&untrusted[..4], ["-norc", "-r", "C:/Users/me/.latexmkrc", "-xelatex"]);
        assert_eq!(untrusted.last().map(String::as_str), Some("main.tex"));
    }

    #[test]
    fn latexmk_gets_absolute_tool_paths() {
        let tools = Toolchains {
            pdflatex: Some(PathBuf::from(r"C:\Program Files\MiKTeX\bin\pdflatex.exe")),
            bibtex: Some(PathBuf::from(r"C:\MiKTeX\bibtex.exe")),
            makeindex: Some(PathBuf::from(r"C:\Odd{dir}\makeindex.exe")),
            ..Default::default()
        };
        let untrusted = latexmk_args(Engine::Pdflatex, "B", "main.tex", false, None, &tools);
        assert!(untrusted.contains(
            &r#"-pdflatex="C:/Program Files/MiKTeX/bin/pdflatex.exe" -no-shell-escape %O %S"#.to_string()
        ));
        assert!(untrusted.contains(&r#"$bibtex=q{"C:/MiKTeX/bibtex.exe" %O %S}"#.to_string()));
        // A path that can't be quoted safely is left out rather than mangled.
        assert!(!untrusted.iter().any(|a| a.contains("makeindex")));
        let trusted = latexmk_args(Engine::Pdflatex, "B", "main.tex", true, None, &tools);
        assert!(trusted.iter().any(|a| a.starts_with("-pdflatex=") && !a.contains("no-shell-escape")));
    }

    #[test]
    fn option_like_file_names_are_made_safe() {
        assert_eq!(safe_file_arg("-shell-escape.tex"), "./-shell-escape.tex");
        assert_eq!(safe_file_arg("main.tex"), "main.tex");
    }

    #[cfg(windows)]
    #[test]
    fn maps_log_paths_into_the_project() {
        let root = Path::new("C:\\Users\\me\\Texo\\Paper");
        let main_dir = root.join("src");
        assert_eq!(project_relative(root, &main_dir, "./intro.tex").as_deref(), Some("src/intro.tex"));
        assert_eq!(project_relative(root, &main_dir, "../refs.bib").as_deref(), Some("refs.bib"));
        assert_eq!(project_relative(root, root, "main.tex").as_deref(), Some("main.tex"));
        assert_eq!(project_relative(root, root, "C:/Users/me/Texo/Paper/a/b.tex").as_deref(), Some("a/b.tex"));
        assert_eq!(project_relative(root, root, "C:\\MiKTeX\\tex\\latex\\base\\article.cls"), None);
        assert_eq!(project_relative(root, root, "./.texo/build/main.bbl"), None);
    }

    fn tools(latexmk: bool, perl: bool, pdflatex: bool, tectonic: bool) -> Toolchains {
        let p = |b: bool| b.then(|| PathBuf::from("x.exe"));
        Toolchains {
            latexmk: p(latexmk),
            perl: p(perl),
            pdflatex: p(pdflatex),
            tectonic: p(tectonic),
            distribution: pdflatex.then(|| "MiKTeX".to_string()),
            ..Default::default()
        }
    }

    #[test]
    fn automatic_choice_prefers_latexmk_then_direct_then_tectonic() {
        assert_eq!(tools(true, true, true, true).choose(Compiler::Auto, Engine::Pdflatex), Some(Compiler::Latexmk));
        // MiKTeX without Perl: latexmk can't run, so use the engine directly.
        assert_eq!(tools(true, false, true, false).choose(Compiler::Auto, Engine::Pdflatex), Some(Compiler::Direct));
        assert_eq!(tools(false, false, false, true).choose(Compiler::Auto, Engine::Pdflatex), Some(Compiler::Tectonic));
        assert_eq!(tools(false, false, false, false).choose(Compiler::Auto, Engine::Pdflatex), None);
        // XeLaTeX missing even though pdfLaTeX exists.
        assert_eq!(tools(true, true, true, false).choose(Compiler::Auto, Engine::Xelatex), None);
        assert_eq!(tools(true, true, true, false).choose(Compiler::Tectonic, Engine::Pdflatex), None);
    }

    /// Compiles the example template with the TeX installed on this machine.
    /// Run with `cargo test -- --ignored` on a machine with MiKTeX or TeX Live.
    #[test]
    #[ignore]
    fn compiles_example_with_installed_tex() {
        let tools = detect(Path::new("."));
        for compiler in [Compiler::Latexmk, Compiler::Direct] {
            let Some(compiler) = tools.choose(compiler, Engine::Pdflatex) else {
                eprintln!("skipping {compiler:?}: not installed");
                continue;
            };
            let root = tempfile::tempdir().unwrap();
            let project = crate::project::create(root.path(), "Example", crate::templates::Template::Example).unwrap();
            let dir = PathBuf::from(&project.path);
            let job = Job {
                root: &dir,
                main: "main.tex",
                engine: Engine::Pdflatex,
                compiler,
                tools: &tools,
                cancel: Arc::new(AtomicBool::new(false)),
                trusted: true,
                on_output: &|_| {},
            };
            let result = compile(&job);
            assert_eq!(result.status, Status::Success, "{compiler:?}: {:?}\n{}", result.issues, result.output);
            assert!(result.pdf_path.is_some());
            assert!(dir.join(".texo/build/main.synctex.gz").is_file(), "{compiler:?}: no synctex");
            // The citation resolved, so BibTeX ran and the reruns happened.
            assert!(!result.issues.iter().any(|i| i.message.contains("undefined")), "{compiler:?}: {:?}", result.issues);

            // SyncTeX round trip: the Method heading sits at the 1in margin,
            // and clicking its box leads back to its line.
            let source = std::fs::read_to_string(dir.join("main.tex")).unwrap();
            let heading = source.lines().position(|l| l.starts_with("\\section{Method}")).unwrap() as u32 + 1;
            let st = crate::synctex::SyncTex::load(&dir.join(".texo/build/main.synctex.gz"), |p| {
                project_relative(&dir, &dir, p)
            })
            .unwrap();
            let fwd = st.forward("main.tex", heading).expect("forward search");
            assert_eq!(fwd.page, 1);
            let r = &fwd.rects[0];
            assert!((r.x - 72.0).abs() < 1.0, "{compiler:?}: heading x = {}", r.x);
            let back = st.inverse(fwd.page, r.x + 5.0, r.y + r.height / 2.0).expect("inverse search");
            assert_eq!((back.file.as_str(), back.line), ("main.tex", heading), "{compiler:?}");

            // A broken document fails with an error on the right line.
            std::fs::write(
                dir.join("main.tex"),
                "\\documentclass{article}\n\\begin{document}\nHello \\foo\n\\end{document}\n",
            )
            .unwrap();
            let broken = compile(&job);
            assert_eq!(broken.status, Status::Failed);
            let err = broken.issues.iter().find(|i| i.severity == texlog::Severity::Error).expect("an error");
            assert_eq!((err.file.as_deref(), err.line), (Some("main.tex"), Some(3)), "{compiler:?}");
            assert!(err.message.contains("Undefined control sequence"));
        }
    }

    /// A project's latexmkrc is Perl code: it must not run until the project is trusted.
    #[test]
    #[ignore]
    fn untrusted_latexmkrc_does_not_run() {
        let tools = detect(Path::new("."));
        let Some(compiler) = tools.choose(Compiler::Latexmk, Engine::Pdflatex) else {
            eprintln!("skipping: latexmk not installed");
            return;
        };
        let root = tempfile::tempdir().unwrap();
        let project = crate::project::create(root.path(), "Rc", crate::templates::Template::Blank).unwrap();
        let dir = PathBuf::from(&project.path);
        let marker = dir.join("rc-ran.txt");
        let rc = format!("open(my $f, '>', '{}'); close($f);\n", marker.to_string_lossy().replace('\\', "/"));
        std::fs::write(dir.join(".latexmkrc"), rc).unwrap();

        for trusted in [false, true] {
            let job = Job {
                root: &dir,
                main: "main.tex",
                engine: Engine::Pdflatex,
                compiler,
                tools: &tools,
                cancel: Arc::new(AtomicBool::new(false)),
                trusted,
                on_output: &|_| {},
            };
            let result = compile(&job);
            assert_eq!(result.status, Status::Success, "{}", result.output);
            assert_eq!(result.rc_ignored, !trusted);
            assert_eq!(marker.exists(), trusted, "trusted={trusted}");
        }
    }

    /// Programs a project ships under tool names (`pdflatex.bat`, …) must
    /// never run, trusted or not: tools are always started by absolute path.
    #[test]
    #[ignore]
    fn planted_tool_programs_never_run() {
        let tools = detect(Path::new("."));
        let root = tempfile::tempdir().unwrap();
        let project = crate::project::create(root.path(), "Planted", crate::templates::Template::Example).unwrap();
        let dir = PathBuf::from(&project.path);
        let marker = dir.join("planted-ran.txt");
        // Impostors: scripts, and a harmless real program renamed to each tool.
        // If one ran instead of the real tool, no PDF would be produced.
        let impostor = Path::new(r"C:\Windows\System32\HOSTNAME.EXE");
        for name in ["pdflatex", "bibtex", "biber", "makeindex", "kpsewhich", "perl"] {
            for ext in ["bat", "cmd"] {
                let script = format!("@echo {name} > \"{}\"\r\n", marker.to_string_lossy());
                std::fs::write(dir.join(format!("{name}.{ext}")), script).unwrap();
            }
            if impostor.is_file() {
                std::fs::copy(impostor, dir.join(format!("{name}.exe"))).unwrap();
            }
        }
        for compiler in [Compiler::Latexmk, Compiler::Direct] {
            let Some(compiler) = tools.choose(compiler, Engine::Pdflatex) else { continue };
            for trusted in [false, true] {
                let job = Job {
                    root: &dir,
                    main: "main.tex",
                    engine: Engine::Pdflatex,
                    compiler,
                    tools: &tools,
                    cancel: Arc::new(AtomicBool::new(false)),
                    trusted,
                    on_output: &|_| {},
                };
                let result = compile(&job);
                assert_eq!(result.status, Status::Success, "{compiler:?} trusted={trusted}: {}", result.output);
                assert!(
                    !marker.exists(),
                    "{compiler:?} trusted={trusted} ran {}",
                    std::fs::read_to_string(&marker).unwrap_or_default()
                );
            }
        }
    }

    /// Compiles with the Tectonic that ships with Texo (fetched into
    /// `src-tauri/binaries/` by scripts/fetch-tectonic.mjs). Needs internet
    /// the first time, while Tectonic fills its package cache.
    #[test]
    #[ignore]
    fn compiles_with_bundled_tectonic() {
        let triple = if cfg!(windows) { "x86_64-pc-windows-msvc.exe" } else { "x86_64-unknown-linux-gnu" };
        let exe = Path::new(env!("CARGO_MANIFEST_DIR")).join(format!("binaries/tectonic-{triple}"));
        if !exe.is_file() {
            eprintln!("skipping: run `pnpm fetch-engine` first");
            return;
        }
        let tools = Toolchains { tectonic: Some(exe), tectonic_bundled: true, ..Default::default() };
        assert_eq!(tools.choose(Compiler::Auto, Engine::Pdflatex), Some(Compiler::Tectonic));

        let root = tempfile::tempdir().unwrap();
        let project = crate::project::create(root.path(), "Bundled", crate::templates::Template::Example).unwrap();
        let dir = PathBuf::from(&project.path);
        let job = Job {
            root: &dir,
            main: "main.tex",
            engine: Engine::Pdflatex,
            compiler: Compiler::Tectonic,
            tools: &tools,
            cancel: Arc::new(AtomicBool::new(false)),
            trusted: false,
            on_output: &|_| {},
        };
        let result = compile(&job);
        assert_eq!(result.status, Status::Success, "{:?}\n{}", result.issues, result.output);
        assert!(result.output.contains("--untrusted"), "untrusted projects run Tectonic in untrusted mode");
        assert!(dir.join(".texo/build/main.synctex.gz").is_file());
        assert!(!result.issues.iter().any(|i| i.message.contains("undefined")), "{:?}", result.issues);

        std::fs::write(
            dir.join("main.tex"),
            "\\documentclass{article}\n\\begin{document}\nHello \\foo\n\\end{document}\n",
        )
        .unwrap();
        let broken = compile(&job);
        assert_eq!(broken.status, Status::Failed);
        let err = broken.issues.iter().find(|i| i.severity == texlog::Severity::Error).expect("an error");
        assert_eq!((err.file.as_deref(), err.line), (Some("main.tex"), Some(3)), "{:?}", broken.issues);
    }
}
