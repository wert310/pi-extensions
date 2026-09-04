# Extensions

Custom extensions for the pi coding agent.

- **duckduckgo.ts** – Web search via DuckDuckGo HTML, returns answers and top organic results.
- **webfetch.ts** – Fetches content from an exact URL, converting HTML pages to simplified Markdown.
- **llamacpp-progress.ts** – llama.cpp prompt-progress reporting and cached-token accounting for the OpenAI-completions API.
- **tps-time.ts** – Tracks tokens-per-second and timing metrics for agent messages and tool calls.
- **lsp/** – Language Server Protocol support (currently Lean), providing definitions, references, hover, and diagnostics.

## Installation

Copy these extension files to your pi extensions folder (e.g., `~/.pi/agent/extensions/`).

Then install the runtime dependency required by `llamacpp-progress.ts`:

```bash
npm install
```

`llamacpp-progress.ts` dynamically loads `convertMessages` from `@earendil-works/pi-ai` via `import.meta.resolve("@earendil-works/pi-ai")`. The bundled pi distribution embeds `pi-ai` as a virtual module, which native `import.meta.resolve()` cannot see, so the package must exist as a real dependency on disk (declared in `package.json`). Keep the `@earendil-works/pi-ai` version in `package.json` in sync with your installed pi version.

For the LSP extension, run `npm install` inside `lsp/` first.
