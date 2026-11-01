use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::compile::Compiler;
use crate::error::AppResult;

/// App-wide settings, stored as JSON in the app config directory.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Settings {
    /// Folder where new projects are created and scanned for.
    pub projects_root: PathBuf,
    /// Project folders opened from outside `projects_root`.
    #[serde(default)]
    pub external_projects: Vec<PathBuf>,
    /// Which TeX toolchain compiles projects.
    #[serde(default)]
    pub compiler: Compiler,
    /// Projects allowed to run their own latexmk config (Perl code).
    #[serde(default)]
    pub trusted_projects: Vec<PathBuf>,
}

impl Settings {
    /// Reads settings from `path`, falling back to defaults when the file is
    /// missing or unreadable.
    pub fn load(path: &Path, default_root: PathBuf) -> Settings {
        std::fs::read_to_string(path)
            .ok()
            .and_then(|text| serde_json::from_str(&text).ok())
            .unwrap_or(Settings {
                projects_root: default_root,
                external_projects: Vec::new(),
                compiler: Compiler::default(),
                trusted_projects: Vec::new(),
            })
    }

    pub fn save(&self, path: &Path) -> AppResult<()> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        std::fs::write(path, serde_json::to_string_pretty(self)?)?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn missing_file_gives_defaults_and_round_trips() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("cfg").join("settings.json");
        let mut s = Settings::load(&path, dir.path().join("Texo"));
        assert_eq!(s.projects_root, dir.path().join("Texo"));
        assert!(s.external_projects.is_empty());

        s.external_projects.push(dir.path().join("elsewhere"));
        s.save(&path).unwrap();
        let again = Settings::load(&path, PathBuf::from("unused"));
        assert_eq!(again.external_projects, s.external_projects);
    }
}
