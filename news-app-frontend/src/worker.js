// Serves the static dashboard and proxies paid actions (Refresh, chat) to the backend.
// The API password lives only in this Worker's AGENT_SECRET secret, so it never reaches the browser.
const MAX_CHAT_BODY_BYTES = 10_000;

export default {
	async fetch(request, env) {
		const url = new URL(request.url);

		if (url.pathname === "/api/agent" || url.pathname === "/api/chat") {
			if (request.method !== "POST") {
				return Response.json({ error: "Use POST" }, { status: 405 });
			}
			// Only accept same-origin calls from the dashboard, not cross-site form posts.
			const origin = request.headers.get("Origin");
			if (origin && origin !== url.origin) {
				return Response.json({ error: "Forbidden" }, { status: 403 });
			}

			const headers = { Authorization: `Bearer ${env.AGENT_SECRET}` };
			let body;
			if (url.pathname === "/api/chat") {
				body = await request.text();
				if (body.length > MAX_CHAT_BODY_BYTES) {
					return Response.json({ error: "Request too large" }, { status: 413 });
				}
				headers["Content-Type"] = "application/json";
			}

			// The service binding calls the backend Worker directly; the hostname is ignored.
			const backendPath = url.pathname.slice("/api".length);
			return env.BACKEND.fetch(`https://news-app-backend${backendPath}`, { method: "POST", headers, body });
		}

		return env.ASSETS.fetch(request);
	},
};
