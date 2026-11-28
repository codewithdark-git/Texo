//! A persistent cache of paper-service responses (`search_cache`), so a
//! restart doesn't go back to the network. Entries expire by TTL, and the
//! table is kept under [`MAX_BYTES`] by dropping the least recently used.

use std::time::Duration;

use rusqlite::{params, Connection, OptionalExtension};

use super::LibResult;

/// The cache never grows past this.
pub const MAX_BYTES: i64 = 100 * 1024 * 1024;

// TTLs for the online search pipeline.
#[allow(dead_code)]
pub const SEARCH_TTL: Duration = Duration::from_secs(24 * 60 * 60);
#[allow(dead_code)]
pub const PAPER_TTL: Duration = Duration::from_secs(14 * 24 * 60 * 60);
#[allow(dead_code)]
pub const BIBTEX_TTL: Duration = Duration::from_secs(14 * 24 * 60 * 60);
#[allow(dead_code)]
pub const COUNTS_TTL: Duration = Duration::from_secs(7 * 24 * 60 * 60);

/// The cache key for one request: an FNV-1a hash of
/// `source|normalised query|params`. Callers pass only the query and its
/// options, never a key or e-mail address, so neither can end up here.
#[allow(dead_code)] // used by the online search pipeline
pub fn cache_key(source: &str, query: &str, params: &str) -> String {
    let query = query.split_whitespace().collect::<Vec<_>>().join(" ").to_lowercase();
    let text = format!("{}|{query}|{params}", source.to_lowercase());
    crate::agents::types::text_hash(Some(&text))
}

/// The cached body, if it hasn't expired. A hit counts as a use for LRU.
#[allow(dead_code)] // used by the online search pipeline
pub fn get(conn: &Connection, source: &str, key: &str, now: i64) -> LibResult<Option<String>> {
    let body: Option<String> = conn
        .query_row(
            "SELECT body FROM search_cache WHERE key = ?1 AND source = ?2 AND expires_at > ?3",
            params![key, source, now],
            |r| r.get(0),
        )
        .optional()?;
    if body.is_some() {
        conn.execute("UPDATE search_cache SET hit_at = ?2 WHERE key = ?1", params![key, now])?;
    }
    Ok(body)
}

/// Stores a body for `ttl`, replacing any older one, then keeps the cache
/// under `MAX_BYTES`.
#[allow(dead_code)] // used by the online search pipeline
pub fn put(conn: &Connection, source: &str, key: &str, body: &str, ttl: Duration, now: i64) -> LibResult<()> {
    put_capped(conn, source, key, body, ttl, now, MAX_BYTES)
}

pub(crate) fn put_capped(
    conn: &Connection,
    source: &str,
    key: &str,
    body: &str,
    ttl: Duration,
    now: i64,
    cap: i64,
) -> LibResult<()> {
    let bytes = body.len() as i64;
    if bytes > cap {
        return Ok(());
    }
    let expires = now.saturating_add(ttl.as_millis().min(i64::MAX as u128) as i64);
    conn.execute(
        "INSERT INTO search_cache(key, source, body, bytes, fetched_at, expires_at, hit_at) \
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?5) \
         ON CONFLICT(key) DO UPDATE SET source = excluded.source, body = excluded.body, bytes = excluded.bytes, \
         fetched_at = excluded.fetched_at, expires_at = excluded.expires_at, hit_at = excluded.hit_at",
        params![key, source, body, bytes, now, expires],
    )?;
    evict(conn, now, cap)
}

/// Drops expired entries, then the least recently used (soonest to expire
/// first among equals) until the cache fits in `cap`.
fn evict(conn: &Connection, now: i64, cap: i64) -> LibResult<()> {
    let (_, total) = size(conn)?;
    if total <= cap {
        return Ok(());
    }
    conn.execute("DELETE FROM search_cache WHERE expires_at <= ?1", params![now])?;
    let (_, mut total) = size(conn)?;
    if total <= cap {
        return Ok(());
    }
    let victims: Vec<(String, i64)> = {
        let mut stmt = conn.prepare("SELECT key, bytes FROM search_cache ORDER BY hit_at ASC, expires_at ASC")?;
        let rows = stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?;
        rows.collect::<Result<_, _>>()?
    };
    for (key, bytes) in victims {
        if total <= cap {
            break;
        }
        conn.execute("DELETE FROM search_cache WHERE key = ?1", params![key])?;
        total -= bytes;
    }
    Ok(())
}

pub fn clear(conn: &Connection) -> LibResult<()> {
    conn.execute("DELETE FROM search_cache", [])?;
    Ok(())
}

/// (entries, bytes).
pub fn size(conn: &Connection) -> LibResult<(i64, i64)> {
    Ok(conn.query_row("SELECT count(*), coalesce(sum(bytes), 0) FROM search_cache", [], |r| Ok((r.get(0)?, r.get(1)?)))?)
}
