//! A token bucket per provider (and server address), so parallel agent runs
//! stay under the provider's request limit instead of collecting 429s.
//! NVIDIA's free tier allows about 40 requests a minute; Texo aims for 35.

// Used by the agents runtime and the chat (v1.2); until those land, parts
// of this module are only reached from tests.

use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use super::error::AiResult;
use super::http::Cancel;
use super::providers::ProviderId;

/// Requests per minute Texo allows itself, or `None` for no limit (a custom
/// server, usually on this computer).
pub fn per_minute(provider: ProviderId) -> Option<u32> {
    match provider {
        ProviderId::Nvidia => Some(35),
        ProviderId::Groq => Some(30),
        ProviderId::Openrouter => Some(20),
        ProviderId::Gemini => Some(15),
        ProviderId::Anthropic => Some(50),
        ProviderId::Custom => None,
    }
}

#[derive(Debug, Clone)]
pub struct Bucket {
    capacity: f64,
    tokens: f64,
    per_sec: f64,
    last: Instant,
}

impl Bucket {
    /// A full bucket. Bursts are limited to a sixth of a minute's allowance
    /// (at least 2) so parallel runs spread out.
    pub fn new(per_minute: u32, now: Instant) -> Self {
        let capacity = (f64::from(per_minute) / 6.0).max(2.0).min(f64::from(per_minute.max(1)));
        Bucket { capacity, tokens: capacity, per_sec: f64::from(per_minute) / 60.0, last: now }
    }

    /// Takes a token if one is there; otherwise says how long until one is.
    /// A request that has to wait reserves its token, so waiters queue up
    /// instead of all firing together.
    pub fn take(&mut self, now: Instant) -> Option<Duration> {
        let elapsed = now.saturating_duration_since(self.last).as_secs_f64();
        self.tokens = (self.tokens + elapsed * self.per_sec).min(self.capacity);
        self.last = now;
        self.tokens -= 1.0;
        if self.tokens >= 0.0 {
            None
        } else {
            Some(Duration::from_secs_f64(-self.tokens / self.per_sec))
        }
    }
}

fn buckets() -> &'static Mutex<HashMap<String, Bucket>> {
    static B: OnceLock<Mutex<HashMap<String, Bucket>>> = OnceLock::new();
    B.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Waits (cancellably) until a request to `provider` at `base_url` may go.
pub async fn acquire(provider: ProviderId, base_url: &str, cancel: &Cancel) -> AiResult<()> {
    let Some(rate) = per_minute(provider) else { return cancel.check() };
    let key = format!("{}|{}", provider.as_str(), base_url);
    let wait = {
        let mut map = buckets().lock().unwrap_or_else(|e| e.into_inner());
        let now = Instant::now();
        map.entry(key).or_insert_with(|| Bucket::new(rate, now)).take(now)
    };
    match wait {
        Some(d) => {
            cancel
                .run(async {
                    tokio::time::sleep(d).await;
                    Ok(())
                })
                .await
        }
        None => cancel.check(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bucket_allows_a_burst_then_paces() {
        let t0 = Instant::now();
        let mut b = Bucket::new(36, t0);
        // Burst of 6 (36 / 6).
        for _ in 0..6 {
            assert_eq!(b.take(t0), None);
        }
        // The 7th waits about one refill interval (60 / 36 s).
        let w = b.take(t0).unwrap();
        assert!((w.as_secs_f64() - 60.0 / 36.0).abs() < 0.01, "{w:?}");
        // The 8th queues behind it.
        let w2 = b.take(t0).unwrap();
        assert!(w2 > w);
        // After a minute, the bucket is full again.
        let later = t0 + Duration::from_secs(60);
        assert_eq!(b.take(later), None);
    }

    #[test]
    fn custom_servers_are_not_limited() {
        assert_eq!(per_minute(ProviderId::Custom), None);
        assert_eq!(per_minute(ProviderId::Nvidia), Some(35));
    }

    #[test]
    fn acquire_respects_cancel() {
        let rt = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
        rt.block_on(async {
            let c = Cancel::default();
            assert!(acquire(ProviderId::Nvidia, "http://bucket-test", &c).await.is_ok());
            c.cancel();
            assert!(acquire(ProviderId::Nvidia, "http://bucket-test", &c).await.is_err());
        });
    }
}
