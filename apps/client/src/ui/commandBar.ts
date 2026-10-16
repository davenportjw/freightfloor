/**
 * Bottom-centre command bar (mock lines 132-141) and the drive guidance bar (mock 147, 2022-2026).
 */
import { leaderboard, type Vehicle } from '@warehouse/sim';
import type { UiCtx, UiModule } from './context.js';
import { button, el, KeyedView } from './dom.js';

export const NL_MAX_LEN = 200;

/**
 * 🚜 Drive target: the selected AI vehicle, else an idle, charged, unloaded, un-stunned agent
 * (idle first, then highest battery), else any AI vehicle. Bot-driven vehicles are never picked.
 */
export function pickDriveTarget(vehicles: readonly Vehicle[], selectedVid: string | null, t: number): string | null {
  const free = vehicles.filter((v) => !v.human && !v.isBot);
  const sel = free.find((v) => v.id === selectedVid);
  if (sel) return sel.id;
  const ok = free.filter((v) => !v.cargo.length && v.battery > 35 && t >= v.stunnedUntil);
  ok.sort((a, b) => (a.state === 'idle' ? 0 : 1) - (b.state === 'idle' ? 0 : 1) || b.battery - a.battery);
  return (ok[0] ?? free[0])?.id ?? null;
}

export function mountCommandBar(zone: HTMLElement, ctx: UiCtx): UiModule {
  const { actions, store } = ctx;
  const drive = button('🚜 Drive', 'btn drive', () => actions.quickDrive(), 'Take the wheel of the best available vehicle');
  const rush = button('⚡ Rush wave', 'btn warn', () => actions.manager('rush'), 'Post a burst of 12 orders and raise arrivals for 30 game-min');
  const p0 = button('★ P0 order', 'btn warn', () => actions.manager('p0'), 'Post one high-value P0 contract');
  const cones = button('🚧 Cones', 'btn', () => actions.setConeMode(!store.coneMode), 'Click floor tiles to place or remove cones [C]');
  const input = el('input', {
    class: 'text-input nl-input',
    attrs: {
      maxlength: String(NL_MAX_LEN),
      placeholder: 'Type an order for the floor, e.g. “post a rush wave”',
      'aria-label': 'Floor command',
      enterkeyhint: 'send',
    },
  });
  const form = el('form', { class: 'nl-form' }, [input]);
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const text = input.value.trim().slice(0, NL_MAX_LEN);
    if (!text) return;
    actions.nlCommand(text);
    input.value = '';
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') input.blur();
  });
  const root = el('div', { class: 'hud command-bar' }, [drive, el('span', { class: 'vsep' }), rush, p0, cones, el('span', { class: 'vsep' }), form]);
  zone.append(root);
  return {
    update() {
      const ready = store.welcomed && store.conn.status === 'open';
      drive.disabled = !ready || store.isDriving();
      drive.title = store.isDriving() ? 'You are already driving' : 'Take the wheel of the best available vehicle';
      for (const b of [rush, p0, cones]) b.disabled = !ready;
      input.disabled = !ready;
      cones.classList.toggle('on', store.coneMode);
      cones.setAttribute('aria-pressed', String(store.coneMode));
    },
  };
}

export function mountDriveBar(zone: HTMLElement, ctx: UiCtx): UiModule {
  const root = el('div', { class: 'hud drive-bar', attrs: { role: 'status' } });
  root.hidden = true;
  const view = new KeyedView(root);
  zone.append(root);
  return {
    update() {
      const { store } = ctx;
      const me = store.isDriving() ? store.myVehicle() : null;
      if (!me) {
        root.hidden = true;
        view.invalidate();
        return;
      }
      root.hidden = false;
      const g = store.myGuide();
      const lb = leaderboard(store.world);
      const rank = lb.findIndex((r) => r.id === me.id) + 1;
      const dist =
        g && typeof g.x === 'number' && typeof g.y === 'number'
          ? Math.round(Math.abs(g.x - me.tile.x) + Math.abs(g.y - me.tile.y))
          : null;
      const bat = Math.round(me.battery);
      view.render(JSON.stringify([g?.text, g?.inRange, dist, rank, Math.round(me.sPts), bat, me.id]), () => [
        el('span', {
          class: g?.inRange ? 'ok' : 'go',
          text: g?.text ? `${g.inRange ? '✓' : '▶'} ${g.text}` : `Driving ${me.id} · waiting for guidance from the site…`,
        }),
        dist !== null && !g?.inRange ? el('span', { class: 'muted num', text: `${dist} tiles` }) : null,
        el('span', { class: `num${bat < 20 ? ' bad' : ''}`, text: `🔋 ${bat}%` }),
        el('span', { class: 'num', text: `${rank ? `#${rank} · ` : ''}${Math.round(me.sPts)} pts` }),
      ]);
    },
  };
}
