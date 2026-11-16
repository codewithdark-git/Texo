use serde::Deserialize;

/// Starter content for a new project. Every template has `main.tex` at the
/// top level, which is the document Texo compiles.
#[derive(Debug, Clone, Copy, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Template {
    Blank,
    Example,
    Conference,
    Report,
    Thesis,
    Lecture,
    Homework,
    Presentation,
    Letter,
    Cv,
}

impl Template {
    /// Every template, in the order the gallery shows them.
    #[cfg(test)]
    pub const ALL: [Template; 10] = [
        Template::Blank,
        Template::Example,
        Template::Conference,
        Template::Report,
        Template::Thesis,
        Template::Lecture,
        Template::Homework,
        Template::Presentation,
        Template::Letter,
        Template::Cv,
    ];

    /// Files as `(relative path, contents)` pairs, with `/` separators.
    pub fn files(self) -> &'static [(&'static str, &'static str)] {
        match self {
            Template::Blank => &[("main.tex", include_str!("../templates/blank/main.tex"))],
            Template::Example => &[
                ("main.tex", include_str!("../templates/example/main.tex")),
                ("references.bib", include_str!("../templates/example/references.bib")),
            ],
            Template::Conference => &[
                ("main.tex", include_str!("../templates/conference/main.tex")),
                ("references.bib", include_str!("../templates/conference/references.bib")),
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
            Template::Lecture => &[("main.tex", include_str!("../templates/lecture/main.tex"))],
            Template::Homework => &[("main.tex", include_str!("../templates/homework/main.tex"))],
            Template::Letter => &[("main.tex", include_str!("../templates/letter/main.tex"))],
            Template::Cv => &[("main.tex", include_str!("../templates/cv/main.tex"))],
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
        let names = [
            ("blank", Template::Blank),
            ("example", Template::Example),
            ("conference", Template::Conference),
            ("report", Template::Report),
            ("thesis", Template::Thesis),
            ("lecture", Template::Lecture),
            ("homework", Template::Homework),
            ("presentation", Template::Presentation),
            ("letter", Template::Letter),
            ("cv", Template::Cv),
        ];
        for (name, template) in names {
            let parsed: Template = serde_json::from_str(&format!("\"{name}\"")).unwrap();
            assert_eq!(parsed, template);
        }
        // The gallery order is the order above, and no template is missing.
        assert_eq!(names.map(|(_, t)| t), Template::ALL);
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

    /// Compiles every template with every toolchain this machine has:
    /// latexmk and the direct engine run (MiKTeX or TeX Live, pdfLaTeX) and
    /// the Tectonic that ships with Texo. Each build must succeed with no
    /// errors, no unresolved references or citations and no overfull boxes.
    /// Run with `pnpm test:tex`; Tectonic needs internet the first time.
    #[test]
    #[ignore]
    fn every_template_compiles_with_every_toolchain() {
        use crate::compile::{self, Compiler, Job, Status, Toolchains};
        use crate::texlog::Severity;
        use std::sync::atomic::AtomicBool;
        use std::sync::Arc;

        let mut runs: Vec<(String, Toolchains, Compiler)> = Vec::new();
        let installed = compile::detect(std::path::Path::new("."));
        for compiler in [Compiler::Latexmk, Compiler::Direct] {
            match installed.choose(compiler, project::Engine::Pdflatex) {
                Some(c) => runs.push((format!("{c:?}"), installed.clone(), c)),
                None => eprintln!("skipping {compiler:?}: not installed"),
            }
        }
        let triple = if cfg!(windows) { "x86_64-pc-windows-msvc.exe" } else { "x86_64-unknown-linux-gnu" };
        let exe = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join(format!("binaries/tectonic-{triple}"));
        if exe.is_file() {
            let tools = Toolchains { tectonic: Some(exe), tectonic_bundled: true, ..Default::default() };
            runs.push(("bundled Tectonic".into(), tools, Compiler::Tectonic));
        } else {
            eprintln!("skipping Tectonic: run `pnpm fetch-engine` first");
        }
        assert!(!runs.is_empty(), "no TeX toolchain found");

        let mut failures = Vec::new();
        for (name, tools, compiler) in &runs {
            let root = tempfile::tempdir().unwrap();
            for template in Template::ALL {
                let created = project::create(root.path(), &format!("{template:?}"), template).unwrap();
                let dir = PathBuf::from(&created.path);
                let result = compile::compile(&Job {
                    root: &dir,
                    main: "main.tex",
                    engine: project::Engine::Pdflatex,
                    compiler: *compiler,
                    tools,
                    cancel: Arc::new(AtomicBool::new(false)),
                    trusted: false,
                    on_output: &|_| {},
                });
                let bad: Vec<_> = result
                    .issues
                    .iter()
                    .filter(|i| match i.severity {
                        Severity::Error => true,
                        Severity::Warning => {
                            let m = i.message.to_lowercase();
                            m.contains("undefined") || m.contains("rerun")
                        }
                        Severity::Badbox => i.message.starts_with("Overfull"),
                    })
                    .map(|i| format!("{:?} {:?}:{:?} {}", i.severity, i.file, i.line, i.message))
                    .collect();
                let messages: Vec<_> = result.issues.iter().map(|i| i.message.as_str()).collect();
                eprintln!("{name} / {template:?}: {:?} {messages:?}", result.status);
                if result.status != Status::Success || result.pdf_path.is_none() || !bad.is_empty() {
                    failures.push(format!("{name} / {template:?}: {:?} {bad:#?}\n{}", result.status, result.output));
                }
            }
        }
        assert!(failures.is_empty(), "{}", failures.join("\n\n"));
    }
}
