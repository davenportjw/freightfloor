# Warehouse Repository Agent Guide (`AGENTS.md`)

This guide applies across **Google Antigravity (`agy`)**, **OpenAI Codex CLI (`codex`)**, **Claude Code (`claude`)**, and any MCP-compatible coding agent working in the `warehouse` monorepo.

---

## 1. Repository Architecture & Workspaces

`warehouse` is a TypeScript ESM monorepo orchestrated with **Wireit** and deployed to Google Cloud Run (`davenporter-freightfloor`):

- **`packages/protocol` (`@warehouse/protocol`)**: Shared Zod runtime schemas (`ClientMessageSchema`, `ServerMessageSchema`), wire quantization, regional `SITE_THEMES`, and TypeScript contracts.
- **`packages/sim` (`@warehouse/sim`)**: Deterministic 10 Hz warehouse physics, A* pathfinding, occupancy reservations, contract generation, and AI driver archetypes (`Sprinter`, `Steady`, `Batcher`, `Opportunist`, `Strategist`).
- **`packages/armor` (`@warehouse/armor`)**: Multi-layer prompt injection defense, regex/heuristic sanitization (`sanitizeDirective`), and Google Cloud Model Armor screening.
- **`apps/lobby` (`@warehouse/lobby`)**: Public Fastify gateway (`POST /api/join`, `GET /api/network`, `/api/queue*`, static client assets, and authenticated `/ws?site=<siteId>` WebSocket reverse proxy).
- **`apps/site` (`@warehouse/site`)**: Authoritative regional shard server (`site-den-1`, `site-slc-2`, `site-phx-3`, `site-abq-4`), Firestore persistence, Pub/Sub cross-site pallet transfers, and Vertex AI (`gemini-3.5-flash-lite`) brain loops.
- **`apps/client` (`@warehouse/client`)**: Vite + hybrid 2:1 isometric Canvas2D renderer (`Painter`) and HUD v3 (`Drive` and `Floor` modes).
- **`tools/sprites` (`@warehouse/sprites`)**: Pure-TypeScript 96×96 isometric 3D sprite atlas generator (`atlas.png` + `atlas.json`).
- **`tools/loadtest` (`@warehouse/loadtest`)**: 128-client Cloud Run Job load harness (112 protocol bots + 16 Gemini 3.5 Flash-Lite pilots).
- **`tools/smoke` (`@warehouse/smoke`)**: Live HTTP/WebSocket, prompt-armor, and Playwright UI verification probes.
- **`tools/ast-sidecar` (`@warehouse/ast-sidecar`)**: Multi-compiler AST & Cross-Layer Lineage GraphDB Sidecar (`.ast-graph/ast.db`, SQLite LPG + Sourcegraph SCIP URIs).
- **`infra/`**: Terraform configuration for Cloud Run services, Firestore TTL, Pub/Sub topics/subscriptions, and Secret Manager.

---

## 2. AST GraphDB Sidecar & Traceability Workflow (`@warehouse/ast-sidecar`)

Always use the **AST GraphDB Sidecar** (detailed in [`.agents/skills/ast-graph-traceability/SKILL.md`](.agents/skills/ast-graph-traceability/SKILL.md)) for code navigation, impact analysis, and targeted test selection instead of blind multi-file greps:

### Cross-Harness Integration
- **Antigravity**: Runs the persistent sidecar daemon (`~/.gemini/config/sidecars/warehouse-ast-sidecar/sidecar.json` on `127.0.0.1:4319`), registers the `warehouse-ast-graph` MCP server (`~/.gemini/config/mcp_config.json` & `~/.gemini/antigravity/mcp_config.json`), and runs automatic `SessionStart` / `PostToolUse` hooks (`.agents/hooks.json`).
- **Claude Code**: Spawns the stdio MCP server via `.mcp.json` (`warehouse-ast-graph`) and runs automatic `SessionStart` / `PostToolUse` hooks via `.claude/settings.json`.
- **OpenAI Codex CLI & General CLI**: Uses the `ast_*` MCP tools or `npm run ast:query -- <cmd>` CLI, which performs an automatic `<2ms` lazy `mtime` incremental sync before every query.

### Strict Anti-Chunking, Batching & Contradiction Circuit-Breaker Mandate
- **NEVER Chunk-Read Large Files**: Never call `view_file` without `StartLine` and `EndLine` on files larger than 250 lines, and **never** page through large files (`packages/sim/src/engine.ts`, `apps/client/src/main.ts`, `apps/site/src/server.ts`, etc.) in 800-line chunks (`1-800`, `801-1600`, ...).
- **Sequential AST-First Lookup**: Never fire speculative `view_file` calls in parallel with `ast:query`. Run `ast_symbol`, `ast_refs`, `ast_outline`, or `ast_search` (or `npm run ast:query -- symbol|refs|outline|search`) **first**, read the `=== TARGET SUMMARY (REPEAT FOR TAIL VISIBILITY) ===` block at the bottom of the output to obtain the exact `filePath#L<start>-L<end>`, and then call `view_file` once on that exact line range.
- **No Shell Chaining with Diffs**: Never chain `npm run ast:query` with `&& git diff` or `&& git log` in the same shell command; large diff output overflows the 8KB tool preview window and obscures the AST result.
- **Historical Contradiction Circuit-Breaker**: If the AST graph shows that a user-reported bug is not present in `HEAD`, run at most **1** bounded `git log -G"<symbol>" -n 5 --oneline` check before checking live Cloud Run revisions or delegating session transcript forensics to the `research` subagent.

### Essential AST Graph Commands
```bash
# Synchronize AST GraphDB incrementally (or --full)
npm run ast:sync

# Look up one or more symbols' exact definitions, signatures, callers, callees, and tests
npm run ast:query -- symbol <Symbol1> [Symbol2...]

# Locate all WRITES_PROPERTY (mutations) and READS_PROPERTY (reads) for class/interface/Zod fields
npm run ast:query -- refs <PropertyOrSymbol1> [PropertyOrSymbol2...]

# List all symbols & exact line spans in one or more files (with optional substring filter)
npm run ast:query -- outline <FilePath1> [FilePath2...] [--filter <Substring>] [--kind <Kind>] [--exported]

# Fuzzy-search symbols by name, qualified name, or signature across the workspace
npm run ast:query -- search <Query> [--kind <Kind>] [--limit <N>]

# Compute 3-hop upstream blast radius & covering Vitest suites before editing
npm run ast:query -- blast-radius <SymbolOrFilePath>

# Identify exact Vitest test suites & test cases covering a symbol or file
npm run ast:query -- tests-for <SymbolOrFilePath>

# Trace cross-layer lineage for a Zod schema, Fastify route, or Terraform resource
npm run ast:query -- lineage <SchemaOrRouteOrResource>

# Find shortest dependency path between two symbols
npm run ast:query -- path <FromSymbol> <ToSymbol>

# Run structural health analysis (coupling/instability, untested hubs, cycles)
npm run ast:analyze

# Run empirical traceability & token-reduction benchmark suite
npm run ast:benchmark

# Export graph to openCypher (.ast-graph/export.cypher) and JSONL (.ast-graph/snapshot.jsonl)
npm run ast:export
```

---

## 3. Core Build, Test & Infrastructure Invariants

1. **Build & Unit Tests**:
   - Run `npm run build` to build all workspaces through the Wireit dependency graph.
   - Run `npm test` (or `npx vitest run <test-file>` from `ast:query -- tests-for`) for offline unit and integration tests.
2. **Never Mock Directive**:
   - Never introduce fake trajectories, mock inference fallbacks, or synthetic data in production routes, studios, or benchmarks. Surface real errors directly.
3. **Hardware & GCP Guardrails**:
   - Local host is Apple Silicon macOS without Docker. Container builds run on Cloud Build (`gcloud builds submit --config=cloudbuild.yaml --project=davenporter-freightfloor .`).
   - Always run `terraform -chdir=infra fmt` and `terraform -chdir=infra validate` when modifying `infra/*.tf`.
   - Use Google Cloud ADC (`gcloud auth application-default`) in project `davenporter-freightfloor`; never require or hardcode API keys.
4. **UI Theme Exception (Repo Override)**:
   - This repository does **not** use the global sepia / academic-light theme. Keep the existing client palette and styling in `apps/client/src/styles.css`; do not restyle toward sepia, even though the user-level UI rule says to. UI changes should be minimal and scoped to the feature being built.
5. **Git Hygiene & Doc-Code-Test Parity**:
   - Never commit `.ast-graph/` or `tools/smoke/out/`.
   - Keep `docs/architecture.md`, `docs/operations.md`, and `docs/protocol.md` in continuous parity with code and tests.
