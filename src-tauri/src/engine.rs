//! First-run setup for the LaTeX engine.
//!
//! When no MiKTeX or TeX Live is installed, Texo compiles with the Tectonic
//! binary it ships. Tectonic downloads the LaTeX packages a document needs the
//! first time they're used (about 90 MB for a typical paper), which would make
//! a user's first compile take minutes. So on first launch Texo compiles its
//! example paper in the background to fill the package cache, and remembers
//! that it did.

use std::path::{Path, PathBuf};
use std::sync::atomic::AtomicBool;
use std::sync::Arc;

use serde::Serialize;

use crate::compile::{self, Compiler, Status, Toolchains};
use crate::error::{AppError, AppResult};
use crate::project::{self, Engine};
use crate::templates::Template;

pub const EVENT: &str = "engine-setup";

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EngineStatus {
    /// The toolchain "Automatic" compiles with, or None if there is none.
    pub compiler: Option<Compiler>,
    /// "MiKTeX", "TeX Live", … when one is installed.
    pub distribution: Option<String>,
    /// The engine in use is the Tectonic that ships with Texo.
    pub bundled: bool,
    /// Ready to compile without a long first-time download.
    pub ready: bool,
}

/// Marks a warmed-up Tectonic, tied to the binary so an update warms up again.
fn marker(work_dir: &Path, tools: &Toolchains) -> Option<PathBuf> {
    let exe = tools.tectonic.as_ref()?;
    let meta = std::fs::metadata(exe).ok()?;
    Some(work_dir.join(format!("tectonic-ready-{}", meta.len())))
}

pub fn status(work_dir: &Path, tools: &Toolchains, pref: Compiler) -> EngineStatus {
    let compiler = tools.choose(pref, Engine::Pdflatex);
    let uses_tectonic = compiler == Some(Compiler::Tectonic);
    EngineStatus {
        compiler,
        distribution: tools.distribution.clone(),
        bundled: uses_tectonic && tools.tectonic_bundled,
        ready: !uses_tectonic || marker(work_dir, tools).is_some_and(|m| m.is_file()),
    }
}

/// Compiles the example paper with Tectonic to fill its package cache.
pub fn prepare(work_dir: &Path, tools: &Toolchains, on_output: &(dyn Fn(Vec<String>) + Sync)) -> AppResult<()> {
    let Some(mark) = marker(work_dir, tools) else {
        return Err(AppError::msg("The built-in LaTeX engine is missing. Reinstall Texo to restore it."));
    };
    let projects = work_dir.join("warm-up");
    let _ = std::fs::remove_dir_all(&projects);
    std::fs::create_dir_all(&projects)?;
    let sample = project::create(&projects, "Sample", Template::Example)?;
    let root = PathBuf::from(&sample.path);

    let result = compile::compile(&compile::Job {
        root: &root,
        main: "main.tex",
        engine: Engine::Xelatex,
        compiler: Compiler::Tectonic,
        tools,
        cancel: Arc::new(AtomicBool::new(false)),
        trusted: false,
        on_output,
    });
    let _ = std::fs::remove_dir_all(&projects);
    if result.status != Status::Success {
        return Err(AppError::msg(
            "Setting up the LaTeX engine didn't finish. Check your internet connection; Texo will try again next time.",
        ));
    }
    std::fs::write(mark, "ok")?;
    Ok(())
}
