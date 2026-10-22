# AST GraphDB Traceability & Targeted Verification Rule

When investigating bugs, tracing cross-package dependencies, modifying `@warehouse/protocol` schemas, refactoring shared code, or selecting tests in the `warehouse` repository:

1. **Query the AST GraphDB First (`@warehouse/ast-sidecar`)**:
   - Before running broad multi-file text searches or reading large source files, query the local AST GraphDB (`.ast-graph/ast.db`) using the `ast-graph-traceability` skill (`npm run ast:query -- <command>` or the `ast_*` MCP tools):
     - **Locate symbol & call neighborhood**: `npm run ast:query -- symbol <SymbolName>` (`ast_symbol`)
     - **Outline symbols in a file (with optional filter)**: `npm run ast:query -- outline <FilePath> [--filter <substr>]` (`ast_outline`)
     - **Fuzzy-search symbols across workspace**: `npm run ast:query -- search <Query> [--kind <Kind>]` (`ast_search`)
     - **Compute upstream blast radius before editing**: `npm run ast:query -- blast-radius <SymbolOrFile>` (`ast_blast_radius`)
     - **Trace protocol / route / Terraform lineage**: `npm run ast:query -- lineage <SchemaOrRoute>` (`ast_lineage`)
     - **Find shortest dependency path**: `npm run ast:query -- path <FromSymbol> <ToSymbol>` (`ast_shortest_path`)
   - **Strict Anti-Chunking & Sequential AST-First Mandate**:
     - **NEVER** call `view_file` without `StartLine` and `EndLine` on files larger than 250 lines, and **NEVER** page through large files (`packages/sim/src/engine.ts`, `apps/client/src/main.ts`, `apps/site/src/server.ts`, etc.) in sequential 800-line chunks (`1-800`, `801-1600`, `1601-2400`, ...).
     - **NEVER** fire speculative `view_file` calls in parallel with an `ast:query` command. Run the AST query **first**, read the `=== TARGET SUMMARY (REPEAT FOR TAIL VISIBILITY) ===` block at the bottom of the output for the exact `filePath#L<start>-L<end>`, and then call `view_file` once on that exact surgical line range (`StartLine`–`EndLine`).

2. **Targeted Test Selection (`tests-for`)**:
   - After modifying any file or symbol, run `npm run ast:query -- tests-for <SymbolOrFile>` (or inspect `coveringTests` from `blast-radius`) and execute the linked Vitest suites (`npx vitest run <test-files>`) immediately for fast verification before running full workspace builds.

3. **Keep `.ast-graph/` Synchronized & Git-Ignored**:
   - `.ast-graph/` is automatically maintained by the Antigravity sidecar daemon (`warehouse-ast-sidecar` on `:4319`), the `PostToolUse` lifecycle hook (`.agents/hooks.json` / `.claude/settings.json`), and lazy pre-query `mtime` synchronization.
   - Never commit `.ast-graph/` artifacts (`ast.db`, `export.cypher`, `snapshot.jsonl`, `benchmark-report.json`) to Git.
   - Run `npm run ast:analyze` after structural changes to verify zero circular dependencies and check high-fan-in test coverage.
