import Anthropic from "@anthropic-ai/sdk";
import { type ArticleForIndex, deleteArticleVectors, indexArticles } from "./embeddings";
import { AGENT_MODEL } from "./models";

export const TOPICS = [
	"Healthcare IT & interoperability",
	"AI in healthcare",
	"Artificial intelligence",
	"Data platforms & cloud",
	"Stock & market news",
] as const;

export type Topic = (typeof TOPICS)[number];

interface TopicFocus {
	/** Narrows what the web search looks for. */
	search: string;
	/** What relevance_score measures for this topic. */
	relevance: string;
	/** Appended to the summary instruction. */
	summary?: string;
}

// Extra guidance for topics whose name alone is too broad.
const TOPIC_FOCUS: Partial<Record<Topic, TopicFocus>> = {
	// Tracks news that could move these Vanguard funds. Informational only, not investment advice.
	"Stock & market news": {
		search: `news likely to affect these Vanguard funds:
  - VTI (Total Stock Market ETF): the whole US stock market
  - VTV (Value ETF): US large-cap value stocks, heavy in financials, healthcare, industrials, energy and consumer staples, and their largest holdings
  - VXUS (Total International Stock ETF): developed and emerging markets outside the US
  - VASGX (LifeStrategy Growth Fund): about 80% US and international stocks and 20% US and international bonds
Relevant: broad US and international market moves; Federal Reserve and interest-rate decisions; Treasury yields and bond markets; inflation, jobs and GDP data; earnings or major events at the largest holdings of these funds; moves in value sectors; the US dollar and currencies; major foreign economies (Europe, Japan, China, emerging markets); trade policy and tariffs; and Vanguard announcements about these funds (fees, distributions, changes).
Skip news about small individual companies, single stocks with little weight in these funds, crypto, and investment advice or stock picks`,
		relevance: "how much the news could affect VTI, VTV, VXUS or VASGX",
		summary: "End the summary with which of VTI, VTV, VXUS and VASGX it most affects, and why, in a few words.",
	},
};

export function isTopic(value: unknown): value is Topic {
	return typeof value === "string" && (TOPICS as readonly string[]).includes(value);
}

const MAX_ARTICLES_PER_TOPIC = 20;
// A web search turn can pause server-side after 10 iterations; resume a few times at most.
const MAX_PAUSE_RESUMES = 3;

export interface CandidateArticle {
	headline: string;
	source: string | null;
	published_date: string | null;
	url: string;
	summary: string | null;
	relevance_score: number | null;
}

export interface TopicResult {
	topic: string;
	returned: number;
	inserted: number;
	skipped: number;
	invalid: number;
	removed: number;
	error?: string;
	/** Set if the articles were stored but the semantic index couldn't be updated. */
	vector_error?: string;
}

export interface AgentResult {
	inserted: number;
	skipped: number;
	total_returned: number;
	topics: TopicResult[];
	started_at: string;
	finished_at: string;
}

/** Runs the pipeline for every topic, or only the ones given. */
export async function runAgent(env: Env, only: readonly Topic[] = TOPICS): Promise<AgentResult> {
	const startedAt = new Date().toISOString();
	const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });

	// Topics are independent, so run them concurrently to keep the request short.
	const topics = await Promise.all(
		only.map((topic) =>
			runTopic(client, env, topic).catch(
				(err): TopicResult => ({
					topic,
					returned: 0,
					inserted: 0,
					skipped: 0,
					invalid: 0,
					removed: 0,
					error: err instanceof Error ? err.message : String(err),
				}),
			),
		),
	);

	return {
		inserted: sum(topics, "inserted"),
		skipped: sum(topics, "skipped"),
		total_returned: sum(topics, "returned"),
		topics,
		started_at: startedAt,
		finished_at: new Date().toISOString(),
	};
}

async function runTopic(client: Anthropic, env: Env, topic: string): Promise<TopicResult> {
	const db = env.DB;
	const known = await db
		.prepare("SELECT url FROM articles WHERE topic = ? ORDER BY published_at DESC LIMIT ?")
		.bind(topic, MAX_ARTICLES_PER_TOPIC)
		.all<{ url: string }>();

	const text = await searchNews(client, topic, known.results.map((r) => r.url));
	const raw = extractJsonArray(text);
	const { articles, invalid } = normalizeArticles(raw);
	const { inserted, removed, toIndex, removedIds } = await storeArticles(db, topic, articles);
	const vectorError = await syncVectors(env, toIndex, removedIds);

	return {
		topic,
		returned: raw.length,
		inserted,
		skipped: articles.length - inserted,
		invalid,
		removed,
		...(vectorError ? { vector_error: vectorError } : {}),
	};
}

export async function storeArticles(
	db: D1Database,
	topic: string,
	articles: CandidateArticle[],
): Promise<{ inserted: number; removed: number; toIndex: ArticleForIndex[]; removedIds: number[] }> {
	// Duplicate URLs inside one response count as skipped, same as URLs already stored.
	const seen = new Set<string>();
	const unique = articles.filter((a) => !seen.has(a.url) && seen.add(a.url));

	const insertedRows: ArticleForIndex[] = [];
	if (unique.length > 0) {
		// RETURNING yields a row only for articles actually inserted (not URL conflicts).
		const insert = db.prepare(
			`INSERT INTO articles (topic, headline, source, published_at, url, summary, relevance_score)
			 VALUES (?, ?, ?, ?, ?, ?, ?)
			 ON CONFLICT(url) DO NOTHING
			 RETURNING id, topic, headline, summary, source, published_at`,
		);
		const results = await db.batch<ArticleForIndex>(
			unique.map((a) =>
				insert.bind(topic, a.headline, a.source, a.published_date, a.url, a.summary, a.relevance_score),
			),
		);
		for (const r of results) insertedRows.push(...r.results);
	}

	// Keep only the newest articles per topic; undated articles are treated as oldest.
	const pruned = await db
		.prepare(
			`DELETE FROM articles WHERE topic = ?1 AND id NOT IN (
				SELECT id FROM articles WHERE topic = ?1
				ORDER BY published_at DESC NULLS LAST, fetched_at DESC, id DESC
				LIMIT ?2
			)
			RETURNING id`,
		)
		.bind(topic, MAX_ARTICLES_PER_TOPIC)
		.all<{ id: number }>();
	const removedIds = pruned.results.map((r) => r.id);
	const removedSet = new Set(removedIds);

	return {
		inserted: insertedRows.length,
		removed: removedIds.length,
		// An article can be inserted and pruned in the same run; it needs no vector.
		toIndex: insertedRows.filter((r) => !removedSet.has(r.id)),
		removedIds,
	};
}

/** Mirrors a topic's inserts and prunes into the vector index. Never fails the pipeline: D1 stays the source of truth. */
async function syncVectors(env: Env, toIndex: ArticleForIndex[], removedIds: number[]): Promise<string | undefined> {
	try {
		await Promise.all([indexArticles(env, toIndex), deleteArticleVectors(env, removedIds)]);
		return undefined;
	} catch (err) {
		console.error("Vector index sync failed", err);
		return err instanceof Error ? err.message : String(err);
	}
}

async function searchNews(client: Anthropic, topic: string, knownUrls: string[]): Promise<string> {
	const today = new Date().toISOString().slice(0, 10);
	const focus = isTopic(topic) ? TOPIC_FOCUS[topic] : undefined;
	const prompt = `Today is ${today}. Use web search to find the most important news articles about "${topic}" published in the last 7 days.${focus ? `\nFocus only on ${focus.search}.` : ""}

Return up to 10 distinct articles from reputable sources. For each one provide:
- headline: the article's headline
- source: the publication name
- published_date: publication date as YYYY-MM-DD, or null if unknown
- url: the canonical article URL
- summary: a 2-3 sentence summary of the article in your own words, describing only that article (readers see it on its own, so don't mention other articles, this request or what is already stored)${focus?.summary ? `. ${focus.summary}` : ""}
- relevance_score: an integer from 1 to 10 for ${focus ? focus.relevance : `how relevant and significant the article is to "${topic}"`}
${knownUrls.length > 0 ? `\nThese URLs are already stored, so skip them:\n${knownUrls.join("\n")}\n` : ""}
Respond with only a JSON array of objects with exactly those keys.`;

	const messages: Anthropic.Beta.BetaMessageParam[] = [{ role: "user", content: prompt }];
	let response: Anthropic.Beta.BetaMessage | undefined;

	for (let attempt = 0; attempt <= MAX_PAUSE_RESUMES; attempt++) {
		response = await client.beta.messages.create({
			model: AGENT_MODEL,
			max_tokens: 16000,
			output_config: { effort: "medium" },
			betas: ["server-side-fallback-2026-07-01"],
			fallbacks: "default",
			tools: [{ type: "web_search_20260209", name: "web_search", max_uses: 5 }],
			messages,
		});
		if (response.stop_reason !== "pause_turn") break;
		messages.push({ role: "assistant", content: response.content });
	}

	if (!response) throw new Error("No response from Claude");
	if (response.stop_reason === "refusal") {
		throw new Error(`Claude declined the request (${response.stop_details?.category ?? "unknown"})`);
	}
	if (response.stop_reason === "pause_turn") throw new Error("Web search did not finish");

	// Web search splits the answer across several text blocks, so join them all before parsing.
	return response.content
		.filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === "text")
		.map((b) => b.text)
		.join("");
}

export function extractJsonArray(text: string): unknown[] {
	const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
	const body = fenced?.[1] ?? text;
	const start = body.indexOf("[");
	const end = body.lastIndexOf("]");
	if (start === -1 || end <= start) throw new Error("Claude's response contained no JSON array");

	const parsed: unknown = JSON.parse(body.slice(start, end + 1));
	if (!Array.isArray(parsed)) throw new Error("Claude's response JSON was not an array");
	return parsed;
}

export function normalizeArticles(raw: unknown[]): { articles: CandidateArticle[]; invalid: number } {
	const articles: CandidateArticle[] = [];
	for (const item of raw) {
		if (typeof item !== "object" || item === null) continue;
		const r = item as Record<string, unknown>;
		const url = str(r.url);
		const headline = str(r.headline);
		if (!url || !headline || !/^https?:\/\//i.test(url)) continue;

		const date = str(r.published_date);
		const score = Number(r.relevance_score);
		articles.push({
			headline,
			source: str(r.source),
			published_date: date && /^\d{4}-\d{2}-\d{2}/.test(date) ? date.slice(0, 10) : null,
			url,
			summary: str(r.summary),
			relevance_score: Number.isFinite(score) ? Math.min(10, Math.max(1, Math.round(score))) : null,
		});
	}
	return { articles, invalid: raw.length - articles.length };
}

function str(value: unknown): string | null {
	return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

function sum(rows: TopicResult[], key: "inserted" | "skipped" | "returned"): number {
	return rows.reduce((n, r) => n + r[key], 0);
}
