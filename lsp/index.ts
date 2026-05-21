import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { StringEnum, Type, type Static } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, truncateHead } from "@earendil-works/pi-coding-agent";
import {
  createMessageConnection,
  StreamMessageReader,
  StreamMessageWriter,
  type MessageConnection,
  DidChangeTextDocumentNotification,
  DidCloseTextDocumentNotification,
  DidOpenTextDocumentNotification,
  DidSaveTextDocumentNotification,
  DefinitionRequest,
  HoverRequest,
  InitializeRequest,
  InitializedNotification,
  ReferencesRequest,
} from "vscode-languageserver-protocol/node.js";
import type {
  Diagnostic,
  Hover,
  Location,
  LocationLink,
} from "vscode-languageserver-protocol";

type LanguageConfig = {
  id: string;
  label: string;
  extensions: string[];
  rootMarkers: string[];
  command: string;
  args: string[];
  languageId: (filePath: string) => string;
  didOpenOptions?: {
    normal?: Record<string, unknown>;
    restart?: Record<string, unknown>;
  };
  clientCapabilities?: Record<string, unknown>;
  progress?: {
    method: string;
    filePath: (params: any) => string | undefined;
    busy: (params: any) => boolean;
  };
};

type ProjectMatch = {
  config: LanguageConfig;
  root: string;
  key: string;
};

type OpenFile = { version: number; text: string };
type LspDiagnostic = Diagnostic & { isSilent?: boolean };

type Params = Static<typeof LspParams>;

const READY_TIMEOUT_MS = 20_000;
const LANGUAGES: LanguageConfig[] = [
  {
    id: "lean",
    label: "Lean",
    extensions: [".lean"],
    rootMarkers: ["lakefile.toml", "lake-manifest.json", "lean-toolchain"],
    command: "lake",
    args: ["serve", "--"],
    languageId: () => "lean4",
    didOpenOptions: {
      normal: { dependencyBuildMode: "never" },
      restart: { dependencyBuildMode: "once" },
    },
    clientCapabilities: {
      lean: {
        incrementalDiagnosticSupport: true,
        silentDiagnosticSupport: true,
        rpcWireFormat: "v1",
      },
    },
    progress: {
      method: "$/lean/fileProgress",
      filePath: (params) => typeof params?.textDocument?.uri === "string" ? uriToPath(params.textDocument.uri) : undefined,
      busy: (params) => (params?.processing?.length ?? 0) > 0,
    },
  },
];
const SUPPORTED_LABEL = LANGUAGES.map((language) => language.label).join(", ");

const ACTIONS = ["definition", "references", "hover", "diagnostics", "restart_file"] as const;
const POSITION_ACTIONS = ["definition", "references", "hover"] as const;

const LspParams = Type.Object({
  action: StringEnum(ACTIONS),
  file: Type.String({ description: "File path inside a supported LSP project" }),
  line: Type.Optional(Type.Number({ description: "1-indexed line" })),
  column: Type.Optional(Type.Number({ description: "1-indexed column" })),
  query: Type.Optional(Type.String({ description: "Text query used to resolve a position inside the file" })),
});

function stripAt(filePath: string): string {
  return filePath.startsWith("@") ? filePath.slice(1) : filePath;
}

function absolutePath(cwd: string, filePath: string): string {
  const clean = stripAt(filePath);
  return path.isAbsolute(clean) ? clean : path.resolve(cwd, clean);
}

function realpath(filePath: string): string {
  const absolute = path.resolve(filePath);
  try {
    const native = (fs.realpathSync as typeof fs.realpathSync & { native?: typeof fs.realpathSync }).native;
    return (native ?? fs.realpathSync)(absolute);
  } catch {
    return absolute;
  }
}

function uriToPath(uri: string): string {
  try {
    return realpath(fileURLToPath(uri));
  } catch {
    return uri;
  }
}

function displayPath(filePath: string, cwd: string): string {
  const absolute = path.isAbsolute(filePath) ? filePath : path.resolve(cwd, filePath);
  const relative = path.relative(cwd, absolute);
  return relative && !relative.startsWith("..") ? relative : absolute;
}

function truncateText(text: string): string {
  const truncated = truncateHead(text, {
    maxBytes: DEFAULT_MAX_BYTES,
    maxLines: DEFAULT_MAX_LINES,
  });
  return truncated.truncated ? `${truncated.content}\n\n[output truncated]` : truncated.content;
}

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    (timer as NodeJS.Timeout).unref?.();
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

function abortable<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(new Error("aborted"));

  return new Promise((resolve, reject) => {
    const onAbort = () => {
      cleanup();
      reject(new Error("aborted"));
    };
    const cleanup = () => signal.removeEventListener("abort", onAbort);

    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        cleanup();
        resolve(value);
      },
      (error) => {
        cleanup();
        reject(error);
      },
    );
  });
}

function cancelledResult() {
  return {
    content: [{ type: "text" as const, text: "Cancelled" }],
    details: { cancelled: true },
  };
}

function sameRange(a: Diagnostic["range"], b: Diagnostic["range"]): boolean {
  return (
    a.start.line === b.start.line &&
    a.start.character === b.start.character &&
    a.end.line === b.end.line &&
    a.end.character === b.end.character
  );
}

function mergeDiagnostics(diagnostics: LspDiagnostic[]): LspDiagnostic[] {
  const merged: LspDiagnostic[] = [];

  for (const diagnostic of diagnostics) {
    const previous = merged[merged.length - 1];
    if (previous && previous.severity === diagnostic.severity && sameRange(previous.range, diagnostic.range)) {
      previous.message += diagnostic.message;
      continue;
    }
    merged.push({ ...diagnostic });
  }

  return merged;
}

function position(line: number, column: number) {
  return { line: Math.max(0, line - 1), character: Math.max(0, column - 1) };
}

function normalizeLocations(result: Location | Location[] | LocationLink[] | null | undefined): Location[] {
  if (!result) return [];
  const items = Array.isArray(result) ? result : [result];
  if (!items.length) return [];
  if ("uri" in items[0] && "range" in items[0]) return items as Location[];
  return (items as LocationLink[]).map((item) => ({
    uri: item.targetUri,
    range: item.targetSelectionRange ?? item.targetRange,
  }));
}

function formatDiagnostic(diagnostic: Diagnostic): string {
  const severity = ["", "ERROR", "WARN", "INFO", "HINT"][diagnostic.severity ?? 1] || "INFO";
  const line = diagnostic.range.start.line + 1;
  const column = diagnostic.range.start.character + 1;
  return `${severity} [${line}:${column}] ${diagnostic.message.trimEnd()}`;
}

function formatLocation(location: { uri: string; range: { start: { line: number; character: number } } }, cwd: string): string {
  const start = location.range.start;
  return `${displayPath(uriToPath(location.uri), cwd)}:${start.line + 1}:${start.character + 1}`;
}

function formatHover(contents: unknown): string {
  if (typeof contents === "string") return contents;
  if (Array.isArray(contents)) return contents.map(formatHover).filter(Boolean).join("\n\n");
  if (contents && typeof contents === "object" && "value" in contents) return String((contents as { value: unknown }).value ?? "");
  return "";
}


function buildHeader(action: Params["action"], query?: string, line?: number, column?: number): string {
  const lines = [`action: ${action}`];
  if (query) lines.push(`query: ${query}`);
  if (line !== undefined && column !== undefined) lines.push(`position: ${line}:${column}`);
  return lines.join("\n");
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function resolveQueryInFile(filePath: string, query: string, action: Params["action"]): { line: number; column: number } | null {
  const lines = fs.readFileSync(filePath, "utf8").split(/\r?\n/);
  const pattern = new RegExp(`\\b${escapeRegExp(query)}\\b`, "g");
  const declaration = /^\s*(def|theorem|lemma|axiom|abbrev|opaque|class|instance|structure|inductive|syntax|macro|notation)\b/;
  let fallback: { line: number; column: number } | null = null;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    const matches = [...line.matchAll(pattern)];
    if (matches.length === 0) continue;

    if ((action === "definition" || action === "references" || action === "hover") && declaration.test(line)) {
      fallback ??= { line: index + 1, column: (matches[0]!.index ?? 0) + 1 };
      if (matches.length > 1) {
        return { line: index + 1, column: (matches[1]!.index ?? 0) + 1 };
      }
      continue;
    }

    return { line: index + 1, column: (matches[0]!.index ?? 0) + 1 };
  }

  return fallback;
}

function findProject(fileOrDirectory: string): ProjectMatch | undefined {
  const absolute = path.resolve(fileOrDirectory);
  const extension = path.extname(absolute);
  const candidates = extension ? LANGUAGES.filter((language) => language.extensions.includes(extension)) : LANGUAGES;
  if (!candidates.length) return undefined;

  let current = absolute;
  try {
    if (!fs.statSync(current).isDirectory()) current = path.dirname(current);
  } catch {
    current = path.dirname(current);
  }

  while (true) {
    for (const config of candidates) {
      if (config.rootMarkers.some((marker) => fs.existsSync(path.join(current, marker)))) {
        const root = realpath(current);
        return { config, root, key: `${config.id}:${root}` };
      }
    }

    const parent = path.dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

class LspServer {
  readonly key: string;
  readonly project: ProjectMatch;
  private readonly process: ChildProcessWithoutNullStreams;
  private readonly connection: MessageConnection;
  private readonly rootUri: string;
  private readonly openFiles = new Map<string, OpenFile>();
  private readonly diagnostics = new Map<string, LspDiagnostic[]>();
  private readonly diagnosticsVersion = new Map<string, number>();
  private readonly diagnosticsWaiters = new Map<string, Array<() => void>>();
  private readonly busy = new Map<string, boolean>();
  private readonly waiters = new Map<string, Array<() => void>>();
  private closed = false;

  constructor(project: ProjectMatch, process: ChildProcessWithoutNullStreams, connection: MessageConnection) {
    this.key = project.key;
    this.project = project;
    this.process = process;
    this.connection = connection;
    this.rootUri = pathToFileURL(project.root).href;
  }

  static async start(project: ProjectMatch): Promise<LspServer | undefined> {
    const process = spawn(project.config.command, project.config.args, {
      cwd: project.root,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const server = new LspServer(
      project,
      process,
      createMessageConnection(new StreamMessageReader(process.stdout), new StreamMessageWriter(process.stdin)),
    );

    process.stdin.on("error", () => {});
    process.stdout.on("error", () => {});
    process.stderr.on("data", () => {});
    process.stderr.on("error", () => {});

    server.connection.onNotification("textDocument/publishDiagnostics", (params: any) => {
      const filePath = uriToPath(params.uri);
      const next = params.isIncremental
        ? [...(server.diagnostics.get(filePath) ?? []), ...(params.diagnostics ?? [])]
        : [...(params.diagnostics ?? [])];
      server.diagnostics.set(filePath, mergeDiagnostics(next.filter((diagnostic: LspDiagnostic) => !diagnostic.isSilent)));
      server.diagnosticsVersion.set(filePath, (server.diagnosticsVersion.get(filePath) ?? 0) + 1);
      const waiters = server.diagnosticsWaiters.get(filePath);
      if (waiters) {
        server.diagnosticsWaiters.delete(filePath);
        for (const resolve of waiters) resolve();
      }
    });

    if (project.config.progress) {
      server.connection.onNotification(project.config.progress.method, (params: any) => {
        const filePath = project.config.progress?.filePath(params);
        if (!filePath) return;
        const isBusy = !!project.config.progress?.busy(params);
        server.busy.set(filePath, isBusy);
        if (!isBusy) server.resolveWaiters(filePath);
      });
    }

    const close = () => {
      server.closed = true;
      servers.delete(server.key);
    };

    server.connection.onError(() => {});
    server.connection.onClose(close);
    process.on("exit", close);
    process.on("error", close);

    server.connection.onRequest("workspace/configuration", () => []);
    server.connection.onRequest("workspace/workspaceFolders", () => [{ uri: server.rootUri, name: path.basename(project.root) }]);
    server.connection.onRequest("window/workDoneProgress/create", () => null);
    server.connection.onRequest("client/registerCapability", () => null);
    server.connection.onRequest("client/unregisterCapability", () => null);
    server.connection.onRequest("workspace/inlayHint/refresh", () => null);
    server.connection.onRequest("workspace/semanticTokens/refresh", () => null);
    server.connection.onRequest("workspace/codeLens/refresh", () => null);

    server.connection.listen();

    try {
      await withTimeout(
        server.connection.sendRequest(InitializeRequest.method, {
          processId: process.pid,
          rootUri: server.rootUri,
          workspaceFolders: [{ uri: server.rootUri, name: path.basename(project.root) }],
          capabilities: {
            workspace: { configuration: true },
            window: { workDoneProgress: true },
            textDocument: {
              synchronization: { didOpen: true, didChange: true, didClose: true, didSave: true },
              publishDiagnostics: { versionSupport: true },
            },
            ...(project.config.clientCapabilities ?? {}),
          },
        }),
        30_000,
        `${project.config.label} initialize`,
      );

      server.connection.sendNotification(InitializedNotification.type, {});
      return server;
    } catch {
      try { process.kill(); } catch {}
      return undefined;
    }
  }

  get isClosed(): boolean {
    return this.closed;
  }

  private resolveWaiters(filePath: string) {
    const waiting = this.waiters.get(filePath);
    if (!waiting) return;
    this.waiters.delete(filePath);
    for (const resolve of waiting) resolve();
  }

  private async waitForDiagnostics(filePath: string, afterVersion: number, timeoutMs = 1500): Promise<void> {
    if ((this.diagnosticsVersion.get(filePath) ?? 0) > afterVersion) return;
    await withTimeout(
      new Promise<void>((resolve) => {
        const waiting = this.diagnosticsWaiters.get(filePath) ?? [];
        waiting.push(resolve);
        this.diagnosticsWaiters.set(filePath, waiting);
      }),
      timeoutMs,
      `${this.project.config.label} diagnostics`,
    ).catch(() => {});
  }

  private async closeFile(filePath: string): Promise<void> {
    const absolute = realpath(filePath);
    if (!this.openFiles.has(absolute)) return;

    this.openFiles.delete(absolute);
    this.diagnostics.delete(absolute);
    this.diagnosticsVersion.delete(absolute);
    this.diagnosticsWaiters.delete(absolute);
    this.busy.delete(absolute);
    this.resolveWaiters(absolute);

    await this.connection.sendNotification(DidCloseTextDocumentNotification.type, {
      textDocument: { uri: pathToFileURL(absolute).href },
    }).catch(() => {});
  }

  private async sync(filePath: string, mode: "normal" | "restart" = "normal"): Promise<{ filePath: string; uri: string; changed: boolean; diagnosticsVersion: number }> {
    const absolute = realpath(filePath);
    const text = fs.readFileSync(absolute, "utf8");
    const uri = pathToFileURL(absolute).href;
    const open = this.openFiles.get(absolute);
    const diagnosticsVersion = this.diagnosticsVersion.get(absolute) ?? 0;
    const changed = mode === "restart" || !open || open.text !== text;

    if (!changed) {
      return { filePath: absolute, uri, changed: false, diagnosticsVersion };
    }

    if (this.project.config.progress) this.busy.set(absolute, true);

    if (open && mode === "normal") {
      const version = open.version + 1;
      this.openFiles.set(absolute, { version, text });
      await this.connection.sendNotification(DidChangeTextDocumentNotification.type, {
        textDocument: { uri, version },
        contentChanges: [{ text }],
      }).catch(() => {});
    } else {
      this.openFiles.set(absolute, { version: 1, text });
      await this.connection.sendNotification(DidOpenTextDocumentNotification.type, {
        textDocument: {
          uri,
          languageId: this.project.config.languageId(absolute),
          version: 1,
          text,
        },
        ...(this.project.config.didOpenOptions?.[mode] ?? {}),
      }).catch(() => {});
    }

    await this.connection.sendNotification(DidSaveTextDocumentNotification.type, {
      textDocument: { uri },
      text,
    }).catch(() => {});

    return { filePath: absolute, uri, changed: true, diagnosticsVersion };
  }

  private async waitUntilReady(filePath: string): Promise<void> {
    if (!this.project.config.progress) return;
    if (this.busy.get(filePath) === false) return;

    await withTimeout(
      new Promise<void>((resolve) => {
        const waiting = this.waiters.get(filePath) ?? [];
        waiting.push(resolve);
        this.waiters.set(filePath, waiting);
      }),
      READY_TIMEOUT_MS,
      `${this.project.config.label} file processing`,
    ).catch(() => {});
  }

  private async prepare(
    filePath: string,
    mode: "normal" | "restart" = "normal",
    settle = false,
  ): Promise<{ filePath: string; uri: string; changed: boolean; diagnosticsVersion: number }> {
    const synced = await this.sync(filePath, mode);
    if (synced.changed) {
      await this.waitUntilReady(synced.filePath);
      if (settle) {
        await this.waitForDiagnostics(synced.filePath, synced.diagnosticsVersion);
      }
    }
    return synced;
  }

  async diagnosticsForFile(filePath: string): Promise<LspDiagnostic[]> {
    const synced = await this.prepare(filePath, "normal", true);
    return [...(this.diagnostics.get(synced.filePath) ?? [])];
  }

  async definition(filePath: string, line: number, column: number): Promise<Location[]> {
    const synced = await this.prepare(filePath, "normal", true);
    return normalizeLocations(
      await this.connection.sendRequest(DefinitionRequest.type, {
        textDocument: { uri: synced.uri },
        position: position(line, column),
      }),
    );
  }

  async references(filePath: string, line: number, column: number): Promise<Location[]> {
    const synced = await this.prepare(filePath, "normal", true);
    return normalizeLocations(
      await this.connection.sendRequest(ReferencesRequest.type, {
        textDocument: { uri: synced.uri },
        position: position(line, column),
        context: { includeDeclaration: true },
      }),
    );
  }

  async hover(filePath: string, line: number, column: number): Promise<Hover | null> {
    const synced = await this.prepare(filePath, "normal", true);
    return (await this.connection.sendRequest(HoverRequest.type, {
      textDocument: { uri: synced.uri },
      position: position(line, column),
    })) ?? null;
  }

  async restartFile(filePath: string): Promise<LspDiagnostic[]> {
    await this.closeFile(filePath);
    const synced = await this.prepare(filePath, "restart", true);
    return [...(this.diagnostics.get(synced.filePath) ?? [])];
  }

  async shutdown(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    try { this.process.kill(); } catch {}
  }
}

const servers = new Map<string, Promise<LspServer | undefined>>();

function getOpenServerCount(): number {
  return servers.size;
}

async function getServerFor(fileOrDirectory: string): Promise<LspServer | undefined> {
  const project = findProject(fileOrDirectory);
  if (!project) return undefined;

  let server = servers.get(project.key);
  if (!server) {
    server = LspServer.start(project);
    servers.set(project.key, server);
  }

  const resolved = await server;
  if (!resolved || resolved.isClosed) {
    servers.delete(project.key);
    return resolved?.isClosed ? getServerFor(fileOrDirectory) : undefined;
  }

  return resolved;
}

async function shutdownServers(): Promise<void> {
  const active = [...servers.values()];
  servers.clear();
  for (const server of active) await (await server)?.shutdown();
}

export default function (pi: ExtensionAPI) {
  let showStatus = false;
  let warmingUp = false;
  let startFailed = false;
  let warmup: Promise<void> | undefined;
  let setStatus: ((key: string, text: string | undefined) => void) | undefined;

  const updateStatus = () => {
    if (!setStatus) return;
    if (!showStatus) return setStatus("lsp", undefined);

    const count = getOpenServerCount();
    if (warmingUp && count === 0) return setStatus("lsp", "lsp: starting...");
    if (startFailed && count === 0) return setStatus("lsp", "lsp: failed to start");
    setStatus("lsp", `lsp: ${count} server${count === 1 ? "" : "s"}`);
  };

  const openServer = async (fileOrDirectory: string, signal?: AbortSignal) => {
    try {
      const server = await abortable(getServerFor(fileOrDirectory), signal);
      startFailed = !server;
      return server;
    } catch (error) {
      if (!(error instanceof Error && error.message === "aborted")) startFailed = true;
      throw error;
    } finally {
      updateStatus();
    }
  };

  const warmServer = (fileOrDirectory: string) => {
    if (warmup) return warmup;

    warmingUp = true;
    startFailed = false;
    updateStatus();

    warmup = (async () => {
      try {
        await openServer(fileOrDirectory);
      } catch {}
      warmingUp = false;
      warmup = undefined;
      updateStatus();
    })();

    return warmup;
  };

  pi.registerTool({
    name: "lsp",
    label: "LSP",
    description: `Query the project language server. Supported right now: ${SUPPORTED_LABEL}. Actions: definition, references, hover, diagnostics, restart_file. Use action=diagnostics on a file after edits to check for errors and warnings. Use action=restart_file when diagnostics say imports are out of date and must be rebuilt or mention the editor Restart File command; it returns fresh diagnostics after rebuild.`,
    promptSnippet: `Query the project language server. Supported right now: ${SUPPORTED_LABEL}. Use action=diagnostics after edits to check for errors.`,
    promptGuidelines: [
      "Use lsp action=diagnostics after editing a supported file to check for errors and warnings.",
      "Use lsp for definition lookup, references, and hover info in a supported project.",
      "Use lsp action=restart_file when diagnostics say imports are out of date and must be rebuilt or mention the editor Restart File command; it returns fresh diagnostics after rebuild.",
    ],
    parameters: LspParams,

    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      try {
        const input = params as Params;
        const absolute = absolutePath(ctx.cwd, input.file);
        const project = findProject(absolute);

        if (!project) {
          return {
            content: [{ type: "text" as const, text: `${displayPath(absolute, ctx.cwd)} is not inside a supported LSP project. Supported right now: ${SUPPORTED_LABEL}.` }],
            details: { unsupported: true },
          };
        }

        const server = await openServer(absolute, signal);
        if (!server) {
          return {
            content: [{ type: "text" as const, text: `Found a ${project.config.label} project for ${displayPath(absolute, ctx.cwd)}, but could not start ${project.config.command} ${project.config.args.join(" ")}.` }],
            details: { startFailed: true },
          };
        }

        let line = input.line;
        let column = input.column;

        if ((POSITION_ACTIONS as readonly string[]).includes(input.action) && (line === undefined || column === undefined)) {
          if (!input.query) throw new Error(`action "${input.action}" requires line/column or query.`);
          const resolved = resolveQueryInFile(absolute, input.query, input.action);
          if (!resolved) throw new Error(`could not resolve query "${input.query}" in ${displayPath(absolute, ctx.cwd)}.`);
          line = resolved.line;
          column = resolved.column;
        }

        switch (input.action) {
          case "definition": {
            const result = await abortable(server.definition(absolute, line!, column!), signal);
            const body = result.length ? result.map((location) => formatLocation(location, ctx.cwd)).join("\n") : "No definitions found.";
            return {
              content: [{ type: "text" as const, text: truncateText(`${buildHeader(input.action, input.query, line, column)}\n${body}`) }],
              details: result,
            };
          }
          case "references": {
            const result = await abortable(server.references(absolute, line!, column!), signal);
            const body = result.length ? result.map((location) => formatLocation(location, ctx.cwd)).join("\n") : "No references found.";
            return {
              content: [{ type: "text" as const, text: truncateText(`${buildHeader(input.action, input.query, line, column)}\n${body}`) }],
              details: result,
            };
          }
          case "hover": {
            const result = await abortable(server.hover(absolute, line!, column!), signal);
            const body = result ? formatHover(result.contents) || "No hover information." : "No hover information.";
            return {
              content: [{ type: "text" as const, text: truncateText(`${buildHeader(input.action, input.query, line, column)}\n${body}`) }],
              details: result,
            };
          }
          case "diagnostics": {
            const result = await abortable(server.diagnosticsForFile(absolute), signal);
            const body = result.length ? result.map(formatDiagnostic).join("\n") : "No diagnostics.";
            return {
              content: [{ type: "text" as const, text: truncateText(`${buildHeader(input.action)}\n${body}`) }],
              details: result,
            };
          }
          case "restart_file": {
            const diagnostics = await abortable(server.restartFile(absolute), signal);
            const body = diagnostics.length ? diagnostics.map(formatDiagnostic).join("\n") : "No diagnostics.";
            return {
              content: [{ type: "text" as const, text: truncateText(`${buildHeader(input.action)}\nfile: ${displayPath(absolute, ctx.cwd)}\n\n${body}`) }],
              details: diagnostics,
            };
          }
        }
      } catch (error) {
        if (signal?.aborted || (error instanceof Error && error.message === "aborted")) return cancelledResult();
        throw error;
      }
    },
  });

  pi.on("session_start", async (_event, ctx) => {
    setStatus = ctx.hasUI ? ctx.ui.setStatus.bind(ctx.ui) : undefined;
    showStatus = !!findProject(ctx.cwd);
    updateStatus();
    if (showStatus) void warmServer(ctx.cwd);
  });

  pi.on("session_shutdown", async () => {
    showStatus = false;
    warmingUp = false;
    startFailed = false;
    warmup = undefined;
    await shutdownServers();
    updateStatus();
    setStatus = undefined;
  });
}
