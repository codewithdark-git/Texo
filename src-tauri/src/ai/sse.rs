//! Server-sent events over the shared HTTP plumbing: sends a request with
//! `stream: true` and hands each event to a callback as it arrives. A
//! server that answers with plain JSON instead (it ignored `stream`) or with
//! an error status is read whole and returned as an ordinary reply.

// Used by the agents runtime and the chat (v1.2); until those land, parts
// of this module are only reached from tests.

use std::time::Duration;

use reqwest::RequestBuilder;

use super::error::{AiError, AiResult, Kind};
use super::http::{map_transport, Cancel, Reply};

const MAX_STREAM_BYTES: usize = 8 * 1024 * 1024;

/// One event: the `event:` name (empty when absent) and the joined `data:`.
#[derive(Debug, Clone, PartialEq)]
pub struct Event {
    pub event: String,
    pub data: String,
}

pub enum Outcome {
    /// The reply was an event stream; every event went to the callback.
    Streamed,
    /// Not a stream: an error status, or JSON from a server that doesn't
    /// stream. The body was read whole.
    Whole(Reply),
}

/// Splits SSE text into events. Feed bytes with [`Parser::push`]; call
/// [`Parser::finish`] at the end for an event without a closing blank line.
#[derive(Default)]
pub struct Parser {
    buf: Vec<u8>,
    event: String,
    data: Vec<String>,
}

impl Parser {
    pub fn push(&mut self, bytes: &[u8], out: &mut Vec<Event>) {
        self.buf.extend_from_slice(bytes);
        while let Some(nl) = self.buf.iter().position(|b| *b == b'\n') {
            let line: Vec<u8> = self.buf.drain(..=nl).collect();
            let line = String::from_utf8_lossy(&line);
            self.line(line.trim_end_matches(['\n', '\r']), out);
        }
    }

    pub fn finish(&mut self, out: &mut Vec<Event>) {
        if !self.buf.is_empty() {
            let rest = std::mem::take(&mut self.buf);
            let line = String::from_utf8_lossy(&rest).into_owned();
            self.line(line.trim_end_matches(['\n', '\r']), out);
        }
        self.dispatch(out);
    }

    fn line(&mut self, line: &str, out: &mut Vec<Event>) {
        if line.is_empty() {
            self.dispatch(out);
            return;
        }
        if line.starts_with(':') {
            return; // comment / keep-alive
        }
        let (field, value) = match line.split_once(':') {
            Some((f, v)) => (f, v.strip_prefix(' ').unwrap_or(v)),
            None => (line, ""),
        };
        match field {
            "event" => self.event = value.to_string(),
            "data" => self.data.push(value.to_string()),
            _ => {}
        }
    }

    fn dispatch(&mut self, out: &mut Vec<Event>) {
        if !self.data.is_empty() {
            out.push(Event { event: std::mem::take(&mut self.event), data: self.data.join("\n") });
        }
        self.event.clear();
        self.data.clear();
    }
}

/// Sends `req` and streams the events to `on_event`. An error returned by
/// the callback stops the stream and is passed on.
pub async fn send(
    req: RequestBuilder,
    timeout: Duration,
    cancel: &Cancel,
    label: &str,
    on_event: &mut (dyn FnMut(Event) -> AiResult<()> + Send),
) -> AiResult<Outcome> {
    cancel
        .run(async {
            let mut resp = req
                .header("accept", "text/event-stream")
                .timeout(timeout)
                .send()
                .await
                .map_err(|e| map_transport(&e, label))?;
            let status = resp.status();
            let headers = resp.headers().clone();
            let is_stream = headers
                .get("content-type")
                .and_then(|v| v.to_str().ok())
                .is_some_and(|v| v.to_ascii_lowercase().contains("text/event-stream"));
            let too_large = || AiError::new(Kind::BadResponse, format!("{label} sent an unexpectedly large reply."));
            if !status.is_success() || !is_stream {
                let mut body = Vec::new();
                while let Some(chunk) = resp.chunk().await.map_err(|e| map_transport(&e, label))? {
                    if body.len() + chunk.len() > MAX_STREAM_BYTES {
                        return Err(too_large());
                    }
                    body.extend_from_slice(&chunk);
                }
                return Ok(Outcome::Whole(Reply { status, headers, body: String::from_utf8_lossy(&body).into_owned() }));
            }
            let mut parser = Parser::default();
            let mut total = 0usize;
            let mut events = Vec::new();
            while let Some(chunk) = resp.chunk().await.map_err(|e| map_transport(&e, label))? {
                total += chunk.len();
                if total > MAX_STREAM_BYTES {
                    return Err(too_large());
                }
                parser.push(&chunk, &mut events);
                for ev in events.drain(..) {
                    on_event(ev)?;
                }
            }
            parser.finish(&mut events);
            for ev in events.drain(..) {
                on_event(ev)?;
            }
            Ok(Outcome::Streamed)
        })
        .await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_events_across_chunks() {
        let mut p = Parser::default();
        let mut out = Vec::new();
        p.push(b"event: message_start\ndata: {\"a\"", &mut out);
        assert!(out.is_empty());
        p.push(b":1}\n\n: keep-alive\n\ndata: one\r\ndata: two\r\n\r\ndata: [DONE]", &mut out);
        p.finish(&mut out);
        assert_eq!(
            out,
            vec![
                Event { event: "message_start".into(), data: "{\"a\":1}".into() },
                Event { event: String::new(), data: "one\ntwo".into() },
                Event { event: String::new(), data: "[DONE]".into() },
            ]
        );
    }

    #[test]
    fn utf8_split_across_chunks_survives() {
        let mut p = Parser::default();
        let mut out = Vec::new();
        let text = "data: café\n\n".as_bytes();
        let (a, b) = text.split_at(9); // inside "é"
        p.push(a, &mut out);
        p.push(b, &mut out);
        assert_eq!(out[0].data, "café");
    }
}
