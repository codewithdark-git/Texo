//! Installs a TeX package the AI suggested, after the user confirmed it in
//! the UI: `miktex packages install <name>` for MiKTeX, `tlmgr install
//! <name>` for TeX Live. The package name is checked first, and is passed as
//! a single argument (never through a shell).

use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::mpsc;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};

use super::error::{AiError, AiResult, Kind};
use super::validate::valid_package;
use crate::compile::Toolchains;

const TIMEOUT: Duration = Duration::from_secs(15 * 60);
const MAX_OUTPUT: usize = 6_000;
/// How long to wait for the rest of the output once the tool has exited.
const DRAIN_WAIT_DONE: Duration = Duration::from_secs(30);
/// The same after the tool was stopped (its pipes may never close).
const DRAIN_WAIT_KILLED: Duration = Duration::from_secs(3);

/// Reads a pipe to the end on its own thread; the text arrives on the
/// receiver.
fn drain(pipe: Option<impl Read + Send + 'static>) -> mpsc::Receiver<String> {
    let (tx, rx) = mpsc::channel();
    std::thread::spawn(move || {
        let mut bytes = Vec::new();
        if let Some(mut p) = pipe {
            let _ = p.read_to_end(&mut bytes);
        }
        let _ = tx.send(String::from_utf8_lossy(&bytes).into_owned());
    });
    rx
}

/// The reader's text, or nothing if it doesn't finish within `wait` (the
/// thread is left to end on its own).
fn collect(rx: &mpsc::Receiver<String>, wait: Duration) -> String {
    rx.recv_timeout(wait).unwrap_or_default()
}

/// Stops the tool and, on Windows, the processes it started (`tlmgr.bat`
/// runs perl through cmd.exe, and killing cmd.exe alone leaves perl).
fn kill_tree(child: &mut std::process::Child) {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        let _ = Command::new("taskkill")
            .args(["/T", "/F", "/PID", &child.id().to_string()])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .creation_flags(0x0800_0000)
            .status();
    }
    let _ = child.kill();
    let _ = child.wait();
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Manager {
    Miktex,
    Texlive,
}

impl Manager {
    pub fn parse(s: &str) -> Option<Manager> {
        match s.trim().to_ascii_lowercase().as_str() {
            "miktex" => Some(Manager::Miktex),
            "texlive" | "tex live" | "tlmgr" => Some(Manager::Texlive),
            _ => None,
        }
    }

    /// The manager for the distribution Texo found ("MiKTeX", "TeX Live").
    pub fn for_distribution(dist: Option<&str>) -> Option<Manager> {
        match dist {
            Some("MiKTeX") => Some(Manager::Miktex),
            Some("TeX Live") => Some(Manager::Texlive),
            _ => None,
        }
    }

    /// The command shown to the user before they confirm.
    pub fn command_line(self, package: &str) -> String {
        match self {
            Manager::Miktex => format!("miktex packages install {package}"),
            Manager::Texlive => format!("tlmgr install {package}"),
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InstallResult {
    pub ok: bool,
    /// Plain-words outcome.
    pub message: String,
    /// The end of the tool's output, for the details view.
    pub output: String,
}

fn exe(name: &str) -> String {
    if cfg!(windows) {
        format!("{name}.exe")
    } else {
        name.to_string()
    }
}

/// The package manager next to the TeX programs Texo found.
pub fn find_tool(tools: &Toolchains, manager: Manager) -> Option<PathBuf> {
    let bin = tools.pdflatex.as_ref().or(tools.kpsewhich.as_ref())?.parent()?.to_path_buf();
    let names: &[&str] = match manager {
        Manager::Miktex => &["miktex"],
        Manager::Texlive => &["tlmgr"],
    };
    for name in names {
        for candidate in [bin.join(exe(name)), bin.join(format!("{name}.bat"))] {
            if candidate.is_file() {
                return Some(candidate);
            }
        }
        // `tlmgr` is a script without an extension on Linux and macOS.
        let plain = bin.join(name);
        if plain.is_file() {
            return Some(plain);
        }
    }
    None
}

pub fn install(tool: &Path, manager: Manager, package: &str) -> AiResult<InstallResult> {
    if !valid_package(package) {
        return Err(AiError::invalid("That isn't a valid package name."));
    }
    let mut cmd = Command::new(tool);
    match manager {
        Manager::Miktex => cmd.args(["packages", "install", package]),
        Manager::Texlive => cmd.args(["install", package]),
    };
    cmd.stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    let mut child = cmd
        .spawn()
        .map_err(|_| AiError::new(Kind::Other, "Texo couldn't start the package manager."))?;
    // One reader per pipe, so a full stderr pipe can't stall the tool.
    let out = drain(child.stdout.take());
    let err = drain(child.stderr.take());
    let start = Instant::now();
    let status = loop {
        if let Some(status) = child.try_wait()? {
            break Some(status);
        }
        if start.elapsed() > TIMEOUT {
            kill_tree(&mut child);
            break None;
        }
        std::thread::sleep(Duration::from_millis(200));
    };
    // After a kill, a grandchild (perl behind tlmgr.bat) may still hold the
    // pipes open, so the readers get a bounded wait instead of a join.
    let wait = if status.is_some() { DRAIN_WAIT_DONE } else { DRAIN_WAIT_KILLED };
    let output = collect(&out, wait) + &collect(&err, wait);
    let tail = tail(&output, MAX_OUTPUT);
    let ok = status.is_some_and(|s| s.success());
    let lower = output.to_ascii_lowercase();
    let message = if ok {
        format!("Installed \"{package}\". Compile again to check.")
    } else if status.is_none() {
        "The installation took too long and was stopped.".to_string()
    } else if lower.contains("permission") || lower.contains("not writable") || lower.contains("administrator") {
        match manager {
            Manager::Texlive => format!(
                "TeX Live needs administrator rights to install packages. Run \"sudo tlmgr install {package}\" \
                 in a terminal, or install your system's TeX Live package that contains it."
            ),
            Manager::Miktex => format!(
                "MiKTeX needs administrator rights here. Open MiKTeX Console as administrator and install \"{package}\"."
            ),
        }
    } else if lower.contains("unknown package") || lower.contains("not found") || lower.contains("unknown") {
        format!("The package manager doesn't know a package called \"{package}\".")
    } else {
        format!("The package manager couldn't install \"{package}\". See the details.")
    };
    Ok(InstallResult { ok, message, output: tail })
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn managers_parse_and_show_their_command() {
        assert_eq!(Manager::parse("MiKTeX"), Some(Manager::Miktex));
        assert_eq!(Manager::parse("texlive"), Some(Manager::Texlive));
        assert_eq!(Manager::parse("apt"), None);
        assert_eq!(Manager::Miktex.command_line("cm-super"), "miktex packages install cm-super");
        assert_eq!(Manager::Texlive.command_line("cm-super"), "tlmgr install cm-super");
        assert_eq!(Manager::for_distribution(Some("TeX Live")), Some(Manager::Texlive));
        assert_eq!(Manager::for_distribution(None), None);
    }

    #[test]
    fn bad_names_never_reach_the_tool() {
        // A tool path that would fail to start if it were ever run.
        let tool = Path::new("definitely-not-a-real-program");
        for bad in ["--admin", "a b", "x;rm -rf /", ""] {
            let err = install(tool, Manager::Miktex, bad).unwrap_err();
            assert_eq!(err.kind, Kind::InvalidInput);
        }
    }

    #[test]
    fn tool_is_found_next_to_pdflatex() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join(exe("pdflatex")), "").unwrap();
        let tools = Toolchains { pdflatex: Some(dir.path().join(exe("pdflatex"))), ..Default::default() };
        assert_eq!(find_tool(&tools, Manager::Miktex), None);
        std::fs::write(dir.path().join(exe("miktex")), "").unwrap();
        assert_eq!(find_tool(&tools, Manager::Miktex), Some(dir.path().join(exe("miktex"))));
        std::fs::write(dir.path().join("tlmgr"), "").unwrap();
        assert!(find_tool(&tools, Manager::Texlive).is_some());
        assert_eq!(find_tool(&Toolchains::default(), Manager::Miktex), None);
    }

    #[test]
    fn a_reader_that_never_finishes_does_not_block() {
        // A pipe still held open by a leftover process: the reader never
        // sends, and collecting gives up after the wait.
        let (_tx, rx) = mpsc::channel::<String>();
        let t = Instant::now();
        assert_eq!(collect(&rx, Duration::from_millis(50)), "");
        assert!(t.elapsed() < Duration::from_secs(2));
        let rx = drain(Some(std::io::Cursor::new(b"done".to_vec())));
        assert_eq!(collect(&rx, Duration::from_secs(5)), "done");
    }

    #[test]
    fn tail_keeps_the_end() {
        assert_eq!(tail("abc", 10), "abc");
        assert!(tail(&"é".repeat(100), 11).starts_with("[...]\n"));
    }
}
