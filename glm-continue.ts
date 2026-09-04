/**
 * glm-continue — auto-repair truncated model generations.
 *
 * Problem: the `glm-5.2-744b-preview` model (hosted by TU Wien) occasionally
 * stops mid-generation — mid-sentence, mid-thought, mid-code-block, or even
 * mid tool-call. This breaks subagents in particular: they observe a truncated
 * assistant turn and give up. The root cause is the hosting/proxy layer and is
 * out of our control.
 *
 * Fix: wrap the model's streamSimple so that, when a generation looks truncated,
 * we transparently prompt the model to "continue from where it stopped", merge
 * the continuation onto the partial output (stripping any overlap), and repeat
 * up to a bounded number of times. This happens BELOW the agent loop, so every
 * caller — main loop and all subagents — is covered automatically, with no
 * per-subagent instrumentation.
 *
 * Mechanism:
 *  - The built-in OpenAI-completions streamer is delegated to (no SSE/tool-call
 *    parsing reimplemented). We consume its event stream, forward text/thinking
 *    deltas LIVE (so UX is unchanged for the common non-truncated case), buffer
 *    tool-call events until they complete, and withhold block-closing events.
 *  - On segment end, run a truncation detector (finish_reason + structural
 *    heuristics: open code fence, open tool-call, mid-word prose).
 *  - If truncated, build a continuation context (partial assistant message +
 *    "continue" nudge), run another segment, merge with overlap-stripping, and
 *    emit only the new tail as deltas. Cap iterations; bail on no progress.
 *  - Finally synthesize the withheld block-closing events + done/error with
 *    summed usage, so the agent loop sees ONE clean, complete assistant message.
 *
 * Scope: only model ids in WRAPPED_IDS are wrapped; every other openai-completions
 * model (e.g. the qwen models on the same endpoint) passes straight through to
 * the original built-in streamer, so behaviour is unchanged for them.
 *
 * Config (env):
 *  GLM_CONTINUE_MODELS      comma-separated model ids to wrap (default: glm-5.2-744b-preview)
 *  GLM_CONTINUE_MAX         max continuation attempts (default: 4)
 *  GLM_CONTINUE_MAX_OVERLAP max overlap-stripped chars when merging text (default: 80)
 *  GLM_CONTINUE_MIN_PROSE  min prose length before "mid-word" heuristic fires (default: 400)
 *  GLM_CONTINUE_DEBUG       set to "1" to log detection/merge decisions to stderr
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getApiProvider } from "@earendil-works/pi-ai/compat";
import {
	createAssistantMessageEventStream,
	type AssistantMessage,
	type AssistantMessageEvent,
	type AssistantMessageEventStream,
	type Context,
	type Model,
	type SimpleStreamOptions,
	type Usage,
} from "@earendil-works/pi-ai";

type StreamFn = (m: Model<any>, c: Context, o?: SimpleStreamOptions) => AssistantMessageEventStream;

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const WRAPPED_IDS = new Set(
	(process.env.GLM_CONTINUE_MODELS ?? "glm-5.2-744b-preview")
		.split(",")
		.map((s) => s.trim())
		.filter(Boolean),
);
const MAX_CONTINUATIONS = envInt("GLM_CONTINUE_MAX", 4);
const MAX_OVERLAP = envInt("GLM_CONTINUE_MAX_OVERLAP", 80);
/** Minimum overlap length to actually strip. Genuine continuations repeat a
 *  >=2-char fragment; 1-char overlaps are coincidental (e.g. an acknowledgment
 *  like "done" sharing a final "d") and stripping them corrupts the text. */
const MIN_OVERLAP_KEEP = 2;
const MIN_PROSE_LEN = envInt("GLM_CONTINUE_MIN_PROSE", 400);
const DEBUG = process.env.GLM_CONTINUE_DEBUG === "1";

/** Matches short "I have nothing more to add" acknowledgments the nudge elicits. */
const DONE_ACK_REGEX = /^(?:done|complete|completed|finished|finishing|that'?s all|that'?s it|nothing (?:more|else)(?: to (?:add|say))?|end of (?:response|message|output|generation|text|answer)|no more text|n\/a|\.\.\.)\.?$/i;

function envInt(key: string, fallback: number): number {
	const v = Number(process.env[key]);
	return Number.isFinite(v) && v > 0 ? v : fallback;
}

function log(...args: unknown[]): void {
	if (DEBUG) console.error("[glm-continue]", ...args);
}

const CONTINUE_NUDGE = [
	"Your previous response was cut off before you finished generating.",
	"Continue EXACTLY from where you stopped. Do not repeat any text, code, or thoughts already produced.",
	"If you were mid-sentence, finish that sentence. If mid code block, complete it.",
	"If you were mid tool-call, re-issue the complete tool call now.",
	"Output ONLY the continuation. If you have truly nothing more to add, reply with the single word: done",
].join(" ");

// ---------------------------------------------------------------------------
// Usage helpers
// ---------------------------------------------------------------------------

function zeroUsage(): Usage {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

function addUsage(a: Usage, b: Usage): Usage {
	return {
		input: a.input + b.input,
		output: a.output + b.output,
		cacheRead: a.cacheRead + b.cacheRead,
		cacheWrite: a.cacheWrite + b.cacheWrite,
		totalTokens: a.totalTokens + b.totalTokens,
		cost: {
			input: a.cost.input + b.cost.input,
			output: a.cost.output + b.cost.output,
			cacheRead: a.cost.cacheRead + b.cost.cacheRead,
			cacheWrite: a.cost.cacheWrite + b.cost.cacheWrite,
			total: a.cost.total + b.cost.total,
		},
	};
}

// ---------------------------------------------------------------------------
// String / content helpers
// ---------------------------------------------------------------------------

/** Length of the longest suffix of `a` that is also a prefix of `b`, capped at `max`. */
export function overlapLen(a: string, b: string, max: number): number {
	const limit = Math.min(max, a.length, b.length);
	for (let k = limit; k > 0; k--) {
		if (a.endsWith(b.slice(0, k))) return k;
	}
	return 0;
}

export function lastText(msg: AssistantMessage): string {
	for (let i = msg.content.length - 1; i >= 0; i--) {
		const block = msg.content[i];
		if (block.type === "text") return block.text;
	}
	return "";
}

function totalTextLen(msg: AssistantMessage): number {
	let n = 0;
	for (const block of msg.content) {
		if (block.type === "text") n += block.text.length;
		else if (block.type === "thinking") n += block.thinking.length;
	}
	return n;
}

export function hasOpenCodeFence(msg: AssistantMessage): boolean {
	let count = 0;
	for (const block of msg.content) {
		if (block.type !== "text") continue;
		const matches = block.text.match(/``+/g);
		if (matches) for (const m of matches) if (m.length >= 3) count++;
	}
	return count % 2 === 1;
}

/**
 * Conservative "looks cut off mid-prose" heuristic for a `stop`-finished turn.
 * Only fires on long responses that end on an alphanumeric character with no
 * terminal punctuation and no trailing newline. Tunable via GLM_CONTINUE_MIN_PROSE.
 * False positives cost one extra (usually short, reverted) continuation call;
 * false negatives leave a truncation unrepaired. Default errs toward not firing.
 */
export function proseLooksCut(msg: AssistantMessage): boolean {
	const text = lastText(msg);
	if (!text) return false;
	if (text.endsWith("\n")) return false; // a trailing newline implies a natural break, not a mid-word cut
	const trimmed = text.replace(/\s+$/, "");
	if (trimmed.length < MIN_PROSE_LEN) return false;
	const last = trimmed[trimmed.length - 1];
	if (/[.!?`)\]}>"']/.test(last)) return false;
	if (/[0-9A-Za-z]/.test(last)) return true;
	return false;
}

/** Remove a trailing, never-forwarded (open) tool-call block from the message. */
export function stripOpenToolCall(msg: AssistantMessage, openToolCall: boolean): AssistantMessage {
	if (!openToolCall) return msg;
	const content = [...msg.content];
	while (content.length && content[content.length - 1].type === "toolCall") content.pop();
	return { ...msg, content };
}

/** Is the (merged) message still truncated and thus worth continuing? */
export function isStillTruncated(running: AssistantMessage, openToolCall: boolean): boolean {
	const reason = running.stopReason;
	if (reason === "length") return true;
	if (reason === "toolUse") return false; // a clean tool call isn't truncated
	if (reason === "stop") return openToolCall || hasOpenCodeFence(running) || proseLooksCut(running);
	return false; // error / aborted
}

// ---------------------------------------------------------------------------
// Segment runner: consumes one built-in stream, forwards live events, returns
// the finalized message + whether it ended mid-tool-call.
// ---------------------------------------------------------------------------

interface ToolCallBuffer {
	contentIndex: number;
	startEvent: AssistantMessageEvent;
	deltas: string[];
}

interface SegmentResult {
	message: AssistantMessage;
	openToolCall: boolean;
	aborted: boolean;
}

/**
 * Run one built-in stream segment.
 * `onEvent` receives the events we forward to the outer stream (live for the
 * first segment; a no-op for buffered continuation segments).
 *
 * Forwarded live: start, text_start, text_delta, thinking_start, thinking_delta.
 * Tool-call events are buffered until `toolcall_end` and then forwarded as a
 * burst (so a tool-call cut mid-stream is never partially emitted and can be
 * cleanly discarded + redone). All `*_end`, `done`, `error` are withheld —
 * they are synthesized once at the very end from the final merged message.
 */
async function runSegment(
	stream: StreamFn,
	model: Model<any>,
	context: Context,
	options: SimpleStreamOptions | undefined,
	onEvent: (ev: AssistantMessageEvent) => void,
): Promise<SegmentResult> {
	const inner = stream(model, context, options);
	let message: AssistantMessage | null = null;
	let openToolCall = false;
	let aborted = false;
	let toolBuf: ToolCallBuffer | null = null;

	for await (const ev of inner) {
		switch (ev.type) {
			case "start":
				onEvent(ev);
				break;
			case "text_start":
			case "text_delta":
			case "thinking_start":
			case "thinking_delta":
				onEvent(ev);
				break;
			case "toolcall_start":
				toolBuf = { contentIndex: ev.contentIndex, startEvent: ev, deltas: [] };
				break;
			case "toolcall_delta":
				if (toolBuf) toolBuf.deltas.push(ev.delta);
				break;
			case "toolcall_end": {
				if (toolBuf) {
					onEvent(toolBuf.startEvent);
					const json = toolBuf.deltas.join("");
					if (json) {
						onEvent({ type: "toolcall_delta", contentIndex: toolBuf.contentIndex, delta: json, partial: ev.partial });
					}
					toolBuf = null;
				}
				break;
			}
			case "text_end":
			case "thinking_end":
				// withheld — synthesized at finalize
				break;
			case "done":
				message = ev.message;
				break;
			case "error":
				message = ev.error;
				aborted = ev.reason === "aborted";
				break;
		}
	}

	openToolCall = toolBuf !== null;
	if (!message) {
		// Stream ended without a terminal event — fabricate an error.
		message = {
			role: "assistant",
			content: [],
			api: model.api,
			provider: model.provider,
			model: model.id,
			usage: zeroUsage(),
			stopReason: "error",
			errorMessage: "stream ended without a terminal event",
			timestamp: Date.now(),
		};
		aborted = false;
	}
	return { message, openToolCall, aborted };
}

// ---------------------------------------------------------------------------
// Merge: fold a continuation segment into the running message, returning the
// merged message + the diff events to emit on the outer stream.
// ---------------------------------------------------------------------------

export function mergeSegment(
	running: AssistantMessage,
	seg: AssistantMessage,
): { message: AssistantMessage; diffs: AssistantMessageEvent[]; appendedText: string } {
	const content = running.content.map((b) => ({ ...b })) as AssistantMessage["content"];
	const diffs: AssistantMessageEvent[] = [];
	const appended: string[] = [];
	let i = 0;

	// 1) Overlap-merge trailing text/thinking of `running` with leading text/thinking of `seg`.
	if (content.length > 0 && i < seg.content.length) {
		const last = content[content.length - 1] as any;
		const first = seg.content[i] as any;
		if (last.type === "text" && first.type === "text") {
			const ov = overlapLen(last.text, first.text, MAX_OVERLAP);
			const appendedText = ov >= MIN_OVERLAP_KEEP ? first.text.slice(ov) : first.text;
			if (appendedText) {
				last.text += appendedText;
				diffs.push({ type: "text_delta", contentIndex: content.length - 1, delta: appendedText, partial: undefined as any });
				appended.push(appendedText);
			}
			i++;
		} else if (last.type === "thinking" && first.type === "thinking") {
			const ov = overlapLen(last.thinking, first.thinking, MAX_OVERLAP);
			const appendedText = ov >= MIN_OVERLAP_KEEP ? first.thinking.slice(ov) : first.thinking;
			if (appendedText) {
				last.thinking += appendedText;
				diffs.push({ type: "thinking_delta", contentIndex: content.length - 1, delta: appendedText, partial: undefined as any });
				appended.push(appendedText);
			}
			i++;
		}
	}

	// 2) Append remaining segment blocks as new blocks.
	for (; i < seg.content.length; i++) {
		const block = seg.content[i] as any;
		const idx = content.length;
		const cloned = { ...block };
		content.push(cloned);
		if (block.type === "text") {
			diffs.push({ type: "text_start", contentIndex: idx, partial: undefined as any });
			if (cloned.text) {
				diffs.push({ type: "text_delta", contentIndex: idx, delta: cloned.text, partial: undefined as any });
				appended.push(cloned.text);
			}
		} else if (block.type === "thinking") {
			diffs.push({ type: "thinking_start", contentIndex: idx, partial: undefined as any });
			if (cloned.thinking) {
				diffs.push({ type: "thinking_delta", contentIndex: idx, delta: cloned.thinking, partial: undefined as any });
				appended.push(cloned.thinking);
			}
		} else if (block.type === "toolCall") {
			diffs.push({ type: "toolcall_start", contentIndex: idx, partial: undefined as any });
			const json = JSON.stringify(cloned.arguments);
			if (json) {
				diffs.push({ type: "toolcall_delta", contentIndex: idx, delta: json, partial: undefined as any });
				appended.push(json);
			}
		}
	}

	const message: AssistantMessage = { ...running, content };
	for (const d of diffs) (d as any).partial = message;
	return { message, diffs, appendedText: appended.join("") };
}

// ---------------------------------------------------------------------------
// Continuation context
// ---------------------------------------------------------------------------

function buildContinuationContext(ctx: Context, partial: AssistantMessage): Context {
	return {
		...ctx,
		messages: [
			...ctx.messages,
			partial,
			{ role: "user", content: CONTINUE_NUDGE, timestamp: Date.now() },
		],
	};
}

// ---------------------------------------------------------------------------
// The wrapper
// ---------------------------------------------------------------------------

export function makeWrapper(delegate: StreamFn) {
	return function wrappedStream(model: Model<any>, context: Context, options?: SimpleStreamOptions): AssistantMessageEventStream {
		// Non-wrapped models: straight pass-through to the original built-in.
		if (!WRAPPED_IDS.has(model.id)) {
			return delegate(model, context, options);
		}

		const outer = createAssistantMessageEventStream();

		void (async () => {
			let running: AssistantMessage | null = null;
			let totalUsage = zeroUsage();
			let lastStopReason: AssistantMessage["stopReason"] = "stop";
			let lastErrorMessage: string | undefined;

			try {
				if (options?.signal?.aborted) throw Object.assign(new Error("aborted"), { aborted: true });

				// --- Segment 1 (live) ---
				const seg1 = await runSegment(delegate, model, context, options, (ev) => outer.push(ev));
				if (options?.signal?.aborted || seg1.aborted) {
					const err = seg1.message;
					outer.push({ type: "error", reason: "aborted", error: err });
					outer.end(err);
					return;
				}

				running = stripOpenToolCall(seg1.message, seg1.openToolCall);
				totalUsage = addUsage(totalUsage, seg1.message.usage);
				lastStopReason = seg1.message.stopReason;
				lastErrorMessage = seg1.message.errorMessage;

				let seg = seg1;
				let discarded = false;
				let exhaustedCap = false;

				for (let iter = 0; iter < MAX_CONTINUATIONS; iter++) {
					if (options?.signal?.aborted) {
						lastStopReason = "aborted";
						break;
					}

					const reason = running.stopReason;
					if (reason === "error") {
						// Host failure (non-abort). If we already have content, deliver it as a
						// best-effort stop; if not, propagate the error. Do not loop on errors.
						if (totalTextLen(running) === 0) {
							lastStopReason = "error";
							lastErrorMessage = running.errorMessage;
						} else {
							log("segment errored with partial content; delivering partial");
							lastStopReason = "stop";
						}
						break;
					}

					// Decide whether the CURRENT (merged) message is still truncated. We check
					// `running` (the merged message), not the last segment alone: a continuation
					// segment that closes a code fence contains a ``` itself, so it would look
					// "open" in isolation and spuriously re-trigger.
					if (!isStillTruncated(running, seg.openToolCall)) {
						lastStopReason = reason;
						break;
					}

					log(`truncation detected (iter ${iter + 1}); continuing…`);

					const contContext = buildContinuationContext(context, running);
					const next = await runSegment(delegate, model, contContext, options, () => {});
					if (options?.signal?.aborted || next.aborted) {
						lastStopReason = "aborted";
						break;
					}

					const { message: merged, diffs, appendedText } = mergeSegment(running, next.message);

					// Progress guard. Discard a continuation that added nothing useful:
					//  - pure echo of the tail (no new text after overlap-stripping), or
					//  - a short "nothing more to add" acknowledgment (the nudge asks for "done"
					//    in that case). This bounds the damage of false-positive truncation
					//    detection: a complete response we wrongly continued has its spurious
					//    continuation discarded, leaving the original intact. Real progress —
					//    even a few chars that close a fence or finish a sentence — is kept.
					const ack = appendedText.replace(/\s+/g, " ").trim();
					const isAck = ack.length > 0 && ack.length < 48 && DONE_ACK_REGEX.test(ack);
					if (!ack || isAck) {
						log(`continuation made no progress (appended=${JSON.stringify(ack)}); discarding and stopping`);
						discarded = true;
						lastStopReason = running.stopReason;
						break;
					}

					for (const d of diffs) outer.push(d);
					running = { ...merged, stopReason: next.message.stopReason, errorMessage: next.message.errorMessage };
					totalUsage = addUsage(totalUsage, next.message.usage);
					lastStopReason = next.message.stopReason;
					lastErrorMessage = next.message.errorMessage;
					seg = next;
					exhaustedCap = iter === MAX_CONTINUATIONS - 1;
				}

				// Cap-exit guard: if we used every continuation attempt and the merged result
				// is STILL truncated, report it honestly as "length". We never override
				// any other exit case (normal break / discard / error / abort already set
				// lastStopReason correctly).
				if (exhaustedCap && !discarded && lastStopReason !== "aborted" && lastStopReason !== "error" && isStillTruncated(running, seg.openToolCall)) {
					lastStopReason = "length";
				}

				finalize(outer, running, totalUsage, lastStopReason, lastErrorMessage);
			} catch (err: any) {
				const aborted = err?.aborted === true || options?.signal?.aborted;
				const reason: "aborted" | "error" = aborted ? "aborted" : "error";
				const errMsg: AssistantMessage = {
					role: "assistant",
					content: running?.content ?? [],
					api: model.api,
					provider: model.provider,
					model: model.id,
					usage: totalUsage,
					stopReason: reason,
					errorMessage: aborted ? "Request was aborted" : err instanceof Error ? err.message : String(err),
					timestamp: Date.now(),
				};
				outer.push({ type: "error", reason, error: errMsg });
				outer.end(errMsg);
			}
		})();

		return outer;
	};
}

// ---------------------------------------------------------------------------
// Finalize: synthesize the withheld block-closing events + terminal event.
// ---------------------------------------------------------------------------

export function finalize(
	outer: AssistantMessageEventStream,
	running: AssistantMessage,
	usage: Usage,
	stopReason: AssistantMessage["stopReason"],
	errorMessage: string | undefined,
): void {
	const message: AssistantMessage = { ...running, usage, stopReason, errorMessage };
	for (let idx = 0; idx < message.content.length; idx++) {
		const block = message.content[idx] as any;
		if (block.type === "text") {
			outer.push({ type: "text_end", contentIndex: idx, content: block.text, partial: message });
		} else if (block.type === "thinking") {
			outer.push({ type: "thinking_end", contentIndex: idx, content: block.thinking, partial: message });
		} else if (block.type === "toolCall") {
			outer.push({ type: "toolcall_end", contentIndex: idx, toolCall: block, partial: message });
		}
	}
	if (stopReason === "error" || stopReason === "aborted") {
		outer.push({ type: "error", reason: stopReason, error: message });
	} else {
		outer.push({ type: "done", reason: stopReason as "stop" | "length" | "toolUse", message });
	}
	outer.end(message);
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI) {
	// Capture the built-in openai-completions streamer BEFORE we override it, so
	// non-wrapped models delegate to the exact original implementation. The
	// built-ins are registered at module load, so this is non-null here.
	const builtin = getApiProvider("openai-completions");
	if (!builtin) {
		console.error("[glm-continue] WARNING: built-in openai-completions streamer not found at load time; not registering");
		return;
	}
	const delegate: StreamFn = (m, c, o) => builtin.streamSimple(m, c, o);

	pi.registerProvider("TU Wien", {
		api: "openai-completions",
		streamSimple: makeWrapper(delegate),
	});

	log(`loaded; wrapping models: ${[...WRAPPED_IDS].join(", ")}`);
}
