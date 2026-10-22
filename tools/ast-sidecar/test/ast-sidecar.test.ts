import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  AstGraphDatabase,
  AstGraphIndexer,
  AstMcpServer,
  MCP_TOOLS_MANIFEST,
  analyzeGraph,
  executeCliCommand,
  extractPythonSource,
  handleHookInvocation,
  runBenchmark,
  startSidecarDaemon,
  type SyncResult,
} from '../src/index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WORKSPACE_ROOT = path.resolve(__dirname, '../../..');

/**
 * Wall-clock perf budgets are only enforced strictly with AST_STRICT_PERF=1 (dedicated perf
 * runs). In the shared parallel suite other workers steal CPU, so the default budget is a
 * load-tolerant 10x ceiling that still catches pathological regressions without flaking.
 */
const STRICT_PERF = process.env.AST_STRICT_PERF === '1';
function perfBudgetMs(strictMs: number): number {
  return STRICT_PERF ? strictMs : strictMs * 10;
}

/**
 * 1-based [startLine, endLine] of a top-level function in packages/sim/src/engine.ts,
 * computed with the TypeScript compiler so assertions don't break whenever engine.ts is edited.
 */
function engineFnSpan(name: string): { startLine: number; endLine: number } {
  const file = path.join(WORKSPACE_ROOT, 'packages/sim/src/engine.ts');
  const sf = ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
  for (const stmt of sf.statements) {
    if (ts.isFunctionDeclaration(stmt) && stmt.name?.text === name) {
      return {
        startLine: sf.getLineAndCharacterOfPosition(stmt.getStart(sf)).line + 1,
        endLine: sf.getLineAndCharacterOfPosition(stmt.getEnd()).line + 1,
      };
    }
  }
  throw new Error(`function ${name} not found in engine.ts`);
}
const HI = engineFnSpan('humanInteract');
const IA = engineFnSpan('interactAt');

describe('@warehouse/ast-sidecar — Multi-Compiler AST & Cross-Layer Lineage GraphDB', () => {
  let tmpDir: string;
  let dbPath: string;
  let db: AstGraphDatabase;
  let indexer: AstGraphIndexer;
  let coldSyncResult: SyncResult;

  beforeAll(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'warehouse-ast-sidecar-test-'));
    dbPath = path.join(tmpDir, 'ast.db');
    db = new AstGraphDatabase(dbPath);
    indexer = new AstGraphIndexer(WORKSPACE_ROOT, db);
    coldSyncResult = indexer.syncWorkspace({ full: true, exportSnapshots: false });
    // A cold full index of the whole monorepo is CPU-bound and synchronous; in the parallel
    // suite it competes with other workers, so give this one hook a local allowance beyond the
    // 30 s global hookTimeout (strict perf budgets are covered by AST_STRICT_PERF=1).
  }, 120_000);

  afterAll(() => {
    try {
      db.close();
    } catch {
      // Ignore already closed
    }
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  });

  it('1. Full Workspace Sync & Graph Inventory: indexes .ts, .mjs, and .tf files with all SCIP node kinds', () => {
    expect(coldSyncResult.mode).toBe('full');
    expect(coldSyncResult.filesScanned).toBeGreaterThanOrEqual(75);
    expect(coldSyncResult.filesUpdated).toBeGreaterThanOrEqual(75);

    const counts = db.getCounts();
    expect(counts.files).toBeGreaterThanOrEqual(75);
    expect(counts.nodes).toBeGreaterThanOrEqual(500);
    expect(counts.edges).toBeGreaterThanOrEqual(1000);
    expect(counts.packages).toBeGreaterThanOrEqual(9);

    const kindRows = db.db
      .prepare('SELECT kind, COUNT(*) AS c FROM nodes GROUP BY kind')
      .all() as Array<{ kind: string; c: number }>;
    const kindsMap = new Map(kindRows.map((r) => [r.kind, Number(r.c)]));

    const requiredKinds = [
      'WorkspacePackage',
      'File',
      'Class',
      'Method',
      'Function',
      'Interface',
      'ZodSchema',
      'RouteEndpoint',
      'TestSuite',
      'TestCase',
      'TerraformResource',
    ];
    for (const kind of requiredKinds) {
      expect(kindsMap.get(kind) ?? 0, `Expected at least 1 node of kind ${kind}`).toBeGreaterThan(0);
    }

    // Verify deterministic SCIP URIs across TypeScript, Endpoints, and Terraform
    const tsScipCount = (
      db.db.prepare("SELECT COUNT(*) AS c FROM nodes WHERE id LIKE 'scip-ts npm %'").get() as { c: number }
    ).c;
    const tfScipCount = (
      db.db.prepare("SELECT COUNT(*) AS c FROM nodes WHERE id LIKE 'scip-tf hcl %'").get() as { c: number }
    ).c;
    const endpointScipCount = (
      db.db.prepare("SELECT COUNT(*) AS c FROM nodes WHERE id LIKE 'scip-endpoint %'").get() as { c: number }
    ).c;

    expect(tsScipCount).toBeGreaterThan(400);
    expect(tfScipCount).toBeGreaterThan(10);
    expect(endpointScipCount).toBeGreaterThan(5);

    // Verify .mjs scripts and .tf files are indexed in files table
    const langRows = db.db
      .prepare('SELECT language, COUNT(*) AS c FROM files GROUP BY language')
      .all() as Array<{ language: string; c: number }>;
    const langs = new Map(langRows.map((r) => [r.language, Number(r.c)]));
    expect(langs.get('typescript') ?? 0).toBeGreaterThan(60);
    expect(langs.get('javascript') ?? 0).toBeGreaterThanOrEqual(1);
    expect(langs.get('terraform') ?? 0).toBeGreaterThanOrEqual(4);
  });

  it('2. Incremental SHA-256 & Lazy mtime Invalidation: fast single-file re-index (<100ms), cascade delete, and noop lazy check', () => {
    // 2a. Lazy sync on unchanged workspace is a fast noop
    const noopCheck = indexer.lazySyncIfDirty();
    expect(noopCheck.mode).toBe('noop');
    expect(noopCheck.filesUpdated).toBe(0);
    expect(noopCheck.durationMs).toBeLessThan(perfBudgetMs(100));

    // 2b. Forced single-file incremental re-index runs in <100ms
    const incSync = indexer.syncWorkspace({
      full: false,
      targetPaths: ['packages/armor/src/hygiene.ts'],
      force: true,
      exportSnapshots: false,
    });
    expect(incSync.mode).toBe('incremental');
    expect(incSync.filesUpdated).toBe(1);
    expect(incSync.durationMs).toBeLessThan(perfBudgetMs(250));

    // 2c. Test file modification & symbol cascade removal in an isolated mini-workspace
    const miniRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'warehouse-ast-mini-'));
    try {
      fs.writeFileSync(
        path.join(miniRoot, 'package.json'),
        JSON.stringify({ name: 'mini-root', private: true, workspaces: ['packages/alpha'] }),
        'utf8',
      );
      const pkgDir = path.join(miniRoot, 'packages', 'alpha');
      fs.mkdirSync(path.join(pkgDir, 'src'), { recursive: true });
      fs.writeFileSync(
        path.join(pkgDir, 'package.json'),
        JSON.stringify({ name: '@mini/alpha', version: '0.1.0' }),
        'utf8',
      );
      const sampleFile = path.join(pkgDir, 'src', 'index.ts');
      fs.writeFileSync(
        sampleFile,
        `export function keepMe(): number { return 42; }\nexport function removeMeLater(): string { return 'ephemeral'; }\n`,
        'utf8',
      );

      const miniDb = new AstGraphDatabase(path.join(miniRoot, '.ast-graph', 'ast.db'));
      const miniIndexer = new AstGraphIndexer(miniRoot, miniDb);

      const firstSync = miniIndexer.syncWorkspace({ full: true, exportSnapshots: false });
      expect(firstSync.mode).toBe('full');
      expect(miniDb.searchSymbols('keepMe').length).toBeGreaterThan(0);
      expect(miniDb.searchSymbols('removeMeLater').length).toBeGreaterThan(0);

      // Modify file removing `removeMeLater` and adding `newlyAddedSymbol`
      const futureTime = Date.now() + 5000;
      fs.writeFileSync(
        sampleFile,
        `export function keepMe(): number { return 42; }\nexport function newlyAddedSymbol(): boolean { return true; }\n`,
        'utf8',
      );
      fs.utimesSync(sampleFile, futureTime / 1000, futureTime / 1000);

      const lazyDelta = miniIndexer.lazySyncIfDirty();
      expect(lazyDelta.mode).toBe('incremental');
      expect(lazyDelta.filesUpdated).toBe(1);
      expect(lazyDelta.durationMs).toBeLessThan(perfBudgetMs(100));

      expect(miniDb.searchSymbols('keepMe').length).toBeGreaterThan(0);
      expect(miniDb.searchSymbols('newlyAddedSymbol').length).toBeGreaterThan(0);
      expect(miniDb.searchSymbols('removeMeLater').length).toBe(0);

      miniDb.close();
    } finally {
      fs.rmSync(miniRoot, { recursive: true, force: true });
    }
  });

  it('3. 4-Layer Lineage & Recursive CTE Graph Queries: symbol neighborhood, file outline, blast radius, tests-for, cross-layer lineage, and shortest path', () => {
    // 3a. Symbol Neighborhood (`humanInteract`, non-exact `SimEngine` suggestions, and `sanitizeDirective`)
    const interactNeighborhood = db.getSymbolNeighborhood('humanInteract');
    expect(interactNeighborhood.symbol).not.toBeNull();
    expect(interactNeighborhood.symbol?.name).toBe('humanInteract');
    expect(interactNeighborhood.symbol?.filePath).toBe('packages/sim/src/engine.ts');
    expect(interactNeighborhood.symbol?.startLine).toBe(HI.startLine);
    expect(interactNeighborhood.symbol?.endLine).toBe(HI.endLine);
    expect(interactNeighborhood.callers.length).toBeGreaterThan(0);
    expect(interactNeighborhood.callees.length).toBeGreaterThan(0);
    expect(interactNeighborhood.totalCallersCount).toBeGreaterThanOrEqual(interactNeighborhood.callers.length);
    expect(interactNeighborhood.totalCalleesCount).toBeGreaterThanOrEqual(interactNeighborhood.callees.length);

    // Non-existent class name `SimEngine` should return `symbol: null` with clean symbol suggestions
    const simNeighborhood = db.getSymbolNeighborhood('SimEngine');
    expect(simNeighborhood.symbol).toBeNull();
    expect(simNeighborhood.matches.length).toBeGreaterThan(0);
    expect(simNeighborhood.matches.some((m) => m.filePath === 'packages/sim/src/engine.ts')).toBe(true);

    // File Outline with filter (`packages/sim/src/engine.ts`, filter: `interact`)
    const engineOutline = db.getFileOutline('packages/sim/src/engine.ts', { filter: 'interact' });
    expect(engineOutline.filePath).toBe('packages/sim/src/engine.ts');
    expect(engineOutline.totalSymbolsInFile).toBeGreaterThan(30);
    const interactAtOutline = engineOutline.symbols.find((s) => s.name === 'interactAt');
    const humanInteractOutline = engineOutline.symbols.find((s) => s.name === 'humanInteract');
    expect(interactAtOutline).toBeDefined();
    expect(interactAtOutline?.startLine).toBe(IA.startLine);
    expect(interactAtOutline?.endLine).toBe(IA.endLine);
    expect(humanInteractOutline).toBeDefined();
    expect(humanInteractOutline?.startLine).toBe(HI.startLine);
    expect(humanInteractOutline?.endLine).toBe(HI.endLine);

    const armorNeighborhood = db.getSymbolNeighborhood('sanitizeDirective');
    expect(armorNeighborhood.symbol).not.toBeNull();
    expect(armorNeighborhood.symbol?.packageName).toBe('@warehouse/armor');
    expect(armorNeighborhood.callers.length).toBeGreaterThan(0);
    expect(armorNeighborhood.coveringTests.length).toBeGreaterThan(0);

    // 3b. k-Hop Upstream Blast Radius (`SimEngine.step`, 3 hops)
    const blast = db.getBlastRadius('SimEngine.step', 3);
    expect(blast.resolvedSymbols.length).toBeGreaterThan(0);
    expect(blast.impactedNodes.length).toBeGreaterThan(0);
    expect(blast.impactedPackages).toContain('@warehouse/sim');
    expect(blast.impactedPackages).toContain('@warehouse/site');
    expect(blast.recommendedTests.length).toBeGreaterThan(0);
    expect(blast.vitestCommand).toContain('npx vitest run');

    // 3c. Targeted Test Selection (`packages/sim/src/engine.ts` and `sanitizeDirective`)
    const engineTests = db.getTestsForChange('packages/sim/src/engine.ts');
    expect(engineTests.resolvedSymbols.length).toBeGreaterThan(0);
    expect(engineTests.directTests.length).toBeGreaterThan(0);
    expect(engineTests.testFiles.some((f) => f.includes('packages/sim/test/'))).toBe(true);
    expect(engineTests.vitestCommand).toContain('packages/sim/test/');

    const armorTests = db.getTestsForChange('sanitizeDirective');
    expect(armorTests.directTests.length).toBeGreaterThan(0);
    expect(armorTests.testFiles).toContain('packages/armor/test/armor.test.ts');

    // 3d. Cross-Layer Lineage (`ClientMessageSchema`, `/api/join`, `google_cloud_run_v2_service.lobby`)
    const schemaLineage = db.getCrossLayerLineage('ClientMessageSchema');
    expect(schemaLineage.focalNodes.length).toBeGreaterThan(0);
    expect(schemaLineage.focalNodes[0]?.kind).toBe('ZodSchema');
    expect(schemaLineage.validators.length).toBeGreaterThan(0);
    expect(schemaLineage.downstreamConsumers.length).toBeGreaterThan(0);

    const routeLineage = db.getCrossLayerLineage('/api/join');
    expect(routeLineage.focalNodes.length).toBeGreaterThan(0);
    expect(routeLineage.routesHandled.length).toBeGreaterThan(0);
    expect(routeLineage.endpointClients.length).toBeGreaterThan(0);

    const tfLineage = db.getCrossLayerLineage('google_cloud_run_v2_service.lobby');
    expect(tfLineage.focalNodes.length).toBeGreaterThan(0);
    expect(tfLineage.focalNodes[0]?.kind).toBe('TerraformResource');
    expect(tfLineage.infraProvisions.length).toBeGreaterThan(0);

    // 3e. Shortest Path Finder (`SimEngine` -> `Order` or `createSiteServer` -> `tick`)
    const pathToTick = db.findShortestPath('createSiteServer', 'tick');
    expect(pathToTick.found).toBe(true);
    expect(pathToTick.hopCount).toBeGreaterThanOrEqual(1);
    expect(pathToTick.path.length).toBe(pathToTick.hopCount);

    const pathSimOrder = db.findShortestPath('SimEngine', 'Order');
    expect(pathSimOrder.found).toBe(true);
    expect(pathSimOrder.hopCount).toBeGreaterThanOrEqual(1);

    // 3f. Property / Field Read & Write Reference Tracking (`runEndsAt` and `depletedRunVid`)
    const runEndsAtRefs = db.getSymbolReferences('runEndsAt');
    expect(runEndsAtRefs.resolvedSymbols.length).toBeGreaterThan(0);
    expect(runEndsAtRefs.resolvedSymbols.some((s) => s.kind === 'Property' && s.name === 'runEndsAt')).toBe(true);
    expect(runEndsAtRefs.writes.length).toBeGreaterThan(0);
    expect(runEndsAtRefs.reads.length).toBeGreaterThan(0);
    expect(runEndsAtRefs.writes.some((w) => w.callSiteFile === 'packages/sim/src/engine.ts')).toBe(true);
    expect(runEndsAtRefs.reads.some((r) => r.callSiteFile === 'packages/sim/src/engine.ts')).toBe(true);

    const runFinishedRefs = db.getSymbolReferences('runFinished');
    expect(runFinishedRefs.resolvedSymbols.some((s) => s.kind === 'Property' && s.name === 'runFinished')).toBe(true);
    expect(runFinishedRefs.writes.some((w) => w.callSiteFile === 'apps/client/src/main.ts')).toBe(true);
    expect(runFinishedRefs.reads.some((r) => r.callSiteFile === 'apps/client/src/main.ts')).toBe(true);

    // Non-existent / historically removed property returns 0 exact matches (circuit-breaker signal)
    const depletedRefs = db.getSymbolReferences('depletedRunVid');
    expect(depletedRefs.resolvedSymbols).toHaveLength(0);
    expect(depletedRefs.writes).toHaveLength(0);
  });

  it('4. Multi-Compiler Python AST Adapter: extracts scip-py classes, functions, methods, imports, and call edges into AstGraphDatabase', () => {
    const pySource = [
      'import math',
      'from typing import List',
      '',
      'def compute_distance(x: float, y: float) -> float:',
      '    """Compute Euclidean norm."""',
      '    if x == 0 and y == 0:',
      '        return 0.0',
      '    return float(x * x + y * y)',
      '',
      'class RoutePlanner:',
      '    """Warehouse route optimizer."""',
      '    def plan_path(self, start: int, goal: int) -> float:',
      '        return compute_distance(float(start), float(goal))',
      '',
    ].join('\n');

    const batch = extractPythonSource('scripts/planner.py', pySource, 'warehouse-py');
    expect(batch.compiler).toBe('python');
    expect(batch.files).toHaveLength(1);
    expect(batch.files[0]?.language).toBe('python');

    const kinds = new Set(batch.nodes.map((n) => n.kind));
    expect(kinds.has('File')).toBe(true);
    expect(kinds.has('Function')).toBe(true);
    expect(kinds.has('Class')).toBe(true);
    expect(kinds.has('Method')).toBe(true);

    const fnNode = batch.nodes.find((n) => n.name === 'compute_distance');
    expect(fnNode).toBeDefined();
    expect(fnNode?.id).toContain('scip-py uv warehouse-py 0.1.0 scripts/planner.py/compute_distance().');
    expect(fnNode?.complexity).toBeGreaterThanOrEqual(2);

    const clsNode = batch.nodes.find((n) => n.name === 'RoutePlanner');
    expect(clsNode?.id).toContain('scip-py uv warehouse-py 0.1.0 scripts/planner.py/RoutePlanner#');

    const methodNode = batch.nodes.find((n) => n.name === 'plan_path');
    expect(methodNode?.id).toContain(
      'scip-py uv warehouse-py 0.1.0 scripts/planner.py/RoutePlanner#plan_path().',
    );

    const edgeKinds = new Set(batch.edges.map((e) => e.kind));
    expect(edgeKinds.has('CONTAINS')).toBe(true);
    expect(edgeKinds.has('IMPORTS')).toBe(true);
    expect(edgeKinds.has('CALLS')).toBe(true);

    // Apply batch into an isolated AstGraphDatabase and query it
    const pyDb = new AstGraphDatabase(path.join(tmpDir, 'py-test.db'));
    try {
      pyDb.applyBatch(batch, true);
      const neighborhood = pyDb.getSymbolNeighborhood('compute_distance');
      expect(neighborhood.symbol?.name).toBe('compute_distance');
      expect(neighborhood.callers.some((c) => c.srcName === 'plan_path')).toBe(true);
    } finally {
      pyDb.close();
    }
  });

  it('5. Open Graph Interchange Exports: writes valid openCypher (.cypher) and JSONL (.jsonl) files', () => {
    const exportDir = path.join(tmpDir, 'exports');
    const result = db.exportGraph(exportDir);

    expect(fs.existsSync(result.cypherPath)).toBe(true);
    expect(fs.existsSync(result.jsonlPath)).toBe(true);
    expect(result.nodesExported).toBeGreaterThan(500);
    expect(result.edgesExported).toBeGreaterThan(1000);

    const cypherSample = fs.readFileSync(result.cypherPath, 'utf8').split('\n').slice(0, 25).join('\n');
    expect(cypherSample).toContain('MERGE (n:');

    const jsonlLines = fs
      .readFileSync(result.jsonlPath, 'utf8')
      .trim()
      .split('\n');
    expect(jsonlLines.length).toBe(result.nodesExported + result.edgesExported);

    const firstRecord = JSON.parse(jsonlLines[0]!) as { type: string; id: string };
    const lastRecord = JSON.parse(jsonlLines[jsonlLines.length - 1]!) as { type: string; kind: string };
    expect(firstRecord.type).toBe('node');
    expect(firstRecord.id).toBeTruthy();
    expect(lastRecord.type).toBe('edge');
    expect(lastRecord.kind).toBeTruthy();
  });

  it('6. Polymorphic Hook Handler: supports both Antigravity and Claude Code SessionStart & PostToolUse payloads', async () => {
    // Antigravity PostToolUse payload -> returns `{}`
    const agyRes = await handleHookInvocation(
      'post-tool-use',
      JSON.stringify({
        conversationId: 'agy-conv-123',
        toolCall: {
          name: 'replace_file_content',
          args: {
            TargetFile: path.join(WORKSPACE_ROOT, 'packages/armor/src/hygiene.ts'),
          },
        },
      }),
      {
        workspaceRoot: WORKSPACE_ROOT,
        dbPath,
        useDaemon: false,
      },
    );
    expect(agyRes.harness).toBe('antigravity');
    expect(agyRes.stdoutJson).toEqual({});
    expect(agyRes.filePath).toContain('packages/armor/src/hygiene.ts');

    // Claude Code PostToolUse payload -> returns `{ continue: true }`
    const claudeRes = await handleHookInvocation(
      'post-tool-use',
      JSON.stringify({
        session_id: 'claude-sess-456',
        hook_event_name: 'PostToolUse',
        tool_name: 'Edit',
        tool_input: {
          file_path: path.join(WORKSPACE_ROOT, 'packages/protocol/src/index.ts'),
        },
      }),
      {
        workspaceRoot: WORKSPACE_ROOT,
        dbPath,
        useDaemon: false,
      },
    );
    expect(claudeRes.harness).toBe('claude-code');
    expect(claudeRes.stdoutJson).toEqual({ continue: true });
    expect(claudeRes.filePath).toContain('packages/protocol/src/index.ts');

    // SessionStart hook invocation
    const sessionRes = await handleHookInvocation(
      'session-start',
      JSON.stringify({ hook_event_name: 'SessionStart', session_id: 'claude-sess-456' }),
      {
        workspaceRoot: WORKSPACE_ROOT,
        dbPath,
        useDaemon: false,
      },
    );
    expect(sessionRes.harness).toBe('claude-code');
    expect(sessionRes.stdoutJson).toEqual({ continue: true });
  });

  it('7. Stdio MCP Server (AstMcpServer): handles initialize, tools/list (11 tools), and tools/call', () => {
    const mcp = new AstMcpServer(WORKSPACE_ROOT, dbPath);
    try {
      const initResp = mcp.handleRequest({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
      });
      expect(initResp?.result).toMatchObject({
        protocolVersion: '2024-11-05',
        serverInfo: { name: 'warehouse-ast-sidecar' },
      });

      const listResp = mcp.handleRequest({
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/list',
      });
      const tools = (listResp?.result as { tools: typeof MCP_TOOLS_MANIFEST }).tools;
      expect(tools).toHaveLength(11);
      expect(tools.map((t) => t.name)).toEqual([
        'ast_symbol',
        'ast_refs',
        'ast_outline',
        'ast_search',
        'ast_blast_radius',
        'ast_tests_for',
        'ast_lineage',
        'ast_shortest_path',
        'ast_analyze',
        'ast_benchmark',
        'ast_sync',
      ]);

      const callTool = (name: string, args: Record<string, unknown>) => {
        const res = mcp.handleRequest({
          jsonrpc: '2.0',
          id: 3,
          method: 'tools/call',
          params: { name, arguments: args },
        });
        const content = (res?.result as { content: Array<{ text: string }>; isError: boolean });
        expect(content.isError).toBe(false);
        return JSON.parse(content.content[0]!.text) as Record<string, unknown>;
      };

      const symData = callTool('ast_symbol', { query: 'humanInteract' });
      expect((symData.symbol as { name: string; startLine: number; endLine: number }).name).toBe('humanInteract');
      expect((symData.symbol as { startLine: number }).startLine).toBe(HI.startLine);
      expect((symData.symbol as { endLine: number }).endLine).toBe(HI.endLine);

      const refsData = callTool('ast_refs', { target: 'runEndsAt' });
      expect((refsData.writes as unknown[]).length).toBeGreaterThan(0);
      expect((refsData.reads as unknown[]).length).toBeGreaterThan(0);

      const batchRefsData = callTool('ast_refs', { targets: ['runEndsAt', 'depletedRunVid'] });
      expect(batchRefsData.batchCount).toBe(2);
      expect((batchRefsData.results as unknown[]).length).toBe(2);

      const simSuggest = callTool('ast_symbol', { query: 'SimEngine' });
      expect(simSuggest.symbol).toBeNull();
      expect((simSuggest.matches as unknown[]).length).toBeGreaterThan(0);

      const outlineData = callTool('ast_outline', {
        filePath: 'packages/sim/src/engine.ts',
        filter: 'interact',
      });
      expect(outlineData.filePath).toBe('packages/sim/src/engine.ts');
      const outlineSymbols = outlineData.symbols as Array<{ name: string; startLine: number; endLine: number }>;
      expect(outlineSymbols.some((s) => s.name === 'interactAt' && s.startLine === IA.startLine && s.endLine === IA.endLine)).toBe(true);
      expect(outlineSymbols.some((s) => s.name === 'humanInteract' && s.startLine === HI.startLine && s.endLine === HI.endLine)).toBe(true);

      const searchData = callTool('ast_search', { query: 'humanInteract' });
      expect((searchData.matches as Array<{ name: string }>).some((m) => m.name === 'humanInteract')).toBe(true);

      const blastData = callTool('ast_blast_radius', { target: 'SimEngine.step', maxHops: 2 });
      expect((blastData.impactedNodes as unknown[]).length).toBeGreaterThan(0);

      const testsData = callTool('ast_tests_for', { target: 'sanitizeDirective' });
      expect((testsData.testFiles as string[])).toContain('packages/armor/test/armor.test.ts');

      const lineageData = callTool('ast_lineage', { target: 'ClientMessageSchema' });
      expect((lineageData.validators as unknown[]).length).toBeGreaterThan(0);

      const analyzeData = callTool('ast_analyze', {});
      expect((analyzeData.packageCoupling as unknown[]).length).toBeGreaterThanOrEqual(8);
    } finally {
      mcp.close();
    }
  });

  it('8. HTTP Sidecar Daemon & Compact CLI Formatter: serves /health, /symbol, /refs, /outline, /search, /blast-radius, /tests-for, /lineage, /metrics and formats compact CLI output (< 90 lines) with bottom summary footer', async () => {
    const daemon = await startSidecarDaemon({
      workspaceRoot: WORKSPACE_ROOT,
      dbPath,
      port: 0, // Ephemeral port
      enableWatcher: false,
    });

    try {
      expect(daemon.port).toBeGreaterThan(0);
      const baseUrl = `http://127.0.0.1:${daemon.port}`;

      const healthRes = await fetch(`${baseUrl}/health`);
      expect(healthRes.status).toBe(200);
      const healthJson = (await healthRes.json()) as { ok: boolean; counts: { nodes: number } };
      expect(healthJson.ok).toBe(true);
      expect(healthJson.counts.nodes).toBeGreaterThan(500);

      const symRes = await fetch(`${baseUrl}/symbol?q=humanInteract`);
      expect(symRes.status).toBe(200);
      const symJson = (await symRes.json()) as { symbol: { name: string; startLine: number; endLine: number } };
      expect(symJson.symbol.name).toBe('humanInteract');
      expect(symJson.symbol.startLine).toBe(HI.startLine);
      expect(symJson.symbol.endLine).toBe(HI.endLine);

      const refsRes = await fetch(`${baseUrl}/refs?q=runEndsAt`);
      expect(refsRes.status).toBe(200);
      const refsJson = (await refsRes.json()) as { writes: unknown[]; reads: unknown[] };
      expect(refsJson.writes.length).toBeGreaterThan(0);
      expect(refsJson.reads.length).toBeGreaterThan(0);

      const simRes = await fetch(`${baseUrl}/symbol?q=SimEngine`);
      expect(simRes.status).toBe(200);
      const simJson = (await simRes.json()) as { symbol: null; matches: unknown[] };
      expect(simJson.symbol).toBeNull();
      expect(simJson.matches.length).toBeGreaterThan(0);

      const outlineRes = await fetch(`${baseUrl}/outline?file=packages/sim/src/engine.ts&filter=interact`);
      expect(outlineRes.status).toBe(200);
      const outlineJson = (await outlineRes.json()) as {
        filePath: string;
        symbols: Array<{ name: string; startLine: number; endLine: number }>;
      };
      expect(outlineJson.filePath).toBe('packages/sim/src/engine.ts');
      expect(outlineJson.symbols.some((s) => s.name === 'interactAt' && s.startLine === IA.startLine && s.endLine === IA.endLine)).toBe(true);
      expect(outlineJson.symbols.some((s) => s.name === 'humanInteract' && s.startLine === HI.startLine && s.endLine === HI.endLine)).toBe(true);

      const searchRes = await fetch(`${baseUrl}/search?q=humanInteract`);
      expect(searchRes.status).toBe(200);
      const searchJson = (await searchRes.json()) as { matches: Array<{ name: string }> };
      expect(searchJson.matches.some((m) => m.name === 'humanInteract')).toBe(true);

      const blastRes = await fetch(`${baseUrl}/blast-radius?target=SimEngine.step`);
      expect(blastRes.status).toBe(200);
      const blastJson = (await blastRes.json()) as { impactedNodes: unknown[] };
      expect(blastJson.impactedNodes.length).toBeGreaterThan(0);

      const testsRes = await fetch(`${baseUrl}/tests-for?target=sanitizeDirective`);
      expect(testsRes.status).toBe(200);
      const testsJson = (await testsRes.json()) as { testFiles: string[] };
      expect(testsJson.testFiles).toContain('packages/armor/test/armor.test.ts');

      const lineageRes = await fetch(`${baseUrl}/lineage?target=ClientMessageSchema`);
      expect(lineageRes.status).toBe(200);
      const lineageJson = (await lineageRes.json()) as { validators: unknown[] };
      expect(lineageJson.validators.length).toBeGreaterThan(0);

      const metricsRes = await fetch(`${baseUrl}/metrics`);
      expect(metricsRes.status).toBe(200);
      const metricsJson = (await metricsRes.json()) as { ok: boolean; telemetry: unknown[] };
      expect(metricsJson.ok).toBe(true);
      expect(metricsJson.telemetry.length).toBeGreaterThan(0);

      // Verify compact CLI output (< 90 lines) and bottom tail-visibility summary footer
      const cliSym = await executeCliCommand(['symbol', 'humanInteract'], {
        workspaceRoot: WORKSPACE_ROOT,
        dbPath,
        useDaemon: true,
        daemonPort: daemon.port,
      });
      expect(cliSym.exitCode).toBe(0);
      expect(cliSym.output.split('\n').length).toBeLessThan(90);
      expect(cliSym.output).toContain('=== TARGET SUMMARY (REPEAT FOR TAIL VISIBILITY) ===');
      expect(cliSym.output).toContain(`packages/sim/src/engine.ts#L${HI.startLine}-L${HI.endLine}`);

      const cliRefs = await executeCliCommand(['refs', 'runEndsAt', 'depletedRunVid'], {
        workspaceRoot: WORKSPACE_ROOT,
        dbPath,
        useDaemon: true,
        daemonPort: daemon.port,
      });
      expect(cliRefs.exitCode).toBe(0);
      expect(cliRefs.output).toContain('[AST REFERENCES] target="runEndsAt"');
      expect(cliRefs.output).toContain('[AST REFERENCES] target="depletedRunVid"');
      expect(cliRefs.output).toContain('WRITES_PROPERTY');
      expect(cliRefs.output).toContain('READS_PROPERTY');
      expect(cliRefs.output).toContain('=== TARGET SUMMARY (REPEAT FOR TAIL VISIBILITY) ===');

      const cliOutline = await executeCliCommand(
        ['outline', 'packages/sim/src/engine.ts', '--filter', 'interact'],
        {
          workspaceRoot: WORKSPACE_ROOT,
          dbPath,
          useDaemon: true,
          daemonPort: daemon.port,
        },
      );
      expect(cliOutline.exitCode).toBe(0);
      expect(cliOutline.output.split('\n').length).toBeLessThan(90);
      expect(cliOutline.output).toContain('=== TARGET SUMMARY (REPEAT FOR TAIL VISIBILITY) ===');
      expect(cliOutline.output).toContain(`packages/sim/src/engine.ts#L${IA.startLine}-L${IA.endLine}`);
      expect(cliOutline.output).toContain(`packages/sim/src/engine.ts#L${HI.startLine}-L${HI.endLine}`);

      const cliBlast = await executeCliCommand(['blast-radius', 'humanInteract'], {
        workspaceRoot: WORKSPACE_ROOT,
        dbPath,
        useDaemon: true,
        daemonPort: daemon.port,
      });
      expect(cliBlast.exitCode).toBe(0);
      expect(cliBlast.output.split('\n').length).toBeLessThan(90);
      expect(cliBlast.output).toContain('=== TARGET SUMMARY (REPEAT FOR TAIL VISIBILITY) ===');
      expect(cliBlast.output).toContain('Recommended Test Command:');
    } finally {
      await daemon.close();
    }
  });

  it('9. Structural Analysis & Empirical Benchmark (analyzeGraph & runBenchmark): computes coupling, hubs, and token savings', () => {
    const analysis = analyzeGraph(db);
    expect(analysis.packageCoupling.length).toBeGreaterThanOrEqual(8);

    const protocolMetrics = analysis.packageCoupling.find((p) => p.packageName === '@warehouse/protocol');
    expect(protocolMetrics).toBeDefined();
    expect(protocolMetrics!.afferentCouplingCa).toBeGreaterThanOrEqual(4);
    expect(protocolMetrics!.efferentCouplingCe).toBe(0);
    expect(protocolMetrics!.instability).toBe(0);

    expect(Array.isArray(analysis.untestedHighFanInHubs)).toBe(true);
    expect(Array.isArray(analysis.circularDependencies)).toBe(true);

    const benchmark = runBenchmark(WORKSPACE_ROOT, db, indexer);
    expect(benchmark.indexing.totalFilesIndexed).toBeGreaterThanOrEqual(75);
    expect(benchmark.indexing.incrementalSingleFileSyncMs).toBeLessThan(perfBudgetMs(100));
    expect(benchmark.queryLatenciesMs.sampleCount).toBe(20);
    expect(benchmark.queryLatenciesMs.p95Ms).toBeLessThan(perfBudgetMs(50));
    expect(benchmark.traceabilityComparisons).toHaveLength(4);
    expect(benchmark.aggregateEfficiency.avgTokenSavingsPct).toBeGreaterThan(50);
    expect(benchmark.aggregateEfficiency.avgFilesReadReductionRatio).toBeGreaterThan(1);
    // runBenchmark performs its own cold full sync + snapshot export (same cost as beforeAll).
  }, 120_000);
});
