use serde::Deserialize;

/// Starter content for a new project. Every template has `main.tex` at the
/// top level, which is the document Texo compiles.
#[derive(Debug, Clone, Copy, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Template {
    Blank,
    Example,
    Report,
    Presentation,
    Thesis,
}

impl Template {
    /// Every template, in the order the gallery shows them.
    #[cfg(test)]
    pub const ALL: [Template; 5] = [
        Template::Blank,
        Template::Example,
        Template::Report,
        Template::Presentation,
        Template::Thesis,
    ];

    /// Files as `(relative path, contents)` pairs, with `/` separators.
    pub fn files(self) -> &'static [(&'static str, &'static str)] {
        match self {
            Template::Blank => &[("main.tex", include_str!("../templates/blank/main.tex"))],
            Template::Example => &[
                ("main.tex", include_str!("../templates/example/main.tex")),
                ("references.bib", include_str!("../templates/example/references.bib")),
            ],
            Template::Report => &[
                ("main.tex", include_str!("../templates/report/main.tex")),
                ("references.bib", include_str!("../templates/report/references.bib")),
            ],
            Template::Presentation => &[("main.tex", include_str!("../templates/presentation/main.tex"))],
            Template::Thesis => &[
                ("main.tex", include_str!("../templates/thesis/main.tex")),
                ("frontmatter/abstract.tex", include_str!("../templates/thesis/frontmatter/abstract.tex")),
                (
                    "frontmatter/acknowledgements.tex",
                    include_str!("../templates/thesis/frontmatter/acknowledgements.tex"),
                ),
                ("chapters/introduction.tex", include_str!("../templates/thesis/chapters/introduction.tex")),
                ("chapters/background.tex", include_str!("../templates/thesis/chapters/background.tex")),
                ("chapters/method.tex", include_str!("../templates/thesis/chapters/method.tex")),
                ("chapters/results.tex", include_str!("../templates/thesis/chapters/results.tex")),
                ("chapters/conclusion.tex", include_str!("../templates/thesis/chapters/conclusion.tex")),
                ("appendix/appendix-a.tex", include_str!("../templates/thesis/appendix/appendix-a.tex")),
                ("references.bib", include_str!("../templates/thesis/references.bib")),
            ],
        }
    }
}

#[cfg(test)]
mod tests {
    use std::path::PathBuf;

    use super::*;
    use crate::project;

    #[test]
    fn serde_names_match_the_ui() {
        for (name, template) in [
            ("blank", Template::Blank),
            ("example", Template::Example),
            ("report", Template::Report),
            ("presentation", Template::Presentation),
            ("thesis", Template::Thesis),
        ] {
            let parsed: Template = serde_json::from_str(&format!("\"{name}\"")).unwrap();
            assert_eq!(parsed, template);
        }
        assert!(serde_json::from_str::<Template>("\"poster\"").is_err());
    }

    #[test]
    fn every_template_creates_its_files_with_the_main_detected() {
        let root = tempfile::tempdir().unwrap();
        for template in Template::ALL {
            let created = project::create(root.path(), &format!("{template:?}"), template).unwrap();
            let dir = PathBuf::from(&created.path);
            for (rel, contents) in template.files() {
                assert_eq!(&std::fs::read_to_string(dir.join(rel)).unwrap(), contents, "{template:?}: {rel}");
                // No shell escape and no pictures that might be missing.
                assert!(!contents.contains("\\write18") && !contents.contains("\\includegraphics"), "{rel}");
            }
            assert_eq!(created.main_document.as_deref(), Some("main.tex"));
            assert_eq!(project::detect_main_document_ranked(&dir).as_deref(), Some("main.tex"), "{template:?}");
            assert_eq!(created.file_count, template.files().len());
        }
    }

    /// Compiles every template with the Tectonic that ships with Texo.
    /// Run with `pnpm test:tex`; needs internet the first time.
    #[test]
    #[ignore]
    fn every_template_compiles_with_bundled_tectonic() {
        use crate::compile::{self, Compiler, Job, Status, Toolchains};
        use std::sync::atomic::AtomicBool;
        use std::sync::Arc;

        let triple = if cfg!(windows) { "x86_64-pc-windows-msvc.exe" } else { "x86_64-unknown-linux-gnu" };
        let exe = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join(format!("binaries/tectonic-{triple}"));
        if !exe.is_file() {
            eprintln!("skipping: run `pnpm fetch-engine` first");
            return;
        }
        let tools = Toolchains { tectonic: Some(exe), tectonic_bundled: true, ..Default::default() };
        let root = tempfile::tempdir().unwrap();
        for template in Template::ALL {
            let created = project::create(root.path(), &format!("{template:?}"), template).unwrap();
            let dir = PathBuf::from(&created.path);
            let result = compile::compile(&Job {
                root: &dir,
                main: "main.tex",
                engine: project::Engine::Pdflatex,
                compiler: Compiler::Tectonic,
                tools: &tools,
                cancel: Arc::new(AtomicBool::new(false)),
                trusted: false,
                on_output: &|_| {},
            });
            let errors: Vec<_> = result
                .issues
                .iter()
                .filter(|i| i.severity == crate::texlog::Severity::Error)
                .collect();
            assert_eq!(result.status, Status::Success, "{template:?}: {errors:?}\n{}", result.output);
            assert!(errors.is_empty(), "{template:?}: {errors:?}");
        }
    }
}
