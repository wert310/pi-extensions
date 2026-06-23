/**
 * LSP Output Summarizer Extension
 * 
 * Intercepts lsp tool results and:
 * 1. Truncates large outputs using pi's built-in truncation utilities
 * 2. Saves full output to a temp file when truncated
 * 3. Calls a configurable subagent model to summarize the output
 * 4. Returns the summary to the main agent
 * 
 * Configuration via settings.json or environment variables:
 * - lspSummarize.model: Model to use for summarization (default: "ollama/qwen2.5:32b")
 * - lspSummarize.prompt: Custom prompt template for summarization
 * - lspSummarize.maxBytes: Max bytes before truncation (default: 50KB)
 * - lspSummarize.maxLines: Max lines before truncation (default: 2000)
 */

import { mkdtemp, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as fs from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	formatSize,
	truncateHead,
	truncateTail,
	type TruncationResult,
	withFileMutationQueue,
} from "@earendil-works/pi-coding-agent";
import { complete, getModel } from "@earendil-works/pi-ai";
import { Type } from "typebox";

// Configuration interface
interface LspSummarizeConfig {
	model: string;
	prompt: string;
	maxBytes: number;
	maxLines: number;
	truncateMode: "head" | "tail"; // "head" keeps beginning, "tail" keeps end
}

// Default configuration
const DEFAULT_CONFIG: LspSummarizeConfig = {
	model: "", // Empty means use the current model in the session
	prompt: `Summarize this LSP (Language Server Protocol) output concisely. Focus on:
- Key findings, errors, or warnings
- Important definitions, references, or diagnostics
- Actionable information for the developer

Keep the summary structured and brief (3-10 bullet points if possible).

<LSP_OUTPUT>
{output}
</LSP_OUTPUT>`,
	maxBytes: DEFAULT_MAX_BYTES,
	maxLines: DEFAULT_MAX_LINES,
	truncateMode: "tail", // For LSP output, we usually want to see errors at the end
};

// Load configuration from settings or environment
function loadConfig(): LspSummarizeConfig {
	const config = { ...DEFAULT_CONFIG };

	// Try to load from settings.json if available
	try {
		const settingsPath = join(process.env.HOME || "~", ".pi", "settings.json");
		const settings = JSON.parse(require("node:fs").readFileSync(settingsPath, "utf-8"));
		
		if (settings.lspSummarize) {
			if (settings.lspSummarize.model) config.model = settings.lspSummarize.model;
			if (settings.lspSummarize.prompt) config.prompt = settings.lspSummarize.prompt;
			if (settings.lspSummarize.maxBytes) config.maxBytes = settings.lspSummarize.maxBytes;
			if (settings.lspSummarize.maxLines) config.maxLines = settings.lspSummarize.maxLines;
			if (settings.lspSummarize.truncateMode) config.truncateMode = settings.lspSummarize.truncateMode;
		}
	} catch {
		// Settings file doesn't exist or is invalid, use defaults
	}

	// Environment variables override
	if (process.env.LSP_SUMMARIZE_MODEL) config.model = process.env.LSP_SUMMARIZE_MODEL;
	if (process.env.LSP_SUMMARIZE_PROMPT) config.prompt = process.env.LSP_SUMMARIZE_PROMPT;
	if (process.env.LSP_SUMMARIZE_MAX_BYTES) config.maxBytes = parseInt(process.env.LSP_SUMMARIZE_MAX_BYTES, 10);
	if (process.env.LSP_SUMMARIZE_MAX_LINES) config.maxLines = parseInt(process.env.LSP_SUMMARIZE_MAX_LINES, 10);
	if (process.env.LSP_SUMMARIZE_TRUNCATE_MODE) {
		const mode = process.env.LSP_SUMMARIZE_TRUNCATE_MODE;
		if (mode === "head" || mode === "tail") config.truncateMode = mode;
	}

	return config;
}

interface LspToolDetails {
	action: string;
	file?: string;
	line?: number;
	column?: number;
	query?: string;
	format?: string;
	truncation?: TruncationResult;
	fullOutputPath?: string;
	summary?: string;
	summaryModel?: string;
}

export default function (pi: ExtensionAPI) {
	pi.on("tool_result", async (event, ctx) => {
		// Only process lsp tool results
		if (event.toolName !== "lsp") {
			return;
		}

		const config = loadConfig();
		
		// Get the current content
		const content = event.content;
		if (!content || content.length === 0) {
			return;
		}

		// Extract text content
		const textContent = content
			.filter((c): c is { type: "text"; text: string } => c.type === "text")
			.map((c) => c.text)
			.join("\n");

		if (!textContent) {
			return;
		}

		// Check if output needs truncation
		const totalBytes = Buffer.byteLength(textContent, "utf-8");
		const totalLines = textContent.split("\n").length;
		const needsTruncation = totalBytes > config.maxBytes || totalLines > config.maxLines;

		if (!needsTruncation) {
			// Output is small enough, no need to summarize
			return;
		}

		// Apply truncation
		const truncation = config.truncateMode === "head"
			? truncateHead(textContent, { maxLines: config.maxLines, maxBytes: config.maxBytes })
			: truncateTail(textContent, { maxLines: config.maxLines, maxBytes: config.maxBytes });

		// Save full output to temp file
		const tempDir = await mkdtemp(join(tmpdir(), "pi-lsp-"));
		const tempFile = join(tempDir, "output.txt");
		await withFileMutationQueue(tempFile, async () => {
			await writeFile(tempFile, textContent, "utf-8");
		});

		// Build truncation notice
		const truncatedLines = truncation.totalLines - truncation.outputLines;
		const truncatedBytes = truncation.totalBytes - truncation.outputBytes;
		
		let resultText = truncation.content;
		resultText += `\n\n[Output truncated: showing ${truncation.outputLines} of ${truncation.totalLines} lines`;
		resultText += ` (${formatSize(truncation.outputBytes)} of ${formatSize(truncation.totalBytes)}).`;
		resultText += ` ${truncatedLines} lines (${formatSize(truncatedBytes)}) omitted.`;
		resultText += ` Full output saved to: ${tempFile}]`;

		// Try to summarize using the configured model
		try {
			// If no model configured, use the current session model
			let model;
			let modelId = config.model;
			
			if (!config.model || config.model.trim() === "") {
				// Use the current model from the session
				const currentModel = ctx.model;
				if (currentModel) {
					model = currentModel;
					modelId = `${currentModel.provider}/${currentModel.id}`;
				}
			} else {
				// Parse the configured model
				model = getModel(config.model.split("/")[0], config.model.split("/").slice(1).join("/"));
			}
			
			if (model) {
				const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
				
				if (auth.ok && auth.apiKey) {
					// Build the summarization prompt
					const summaryPrompt = config.prompt.replace("{output}", truncation.content);
					
					const summaryMessages = [
						{
							role: "user" as const,
							content: [{ type: "text" as const, text: summaryPrompt }],
							timestamp: Date.now(),
						},
					];

					const response = await complete(
						model,
						{ messages: summaryMessages },
						{
							apiKey: auth.apiKey,
							headers: auth.headers,
						},
					);

					const summary = response.content
						.filter((c): c is { type: "text"; text: string } => c.type === "text")
						.map((c) => c.text)
						.join("\n");

					// Prepend summary to the truncated output
					resultText = `## LSP Output Summary (generated by ${modelId})\n\n${summary}\n\n---\n\n${resultText}`;

					// Update the event content with the summary
					return {
						content: [{ type: "text", text: resultText }],
						details: {
							...event.details,
							truncation: truncation,
							fullOutputPath: tempFile,
							summary: summary,
							summaryModel: modelId,
						} as LspToolDetails,
					};
				}
			}
		} catch (error) {
			// If summarization fails, just return the truncated output
			const errorMsg = error instanceof Error ? error.message : "Unknown error";
			resultText += `\n\n[Summarization failed: ${errorMsg}]`;
		}

		// Return truncated output without summary
		return {
			content: [{ type: "text", text: resultText }],
			details: {
				...event.details,
				truncation: truncation,
				fullOutputPath: tempFile,
			} as LspToolDetails,
		};
	});
}
