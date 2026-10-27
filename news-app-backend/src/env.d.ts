// Secrets aren't in wrangler.jsonc, so `wrangler types` can't generate them.
interface Env {
	/** Set with `wrangler secret put ANTHROPIC_API_KEY`. */
	ANTHROPIC_API_KEY: string;
}
