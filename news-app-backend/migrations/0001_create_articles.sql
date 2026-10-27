-- News articles collected and scored by the News Intelligence App.
CREATE TABLE IF NOT EXISTS articles (
	id              INTEGER PRIMARY KEY AUTOINCREMENT,
	topic           TEXT    NOT NULL,
	headline        TEXT    NOT NULL,
	source          TEXT,
	published_at    TEXT,                              -- ISO-8601 publication date
	url             TEXT    NOT NULL UNIQUE,
	summary         TEXT,                              -- AI-generated summary
	relevance_score INTEGER CHECK (relevance_score BETWEEN 1 AND 10),
	fetched_at      TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_articles_topic_published ON articles (topic, published_at DESC);
