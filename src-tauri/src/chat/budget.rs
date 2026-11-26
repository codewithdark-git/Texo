//! Fitting a long chat into the model's context (spec: about 60% of the
//! model's context, or 120k characters when it isn't known).
//!
//! - Earlier turns go to the model as plain user / assistant text (tool
//!   calls of earlier answers are not replayed; the answer text is).
//! - When they don't fit, the oldest turns are summarised to one line each
//!   in a note at the start, and when even the note is too long the oldest
//!   lines are left out with a count. No model call is needed for this.
//! - Within one answer, older tool results are shortened to one line once
//!   the conversation passes the budget.

use crate::ai::llm::{ModelCaps, Msg, Part};

use super::store::{clip_line, AttachmentKind, ChatMessage, ChatRole};

/// Used when the model's context length isn't known.
pub const UNKNOWN_BUDGET: usize = 120_000;
const MIN_BUDGET: usize = 24_000;
const MAX_BUDGET: usize = 400_000;
/// Rough characters per token for prose and LaTeX.
const CHARS_PER_TOKEN: f64 = 3.0;
/// Room kept for the system prompt and tool definitions.
pub const RESERVE: usize = 8_000;
/// An image counts as this many characters.
pub const IMAGE_CHARS: usize = 3_000;
const SUMMARY_MAX: usize = 6_000;
const SUMMARY_USER: usize = 100;
const SUMMARY_ASSISTANT: usize = 160;

/// The character budget for the whole conversation sent to this model.
pub fn budget_chars(caps: &ModelCaps) -> usize {
    match caps.context_length {
        Some(tokens) => ((tokens as f64 * 0.6 * CHARS_PER_TOKEN) as usize).clamp(MIN_BUDGET, MAX_BUDGET),
        None => UNKNOWN_BUDGET,
    }
}

/// What the model sees of a stored user message (earlier images become a
/// short note; only the newest message carries image data).
pub fn user_text(m: &ChatMessage) -> String {
    let mut out = String::new();
    if !m.context_text.is_empty() {
        out.push_str(&m.context_text);
        out.push_str("\n\n");
    }
    let images: Vec<&str> =
        m.attachments.iter().filter(|a| a.kind == AttachmentKind::Image).map(|a| a.name.as_str()).collect();
    if !images.is_empty() {
        out.push_str(&format!("[Images attached: {}]\n\n", images.join(", ")));
    }
    out.push_str(&m.text);
    out
}

/// What the model sees of a stored assistant message.
fn assistant_text(m: &ChatMessage) -> Option<String> {
    let mut t = m.text.trim().to_string();
    if let Some(task) = &m.proposed_task {
        t.push_str(&format!("\n\n(I suggested a task: {})", clip_line(&task.prompt, 300)));
    }
    if t.trim().is_empty() {
        // A failed or stopped answer with no text: nothing useful to replay.
        None
    } else {
        Some(t)
    }
}

pub fn msg_chars(m: &Msg) -> usize {
    match m {
        Msg::User { content } => content
            .iter()
            .map(|p| match p {
                Part::Text { text } => text.len(),
                Part::Image { .. } => IMAGE_CHARS,
            })
            .sum(),
        Msg::Assistant { text, tool_calls, .. } => {
            text.len() + tool_calls.iter().map(|c| c.name.len() + c.arguments.to_string().len()).sum::<usize>()
        }
        Msg::Tool { content, .. } => content.len(),
    }
}

/// The earlier conversation, fitted to the budget.
#[derive(Debug, Clone, PartialEq)]
pub struct Fitted {
    pub msgs: Vec<Msg>,
    /// Earlier turns (messages of one side in a row) shown only as a
    /// one-line summary.
    pub summarised: usize,
    /// Earlier turns left out entirely.
    pub dropped: usize,
}

/// Turns the stored messages before the new one into model messages that
/// fit in `budget` characters. Consecutive messages of the same role are
/// joined and the result always starts with a user message.
pub fn fit_history(earlier: &[ChatMessage], budget: usize) -> Fitted {
    // (role, text) in order, empty assistant turns skipped.
    let mut turns: Vec<(ChatRole, String)> = Vec::new();
    for m in earlier {
        let text = match m.role {
            ChatRole::User => Some(user_text(m)),
            ChatRole::Assistant => assistant_text(m),
        };
        let Some(text) = text else { continue };
        match turns.last_mut() {
            Some((role, prev)) if *role == m.role => {
                prev.push_str("\n\n");
                prev.push_str(&text);
            }
            _ => turns.push((m.role, text)),
        }
    }

    // Keep the newest turns that fit in full.
    let mut used = 0usize;
    let mut keep_from = turns.len();
    for (i, (_, text)) in turns.iter().enumerate().rev() {
        if used + text.len() > budget {
            break;
        }
        used += text.len();
        keep_from = i;
    }
    // The kept part must start with the user.
    while keep_from < turns.len() && turns[keep_from].0 == ChatRole::Assistant {
        keep_from += 1;
    }

    let mut msgs = Vec::new();
    let older = &turns[..keep_from];
    let mut summarised = 0;
    let mut dropped = 0;
    if !older.is_empty() {
        let room = budget.saturating_sub(used).min(SUMMARY_MAX);
        let mut lines: Vec<String> = older
            .iter()
            .map(|(role, text)| match role {
                ChatRole::User => format!("- You asked: {}", clip_line(text, SUMMARY_USER)),
                ChatRole::Assistant => format!("- I answered: {}", clip_line(text, SUMMARY_ASSISTANT)),
            })
            .collect();
        let size = |ls: &[String]| ls.iter().map(|l| l.len() + 1).sum::<usize>();
        while !lines.is_empty() && size(&lines) > room {
            lines.remove(0);
            dropped += 1;
        }
        summarised = lines.len();
        let mut note = String::from("(This chat is long, so its start is shortened.");
        if dropped > 0 {
            note.push_str(&format!(" {dropped} of the earliest messages are left out."));
        }
        note.push(')');
        if !lines.is_empty() {
            note.push_str("\nSummary of the earlier conversation:\n");
            note.push_str(&lines.join("\n"));
        }
        msgs.push(Msg::user(note));
    }
    for (role, text) in &turns[keep_from..] {
        match role {
            ChatRole::User => {
                // Joined with the summary note when that came first.
                if let Some(Msg::User { content }) = msgs.last_mut() {
                    content.push(Part::Text { text: text.clone() });
                } else {
                    msgs.push(Msg::user(text.clone()));
                }
            }
            ChatRole::Assistant => {
                msgs.push(Msg::Assistant { text: text.clone(), tool_calls: Vec::new(), replay: None })
            }
        }
    }
    Fitted { msgs, summarised, dropped }
}

/// Within one answer: once the messages pass `budget`, replaces the oldest
/// tool results with a one-line note. Returns how many were shortened.
/// The newest tool result is never shortened.
pub fn shrink_tool_results(msgs: &mut [Msg], budget: usize) -> usize {
    let mut total: usize = msgs.iter().map(msg_chars).sum();
    if total <= budget {
        return 0;
    }
    let last_tool = msgs.iter().rposition(|m| matches!(m, Msg::Tool { .. }));
    let mut n = 0;
    for (i, m) in msgs.iter_mut().enumerate() {
        if total <= budget {
            break;
        }
        if Some(i) == last_tool {
            break;
        }
        if let Msg::Tool { name, content, .. } = m {
            if content.starts_with("[Earlier result") {
                continue;
            }
            let short = format!("[Earlier result of {name}, shortened: {}]", clip_line(content, 160));
            total = total - content.len() + short.len();
            *content = short;
            n += 1;
        }
    }
    n
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ai::llm::{ThinkingParam, ToolCall};
    use crate::chat::store::{ProposedTask, StoredAttachment};
    use serde_json::json;

    fn msg(role: ChatRole, text: &str) -> ChatMessage {
        ChatMessage::new(role, text)
    }

    fn caps(ctx: Option<u64>) -> ModelCaps {
        ModelCaps { vision: false, tools: true, thinking: ThinkingParam::None, context_length: ctx, known: true }
    }

    #[test]
    fn budget_follows_the_context_length() {
        assert_eq!(budget_chars(&caps(None)), UNKNOWN_BUDGET);
        assert_eq!(budget_chars(&caps(Some(1_000))), MIN_BUDGET);
        assert_eq!(budget_chars(&caps(Some(100_000))), 180_000);
        assert_eq!(budget_chars(&caps(Some(1_000_000))), MAX_BUDGET);
    }

    #[test]
    fn short_chats_are_sent_as_they_are() {
        let earlier = vec![msg(ChatRole::User, "Q1"), msg(ChatRole::Assistant, "A1"), msg(ChatRole::User, "Q2")];
        let f = fit_history(&earlier, 10_000);
        assert_eq!(f.summarised + f.dropped, 0);
        assert_eq!(f.msgs, vec![
            Msg::user("Q1"),
            Msg::Assistant { text: "A1".into(), tool_calls: vec![], replay: None },
            Msg::user("Q2"),
        ]);
    }

    #[test]
    fn failed_answers_are_skipped_and_same_roles_joined() {
        let mut failed = msg(ChatRole::Assistant, "");
        failed.error = Some(crate::chat::store::ChatError { kind: "offline".into(), message: "x".into() });
        let earlier = vec![msg(ChatRole::User, "Q1"), failed, msg(ChatRole::User, "Q1 again")];
        let f = fit_history(&earlier, 10_000);
        assert_eq!(f.msgs.len(), 1);
        assert_eq!(f.msgs[0], Msg::user("Q1\n\nQ1 again"));
    }

    #[test]
    fn long_chats_summarise_then_drop_the_oldest_turns() {
        let mut earlier = Vec::new();
        for i in 0..40 {
            earlier.push(msg(ChatRole::User, &format!("Question {i} {}", "q".repeat(400))));
            earlier.push(msg(ChatRole::Assistant, &format!("Answer {i} {}", "a".repeat(2_000))));
        }
        let f = fit_history(&earlier, 20_000);
        assert!(f.summarised > 0);
        let total: usize = f.msgs.iter().map(msg_chars).sum();
        assert!(total <= 20_000 + 7_000, "{total}");
        let Msg::User { content } = &f.msgs[0] else { panic!("starts with the user") };
        let Part::Text { text } = &content[0] else { panic!() };
        assert!(text.contains("shortened"));
        assert!(text.contains("You asked: Question 0") || f.dropped > 0);
        // The newest answer is kept in full.
        assert!(matches!(f.msgs.last(), Some(Msg::Assistant { text, .. }) if text.starts_with("Answer 39")));

        let tiny = fit_history(&earlier, 3_000);
        assert!(tiny.dropped > 0, "{tiny:?}");
        let total: usize = tiny.msgs.iter().map(msg_chars).sum();
        assert!(total <= 3_000 + 200, "{total}");
    }

    #[test]
    fn earlier_images_become_a_note_and_tasks_are_mentioned() {
        let mut u = msg(ChatRole::User, "What is in this figure?");
        u.attachments.push(StoredAttachment {
            name: "plot.png".into(),
            mime: "image/png".into(),
            kind: AttachmentKind::Image,
            size: 10,
            data_url: Some("data:image/png;base64,AAAA".into()),
            truncated: false,
        });
        u.context_text = "Current file main.tex".into();
        let mut a = msg(ChatRole::Assistant, "A chart.");
        a.proposed_task = Some(ProposedTask { prompt: "Redraw it".into(), files: vec![] });
        let f = fit_history(&[u, a], 10_000);
        let Msg::User { content } = &f.msgs[0] else { panic!() };
        assert_eq!(content.len(), 1, "no image data for earlier turns");
        let Part::Text { text } = &content[0] else { panic!() };
        assert!(text.starts_with("Current file main.tex"));
        assert!(text.contains("[Images attached: plot.png]"));
        let Msg::Assistant { text, .. } = &f.msgs[1] else { panic!() };
        assert!(text.contains("I suggested a task: Redraw it"));
    }

    #[test]
    fn old_tool_results_are_shortened_but_not_the_newest() {
        let call = ToolCall { id: "1".into(), name: "read_file".into(), arguments: json!({}), invalid_arguments: None };
        let mut msgs = vec![
            Msg::user("q"),
            Msg::Assistant { text: String::new(), tool_calls: vec![call.clone()], replay: None },
            Msg::tool_result(&call, "x".repeat(10_000), false),
            Msg::Assistant { text: String::new(), tool_calls: vec![call.clone()], replay: None },
            Msg::tool_result(&call, "y".repeat(10_000), false),
        ];
        assert_eq!(shrink_tool_results(&mut msgs, 50_000), 0);
        assert_eq!(shrink_tool_results(&mut msgs, 12_000), 1);
        let Msg::Tool { content, .. } = &msgs[2] else { panic!() };
        assert!(content.starts_with("[Earlier result of read_file, shortened"));
        let Msg::Tool { content, .. } = &msgs[4] else { panic!() };
        assert_eq!(content.len(), 10_000);
    }
}
