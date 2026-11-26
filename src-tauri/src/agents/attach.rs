//! Turns the prompt and its attachments into the run's first user message.
//!
//! - Images (png/jpg/webp/gif; the webview already downscaled them) go as
//!   image parts when the model can see images; otherwise [`describe`] has
//!   the vision fallback model describe them for the main model, or (with no
//!   fallback, or when it fails) the model is told an image was attached
//!   that it can't see.
//! - `.tex`/`.bib`/`.txt`/`.md`/`.csv` (and other text) go as text, capped;
//!   PDFs as the text the webview extracted.
//! - Anything else is refused with a message.
//! - "Also save into project" (`saveAs`) puts a text attachment into the
//!   changeset like any other new file.

use base64::Engine as _;

use crate::error::{AppError, AppResult};

use super::overlay::Overlay;
use super::types::{Attachment, AttachmentInfo};
use crate::ai::llm::Part;

pub const MAX_ATTACHMENTS: usize = 12;
const MAX_TEXT_CHARS: usize = 40_000;
/// Base64 of an image after the webview's downscaling is ~240 KB; allow
/// some slack for screenshots that couldn't be shrunk further.
const MAX_IMAGE_BASE64: usize = 3 * 1024 * 1024;
const IMAGE_MIMES: &[&str] = &["image/png", "image/jpeg", "image/jpg", "image/webp", "image/gif"];
const TEXT_EXTENSIONS: &[&str] = &["tex", "bib", "txt", "md", "csv", "tsv", "sty", "cls", "json", "yaml", "yml", "log"];

#[derive(Debug)]
pub struct Prepared {
    pub parts: Vec<Part>,
    pub infos: Vec<AttachmentInfo>,
    /// (project path, text) to put into the changeset.
    pub saves: Vec<(String, String)>,
    /// Images the model can't see: (index in `parts` of their placeholder,
    /// index in `infos`, the image part) for [`describe`].
    pub unseen: Vec<(usize, usize, Part)>,
}

/// The model that describes images for a model that can't see them.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct VisionFallback {
    pub model: String,
    pub fallbacks: Vec<String>,
}

fn ext(name: &str) -> String {
    name.rsplit_once('.').map(|(_, e)| e.to_ascii_lowercase()).unwrap_or_default()
}

fn refuse(name: &str, why: &str) -> AppError {
    AppError::msg(format!("“{name}” can't be attached: {why}"))
}

/// Builds the first user message. `vision`: the model can see images.
pub fn prepare(overlay: &Overlay, prompt: &str, attachments: &[Attachment], vision: bool) -> AppResult<Prepared> {
    if attachments.len() > MAX_ATTACHMENTS {
        return Err(AppError::msg(format!("At most {MAX_ATTACHMENTS} attachments can be sent with one request.")));
    }
    let mut parts = vec![Part::Text { text: prompt.trim().to_string() }];
    let mut infos = Vec::new();
    let mut saves = Vec::new();
    let mut unseen = Vec::new();
    for a in attachments {
        let name = if a.name.trim().is_empty() { a.path.clone().unwrap_or_else(|| "attachment".into()) } else { a.name.trim().to_string() };
        let mime = a.mime.trim().to_ascii_lowercase();
        let e = ext(&name);
        let mut info = AttachmentInfo { name: name.clone(), mime: mime.clone(), path: a.path.clone(), used_as: String::new(), note: None };
        if IMAGE_MIMES.contains(&mime.as_str()) {
            let data = a.data_base64.as_deref().map(str::trim).filter(|d| !d.is_empty()).ok_or_else(|| refuse(&name, "the image data is missing."))?;
            let data = data.split_once("base64,").map(|x| x.1).unwrap_or(data);
            if data.len() > MAX_IMAGE_BASE64 {
                return Err(refuse(&name, "the image is too large."));
            }
            if base64::engine::general_purpose::STANDARD.decode(data).is_err() {
                return Err(refuse(&name, "the image data is damaged."));
            }
            if vision {
                parts.push(Part::Text { text: format!("Attached image: {name}") });
                parts.push(Part::Image { mime: if mime == "image/jpg" { "image/jpeg".into() } else { mime.clone() }, data_url: format!("data:{mime};base64,{data}") });
                info.used_as = "image".into();
            } else {
                unseen.push((
                    parts.len(),
                    infos.len(),
                    Part::Image { mime: if mime == "image/jpg" { "image/jpeg".into() } else { mime.clone() }, data_url: format!("data:{mime};base64,{data}") },
                ));
                parts.push(Part::Text { text: format!("[The user attached an image, {name}, but this model can't see images.]") });
                info.used_as = "skipped".into();
                info.note = Some("This model can't see images. Pick a vision model to include them.".into());
            }
            if a.save_as.is_some() {
                info.note = Some("Images can't be saved into the project from a run yet; add it with Import instead.".into());
            }
            infos.push(info);
            continue;
        }
        let text = if let Some(t) = &a.text {
            t.clone()
        } else if mime == "application/pdf" || e == "pdf" {
            return Err(refuse(&name, "its text couldn't be read."));
        } else if let Some(d) = a.data_base64.as_deref() {
            let d = d.trim();
            let d = d.split_once("base64,").map(|x| x.1).unwrap_or(d);
            let bytes = base64::engine::general_purpose::STANDARD.decode(d).map_err(|_| refuse(&name, "the file data is damaged."))?;
            if !(TEXT_EXTENSIONS.contains(&e.as_str()) || mime.starts_with("text/")) || bytes.contains(&0) {
                return Err(refuse(&name, "only images, text files (.tex, .bib, .txt, .md, .csv) and PDFs can be sent."));
            }
            String::from_utf8(bytes).map_err(|_| refuse(&name, "it isn't plain text (UTF-8)."))?
        } else if let Some(p) = &a.path {
            overlay.peek(p)?.ok_or_else(|| refuse(&name, "the file can't be found in the project."))?
        } else {
            return Err(refuse(&name, "it has no content."));
        };
        let shown = super::types::cap(&text, MAX_TEXT_CHARS);
        parts.push(Part::Text { text: format!("Attached file {name}:\n```\n{shown}\n```") });
        info.used_as = "text".into();
        if text.chars().count() > MAX_TEXT_CHARS {
            info.note = Some(format!("Only the first {MAX_TEXT_CHARS} characters were sent."));
        }
        if let Some(dest) = a.save_as.as_deref().map(str::trim).filter(|d| !d.is_empty()) {
            if a.text.is_some() && (mime == "application/pdf" || e == "pdf") {
                info.note = Some("A PDF can't be saved into the project from a run; add it with Import instead.".into());
            } else {
                saves.push((dest.to_string(), text));
            }
        }
        infos.push(info);
    }
    Ok(Prepared { parts, infos, saves, unseen })
}

const DESCRIBE_SYSTEM: &str = "You describe pictures for an assistant that can't see them. Be factual and complete; don't guess what isn't visible.";
const DESCRIBE_ASK: &str = "Describe each picture precisely for someone who can't see it: what it shows, all visible text, numbers, axes, labels, equations (as LaTeX) and anything that looks wrong. Number the pictures in the order given.";

/// Has the vision fallback model describe the images the main model can't
/// see, and puts the description in place of their placeholders. Returns a
/// notice for the run log. Never fails the run (except on cancel): on an
/// error the placeholders stay.
pub async fn describe(
    client: &reqwest::Client,
    endpoint: &crate::ai::http::Endpoint,
    vision: &VisionFallback,
    policy: crate::ai::llm::RetryPolicy,
    prepared: &mut Prepared,
    cancel: &crate::ai::http::Cancel,
) -> crate::ai::error::AiResult<Option<String>> {
    use crate::ai::llm::{self, LlmRequest, Msg, ToolChoice};
    if prepared.unseen.is_empty() {
        return Ok(None);
    }
    let names: Vec<String> = prepared.unseen.iter().map(|(_, i, _)| prepared.infos[*i].name.clone()).collect();
    let mut content = vec![Part::Text { text: DESCRIBE_ASK.into() }];
    for (n, (_, _, img)) in prepared.unseen.iter().enumerate() {
        content.push(Part::Text { text: format!("Picture {}: {}", n + 1, names[n]) });
        content.push(img.clone());
    }
    let ep = crate::ai::http::Endpoint { model: vision.model.clone(), ..endpoint.clone() };
    let req = LlmRequest {
        system: DESCRIBE_SYSTEM.into(),
        messages: vec![Msg::User { content }],
        tool_choice: ToolChoice::None,
        max_tokens: Some(2_000),
        fallback_models: vision.fallbacks.clone(),
        policy,
        ..Default::default()
    };
    match llm::complete(client, &ep, req, cancel).await {
        Ok(r) if !r.text.trim().is_empty() => {
            let text = r.text.trim().to_string();
            for (k, (part_at, info_at, _)) in prepared.unseen.iter().enumerate() {
                prepared.parts[*part_at] = Part::Text {
                    text: if k == 0 {
                        format!("[Description of the attached image(s) {} by a vision model:]\n{text}", names.join(", "))
                    } else {
                        format!("[Image {} is described above.]", names[k])
                    },
                };
                let info = &mut prepared.infos[*info_at];
                info.used_as = "described".into();
                info.note = Some(format!("Described by {} because the main model can't see images.", r.model));
            }
            prepared.unseen.clear();
            Ok(Some(format!("{} can't see images, so {} described them first.", endpoint.model, r.model)))
        }
        Err(e) if e.kind == crate::ai::error::Kind::Cancelled => Err(e),
        other => {
            let why = match other {
                Err(e) => e.message,
                Ok(_) => "the answer was empty".into(),
            };
            Ok(Some(format!("The attached images couldn't be described ({why}), so only their names were sent.")))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn b64(s: &[u8]) -> String {
        base64::engine::general_purpose::STANDARD.encode(s)
    }

    #[test]
    fn images_text_and_refusals() {
        let d = tempfile::tempdir().unwrap();
        std::fs::write(d.path().join("notes.md"), "project notes").unwrap();
        let o = Overlay::new(d.path(), Vec::new());
        let img = Attachment { name: "shot.png".into(), mime: "image/png".into(), data_base64: Some(b64(b"\x89PNG")), ..Default::default() };
        let txt = Attachment {
            name: "reviews.txt".into(),
            mime: "text/plain".into(),
            data_base64: Some(b64(b"Reviewer 1: unclear")),
            save_as: Some("reviews/r1.txt".into()),
            ..Default::default()
        };
        let pdf = Attachment { name: "paper.pdf".into(), mime: "application/pdf".into(), text: Some("PDF text".into()), ..Default::default() };
        let inproject = Attachment { name: "notes.md".into(), mime: "text/markdown".into(), path: Some("notes.md".into()), ..Default::default() };
        let p = prepare(&o, "Do it", &[img.clone(), txt.clone(), pdf.clone(), inproject], true).unwrap();
        assert!(matches!(&p.parts[2], Part::Image { data_url, .. } if data_url.starts_with("data:image/png;base64,")));
        assert!(p.parts.iter().any(|x| matches!(x, Part::Text { text } if text.contains("Reviewer 1: unclear"))));
        assert!(p.parts.iter().any(|x| matches!(x, Part::Text { text } if text.contains("project notes"))));
        assert_eq!(p.saves, vec![("reviews/r1.txt".to_string(), "Reviewer 1: unclear".to_string())]);
        assert_eq!(p.infos.iter().map(|i| i.used_as.as_str()).collect::<Vec<_>>(), ["image", "text", "text", "text"]);

        let blind = prepare(&o, "Do it", &[img], false).unwrap();
        assert!(!blind.parts.iter().any(|x| matches!(x, Part::Image { .. })));
        assert_eq!(blind.infos[0].used_as, "skipped");

        let zip = Attachment { name: "a.zip".into(), mime: "application/zip".into(), data_base64: Some(b64(b"PK\x03\x04\0")), ..Default::default() };
        assert!(prepare(&o, "x", &[zip], true).unwrap_err().to_string().contains("can't be attached"));
        let raw_pdf = Attachment { name: "b.pdf".into(), mime: "application/pdf".into(), data_base64: Some(b64(b"%PDF")), ..Default::default() };
        assert!(prepare(&o, "x", &[raw_pdf], true).is_err());
        let bad = Attachment { name: "c.png".into(), mime: "image/png".into(), data_base64: Some("!!!".into()), ..Default::default() };
        assert!(prepare(&o, "x", &[bad], true).is_err());
    }
}
