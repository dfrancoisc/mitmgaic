// Every Claude model the backend calls is configured in this file.
// GET /models publishes this configuration so the dashboard can show which LLM is in use.

/** Model behind the news pipeline: the Refresh button (POST /agent) and the daily 7 AM run. */
export const AGENT_MODEL = "claude-opus-5-5";

/** Chat model options. Keys are what clients send as `model`; values are Anthropic model IDs. */
export const CHAT_MODELS: Record<string, string> = {
	fast: "claude-haiku-5-5",
	capable: "claude-opus-5-5",
	// Also accepted by the API, not offered in the dashboard.
	haiku: "claude-haiku-5-5",
	sonnet: "claude-sonnet-5-5",
	opus: "claude-opus-5-5",
};

/** Workers AI embedding model for semantic search (768 dimensions; the Vectorize index must match). */
export const EMBEDDING_MODEL = "@cf/baai/bge-base-en-v1.5";
export const VECTOR_INDEX = "news-articles";

/** Used when a chat request doesn't name a model. */
export const DEFAULT_CHAT_MODEL = CHAT_MODELS.capable;

/** The options the dashboard's model switch offers, in order. */
const DASHBOARD_OPTIONS = [
	{ key: "fast", description: "Quick, low-cost answers" },
	{ key: "capable", description: "Deeper, more thorough answers" },
];

const MODEL_NAMES: Record<string, string> = {
	"claude-opus-5-5": "Claude Opus 5.5",
	"claude-sonnet-5-5": "Claude Sonnet 5.5",
	"claude-haiku-5-5": "Claude Haiku 5.5",
};

const CONFIG_FILE = "news-app-backend/src/models.ts";
const REPO_BLOB_URL = "https://github.com/dfrancoisc/mitmgaic/blob/main/";

export function modelName(id: string): string {
	return MODEL_NAMES[id] ?? id;
}

/** Public, non-secret description of the LLM setup, served by GET /models. */
export function modelConfig() {
	return {
		provider: "Anthropic Claude API",
		api_key: "Stored as the Cloudflare Worker secret ANTHROPIC_API_KEY (never sent to the browser)",
		configured_in: { file: CONFIG_FILE, url: `${REPO_BLOB_URL}${CONFIG_FILE}` },
		chat: {
			default_model: DEFAULT_CHAT_MODEL,
			options: DASHBOARD_OPTIONS.map((o) => ({
				key: o.key,
				model: CHAT_MODELS[o.key],
				name: modelName(CHAT_MODELS[o.key]),
				description: o.description,
			})),
			accepted_keys: Object.keys(CHAT_MODELS),
		},
		pipeline: {
			model: AGENT_MODEL,
			name: modelName(AGENT_MODEL),
			used_by: "Refresh button and the daily 7 AM run",
		},
		retrieval: {
			method: "Semantic search",
			embedding_model: EMBEDDING_MODEL,
			embedding_provider: "Cloudflare Workers AI",
			vector_index: `Cloudflare Vectorize index "${VECTOR_INDEX}" (cosine)`,
		},
	};
}
