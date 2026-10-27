const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

export interface Article {
	id: number;
	topic: string;
	headline: string;
	source: string | null;
	published_at: string | null;
	url: string;
	summary: string | null;
	relevance_score: number | null;
	fetched_at: string;
}

export class BadRequest extends Error {}

/**
 * Query params: topic, source (both case-insensitive exact match), from / to
 * (YYYY-MM-DD, inclusive, on publication date), min_score (1-10), limit (1-200).
 */
export async function listArticles(db: D1Database, params: URLSearchParams) {
	const where: string[] = [];
	const binds: (string | number)[] = [];

	const topic = params.get("topic");
	if (topic) {
		where.push("topic = ? COLLATE NOCASE");
		binds.push(topic);
	}

	const source = params.get("source");
	if (source) {
		where.push("source = ? COLLATE NOCASE");
		binds.push(source);
	}

	const from = params.get("from");
	if (from) {
		if (!DATE.test(from)) throw new BadRequest("from must be YYYY-MM-DD");
		where.push("published_at >= ?");
		binds.push(from);
	}

	const to = params.get("to");
	if (to) {
		if (!DATE.test(to)) throw new BadRequest("to must be YYYY-MM-DD");
		where.push("published_at <= ?");
		binds.push(to);
	}

	const minScore = params.get("min_score");
	if (minScore) {
		const n = Number(minScore);
		if (!Number.isInteger(n) || n < 1 || n > 10) throw new BadRequest("min_score must be an integer from 1 to 10");
		where.push("relevance_score >= ?");
		binds.push(n);
	}

	const limitParam = params.get("limit");
	const limit = limitParam === null ? DEFAULT_LIMIT : Number(limitParam);
	if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
		throw new BadRequest(`limit must be an integer from 1 to ${MAX_LIMIT}`);
	}

	const sql = `SELECT * FROM articles
		${where.length ? `WHERE ${where.join(" AND ")}` : ""}
		ORDER BY published_at DESC NULLS LAST, relevance_score DESC, id DESC
		LIMIT ?`;
	const { results } = await db.prepare(sql).bind(...binds, limit).all<Article>();

	return { count: results.length, articles: results };
}
