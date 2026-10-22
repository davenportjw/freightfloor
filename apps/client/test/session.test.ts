import { describe, expect, it, vi } from 'vitest';
import { A2uiScreenMessageSchema } from '@warehouse/protocol';
import { AGENT_COMMAND_TIMEOUT_MS, ClientStore } from '../src/state.js';
import { recommendedSourceLabel } from '../src/ui/a2ui.js';
import { createInteractHold } from '../src/ui/touchControls.js';

describe('ClientStore session hygiene', () => {
  it('resetForNewSession drops the old session view state (and per-site data on a site change)', () => {
    const store = new ClientStore();
    store.ui.feedNotes = [{ text: 'old', tone: 'info', at: 1 }] as typeof store.ui.feedNotes;
    store.ui.alert = { kind: 'error', text: 'stale', until: Date.now() + 10_000 } as unknown as typeof store.ui.alert;
    store.ui.orderNote = { text: 'old order', until: Date.now() + 10_000 };
    store.ui.followVid = 'FL-09';
    store.ui.dispatchOpen = true;
    store.coneMode = true;
    store.markAgentCommandPending(Date.now());
    store.brainHealth = { ok: true } as unknown as typeof store.brainHealth;
    const listener = vi.fn();
    store.subscribe(listener);

    store.resetForNewSession(false);
    expect(store.ui.feedNotes).toEqual([]);
    expect(store.ui.alert).toBeNull();
    expect(store.ui.orderNote).toBeNull();
    expect(store.ui.followVid).toBeNull();
    expect(store.ui.dispatchOpen).toBe(false);
    expect(store.coneMode).toBe(false);
    expect(store.ui.agentCommandPending).toBe(false);
    expect(store.activeA2ui).toBeNull();
    expect(store.dispatchersCall).toBeNull();
    expect(store.brainHealth).not.toBeNull(); // same site: keep per-site data
    expect(listener).toHaveBeenCalled();

    store.resetForNewSession(true);
    expect(store.brainHealth).toBeNull();
    expect(store.phaseInfo).toBeNull();
  });

  it('agentCommandPending expires after AGENT_COMMAND_TIMEOUT_MS instead of sticking', () => {
    const store = new ClientStore();
    store.markAgentCommandPending(1_000);
    expect(store.expireAgentCommandPending(1_000 + AGENT_COMMAND_TIMEOUT_MS - 1)).toBe(false);
    expect(store.ui.agentCommandPending).toBe(true);
    expect(store.expireAgentCommandPending(1_000 + AGENT_COMMAND_TIMEOUT_MS)).toBe(true);
    expect(store.ui.agentCommandPending).toBe(false);
    expect(store.expireAgentCommandPending(1_000_000)).toBe(false); // nothing pending: no repeat notice
  });

  it('clearAgentCommandPending reports whether something was pending', () => {
    const store = new ClientStore();
    expect(store.clearAgentCommandPending()).toBe(false);
    store.markAgentCommandPending(0);
    expect(store.clearAgentCommandPending()).toBe(true);
  });

  it('the top layer follows the store (results closes nothing by itself; modals suspend sheets)', () => {
    const store = new ClientStore();
    store.ui.helpOpen = false;
    expect(store.topLayer()).toBeNull();
    store.ui.leaderboardModalOpen = true;
    expect(store.topLayer()).toBe('leaderboard');
    store.ui.helpOpen = true;
    expect(store.topLayer()).toBe('intro');
  });
});

describe('touch Interact hold', () => {
  it('release() sends interactUp once (hide path), and is a no-op when not held', () => {
    const actions = { interact: vi.fn(), interactDown: vi.fn(), interactUp: vi.fn() };
    const hold = createInteractHold(actions);
    hold.release();
    expect(actions.interactUp).not.toHaveBeenCalled();
    hold.down();
    expect(actions.interactDown).toHaveBeenCalledTimes(1);
    expect(hold.held).toBe(true);
    hold.release(); // controls hidden mid-hold
    hold.release(); // the late pointerup / lostpointercapture
    expect(actions.interactUp).toHaveBeenCalledTimes(1);
    expect(hold.held).toBe(false);
  });

  it('falls back to interact() without interactDown', () => {
    const actions = { interact: vi.fn() };
    const hold = createInteractHold(actions);
    hold.down();
    expect(actions.interact).toHaveBeenCalledTimes(1);
    hold.release();
  });
});

describe('A2UI recommendedSource attribution', () => {
  it('labels model vs keyword-match drafts honestly and shows nothing when absent', () => {
    expect(recommendedSourceLabel('model')).toBe('Suggested by Gemini');
    expect(recommendedSourceLabel('heuristic')).toBe('Pre-filled from your words (keyword match)');
    expect(recommendedSourceLabel(undefined)).toBeNull();
  });

  it('protocol: recommendedSource is optional and restricted to model | heuristic', () => {
    const screen = {
      type: 'a2uiScreen',
      screenId: 's1',
      title: 'Clarify',
      subtitle: 'Pick a dispatch',
      telemetry: [],
      selectors: [],
      presets: [],
      recommendedDispatch: { sourceZone: 'haz', targetBay: 'RET', priority: 'p0', mode: 'reroute_and_spawn', count: 2 },
    };
    expect(A2uiScreenMessageSchema.safeParse(screen).success).toBe(true);
    expect(A2uiScreenMessageSchema.safeParse({ ...screen, recommendedSource: 'model' }).success).toBe(true);
    expect(A2uiScreenMessageSchema.safeParse({ ...screen, recommendedSource: 'heuristic' }).success).toBe(true);
    expect(A2uiScreenMessageSchema.safeParse({ ...screen, recommendedSource: 'gemini' }).success).toBe(false);
  });
});
