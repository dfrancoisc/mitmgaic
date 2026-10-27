// Chat panel: sends questions to the same-origin proxy (src/worker.js), which adds the API password.
(() => {
	const MODEL_KEY = "news-chat-model";

	const form = document.getElementById("chat-form");
	const input = document.getElementById("chat-input");
	const modelSelect = document.getElementById("chat-model");
	const submit = document.getElementById("chat-submit");
	const thread = document.getElementById("chat-thread");
	const empty = document.getElementById("chat-empty");

	try {
		const saved = localStorage.getItem(MODEL_KEY);
		if (saved && [...modelSelect.options].some((o) => o.value === saved)) modelSelect.value = saved;
	} catch {}
	modelSelect.addEventListener("change", () => {
		try {
			localStorage.setItem(MODEL_KEY, modelSelect.value);
		} catch {}
	});

	for (const btn of document.querySelectorAll(".suggestion")) {
		btn.addEventListener("click", () => ask(btn.textContent));
	}

	form.addEventListener("submit", (e) => {
		e.preventDefault();
		ask(input.value);
	});

	// Enter sends; Shift+Enter adds a new line.
	input.addEventListener("keydown", (e) => {
		if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
			e.preventDefault();
			form.requestSubmit();
		}
	});

	async function ask(rawQuestion) {
		const question = rawQuestion.trim();
		if (!question || submit.disabled) return;

		empty?.remove();
		input.value = "";
		setBusy(true);

		append(el("div", "msg-question", question));
		const pending = el("div", "typing");
		const dots = el("span", "typing-dots");
		dots.append(el("span"), el("span"), el("span"));
		pending.append(dots, document.createTextNode(`${modelSelect.selectedOptions[0].text.split(" ·")[0]} is reading the articles…`));
		append(pending);

		try {
			const res = await fetch("/api/chat", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ question, model: modelSelect.value }),
			});
			const data = await res.json().catch(() => ({}));
			if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
			pending.replaceWith(renderAnswer(data));
		} catch (err) {
			pending.replaceWith(el("div", "msg-error", `Couldn't get an answer: ${err.message}`));
		} finally {
			setBusy(false);
			thread.scrollTop = thread.scrollHeight;
			input.focus();
		}
	}

	function setBusy(on) {
		submit.disabled = on;
		submit.textContent = on ? "Thinking…" : "Ask";
		for (const b of document.querySelectorAll(".suggestion")) b.disabled = on;
	}

	function append(node) {
		thread.append(node);
		thread.scrollTop = thread.scrollHeight;
	}

	function renderAnswer(data) {
		const wrap = el("div", "msg-answer");
		const urls = new Map(data.sources.map((s) => [s.ref, s.url]));
		wrap.append(...renderMarkdown(data.answer, urls));

		const cited = new Set([...data.answer.matchAll(/\[(\d+)\]/g)].map((m) => Number(m[1])));
		const shown = data.sources.filter((s) => cited.has(s.ref));
		if (shown.length) {
			const details = el("details", "msg-sources");
			details.append(el("summary", null, `Sources (${shown.length})`));
			const list = document.createElement("ol");
			for (const s of shown) {
				const li = document.createElement("li");
				li.value = s.ref;
				li.append(link(s.url, s.headline), document.createTextNode(` · ${s.source || "Unknown"}${s.published_at ? `, ${s.published_at}` : ""}`));
				list.append(li);
			}
			details.append(list);
			wrap.append(details);
		}

		wrap.append(el("div", "msg-meta", `Answered by ${data.model}`));
		return wrap;
	}

	// Minimal, safe Markdown: paragraphs, "- " lists, **bold**, and [n] citations. Builds DOM nodes, never HTML strings.
	function renderMarkdown(text, urls) {
		const blocks = [];
		let list = null;
		for (const rawLine of text.split("\n")) {
			const line = rawLine.trim();
			if (!line) {
				list = null;
				continue;
			}
			const bullet = line.match(/^[-*•]\s+(.*)$/);
			if (bullet) {
				if (!list) blocks.push((list = document.createElement("ul")));
				const li = document.createElement("li");
				li.append(...inline(bullet[1], urls));
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
				nodes.push(el("strong", null, m[1]));
			} else {
				const ref = Number(m[2]);
				const a = link(urls.get(ref), `[${ref}]`);
				a.className = "cite";
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

	function el(tag, className, text) {
		const node = document.createElement(tag);
		if (className) node.className = className;
		if (text !== undefined) node.textContent = text;
		return node;
	}
})();
