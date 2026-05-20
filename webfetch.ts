/**
 * Web fetch tool for pi.
 *
 * Fetches the content of an exact URL.
 * This tool does not search; it fetches exactly the content of the URL you provide.
 * For HTML pages, it converts the page to simplified Markdown for readability.
 */

import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	formatSize,
	truncateHead,
	type TruncationResult,
	withFileMutationQueue,
	defineTool,
	type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const REQUEST_TIMEOUT_MS = 30_000;
const TEXTUAL_CONTENT_TYPES = [
	"text/",
	"application/json",
	"application/ld+json",
	"application/xml",
	"application/xhtml+xml",
	"application/javascript",
	"application/x-javascript",
	"application/ecmascript",
	"application/rss+xml",
	"application/atom+xml",
	"application/yaml",
	"application/x-yaml",
	"application/csv",
	"image/svg+xml",
] as const;

const NAMED_HTML_ENTITIES: Record<string, string> = {
	amp: "&",
	lt: "<",
	gt: ">",
	quot: '"',
	apos: "'",
	nbsp: " ",
};

interface WebFetchDetails {
	requestedUrl: string;
	finalUrl: string;
	status: number;
	statusText: string;
	contentType?: string;
	title?: string;
	convertedFromHtml: boolean;
	truncation?: TruncationResult;
	fullContentPath?: string;
}

function decodeHtmlEntities(input: string) {
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

function stripHtml(input: string) {
	return decodeHtmlEntities(input.replace(/<[^>]+>/g, " "));
}

function normalizeTextLine(input: string) {
	return input.replace(/\u00a0/g, " ").replace(/[ \t]+/g, " ").trim();
}

function resolveUrl(value: string, baseUrl: string) {
	const decoded = decodeHtmlEntities(value).trim();
	if (!decoded) return "";
	try {
		return new URL(decoded, baseUrl).toString();
	} catch {
		return decoded;
	}
}

function getRequestSignal(signal?: AbortSignal) {
	const timeoutSignal = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
	if (!signal || typeof AbortSignal.any !== "function") return signal ?? timeoutSignal;
	return AbortSignal.any([signal, timeoutSignal]);
}

function isTextLikeContentType(contentType?: string | null) {
	if (!contentType) return true;
	const lower = contentType.toLowerCase();
	return TEXTUAL_CONTENT_TYPES.some((type) => lower.includes(type))
		|| lower.includes("+json")
		|| lower.includes("+xml")
		|| lower.includes("yaml")
		|| lower.includes("csv")
		|| lower.includes("markdown");
}

function looksLikeHtml(text: string, contentType?: string | null) {
	const lower = contentType?.toLowerCase() ?? "";
	return lower.includes("html") || /<!doctype html\b|<html\b|<head\b|<body\b/i.test(text);
}

function extractTitle(html: string) {
	const titleMatch = html.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i);
	const title = normalizeTextLine(stripHtml(titleMatch?.[1] ?? ""));
	return title || undefined;
}

function extractPreferredHtmlRegion(html: string) {
	const candidates: string[] = [];

	for (const tag of ["main", "article"]) {
		const matches = [...html.matchAll(new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}>`, "gi"))];
		for (const match of matches) {
			if (match[1]) candidates.push(match[1]);
		}
	}

	if (candidates.length > 0) {
		return candidates.sort((a, b) => b.length - a.length)[0] ?? html;
	}

	const bodyMatch = html.match(/<body\b[^>]*>([\s\S]*?)<\/body>/i);
	return bodyMatch?.[1] ?? html;
}

function htmlToMarkdown(html: string, baseUrl: string) {
	let content = extractPreferredHtmlRegion(html)
		.replace(/<!--([\s\S]*?)-->/g, " ")
		.replace(/<(script|style|noscript|template|svg|canvas|iframe|object|embed|picture|video|audio|source)\b[\s\S]*?<\/\1>/gi, " ")
		.replace(/<(nav|footer|aside|form)\b[\s\S]*?<\/\1>/gi, " ");

	const placeholders: string[] = [];
	const stash = (value: string) => {
		const token = `@@PI_WEBFETCH_${placeholders.length}@@`;
		placeholders.push(value);
		return token;
	};

	content = content.replace(/<pre\b[^>]*>\s*<code\b([^>]*)>([\s\S]*?)<\/code>\s*<\/pre>/gi, (_match, attrs, inner) => {
		const language = String(attrs).match(/language-([a-z0-9_+-]+)/i)?.[1] ?? "";
		const code = decodeHtmlEntities(inner).replace(/\r\n?/g, "\n").trimEnd();
		return `\n\n${stash(`\`\`\`${language}\n${code}\n\`\`\``)}\n\n`;
	});

	content = content.replace(/<pre\b[^>]*>([\s\S]*?)<\/pre>/gi, (_match, inner) => {
		const code = decodeHtmlEntities(inner).replace(/\r\n?/g, "\n").trimEnd();
		return `\n\n${stash(`\`\`\`\n${code}\n\`\`\``)}\n\n`;
	});

	content = content.replace(/<code\b[^>]*>([\s\S]*?)<\/code>/gi, (_match, inner) => {
		const code = normalizeTextLine(stripHtml(inner));
		return code ? stash(`\`${code}\``) : "";
	});

	content = content.replace(/<a\b[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi, (_match, href, inner) => {
		const text = normalizeTextLine(stripHtml(inner));
		const resolved = resolveUrl(href, baseUrl);
		if (!text && !resolved) return "";
		if (!resolved) return text;
		if (!text || text === resolved) return `<${resolved}>`;
		return `[${text}](${resolved})`;
	});

	for (let level = 1; level <= 6; level++) {
		content = content.replace(new RegExp(`<h${level}\\b[^>]*>([\\s\\S]*?)<\\/h${level}>`, "gi"), (_match, inner) => {
			const text = normalizeTextLine(stripHtml(inner));
			return text ? `\n\n${"#".repeat(level)} ${text}\n\n` : "\n";
		});
	}

	content = content.replace(/<blockquote\b[^>]*>([\s\S]*?)<\/blockquote>/gi, (_match, inner) => {
		const text = stripHtml(inner)
			.replace(/\r\n?/g, "\n")
			.split("\n")
			.map((line) => normalizeTextLine(line))
			.filter(Boolean)
			.map((line) => `> ${line}`)
			.join("\n");
		return text ? `\n\n${text}\n\n` : "\n";
	});

	content = content
		.replace(/<br\s*\/?>/gi, "\n")
		.replace(/<(img|picture)\b[^>]*>/gi, " ")
		.replace(/<li\b[^>]*>/gi, "\n- ")
		.replace(/<\/(ul|ol)>/gi, "\n")
		.replace(/<(ul|ol)\b[^>]*>/gi, "\n")
		.replace(/<tr\b[^>]*>/gi, "\n")
		.replace(/<\/(tr|table|thead|tbody|tfoot)>/gi, "\n")
		.replace(/<(table|thead|tbody|tfoot)\b[^>]*>/gi, "\n")
		.replace(/<(td|th)\b[^>]*>/gi, "| ")
		.replace(/<\/(td|th)>/gi, " ")
		.replace(/<\/(p|div|section|article|main|header|figure|figcaption)>/gi, "\n\n")
		.replace(/<(p|div|section|article|main|header|figure|figcaption)\b[^>]*>/gi, "\n\n")
		.replace(/<hr\b[^>]*\/?\s*>/gi, "\n\n---\n\n")
		.replace(/<[^>]+>/g, " ");

	content = decodeHtmlEntities(content);

	for (const [index, value] of placeholders.entries()) {
		content = content.replaceAll(`@@PI_WEBFETCH_${index}@@`, value);
	}

	const lines = content.replace(/\r\n?/g, "\n").split("\n");
	const cleaned: string[] = [];
	let inCodeBlock = false;
	let blankLines = 0;

	for (const originalLine of lines) {
		const trimmedOriginal = originalLine.trim();
		if (trimmedOriginal.startsWith("```")) {
			if (!inCodeBlock && cleaned.length > 0 && cleaned[cleaned.length - 1] !== "") cleaned.push("");
			cleaned.push(trimmedOriginal);
			inCodeBlock = !inCodeBlock;
			blankLines = 0;
			continue;
		}

		if (inCodeBlock) {
			cleaned.push(originalLine.replace(/\s+$/g, ""));
			continue;
		}

		const line = normalizeTextLine(originalLine);
		if (!line) {
			if (cleaned.length > 0 && blankLines < 1) cleaned.push("");
			blankLines += 1;
			continue;
		}

		blankLines = 0;
		cleaned.push(line);
	}

	return cleaned.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

function formatFetchedContent(details: WebFetchDetails, body: string) {
	const lines = [
		"# Web Fetch",
		"",
		`- Requested URL: ${details.requestedUrl}`,
		`- Final URL: ${details.finalUrl}`,
		`- Status: ${details.status} ${details.statusText}`,
	];

	if (details.contentType) lines.push(`- Content-Type: ${details.contentType}`);
	if (details.title) lines.push(`- Title: ${details.title}`);
	if (details.convertedFromHtml) lines.push("- Note: HTML was converted to simplified Markdown for readability.");

	return `${lines.join("\n")}\n\n${body}`.trim();
}

async function writeTempContent(content: string, extension: string) {
	const dir = await mkdtemp(join(tmpdir(), "pi-webfetch-"));
	const path = join(dir, `content${extension}`);
	await withFileMutationQueue(path, async () => {
		await writeFile(path, content, "utf8");
	});
	return path;
}

export const webFetchTool = defineTool({
	name: "webfetch",
	label: "Web Fetch",
	description:
		"Fetch the content of a specific URL. This tool does not search; it fetches exactly the content of the URL you provide. HTML pages are converted to simplified Markdown for readability. Output is truncated to 2000 lines or 50KB if needed.",
	promptSnippet: "Fetch the content of an exact URL without searching",
	promptGuidelines: [
		"Use webfetch when you already know the exact URL you want to inspect.",
		"Do not use webfetch for search queries; use websearch for finding pages first.",
	],
	parameters: Type.Object({
		url: Type.String({ description: "Exact URL to fetch" }),
	}),

	async execute(_toolCallId, params, signal) {
		let parsedUrl: URL;
		try {
			parsedUrl = new URL(params.url);
		} catch {
			throw new Error(`Invalid URL: ${params.url}`);
		}

		if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") {
			throw new Error(`Unsupported URL protocol: ${parsedUrl.protocol}`);
		}

		const response = await fetch(parsedUrl, {
			headers: {
				accept: "text/html,application/xhtml+xml,application/json,text/plain;q=0.9,*/*;q=0.1",
				"accept-language": "en-US,en;q=0.9",
				"user-agent": "Mozilla/5.0 (compatible; pi-webfetch-extension/1.0)",
			},
			signal: getRequestSignal(signal),
		});

		const contentType = response.headers.get("content-type") ?? undefined;
		if (!isTextLikeContentType(contentType)) {
			throw new Error(`Unsupported content type for webfetch: ${contentType}`);
		}

		const rawText = await response.text();
		const convertedFromHtml = looksLikeHtml(rawText, contentType);
		const title = convertedFromHtml ? extractTitle(rawText) : undefined;
		const body = convertedFromHtml
			? htmlToMarkdown(rawText, response.url) || normalizeTextLine(stripHtml(rawText))
			: rawText.replace(/\r\n?/g, "\n").trim();

		const details: WebFetchDetails = {
			requestedUrl: parsedUrl.toString(),
			finalUrl: response.url,
			status: response.status,
			statusText: response.statusText,
			...(contentType ? { contentType } : {}),
			...(title ? { title } : {}),
			convertedFromHtml,
		};

		const formatted = formatFetchedContent(details, body || "(No readable text content returned)");
		const truncation = truncateHead(formatted, {
			maxLines: DEFAULT_MAX_LINES,
			maxBytes: DEFAULT_MAX_BYTES,
		});

		let output = truncation.content;
		if (truncation.truncated) {
			const fullContentPath = await writeTempContent(
				formatted,
				convertedFromHtml ? ".md" : contentType?.toLowerCase().includes("json") ? ".json" : ".txt",
			);
			details.truncation = truncation;
			details.fullContentPath = fullContentPath;

			output += `\n\n[Content truncated: showing ${truncation.outputLines} of ${truncation.totalLines} lines`;
			output += ` (${formatSize(truncation.outputBytes)} of ${formatSize(truncation.totalBytes)}).`;
			output += ` Full content saved to: ${fullContentPath}]`;
		}

		return {
			content: [{ type: "text", text: output }],
			details,
		};
	},
});

export default function (pi: ExtensionAPI) {
	pi.registerTool(webFetchTool);
}
