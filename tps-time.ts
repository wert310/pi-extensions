import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const STATUS_KEY = "tps-tracker";
const START_ICON = "⚙";
const TOOL_STATUS_TICK_MS = 200;

type MessageStats = {
	tokens: number;
	elapsedMs: number;
	approximate: boolean;
	tps: number;
};

type ActiveTool = {
	toolName: string;
	startedAt: number;
};

export default function (pi: ExtensionAPI) {
	let currentMessageStart: number | null = null;
	let currentStreamStart: number | null = null;
	let currentEstimatedTokens = 0;
	let currentLiveStats: MessageStats | null = null;
	let totalTokens = 0;
	let totalStreamMs = 0;
	let lastMessageStats: MessageStats | null = null;
	const activeTools = new Map<string, ActiveTool>();
	let toolStatusTimer: ReturnType<typeof setInterval> | null = null;
	let toolStatusCtx: ExtensionContext | null = null;

	function resetCurrentMessage() {
		currentMessageStart = null;
		currentStreamStart = null;
		currentEstimatedTokens = 0;
		currentLiveStats = null;
	}

	function stopToolStatusTimer() {
		if (toolStatusTimer != null) {
			clearInterval(toolStatusTimer);
			toolStatusTimer = null;
		}
		toolStatusCtx = null;
	}


	function resetAgentState(ctx?: ExtensionContext) {
		resetCurrentMessage();
		totalTokens = 0;
		totalStreamMs = 0;
		lastMessageStats = null;
		activeTools.clear();
		stopToolStatusTimer();
		ctx?.ui.setStatus(STATUS_KEY, undefined);
	}

	function formatTokens(count: number) {
		if (count < 1000) return count.toString();
		if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
		if (count < 1000000) return `${Math.round(count / 1000)}k`;
		if (count < 10000000) return `${(count / 1000000).toFixed(1)}M`;
		return `${Math.round(count / 1000000)}M`;
	}

	function formatStats(ctx: ExtensionContext, stats: MessageStats) {
		const tokenLabel = `${stats.approximate ? "~" : ""}${stats.tokens} tok`;
		return `${ctx.ui.theme.fg("accent", `${stats.tps} t/s`)} ${ctx.ui.theme.fg("dim", `(${tokenLabel} / ${(stats.elapsedMs / 1000).toFixed(1)}s avg)`)}`;
	}

	function formatContextUsage(ctx: ExtensionContext) {
		const usage = ctx.getContextUsage();
		if (!usage) return undefined;

		const usedTokens = Math.max(0, Math.round(usage.tokens));
		const contextWindow = usage.contextWindow ?? ctx.model?.contextWindow ?? 0;
		if (contextWindow <= 0) return undefined;

		const percentLabel = usage.percent != null ? ` (${usage.percent.toFixed(1)}%)` : "";
		return ctx.ui.theme.fg("dim", `${formatTokens(usedTokens)}/${formatTokens(contextWindow)}${percentLabel}`);
	}

	function joinStatusParts(ctx: ExtensionContext, parts: Array<string | undefined>) {
		const definedParts = parts.filter((part): part is string => !!part);
		if (definedParts.length === 0) return undefined;
		return definedParts.join(` ${ctx.ui.theme.fg("dim", "·")} `);
	}

	function formatToolStatus(ctx: ExtensionContext, now: number) {
		const tools = [...activeTools.values()];
		if (tools.length === 0) return undefined;

		const startedAt = Math.min(...tools.map((tool) => tool.startedAt));
		const label = tools.length === 1 ? tools[0]!.toolName : `${tools.length} tools`;
		return `${ctx.ui.theme.fg("warning", label)} ${ctx.ui.theme.fg("dim", `${((now - startedAt) / 1000).toFixed(1)}s`)}`;
	}

	function updateIdleStatus(ctx: ExtensionContext) {
		if (!lastMessageStats) {
			ctx.ui.setStatus(STATUS_KEY, undefined);
			return;
		}

		const stats = formatStats(ctx, lastMessageStats);
		const contextUsage = formatContextUsage(ctx);
		const toolStatus = formatToolStatus(ctx, Date.now());
		ctx.ui.setStatus(STATUS_KEY, joinStatusParts(ctx, [stats, contextUsage, toolStatus]));
	}

	function ensureToolStatusTimer(ctx: ExtensionContext) {
		toolStatusCtx = ctx;
		if (toolStatusTimer != null) return;

		toolStatusTimer = setInterval(() => {
			if (!toolStatusCtx) return;
			updateIdleStatus(toolStatusCtx);
		}, TOOL_STATUS_TICK_MS);
	}

	pi.on("session_start", async (_event, ctx) => {
		resetAgentState(ctx);
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		resetAgentState(ctx);
	});

	pi.on("before_agent_start", async (_event, ctx) => {
		resetAgentState(ctx);
	});

	pi.on("message_start", async (event) => {
		if (event.message.role !== "assistant") return;
		resetCurrentMessage();
		currentMessageStart = Date.now();
	});

	pi.on("message_end", async (event, ctx) => {
		if (event.message.role !== "user") return;
		const timestamp = Date.now();
		ctx.ui.notify(`${ctx.ui.theme.fg("dim", `[${new Date(timestamp).toLocaleTimeString()}]`)} ${ctx.ui.theme.fg("accent", START_ICON)}`, "info");
	});

	pi.on("message_update", async (event, ctx) => {
		if (event.message.role !== "assistant") return;
		const assistantEvent = event.assistantMessageEvent;
		if (assistantEvent.type === "done" || assistantEvent.type === "error") return;

		const now = Date.now();
		currentMessageStart ??= now;

		if (
			assistantEvent.type === "start" ||
			assistantEvent.type === "text_start" ||
			assistantEvent.type === "thinking_start" ||
			assistantEvent.type === "toolcall_start"
		) {
			currentStreamStart ??= now;
		}

		if (
			assistantEvent.type === "text_delta" ||
			assistantEvent.type === "thinking_delta" ||
			assistantEvent.type === "toolcall_delta"
		) {
			currentStreamStart ??= now;
			currentEstimatedTokens += assistantEvent.delta.length / 4;
		}

		const streamStart = currentStreamStart ?? currentMessageStart;
		if (streamStart == null) return;

		const approximate = event.message.usage.output <= 0;
		const liveTokens = !approximate
			? event.message.usage.output
			: Math.max(1, Math.round(currentEstimatedTokens));
		if (liveTokens <= 0) return;

		const elapsedMs = Math.max(1, now - streamStart);
		const tps = Math.max(1, Math.round((liveTokens * 1000) / elapsedMs));
		const tokenLabel = `${approximate ? "~" : ""}${liveTokens} tok`;
		currentLiveStats = {
			tokens: liveTokens,
			elapsedMs,
			approximate,
			tps,
		};

		const liveStatus = `${ctx.ui.theme.fg("accent", `${tps} t/s`)} ${ctx.ui.theme.fg("dim", `(${tokenLabel} / ${(elapsedMs / 1000).toFixed(1)}s)`)}`;
		ctx.ui.setStatus(STATUS_KEY, joinStatusParts(ctx, [liveStatus, formatContextUsage(ctx)]));
	});

	pi.on("message_end", async (event, ctx) => {
		if (event.message.role !== "assistant") return;

		const streamStart = currentStreamStart ?? currentMessageStart;
		const elapsedMs = streamStart == null ? 0 : Math.max(0, Date.now() - streamStart);
		const approximate = event.message.usage.output <= 0;
		const finalTokens = !approximate
			? event.message.usage.output
			: Math.max(0, Math.round(currentEstimatedTokens));

		const completedStats = elapsedMs > 0 && finalTokens > 0
			? {
				tokens: finalTokens,
				elapsedMs,
				approximate,
				tps: Math.max(1, Math.round((finalTokens * 1000) / elapsedMs)),
			}
			: currentLiveStats;

		if (completedStats) {
			lastMessageStats = completedStats;
			totalStreamMs += completedStats.elapsedMs;
			totalTokens += completedStats.tokens;
			updateIdleStatus(ctx);
		} else if (activeTools.size === 0) {
			lastMessageStats = null;
			ctx.ui.setStatus(STATUS_KEY, undefined);
		}

		resetCurrentMessage();
	});

	pi.on("tool_execution_start", async (event, ctx) => {
		activeTools.set(event.toolCallId, {
			toolName: event.toolName,
			startedAt: Date.now(),
		});
		ensureToolStatusTimer(ctx);
		updateIdleStatus(ctx);
	});

	pi.on("tool_execution_update", async (_event, ctx) => {
		toolStatusCtx = ctx;
		updateIdleStatus(ctx);
	});

	pi.on("tool_execution_end", async (event, ctx) => {
		activeTools.delete(event.toolCallId);
		if (activeTools.size === 0) stopToolStatusTimer();
		else toolStatusCtx = ctx;
		updateIdleStatus(ctx);
	});

	pi.on("agent_end", async (_event, ctx) => {
		if (currentMessageStart != null && currentLiveStats) {
			lastMessageStats = currentLiveStats;
			totalStreamMs += currentLiveStats.elapsedMs;
			totalTokens += currentLiveStats.tokens;
		}

		activeTools.clear();
		stopToolStatusTimer();
		updateIdleStatus(ctx);

		const timestamp = Date.now();
		const seconds = totalStreamMs / 1000;
		const tps = seconds > 0 && totalTokens > 0 ? Math.round(totalTokens / seconds) : 0;
		const prefix = `${ctx.ui.theme.fg("dim", `[${new Date(timestamp).toLocaleTimeString()}]`)} ${ctx.ui.theme.fg("success", "✓")}`;
		const stats = totalTokens > 0 && seconds > 0
			? `${ctx.ui.theme.fg("accent", `${tps} t/s overall`)} ${ctx.ui.theme.fg("dim", `${totalTokens} tokens in ${seconds.toFixed(1)}s`)}`
			: ctx.ui.theme.fg("dim", "no streamed assistant tokens");
		ctx.ui.notify(`${prefix} ${stats}`, "info");
		resetCurrentMessage();
	});
}
