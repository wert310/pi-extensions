# Extensions

Custom extensions for the pi coding agent.

- **duckduckgo.ts** – Web search via DuckDuckGo HTML, returns answers and top organic results.
- **webfetch.ts** – Fetches content from an exact URL, converting HTML pages to simplified Markdown.
- **tps-time.ts** – Tracks tokens-per-second and timing metrics for agent messages and tool calls.
- **lsp/** – Language Server Protocol support (currently Lean), providing definitions, references, hover, and diagnostics.
- **glm-continue.ts** – Auto-repairs truncated `glm-5.2-744b-preview` generations by transparently continuing + merging, so subagents never observe a cut-off turn. Wraps the model's `streamSimple` (below the agent loop); other models pass through unchanged. Env-tunable (`GLM_CONTINUE_*`).

## Installation

Copy these extension files to your pi extensions folder (e.g., `~/.pi/agent/extensions/`). For the LSP extension, run `npm install` inside `lsp/` first.
