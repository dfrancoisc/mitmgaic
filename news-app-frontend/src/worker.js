// Serves the static dashboard and proxies Refresh to the backend agent.
// The agent password lives only in this Worker's AGENT_SECRET secret, so it never reaches the browser.
export default {
	async fetch(request, env) {
		const url = new URL(request.url);

		if (url.pathname === "/api/agent") {
			if (request.method !== "POST") {
				return Response.json({ error: "Use POST to run the agent" }, { status: 405 });
			}
			// Only accept same-origin calls from the dashboard, not cross-site form posts.
			const origin = request.headers.get("Origin");
			if (origin && origin !== url.origin) {
				return Response.json({ error: "Forbidden" }, { status: 403 });
			}
			// The service binding calls the backend Worker directly; the hostname is ignored.
			return env.BACKEND.fetch("https://news-app-backend/agent", {
				method: "POST",
				headers: { Authorization: `Bearer ${env.AGENT_SECRET}` },
			});
		}

		return env.ASSETS.fetch(request);
	},
};
