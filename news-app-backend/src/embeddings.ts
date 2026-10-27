import { EMBEDDING_MODEL } from "./models";

// One vector per article: id = articles.id, embedded from headline + summary.
// Questions and articles must use the same model and pooling or their vectors aren't comparable.
const POOLING = "cls" as const;
const EMBED_BATCH = 50;
const UPSERT_BATCH = 500;

export interface ArticleForIndex {
	id: number;
	topic: string;
	headline: string;
	summary: string | null;
	source: string | null;
	published_at: string | null;
}

export interface SemanticMatch {
	id: number;
	score: number;
}

/** The text an article is embedded from. Topic and source add a little useful signal to short summaries. */
export function articleEmbeddingText(a: ArticleForIndex): string {
	return `${a.headline}\n${a.summary ?? ""}\nTopic: ${a.topic}${a.source ? ` | Source: ${a.source}` : ""}`;
}

export async function embed(ai: Ai, texts: string[]): Promise<number[][]> {
	const vectors: number[][] = [];
	for (let i = 0; i < texts.length; i += EMBED_BATCH) {
		const batch = texts.slice(i, i + EMBED_BATCH);
		const out = await ai.run(EMBEDDING_MODEL, { text: batch, pooling: POOLING });
		if (!("data" in out) || !out.data || out.data.length !== batch.length) {
			throw new Error("Embedding model returned no vectors");
		}
		vectors.push(...out.data);
	}
	return vectors;
}

/** Embeds articles and upserts their vectors. Safe to re-run: upsert replaces existing ids. */
export async function indexArticles(env: Env, articles: ArticleForIndex[]): Promise<number> {
	if (articles.length === 0) return 0;
	const vectors = await embed(env.AI, articles.map(articleEmbeddingText));
	const records = articles.map((a, i) => ({
		id: String(a.id),
		values: vectors[i],
		metadata: { topic: a.topic, published_at: a.published_at ?? "" },
	}));
	for (let i = 0; i < records.length; i += UPSERT_BATCH) {
		await env.VECTORIZE.upsert(records.slice(i, i + UPSERT_BATCH));
	}
	return records.length;
}

export async function deleteArticleVectors(env: Env, ids: number[]): Promise<void> {
	if (ids.length > 0) await env.VECTORIZE.deleteByIds(ids.map(String));
}

/** Finds the stored articles whose meaning is closest to the question, best match first. */
export async function semanticSearch(env: Pick<Env, "AI" | "VECTORIZE">, question: string, topK: number): Promise<SemanticMatch[]> {
	const [vector] = await embed(env.AI, [question]);
	const { matches } = await env.VECTORIZE.query(vector, { topK, returnMetadata: "none" });
	return matches.map((m) => ({ id: Number(m.id), score: m.score })).filter((m) => Number.isInteger(m.id));
}
