#!/usr/bin/env node
/**
 * UI smoke test against a live lobby (docs/operations.md § UI smoke).
 *
 *   node tools/smoke/ui.mjs https://warehouse-lobby-...run.app [outDir]
 *
 * Drives the real client in headless system Chrome (playwright-core, no bundled browser) and
 * verifies the UI-parity contract end to end against real server data:
 *   - clock reads "Day N · HH:MM · Shift X" (no duplicated day)
 *   - every collapsible panel folds, and stays folded after a reload (localStorage)
 *   - the history drawer opens and every tab renders
 *   - taking the wheel and driving 3 s changes the inspector readout and the pose
 *   - a contract card hand / offer appears for the driver
 *   - Strategy Board and Value chart content change within 60 s
 *   - screenshots at 1600x1000 and 1280x760
 *   - no console errors / page errors
 * Uses a `smoke-` display name (the loadtest cleanup removes smoke-* player docs) and always
 * closes the browser (and therefore its WebSocket) on exit.
 */
import { mkdirSync } from 'node:fs';
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
const displayName = `smoke-${Math.random().toString(36).slice(2, 8)}`;

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
}

const browser = await chromium.launch({ executablePath: chromePath, headless: true });
const consoleErrors = [];
const acks = [];
try {
  const context = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
  // Pre-seed display name and 'warehouse.help.seen'='1' to verify the Intro Page still opens on subsequent visits too.
  await context.addInitScript((name) => {
    if (!localStorage.getItem('warehouse_display_name')) localStorage.setItem('warehouse_display_name', name);
    localStorage.setItem('warehouse.help.seen', '1');
  }, displayName);
  const page = await context.newPage();
  page.on('console', (m) => {
    if (m.type() === 'error') consoleErrors.push(m.text());
  });
  page.on('pageerror', (e) => consoleErrors.push(String(e)));
  page.on('websocket', (ws) =>
    ws.on('framereceived', (f) => {
      const s = String(f.payload);
      if (!s.startsWith('{"type":"ack"')) return;
      try {
        acks.push(JSON.parse(s));
      } catch {
        /* non-JSON frame */
      }
    }),
  );

  await page.goto(`${lobbyUrl}/`, { waitUntil: 'domcontentloaded' });

  // 0. Intro Page opens by default on boot with the "How to Play" tab, switches to "The AI Inside" tab, and closes/re-opens cleanly.
  const helpVisibleOnBoot = await page.locator('#help').isVisible().catch(() => false);
  check('intro page (#help) visible on initial load', helpVisibleOnBoot);

  const rulesVisible = await page.locator('#help [data-pane="rules"]').isVisible().catch(() => false);
  const stepCount = await page.locator('#help [data-pane="rules"] .intro-step').count().catch(() => 0);
  check('intro How to Play tab shows 3 steps by default', rulesVisible && stepCount === 3, `rules=${rulesVisible} steps=${stepCount}`);

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
  await page.screenshot({ path: join(outDir, 'ui-intro-ai.png') });
  await page.locator('#help [data-intro-tab="play"]').click();

  // Dismiss Intro Page via "Enter the Floor →" button
  await page.locator('[data-action="close-intro"]').first().click();
  await page.waitForTimeout(250);
  const helpHiddenAfterClose = !(await page.locator('#help').isVisible().catch(() => true));
  check('close-intro button dismisses #help', helpHiddenAfterClose);

  // Re-open Intro Page via top toolbar "Intro & Rules ?" button
  await page.locator('[data-action="open-intro"]').first().click();
  await page.waitForTimeout(250);
  const helpReopened = await page.locator('#help').isVisible().catch(() => false);
  check('open-intro toolbar button re-opens #help', helpReopened);

  // Dismiss again to proceed with floor tests
  await page.locator('[data-action="close-intro"]').first().click();
  await page.waitForTimeout(250);

  const joinVisible = await page.locator('#joinOverlay').isVisible().catch(() => false);
  if (joinVisible) {
    await page.fill('#joinName', displayName);
    await page.locator('#joinForm button[type=submit], #joinForm button').first().click();
  }

  // 1. Clock format (wait for the welcome to populate it).
  const clock = page.locator('.clock').first();
  await page.waitForFunction(
    () => /^Day \d+ · \d{2}:\d{2} · Shift [A-C]$/.test(document.querySelector('.clock')?.textContent?.trim() ?? ''),
    null,
    { timeout: 30_000 },
  ).catch(() => {});
  const clockText = (await clock.textContent())?.trim() ?? '';
  check('clock format', /^Day \d+ · \d{2}:\d{2} · Shift [A-C]$/.test(clockText) && clockText.split('Day').length === 2, clockText);

  await page.waitForTimeout(2500);
  await page.screenshot({ path: join(outDir, 'ui-1600.png') });

  // 2. Board + value chart change within 60 s (real server stats).
  const boardText = async () => (await page.locator('[data-panel=board]').textContent().catch(() => ''))?.trim() ?? '';
  const valueText = async () => (await page.locator('[data-panel=value]').textContent().catch(() => ''))?.trim() ?? '';
  const panelIds = await page.$$eval('[data-panel]', (els) => els.map((e) => e.getAttribute('data-panel')));
  console.log('panels:', panelIds.join(', '));
  // Value panel defaults to collapsed: open it so its body renders.
  const valuePanel = page.locator('[data-panel=value]');
  if ((await valuePanel.count()) && (await valuePanel.locator('.panel-header').getAttribute('aria-expanded')) !== 'true') {
    await valuePanel.locator('.panel-header').click();
  }
  const b0 = await boardText();
  const v0 = await valueText();
  let boardChanged = false;
  let valueChanged = false;
  for (let i = 0; i < 60 && !(boardChanged && valueChanged); i++) {
    await page.waitForTimeout(1000);
    if (!boardChanged && (await boardText()) !== b0) boardChanged = true;
    if (!valueChanged && (await valueText()) !== v0) valueChanged = true;
  }
  check('strategy board updates within 60 s', boardChanged);
  check('value chart updates within 60 s', valueChanged);

  // 3. Panels fold and persist across reload.
  const foldable = [];
  for (const id of panelIds) {
    const header = page.locator(`[data-panel="${id}"] .panel-header`);
    if (!(await header.count()) || !(await header.isVisible())) continue;
    if ((await header.getAttribute('aria-expanded')) !== 'true') await header.click(); // open first
    await header.click(); // fold
    const folded = (await header.getAttribute('aria-expanded')) === 'false';
    foldable.push({ id, folded });
  }
  check('every panel folds', foldable.length > 0 && foldable.every((p) => p.folded), foldable.map((p) => `${p.id}:${p.folded}`).join(' '));
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1500);
  const helpVisibleAfterReload = await page.locator('#help').isVisible().catch(() => false);
  check('intro page (#help) visible on subsequent visit after reload', helpVisibleAfterReload);
  if (helpVisibleAfterReload) {
    await page.locator('[data-action="close-intro"]').first().click();
  }
  await page.waitForTimeout(2500);
  const persisted = [];
  for (const { id } of foldable) {
    const exp = await page.locator(`[data-panel="${id}"] .panel-header`).getAttribute('aria-expanded').catch(() => null);
    persisted.push({ id, ok: exp === 'false' });
  }
  check('folded panels persist after reload', persisted.every((p) => p.ok), persisted.map((p) => `${p.id}:${p.ok}`).join(' '));
  // Restore everything open for the remaining checks / screenshots.
  for (const { id } of foldable) {
    const header = page.locator(`[data-panel="${id}"] .panel-header`);
    if ((await header.getAttribute('aria-expanded')) === 'false') await header.click();
  }

  // 4. Drawer + tabs.
  // Note: no canvas click here — clicking empty floor deselects (by design) and would hide the inspector.
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
  await page.keyboard.press('KeyH');

  // 5. Drive ~3 s: the server acks must show the pose/speed changing and the inspector must update.
  const drive = page.getByRole('button', { name: /Drive/ }).first();
  if (await drive.isEnabled().catch(() => false)) await drive.click();
  await page.waitForTimeout(2500);
  await page.evaluate(() => (document.activeElement instanceof HTMLElement ? document.activeElement.blur() : undefined));
  const inspText = async () => ((await page.locator('#zoneInspector').textContent()) ?? '').trim();
  const before = await inspText();
  const ackStart = acks.length;
  const samples = new Set([before]);
  // W first; if the vehicle is parked nose-to-rack, back out / turn instead.
  for (const k of ['KeyW', 'KeyS', 'KeyA', 'KeyD']) {
    await page.keyboard.down(k);
    for (let i = 0; i < 4; i++) {
      await page.waitForTimeout(200);
      samples.add(await inspText());
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
  const inspVisible = await page.locator('#zoneInspector .inspector').isVisible().catch(() => false);
  check('driving updates the inspector readout', inspVisible && samples.size > 1, `${samples.size} distinct readouts · inspector ${inspVisible ? 'visible' : 'hidden'}`);
  const driveBar = ((await page.locator('#zoneBottom').textContent()) ?? '').trim();
  check('drive guidance bar visible while driving', /tiles|Drive to|Deliver|Charge|press E/i.test(driveBar), driveBar.slice(-90));

  // 6. Card hand / offer.
  let cards = '';
  for (let i = 0; i < 20 && !cards; i++) {
    cards = ((await page.locator('#cardsTray, .deal, [data-panel=deal]').allTextContents()).join(' ') ?? '').trim();
    if (!cards) await page.waitForTimeout(1000);
  }
  check('contract card hand appears', cards.length > 0, cards.slice(0, 80));
  await page.screenshot({ path: join(outDir, 'ui-1600-driving.png') });
  await page.keyboard.press('Escape');

  // 7. Narrow viewport screenshot (auto-collapse applies to panels without a user choice).
  await page.setViewportSize({ width: 1280, height: 760 });
  await page.waitForTimeout(1200);
  await page.screenshot({ path: join(outDir, 'ui-1280.png') });

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
console.log(`\n${results.length - failed.length}/${results.length} checks passed · screenshots in ${outDir}`);
process.exit(failed.length ? 1 : 0);
