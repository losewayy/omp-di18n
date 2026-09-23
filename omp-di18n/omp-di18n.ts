/**
 * omp-di18n — runtime zh-CN localization for the omp TUI.
 *
 * Patches shared pi-tui component prototypes (the extension loader resolves
 * `@oh-my-pi/pi-tui` to the host's bundled module instance, so these patches
 * affect the real UI). Covers:
 *   - MenuSelection items/visibleItems getters  → SelectList, SettingsList, menus
 *   - CombinedAutocompleteProvider.getSuggestions → slash-command descriptions
 *   - Text.setText / Text.render                 → status lines, loaders, footers
 *   - TabBar.render                              → settings tab labels
 *
 * Strings that look translatable but are missing from the dictionary are
 * appended to `omp-di18n.misses.txt` next to this file — translate and add them
 * to `omp-di18n.zh-CN.json`, then run `/di18n reload`.
 */

import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const BASE_DIR = dirname(fileURLToPath(import.meta.url));
const DICT_PATH = join(BASE_DIR, "omp-di18n.zh-CN.json");
const MISS_PATH = join(BASE_DIR, "omp-di18n.misses.txt");

const g = globalThis as any;
const STATE_KEY = "__omp_di18n_state__";

type Dict = Record<string, string>;

interface Di18nState {
	enabled: boolean;
	dict: Dict;
	/** Dash-normalized fallback map (—/–/− → -) so keys match either dash style. */
	dictNorm: Dict;
	misses: Set<string>;
	missTimer: ReturnType<typeof setTimeout> | null;
	stats: { translated: number; missed: number };
	installed: boolean;
}

function getState(): Di18nState {
	if (!g[STATE_KEY]) {
		g[STATE_KEY] = {
			enabled: true,
			dict: {},
			dictNorm: {},
			misses: new Set<string>(),
			missTimer: null,
			stats: { translated: 0, missed: 0 },
			installed: false,
		} satisfies Di18nState;
	}
	return g[STATE_KEY] as Di18nState;
}

const normDash = (s: string) => (s.indexOf("—") + s.indexOf("–") + s.indexOf("−") > -3 ? s.replace(/[—–−]/g, "-") : s);

/** dict[s], then dash-normalized fallback. */
function dictGet(state: Di18nState, s: string): string | undefined {
	const hit = state.dict[s];
	if (hit !== undefined) return hit;
	return state.dictNorm[normDash(s)];
}

function loadDict(state: Di18nState): number {
	try {
		const raw = readFileSync(DICT_PATH, "utf-8");
		const obj = JSON.parse(raw) as Dict;
		state.dict = {};
		state.dictNorm = {};
		for (const [k, v] of Object.entries(obj)) {
			if (typeof k === "string" && typeof v === "string" && k && v) {
				state.dict[k] = v; // k === v = intentional passthrough (brand/id), also suppresses miss-logging
				const nk = normDash(k);
				if (!(nk in state.dictNorm)) state.dictNorm[nk] = v;
			}
		}
		g[TEMPLATE_KEY] = null; // invalidate template cache on (re)load
		g[LINERE_KEY] = undefined;
		return Object.keys(state.dict).length;
	} catch {
		state.dict = {};
		return 0;
	}
}

// ---------------------------------------------------------------------------
// Translation core
// ---------------------------------------------------------------------------

const CJK_RE = /[　-鿿＀-￯]/;
const LATIN_RE = /[a-zA-Z]/;
const ANSI_RE = /\x1b\[[0-9;]*m/g;

/** Heuristic: does this string look like a piece of English UI chrome? */
function looksTranslatable(s: string): boolean {
	const t = s.trim();
	if (t.length < 2 || t.length > 200) return false;
	if (!LATIN_RE.test(t)) return false;
	if (CJK_RE.test(t)) return false;
	// Skip code-ish strings: paths, URLs, brace templates, snake_case ids
	if (/[`{}\\<>]/.test(t)) return false;
	if (/^(https?|ssh|git@|file):/i.test(t)) return false;
	if (/^\/?(?:[\w.-]+\/)+[\w.-]+$/.test(t)) return false; // bare path
	if (/^[a-z][a-z0-9_-]*$/.test(t)) return false; // single lowercase identifier
	return true;
}

function recordMiss(state: Di18nState, s: string): void {
	const t = s.trim();
	if (!looksTranslatable(t) || dictGet(state, t) !== undefined) return;
	// Status/data strings: strip leading icons & punctuation; what remains may
	// be a lone token (model id, path, percent) or a "name v1.2.3" banner.
	const core = t.replace(/^[^＀-￯\p{L}\p{N}]+/u, "").trim();
	if (/^[\w:.\-~%/\\]+$/u.test(core)) return;
	if (/^[\w.@-]+\s+v?\d+\.\d+/i.test(core)) return;
	if (!/\s/.test(t) && /^[\w:.\-/]+$/.test(t)) return;
	if (state.misses.has(t)) return;
	state.misses.add(t);
	state.stats.missed++;
	if (state.missTimer) return;
	state.missTimer = setTimeout(() => {
		state.missTimer = null;
		try {
			const lines = [...state.misses].join("\n") + "\n";
			writeFileSync(MISS_PATH, lines);
		} catch {
			// ignore
		}
	}, 2000);
	state.missTimer.unref?.();
}

const TEMPLATE_KEY = "__omp_di18n_templates__";
const LINERE_KEY = "__omp_di18n_linere__";
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * One alternation over all substring-safe dict keys (len>=3, not a bare
 * lowercase word), longest-first, word-boundary anchored. Cached per dict load.
 */
function getLineRegex(state: Di18nState): RegExp | null {
	if (g[LINERE_KEY] === undefined) {
		const keys = Object.keys(state.dict)
			.filter(k => k.length >= 3 && !/^[a-z]+$/.test(k))
			.sort((a, b) => b.length - a.length);
		g[LINERE_KEY] = keys.length
			? new RegExp(`(?<![A-Za-z0-9_])(?:${keys.map(escapeRe).join("|")})(?![A-Za-z0-9_])`, "g")
			: null;
	}
	return g[LINERE_KEY] as RegExp | null;
}

/** Build `${expr}` template matchers from dict keys like "  Search: ${query}". */
function getTemplates(state: Di18nState): { re: RegExp; to: string }[] {
	if (!g[TEMPLATE_KEY]) {
		g[TEMPLATE_KEY] = Object.entries(state.dict)
			.filter(([k]) => k.includes("${"))
			.map(([k, to]) => {
				const parts = k.split(/\$\{[^}]*\}/);
				return {
					re: new RegExp("^" + parts.map(escapeRe).join("([\\s\\S]*?)") + "$"),
					to,
				};
			});
	}
	return g[TEMPLATE_KEY] as { re: RegExp; to: string }[];
}

function applyTemplate(tpl: string, captures: string[]): string {
	let i = 0;
	return tpl.replace(/\$\{[^}]*\}/g, () => captures[i++] ?? "");
}

/** Status words that appear after "Label: " in dynamic descriptions. */
const STATUS_ZH: Record<string, string> = {
	on: "开",
	off: "关",
	headless: "无头",
	none: "无",
	ready: "就绪",
	blocked: "已阻塞",
	enabled: "已启用",
	disabled: "已禁用",
	available: "可用",
	paused: "已暂停",
	inactive: "未激活",
	"not in collab": "未在协作中",
	"blocked by plan mode": "被计划模式阻塞",
	"plan mode inactive": "计划模式未激活",
	"drop context, keep session": "丢弃上下文，保留会话",
	"choose provider": "选择 provider",
};

/** Regex rules for dynamic strings that embed counters/paths (evaluated in order). */
const DYN_RULES: [RegExp, (m: RegExpExecArray) => string][] = [
	[/^(\d+) skills$/, m => `${m[1]} 个技能`],
	[/^New version (\S+) is available\. Run: (.+)$/, m => `新版本 ${m[1]} 可用。运行：${m[2]}`],
	[/^Context: (\d+%) \((.+)\)$/, m => `上下文：${m[1]}（${m[2]}）`],
	[/^Tools: (\d+) active \/ (\d+) available$/, m => `工具：${m[1]} 启用 / ${m[2]} 可用`],
	[/^Force: (\d+) active tools$/, m => `Force：${m[1]} 个活跃工具`],
	[/^Compact: context (\d+%) used$/, m => `Compact：上下文已用 ${m[1]}`],
	[/^Plan mode enabled\. Plan file: (.+)$/, m => `计划模式已启用。计划文件：${m[1]}`],
	[/^Model: (.+)$/, m => `模型：${m[1]}`],
	// "X mode enabled." / "X mode disabled." one-liners (descriptions with
	// trailing sentences still need full dict entries).
	[/^(.{1,40}?) mode (enabled|disabled)\.?$/, m => `${m[1]} 模式已${m[2] === "enabled" ? "启用" : "关闭"}。`],
	// "· /path (59m ago)" — recent-session rows on the welcome screen.
	// Compact output so it never exceeds the original cell width.
	[
		/^(·?\s*)(.*?)\s*\((\d+)([smhd])\s*ago\)$/,
		m => `${m[1]}${m[2]}(${m[3]}${{ s: "秒", m: "分", h: "时", d: "天" }[m[4] as "s" | "m" | "h" | "d"]}前)`,
	],
];

/** Exact dict + template match only (no rules/recursion — used for compositional parts). */
function tExact(state: Di18nState, s: string): string {
	const hit = dictGet(state, s);
	if (hit !== undefined) return hit;
	for (const { re, to } of getTemplates(state)) {
		const m = re.exec(s);
		if (m) return applyTemplate(to, m.slice(1));
	}
	return s;
}

/** Translate a string: exact dict → templates → ANSI → dynamic rules → "Label: rest" split. Logs misses. */
function t(state: Di18nState, s: unknown): unknown {
	if (!state.enabled || typeof s !== "string" || s.length === 0) return s;
	const hit = dictGet(state, s);
	if (hit !== undefined) {
		if (hit !== s) state.stats.translated++;
		return hit;
	}
	for (const { re, to } of getTemplates(state)) {
		const m = re.exec(s);
		if (m) {
			state.stats.translated++;
			return applyTemplate(to, m.slice(1));
		}
	}
	// ANSI-wrapped run: translate the visible text, splice back into the codes.
	if (s.includes("\x1b")) {
		const clean = s.replace(ANSI_RE, "");
		const tr = t(state, clean) as string;
		return tr !== clean ? s.replace(clean, tr) : s;
	}
	for (const [re, fn] of DYN_RULES) {
		const m = re.exec(s);
		if (m) {
			state.stats.translated++;
			return fn(m);
		}
	}
	// Compositional: "Label: status" — translate each side independently.
	const cm = /^(.{1,80}?): (.+)$/.exec(s);
	if (cm) {
		const l = tExact(state, cm[1]!);
		const r = STATUS_ZH[cm[2]!.toLowerCase()] ?? tExact(state, cm[2]!);
		if (l !== cm[1] || r !== cm[2]) {
			state.stats.translated++;
			return `${l}: ${r}`;
		}
	}
	recordMiss(state, s);
	return s;
}

const ANSI_SPLIT_RE = /(\x1b\[[0-9;]*m)/;

function charWidth(cp: number): number {
	return cp >= 0x1100 &&
		(cp <= 0x115f ||
			(cp >= 0x2e80 && cp <= 0xa4cf) ||
			(cp >= 0xac00 && cp <= 0xd7a3) ||
			(cp >= 0xf900 && cp <= 0xfaff) ||
			(cp >= 0xfe30 && cp <= 0xfe6f) ||
			(cp >= 0xff00 && cp <= 0xff60) ||
			(cp >= 0xffe0 && cp <= 0xffe6) ||
			(cp >= 0x1f300 && cp <= 0x1faff) ||
			(cp >= 0x20000 && cp <= 0x3fffd))
		? 2
		: 1;
}

/** Approximate terminal cell width (CJK/wide = 2, else 1). */
function visWidth(s: string): number {
	let w = 0;
	for (const ch of s) w += charWidth(ch.codePointAt(0)!);
	return w;
}

/** Clip a string to `w` display cells (used for boxed lines that must not overflow). */
function clipToWidth(s: string, w: number): string {
	if (visWidth(s) <= w) return s;
	let acc = 0;
	let i = 0;
	for (const ch of s) {
		const cw = charWidth(ch.codePointAt(0)!);
		if (acc + cw > w) break;
		acc += cw;
		i += ch.length;
	}
	return s.slice(0, i);
}

const BOX_CHAR_RE = /[│┃╎┆╽╿]/;

/**
 * Pad `out` back to `orig`'s display width after translation. Chinese text is
 * usually narrower than the English it replaces, which breaks drawn boxes —
 * pad before the trailing box char (or at end) so columns/borders stay put.
 */
function padToWidth(orig: string, out: string): string {
	const deficit = visWidth(orig) - visWidth(out);
	if (deficit <= 0) return out;
	const pad = " ".repeat(deficit);
	if (BOX_CHAR_RE.test(out)) {
		// Insert before the last box-drawing char so the right border stays aligned.
		const idx = out.lastIndexOf(out.match(/[│┃╎┆╽╿](?![\s\S]*[│┃╎┆╽╿])/)![0]);
		return out.slice(0, idx) + pad + out.slice(idx);
	}
	return out + pad;
}

/** Translate a rendered line: match on the trimmed content, preserve padding.
 *  `inBox` marks lines drawn inside a bordered box — translations there must
 *  not exceed the original width or the right border gets pushed out. */
function translateLine(state: Di18nState, line: string, inBox?: boolean): string {
	if (!state.enabled || typeof line !== "string") return line;
	if (inBox === undefined) inBox = BOX_CHAR_RE.test(line);
	const fit = (orig: string, out: string) => {
		let r = out;
		if (inBox && visWidth(r) > visWidth(orig)) {
			// Over-wide inside a box: clip content but keep a trailing border char.
			r = BOX_CHAR_RE.test(r.slice(-1))
				? clipToWidth(r.slice(0, -1), visWidth(orig) - 1) + r.slice(-1)
				: clipToWidth(r, visWidth(orig));
		}
		return padToWidth(orig, r);
	};
	// ANSI-styled line: split into code/text runs and translate each text run.
	if (ANSI_SPLIT_RE.test(line)) {
		return line
			.split(ANSI_SPLIT_RE)
			.map(part => (ANSI_SPLIT_RE.test(part) ? part : translateLine(state, part, inBox)))
			.join("");
	}
	const trimmed = line.trim();
	if (!trimmed) return line;
	const lead = line.slice(0, line.length - line.trimStart().length);
	const trail = line.slice(line.trimEnd().length);
	const hit = dictGet(state, trimmed);
	if (hit !== undefined) {
		state.stats.translated++;
		return lead + fit(trimmed, hit) + trail;
	}
	for (const [re, fn] of DYN_RULES) {
		const m = re.exec(trimmed);
		if (m) {
			state.stats.translated++;
			return lead + fit(trimmed, fn(m)) + trail;
		}
	}
	// Compositional: "Label: rest" — translate each side independently.
	const cm = /^(.{1,80}?): (.+)$/.exec(trimmed);
	if (cm) {
		const l = tExact(state, cm[1]!);
		const r = STATUS_ZH[cm[2]!.toLowerCase()] ?? tExact(state, cm[2]!);
		if (l !== cm[1] || r !== cm[2]) {
			state.stats.translated++;
			return lead + fit(trimmed, `${l}: ${r}`) + trail;
		}
	}
	// Substring pass for composite lines ("A · B · C" footers, "Settings: X").
	// One alternation regex over all dict keys, longest-first so "Tasks" wins
	// over "Task"; word-boundary anchored so we never chew half a word.
	if (LATIN_RE.test(trimmed) && !CJK_RE.test(trimmed)) {
		const re = getLineRegex(state);
		if (re) {
			const out = line.replace(re, m => state.dict[m] ?? m);
			if (out !== line) {
				state.stats.translated++;
				// Partial translation: a run of >=4 English words survives —
				// log the original so the whole sentence can get a dict entry.
				if (/[A-Za-z][A-Za-z'/-]*(?:\s+[A-Za-z][A-Za-z'/-]*){3,}/.test(out)) {
					recordMiss(state, trimmed);
				}
				return fit(line, out);
			}
		}
		recordMiss(state, line);
	}
	return line;
}

/** Exact-match line translation only — for content components where a
 *  substring pass could mangle model/user text. */
function translateLineExact(state: Di18nState, line: string): string {
	if (!state.enabled || typeof line !== "string") return line;
	if (ANSI_SPLIT_RE.test(line)) {
		return line
			.split(ANSI_SPLIT_RE)
			.map(part => (ANSI_SPLIT_RE.test(part) ? part : translateLineExact(state, part)))
			.join("");
	}
	const trimmed = line.trim();
	const hit = trimmed ? dictGet(state, trimmed) : undefined;
	if (hit === undefined) return line;
	state.stats.translated++;
	const lead = line.slice(0, line.length - line.trimStart().length);
	const trail = line.slice(line.trimEnd().length);
	return lead + hit + trail;
}

/**
 * renderWelcomeTip word-wraps the tip body to the terminal width BEFORE our
 * render patch sees it, so each fragment can never match a full dict key.
 * Detect the "Tip: " block in WelcomeComponent output, rejoin the wrapped
 * fragments, translate the whole tip, re-wrap the Chinese, and splice the
 * lines back — preserving each line's original ANSI clothes.
 */
function rewrapTips(state: Di18nState, lines: string[]): string[] {
	const keys = Object.keys(state.dictNorm);
	const out = lines.slice();
	for (let i = 0; i < out.length; i++) {
		const raw = out[i]!;
		const plain = raw.replace(ANSI_RE, "");
		const ti = plain.indexOf("Tip: ");
		if (ti === -1) continue;
		let acc = plain.slice(ti + 5).trim();
		if (!acc) continue;
		let last = i;
		for (let j = i + 1; j < out.length && j <= i + 8; j++) {
			const cand = out[j]!.replace(ANSI_RE, "").trim();
			if (!cand || BOX_CHAR_RE.test(cand)) break;
			const tryAcc = `${acc} ${cand}`;
			if (keys.some(k => k.startsWith(normDash(tryAcc)))) {
				acc = tryAcc;
				last = j;
			} else break;
		}
		const zh = dictGet(state, acc) ?? dictGet(state, `Tip: ${acc}`);
		if (zh === undefined || zh === acc) continue;
		const bodyW = Math.max(8, visWidth(plain) - ti - 5);
		const segs: string[] = [];
		let cur = "";
		let w = 0;
		for (const ch of zh) {
			const cw = charWidth(ch.codePointAt(0)!);
			if (w + cw > bodyW && cur) {
				segs.push(cur);
				cur = "";
				w = 0;
			}
			cur += ch;
			w += cw;
		}
		if (cur) segs.push(cur);
		const maxLines = last - i + 1;
		if (segs.length > maxLines) segs.length = maxLines;
		for (let k = 0; k < maxLines; k++) {
			const seg = segs[k];
			const rl = out[i + k]!;
			if (seg === undefined) {
				out[i + k] = "";
				continue;
			}
			if (k === 0) {
				const idx = rl.indexOf("Tip: ");
				const tail = rl.slice(idx + 5);
				const leadA = /^(\x1b\[[0-9;]*m)+/.exec(tail)?.[0] ?? "";
				const trailA = /(\x1b\[[0-9;]*m)+$/.exec(tail)?.[0] ?? "";
				out[i] = rl.slice(0, idx) + "提示：" + leadA + seg + trailA;
			} else {
				const vis = rl.replace(ANSI_RE, "").trim();
				const pos = rl.lastIndexOf(vis);
				if (pos === -1) continue;
				out[i + k] = rl.slice(0, pos) + " " + seg + rl.slice(pos + vis.length);
			}
		}
		i = last;
	}
	return out;
}

const ITEM_TEXT_FIELDS = ["label", "description", "warning", "hint", "title", "text", "placeholder"] as const;
const ITEM_LIST_FIELDS = ["values", "options", "choices"] as const;

/** Shallow-copy a menu/setting item with its display fields translated. */
function translateItem(state: Di18nState, item: unknown): unknown {
	if (!state.enabled || item === null || typeof item !== "object" || Array.isArray(item)) {
		if (typeof item === "string") return t(state, item);
		return item;
	}
	const src = item as Record<string, unknown>;
	let out: Record<string, unknown> | null = null;
	for (const f of ITEM_TEXT_FIELDS) {
		const v = src[f];
		const hit = typeof v === "string" ? dictGet(state, v) : undefined;
		if (hit !== undefined) {
			if (!out) out = { ...src };
			out[f] = hit;
			state.stats.translated++;
		} else if (typeof v === "string") {
			recordMiss(state, v);
		}
	}
	for (const f of ITEM_LIST_FIELDS) {
		const v = src[f];
		if (Array.isArray(v) && v.some(x => typeof x === "string" && dictGet(state, x) !== undefined)) {
			if (!out) out = { ...src };
			out[f] = v.map(x => (typeof x === "string" ? (dictGet(state, x) ?? x) : x));
		}
	}
	return out ?? item;
}

// ---------------------------------------------------------------------------
// Prototype patching
// ---------------------------------------------------------------------------

function patchMethod(proto: any, name: string, make: (orig: any) => any): boolean {
	const cur = proto?.[name];
	if (typeof cur !== "function" || cur.__ompDi18n) return false;
	const wrapped = make(cur);
	wrapped.__ompDi18n = true;
	proto[name] = wrapped;
	return true;
}

function patchGetter(proto: any, name: string, transform: (v: any) => any): boolean {
	const desc = Object.getOwnPropertyDescriptor(proto, name);
	if (!desc?.get || desc.get.__ompDi18n) return false;
	const orig = desc.get;
	const wrapped = function (this: unknown) {
		return transform(orig.call(this));
	};
	wrapped.__ompDi18n = true;
	Object.defineProperty(proto, name, { ...desc, get: wrapped });
	return true;
}

async function installPatches(state: Di18nState): Promise<string[]> {
	const applied: string[] = [];
	let tui: any;
	try {
		tui = await import("@oh-my-pi/pi-tui");
	} catch {
		try {
			tui = await import("@earendil-works/pi-tui");
		} catch {
			return applied;
		}
	}

	// MenuSelection: covers SelectList + SettingsList + every consumer menu.
	if (tui.MenuSelection?.prototype) {
		const xf = (items: any) =>
			Array.isArray(items) ? items.map(i => translateItem(state, i)) : items;
		if (patchGetter(tui.MenuSelection.prototype, "visibleItems", xf)) applied.push("MenuSelection.visibleItems");
		if (patchGetter(tui.MenuSelection.prototype, "items", xf)) applied.push("MenuSelection.items");
	}

	// SelectList / SettingsList setItems for components not going through MenuSelection.
	for (const cls of ["SelectList", "SettingsList"]) {
		const proto = tui[cls]?.prototype;
		if (!proto) continue;
		if (
			patchMethod(proto, "setItems", (orig: any) =>
				function (this: unknown, items: any, ...rest: any[]) {
					const mapped = Array.isArray(items) ? items.map(i => translateItem(state, i)) : items;
					return orig.call(this, mapped, ...rest);
				})
		)
			applied.push(`${cls}.setItems`);
	}

	// Slash-command / autocomplete descriptions.
	const ac = tui.CombinedAutocompleteProvider?.prototype;
	if (ac) {
		const wrapItems = (res: any) => {
			if (res && Array.isArray(res.items)) {
				return {
					...res,
					items: res.items.map((i: any) =>
						i && typeof i === "object" && typeof i.description === "string"
							? { ...i, description: t(state, i.description) }
							: i),
				};
			}
			return res;
		};
		if (
			patchMethod(ac, "getSuggestions", (orig: any) =>
				async function (this: unknown, ...args: any[]) {
					return wrapItems(await orig.apply(this, args));
				})
		)
			applied.push("Autocomplete.getSuggestions");
		if (
			patchMethod(ac, "trySyncSlashCompletion", (orig: any) =>
				function (this: unknown, ...args: any[]) {
					return wrapItems(orig.apply(this, args));
				})
		)
			applied.push("Autocomplete.trySyncSlashCompletion");
		if (
			patchMethod(ac, "getInlineHint", (orig: any) =>
				function (this: unknown, ...args: any[]) {
					const hint = orig.apply(this, args);
					return typeof hint === "string" ? t(state, hint) : hint;
				})
		)
			applied.push("Autocomplete.getInlineHint");
	}

	// Text (and subclasses: Loader etc.) — setText for live updates, render for
	// constructor-supplied strings. Exact-match only on setText; render gets the
	// line translator.
	for (const cls of ["Text", "Loader", "CancellableLoader", "TruncatedText"]) {
		const proto = tui[cls]?.prototype;
		if (!proto) continue;
		if (
			patchMethod(proto, "setText", (orig: any) =>
				function (this: unknown, text: any, ...rest: any[]) {
					return orig.call(this, typeof text === "string" ? t(state, text) : text, ...rest);
				})
		)
			applied.push(`${cls}.setText`);
		if (
			patchMethod(proto, "render", (orig: any) =>
				function (this: unknown, ...args: any[]) {
					const lines = orig.apply(this, args);
					return Array.isArray(lines) ? lines.map(l => translateLine(state, l)) : lines;
				})
		)
			applied.push(`${cls}.render`);
	}

	// Components that compose their own rendered lines (footers, item values,
	// section headers) instead of going through Text. Rendering output is
	// chrome-only, so line-translation is safe here.
	for (const cls of [
		"TabBar",
		"SelectList",
		"SettingsList",
		"KeyValueList",
		"Autocomplete",
		"Form",
		"Section",
		"Disclosure",
		"Menu",
	]) {
		const proto = tui[cls]?.prototype;
		if (!proto) continue;
		if (
			patchMethod(proto, "render", (orig: any) =>
				function (this: unknown, ...args: any[]) {
					const lines = orig.apply(this, args);
					return Array.isArray(lines) ? lines.map(l => translateLine(state, l)) : lines;
				})
		)
			applied.push(`${cls}.render`);
	}

	// Every component class re-exported by pi-coding-agent (welcome screen,
	// footer/status line, all selector/login overlays, …). Chrome-y components
	// get the full line translator; content components (chat, editors, diffs)
	// get exact-match only so model/user text is never substring-mangled.
	try {
		const agent = await import("@oh-my-pi/pi-coding-agent");
		const CHROME_RE = /welcome|footer|status|hint|selector|dialog|loader|wizard|menu|timer|title|border|hub|picker|overlay|countdown|segment|notice|banner/i;
		const CONTENT_RE = /editor|transcript|message|execution|diff|markdown|image|latex|tool|composer/i;
		for (const [name, exp] of Object.entries(agent)) {
			const proto = (exp as any)?.prototype;
			if (!proto || typeof proto.render !== "function") continue;
			const substring = CHROME_RE.test(name) && !CONTENT_RE.test(name);
			const isWelcome = name === "WelcomeComponent";
			if (
				patchMethod(proto, "render", (orig: any) =>
					function (this: unknown, ...args: any[]) {
						let lines = orig.apply(this, args);
						if (!Array.isArray(lines)) return lines;
						if (isWelcome) lines = rewrapTips(state, lines);
						return lines.map((l: string) =>
							substring ? translateLine(state, l) : translateLineExact(state, l));
					})
			)
				applied.push(`agent.${name}`);
		}
	} catch {
		// coding-agent barrel unavailable — chrome components stay untranslated
	}

	return applied;
}

// ---------------------------------------------------------------------------
// Extension entry
// ---------------------------------------------------------------------------

export default function ompDi18n(pi: any): void {
	const state = getState();
	const dictCount = loadDict(state);

	const report = (ctx: any, msg: string, kind: "info" | "warning" = "info") => {
		try {
			ctx?.ui?.notify?.(`[di18n] ${msg}`, kind);
		} catch {
			// headless
		}
	};

	const install = async (ctx?: any) => {
		if (state.installed) return;
		try {
			const applied = await installPatches(state);
			state.installed = applied.length > 0;
			try {
				writeFileSync(
					join(BASE_DIR, "omp-di18n-debug.txt"),
					`installed=${state.installed}\ndict=${Object.keys(state.dict).length}\npatches:\n${applied.join("\n")}\n`,
				);
			} catch {}
			report(
				ctx,
				state.installed
					? `已启用 zh-CN 界面汉化（${dictCount} 条字典，patch: ${applied.join(", ")}）`
					: "未找到可 patch 的组件（omp 版本可能不兼容）",
				state.installed ? "info" : "warning",
			);
		} catch (e) {
			report(ctx, `汉化 patch 失败：${String(e)}`, "warning");
		}
	};

	// Install as early as possible so dialogs built during startup get patched.
	void install().catch(() => {});

	pi.on?.("session_start", async (_e: unknown, ctx: any) => {
		await install(ctx).catch(() => {});
	});

	// /di18n — on | off | reload | stats | misses
	pi.registerCommand?.("di18n", {
		description: "omp-di18n：界面汉化开关与诊断",
		handler: async (args: string, ctx: any) => {
			const cmd = String(args ?? "").trim().toLowerCase();
			switch (cmd) {
				case "off":
					state.enabled = false;
					report(ctx, "汉化已关闭（重启 omp 恢复默认）");
					return;
				case "on":
					state.enabled = true;
					report(ctx, "汉化已开启");
					return;
				case "reload": {
					const n = loadDict(state);
					state.misses.clear();
					report(ctx, `字典已重载：${n} 条`);
					return;
				}
				case "misses":
					report(ctx, `未翻译候选 ${state.misses.size} 条 → ${MISS_PATH}`);
					return;
				default:
					report(
						ctx,
						`di18n: ${state.enabled ? "on" : "off"} · dict=${Object.keys(state.dict).length} · translated=${state.stats.translated} · missed=${state.stats.missed}（用法: /di18n on|off|reload|misses）`,
					);
			}
		},
	});
}
