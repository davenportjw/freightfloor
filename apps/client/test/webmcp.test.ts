import { afterEach, describe, expect, it, vi } from 'vitest';
import { registerWebMcpTools, webMcpTools } from '../src/webmcp.js';

describe('WebMCP tools', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('exposes read-only tools with JSON Schema inputs', async () => {
    const tools = webMcpTools();
    expect(tools.map((t) => t.name)).toEqual([
      'get_warehouse_network',
      'get_daily_shift_leaderboard',
      'get_how_to_play',
    ]);
    for (const t of tools) {
      expect(t.inputSchema.type).toBe('object');
      expect(t.annotations?.readOnlyHint).toBe(true);
    }
    const howTo = (await tools[2]!.execute({})) as { content: Array<{ text: string }> };
    expect(howTo.content[0]!.text).toContain('WASD');
  });

  it('registers on document.modelContext (falling back to navigator) and no-ops without it', () => {
    const registerTool = vi.fn(async () => {});
    vi.stubGlobal('document', { modelContext: { registerTool } });
    vi.stubGlobal('navigator', {});
    const controller = registerWebMcpTools();
    expect(controller).toBeInstanceOf(AbortController);
    expect(registerTool).toHaveBeenCalledTimes(3);
    expect(registerTool.mock.calls[0]![1]).toEqual({ signal: controller!.signal });

    const navRegister = vi.fn();
    vi.stubGlobal('document', {});
    vi.stubGlobal('navigator', { modelContext: { registerTool: navRegister } });
    expect(registerWebMcpTools()).not.toBeNull();
    expect(navRegister).toHaveBeenCalledTimes(3);

    vi.stubGlobal('navigator', {});
    expect(registerWebMcpTools()).toBeNull();
  });
});
