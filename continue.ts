// Minimal invisible-continue extension
// Resumes the agentic loop without adding any text to the LLM context

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Agent } from "@earendil-works/pi-agent-core";

let _agent: Agent | null = null;

// Capture the Agent instance when AgentSession subscribes (called during construction)
const _origSubscribe = Agent.prototype.subscribe;
Agent.prototype.subscribe = function (this: Agent, ...args: any[]) {
  _agent = this;
  return _origSubscribe.apply(this, args);
};

export default function (pi: ExtensionAPI) {
  pi.registerCommand("continue", {
    description: "Resume the agentic loop invisibly — no new text added to LLM context",
    handler: async (_args, ctx) => {
      if (!_agent) {
        ctx.ui.notify("Agent not captured yet. Send a prompt first.", "warning");
        return;
      }
      if (!ctx.isIdle()) {
        await ctx.waitForIdle();
      }
      // Empty prompt array = runAgentLoop with unmodified context snapshot
      // The LLM sees exactly the same messages it had before
      await _agent.prompt([]);
    },
  });
}
