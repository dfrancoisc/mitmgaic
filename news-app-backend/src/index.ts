import { runAgent } from "./agent";
import { BadRequest, listArticles } from "./articles";

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
					return json(await runAgent(env));

				case "/articles":
					if (request.method !== "GET") {
						return json({ error: "Use GET to list articles" }, 405);
					}
					return json(await listArticles(env.DB, url.searchParams));

				default:
					return json({ error: "Not found", endpoints: ["/health", "/agent", "/articles"] }, 404);
			}
		} catch (err) {
			if (err instanceof BadRequest) return json({ error: err.message }, 400);
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
