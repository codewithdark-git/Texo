use serde::Deserialize;

/// Starter content for a new project.
#[derive(Debug, Clone, Copy, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Template {
    Blank,
    Example,
}

impl Template {
    /// Files as `(relative path, contents)` pairs.
    pub fn files(self) -> &'static [(&'static str, &'static str)] {
        match self {
            Template::Blank => &[("main.tex", include_str!("../templates/blank/main.tex"))],
            Template::Example => &[
                ("main.tex", include_str!("../templates/example/main.tex")),
                ("references.bib", include_str!("../templates/example/references.bib")),
            ],
        }
    }
}
