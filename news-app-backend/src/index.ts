import Anthropic from "@anthropic-ai/sdk";
import { runAgent } from "./agent";
import { BadRequest, listArticles } from "./articles";
import { chat, ChatRefused, parseChatRequest } from "./chat";
import { modelConfig } from "./models";

const CORS_HEADERS = {
	"Access-Control-Allow-Origin": "*",
	"Access-Control-Allow-Methods": "GET, POST, OPTIONS",
	"Access-Control-Allow-Headers": "Content-Type, Authorization",
	"Access-Control-Max-Age": "86400",
};

function json(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body, null, 2), {
		status,
		headers: { "Content-Type": "application/json; charset=utf-8", ...CORS_HEADERS },
	});
}

/** Checks `Authorization: Bearer <AGENT_SECRET>` without leaking timing information. */
async function isAuthorized(request: Request, secret: string): Promise<boolean> {
	const match = request.headers.get("Authorization")?.match(/^Bearer\s+(.+)$/i);
	if (!match) return false;
	// Hash both sides so the comparison is constant-time and length-independent.
	const enc = new TextEncoder();
	const [given, expected] = await Promise.all([
		crypto.subtle.digest("SHA-256", enc.encode(match[1].trim())),
		crypto.subtle.digest("SHA-256", enc.encode(secret)),
	]);
	return crypto.subtle.timingSafeEqual(given, expected);
}

/** Returns an error response unless the request carries the API password; paid endpoints call this first. */
async function requirePassword(request: Request, env: Env): Promise<Response | null> {
	// Fail closed: without a configured secret nobody can trigger a paid call.
	if (!env.AGENT_SECRET) return json({ error: "This endpoint is not configured" }, 503);
	if (await isAuthorized(request, env.AGENT_SECRET)) return null;
	const res = json({ error: "Unauthorized: a valid Authorization: Bearer <password> header is required" }, 401);
	res.headers.set("WWW-Authenticate", 'Bearer realm="news-agent"');
	return res;
}

/** Cron triggers run in UTC, so two are scheduled and only the one landing on 7 AM New York time runs. */
export function isSevenAmInNewYork(date: Date): boolean {
	const hour = new Intl.DateTimeFormat("en-US", {
		timeZone: "America/New_York",
		hour: "numeric",
		hourCycle: "h23",
	}).format(date);
	return Number(hour) === 7;
}

export default {
	async fetch(request, env): Promise<Response> {
		if (request.method === "OPTIONS") {
			return new Response(null, { status: 204, headers: CORS_HEADERS });
		}

		const url = new URL(request.url);
		try {
			switch (url.pathname) {
				case "/health":
					return json({ status: "ok", service: "news-app-backend", timestamp: new Date().toISOString() });

				case "/agent":
					if (request.method !== "POST") {
						return json({ error: "Use POST to run the agent" }, 405);
					}
					{
						const denied = await requirePassword(request, env);
						if (denied) return denied;
					}
					return json(await runAgent(env));

				case "/models":
					// Public and non-secret: which Claude models the app uses and where that's configured.
					return json(modelConfig());

				case "/chat": {
					if (request.method !== "POST") {
						return json({ error: 'Use POST with a JSON body like {"question": "...", "model": "sonnet"}' }, 405);
					}
					const denied = await requirePassword(request, env);
					if (denied) return denied;

					let body: unknown;
					try {
						body = await request.json();
					} catch {
						return json({ error: "Body must be valid JSON" }, 400);
					}
					return json(await chat(env, parseChatRequest(body)));
				}

				case "/articles":
					if (request.method !== "GET") {
						return json({ error: "Use GET to list articles" }, 405);
					}
					return json(await listArticles(env.DB, url.searchParams));

				default:
					return json({ error: "Not found", endpoints: ["/health", "/agent", "/articles", "/chat", "/models"] }, 404);
			}
		} catch (err) {
			if (err instanceof BadRequest) return json({ error: err.message }, 400);
			if (err instanceof ChatRefused) return json({ error: err.message }, 422);
			if (err instanceof Anthropic.RateLimitError) {
				return json({ error: "Claude is rate limited right now; try again shortly" }, 429);
			}
			if (err instanceof Anthropic.APIError) {
				console.error("Anthropic API error", err.status, err.message);
				return json({ error: "Claude API request failed", status: err.status, detail: err.message }, 502);
			}
			console.error(err);
			return json({ error: "Internal error", detail: err instanceof Error ? err.message : String(err) }, 500);
		}
	},

	async scheduled(controller, env, ctx): Promise<void> {
		if (!isSevenAmInNewYork(new Date(controller.scheduledTime))) return;
		ctx.waitUntil(
			runAgent(env).then((result) => console.log("Scheduled agent run", JSON.stringify(result))),
		);
	},
} satisfies ExportedHandler<Env>;
