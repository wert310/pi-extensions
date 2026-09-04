import { readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import type { ExtensionAPI, ExtensionContext, Tool } from "@earendil-works/pi-coding-agent/dist/core/extensions/types";
import { Type } from "typebox";

interface NtfyConfig {
  server: string; topic: string; token: string;
  notifyOn: { agentEnd: boolean; error: boolean };
}

interface State {
  lastStopReason: string | null;
  lastErrorMessage: string | null;
  lastHttpStatus: number | null;
  hasAssistantMessage: boolean;
  toolErrors: string[];
}

function getNtfyConfig(): NtfyConfig | null {
  try {
    const settings = JSON.parse(readFileSync(join(homedir(), ".pi", "agent", "settings.json"), "utf-8"));
    const ntfy = settings.ntfy;
    if (!ntfy?.topic || !ntfy?.token) return null;
    return {
      server: ntfy.server ?? "ntfy.sh", topic: ntfy.topic, token: ntfy.token,
      notifyOn: { agentEnd: ntfy.notifyOn?.agentEnd ?? true, error: ntfy.notifyOn?.error ?? true },
    };
  } catch (e) { return null; }
}

async function sendNtfyNotification(ctx: ExtensionContext, config: NtfyConfig, title: string, message: string, priority: number = 3, tags: string[] = []): Promise<void> {
  const url = `https://${config.server}/${encodeURIComponent(config.topic)}`;
  const headers: Record<string, string> = {
    "Authorization": `Bearer ${config.token}`, "Title": title, "Priority": priority.toString(),
  };
  if (tags.length > 0) headers["Tags"] = tags.join(",");
  for (let i = 0; i <= 2; i++) {
    const ctrl = new AbortController();
    const tid = setTimeout(() => ctrl.abort(), 20000);
    try {
      const res = await fetch(url, { method: "POST", headers, body: message, signal: ctrl.signal });
      clearTimeout(tid);
      if (!res.ok && res.status >= 400 && res.status < 500) { ctx.ui.notify(`ntfy: ${res.status}`, "error"); return; }
      if (res.ok) return;
    } catch (e) {
      clearTimeout(tid);
      const msg = e instanceof Error ? e.message : String(e);
      if (i === 2) ctx.ui.notify(`ntfy: ${msg}`, "error");
      else await new Promise(r => setTimeout(r, Math.pow(2, i) * 500));
    }
  }
}

export default function ntfyNotify(pi: ExtensionAPI) {
  const config = getNtfyConfig();
  if (!config) return;

  const state: State = { lastStopReason: null, lastErrorMessage: null, lastHttpStatus: null, hasAssistantMessage: false, toolErrors: [] };

  pi.on("after_provider_response", (event) => {
    if (event.status >= 400) state.lastHttpStatus = event.status;
  });

  pi.on("message_end", (event) => {
    const msg = event.message as any;
    if (msg.role === "assistant") {
      state.hasAssistantMessage = true;
      state.lastStopReason = msg.stopReason || null;
      state.lastErrorMessage = msg.errorMessage || null;
    }
  });

  pi.on("tool_end", (event) => { if (event.error) state.toolErrors.push(`[${event.toolName}] ${event.error}`); });
  pi.on("agent_start", () => { state.lastStopReason = null; state.lastErrorMessage = null; state.lastHttpStatus = null; state.hasAssistantMessage = false; state.toolErrors = []; });

  pi.on("agent_settled", (event, ctx) => {
    if (!config.notifyOn.agentEnd) return;
    if (state.lastStopReason === "aborted") return;
    if (!state.hasAssistantMessage && !state.lastErrorMessage) return;

    const sess = ctx.session?.name || "session";
    const toolErrs = config.notifyOn.error && state.toolErrors.length > 0 ? `\n${state.toolErrors.join("\n")}` : "";

    if (state.lastStopReason === "error" || state.lastErrorMessage) {
      const msg = `LLM error: ${state.lastErrorMessage || "(no details)"}\nHTTP: ${state.lastHttpStatus || "N/A"}${toolErrs}`;
      sendNtfyNotification(ctx, config, `Pi ERROR: ${sess}`, msg, 5, ["warning", "x"]);
    } else if (state.lastStopReason === "length") {
      sendNtfyNotification(ctx, config, `Pi: ${sess}`, `Output truncated${toolErrs}`, 4, ["warning", "hourglass"]);
    } else {
      sendNtfyNotification(ctx, config, `Pi: ${sess}`, `Ready for input${toolErrs}`, 3, ["bell"]);
    }
    state.toolErrors = [];
  });

  pi.registerCommand("ntfy-test", {
    description: "Test ntfy", handler: async (ctx) => {
      await sendNtfyNotification(ctx, config, "ntfy test", "Test from pi!", 3, ["bell"]);
      return { output: "Sent!" };
    },
  });

  pi.registerTool({
    name: "ntfy_notify", description: "Send ntfy notification",
    inputSchema: Type.Object({ title: Type.String(), message: Type.String(), priority: Type.Optional(Type.Number()), tags: Type.Optional(Type.Array(Type.String())) }),
    execute: async (input, ctx) => { await sendNtfyNotification(ctx, config, input.title, input.message, input.priority ?? 3, input.tags ?? []); return { success: true }; },
  } as Tool<any>);
}
