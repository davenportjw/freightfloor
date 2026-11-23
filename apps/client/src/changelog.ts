/**
 * "What's new" changelog shown in the intro modal (`#help` → ✨ What's new) and linked from
 * ☰ → Game → What's new.
 *
 * Curated by hand from `git log`: only player-visible features, improvements and bug fixes land
 * here (no infra, cost, SEO, analytics or tooling commits). Run `npm run changelog:draft` to list
 * feat / fix / perf commits newer than the top release below, then rewrite them in player terms.
 *
 * Every item cites the commit(s) it came from so the copy stays traceable to real changes.
 */
import type { StorageLike } from './ui/panel.js';

export const CHANGELOG_SEEN_KEY = 'warehouse.changelog.seen';

export type ChangeKind = 'new' | 'improved' | 'fixed';

export interface ChangelogItem {
  kind: ChangeKind;
  title: string;
  body: string;
  /** Short SHAs of the source commits. */
  commits: readonly string[];
  /** Shipped in the engine but not reachable from the game UI yet. */
  soon?: boolean;
}

export interface ChangelogRelease {
  /** ISO date (YYYY-MM-DD); doubles as the release id for the "seen" marker. */
  date: string;
  title: string;
  items: readonly ChangelogItem[];
}

/** Newest first. */
export const CHANGELOG: readonly ChangelogRelease[] = [
  {
    date: '2026-11-22',
    title: 'Bring Your Own Agent (BYO Forklift SDK)',
    items: [
      {
        kind: 'new',
        title: 'Connect your own AI agent to drive a forklift',
        body: 'Developers can now mint a personal agent key, connect over WebSocket via @warehouse/agent-sdk, and drive a live forklift on their own compute and LLM budget (Gemini, Claude, OpenAI, Ollama, or pure heuristics). Visit /agents.html from the intro screen to get started in 2 minutes.',
        commits: ['b137356', 'c58966c'],
      },
      {
        kind: 'new',
        title: 'Dedicated Agent League leaderboard & seat caps',
        body: 'External agents compete on their own Agent League leaderboard (/api/agents/leaderboard) so human standings stay pure. Each key is limited to 1 active forklift (capped at 4 external agents per site), and server-side LLM commands are disabled for external agents.',
        commits: ['b137356'],
      },
      {
        kind: 'improved',
        title: 'Local 10 Hz steering & obstacle avoidance in the SDK',
        body: 'The open-source PilotLoop runs smooth moveAngle steering and forklift collision avoidance locally at 10 Hz while calling your async decide() callback at your own pace.',
        commits: ['c58966c'],
      },
    ],
  },
  {
    date: '2026-11-17',
    title: 'Floor Trials: Challenges & ghosts',
    items: [
      {
        kind: 'new',
        title: 'Twelve Floor Trials challenges',
        body: 'Levels 7–18 add one twist at a time: stow inbound pallets into rack slots, sort cross-dock freight, carry glass that shatters and heavy pallets that must ride low, weave through cone mazes, plan a charger stop on a thin battery, beat timed dock doors, dodge forklift traffic and drive with only your headlights. Night Shift throws it all at you at once.',
        commits: ['f33be31', '0c25f04'],
      },
      {
        kind: 'new',
        title: 'Ghost runs in Floor Trials',
        body: "Race other players' runs. Translucent ghost trucks drive each level with you: World #1 (the fastest run, with its route and lift stops painted on the floor), the run just faster than your best, and your own best. Clear a level faster than before and your run is shared under your callsign. Press G to switch ghosts or hide them.",
        commits: ['1830788', 'eecf89c', 'a8d1d9d'],
      },
      {
        kind: 'fixed',
        title: 'Smoother motion across the floor',
        body: 'Conveyor totes roll steadily down each belt instead of stuttering tile to tile, and dock trucks glide at an even pace. Forks rise and lower smoothly on every forklift, your truck no longer jumps when Co-Pilot takes over or hands back control, and floating labels, callouts and incident markers ease and fade instead of snapping. The camera glides over when you start driving or follow a truck, Floor Trials ghost trails no longer shimmer, and the flashing lights in Cab View are calmer too.',
        commits: ['f13201b', '76bf05e'],
      },
      {
        kind: 'improved',
        title: 'Floor Trials level list',
        body: 'The level rail is now split into Getting started and Challenges, and each challenge card shows tags for its twists.',
        commits: ['0c25f04'],
      },
    ],
  },
  {
    date: '2026-11-16',
    title: 'Floor Trials',
    items: [
      {
        kind: 'new',
        title: 'Floor Trials',
        body: 'Six solo precision challenges at /trials.html (open ★ Floor Trials on the intro or from the ☰ menu). Stack up to three pallets high, manage load sway around corners and over spills, dodge collapsing racks, and beat par times for ★★★.',
        commits: ['945e3a5', 'f03cfa4', '029bda9'],
      },
      {
        kind: 'improved',
        title: 'Calibrated AI confidence',
        body: 'Click any AI forklift to see calibrated confidence scores alongside its live move choices.',
        commits: ['61752a8'],
      },
      {
        kind: 'fixed',
        title: 'One-press pickups in Lift Mode',
        body: 'Tapping E at an upper rack shelf no longer needs a second press. Tap E for a standard grab (no bonus, no penalty); hold E and release in the sweet spot for a Perfect Lift bonus. Same in Cab View.',
        commits: ['cb44870'],
      },
    ],
  },
  {
    date: '2026-11-12',
    title: 'Daily Shift',
    items: [
      {
        kind: 'new',
        title: 'Daily Shift',
        body: 'One shared 3-minute run per day (resets 00:00 UTC). Everyone gets the same three contracts plus a modifier that rotates daily: Cold Chain Day, Long Haul, Express Freight, Clean Shift, Heavy Load, Combo Day or Eco Run. Pick "Play the Daily" on the intro, 📅 Daily on the contract sheet, or from the results screen. Unlimited attempts; your best run counts.',
        commits: ['767fbb5'],
      },
      {
        kind: 'new',
        title: 'Daily leaderboard',
        body: 'Every Daily run is ranked against all drivers across every warehouse. See the leader on the intro and your rank, the top 5 and your run tape (🟩 on-time, 🟨 late, 🟥 incident) on the results screen.',
        commits: ['767fbb5'],
      },
    ],
  },
  {
    date: '2026-11-11',
    title: 'Graphics upgrade',
    items: [
      {
        kind: 'improved',
        title: 'Real wheels, sharper forklifts',
        body: 'Every vehicle now rolls on round wheels that spin and steer as you drive, with team trim, hazard bumpers, headlights and twin mast rails. Reach trucks and AGVs get their own wheel layouts.',
        commits: ['e4c375a'],
      },
      {
        kind: 'improved',
        title: 'One look in every camera',
        body: 'Pallets, conveyors, chargers, cones and dock trucks share a single model across Fixed Floor, Forklift Up and Cab View, with soft ground shadows. No more flattened cartons in Forklift Up.',
        commits: ['e4c375a'],
      },
      {
        kind: 'improved',
        title: 'Faster frames',
        body: 'Off-screen pallets, chargers and vehicles are skipped and far-zoom detail is simplified, so the new graphics run faster than the old ones.',
        commits: ['8914c39'],
      },
      {
        kind: 'improved',
        title: 'Cab View shadows and braking',
        body: 'Real sun shadows in Cab View, a see-through hood outline, and the forklift nose dips when you brake. The ghost path is now painted on the floor under your truck.',
        commits: ['cb58ad5'],
      },
    ],
  },
  {
    date: '2026-10-28',
    title: 'Cab View',
    items: [
      {
        kind: 'new',
        title: 'Cab View',
        body: 'Drive from the forklift seat in first person. Press P or use ☰ → View.',
        commits: ['bb5eba4'],
      },
      {
        kind: 'improved',
        title: 'Steadier steering',
        body: 'Your inputs are timed on your device and replayed on the server, which removes the steering wobble.',
        commits: ['bb5eba4'],
      },
      {
        kind: 'improved',
        title: 'Forklift Up camera looks ahead',
        body: 'In Forklift Up (R) your truck sits low on screen so you see more of the aisle in front of you.',
        commits: ['5bcd31b'],
      },
      {
        kind: 'fixed',
        title: 'Smoother rival forklifts',
        body: 'Other vehicles no longer surge and stall when network packets arrive unevenly.',
        commits: ['59b0a5d'],
      },
      {
        kind: 'fixed',
        title: 'Telescoping mast',
        body: 'The mast is short when the forks are down and extends as they rise.',
        commits: ['7330f9e'],
      },
    ],
  },
  {
    date: '2026-10-26',
    title: 'Lift Mode',
    items: [
      {
        kind: 'new',
        title: 'Lift Mode',
        body: 'An optional mode where you raise the forks to Low, Mid or High rack shelves. Turn it on from the intro page or ☰ → Settings.',
        commits: ['1801973'],
      },
      {
        kind: 'fixed',
        title: 'Blitz scoring',
        body: 'The Blitz pace count is consistent, and combos and streaks reset when a shift ends.',
        commits: ['5c9610e'],
      },
    ],
  },
  {
    date: '2026-10-24',
    title: 'Mobile & motion fixes',
    items: [
      {
        kind: 'fixed',
        title: 'Touch controls on the intro',
        body: 'Phones and tablets now see the joystick and touch controls instead of keyboard keys.',
        commits: ['d7bd57a'],
      },
      {
        kind: 'fixed',
        title: 'Smoother motion',
        body: 'Carried pallets no longer blink and 60 Hz motion is smooth. Boost and battery are clearer on the HUD.',
        commits: ['5bbb006'],
      },
      {
        kind: 'fixed',
        title: 'No more iOS double-tap',
        body: 'Buttons on the intro and HUD respond to a single tap in iOS Safari.',
        commits: ['5e17640'],
      },
      {
        kind: 'fixed',
        title: 'One callsign per browser',
        body: 'Each browser keeps its own assigned callsign.',
        commits: ['ccc1e31'],
      },
    ],
  },
  {
    date: '2026-10-21',
    title: 'HUD v3',
    items: [
      {
        kind: 'new',
        title: 'New HUD',
        body: 'Floating cards for Drive and Floor modes, the ☰ menu, and callsign lookup.',
        commits: ['8bc51d6'],
      },
      {
        kind: 'fixed',
        title: 'Blitz clock waits for you',
        body: 'The 3-minute clock starts on your first move, not while you are still reading the intro.',
        commits: ['684704a'],
      },
    ],
  },
];

export const CHANGE_KIND_LABEL: Record<ChangeKind, string> = {
  new: 'New',
  improved: 'Improved',
  fixed: 'Fixed',
};

export function latestReleaseId(log: readonly ChangelogRelease[] = CHANGELOG): string | null {
  return log[0]?.date ?? null;
}

/** True when the newest release is newer than the one the player last opened. */
export function hasUnseenChanges(storage: StorageLike | null | undefined, log: readonly ChangelogRelease[] = CHANGELOG): boolean {
  const latest = latestReleaseId(log);
  if (!latest) return false;
  try {
    const seen = storage?.getItem(CHANGELOG_SEEN_KEY) ?? null;
    return seen === null || seen < latest;
  } catch {
    return false;
  }
}

export function markChangelogSeen(storage: StorageLike | null | undefined, log: readonly ChangelogRelease[] = CHANGELOG): void {
  const latest = latestReleaseId(log);
  if (!latest) return;
  try {
    storage?.setItem(CHANGELOG_SEEN_KEY, latest);
  } catch {
    /* storage unavailable (private mode): the NEW dot simply shows again next time */
  }
}

/** `localStorage` when available (null in private mode / tests). */
export function browserStorage(): StorageLike | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

/** "Nov 11, 2026" from an ISO date, independent of the viewer's time zone. */
export function formatReleaseDate(iso: string): string {
  const [y, m, d] = iso.split('-').map(Number);
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${months[(m ?? 1) - 1]} ${d}, ${y}`;
}
