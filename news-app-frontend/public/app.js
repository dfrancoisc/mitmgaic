const API_BASE = "https://news-app-backend.dsfranco-cadastro.workers.dev";

// Keep in sync with TOPICS in news-app-backend/src/agent.ts.
const TOPICS = [
	"Healthcare IT & interoperability",
	"AI in healthcare",
	"Artificial intelligence",
	"Data platforms & cloud",
];

const els = {
	filters: document.getElementById("filters"),
	topic: document.getElementById("topic"),
	minScore: document.getElementById("min-score"),
	limit: document.getElementById("limit"),
	articles: document.getElementById("articles"),
	count: document.getElementById("result-count"),
	status: document.getElementById("status"),
	refreshed: document.getElementById("last-refreshed"),
	refreshBtn: document.getElementById("refresh-btn"),
	cardTemplate: document.getElementById("card-template"),
};

let loadSeq = 0;

for (const topic of TOPICS) {
	els.topic.add(new Option(topic, topic));
}

els.filters.addEventListener("change", () => loadArticles());
els.filters.addEventListener("submit", (e) => e.preventDefault());
els.refreshBtn.addEventListener("click", runAgent);

loadArticles();

async function loadArticles() {
	const seq = ++loadSeq;
	const params = new URLSearchParams();
	if (els.topic.value) params.set("topic", els.topic.value);
	if (els.minScore.value) params.set("min_score", els.minScore.value);
	params.set("limit", els.limit.value);

	els.articles.setAttribute("aria-busy", "true");
	els.articles.style.opacity = "0.55";

	try {
		const res = await fetch(`${API_BASE}/articles?${params}`);
		const data = await res.json();
		if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
		if (seq !== loadSeq) return; // a newer filter change already started

		render(data.articles);
		els.count.textContent = `${data.count} article${data.count === 1 ? "" : "s"}`;
		els.refreshed.textContent = data.last_refreshed
			? `Last refreshed ${formatDateTime(data.last_refreshed)}`
			: "Not refreshed yet";
		els.refreshed.title = data.last_refreshed ? new Date(data.last_refreshed).toString() : "";
	} catch (err) {
		if (seq !== loadSeq) return;
		showStatus("error", `Couldn't load articles: ${err.message}`);
		if (!els.articles.querySelector(".topic-group")) els.articles.replaceChildren();
	} finally {
		if (seq === loadSeq) {
			els.articles.setAttribute("aria-busy", "false");
			els.articles.style.opacity = "";
		}
	}
}

async function runAgent() {
	setRefreshing(true);
	showStatus("info", "Searching the web for new articles on every topic. This usually takes about a minute…");

	try {
		const res = await fetch(`${API_BASE}/agent`, { method: "POST" });
		const data = await res.json();
		if (!res.ok) throw new Error(data.detail || data.error || `Request failed (${res.status})`);

		const failed = data.topics.filter((t) => t.error);
		const summary = `Found ${data.total_returned} articles: ${data.inserted} new, ${data.skipped} already saved.`;
		if (failed.length) {
			showStatus("error", `${summary} ${failed.length} topic(s) failed: ${failed.map((t) => t.topic).join(", ")}.`);
		} else {
			showStatus("success", summary);
		}
		await loadArticles();
	} catch (err) {
		showStatus("error", `Refresh failed: ${err.message}`);
	} finally {
		setRefreshing(false);
	}
}

function setRefreshing(on) {
	els.refreshBtn.disabled = on;
	els.refreshBtn.classList.toggle("is-loading", on);
	els.refreshBtn.querySelector(".btn-label").textContent = on ? "Refreshing…" : "Refresh";
}

function showStatus(kind, message) {
	els.status.className = `status ${kind}`;
	els.status.textContent = message;
	els.status.hidden = false;
}

function render(articles) {
	if (articles.length === 0) {
		const empty = document.createElement("div");
		empty.className = "empty";
		empty.textContent = "No articles match these filters.";
		els.articles.replaceChildren(empty);
		return;
	}

	// Group in the canonical topic order; any unknown topic goes last.
	const groups = new Map();
	for (const topic of TOPICS) groups.set(topic, []);
	for (const a of articles) {
		if (!groups.has(a.topic)) groups.set(a.topic, []);
		groups.get(a.topic).push(a);
	}

	const sections = [];
	for (const [topic, items] of groups) {
		if (items.length === 0) continue;

		const section = document.createElement("section");
		section.className = "topic-group";
		const id = `topic-${slug(topic)}`;
		section.setAttribute("aria-labelledby", id);

		const heading = document.createElement("h2");
		heading.className = "topic-heading";
		heading.id = id;
		heading.textContent = topic;
		const count = document.createElement("span");
		count.className = "topic-count";
		count.textContent = `${items.length} article${items.length === 1 ? "" : "s"}`;
		heading.append(count);

		const grid = document.createElement("div");
		grid.className = "grid";
		grid.append(...items.map(renderCard));

		section.append(heading, grid);
		sections.push(section);
	}
	els.articles.replaceChildren(...sections);
}

function renderCard(a) {
	const card = els.cardTemplate.content.firstElementChild.cloneNode(true);

	const badge = card.querySelector(".badge");
	const score = a.relevance_score;
	if (score == null) {
		badge.remove();
	} else {
		badge.textContent = `${score}/10`;
		badge.classList.add(score >= 8 ? "high" : score >= 5 ? "mid" : "low");
		badge.title = `Relevance score ${score} out of 10`;
	}

	const source = card.querySelector(".source");
	source.textContent = a.source || "Unknown source";
	source.title = source.textContent;

	const time = card.querySelector(".date");
	if (a.published_at) {
		time.dateTime = a.published_at;
		time.textContent = formatDate(a.published_at);
	} else {
		time.textContent = "Date unknown";
	}

	const link = card.querySelector(".headline a");
	link.textContent = a.headline;
	if (/^https?:\/\//i.test(a.url)) link.href = a.url;

	card.querySelector(".summary").textContent = a.summary || "";
	return card;
}

function formatDate(isoDate) {
	// Publication dates are calendar days; build a local date so they don't shift a day in US time zones.
	const [y, m, d] = isoDate.slice(0, 10).split("-").map(Number);
	return new Date(y, m - 1, d).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

function formatDateTime(iso) {
	return new Date(iso).toLocaleString(undefined, {
		month: "short",
		day: "numeric",
		hour: "numeric",
		minute: "2-digit",
	});
}

function slug(s) {
	return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");
}
