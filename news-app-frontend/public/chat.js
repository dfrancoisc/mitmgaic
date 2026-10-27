// Chat panel: sends questions to the same-origin proxy (src/worker.js), which adds the API password.
(() => {
	const PREFS_KEY = "news-chat-prefs";
	const SPARK_ICON =
		'<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3l1.9 4.6L18.5 9.5l-4.6 1.9L12 16l-1.9-4.6L5.5 9.5l4.6-1.9z"/></svg>';

	const form = document.getElementById("chat-form");
	const input = document.getElementById("chat-input");
	const submit = document.getElementById("chat-submit");
	const thread = document.getElementById("chat-thread");
	const empty = document.getElementById("chat-empty");
	const modelInputs = [...document.querySelectorAll('input[name="chat-model"]')];
	const webToggle = document.getElementById("web-search-toggle");
	const webBadge = document.getElementById("web-search-badge");
	const stats = Object.fromEntries([...document.querySelectorAll("#hood-stats [data-stat]")].map((dd) => [dd.dataset.stat, dd]));
	const modelLine = document.getElementById("model-line");
	const configList = document.getElementById("llm-config-list");
	const hood = document.getElementById("under-hood");

	const fmt = new Intl.NumberFormat();
	let busy = false;
	// LLM configuration published by the backend (GET /models), so the UI always names the model actually called.
	let llmConfig = null;

	// Preferences: model choice and web search toggle survive reloads (best effort).
	const prefs = loadPrefs();
	if (prefs.model && modelInputs.some((i) => i.value === prefs.model)) {
		modelInputs.find((i) => i.value === prefs.model).checked = true;
	}
	setWebSearch(prefs.webSearch === true);

	for (const i of modelInputs) {
		i.addEventListener("change", () => {
			savePrefs();
			renderModelInfo();
		});
	}

	document.getElementById("model-details-btn").addEventListener("click", () => {
		hood.open = true;
		document.getElementById("llm-config").scrollIntoView({ behavior: "smooth", block: "nearest" });
	});

	loadModelConfig();

	async function loadModelConfig() {
		try {
			const res = await fetch(`${API_BASE}/models`);
			if (!res.ok) throw new Error(`HTTP ${res.status}`);
			llmConfig = await res.json();
		} catch {
			modelLine.textContent = "Model info unavailable";
			configList.replaceChildren(configRow("Status", "Couldn't load the model configuration."));
			return;
		}
		for (const opt of llmConfig.chat.options) {
			const label = modelInputs.find((i) => i.value === opt.key)?.closest(".segment");
			if (label) label.title = `${opt.name} (${opt.model}): ${opt.description}`;
		}
		const refresh = document.getElementById("refresh-btn");
		refresh.title = `Runs the news pipeline with ${llmConfig.pipeline.name} (${llmConfig.pipeline.model})`;
		renderModelInfo();
	}

	function selectedOption() {
		return llmConfig?.chat.options.find((o) => o.key === currentModel());
	}

	function renderModelInfo() {
		if (!llmConfig) return;
		const opt = selectedOption();
		if (opt) {
			modelLine.replaceChildren(document.createTextNode("Using "), el("strong", null, opt.name));
			// Exact model IDs stay available on hover without taking space.
			modelLine.parentElement.title = `${opt.name} (${opt.model}) via the ${llmConfig.provider}. Configured in ${llmConfig.configured_in.file}`;
		}

		// The highlighted row marks the model in use.
		const rows = llmConfig.chat.options.map((o) => {
			const value = el("dd");
			value.append(el("span", null, o.name), el("span", "config-note", o.description));
			value.title = o.model;
			const row = configRow(`Chat · ${capitalize(o.key)}`, value);
			if (o.key === opt?.key) row.classList.add("in-use");
			return row;
		});

		const pipeline = el("dd");
		pipeline.append(el("span", null, llmConfig.pipeline.name), el("span", "config-note", llmConfig.pipeline.used_by));
		pipeline.title = llmConfig.pipeline.model;
		rows.push(configRow("News pipeline", pipeline));

		if (llmConfig.retrieval) {
			const ret = el("dd");
			ret.append(
				el("span", null, llmConfig.retrieval.method),
				el("span", "config-note", `${llmConfig.retrieval.embedding_model} (${llmConfig.retrieval.embedding_provider}) · ${llmConfig.retrieval.vector_index}`),
			);
			rows.push(configRow("Retrieval", ret));
		}

		rows.push(configRow("Provider", llmConfig.provider));

		const where = el("dd");
		where.append(link(llmConfig.configured_in.url, llmConfig.configured_in.file), el("span", "config-note", "Change models here and redeploy the backend Worker."));
		rows.push(configRow("Configured in", where));

		rows.push(configRow("API key", llmConfig.api_key));
		configList.replaceChildren(...rows);
	}

	function configRow(label, value) {
		const row = document.createElement("div");
		const dd = value instanceof Node ? value : el("dd", null, value);
		row.append(el("dt", null, label), dd);
		return row;
	}

	function capitalize(s) {
		return s.charAt(0).toUpperCase() + s.slice(1);
	}
	webToggle.addEventListener("click", () => {
		setWebSearch(webToggle.getAttribute("aria-checked") !== "true");
		savePrefs();
	});

	for (const btn of document.querySelectorAll(".suggestion")) {
		btn.addEventListener("click", () => ask(btn.textContent));
	}

	form.addEventListener("submit", (e) => {
		e.preventDefault();
		ask(input.value);
	});

	// Enter sends; Shift+Enter adds a new line. The box grows with its content.
	input.addEventListener("keydown", (e) => {
		if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
			e.preventDefault();
			form.requestSubmit();
		}
	});
	input.addEventListener("input", autosize);

	function autosize() {
		input.style.height = "auto";
		input.style.height = `${Math.min(input.scrollHeight, 160)}px`;
	}

	function currentModel() {
		return modelInputs.find((i) => i.checked)?.value ?? "fast";
	}

	function webSearchOn() {
		return webToggle.getAttribute("aria-checked") === "true";
	}

	function setWebSearch(on) {
		webToggle.setAttribute("aria-checked", String(on));
		webBadge.hidden = !on;
	}

	function loadPrefs() {
		try {
			return JSON.parse(localStorage.getItem(PREFS_KEY)) ?? {};
		} catch {
			return {};
		}
	}

	function savePrefs() {
		try {
			localStorage.setItem(PREFS_KEY, JSON.stringify({ model: currentModel(), webSearch: webSearchOn() }));
		} catch {}
	}

	async function ask(rawQuestion) {
		const question = rawQuestion.trim();
		if (!question || busy) return;

		const model = currentModel();
		const webSearch = webSearchOn();
		empty?.remove();
		input.value = "";
		autosize();
		setBusy(true);

		append(el("div", "msg msg-question", question));
		const pending = answerShell();
		const typing = el("div", "typing");
		const dots = el("span", "typing-dots");
		dots.append(el("span"), el("span"), el("span"));
		typing.append(dots, document.createTextNode(webSearch ? "Reading articles and searching the web…" : "Reading the articles…"));
		pending.body.append(typing);
		append(pending.root);

		try {
			const res = await fetch("/api/chat", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ question, model, web_search: webSearch }),
			});
			const data = await res.json().catch(() => ({}));
			if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
			typing.remove();
			renderAnswer(pending.body, data, model);
			updateHood(data);
		} catch (err) {
			pending.root.replaceWith(el("div", "msg msg-error", `Couldn't get an answer: ${err.message}`));
		} finally {
			setBusy(false);
			thread.scrollTop = thread.scrollHeight;
			input.focus();
		}
	}

	function setBusy(on) {
		busy = on;
		submit.disabled = on;
		submit.querySelector(".send-label").textContent = on ? "Sending" : "Send";
		webToggle.disabled = on;
		for (const i of modelInputs) i.disabled = on;
		for (const b of document.querySelectorAll(".suggestion")) b.disabled = on;
	}

	function append(node) {
		thread.append(node);
		thread.scrollTop = thread.scrollHeight;
	}

	function answerShell() {
		const root = el("div", "msg msg-answer");
		const avatar = el("span", "avatar");
		avatar.innerHTML = SPARK_ICON; // static, trusted markup
		const body = el("div", "answer-body");
		root.append(avatar, body);
		return { root, body };
	}

	function renderAnswer(body, data, modelChoice) {
		const urls = new Map(data.sources.map((s) => [s.ref, s.url]));
		body.append(...renderMarkdown(data.answer, urls));

		const cited = new Set([...data.answer.matchAll(/\[(\d+)\]/g)].map((m) => Number(m[1])));
		const shown = data.sources.filter((s) => cited.has(s.ref));
		if (shown.length) {
			const list = document.createElement("ol");
			for (const s of shown) {
				const li = document.createElement("li");
				li.value = s.ref;
				li.append(link(s.url, s.headline), document.createTextNode(` · ${s.source || "Unknown"}${s.published_at ? `, ${s.published_at}` : ""}`));
				if (typeof s.similarity === "number") {
					const m = el("span", "match", `${Math.round(s.similarity * 100)}% match`);
					m.title = `Semantic similarity to your question (cosine ${s.similarity.toFixed(3)})`;
					li.append(m);
				}
				list.append(li);
			}
			body.append(sourcesBlock(`Article sources (${shown.length})`, list));
		}
		if (data.web_sources?.length) {
			const list = document.createElement("ul");
			for (const w of data.web_sources) {
				const li = document.createElement("li");
				li.append(link(w.url, w.title || hostname(w.url)));
				list.append(li);
			}
			body.append(sourcesBlock(`Web sources (${data.web_sources.length})`, list));
		}

		// Token usage for this response, always visible.
		const row = el("div", "usage-row");
		const modelChip = el("span", "chip model", `${capitalize(modelChoice)} · ${data.model_name ?? data.model}`);
		modelChip.title = `Answered by ${data.model}`;
		row.append(
			modelChip,
			chip(fmt.format(data.usage.input_tokens), "in"),
			chip(fmt.format(data.usage.output_tokens), "out"),
			chip(String(data.context.articles), data.context.articles === 1 ? "article" : "articles"),
		);
		if (data.retrieval) {
			const semantic = data.retrieval.method === "semantic";
			const r = el("span", `chip ${semantic ? "semantic" : "fallback"}`, semantic ? "Semantic search" : "Keyword fallback");
			r.title = semantic
				? "Context chosen by meaning: the question was embedded and matched against article vectors in Vectorize"
				: `Semantic search wasn't used (${data.retrieval.fallback_reason ?? "unavailable"}); context chosen by keyword match`;
			row.append(r);
		}
		if (data.web_search) row.append(chip(String(data.usage.web_search_requests), data.usage.web_search_requests === 1 ? "web search" : "web searches"));
		// A safety fallback can hand the request to another model; say so rather than mislabel the answer.
		if (data.requested_model && data.model !== data.requested_model) {
			const fb = el("span", "chip fallback", `Fallback: ${data.requested_model} declined`);
			fb.title = `${data.requested_model} declined this request, so ${data.model} answered instead.`;
			row.append(fb);
		}
		body.append(row);
	}

	function sourcesBlock(label, list) {
		const details = el("details", "msg-sources");
		details.append(el("summary", null, label), list);
		return details;
	}

	function chip(value, label) {
		const c = el("span", "chip");
		c.append(el("strong", null, value), document.createTextNode(` ${label}`));
		return c;
	}

	function updateHood(data) {
		const set = (key, text) => {
			stats[key].textContent = text;
			stats[key].classList.remove("updated");
			void stats[key].offsetWidth; // restart the highlight animation
			stats[key].classList.add("updated");
		};
		set("articles", fmt.format(data.context.articles));
		set("context", `${data.context.estimated ? "≈" : ""}${fmt.format(data.context.tokens)}`);
		stats.context.title = data.context.estimated
			? "Estimated from text length"
			: "Counted with the Anthropic token counter for this model";
		set("input", fmt.format(data.usage.input_tokens));
		set("output", fmt.format(data.usage.output_tokens));
		set("searches", data.web_search ? fmt.format(data.usage.web_search_requests) : "Off");
		set("model", data.model_name ?? data.model);
		stats.model.title = data.model;

		const line = document.getElementById("retrieval-line");
		const r = data.retrieval;
		if (r?.method === "semantic") {
			line.replaceChildren(
				document.createTextNode("Retrieval: "),
				el("strong", null, "semantic search"),
				document.createTextNode(r.top_similarity != null ? ` · best match ${Math.round(r.top_similarity * 100)}%` : ""),
			);
		} else if (r) {
			line.replaceChildren(document.createTextNode("Retrieval: "), el("strong", null, "keyword fallback"), document.createTextNode(` · ${r.fallback_reason ?? "semantic search unavailable"}`));
		}
	}

	// Minimal, safe Markdown: paragraphs, "-" and "1." lists, **bold**, and [n] citations. Builds DOM nodes, never HTML strings.
	function renderMarkdown(text, urls) {
		const blocks = [];
		let list = null;
		let listType = null;
		for (const rawLine of text.split("\n")) {
			const line = rawLine.trim();
			if (!line) {
				list = null;
				continue;
			}
			const bullet = line.match(/^[-*•]\s+(.*)$/);
			const numbered = line.match(/^\d+[.)]\s+(.*)$/);
			if (bullet || numbered) {
				const type = bullet ? "ul" : "ol";
				if (!list || listType !== type) {
					blocks.push((list = document.createElement(type)));
					listType = type;
				}
				const li = document.createElement("li");
				li.append(...inline((bullet ?? numbered)[1], urls));
				list.append(li);
			} else {
				list = null;
				const p = document.createElement("p");
				p.append(...inline(line.replace(/^#+\s*/, ""), urls));
				blocks.push(p);
			}
		}
		return blocks;
	}

	function inline(text, urls) {
		const nodes = [];
		const re = /\*\*(.+?)\*\*|\[(\d+)\]/g;
		let last = 0;
		for (const m of text.matchAll(re)) {
			if (m.index > last) nodes.push(document.createTextNode(text.slice(last, m.index)));
			if (m[1] !== undefined) {
				// Bold text can itself contain citations, e.g. **[1] Headline**.
				const strong = el("strong");
				strong.append(...inline(m[1], urls));
				nodes.push(strong);
			} else {
				const ref = Number(m[2]);
				const a = link(urls.get(ref), String(ref));
				a.classList.add("cite");
				a.title = `Article ${ref}`;
				nodes.push(a);
			}
			last = m.index + m[0].length;
		}
		if (last < text.length) nodes.push(document.createTextNode(text.slice(last)));
		return nodes;
	}

	function link(url, label) {
		if (!url || !/^https?:\/\//i.test(url)) return el("span", null, label);
		const a = el("a", null, label);
		a.href = url;
		a.target = "_blank";
		a.rel = "noopener noreferrer";
		return a;
	}

	function hostname(url) {
		try {
			return new URL(url).hostname.replace(/^www\./, "");
		} catch {
			return url;
		}
	}

	function el(tag, className, text) {
		const node = document.createElement(tag);
		if (className) node.className = className;
		if (text !== undefined) node.textContent = text;
		return node;
	}
})();
