# Claude Code Configuration & Workflow (`CLAUDE.md`)

Please read and follow [AGENTS.md](./AGENTS.md) and the AST GraphDB Traceability Skill in [.agents/skills/ast-graph-traceability/SKILL.md](./.agents/skills/ast-graph-traceability/SKILL.md) for full repository architecture, invariants, and traceability workflows.

---

## How the AST GraphDB Sidecar Works in Claude Code

1. **Automatic Stdio MCP Server (`.mcp.json`)**:
   - Claude Code automatically launches `warehouse-ast-graph` (`node --no-warnings tools/ast-sidecar/dist/mcp.js`) defined in [`.mcp.json`](./.mcp.json).
   - While running, the MCP server keeps an in-process debounced `fs.watch` watcher active across `packages/`, `apps/`, `tools/`, and `infra/`, and exposes all 10 `ast_*` MCP tools:
     - `ast_symbol`: Lookup symbol definition, signature, callers, callees, and covering tests.
     - `ast_outline`: List a file's structural symbol outline with exact `startLine`–`endLine` spans and optional `--filter` / `--kind` / `--exported` filtering.
     - `ast_search`: Fuzzy FTS5/substring symbol search across the workspace without SCIP URI path false positives.
     - `ast_blast_radius`: Compute transitive upstream callers/dependents and required Vitest test files before modifying shared code.
     - `ast_tests_for`: Return the exact Vitest `TestSuite` and `TestCase` nodes covering a symbol or file.
     - `ast_lineage`: Trace cross-layer lineage across `@warehouse/protocol` Zod schemas, Fastify HTTP/WS routes, client calls, and `infra/*.tf` Terraform resources.
     - `ast_shortest_path`: Find the shortest dependency chain between two symbols.
     - `ast_analyze`: Compute package coupling/instability ($C_a, C_e, I$), circular dependencies, and untested high-fan-in hubs.
     - `ast_benchmark`: Run the empirical indexing and context-efficiency benchmark suite.
     - `ast_sync`: Trigger an immediate incremental or full AST GraphDB sync.

2. **Strict Anti-Chunking & Sequential AST-First Mandate**:
   - Never page through large files (`packages/sim/src/engine.ts`, `apps/client/src/main.ts`, `apps/site/src/server.ts`) in 800-line chunks, and never run speculative file reads in parallel with an AST query.
   - Always call `ast_symbol`, `ast_outline`, or `ast_search` first, get the exact `startLine`–`endLine`, and read only that surgical span.

3. **Automatic Lifecycle Hooks (`.claude/settings.json`)**:
   - `SessionStart`: Runs `hook-handler.js session-start` to verify `.ast-graph/ast.db` readiness and report graph inventory.
   - `PostToolUse` (`Write|Edit|MultiEdit`): Automatically runs `hook-handler.js post-tool-use` to incrementally re-index the modified file in `<50ms` after every file edit.

4. **CLI Fallback (`npm run ast:*`)**:
   - You can also invoke the AST GraphDB directly from the shell at any time via `npm run ast:query -- <symbol|outline|search|blast-radius|tests-for|lineage|path>`, `npm run ast:analyze`, `npm run ast:benchmark`, and `npm run ast:sync`.
