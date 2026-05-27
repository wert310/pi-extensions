import { appendFileSync } from "node:fs";
import type { ExtensionAPI, ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import {
	calculateCost,
	clampThinkingLevel,
	createAssistantMessageEventStream,
	getEnvApiKey,
	parseStreamingJson,
	type Context,
	type Model,
	type SimpleStreamOptions,
	type Tool,
} from "@earendil-works/pi-ai";
import { convertMessages } from "/home/ubuntu/.local/share/pi-node/node-v22.22.3-linux-x64/lib/node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-ai/dist/providers/openai-completions.js";

const API = "llamacpp-openai-completions";
const DEBUG = process.env.PI_LLAMACPP_PROGRESS_DEBUG === "1";
const LOG_FILE = "/tmp/llamacpp-progress.log";

let ui: ExtensionUIContext | undefined;

function debug(message: string, extra?: unknown): void {
	if (!DEBUG) return;
	try {
		const suffix = extra === undefined ? "" : ` ${JSON.stringify(extra)}`;
		appendFileSync(LOG_FILE, `${new Date().toISOString()} ${message}${suffix}\n`, "utf8");
	} catch {}
}

function stripTrailingSlash(url: string): string {
	return url.replace(/\/+$/, "");
}

function headersToRecord(headers: Headers): Record<string, string> {
	const result: Record<string, string> = {};
	for (const [key, value] of headers.entries()) {
		result[key] = value;
	}
	return result;
}

function formatProgress(progress: { total?: number; cache?: number; processed?: number; time_ms?: number }): string {
	const total = Math.max(0, Number(progress.total) || 0);
	const cache = Math.max(0, Number(progress.cache) || 0);
	const processed = Math.max(0, Number(progress.processed) || 0);
	const uncachedTotal = Math.max(0, total - cache);
	const uncachedProcessed = Math.max(0, processed - cache);
	const percent = uncachedTotal > 0
		? Math.max(0, Math.min(100, Math.round((100 * uncachedProcessed) / uncachedTotal)))
		: total > 0
			? Math.max(0, Math.min(100, Math.round((100 * processed) / total)))
			: 0;
	const seconds = Math.max(0, Number(progress.time_ms) || 0) / 1000;

	return [
		`Prompt ${percent}%`,
		`${processed}/${total}`,
		cache > 0 ? `cache ${cache}` : undefined,
		seconds > 0 ? `${seconds.toFixed(1)}s` : undefined,
	]
		.filter(Boolean)
		.join(" · ");
}

function getCompat(model: Model<any>) {
	const compat = (model.compat ?? {}) as Record<string, any>;
	return {
		supportsStore: compat.supportsStore ?? true,
		supportsDeveloperRole: compat.supportsDeveloperRole ?? true,
		supportsReasoningEffort: compat.supportsReasoningEffort ?? true,
		supportsUsageInStreaming: compat.supportsUsageInStreaming ?? true,
		maxTokensField: compat.maxTokensField ?? "max_completion_tokens",
		requiresReasoningContentOnAssistantMessages: compat.requiresReasoningContentOnAssistantMessages ?? false,
		thinkingFormat: compat.thinkingFormat ?? "openai",
		supportsStrictMode: compat.supportsStrictMode ?? true,
	};
}

function convertTools(tools: Tool[], compat: ReturnType<typeof getCompat>) {
	return tools.map((tool) => ({
		type: "function",
		function: {
			name: tool.name,
			description: tool.description,
			parameters: tool.parameters,
			...(compat.supportsStrictMode !== false && { strict: false }),
		},
	}));
}

function parseChunkUsage(rawUsage: any, model: Model<any>) {
	const promptTokens = rawUsage.prompt_tokens || 0;
	const cacheReadTokens = rawUsage.prompt_tokens_details?.cached_tokens ?? rawUsage.prompt_cache_hit_tokens ?? 0;
	const cacheWriteTokens = rawUsage.prompt_tokens_details?.cache_write_tokens || 0;
	const input = Math.max(0, promptTokens - cacheReadTokens - cacheWriteTokens);
	const outputTokens = rawUsage.completion_tokens || 0;
	const usage = {
		input,
		output: outputTokens,
		cacheRead: cacheReadTokens,
		cacheWrite: cacheWriteTokens,
		totalTokens: input + outputTokens + cacheReadTokens + cacheWriteTokens,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
	calculateCost(model, usage);
	return usage;
}

function mapStopReason(reason: string | null) {
	if (reason === null) return { stopReason: "stop" as const };
	switch (reason) {
		case "stop":
		case "end":
			return { stopReason: "stop" as const };
		case "length":
			return { stopReason: "length" as const };
		case "function_call":
		case "tool_calls":
			return { stopReason: "toolUse" as const };
		case "content_filter":
			return { stopReason: "error" as const, errorMessage: "Provider finish_reason: content_filter" };
		case "network_error":
			return { stopReason: "error" as const, errorMessage: "Provider finish_reason: network_error" };
		default:
			return { stopReason: "error" as const, errorMessage: `Provider finish_reason: ${reason}` };
	}
}

function buildPayload(model: Model<any>, context: Context, options: SimpleStreamOptions | undefined) {
	const compat = getCompat(model);
	const messages = convertMessages(model as any, context, compat as any);
	const params: Record<string, any> = {
		model: model.id,
		messages,
		stream: true,
		return_progress: true,
	};

	if (compat.supportsUsageInStreaming !== false) {
		params.stream_options = { include_usage: true };
	}
	if (compat.supportsStore) {
		params.store = false;
	}
	if (options?.maxTokens) {
		if (compat.maxTokensField === "max_tokens") {
			params.max_tokens = options.maxTokens;
		} else {
			params.max_completion_tokens = options.maxTokens;
		}
	}
	if (options?.temperature !== undefined) {
		params.temperature = options.temperature;
	}
	if (context.tools && context.tools.length > 0) {
		params.tools = convertTools(context.tools, compat);
	}

	const reasoningLevel = options?.reasoning ? clampThinkingLevel(model, options.reasoning) : undefined;
	const reasoningEffort = reasoningLevel === "off" ? undefined : reasoningLevel;
	if (compat.thinkingFormat === "qwen-chat-template" && model.reasoning) {
		params.chat_template_kwargs = {
			enable_thinking: !!reasoningEffort,
			preserve_thinking: true,
		};
	} else if (compat.thinkingFormat === "openai" && reasoningEffort && model.reasoning && compat.supportsReasoningEffort) {
		params.reasoning_effort = model.thinkingLevelMap?.[reasoningEffort] ?? reasoningEffort;
	}

	return params;
}

function buildHeaders(model: Model<any>, options: SimpleStreamOptions | undefined, apiKey: string | undefined) {
	const headers: Record<string, string> = {
		"content-type": "application/json",
		...(model.headers ?? {}),
		...(options?.headers ?? {}),
	};
	if (apiKey && headers.Authorization === undefined && headers.authorization === undefined) {
		headers.Authorization = `Bearer ${apiKey}`;
	}
	return headers;
}

export default function llamacppProgress(pi: ExtensionAPI) {
	pi.on("session_start", (_event, ctx) => {
		ui = ctx.ui;
		debug("session_start", { hasUI: ctx.hasUI });
	});

	pi.on("agent_end", () => {
		ui?.setWorkingMessage();
	});

	pi.on("session_shutdown", () => {
		ui?.setWorkingMessage();
		ui = undefined;
	});

	pi.registerProvider("llamacpp-progress", {
		api: API,
		streamSimple(model, context, options) {
			debug("streamSimple:start", { provider: model.provider, api: model.api, baseUrl: model.baseUrl, id: model.id });
			const stream = createAssistantMessageEventStream();

			(async () => {
				const output: any = {
					role: "assistant",
					content: [],
					api: model.api,
					provider: model.provider,
					model: model.id,
					usage: {
						input: 0,
						output: 0,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 0,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					},
					stopReason: "stop",
					timestamp: Date.now(),
				};

				let sawPromptProgress = false;
				try {
					const apiKey = options?.apiKey || getEnvApiKey(model.provider);
					const payload = buildPayload(model, context, options);
					const nextPayload = (await options?.onPayload?.(payload, model)) ?? payload;
					const headers = buildHeaders(model, options, apiKey);
					const url = `${stripTrailingSlash(model.baseUrl)}/chat/completions`;
					debug("request", { url, payloadKeys: Object.keys(nextPayload as object) });
					const response = await fetch(url, {
						method: "POST",
						headers,
						body: JSON.stringify(nextPayload),
						signal: options?.signal,
					});
					await options?.onResponse?.({ status: response.status, headers: headersToRecord(response.headers) }, model);
					debug("response", { status: response.status, contentType: response.headers.get("content-type") });

					if (!response.ok) {
						throw new Error(`OpenAI API error (${response.status}): ${await response.text()}`);
					}
					if (!response.body) {
						throw new Error("Response body missing");
					}

					stream.push({ type: "start", partial: output });

					let textBlock: any = null;
					let thinkingBlock: any = null;
					let hasFinishReason = false;
					const toolCallBlocksByIndex = new Map<number, any>();
					const toolCallBlocksById = new Map<string, any>();
					const blocks = output.content as any[];
					const getContentIndex = (block: any) => blocks.indexOf(block);

					const finishBlock = (block: any) => {
						const contentIndex = getContentIndex(block);
						if (contentIndex === -1) return;
						if (block.type === "text") {
							stream.push({ type: "text_end", contentIndex, content: block.text, partial: output });
						} else if (block.type === "thinking") {
							stream.push({ type: "thinking_end", contentIndex, content: block.thinking, partial: output });
						} else if (block.type === "toolCall") {
							block.arguments = parseStreamingJson(block.partialArgs);
							delete block.partialArgs;
							delete block.streamIndex;
							stream.push({ type: "toolcall_end", contentIndex, toolCall: block, partial: output });
						}
					};

					const ensureTextBlock = () => {
						if (!textBlock) {
							textBlock = { type: "text", text: "" };
							blocks.push(textBlock);
							stream.push({ type: "text_start", contentIndex: getContentIndex(textBlock), partial: output });
						}
						return textBlock;
					};

					const ensureThinkingBlock = (thinkingSignature?: string) => {
						if (!thinkingBlock) {
							thinkingBlock = { type: "thinking", thinking: "", thinkingSignature };
							blocks.push(thinkingBlock);
							stream.push({ type: "thinking_start", contentIndex: getContentIndex(thinkingBlock), partial: output });
						}
						return thinkingBlock;
					};

					const ensureToolCallBlock = (toolCall: any) => {
						const streamIndex = typeof toolCall.index === "number" ? toolCall.index : undefined;
						let block = streamIndex !== undefined ? toolCallBlocksByIndex.get(streamIndex) : undefined;
						if (!block && toolCall.id) block = toolCallBlocksById.get(toolCall.id);
						if (!block) {
							block = {
								type: "toolCall",
								id: toolCall.id || "",
								name: toolCall.function?.name || "",
								arguments: {},
								partialArgs: "",
								streamIndex,
							};
							if (streamIndex !== undefined) toolCallBlocksByIndex.set(streamIndex, block);
							if (toolCall.id) toolCallBlocksById.set(toolCall.id, block);
							blocks.push(block);
							stream.push({ type: "toolcall_start", contentIndex: getContentIndex(block), partial: output });
						}
						if (streamIndex !== undefined && block.streamIndex === undefined) {
							block.streamIndex = streamIndex;
							toolCallBlocksByIndex.set(streamIndex, block);
						}
						if (toolCall.id) toolCallBlocksById.set(toolCall.id, block);
						return block;
					};

					const reader = response.body.getReader();
					const decoder = new TextDecoder();
					let buffer = "";
					let dataLines: string[] = [];

					const processChunk = (chunk: any) => {
						output.responseId ||= chunk.id;
						if (typeof chunk.model === "string" && chunk.model.length > 0 && chunk.model !== model.id) {
							output.responseModel ||= chunk.model;
						}
						if (chunk.usage) {
							output.usage = parseChunkUsage(chunk.usage, model);
						}
						if (chunk.prompt_progress) {
							sawPromptProgress = true;
							const message = formatProgress(chunk.prompt_progress);
							debug("prompt_progress", { message, progress: chunk.prompt_progress });
							ui?.setWorkingMessage(message);
						}
						const choice = Array.isArray(chunk.choices) ? chunk.choices[0] : undefined;
						if (!choice) return;
						if (sawPromptProgress && !chunk.prompt_progress) {
							ui?.setWorkingMessage();
							sawPromptProgress = false;
						}
						if (!chunk.usage && choice.usage) {
							output.usage = parseChunkUsage(choice.usage, model);
						}
						if (choice.finish_reason) {
							const finishReasonResult = mapStopReason(choice.finish_reason);
							output.stopReason = finishReasonResult.stopReason;
							if (finishReasonResult.errorMessage) {
								output.errorMessage = finishReasonResult.errorMessage;
							}
							hasFinishReason = true;
						}
						if (!choice.delta) return;

						if (choice.delta.content !== null && choice.delta.content !== undefined && choice.delta.content.length > 0) {
							const block = ensureTextBlock();
							block.text += choice.delta.content;
							stream.push({ type: "text_delta", contentIndex: getContentIndex(block), delta: choice.delta.content, partial: output });
						}

						const reasoningFields = ["reasoning_content", "reasoning", "reasoning_text"] as const;
						let foundReasoningField: string | null = null;
						for (const field of reasoningFields) {
							const value = choice.delta[field];
							if (typeof value === "string" && value.length > 0) {
								foundReasoningField = field;
								break;
							}
						}
						if (foundReasoningField) {
							const delta = choice.delta[foundReasoningField];
							if (typeof delta === "string" && delta.length > 0) {
								const block = ensureThinkingBlock(foundReasoningField);
								block.thinking += delta;
								stream.push({ type: "thinking_delta", contentIndex: getContentIndex(block), delta, partial: output });
							}
						}

						if (choice.delta.tool_calls) {
							for (const toolCall of choice.delta.tool_calls) {
								const block = ensureToolCallBlock(toolCall);
								if (!block.id && toolCall.id) {
									block.id = toolCall.id;
									toolCallBlocksById.set(toolCall.id, block);
								}
								if (!block.name && toolCall.function?.name) {
									block.name = toolCall.function.name;
								}
								let delta = "";
								if (toolCall.function?.arguments) {
									delta = toolCall.function.arguments;
									block.partialArgs = (block.partialArgs ?? "") + toolCall.function.arguments;
									block.arguments = parseStreamingJson(block.partialArgs);
								}
								stream.push({ type: "toolcall_delta", contentIndex: getContentIndex(block), delta, partial: output });
							}
						}

						const reasoningDetails = choice.delta.reasoning_details;
						if (reasoningDetails && Array.isArray(reasoningDetails)) {
							for (const detail of reasoningDetails) {
								if (detail.type === "reasoning.encrypted" && detail.id && detail.data) {
									const matchingToolCall = output.content.find((b: any) => b.type === "toolCall" && b.id === detail.id);
									if (matchingToolCall) {
										matchingToolCall.thoughtSignature = JSON.stringify(detail);
									}
								}
							}
						}
					};

					const flush = () => {
						if (dataLines.length === 0) return;
						const data = dataLines.join("\n");
						dataLines = [];
						if (!data || data === "[DONE]") return;
						const chunk = JSON.parse(data);
						processChunk(chunk);
					};

					while (true) {
						const { value, done } = await reader.read();
						if (done) break;
						buffer += decoder.decode(value, { stream: true });
						while (true) {
							const newline = buffer.indexOf("\n");
							if (newline === -1) break;
							let line = buffer.slice(0, newline);
							buffer = buffer.slice(newline + 1);
							if (line.endsWith("\r")) line = line.slice(0, -1);
							if (!line) {
								flush();
							} else if (line.startsWith("data:")) {
								dataLines.push(line.slice(5).trimStart());
							}
						}
					}
					buffer += decoder.decode();
					if (buffer) {
						for (const line of buffer.split(/\r?\n/)) {
							if (!line) {
								flush();
							} else if (line.startsWith("data:")) {
								dataLines.push(line.slice(5).trimStart());
							}
						}
					}
					flush();
					reader.releaseLock();

					for (const block of blocks) finishBlock(block);
					ui?.setWorkingMessage();
					if (options?.signal?.aborted) throw new Error("Request was aborted");
					if (output.stopReason === "aborted") throw new Error("Request was aborted");
					if (output.stopReason === "error") throw new Error(output.errorMessage || "Provider returned an error stop reason");
					if (!hasFinishReason) throw new Error("Stream ended without finish_reason");
					stream.push({ type: "done", reason: output.stopReason, message: output });
					stream.end();
				} catch (error: any) {
					ui?.setWorkingMessage();
					output.stopReason = options?.signal?.aborted ? "aborted" : "error";
					output.errorMessage = error instanceof Error ? error.message : JSON.stringify(error);
					stream.push({ type: "error", reason: output.stopReason, error: output });
					stream.end();
				}
			})();

			return stream;
		},
	});
}
