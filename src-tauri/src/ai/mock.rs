//! A tiny local HTTP server for tests: it answers each request with the next
//! canned reply and records what it received. No real keys or network.

use std::io::{BufRead, BufReader, Read, Write};
use std::net::TcpListener;
use std::sync::{Arc, Mutex};
use std::thread;

#[derive(Clone, Debug)]
pub struct Recorded {
    pub method: String,
    pub path: String,
    /// Header names are lowercased.
    pub headers: Vec<(String, String)>,
    pub body: String,
}

impl Recorded {
    pub fn header(&self, name: &str) -> Option<&str> {
        self.headers.iter().find(|(k, _)| k == name).map(|(_, v)| v.as_str())
    }
    pub fn json(&self) -> serde_json::Value {
        serde_json::from_str(&self.body).unwrap()
    }
}

pub struct Canned {
    pub status: u16,
    pub headers: Vec<(&'static str, String)>,
    pub body: String,
    /// Wait this long before answering (for timeout and cancel tests).
    pub delay_ms: u64,
    pub content_type: &'static str,
    /// When set, the body is sent in these pieces (no content-length; the
    /// connection closes at the end), `chunk_delay_ms` apart. For SSE.
    pub chunks: Vec<String>,
    pub chunk_delay_ms: u64,
}

impl Canned {
    pub fn json(status: u16, body: serde_json::Value) -> Self {
        Canned {
            status,
            headers: Vec::new(),
            body: body.to_string(),
            delay_ms: 0,
            content_type: "application/json",
            chunks: Vec::new(),
            chunk_delay_ms: 0,
        }
    }
    /// A server-sent event stream: each item is one event's `data:` JSON
    /// (or a full pre-formatted `event: …` block when it starts with
    /// `event:`), sent as its own chunk.
    pub fn sse(events: Vec<String>) -> Self {
        let chunks = events
            .into_iter()
            .map(|e| if e.starts_with("event:") || e.starts_with(':') { format!("{e}\n\n") } else { format!("data: {e}\n\n") })
            .collect();
        Canned {
            status: 200,
            headers: Vec::new(),
            body: String::new(),
            delay_ms: 0,
            content_type: "text/event-stream",
            chunks,
            chunk_delay_ms: 0,
        }
    }
    pub fn chunk_delay(mut self, ms: u64) -> Self {
        self.chunk_delay_ms = ms;
        self
    }
    pub fn header(mut self, name: &'static str, value: &str) -> Self {
        self.headers.push((name, value.to_string()));
        self
    }
    pub fn delay(mut self, ms: u64) -> Self {
        self.delay_ms = ms;
        self
    }
}

pub struct MockServer {
    pub base_url: String,
    pub requests: Arc<Mutex<Vec<Recorded>>>,
}

impl MockServer {
    /// Serves `replies` in order, one per connection.
    pub fn start(replies: Vec<Canned>) -> MockServer {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        let requests = Arc::new(Mutex::new(Vec::new()));
        let log = requests.clone();
        thread::spawn(move || {
            for reply in replies {
                let Ok((stream, _)) = listener.accept() else { return };
                let mut reader = BufReader::new(stream.try_clone().unwrap());
                let mut line = String::new();
                if reader.read_line(&mut line).is_err() {
                    continue;
                }
                let mut parts = line.split_whitespace();
                let method = parts.next().unwrap_or_default().to_string();
                let path = parts.next().unwrap_or_default().to_string();
                let mut headers = Vec::new();
                let mut length = 0usize;
                loop {
                    let mut h = String::new();
                    if reader.read_line(&mut h).is_err() || h.trim().is_empty() {
                        break;
                    }
                    if let Some((k, v)) = h.split_once(':') {
                        let k = k.trim().to_ascii_lowercase();
                        let v = v.trim().to_string();
                        if k == "content-length" {
                            length = v.parse().unwrap_or(0);
                        }
                        headers.push((k, v));
                    }
                }
                let mut body = vec![0u8; length];
                let _ = reader.read_exact(&mut body);
                log.lock().unwrap().push(Recorded {
                    method,
                    path,
                    headers,
                    body: String::from_utf8_lossy(&body).into_owned(),
                });
                if reply.delay_ms > 0 {
                    thread::sleep(std::time::Duration::from_millis(reply.delay_ms));
                }
                let mut out = stream;
                let mut head = format!("HTTP/1.1 {} X\r\ncontent-type: {}\r\n", reply.status, reply.content_type);
                if reply.chunks.is_empty() {
                    head.push_str(&format!("content-length: {}\r\n", reply.body.len()));
                }
                head.push_str("connection: close\r\n");
                for (k, v) in &reply.headers {
                    head.push_str(&format!("{k}: {v}\r\n"));
                }
                head.push_str("\r\n");
                let _ = out.write_all(head.as_bytes());
                if reply.chunks.is_empty() {
                    let _ = out.write_all(reply.body.as_bytes());
                } else {
                    for chunk in &reply.chunks {
                        if out.write_all(chunk.as_bytes()).is_err() {
                            break;
                        }
                        let _ = out.flush();
                        if reply.chunk_delay_ms > 0 {
                            thread::sleep(std::time::Duration::from_millis(reply.chunk_delay_ms));
                        }
                    }
                }
                let _ = out.flush();
            }
        });
        MockServer { base_url: format!("http://{addr}"), requests }
    }

    pub fn recorded(&self) -> Vec<Recorded> {
        self.requests.lock().unwrap().clone()
    }
}

pub fn runtime() -> tokio::runtime::Runtime {
    tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap()
}
