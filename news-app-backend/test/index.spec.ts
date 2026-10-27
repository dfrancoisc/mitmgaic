import { env, exports } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { extractJsonArray, normalizeArticles, storeArticles, type CandidateArticle } from "../src/agent";
import type { Article } from "../src/articles";
import { rankArticles, resolveModel } from "../src/chat";
import { isSevenAmInNewYork } from "../src/index";

const SELF = exports.default;

async function seed() {
	await env.DB.exec("DELETE FROM articles");
	const insert = env.DB.prepare(
		`INSERT INTO articles (topic, headline, source, published_at, url, summary, relevance_score)
		 VALUES (?, ?, ?, ?, ?, ?, ?)`,
	);
	await env.DB.batch([
		insert.bind("AI in healthcare", "A", "STAT", "2026-10-20", "https://a.example/1", "s", 9),
		insert.bind("AI in healthcare", "B", "Fierce", "2026-10-25", "https://a.example/2", "s", 4),
		insert.bind("Artificial intelligence", "C", "STAT", "2026-10-26", "https://a.example/3", "s", 7),
	]);
}

describe("/health", () => {
	it("returns ok with a timestamp and CORS headers", async () => {
		const res = await SELF.fetch("https://x/health");
		expect(res.status).toBe(200);
		expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");
		const body = await res.json<{ status: string; timestamp: string }>();
		expect(body.status).toBe("ok");
		expect(Number.isNaN(Date.parse(body.timestamp))).toBe(false);
	});
});

describe("CORS and routing", () => {
	it("answers preflight requests", async () => {
		const res = await SELF.fetch("https://x/articles", { method: "OPTIONS" });
		expect(res.status).toBe(204);
		expect(res.headers.get("Access-Control-Allow-Methods")).toContain("GET");
	});

	it("returns 404 JSON with CORS for unknown paths", async () => {
		const res = await SELF.fetch("https://x/nope");
		expect(res.status).toBe(404);
		expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");
	});

	it("rejects GET on /agent without calling Claude", async () => {
		const res = await SELF.fetch("https://x/agent");
		expect(res.status).toBe(405);
	});
});

describe("/agent authorization", () => {
	// Only rejection paths are tested here: an authorized request would call the real Claude API.
	it("rejects a request with no password", async () => {
		const res = await SELF.fetch("https://x/agent", { method: "POST" });
		expect(res.status).toBe(401);
		expect(res.headers.get("WWW-Authenticate")).toContain("Bearer");
		expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");
	});

	it("rejects a wrong password, including one that differs only in length", async () => {
		for (const auth of ["Bearer wrong", "Bearer test-agent-secretX", "Basic dGVzdA==", "test-agent-secret"]) {
			const res = await SELF.fetch("https://x/agent", { method: "POST", headers: { Authorization: auth } });
			expect(res.status, auth).toBe(401);
		}
	});

	it("keeps /health and /articles public", async () => {
		expect((await SELF.fetch("https://x/health")).status).toBe(200);
		expect((await SELF.fetch("https://x/articles")).status).toBe(200);
	});
});

describe("/articles", () => {
	beforeEach(seed);

	it("returns all articles newest first with a count", async () => {
		const body = await (await SELF.fetch("https://x/articles")).json<any>();
		expect(body.count).toBe(3);
		expect(body.last_refreshed).toMatch(/^\d{4}-\d{2}-\d{2}T/);
		expect(body.articles.map((a: any) => a.headline)).toEqual(["C", "B", "A"]);
	});

	it("filters by topic, source, date range, min_score and limit", async () => {
		const get = async (q: string) => (await (await SELF.fetch(`https://x/articles?${q}`)).json<any>()).count;
		expect(await get("topic=ai%20in%20healthcare")).toBe(2);
		expect(await get("source=stat")).toBe(2);
		expect(await get("from=2026-10-21&to=2026-10-25")).toBe(1);
		expect(await get("min_score=7")).toBe(2);
		expect(await get("limit=1")).toBe(1);
	});

	it("rejects invalid filters with 400", async () => {
		for (const q of ["min_score=11", "limit=0", "from=10/20/2026"]) {
			const res = await SELF.fetch(`https://x/articles?${q}`);
			expect(res.status, q).toBe(400);
		}
	});
});

describe("Claude response parsing", () => {
	it("extracts a JSON array from text joined across blocks", () => {
		const blocks = ["Here are the results:\n```json\n[{\"headline\": \"X\",", " \"url\": \"https://x.example\"}]\n```"];
		expect(extractJsonArray(blocks.join(""))).toEqual([{ headline: "X", url: "https://x.example" }]);
	});

	it("throws when there is no array", () => {
		expect(() => extractJsonArray("No news found.")).toThrow();
	});

	it("drops invalid items and clamps scores", () => {
		const { articles, invalid } = normalizeArticles([
			{ headline: "Ok", url: "https://ok.example", relevance_score: 14, published_date: "2026-10-26T08:00:00Z" },
			{ headline: "No url" },
			"junk",
		]);
		expect(invalid).toBe(2);
		expect(articles[0]).toMatchObject({ relevance_score: 10, published_date: "2026-10-26" });
	});
});

describe("storing articles", () => {
	const article = (n: number, day: number): CandidateArticle => ({
		headline: `H${n}`,
		source: "S",
		published_date: `2026-10-${String(day).padStart(2, "0")}`,
		url: `https://s.example/${n}`,
		summary: "s",
		relevance_score: 5,
	});

	beforeEach(() => env.DB.exec("DELETE FROM articles"));

	it("skips URLs already stored or repeated in the same batch", async () => {
		expect(await storeArticles(env.DB, "T", [article(1, 1), article(2, 2)])).toEqual({ inserted: 2, removed: 0 });
		const again = await storeArticles(env.DB, "T", [article(1, 1), article(3, 3), article(3, 3)]);
		expect(again).toEqual({ inserted: 1, removed: 0 });
	});

	it("caps each topic at 20 by removing the oldest", async () => {
		await storeArticles(env.DB, "Other", [article(100, 1)]);
		const batch = Array.from({ length: 25 }, (_, i) => article(i, i + 1)); // days 1..25
		expect(await storeArticles(env.DB, "T", batch)).toEqual({ inserted: 25, removed: 5 });

		const { results } = await env.DB.prepare("SELECT MIN(published_at) AS oldest, COUNT(*) AS n FROM articles WHERE topic = 'T'").all<{ oldest: string; n: number }>();
		expect(results[0]).toEqual({ oldest: "2026-10-06", n: 20 });
		const other = await env.DB.prepare("SELECT COUNT(*) AS n FROM articles WHERE topic = 'Other'").first<number>("n");
		expect(other).toBe(1);
	});
});

describe("/chat", () => {
	// Validation and auth only: a valid authorized request would call the real Claude API.
	const auth = { Authorization: "Bearer test-agent-secret", "Content-Type": "application/json" };
	const post = (body: string, headers: Record<string, string> = auth) =>
		SELF.fetch("https://x/chat", { method: "POST", headers, body });

	it("requires the password", async () => {
		expect((await post('{"question":"hi"}', { "Content-Type": "application/json" })).status).toBe(401);
	});

	it("rejects bad input with 400 before calling Claude", async () => {
		for (const body of ["not json", "{}", '{"question":"  "}', '{"question":"hi","model":"gpt-4"}', `{"question":"${"x".repeat(2001)}"}`]) {
			const res = await post(body);
			expect(res.status, body.slice(0, 40)).toBe(400);
		}
	});

	it("resolves model preferences", () => {
		expect(resolveModel(undefined)).toBe("claude-opus-5-5");
		expect(resolveModel("Sonnet")).toBe("claude-sonnet-5-5");
		expect(resolveModel("haiku")).toBe("claude-haiku-5-5");
		expect(resolveModel("claude-sonnet-5-5")).toBe("claude-sonnet-5-5");
		expect(() => resolveModel("claude-3-opus")).toThrow(/Unsupported model/);
	});

	it("ranks keyword matches first and falls back to fresh, high-scoring articles", () => {
		const art = (id: number, headline: string, summary: string, score: number, date: string): Article => ({
			id, topic: "T", headline, source: "S", published_at: date, url: `https://x/${id}`, summary, relevance_score: score, fetched_at: date,
		});
		const now = new Date("2026-10-27T12:00:00Z");
		const list = [
			art(1, "Snowflake joins Oracle cloud", "Snowflake on OCI", 6, "2026-10-20"),
			art(2, "ONC finalizes HTI-5 rule", "Certification criteria cut", 9, "2026-10-26"),
			art(3, "Epic launches AI scribe", "HTI-5 mentioned briefly", 7, "2026-10-27"),
		];
		expect(rankArticles("What changed in the HTI-5 rule?", list, now).map((a) => a.id)).toEqual([2, 3]);
		// No keyword overlap: every article stays in, ordered by relevance score plus freshness.
		expect(rankArticles("what's going on?", list, now).map((a) => a.id)).toEqual([2, 3, 1]);
	});
});

describe("schedule", () => {
	it("fires at 7 AM New York time in both daylight and standard time", () => {
		expect(isSevenAmInNewYork(new Date("2026-10-27T11:00:00Z"))).toBe(true); // EDT
		expect(isSevenAmInNewYork(new Date("2026-10-27T12:00:00Z"))).toBe(false);
		expect(isSevenAmInNewYork(new Date("2026-12-01T12:00:00Z"))).toBe(true); // EST
		expect(isSevenAmInNewYork(new Date("2026-12-01T11:00:00Z"))).toBe(false);
	});
});
