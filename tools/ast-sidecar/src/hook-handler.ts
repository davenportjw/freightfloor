import path from 'node:path';
import http from 'node:http';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { AstGraphDatabase } from './db.js';
import { AstGraphIndexer } from './indexer.js';

export type HookHarnessFormat = 'antigravity' | 'claude-code' | 'unknown';

export interface HookResult {
  harness: HookHarnessFormat;
  eventType: string;
  filePath?: string;
  filesUpdated: number;
  durationMs: number;
  stdoutJson: Record<string, unknown>;
}

export interface HookInvocationOptions {
  workspaceRoot?: string;
  dbPath?: string;
  useDaemon?: boolean;
  daemonHost?: string;
  daemonPort?: number;
}

export interface ParsedHookInput {
  harness: HookHarnessFormat;
  eventType: string;
  filePath?: string;
  rawPayload: Record<string, unknown>;
}

const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_PORT = 4319;

/**
 * Polymorphically parses stdin JSON from either Antigravity or Claude Code hook harnesses.
 */
export function parseHookInput(eventTypeArg: string, rawStdinJson: string): ParsedHookInput {
  const trimmed = rawStdinJson.trim();
  let parsed: Record<string, unknown> = {};
  if (trimmed.length > 0) {
    try {
      const candidate = JSON.parse(trimmed) as unknown;
      if (candidate && typeof candidate === 'object' && !Array.isArray(candidate)) {
        parsed = candidate as Record<string, unknown>;
      }
    } catch {
      parsed = {};
    }
  }

  // Detect Antigravity format: { toolCall: { name, args: { TargetFile, ... } } }
  const toolCall = parsed.toolCall as Record<string, unknown> | undefined;
  const toolCallArgs = (toolCall?.args as Record<string, unknown> | undefined) ?? undefined;
  const agyTargetFile =
    (typeof toolCallArgs?.TargetFile === 'string' ? toolCallArgs.TargetFile : undefined) ??
    (typeof toolCallArgs?.AbsolutePath === 'string' ? toolCallArgs.AbsolutePath : undefined) ??
    (typeof parsed.TargetFile === 'string' ? parsed.TargetFile : undefined);

  // Detect Claude Code format: { hook_event_name, tool_name, tool_input: { file_path, path } }
  const toolInput = parsed.tool_input as Record<string, unknown> | undefined;
  const claudeFilePath =
    (typeof toolInput?.file_path === 'string' ? toolInput.file_path : undefined) ??
    (typeof toolInput?.path === 'string' ? toolInput.path : undefined) ??
    (typeof parsed.file_path === 'string' ? parsed.file_path : undefined);

  let harness: HookHarnessFormat = 'unknown';
  if (
    toolCall !== undefined ||
    typeof parsed.conversationId === 'string' ||
    typeof parsed.TargetFile === 'string'
  ) {
    harness = 'antigravity';
  } else if (
    toolInput !== undefined ||
    typeof parsed.hook_event_name === 'string' ||
    typeof parsed.tool_name === 'string' ||
    typeof parsed.session_id === 'string'
  ) {
    harness = 'claude-code';
  }

  const normalizedEvent =
    eventTypeArg ||
    (typeof parsed.hook_event_name === 'string' ? parsed.hook_event_name : '') ||
    (typeof parsed.event === 'string' ? parsed.event : '') ||
    'post-tool-use';

  return {
    harness,
    eventType: normalizedEvent,
    filePath: agyTargetFile ?? claudeFilePath,
    rawPayload: parsed,
  };
}

async function tryPingDaemonSync(
  endpoint: string,
  body: Record<string, unknown>,
  host: string,
  port: number,
  timeoutMs = 75,
): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const payload = JSON.stringify(body);
    const req = http.request(
      {
        hostname: host,
        port,
        path: endpoint,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload),
        },
        timeout: timeoutMs,
      },
      (res) => {
        res.resume();
        res.on('end', () => {
          resolve((res.statusCode ?? 500) >= 200 && (res.statusCode ?? 500) < 300);
        });
      },
    );
    req.on('timeout', () => {
      req.destroy();
      resolve(false);
    });
    req.on('error', () => {
      resolve(false);
    });
    req.write(payload);
    req.end();
  });
}

/**
 * Executes a hook invocation for either `session-start` or `post-tool-use` and returns
 * the harness-compatible stdout JSON response alongside timing telemetry.
 */
export async function handleHookInvocation(
  eventTypeArg: string,
  rawStdinJson: string,
  options?: HookInvocationOptions,
): Promise<HookResult> {
  const startTime = performance.now();
  const parsed = parseHookInput(eventTypeArg, rawStdinJson);
  const workspaceRoot = path.resolve(options?.workspaceRoot ?? process.cwd());
  const dbPath =
    options?.dbPath ?? path.join(workspaceRoot, '.ast-graph', 'ast.db');
  const lowerEvent = parsed.eventType.toLowerCase();

  let filesUpdated = 0;

  if (lowerEvent === 'session-start' || lowerEvent === 'sessionstart') {
    const daemonHandled =
      options?.useDaemon !== false
        ? await tryPingDaemonSync(
            '/sync',
            { full: false },
            options?.daemonHost ?? DEFAULT_HOST,
            options?.daemonPort ?? DEFAULT_PORT,
          )
        : false;

    if (!daemonHandled) {
      const db = new AstGraphDatabase(dbPath);
      try {
        const indexer = new AstGraphIndexer(workspaceRoot, db);
        const result = indexer.lazySyncIfDirty();
        filesUpdated = result.filesUpdated;
      } finally {
        db.close();
      }
    }
  } else {
    // post-tool-use / PostToolUse
    if (parsed.filePath) {
      const daemonHandled =
        options?.useDaemon !== false
          ? await tryPingDaemonSync(
              '/sync',
              { full: false, paths: [parsed.filePath] },
              options?.daemonHost ?? DEFAULT_HOST,
              options?.daemonPort ?? DEFAULT_PORT,
            )
          : false;

      if (daemonHandled) {
        filesUpdated = 1;
      } else {
        const db = new AstGraphDatabase(dbPath);
        try {
          const indexer = new AstGraphIndexer(workspaceRoot, db);
          const counts = db.getCounts();
          if (counts.files === 0) {
            // Ensure initial graph is populated before applying single-file delta
            indexer.syncWorkspace({ full: true });
          }
          const delta = indexer.syncWorkspace({
            full: false,
            targetPaths: [parsed.filePath],
          });
          filesUpdated = delta.filesUpdated + delta.filesDeleted;
        } finally {
          db.close();
        }
      }
    } else {
      // No target file specified — perform a fast dirty check
      const db = new AstGraphDatabase(dbPath);
      try {
        const indexer = new AstGraphIndexer(workspaceRoot, db);
        const delta = indexer.lazySyncIfDirty();
        filesUpdated = delta.filesUpdated + delta.filesDeleted;
      } finally {
        db.close();
      }
    }
  }

  const durationMs = Number((performance.now() - startTime).toFixed(2));

  // Build harness-appropriate response
  let stdoutJson: Record<string, unknown>;
  if (parsed.harness === 'claude-code') {
    stdoutJson = { continue: true };
  } else {
    // Antigravity expects `{}` (or `{ injectSteps: [...] }`)
    stdoutJson = {};
  }

  return {
    harness: parsed.harness,
    eventType: parsed.eventType,
    filePath: parsed.filePath,
    filesUpdated,
    durationMs,
    stdoutJson,
  };
}

async function readStdin(timeoutMs = 250): Promise<string> {
  if (process.stdin.isTTY) {
    return '';
  }
  return new Promise<string>((resolve) => {
    const chunks: Buffer[] = [];
    const timer = setTimeout(() => {
      process.stdin.removeAllListeners();
      resolve(Buffer.concat(chunks).toString('utf8'));
    }, timeoutMs);

    process.stdin.on('data', (chunk: Buffer | string) => {
      chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
    });
    process.stdin.on('end', () => {
      clearTimeout(timer);
      resolve(Buffer.concat(chunks).toString('utf8'));
    });
    process.stdin.on('error', () => {
      clearTimeout(timer);
      resolve(Buffer.concat(chunks).toString('utf8'));
    });
  });
}

const isMain =
  process.argv[1] &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (isMain) {
  const eventArg = process.argv[2] ?? 'post-tool-use';
  readStdin()
    .then((rawStdin) => handleHookInvocation(eventArg, rawStdin))
    .then((result) => {
      process.stdout.write(`${JSON.stringify(result.stdoutJson)}\n`);
    })
    .catch(() => {
      // Never block the host agent tool loop on hook errors
      process.stdout.write('{}\n');
    });
}
