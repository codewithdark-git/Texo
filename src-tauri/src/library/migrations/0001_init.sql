-- Texo paper library, schema version 1. Times are Unix milliseconds.

CREATE TABLE papers(
  id INTEGER PRIMARY KEY,
  uid TEXT UNIQUE NOT NULL,
  title TEXT NOT NULL,
  title_norm TEXT NOT NULL,
  first_author_norm TEXT,
  authors_json TEXT NOT NULL DEFAULT '[]',
  authors_text TEXT NOT NULL DEFAULT '',
  abstract TEXT,
  tldr TEXT,
  year INTEGER,
  venue TEXT,
  work_type TEXT,
  volume TEXT,
  issue TEXT,
  pages TEXT,
  publisher TEXT,
  citation_count INTEGER,
  influential_count INTEGER,
  counts_updated_at INTEGER,
  is_oa INTEGER,
  oa_status TEXT,
  oa_pdf_url TEXT,
  landing_url TEXT,
  extra_json TEXT,
  note TEXT,
  -- NULL: seen only (cache-like); otherwise the paper is in "Saved".
  saved_at INTEGER,
  -- A possible duplicate of another row, never merged automatically.
  dup_of INTEGER REFERENCES papers(id),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL
);
CREATE INDEX papers_title_year ON papers(title_norm, year);

CREATE TABLE paper_ids(
  paper_id INTEGER NOT NULL REFERENCES papers ON DELETE CASCADE,
  scheme TEXT NOT NULL CHECK(scheme IN('doi','arxiv','s2','corpus','openalex','pmid','dblp')),
  value TEXT NOT NULL,
  PRIMARY KEY(scheme, value)
);
CREATE INDEX paper_ids_paper ON paper_ids(paper_id);

CREATE TABLE paper_sources(
  paper_id INTEGER NOT NULL REFERENCES papers ON DELETE CASCADE,
  source TEXT NOT NULL,
  source_id TEXT NOT NULL,
  fetched_at INTEGER NOT NULL,
  citation_count INTEGER,
  PRIMARY KEY(source, source_id)
);
CREATE INDEX paper_sources_paper ON paper_sources(paper_id);

CREATE TABLE tags(id INTEGER PRIMARY KEY, name TEXT UNIQUE NOT NULL, color TEXT);
CREATE TABLE paper_tags(
  paper_id INTEGER REFERENCES papers ON DELETE CASCADE,
  tag_id INTEGER REFERENCES tags ON DELETE CASCADE,
  PRIMARY KEY(paper_id, tag_id)
);

CREATE TABLE projects(id INTEGER PRIMARY KEY, path TEXT UNIQUE NOT NULL, name TEXT);
CREATE TABLE project_refs(
  project_id INTEGER NOT NULL REFERENCES projects ON DELETE CASCADE,
  paper_id INTEGER NOT NULL REFERENCES papers ON DELETE CASCADE,
  cite_key TEXT,
  bib_file TEXT,
  in_bib INTEGER NOT NULL DEFAULT 0,
  verify_status TEXT,
  verify_note TEXT,
  verified_at INTEGER,
  -- 'user' | 'agent:<run_id>' | 'bib-scan'
  added_by TEXT,
  added_at INTEGER NOT NULL,
  PRIMARY KEY(project_id, paper_id)
);
CREATE UNIQUE INDEX project_refs_key ON project_refs(project_id, cite_key) WHERE cite_key IS NOT NULL;
CREATE INDEX project_refs_paper ON project_refs(paper_id);

CREATE TABLE run_finds(
  run_id TEXT NOT NULL,
  project_id INTEGER REFERENCES projects ON DELETE CASCADE,
  paper_id INTEGER NOT NULL REFERENCES papers ON DELETE CASCADE,
  tool TEXT,
  at INTEGER NOT NULL,
  PRIMARY KEY(run_id, paper_id)
);
CREATE INDEX run_finds_paper ON run_finds(paper_id);

CREATE TABLE search_cache(
  key TEXT PRIMARY KEY,
  source TEXT NOT NULL,
  body TEXT NOT NULL,
  bytes INTEGER NOT NULL,
  fetched_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  hit_at INTEGER NOT NULL
);
CREATE INDEX search_cache_exp ON search_cache(expires_at);
CREATE INDEX search_cache_hit ON search_cache(hit_at);

CREATE VIRTUAL TABLE papers_fts USING fts5(
  title, authors_text, abstract, tldr, venue,
  content='papers', content_rowid='id',
  tokenize='porter unicode61 remove_diacritics 2', prefix='2 3'
);

-- Keep the full-text index in step with `papers` (external-content pattern).
CREATE TRIGGER papers_fts_ai AFTER INSERT ON papers BEGIN
  INSERT INTO papers_fts(rowid, title, authors_text, abstract, tldr, venue)
  VALUES (new.id, new.title, new.authors_text, new.abstract, new.tldr, new.venue);
END;
CREATE TRIGGER papers_fts_ad AFTER DELETE ON papers BEGIN
  INSERT INTO papers_fts(papers_fts, rowid, title, authors_text, abstract, tldr, venue)
  VALUES ('delete', old.id, old.title, old.authors_text, old.abstract, old.tldr, old.venue);
END;
CREATE TRIGGER papers_fts_au AFTER UPDATE OF title, authors_text, abstract, tldr, venue ON papers BEGIN
  INSERT INTO papers_fts(papers_fts, rowid, title, authors_text, abstract, tldr, venue)
  VALUES ('delete', old.id, old.title, old.authors_text, old.abstract, old.tldr, old.venue);
  INSERT INTO papers_fts(rowid, title, authors_text, abstract, tldr, venue)
  VALUES (new.id, new.title, new.authors_text, new.abstract, new.tldr, new.venue);
END;
