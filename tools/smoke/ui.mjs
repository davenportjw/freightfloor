#!/usr/bin/env node
/**
 * UI smoke test against a live lobby (docs/operations.md § UI smoke).
 *
 *   node tools/smoke/ui.mjs https://warehouse-lobby-...run.app [outDir]
 *
 * Drives the real client in headless system Chrome (playwright-core, no bundled browser) and
 * verifies the HUD v3 contract end to end against real server data, following the real join flow:
 * a joining player is seated as a driver when the site has room (contract pick sheet → Drive HUD →
 * Run complete → "Watch the floor" → Floor view → F drives again); when the site is at its driver
 * cap the join lands in the Floor view and the floor checks run first.
 *   - Intro opens on boot (How to play / The AI inside) and re-opens from the ☰ menu
 *   - pick sheet: Esc minimises it and leaves ☰ usable; "contracts waiting" reopens it; ↵ starts
 *   - Drive HUD: driving 3 s moves the vehicle (server acks) and changes the capsule/dash readout;
 *     exactly the 5 drive elements; no overlapping cards and ≤15% floor coverage at 1600x900 and
 *     1280x760 (steady state: measured after a transient order-choice card resolves); hold-Tab
 *     Standings with the difficulty vote; Enter chat; HUD Minimal (V) persists across reload; the
 *     history drawer opens and every tab renders; Cab View (P) shows the first-person canvas, still
 *     drives (server acks) and P returns to iso
 *   - Run complete sheet (timer end) → Watch the floor
 *   - Floor view: KPI clock "Day N · HH:MM · Shift X" (no duplicated day), Floor orders bar present
 *     with every disabled order explaining why, no overlapping HUD cards; Team Standings (B) and
 *     Value change within 60 s; ☰ lists every flyout; a ★ P0 order updates the server floorOrders
 *     state; Dispatch drawer (4); Cone mode (3); F → Drive HUD
 *   - quiet notifications: no visible .toast in either mode; Drive shows at most 1 alert line,
 *     Floor at most 3 feed cards (the alert line, feed and order line are in the overlap check)
 *   - screenshots at 1600x1000, 1600x900 and 1280x760 (Floor view, Team Standings and the Dispatch
 *     drawer are also overlap-checked and captured at 1280x760)
 *   - no console errors / page errors
 *   - on any failure, diag.json (console messages + WebSocket open/close/frame types, tickets
 *     redacted, plus the visible state if Play again stalls) is written next to the screenshots
 * Uses a `smoke-ui-*` clientId (cleanupSmokePlayers removes smoke-* player docs) and always
 * closes the browser (and therefore its WebSocket) on exit. Set SMOKE_SKIP_FIRESTORE=1 for a local
 * in-memory stack. RUN_END_WAIT_MS (default 360000) bounds the wait for the 5-minute Blitz to end.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { chromium } from 'playwright-core';

const lobbyUrl = (process.argv[2] || process.env.LOBBY_URL || '').replace(/\/$/, '');
if (!lobbyUrl) {
  console.error('usage: node tools/smoke/ui.mjs <LOBBY_URL> [outDir]');
  process.exit(2);
}
const outDir = resolve(process.argv[3] || process.env.UI_SMOKE_OUT || 'tools/smoke/out');
mkdirSync(outDir, { recursive: true });
const chromePath =
  process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const runEndWaitMs = Number(process.env.RUN_END_WAIT_MS || 360_000);
// `smoke-` names join as bots (reserved prefix), and any stats doc the site writes is keyed by
// clientId — so also mark the clientId, letting cleanupSmokePlayers match by id as well as name.
// Bot sessions receive no run telemetry (runPts / runFinished are human-only on the site), so the
// Blitz results sheet never appears for them: set SMOKE_DISPLAY_NAME to a non-reserved name (e.g.
// `uitest-1`) to exercise run end → "Watch the floor"; cleanup still matches the smoke-ui-* clientId.
const displayName = process.env.SMOKE_DISPLAY_NAME || `uitest-${Math.random().toString(36).slice(2, 8)}`;
const smokeClientId = `smoke-ui-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
}

// Extra Chrome flags, space-separated — e.g. CHROME_ARGS="--disable-features=AsyncDns" makes Chrome
// use the OS resolver on hosts where its built-in DNS client intermittently fails.
const chromeArgs = (process.env.CHROME_ARGS || '').split(/\s+/).filter(Boolean);
const browser = await chromium.launch({ executablePath: chromePath, headless: true, args: chromeArgs });
const consoleErrors = [];
const acks = [];
/** Latest `floorOrders` seen on the WebSocket (welcome / delta), straight from the server. */
let lastFloorOrders = null;
/** Rolling console + WebSocket event log, written to `diag.json` in outDir when any check fails. */
const diagLog = [];
function diag(kind, detail) {
  const last = diagLog[diagLog.length - 1];
  if (last && last.kind === kind && last.detail === detail) {
    last.n = (last.n ?? 1) + 1;
    last.until = new Date().toISOString();
    return;
  }
  diagLog.push({ t: new Date().toISOString(), kind, detail });
  if (diagLog.length > 400) diagLog.shift();
}
/** Message type of a WS frame (`{"type":"delta",…}` → `delta`), never the payload itself. */
function frameType(payload) {
  const m = /^\{"type":"([^"]+)"/.exec(String(payload));
  return m ? m[1] : `${String(payload).length}B`;
}
try {
  const context = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
  // Pre-seed display name, a smoke- clientId ('warehouse_client_id', see apps/client/src/main.ts
  // CLIENT_ID_KEY) and 'warehouse.help.seen'='1' to verify the Intro Page still opens on
  // subsequent visits too.
  await context.addInitScript(([name, cid]) => {
    if (!localStorage.getItem('warehouse_display_name')) localStorage.setItem('warehouse_display_name', name);
    if (!localStorage.getItem('warehouse_client_id')) localStorage.setItem('warehouse_client_id', cid);
    localStorage.setItem('warehouse.help.seen', '1');
  }, [displayName, smokeClientId]);
  const page = await context.newPage();
  page.on('console', (m) => {
    if (m.type() === 'error') consoleErrors.push(m.text());
    diag(`console.${m.type()}`, m.text().slice(0, 300));
  });
  page.on('pageerror', (e) => {
    consoleErrors.push(String(e));
    diag('pageerror', String(e).slice(0, 300));
  });
  page.on('websocket', (ws) => {
    diag('ws.open', ws.url().replace(/([?&](ticket|t)=)[^&]+/g, '$1…'));
    ws.on('close', () => diag('ws.close', ws.url().split('?')[0]));
    ws.on('socketerror', (e) => diag('ws.error', String(e)));
    // Per-tick input / ack frames are too chatty for the rolling log; everything else is kept.
    ws.on('framesent', (f) => frameType(f.payload) !== 'input' && diag('ws.sent', frameType(f.payload)));
    ws.on('framereceived', (f) => {
      const s = String(f.payload);
      if (frameType(s) !== 'ack') diag('ws.recv', frameType(s));
      if (s.startsWith('{"type":"ack"')) {
        try {
          acks.push(JSON.parse(s));
        } catch {
          /* non-JSON frame */
        }
        return;
      }
      if (!s.includes('"floorOrders"')) return;
      try {
        const m = JSON.parse(s);
        if (m.floorOrders) lastFloorOrders = m.floorOrders;
      } catch {
        /* non-JSON frame */
      }
    });
  });

  /** Visible HUD cards (top-stack children instead of the stack itself). */
  const HUD_CARDS = ['#menuBtn', '#githubBtn', '#brandBadge', '#run', '#objective', '#fare', '#alert', '#reloc', '#contracts', '#dash', '#kpis', '#floorBanner', '#inspector', '#feed', '#orders', '#dispatchPop', '#coneHint', '#orderNote', '#chat'];
  const hudGeometry = () =>
    page.evaluate((sels) => {
      const rects = [];
      for (const s of sels) {
        const e = document.querySelector(s);
        // HUD cards are position:fixed (offsetParent is always null), so use checkVisibility().
        if (!e || e.hidden || !e.checkVisibility()) continue;
        const r = e.getBoundingClientRect();
        if (r.width < 2 || r.height < 2) continue;
        rects.push({ s, l: r.left, t: r.top, r: r.right, b: r.bottom });
      }
      const overlaps = [];
      for (let i = 0; i < rects.length; i++)
        for (let j = i + 1; j < rects.length; j++) {
          const a = rects[i];
          const b = rects[j];
          if (Math.min(a.r, b.r) - Math.max(a.l, b.l) > 1 && Math.min(a.b, b.b) - Math.max(a.t, b.t) > 1) overlaps.push(`${a.s}×${b.s}`);
        }
      // Union coverage by 4px sampling (overlaps counted once).
      const W = innerWidth;
      const H = innerHeight;
      let hit = 0;
      let n = 0;
      for (let y = 2; y < H; y += 4)
        for (let x = 2; x < W; x += 4) {
          n++;
          if (rects.some((q) => x >= q.l && x < q.r && y >= q.t && y < q.b)) hit++;
        }
      return { visible: rects.map((q) => q.s), overlaps, coverage: n ? hit / n : 0 };
    }, HUD_CARDS);
  const isShown = (sel) => page.locator(sel).isVisible().catch(() => false);
  async function githubBtnCheck(label) {
    const info = await page.evaluate(() => {
      const btn = document.querySelector('#githubBtn');
      if (!btn || btn.hidden || !btn.checkVisibility()) {
        return { visible: false, href: '', overlaps: [] };
      }
      const r = btn.getBoundingClientRect();
      const visible = r.width >= 2 && r.height >= 2;
      const href = btn.getAttribute('href') || '';
      const overlaps = [];
      for (const s of ['#menuBtn', '#brandBadge', '#run', '#kpis']) {
        const other = document.querySelector(s);
        if (!other || other.hidden || !other.checkVisibility()) continue;
        const o = other.getBoundingClientRect();
        if (o.width < 2 || o.height < 2) continue;
        if (Math.min(r.right, o.right) - Math.max(r.left, o.left) > 1 && Math.min(r.bottom, o.bottom) - Math.max(r.top, o.top) > 1) {
          overlaps.push(`#githubBtn×${s}`);
        }
      }
      const badge = document.querySelector('#brandBadge');
      if (badge && !badge.hidden && badge.checkVisibility()) {
        const br = badge.getBoundingClientRect();
        for (const s of ['#menuBtn', '#githubBtn', '#run', '#kpis', '#floorBanner']) {
          const other = document.querySelector(s);
          if (!other || other.hidden || !other.checkVisibility()) continue;
          const o = other.getBoundingClientRect();
          if (o.width < 2 || o.height < 2) continue;
          if (Math.min(br.right, o.right) - Math.max(br.left, o.left) > 1 && Math.min(br.bottom, o.bottom) - Math.max(br.top, o.top) > 1) {
            overlaps.push(`#brandBadge×${s}`);
          }
        }
      }
      return { visible, href, overlaps };
    });
    check(
      `#githubBtn visible with repo href and no overlap (${label})`,
      info.visible && info.href === 'https://github.com/davenportjw/freightfloor' && info.overlaps.length === 0,
      `visible=${info.visible} href=${info.href} overlaps=${info.overlaps.join(' ') || 'none'}`,
    );
  }
  async function buttonChromeCheck(label) {
    const violations = await page.evaluate(() => {
      const bad = [];
      for (const btn of document.querySelectorAll('button')) {
        if (btn.hidden || !btn.checkVisibility()) continue;
        const r = btn.getBoundingClientRect();
        if (r.width < 2 || r.height < 2) continue;
        const cs = getComputedStyle(btn);
        const hasBg = cs.backgroundColor !== 'rgba(0, 0, 0, 0)' && cs.backgroundColor !== 'transparent';
        const hasBorder = parseFloat(cs.borderTopWidth) > 0;
        const hasUnderline = cs.textDecorationLine.includes('underline');
        const isOutset = cs.borderTopStyle === 'outset' || cs.borderTopStyle === 'inset';
        if ((hasBg || hasBorder) && hasUnderline) {
          bad.push(`${btn.className || btn.tagName}:underline-on-pill`);
        }
        if (isOutset) {
          bad.push(`${btn.className || btn.tagName}:native-outset-border`);
        }
      }
      return bad;
    });
    check(
      `visible buttons have clean pill/button chrome with no underline or native bevel (${label})`,
      violations.length === 0,
      violations.join(', ') || 'ok',
    );
  }
  /**
   * Quiet notifications (ui/notify.ts): sampled 6× over ~2.4 s, worst case kept. Drive: at most one
   * alert line (#alert / #reloc); Floor: at most 3 feed cards; never a visible .toast in either.
   */
  async function noticeChecks(label) {
    let worst = { toasts: 0, alerts: 0, feed: 0 };
    for (let i = 0; i < 6; i++) {
      const n = await page.evaluate(() => {
        const vis = (e) => Boolean(e) && !e.hidden && e.checkVisibility();
        const count = (sel) => [...document.querySelectorAll(sel)].filter(vis).length;
        return { toasts: count('.toast, .toasts, #toasts'), alerts: count('#alert, #reloc'), feed: count('#feed .ev') };
      });
      worst = { toasts: Math.max(worst.toasts, n.toasts), alerts: Math.max(worst.alerts, n.alerts), feed: Math.max(worst.feed, n.feed) };
      await page.waitForTimeout(400);
    }
    const m = await mode();
    check(`no toast elements visible (${label})`, worst.toasts === 0, `${worst.toasts} visible`);
    if (m === 'driving') check(`at most 1 alert line (${label})`, worst.alerts <= 1, `${worst.alerts} visible`);
    else check(`at most 3 feed cards (${label})`, worst.feed <= 3, `${worst.feed} visible`);
  }
  const mode = () => page.evaluate(() => document.body.dataset.mode);
  const blur = () => page.evaluate(() => (document.activeElement instanceof HTMLElement ? document.activeElement.blur() : undefined));
  const sampleChange = async (sel, label) => {
    const text = async () => ((await page.locator(sel).textContent().catch(() => '')) ?? '').trim();
    const t0 = await text();
    for (let i = 0; i < 60; i++) {
      await page.waitForTimeout(1000);
      if ((await text()) !== t0) return true;
    }
    console.log(`${label}: unchanged — ${t0.slice(0, 80)}`);
    return false;
  };

  page.on('requestfailed', (r) => diag('request.failed', `${r.url().split('?')[0]} ${r.failure()?.errorText ?? ''}`));
  for (let attempt = 1; ; attempt++) {
    try {
      await page.goto(`${lobbyUrl}/`, { waitUntil: 'domcontentloaded', timeout: 45_000 });
      break;
    } catch (err) {
      diag('goto.failed', `attempt ${attempt}: ${String(err?.message || err).split('\n')[0]}`);
      if (attempt >= 3) throw err;
      console.log(`page load attempt ${attempt} failed — retrying`);
    }
  }

  // 0. Intro Page opens by default on boot with the "How to Play" tab, switches to "The AI Inside" tab, and closes/re-opens cleanly.
  const helpVisibleOnBoot = await page.locator('#help').isVisible().catch(() => false);
  check('intro page (#help) visible on initial load', helpVisibleOnBoot);

  const introGithubVisible = await page.locator('#help .intro-github-link').isVisible().catch(() => false);
  const introGithubHref = (await page.locator('#help .intro-github-link').getAttribute('href').catch(() => '')) ?? '';
  check(
    'intro modal (.intro-github-link) visible with repo href',
    introGithubVisible && introGithubHref === 'https://github.com/davenportjw/freightfloor',
    `visible=${introGithubVisible} href=${introGithubHref}`,
  );

  const introPoweredVisible = await page.locator('#help .intro-powered-link').isVisible().catch(() => false);
  const introPoweredHref = (await page.locator('#help .intro-powered-link').getAttribute('href').catch(() => '')) ?? '';
  check(
    'intro modal (.intro-powered-link) visible with davenporter.com href',
    introPoweredVisible && introPoweredHref === 'https://davenporter.com',
    `visible=${introPoweredVisible} href=${introPoweredHref}`,
  );

  const rulesVisible = await page.locator('#help [data-pane="rules"]').isVisible().catch(() => false);
  const stepCount = await page.locator('#help [data-pane="rules"] .intro-step').count().catch(() => 0);
  check('intro How to Play tab shows 3 steps by default', rulesVisible && stepCount === 3, `rules=${rulesVisible} steps=${stepCount}`);
  await buttonChromeCheck('intro How to Play');

  await page.screenshot({ path: join(outDir, 'ui-intro.png') });

  await page.locator('#help [data-intro-tab="ai"]').click();
  const aiConceptsVisible = await page.locator('#help [data-pane="ai-concepts"]').isVisible().catch(() => false);
  const rulesHidden = !(await page.locator('#help [data-pane="rules"]').isVisible().catch(() => true));
  const aiCardCount = await page.locator('#help [data-pane="ai-concepts"] .ai-concept-card').count().catch(() => 0);
  check(
    'intro AI tab switches panes',
    aiConceptsVisible && rulesHidden && aiCardCount >= 4,
    `ai=${aiConceptsVisible} rulesHidden=${rulesHidden} cards=${aiCardCount}`,
  );
  await buttonChromeCheck('intro AI tab');
  await page.screenshot({ path: join(outDir, 'ui-intro-ai.png') });
  await page.locator('#help [data-intro-tab="play"]').click();

  // Wait for the welcome: a seated driver gets the pick sheet / Drive HUD, a spectator the Floor view.
  await page.waitForFunction(
    () => ['#pickSheet', '#run', '#kpis'].some((s) => { const e = document.querySelector(s); return e && !e.hidden; }),
    null,
    { timeout: 30_000 },
  ).catch(() => {});

  // Dismiss Intro Page via "Enter the Floor →" button
  await page.locator('[data-action="close-intro"]').first().click();
  await page.waitForTimeout(400);
  const helpHiddenAfterClose = !(await page.locator('#help').isVisible().catch(() => true));
  check('close-intro button dismisses #help', helpHiddenAfterClose);

  const startMode = await mode();
  console.log(`joined in ${startMode === 'driving' ? 'Drive (seated as a driver)' : 'Floor view (spectator)'}`);

  // ---------------------------------------------------------------------------------------------
  /** Contract pick sheet: Esc minimises it (☰ stays usable), "contracts waiting" reopens it, ↵ starts. */
  async function pickSheetFlow() {
    let cards = '';
    for (let i = 0; i < 20 && !cards; i++) {
      cards = ((await page.locator('#pickSheet:visible, #contracts:visible').allTextContents()).join(' ') ?? '').trim();
      if (!cards) await page.waitForTimeout(1000);
    }
    check('contract pick sheet / contracts card appears', cards.length > 0, cards.slice(0, 80));
    if (!(await isShown('#pickSheet'))) return;
    await page.screenshot({ path: join(outDir, 'ui-1600-pick.png') });
    await blur();
    await page.keyboard.press('Escape'); // minimise into the contracts card
    await page.waitForTimeout(400);
    const scrimGone = !(await isShown('#scrim'));
    check('Esc minimises the pick sheet (no scrim left)', !(await isShown('#pickSheet')) && scrimGone, `scrimGone=${scrimGone}`);
    // ☰ is usable while the deal is minimised: menu opens and "How to play" re-opens the intro.
    await page.locator('#menuBtn').click({ timeout: 5000 });
    await page.waitForTimeout(250);
    check('☰ menu opens with the deal minimised', await isShown('#menu'));
    await page.locator('#menu [data-action="open-intro"]').first().click();
    await page.waitForTimeout(250);
    check('☰ menu "How to play" re-opens #help', await isShown('#help'));
    await page.locator('[data-action="close-intro"]').first().click();
    await page.waitForTimeout(400);
    // Reopen from the contracts card and start the run with the selected cards.
    const reopen = page.locator('#contracts [data-action="open-deal"]').first();
    if (await reopen.count()) await reopen.click();
    await page.waitForTimeout(300);
    check('"contracts waiting" reopens the pick sheet', await isShown('#pickSheet'));
    await blur();
    await page.keyboard.press('Enter'); // keep the selected cards and start
    await page.locator('#pickSheet').waitFor({ state: 'hidden', timeout: 5000 }).catch(() => {});
    check('↵ starts the run (pick sheet closes)', !(await isShown('#pickSheet')));
  }

  /**
   * The order-choice card (#fare) is a transient decision prompt — the Co-Pilot reserves an order
   * within a few seconds — so steady-state coverage is measured after it resolves (≤8 s). The
   * transient coverage is still printed for the record.
   */
  async function settleTransients(label) {
    if (!(await isShown('#fare'))) return;
    const g = await hudGeometry();
    console.log(`order choice open (${label}): transient coverage ${(g.coverage * 100).toFixed(1)}% — waiting for it to resolve`);
    await page.waitForFunction(() => !document.querySelector('#fare')?.checkVisibility(), null, { timeout: 8_000 }).catch(() => {});
    await page.waitForTimeout(400);
  }

  /** Drive HUD checks; `full` adds the one-off checks (Tab / chat / minimal / drawer). */
  async function driveChecks(full) {
    await blur();
    await page.setViewportSize({ width: 1600, height: 900 });
    await page.waitForTimeout(500);
    const m = await mode();
    check('Drive HUD active', m === 'driving' && (await isShown('#run')) && (await isShown('#dash')) && !(await isShown('#orders')), `body[data-mode]=${m}`);
    const hudText = async () => ((await page.locator('#run').textContent().catch(() => '')) ?? '').trim() + ' | ' + ((await page.locator('#dash').textContent().catch(() => '')) ?? '').trim();
    const before = await hudText();
    const ackStart = acks.length;
    const samples = new Set([before]);
    // W first; if the vehicle is parked nose-to-rack, back out / turn instead.
    for (const k of ['KeyW', 'KeyS', 'KeyA', 'KeyD']) {
      await page.keyboard.down(k);
      for (let i = 0; i < 4; i++) {
        await page.waitForTimeout(200);
        samples.add(await hudText());
      }
      await page.keyboard.up(k);
      const moved = acks.slice(ackStart).some((a) => a.speedNow > 0.05 || a.x !== acks[ackStart]?.x || a.y !== acks[ackStart]?.y);
      if (moved && samples.size > 1) break;
    }
    const driveAcks = acks.slice(ackStart);
    const first = driveAcks[0];
    const last = driveAcks[driveAcks.length - 1];
    const moved = driveAcks.some((a) => a.speedNow > 0.05) || (first && last && (first.x !== last.x || first.y !== last.y));
    check('driving moves the vehicle (server acks)', Boolean(moved), first && last ? `(${first.x},${first.y}) → (${last.x},${last.y}) · ${driveAcks.length} acks` : 'no acks');
    check('driving updates the run capsule / dash readout', samples.size > 1, `${samples.size} distinct readouts`);
    const objective = ((await page.locator('#objective').textContent().catch(() => '')) ?? '').trim();
    check('objective pill visible while driving', (await isShown('#objective')) && objective.length > 0, objective.slice(0, 90));
    await settleTransients('1600×900');
    await noticeChecks('drive, 1600×900');
    await githubBtnCheck('drive, 1600×900');
    const driveGeo = await hudGeometry();
    const core = ['#menuBtn', '#run', '#objective', '#contracts', '#dash'];
    const extras = driveGeo.visible.filter((s) => !core.includes(s) && !['#githubBtn', '#brandBadge', '#fare', '#alert', '#reloc'].includes(s));
    check('Drive HUD shows the 5 drive elements only', core.every((s) => driveGeo.visible.includes(s)) && extras.length === 0, driveGeo.visible.join(','));
    check('no overlapping HUD cards (drive, 1600×900)', driveGeo.overlaps.length === 0, driveGeo.overlaps.join(' ') || driveGeo.visible.join(','));
    check('Drive HUD covers ≤15% of the floor (1600×900)', driveGeo.coverage <= 0.15, `${(driveGeo.coverage * 100).toFixed(1)}%`);
    await page.screenshot({ path: join(outDir, full ? 'ui-1600-driving.png' : 'ui-1600-driving-again.png') });

    // Narrow viewport: still no overlap, still ≤15% coverage.
    await page.setViewportSize({ width: 1280, height: 760 });
    await page.waitForTimeout(1200);
    await settleTransients('1280×760');
    if (full) await noticeChecks('drive, 1280×760');
    const narrowGeo = await hudGeometry();
    check('no overlapping HUD cards (drive, 1280×760)', narrowGeo.overlaps.length === 0, narrowGeo.overlaps.join(' ') || narrowGeo.visible.join(','));
    check('Drive HUD covers ≤15% of the floor (1280×760)', narrowGeo.coverage <= 0.15, `${(narrowGeo.coverage * 100).toFixed(1)}%`);
    await page.screenshot({ path: join(outDir, full ? 'ui-1280.png' : 'ui-1280-again.png') });
    if (!full) return;

    // Hold Tab → Standings sheet with the difficulty vote; release closes it.
    await page.keyboard.down('Tab');
    await page.waitForTimeout(300);
    const standingsOpen = await isShown('#standingsSheet');
    const votes = await page.locator('#standingsSheet [data-vote]').count();
    check('hold Tab shows Standings with the vote', standingsOpen && votes >= 4, `open=${standingsOpen} votes=${votes}`);
    await page.screenshot({ path: join(outDir, 'ui-1280-standings.png') });
    await page.keyboard.up('Tab');
    await page.waitForTimeout(250);
    check('releasing Tab closes Standings', !(await isShown('#standingsSheet')));

    // Enter → chat box; Esc closes it.
    await blur();
    await page.keyboard.press('Enter');
    await page.waitForTimeout(300);
    check('Enter opens chat', await isShown('#chat'));
    await page.screenshot({ path: join(outDir, 'ui-1280-chat.png') });
    await page.keyboard.press('Escape');
    await page.waitForTimeout(300);
    check('Esc closes chat', !(await isShown('#chat')));

    // Drawer + tabs.
    await blur();
    await page.keyboard.press('KeyH');
    await page.waitForTimeout(400);
    const drawerOpen = await page.locator('#drawer').evaluate((d) => !d.classList.contains('closed'));
    const tabs = page.locator('#drawer .drawer-tabs button');
    const tabCount = await tabs.count();
    const tabTexts = [];
    for (let i = 0; i < tabCount; i++) {
      await tabs.nth(i).click();
      await page.waitForTimeout(250);
      const body = ((await page.locator('#drawer').textContent()) ?? '').trim();
      tabTexts.push(`${(await tabs.nth(i).textContent())?.trim()}:${body.length > 0}`);
    }
    check('drawer opens with all tabs', drawerOpen && tabCount >= 5, tabTexts.join(' '));
    await blur();
    await page.keyboard.press('KeyH');

    // Cab View (P): the lazy three.js chunk loads, the first-person canvas shows and draws, drive
    // input still moves the truck (server acks), and P returns to the iso view.
    await blur();
    await page.keyboard.press('KeyP');
    let cabShown = false;
    for (let i = 0; i < 20 && !cabShown; i++) {
      await page.waitForTimeout(250);
      cabShown = await page
        .locator('canvas.cab-canvas')
        .evaluate((c) => getComputedStyle(c).display !== 'none' && c.width > 0)
        .catch(() => false);
    }
    check('Cab View (P) shows the first-person canvas', cabShown);
    if (cabShown) {
      const acksBefore = acks.length;
      await page.keyboard.down('KeyW');
      await page.waitForTimeout(1200);
      await page.keyboard.up('KeyW');
      await page.waitForTimeout(400);
      check('driving in Cab View gets server acks', acks.length > acksBefore, `acks ${acksBefore}→${acks.length}`);
      await page.screenshot({ path: join(outDir, 'ui-1280-cab.png') });
    }
    await page.keyboard.press('KeyP');
    await page.waitForTimeout(400);
    const cabHidden = await page
      .locator('canvas.cab-canvas')
      .evaluate((c) => getComputedStyle(c).display === 'none')
      .catch(() => true);
    check('P again returns to the iso view', cabHidden);

    // HUD Minimal (V) persists across reload; the intro still opens on a subsequent visit,
    // and dismissing it never opens a second blocking #pickSheet modal even for returning players.
    await page.keyboard.press('KeyV');
    await page.waitForTimeout(150);
    await page.evaluate(() => localStorage.setItem('warehouse.runs.done', '2'));
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(1500);
    const helpVisibleAfterReload = await page.locator('#help').isVisible().catch(() => false);
    check('intro page (#help) visible on subsequent visit after reload', helpVisibleAfterReload);
    if (helpVisibleAfterReload) await page.locator('[data-action="close-intro"]').first().click();
    await page.waitForTimeout(2500);
    check('single intro dismissal enters floor without stacked #pickSheet modal', !(await isShown('#help')) && !(await isShown('#pickSheet')));
    const minimalPersisted = await page.evaluate(() => document.body.classList.contains('hud-minimal'));
    check('HUD Minimal persists after reload', minimalPersisted);
    await blur();
    await page.keyboard.press('KeyV'); // back to Full for the remaining checks
    await page.waitForTimeout(300);
  }

  /** Overlap-check + screenshot the current Floor state at 1280×760, then restore 1600×1000. */
  async function narrowShot(file, label) {
    await page.setViewportSize({ width: 1280, height: 760 });
    await page.waitForTimeout(400);
    await noticeChecks(`${label}, 1280×760`);
    const geo = await hudGeometry();
    check(`no overlapping HUD cards (${label}, 1280×760)`, geo.overlaps.length === 0, geo.overlaps.join(' ') || geo.visible.join(','));
    await page.screenshot({ path: join(outDir, file) });
    await page.setViewportSize({ width: 1600, height: 1000 });
    await page.waitForTimeout(300);
  }

  /** Floor view checks (spectator, or after "Watch the floor"). */
  async function floorChecks() {
    await page.setViewportSize({ width: 1600, height: 1000 });
    await page.waitForFunction(
      () => /^Day \d+ · \d{2}:\d{2} · Shift [A-C]$/.test(document.querySelector('#kpis .clock')?.textContent?.trim() ?? ''),
      null,
      { timeout: 30_000 },
    ).catch(() => {});
    const clockText = ((await page.locator('#kpis .clock').first().textContent().catch(() => '')) ?? '').trim();
    check('floor KPI clock format', /^Day \d+ · \d{2}:\d{2} · Shift [A-C]$/.test(clockText) && clockText.split('Day').length === 2, clockText);
    const m = await mode();
    check('Floor view active', m === 'floor', `body[data-mode]=${m}`);
    const floorShown = { kpis: await isShown('#kpis'), banner: await isShown('#floorBanner'), orders: await isShown('#orders') };
    const driveHidden = !(await isShown('#run')) && !(await isShown('#dash')) && !(await isShown('#contracts'));
    check('Floor HUD shows KPIs / banner / orders, hides drive cards', Object.values(floorShown).every(Boolean) && driveHidden, JSON.stringify({ ...floorShown, driveHidden }));
    const orderInfo = await page.$$eval('#orders [data-order]', (els) => els.map((e) => ({ id: e.getAttribute('data-order'), disabled: e.disabled, title: e.title, text: e.textContent })));
    const orderIds = orderInfo.map((o) => o.id);
    check('Floor orders bar has Rush / P0 / Cones / Dispatch', ['rush', 'p0', 'cones', 'dispatch'].every((id) => orderIds.includes(id)), orderIds.join(','));
    check('every disabled Floor order says why', orderInfo.filter((o) => o.disabled).every((o) => o.title.trim().length > 0), orderInfo.filter((o) => o.disabled).map((o) => `${o.id}:${o.title.slice(0, 30)}`).join(' | '));
    check('server sent floorOrders on the WebSocket', lastFloorOrders !== null, lastFloorOrders ? JSON.stringify(lastFloorOrders).slice(0, 120) : 'none');
    await page.waitForTimeout(2500);
    await noticeChecks('floor, 1600×1000');
    await githubBtnCheck('floor, 1600×1000');
    const floorGeo = await hudGeometry();
    check('no overlapping HUD cards (floor, 1600×1000)', floorGeo.overlaps.length === 0, floorGeo.overlaps.join(' ') || floorGeo.visible.join(','));
    await page.screenshot({ path: join(outDir, 'ui-1600.png') });
    await narrowShot('ui-1280-floor.png', 'floor');

    // Team Standings (B) and the Value flyout change within 60 s each (real server stats).
    await blur();
    await page.keyboard.press('KeyB');
    await page.waitForTimeout(300);
    check('B opens Team Standings', await isShown('#standFly'));
    await page.screenshot({ path: join(outDir, 'ui-1600-floorstand.png') });
    await narrowShot('ui-1280-floorstand.png', 'team standings');
    check('Team Standings updates within 60 s', await sampleChange('#standFly', 'standings'));
    await page.keyboard.press('Escape');
    await page.locator('#menuBtn').click();
    await page.waitForTimeout(200);
    const menuOpen = await isShown('#menu');
    const flyIds = await page.$$eval('#menu [data-flyout]', (els) => els.map((e) => e.getAttribute('data-flyout')));
    check('☰ menu lists every flyout', menuOpen && ['board', 'fleet', 'drivers', 'value', 'network', 'layers', 'settings'].every((id) => flyIds.includes(id)), flyIds.join(','));
    await page.locator('#menu [data-flyout="value"]').click();
    await page.waitForTimeout(300);
    check('Value created flyout opens', await isShown('#flyout'));
    check('value chart updates within 60 s', await sampleChange('#flyout', 'value'));
    await page.keyboard.press('Escape');
    await page.waitForTimeout(150);
    if (await isShown('#menu')) await page.keyboard.press('KeyM');

    // ★ P0: pressing it must change the server's floorOrders (open count or cooldown), or — when
    // it is disabled — the disabled reason is already asserted above.
    const p0 = page.locator('#orders [data-order="p0"]');
    if (await p0.isEnabled().catch(() => false)) {
      const before = JSON.stringify(lastFloorOrders?.p0 ?? null);
      await p0.click();
      let after = before;
      for (let i = 0; i < 20 && after === before; i++) {
        await page.waitForTimeout(250);
        after = JSON.stringify(lastFloorOrders?.p0 ?? null);
      }
      const btn = ((await p0.textContent().catch(() => '')) ?? '').trim();
      check('★ P0 order updates server floorOrders', after !== before, `${before} → ${after} · button "${btn}"`);
    } else {
      console.log(`★ P0 disabled: ${await p0.getAttribute('title')}`);
    }

    // 4 → Dispatch drawer; Esc closes it.
    await blur();
    await page.keyboard.press('Digit4');
    await page.waitForTimeout(300);
    const dispatchOpen = await isShown('#dispatchPop');
    const dispatchReady = !(await page.locator('#orders [data-order="dispatch"]').isDisabled().catch(() => true)) || dispatchOpen;
    check('4 opens the Dispatch drawer (or explains the cooldown)', dispatchOpen || !dispatchReady, `open=${dispatchOpen}`);
    if (dispatchOpen) {
      const geo = await hudGeometry();
      check('no overlapping HUD cards (dispatch drawer)', geo.overlaps.length === 0, geo.overlaps.join(' '));
      await page.screenshot({ path: join(outDir, 'ui-1600-dispatch.png') });
      await narrowShot('ui-1280-dispatch.png', 'dispatch drawer');
      await page.keyboard.press('Escape');
      await page.waitForTimeout(250);
    }

    // 3 → cone placement mode (hint shown); Esc leaves it.
    await page.keyboard.press('Digit3');
    await page.waitForTimeout(300);
    const coneOn = (await isShown('#coneHint')) && (await page.locator('#orders [data-order="cones"]').getAttribute('aria-pressed')) === 'true';
    check('3 enters cone mode', coneOn);
    await page.screenshot({ path: join(outDir, 'ui-1600-cones.png') });
    await page.keyboard.press('Escape');
    await page.waitForTimeout(250);
    check('Esc leaves cone mode', !(await isShown('#coneHint')));
  }

  /** Wait for the Blitz timer to end the run, then "Watch the floor". */
  async function runEndToFloor() {
    // The reload above re-seats us in a fresh run whose Blitz clock only starts on the first
    // move (behind the pick sheet): take the deal and nudge forward so the clock runs.
    await pickSheetFlowIfAny();
    await blur();
    await page.keyboard.down('KeyW');
    await page.waitForTimeout(600);
    await page.keyboard.up('KeyW');
    // Hand the wheel to the Co-Pilot (Esc) so the run keeps working while we wait.
    await page.keyboard.press('Escape');
    const t0 = Date.now();
    await page.locator('#runEnd .results').waitFor({ state: 'visible', timeout: runEndWaitMs }).catch(() => {});
    const shown = await isShown('#runEnd .results');
    check('Run complete sheet appears when the run ends', shown, `${Math.round((Date.now() - t0) / 1000)} s`);
    if (!shown) return false;
    await page.setViewportSize({ width: 1280, height: 760 });
    await page.waitForTimeout(400);
    await page.screenshot({ path: join(outDir, 'ui-1280-results.png') });
    const txt = ((await page.locator('#runEnd').textContent()) ?? '').trim();
    check('Run complete offers Watch the floor / Run again', /Watch the floor/.test(txt) && /Run again|Play again/.test(txt), txt.slice(0, 90));
    await page.getByRole('button', { name: /Watch the floor/ }).click();
    await page.waitForTimeout(800);
    return true;
  }

  async function driveFromFloor() {
    await page.setViewportSize({ width: 1600, height: 900 });
    const drive = page.locator('#floorBanner [data-role="drive-btn"]').first();
    if ((await drive.count()) && (await drive.isEnabled())) await drive.click();
    else await page.keyboard.press('KeyF');
    // Play again opens a fresh socket and a new run: wait for Drive mode (or the new deal) rather
    // than a fixed delay, so a slow link does not read as a failed rejoin. 30 s covers one
    // client connect-watchdog retry (CONNECT_TIMEOUT_MS 10 s + backoff + rejoin).
    await page
      .waitForFunction(
        () => document.body.dataset.mode === 'driving' || !document.getElementById('pickSheet')?.hidden,
        null,
        { timeout: 30_000 },
      )
      .catch(() => {});
    if ((await mode()) !== 'driving' && !(await isShown('#pickSheet'))) {
      const state = await page
        .evaluate(() => ({
          mode: document.body.dataset.mode,
          url: location.href.replace(/([?&#](ticket|t)=)[^&]+/g, '$1…'),
          text: document.body.innerText.replace(/\s+/g, ' ').slice(0, 400),
        }))
        .catch((e) => ({ error: String(e) }));
      diag('drive-again.stalled', JSON.stringify(state));
    }
    await page.waitForTimeout(800);
    await pickSheetFlowIfAny();
  }

  async function pickSheetFlowIfAny() {
    if (await isShown('#pickSheet')) {
      await blur();
      await page.keyboard.press('Enter');
      await page.waitForTimeout(800);
    }
  }

  if (startMode === 'driving') {
    await pickSheetFlow();
    await driveChecks(true);
    if (await runEndToFloor()) {
      await floorChecks();
      await driveFromFloor();
      await driveChecks(false);
    }
  } else {
    await floorChecks();
    await driveFromFloor();
    if ((await mode()) === 'driving') await driveChecks(true);
    else check('F from the Floor view takes a wheel', false, 'no AI vehicle free / site at driver cap');
  }

  check('no console errors', consoleErrors.length === 0, consoleErrors.slice(0, 3).join(' | '));
} catch (err) {
  check('ui smoke ran to completion', false, String(err?.stack || err));
} finally {
  await browser.close();
  if (process.env.SMOKE_SKIP_FIRESTORE !== '1') {
    try {
      const { cleanupSmokePlayers } = await import('./dist/live.js');
      const n = await cleanupSmokePlayers({});
      console.log(`cleanup: removed ${n} smoke-* player doc(s)`);
    } catch (err) {
      check('smoke-* player cleanup', false, String(err?.message || err));
    }
  }
}

const failed = results.filter((r) => !r.ok);
if (failed.length) {
  writeFileSync(join(outDir, 'diag.json'), JSON.stringify({ failed, events: diagLog }, null, 1));
  console.log(`diagnostics (console + WebSocket events) → ${join(outDir, 'diag.json')}`);
}
console.log(`\n${results.length - failed.length}/${results.length} checks passed · screenshots in ${outDir}`);
process.exit(failed.length ? 1 : 0);
