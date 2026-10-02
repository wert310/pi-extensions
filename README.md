# pi-extensions

Custom extensions for the **[pi coding agent](https://github.com/earendil-works/pi-coding-agent)**, built and tested against pi **0.84.x**.

This repo is a drop-in set of tools and a provider that extend pi beyond its built-ins:

| Extension | What it adds |
| --- | --- |
| `duckduckgo.ts` | **websearch** tool — DuckDuckGo search with answer + organic results, ad-filtered |
| `webfetch.ts` | **webfetch** tool — fetch a URL, convert HTML → readable Markdown, truncate safely |
| `llamacpp-progress.ts` | **llamacpp-progress** provider — prompt progression + cached-token accounting for llama.cpp |
| `tps-time.ts` | tokens-per-second & timing stats in the status bar / session notify |
| `continue.ts` | **continue** command — resume the agent loop invisibly with no new context |
| `lsp/` | **lsp** tool — Language Server Protocol client (currently Lean: defs, refs, hover, diagnostics, goals) |

---

## Installation

1. Copy the extension files into pi's extension folder:

   ```bash
   cp *.ts -r lsp ~/.pi/agent/extensions/
   ```

   (Or clone this repo there — it's designed to be used directly from a checkout.)

2. Install runtime dependencies (required by `llamacpp-progress.ts` and `lsp/`):

   ```bash
   npm install          # at the repo root
   npm install --prefix lsp   # for the LSP extension
   ```

   Alternatively, point pi at this repo with the `.pi.json` / `pi.extensions` setting that takes
   an extension path or `npm:` spec — see the pi docs on extensions.

3. Restart pi (extensions are discovered at startup).

> **Why `@earendil-works/pi-ai` has to be installed as a real dependency (not just present inside pi):**
> the bundled pi distribution embeds `pi-ai` as a virtual module, which native
> `import.meta.resolve()` cannot see. `llamacpp-progress.ts` needs to import a module path
> out of `pi-ai` at runtime, so the package must physically exist in `node_modules`.
> Keep the `pi-ai` version in `package.json` in sync with your installed pi version.

---

## duckduckgo.ts — `websearch`

Searches the public web via DuckDuckGo's HTML endpoint and returns an `answer` plus the top
organic results as JSON. Sponsored results are detected and filtered.

- **Parameters:** `query` (required), `maxResults` (default 8, max 10)
- **Output:** `{ query, answer?, results: [{ rank, title, url, displayUrl?, snippet? }] }`

### Notes

- Uses DuckDuckGo's **unofficial `html/` endpoint**, which can change or rate-limit without notice.
  Use it from modest volume only.
- Pure parsing helpers (`decodeHtmlEntities`, `parseDuckDuckGoHtml`, …) are exported so you can
  reuse them elsewhere.

## webfetch.ts — `webfetch`

Fetches the content of an exact URL and converts HTML to simplified Markdown. Useful because it
hands the model a clean, token-efficient rendering instead of raw markup.

- **Parameters:** `url`
- Handles: headings, links, lists, tables, blockquotes, fenced code blocks, `main`/`article`
  extraction, and strips `script`/`style`/`nav`/`footer`/`form`/`svg` etc.
- **Truncation:** output is capped at the standard pi limits (2000 lines / 50 KB). If truncated,
  the **full content is written to a temp file** and the path is included in the result, so the
  model (or the user) can read on from disk instead of losing data.
- HTTP/HTTPS only; non-textual content types are rejected. Has a 30s timeout and respects
  abort signals.

## llamacpp-progress.ts — `llamacpp-progress` provider

A drop-in **provider override** for llama.cpp's OpenAI-completions protocol. It wraps the standard
completions request with two things the built-in provider doesn't show:

- **Prompt progression** — llama.cpp's SSE `prompt_progress` events are rendered as a live
  "Prompt 42% · 2140/5000 · cache 1560 · 87.4 tok/s" working message instead of silence.
- **Cached-token accounting** — reads `usage.prompt_tokens_details.cached_tokens` (and
  `_cache_write_tokens` / `prompt_cache_hit_tokens`) so cached prompt tokens are billed and
  reported separately from fresh input.

It also handles streaming thinking/reasoning content, incremental tool-call argument parsing,
and `usage` inside stream chunks.

### Configuration

Point a model at this provider instead of the default llama.cpp one. Example provider config:

```json
{
  "type": "llamacpp-progress",
  "baseUrl": "http://localhost:8080/v1",
  "api": "llamacpp-openai-completions"
}
```

Tested with llama.cpp `--serve` and `--jinja`/Qwen chat-templates (reasoning via
`chat_template_kwargs`).

## tps-time.ts

Tracks tokens-per-second and timing metrics across a session, surfaced in the TUI:

- **During streaming:** live `92 t/s (486 tok / 5.3s)` plus context usage in the status bar.
- **During tool calls:** elapsed time for active tools.
- **At the end of an agent run:** a summary notification —

  ```
  21:04:22 ✓ 87 t/s overall · 12.4k tokens in 142.7s streamed · 8.3s tools · 154.0s total
  ```

When usage isn't reported (some local models), it falls back to an estimated token count and marks
it with a `~`.

## continue.ts — `continue`

Adds a `continue` command that resumes the agentic loop with an **identical context snapshot** —
no synthetic "continue" text is injected into the LLM's messages. The resumption is injected into
the agent loop without blocking the RPC response (which would otherwise trip the web UI's 30s
timeout).

## lsp/ — `lsp` tool

A multi-language **Language Server Protocol** client that brokers requests to a real language
server. Currently configured for **Lean** (spawns `lake serve --`), but the config table is
language-agnostic and easy to extend.

- **Actions:** `definition`, `references`, `hover`, `diagnostics`, `restart_file`, `goal`
- **Params:** `file`, plus `line`/`column` **or** a `query` to resolve a position automatically
  (finds the declaration site for a symbol).
- **`goal`** returns the live Lean proof state (hypotheses + goal) at a cursor — very useful for
  writing proofs conversationally.
- **`restart_file`** forces a dependency rebuild (the "Restart File" command) and returns fresh diagnostics.
- **`diagnostics`** waits for the file to finish processing, then returns the current diagnostics.
- Server lifecycle is handled for you: project root detection via `lakefile.toml` /
  `lake-manifest.json` / `lean-toolchain`, per-project server reuse, diagnostics merge +
  version tracking, and graceful shutdown.

- The status bar shows `lsp: 2 servers` while servers are alive.
- A `lsp-errors` **command** prints the most recent entries from `~/.pi/agent/extensions/lsp/lsp-errors.log`
  to help debug server startup failures.

---

## Requirements

- pi **0.84.x** (older/newer may work but aren't tested)
- Node.js with `npm`
- For `lsp/`: a working Lean toolchain on `PATH` (`lake`)
- For `llamacpp-progress.ts`: a running llama.cpp server (or API-compatible backend)

## Troubleshooting

- **`llamacpp-progress.ts` fails to load** → `pi-ai` isn't a resolvable dependency on disk. Run
  `npm install` and re-check the `@earendil-works/pi-ai` version matches your pi.
- **LSP says it can't start a server** → run `lsp-errors` in pi to see the last 50 log lines.
- **`websearch`/`webfetch` returns nothing / rate-limited** → the upstream site changed its markup
  or throttled you; pause and retry later.

## Development

The extensions are independent of each other — each file registers one extension and can be
copied in or out on its own.

## License

MIT — see [LICENSE](LICENSE).
