//! Text clean-up for answers from open models, used by [`super::llm`]:
//! - `<think>…</think>` blocks (and a stray `</think>`) are removed;
//! - tool calls written as text are found: `<tool_call>{…}</tool_call>`, the
//!   XML form `<function=name><parameter=p>v</parameter></function>`, fenced
//!   JSON, a bare `{"name": …, "arguments": …}`, and the ReAct line
//!   `Action: name {json}`;
//! - a doubled tool name (`read_fileread_file`) is matched to the tool list;
//! - JSON with fences, trailing commas or missing closing brackets is
//!   repaired before giving up.

// Used by the agents runtime and the chat (v1.2); until those land, parts
// of this module are only reached from tests.

use serde_json::{Map, Value};

const THINK_OPEN: &str = "<think>";
const THINK_CLOSE: &str = "</think>";
const CALL_OPEN: &str = "<tool_call>";
const CALL_CLOSE: &str = "</tool_call>";

/// Removes reasoning the model wrote into its answer. An unclosed `<think>`
/// hides everything after it; a `</think>` without an opening tag hides
/// everything before it (some chat templates add the opening tag
/// themselves).
pub fn strip_think(text: &str) -> String {
    strip_think_raw(text).trim().to_string()
}

/// [`strip_think`] without the final trim.
fn strip_think_raw(text: &str) -> String {
    let mut s = text;
    // Stray close: everything before the last unmatched `</think>` is thinking.
    let mut out = String::new();
    loop {
        let open = s.find(THINK_OPEN);
        let close = s.find(THINK_CLOSE);
        match (open, close) {
            (_, Some(c)) if open.is_none_or(|o| c < o) => {
                // Close before any open: drop what came before (thinking).
                out.clear();
                s = &s[c + THINK_CLOSE.len()..];
            }
            (Some(o), _) => {
                out.push_str(&s[..o]);
                let rest = &s[o + THINK_OPEN.len()..];
                match rest.find(THINK_CLOSE) {
                    Some(c) => s = &rest[c + THINK_CLOSE.len()..],
                    None => {
                        s = "";
                    }
                }
            }
            (None, None) => {
                out.push_str(s);
                break;
            }
            _ => unreachable!(),
        }
        if s.is_empty() {
            break;
        }
    }
    out
}

/// The text that is safe to show while an answer is still streaming:
/// thinking is hidden, and so is anything from the start of a text tool call
/// on. A marker that is only partly received is held back.
pub fn visible_prefix(raw: &str, react: bool) -> String {
    let mut text = raw.to_string();
    // Hold back a partial marker at the very end.
    for marker in [THINK_OPEN, THINK_CLOSE, CALL_OPEN, "<function=", "Action:"] {
        for n in (1..marker.len()).rev() {
            if text.ends_with(&marker[..n]) {
                text.truncate(text.len() - n);
                break;
            }
        }
    }
    let mut out = strip_think_raw(&text);
    if let Some(i) = out.find(CALL_OPEN) {
        out.truncate(i);
    }
    if let Some(i) = out.find("<function=") {
        out.truncate(i);
    }
    if react {
        if let Some(i) = find_action_line(&out) {
            out.truncate(i);
        }
    }
    out.trim_start().to_string()
}

fn find_action_line(text: &str) -> Option<usize> {
    let mut pos = 0;
    for line in text.split_inclusive('\n') {
        let t = line.trim_start();
        if t.starts_with("Action:") {
            return Some(pos);
        }
        pos += line.len();
    }
    None
}

/// A tool call found in the answer text.
#[derive(Debug, Clone, PartialEq)]
pub struct TextCall {
    pub name: String,
    /// The arguments as written (JSON text, possibly broken).
    pub arguments: String,
}

/// Finds tool calls written as text. Only names that match the tool list
/// (after [`resolve_tool_name`]) count. Returns the text with the calls
/// removed, and the calls in order.
pub fn extract_text_calls(text: &str, tools: &[&str]) -> (String, Vec<TextCall>) {
    if tools.is_empty() {
        return (text.to_string(), Vec::new());
    }
    let mut calls = Vec::new();
    let mut rest = text.to_string();

    // 1. <tool_call> … </tool_call> (the close tag may be missing).
    while let Some(start) = rest.find(CALL_OPEN) {
        let inner_start = start + CALL_OPEN.len();
        let (inner_end, end) = match rest[inner_start..].find(CALL_CLOSE) {
            Some(i) => (inner_start + i, inner_start + i + CALL_CLOSE.len()),
            None => (rest.len(), rest.len()),
        };
        let inner = rest[inner_start..inner_end].to_string();
        let found = parse_xml_function(&inner, tools)
            .map(|c| vec![c])
            .unwrap_or_else(|| json_calls(&inner, tools));
        calls.extend(found);
        rest.replace_range(start..end, "");
    }

    // 2. Bare XML function form without the wrapper.
    while let Some(start) = rest.find("<function=") {
        let end = rest[start..].find("</function>").map(|i| start + i + "</function>".len()).unwrap_or(rest.len());
        let chunk = rest[start..end].to_string();
        match parse_xml_function(&chunk, tools) {
            Some(c) => {
                calls.push(c);
                rest.replace_range(start..end, "");
            }
            None => break,
        }
    }

    // 3. ReAct: `Action: name {json}` or `Action: name` + `Action Input: {json}`.
    let (after_react, react_calls) = react_calls(&rest, tools);
    if !react_calls.is_empty() {
        calls.extend(react_calls);
        rest = after_react;
    }

    // 4. Fenced JSON blocks holding a call.
    if calls.is_empty() {
        let mut search_from = 0;
        while let Some(rel) = rest[search_from..].find("```") {
            let fence = search_from + rel;
            let body_start = rest[fence + 3..].find('\n').map(|i| fence + 3 + i + 1).unwrap_or(fence + 3);
            let Some(close_rel) = rest[body_start..].find("```") else { break };
            let close = body_start + close_rel;
            let found = json_calls(&rest[body_start..close], tools);
            if found.is_empty() {
                search_from = close + 3;
            } else {
                calls.extend(found);
                rest.replace_range(fence..close + 3, "");
                search_from = fence;
            }
        }
    }

    // 5. Bare JSON objects (or a list of them) with "name" + "arguments".
    if calls.is_empty() {
        let mut i = 0;
        while i < rest.len() {
            let Some(rel) = rest[i..].find(['{', '[']) else { break };
            let start = i + rel;
            let end = balanced_end(&rest, start).unwrap_or(rest.len());
            let found = json_calls(&rest[start..end], tools);
            if found.is_empty() {
                i = start + 1;
            } else {
                calls.extend(found);
                rest.replace_range(start..end, "");
                i = start;
            }
        }
    }

    (rest.trim().to_string(), calls)
}

/// `<function=name><parameter=p>value</parameter>…</function>`.
fn parse_xml_function(text: &str, tools: &[&str]) -> Option<TextCall> {
    let start = text.find("<function=")? + "<function=".len();
    let name_end = text[start..].find('>')? + start;
    let name = resolve_tool_name(text[start..name_end].trim(), tools)?;
    let body = &text[name_end + 1..];
    let mut args = Map::new();
    let mut rest = body;
    while let Some(p) = rest.find("<parameter=") {
        let ps = p + "<parameter=".len();
        let Some(pe_rel) = rest[ps..].find('>') else { break };
        let pname = rest[ps..ps + pe_rel].trim().to_string();
        let vs = ps + pe_rel + 1;
        let ve = rest[vs..].find("</parameter>").map(|i| vs + i).unwrap_or(rest.len());
        let raw = rest[vs..ve].trim_matches('\n');
        let value = match serde_json::from_str::<Value>(raw.trim()) {
            Ok(v @ (Value::Object(_) | Value::Array(_) | Value::Number(_) | Value::Bool(_))) => v,
            _ => Value::String(raw.to_string()),
        };
        args.insert(pname, value);
        rest = if ve + "</parameter>".len() <= rest.len() { &rest[ve + "</parameter>".len()..] } else { "" };
    }
    Some(TextCall { name, arguments: Value::Object(args).to_string() })
}

fn react_calls(text: &str, tools: &[&str]) -> (String, Vec<TextCall>) {
    let mut calls = Vec::new();
    let mut kept = String::new();
    let lines: Vec<&str> = text.split_inclusive('\n').collect();
    let mut i = 0;
    while i < lines.len() {
        let line = lines[i];
        let t = line.trim_start();
        if let Some(after) = t.strip_prefix("Action:") {
            let after = after.trim();
            // The name runs to the first space, `{` or `(`.
            let name_end = after.find(|c: char| c.is_whitespace() || c == '{' || c == '(').unwrap_or(after.len());
            let raw_name = after[..name_end].trim_matches(|c: char| c == '`' || c == '"' || c == '\'');
            if let Some(name) = resolve_tool_name(raw_name, tools) {
                let mut args_text = after[name_end..].trim().trim_start_matches('(').to_string();
                let mut consumed = 1;
                if args_text.is_empty() {
                    // `Action Input:` on the next line(s).
                    if let Some(next) = lines.get(i + 1) {
                        if let Some(input) = next.trim_start().strip_prefix("Action Input:") {
                            args_text = input.trim().to_string();
                            consumed = 2;
                        }
                    }
                }
                // A JSON object may continue over the following lines.
                if args_text.starts_with('{') && balanced_end(&args_text, 0).is_none() {
                    let mut j = i + consumed;
                    while j < lines.len() {
                        args_text.push('\n');
                        args_text.push_str(lines[j].trim_end_matches('\n'));
                        j += 1;
                        if balanced_end(&args_text, 0).is_some() {
                            break;
                        }
                    }
                    consumed = j - i;
                }
                if let Some(end) = balanced_end(&args_text, 0) {
                    args_text.truncate(end);
                }
                let args_text = args_text.trim().trim_end_matches(')').trim().to_string();
                calls.push(TextCall {
                    name,
                    arguments: if args_text.is_empty() { "{}".into() } else { args_text },
                });
                i += consumed;
                continue;
            }
        }
        if !calls.is_empty() {
            // Only the Action block counts: anything after it (an invented
            // `Observation:`, a claim about the result) was written before
            // the tool ran, so it is dropped.
            if t.trim().is_empty() {
                i += 1;
                continue;
            }
            break;
        }
        kept.push_str(line);
        i += 1;
    }
    (kept, calls)
}

/// Calls in a JSON text: one object, or a list of objects, each with a
/// `name` (or `function.name`) and `arguments` / `parameters` / `input`.
fn json_calls(text: &str, tools: &[&str]) -> Vec<TextCall> {
    let Some(v) = repair_json(text) else { return Vec::new() };
    let items: Vec<Value> = match v {
        Value::Array(a) => a,
        other => vec![other],
    };
    items
        .iter()
        .filter_map(|item| {
            let obj = item.as_object()?;
            let (name, holder) = match obj.get("function").and_then(Value::as_object) {
                Some(f) if f.contains_key("name") => (f.get("name")?.as_str()?, f),
                _ => (obj.get("name")?.as_str()?, obj),
            };
            let name = resolve_tool_name(name, tools)?;
            let args = ["arguments", "parameters", "input", "args"]
                .iter()
                .find_map(|k| holder.get(*k))
                .cloned()
                .unwrap_or(Value::Object(Map::new()));
            let arguments = match args {
                Value::String(s) => s,
                other => other.to_string(),
            };
            Some(TextCall { name, arguments })
        })
        .collect()
}

/// The byte index just past the bracket that closes the one at `start`
/// (`{` or `[`), skipping brackets inside strings. `None` if unclosed.
pub fn balanced_end(text: &str, start: usize) -> Option<usize> {
    let bytes = text.as_bytes();
    let mut depth = 0i32;
    let mut in_str = false;
    let mut escaped = false;
    for (i, &b) in bytes.iter().enumerate().skip(start) {
        if in_str {
            if escaped {
                escaped = false;
            } else if b == b'\\' {
                escaped = true;
            } else if b == b'"' {
                in_str = false;
            }
            continue;
        }
        match b {
            b'"' => in_str = true,
            b'{' | b'[' => depth += 1,
            b'}' | b']' => {
                depth -= 1;
                if depth == 0 {
                    return Some(i + 1);
                }
                if depth < 0 {
                    return None;
                }
            }
            _ => {}
        }
    }
    None
}

/// Matches a tool name from the model to the tool list: exact, then
/// case-insensitive, then without a `functions.` prefix or quotes, then a
/// name repeated two or more times (`xx` + `xx`, a streaming glitch).
pub fn resolve_tool_name(name: &str, tools: &[&str]) -> Option<String> {
    let n = name.trim().trim_matches(|c: char| c == '"' || c == '\'' || c == '`');
    let n = n.strip_prefix("functions.").unwrap_or(n);
    let n = n.split("<|").next().unwrap_or(n).trim();
    if n.is_empty() {
        return None;
    }
    if let Some(t) = tools.iter().find(|t| **t == n) {
        return Some(t.to_string());
    }
    if let Some(t) = tools.iter().find(|t| t.eq_ignore_ascii_case(n)) {
        return Some(t.to_string());
    }
    for t in tools {
        if !t.is_empty() && n.len() > t.len() && n.len() % t.len() == 0 && n.eq_ignore_ascii_case(&t.repeat(n.len() / t.len())) {
            return Some(t.to_string());
        }
    }
    None
}

/// Parses JSON a model wrote, repairing the usual slips: code fences, text
/// around the object, trailing commas, missing closing brackets or quotes,
/// and JSON encoded twice as a string. `None` if it still isn't JSON.
/// The text was cut off inside a JSON string (e.g. tool arguments that
/// stopped mid-file). [`repair_json`] would close the string and save a
/// shortened value, so callers that act on the value must check this first.
pub fn ends_in_open_string(text: &str) -> bool {
    let t = strip_fences(text.trim());
    let Some(start) = t.find(['{', '[']) else { return false };
    let body = &t[start..];
    if balanced_end(body, 0).is_some() {
        return false;
    }
    let mut in_str = false;
    let mut escaped = false;
    for c in body.chars() {
        if in_str {
            if escaped {
                escaped = false;
            } else if c == '\\' {
                escaped = true;
            } else if c == '"' {
                in_str = false;
            }
        } else if c == '"' {
            in_str = true;
        }
    }
    in_str
}

pub fn repair_json(text: &str) -> Option<Value> {
    let t = strip_fences(text.trim());
    if t.is_empty() {
        return None;
    }
    if let Some(v) = parse_once(t) {
        return Some(unwrap_string(v));
    }
    // Text around an object: start at the first bracket.
    let start = t.find(['{', '['])?;
    let body = &t[start..];
    let body = match balanced_end(body, 0) {
        Some(end) => &body[..end],
        None => body,
    };
    let fixed = close_brackets(&drop_trailing_commas(body));
    parse_once(&fixed).map(unwrap_string)
}

fn parse_once(t: &str) -> Option<Value> {
    serde_json::from_str::<Value>(t).ok()
}

/// `"{\"a\":1}"` (JSON sent as a string) → the object inside.
fn unwrap_string(v: Value) -> Value {
    if let Value::String(s) = &v {
        let st = s.trim();
        if st.starts_with('{') || st.starts_with('[') {
            if let Some(inner) = repair_json(st) {
                return inner;
            }
        }
    }
    v
}

fn strip_fences(t: &str) -> &str {
    let Some(rest) = t.strip_prefix("```") else { return t };
    let rest = match rest.find('\n') {
        Some(i) if !rest[..i].contains(['{', '[']) => &rest[i + 1..],
        _ => rest,
    };
    rest.trim_end().strip_suffix("```").unwrap_or(rest).trim()
}

fn drop_trailing_commas(t: &str) -> String {
    let chars: Vec<char> = t.chars().collect();
    let mut out = String::with_capacity(t.len());
    let mut in_str = false;
    let mut escaped = false;
    for (i, &c) in chars.iter().enumerate() {
        if in_str {
            out.push(c);
            if escaped {
                escaped = false;
            } else if c == '\\' {
                escaped = true;
            } else if c == '"' {
                in_str = false;
            }
            continue;
        }
        if c == '"' {
            in_str = true;
        }
        if c == ',' {
            let next = chars[i + 1..].iter().find(|c| !c.is_whitespace());
            if matches!(next, Some('}') | Some(']') | None) {
                continue;
            }
        }
        out.push(c);
    }
    out
}

fn close_brackets(t: &str) -> String {
    let mut stack = Vec::new();
    let mut in_str = false;
    let mut escaped = false;
    for c in t.chars() {
        if in_str {
            if escaped {
                escaped = false;
            } else if c == '\\' {
                escaped = true;
            } else if c == '"' {
                in_str = false;
            }
            continue;
        }
        match c {
            '"' => in_str = true,
            '{' => stack.push('}'),
            '[' => stack.push(']'),
            '}' | ']' => {
                stack.pop();
            }
            _ => {}
        }
    }
    let mut out = t.to_string();
    if in_str {
        if escaped {
            out.pop();
        }
        out.push('"');
    }
    let trimmed = out.trim_end().trim_end_matches([',', ':']).to_string();
    let mut out = trimmed;
    // A dangling key without a value (`{"a": 1, "b"`) can't be saved.
    while let Some(c) = stack.pop() {
        out.push(c);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    const TOOLS: &[&str] = &["read_file", "edit_file", "compile_check"];

    #[test]
    fn think_blocks_are_removed() {
        assert_eq!(strip_think("<think>hmm</think>Answer"), "Answer");
        assert_eq!(strip_think("A <think>x</think> B <think>y</think>C"), "A  B C");
        assert_eq!(strip_think("reasoning here</think>\n\nThe answer"), "The answer");
        assert_eq!(strip_think("Start <think>never closed"), "Start");
        assert_eq!(strip_think("plain"), "plain");
        assert_eq!(strip_think("<think></think>"), "");
    }

    #[test]
    fn streaming_prefix_hides_thinking_and_calls() {
        assert_eq!(visible_prefix("<thi", false), "");
        assert_eq!(visible_prefix("<think>abc", false), "");
        assert_eq!(visible_prefix("<think>abc</think>Hel", false), "Hel");
        assert_eq!(visible_prefix("Sure. <tool_call>{\"name\"", false), "Sure. ");
        assert_eq!(visible_prefix("Sure. <tool_", false), "Sure. ");
        assert_eq!(visible_prefix("Let me look.\nAction: read_file {", true), "Let me look.\n");
        assert_eq!(visible_prefix("Let me look.\nAction: read_file {", false), "Let me look.\nAction: read_file {");
    }

    #[test]
    fn tool_call_tags_are_parsed() {
        let text = "I'll read it.\n<tool_call>\n{\"name\": \"read_file\", \"arguments\": {\"path\": \"main.tex\"}}\n</tool_call>";
        let (rest, calls) = extract_text_calls(text, TOOLS);
        assert_eq!(rest, "I'll read it.");
        assert_eq!(calls.len(), 1);
        assert_eq!(calls[0].name, "read_file");
        assert_eq!(repair_json(&calls[0].arguments).unwrap(), json!({"path": "main.tex"}));

        // Two calls, the second one unclosed and with a trailing comma.
        let text = "<tool_call>{\"name\":\"compile_check\",\"arguments\":{}}</tool_call><tool_call>{\"name\":\"read_file\",\"arguments\":{\"path\":\"a.tex\",}";
        let (_, calls) = extract_text_calls(text, TOOLS);
        assert_eq!(calls.len(), 2);
        assert_eq!(repair_json(&calls[1].arguments).unwrap(), json!({"path": "a.tex"}));
    }

    #[test]
    fn xml_function_form_is_parsed() {
        let text = "<tool_call>\n<function=edit_file>\n<parameter=path>\nmain.tex\n</parameter>\n<parameter=old>\n\\beign{document}\n</parameter>\n<parameter=new>\n\\begin{document}\n</parameter>\n</function>\n</tool_call>";
        let (rest, calls) = extract_text_calls(text, TOOLS);
        assert_eq!(rest, "");
        assert_eq!(calls[0].name, "edit_file");
        let args = repair_json(&calls[0].arguments).unwrap();
        assert_eq!(args["path"], "main.tex");
        assert_eq!(args["old"], "\\beign{document}");
    }

    #[test]
    fn fenced_and_bare_json_calls() {
        let text = "Here:\n```json\n{\"name\": \"read_file\", \"arguments\": {\"path\": \"x.tex\"}}\n```";
        let (rest, calls) = extract_text_calls(text, TOOLS);
        assert_eq!(rest, "Here:");
        assert_eq!(calls[0].name, "read_file");

        let (rest, calls) = extract_text_calls("{\"name\": \"compile_check\", \"parameters\": {}}", TOOLS);
        assert_eq!(rest, "");
        assert_eq!(calls[0].name, "compile_check");

        let (_, calls) = extract_text_calls(
            "[{\"function\": {\"name\": \"read_file\", \"arguments\": \"{\\\"path\\\": \\\"b.tex\\\"}\"}}]",
            TOOLS,
        );
        assert_eq!(repair_json(&calls[0].arguments).unwrap(), json!({"path": "b.tex"}));

        // Unknown names and ordinary JSON are left alone.
        let text = "The config is {\"name\": \"paper\", \"arguments\": 3}";
        let (rest, calls) = extract_text_calls(text, TOOLS);
        assert!(calls.is_empty());
        assert_eq!(rest, text);
    }

    #[test]
    fn react_actions_are_parsed() {
        let text = "Thought: check the file\nAction: read_file {\"path\": \"main.tex\"}\n";
        let (rest, calls) = extract_text_calls(text, TOOLS);
        assert_eq!(rest, "Thought: check the file");
        assert_eq!(calls[0].name, "read_file");
        assert_eq!(repair_json(&calls[0].arguments).unwrap(), json!({"path": "main.tex"}));

        let text = "Action: edit_file\nAction Input: {\"path\": \"a\",\n \"old\": \"x\", \"new\": \"y\"}\n";
        let (_, calls) = extract_text_calls(text, TOOLS);
        assert_eq!(repair_json(&calls[0].arguments).unwrap(), json!({"path": "a", "old": "x", "new": "y"}));

        let (_, calls) = extract_text_calls("Action: compile_check", TOOLS);
        assert_eq!(calls[0].arguments, "{}");
        assert!(extract_text_calls("Action: dance {}", TOOLS).1.is_empty());
    }

    #[test]
    fn doubled_and_decorated_names_resolve() {
        assert_eq!(resolve_tool_name("read_fileread_file", TOOLS).as_deref(), Some("read_file"));
        assert_eq!(resolve_tool_name("compile_checkcompile_checkcompile_check", TOOLS).as_deref(), Some("compile_check"));
        assert_eq!(resolve_tool_name("functions.edit_file", TOOLS).as_deref(), Some("edit_file"));
        assert_eq!(resolve_tool_name("Read_File", TOOLS).as_deref(), Some("read_file"));
        assert_eq!(resolve_tool_name("\"read_file\"", TOOLS).as_deref(), Some("read_file"));
        assert_eq!(resolve_tool_name("read_file<|channel|>commentary", TOOLS).as_deref(), Some("read_file"));
        assert_eq!(resolve_tool_name("read_files", TOOLS), None);
        assert_eq!(resolve_tool_name("", TOOLS), None);
    }

    #[test]
    fn json_is_repaired() {
        assert_eq!(repair_json("{\"a\": 1}").unwrap(), json!({"a": 1}));
        assert_eq!(repair_json("```json\n{\"a\": 1}\n```").unwrap(), json!({"a": 1}));
        assert_eq!(repair_json("{\"a\": [1, 2,],}").unwrap(), json!({"a": [1, 2]}));
        assert_eq!(repair_json("{\"a\": {\"b\": \"c").unwrap(), json!({"a": {"b": "c"}}));
        assert_eq!(repair_json("{\"a\": 1,").unwrap(), json!({"a": 1}));
        assert_eq!(repair_json("Sure! {\"a\": \"x, y\"} done").unwrap(), json!({"a": "x, y"}));
        assert_eq!(repair_json("\"{\\\"a\\\": 2}\"").unwrap(), json!({"a": 2}));
        assert_eq!(repair_json("{\"s\": \"brace } inside, ]\",}").unwrap(), json!({"s": "brace } inside, ]"}));
        assert!(repair_json("not json at all").is_none());
        assert!(repair_json("").is_none());
    }

    #[test]
    fn open_strings_are_detected() {
        assert!(ends_in_open_string("{\"path\": \"main.tex\", \"text\": \"\\documentclass"));
        assert!(ends_in_open_string("{\"a\": \"x\\\""));
        assert!(!ends_in_open_string("{\"a\": {\"b\": 1"));
        assert!(!ends_in_open_string("{\"a\": \"x\"}"));
        assert!(!ends_in_open_string("{\"a\": \"x\"} then \"open"));
        assert!(!ends_in_open_string("no json"));
    }

    #[test]
    fn react_text_after_the_action_is_dropped() {
        let text = "Checking.\nAction: compile_check {}\nObservation: compiled fine\nAll errors are fixed.\nAction: read_file {\"path\": \"x\"}\n";
        let (rest, calls) = extract_text_calls(text, TOOLS);
        assert_eq!(rest, "Checking.");
        assert_eq!(calls.len(), 1);
        assert_eq!(calls[0].name, "compile_check");
        // Consecutive Action lines are parallel calls.
        let (_, calls) = extract_text_calls("Action: compile_check {}\n\nAction: read_file {\"path\": \"a\"}", TOOLS);
        assert_eq!(calls.len(), 2);
    }

    #[test]
    fn balanced_end_skips_strings() {
        assert_eq!(balanced_end("{\"a\":\"}\"} tail", 0), Some(9));
        assert_eq!(balanced_end("{\"a\":", 0), None);
    }
}
