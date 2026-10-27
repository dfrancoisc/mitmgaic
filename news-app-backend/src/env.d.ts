// Secrets aren't in wrangler.jsonc, so `wrangler types` can't generate them.
interface Env {
	/** Set with `wrangler secret put ANTHROPIC_API_KEY`. */
	ANTHROPIC_API_KEY: string;
	/** Password required (as `Authorization: Bearer ...`) to run POST /agent. Set with `wrangler secret put AGENT_SECRET`. */
	AGENT_SECRET: string;
}
