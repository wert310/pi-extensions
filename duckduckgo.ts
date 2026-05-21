/**
 * DuckDuckGo web search tool for pi.
 *
 * Scrapes https://duckduckgo.com/html/?q=... and returns a compact JSON payload
 * with an optional zero-click answer plus the top organic web results.
 */

import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";

const DUCKDUCKGO_HTML_URL = "https://duckduckgo.com/html/";
const DEFAULT_MAX_RESULTS = 8;
const HARD_MAX_RESULTS = 10;

const NAMED_HTML_ENTITIES: Record<string, string> = {
	amp: "&",
	lt: "<",
	gt: ">",
	quot: '"',
	apos: "'",
	nbsp: " ",
};

export interface DuckDuckGoSearchResult {
	rank: number;
	title: string;
	url: string;
	displayUrl?: string;
	snippet?: string;
}

export interface DuckDuckGoAnswer {
	text: string;
	title?: string;
	url?: string;
}

export interface DuckDuckGoSearchPayload {
	query: string;
	answer?: DuckDuckGoAnswer;
	results: DuckDuckGoSearchResult[];
}

function clampMaxResults(value?: number) {
	if (!Number.isFinite(value)) return DEFAULT_MAX_RESULTS;
	return Math.max(1, Math.min(HARD_MAX_RESULTS, Math.trunc(value!)));
}

export function decodeHtmlEntities(input: string) {
	return input.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (entity, code) => {
		const lower = String(code).toLowerCase();

		if (lower.startsWith("#x")) {
			const value = Number.parseInt(lower.slice(2), 16);
			return Number.isFinite(value) ? String.fromCodePoint(value) : entity;
		}

		if (lower.startsWith("#")) {
			const value = Number.parseInt(lower.slice(1), 10);
			return Number.isFinite(value) ? String.fromCodePoint(value) : entity;
		}

		return NAMED_HTML_ENTITIES[lower] ?? entity;
	});
}

export function normalizeWhitespace(input: string) {
	return input.replace(/\s+/g, " ").trim();
}

export function stripHtml(input: string) {
	return normalizeWhitespace(decodeHtmlEntities(input.replace(/<[^>]+>/g, " ")));
}

export function extractDuckDuckGoTargetUrl(href: string) {
	if (!href) return "";

	const decodedHref = decodeHtmlEntities(href).trim();
	const normalizedHref = decodedHref.startsWith("//")
		? `https:${decodedHref}`
		: decodedHref.startsWith("/")
			? new URL(decodedHref, DUCKDUCKGO_HTML_URL).toString()
			: decodedHref;

	try {
		const url = new URL(normalizedHref, DUCKDUCKGO_HTML_URL);
		if (url.hostname.endsWith("duckduckgo.com") && url.pathname === "/l/") {
			return url.searchParams.get("uddg") ?? normalizedHref;
		}
		return url.toString();
	} catch {
		return normalizedHref;
	}
}

function isLikelyAdHref(href: string) {
	const decodedHref = decodeHtmlEntities(href).toLowerCase();
	return decodedHref.includes("duckduckgo.com/y.js?")
		|| decodedHref.includes("/y.js?")
		|| decodedHref.includes("ad_domain=")
		|| decodedHref.includes("ad_provider=");
}

function isLikelyAdResult(className: string, chunk: string) {
	return /\bresult--ad\b/i.test(className)
		|| /\bbadge--ad\b/i.test(className)
		|| /\bresult__badge\b/i.test(chunk)
		|| />\s*sponsored\s*</i.test(chunk)
		|| /duckduckgo\.com\/y\.js\?/i.test(chunk)
		|| /\bad_domain=/i.test(chunk)
		|| /\bad_provider=/i.test(chunk);
}

export function extractDuckDuckGoAnswer(html: string): DuckDuckGoAnswer | undefined {
	const answerMatch = html.match(/<div class="zci__result"[^>]*>([\s\S]*?)<\/div>/i);
	if (!answerMatch) return undefined;

	const answerHtml = (answerMatch[1] ?? "")
		.replace(/<a\b[^>]*>\s*<img[\s\S]*?<\/a>/gi, " ")
		.replace(/<a\b[^>]*>\s*More at[\s\S]*?<\/a>/gi, " ");
	const text = stripHtml(answerHtml);
	if (!text) return undefined;

	const titleMatch = html.match(/<h1 class="zci__heading">\s*(?:<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>|([\s\S]*?))\s*<\/h1>/i);
	const title = stripHtml(titleMatch?.[2] ?? titleMatch?.[3] ?? "");
	const url = titleMatch?.[1] ? extractDuckDuckGoTargetUrl(titleMatch[1]) : undefined;

	return {
		text,
		...(title ? { title } : {}),
		...(url ? { url } : {}),
	};
}

function extractResultsSection(html: string) {
	const startToken = '<div id="links" class="results">';
	const startIndex = html.indexOf(startToken);
	if (startIndex < 0) return "";

	const afterStart = html.slice(startIndex + startToken.length);
	let endIndex = afterStart.length;

	for (const endToken of ['<div class="nav-link">', '<div class="feedback-btn">']) {
		const index = afterStart.indexOf(endToken);
		if (index >= 0 && index < endIndex) endIndex = index;
	}

	return afterStart.slice(0, endIndex);
}

export function parseDuckDuckGoHtml(html: string, maxResults = DEFAULT_MAX_RESULTS): DuckDuckGoSearchResult[] {
	const resultsSection = extractResultsSection(html);
	if (!resultsSection) return [];

	const resultBlocks = [...resultsSection.matchAll(/<div class="([^"]*\bresult\b[^"]*\bresults_links\b[^"]*)">([\s\S]*?)(?=<div class="[^"]*\bresult\b[^"]*\bresults_links\b[^"]*">|$)/g)];
	const results: DuckDuckGoSearchResult[] = [];
	const seenUrls = new Set<string>();
	const limit = clampMaxResults(maxResults);

	for (const match of resultBlocks) {
		const className = match[1] ?? "";
		const chunk = match[2] ?? "";
		if (isLikelyAdResult(className, chunk)) continue;

		const titleMatch = chunk.match(/<a[^>]*class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i);
		if (!titleMatch) continue;
		if (isLikelyAdHref(titleMatch[1] ?? "")) continue;

		const url = extractDuckDuckGoTargetUrl(titleMatch[1] ?? "");
		if (!url || seenUrls.has(url)) continue;
		seenUrls.add(url);

		const title = stripHtml(titleMatch[2] ?? "") || url;
		const displayUrlMatch = chunk.match(/<a[^>]*class="result__url"[^>]*>([\s\S]*?)<\/a>/i);
		const snippetMatch = chunk.match(/<a[^>]*class="result__snippet"[^>]*>([\s\S]*?)<\/a>/i);
		const displayUrl = displayUrlMatch ? stripHtml(displayUrlMatch[1] ?? "") : undefined;
		const snippet = snippetMatch ? stripHtml(snippetMatch[1] ?? "") : undefined;

		results.push({
			rank: results.length + 1,
			title,
			url,
			...(displayUrl ? { displayUrl } : {}),
			...(snippet ? { snippet } : {}),
		});

		if (results.length >= limit) break;
	}

	return results;
}

export async function searchDuckDuckGo(
	query: string,
	options: { maxResults?: number; signal?: AbortSignal } = {},
): Promise<DuckDuckGoSearchPayload> {
	const trimmedQuery = query.trim();
	if (!trimmedQuery) throw new Error("Query must not be empty");

	const url = new URL(DUCKDUCKGO_HTML_URL);
	url.searchParams.set("q", trimmedQuery);

	const response = await fetch(url, {
		headers: {
			"accept": "text/html,application/xhtml+xml",
			"accept-language": "en-US,en;q=0.9",
			"user-agent": "Mozilla/5.0 (compatible; pi-duckduckgo-extension/1.0)",
		},
		signal: options.signal,
	});

	if (!response.ok) {
		throw new Error(`DuckDuckGo request failed: ${response.status} ${response.statusText}`);
	}

	const html = await response.text();
	const answer = extractDuckDuckGoAnswer(html);
	return {
		query: trimmedQuery,
		...(answer ? { answer } : {}),
		results: parseDuckDuckGoHtml(html, options.maxResults),
	};
}

export const duckDuckGoTool = defineTool({
	name: "websearch",
	label: "Web Search",
	description:
		"Search the public web with DuckDuckGo HTML and return JSON with an optional answer plus organic results containing title, url, displayUrl, and snippet. Sponsored results are filtered when detected. Returns up to 10 results.",
	promptSnippet: "Search the public web using DuckDuckGo HTML and return JSON results",
	promptGuidelines: [
		"Use websearch when you need external or current web information that is not present in the repository or conversation.",
	],
	parameters: Type.Object({
		query: Type.String({ description: "Search query" }),
		maxResults: Type.Optional(
			Type.Integer({
				description: `Maximum number of results to return (default ${DEFAULT_MAX_RESULTS}, max ${HARD_MAX_RESULTS})`,
				minimum: 1,
				maximum: HARD_MAX_RESULTS,
			}),
		),
	}),

	async execute(_toolCallId, params, signal) {
		const payload = await searchDuckDuckGo(params.query, {
			maxResults: params.maxResults,
			signal,
		});

		return {
			content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
			details: payload,
		};
	},

	renderResult(result, { expanded, isPartial }, theme) {
		if (isPartial) {
			return new Text(theme.fg("warning", "Searching..."), 0, 0);
		}

		const details = result.details as DuckDuckGoSearchPayload | undefined;
		if (!expanded) {
			const count = details?.results.length ?? 0;
			return new Text(theme.fg("success", `${count} result${count === 1 ? "" : "s"}`), 0, 0);
		}

		const content = result.content.find((item) => item.type === "text");
		const text = content?.type === "text" ? content.text : "";
		return new Text(theme.fg("toolOutput", text ?? ""), 0, 0);
	},
});

export default function (pi: ExtensionAPI) {
	pi.registerTool(duckDuckGoTool);
}
