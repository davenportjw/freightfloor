/**
 * Full-screen Leaderboard & Silly Superlatives Modal (`#leaderboardModal`).
 *
 * Gives players a spacious, high-contrast academic sepia dashboard with:
 * 1. Live Shift Standings (full table of all human & AI vehicles withPts, Shipped, Crashes, Near Misses, Skids, Drops, Battery, Status)
 * 2. Silly Superlatives ("Wall of Shame & Glory" — Crash Test Dummy, Butterfingers, Tokyo Drift, Close Call Champion, Living on the Edge, Parking Brake Award)
 * 3. Site Hall of Fame (top recorded shift winners on this shard)
 * 4. Network Lifetime Leaderboard (cross-site top human drivers from Firestore)
 */
import { leaderboard, type Vehicle, type World } from '@warehouse/sim';
import type { LeaderboardModalTab } from '../state.js';
import type { UiCtx, UiModule } from './context.js';
import { button, el, KeyedView, swatch, type Child } from './dom.js';
import { difficultyLabel, shiftLeft, teamColor } from './format.js';

export interface SillyAward {
  id: 'crashes' | 'palletDrops' | 'skids' | 'nearMisses' | 'lowBattery' | 'parkingBrake';
  icon: string;
  title: string;
  subtitle: string;
  vid: string | null;
  holder: string;
  strat: string | null;
  human: boolean;
  mine: boolean;
  value: number;
  statText: string;
  caption: string;
}

function formatHolder(v: Vehicle): string {
  return v.human && v.driver ? `${v.driver} (${v.id})` : v.id;
}

/**
 * Pure helper computing the 6 live Silly Superlatives from authoritative `world.vehicles`.
 * Never invents numbers: when no vehicle has triggered a given mishap yet, returns a clean zero state.
 */
export function computeSillyAwards(
  w: Pick<World, 'vehicles'>,
  myVid: string | null = null,
): SillyAward[] {
  const vehicles = w.vehicles ?? [];

  // 1. Crash Test Dummy (most incidents)
  const byCrashes = [...vehicles].sort(
    (a, b) =>
      (b.incidents ?? 0) - (a.incidents ?? 0) ||
      (b.palletDrops ?? 0) - (a.palletDrops ?? 0) ||
      a.id.localeCompare(b.id),
  );
  const topCrash = byCrashes[0];
  const crashCount = topCrash ? (topCrash.incidents ?? 0) : 0;
  const crashesAward: SillyAward =
    topCrash && crashCount > 0
      ? {
          id: 'crashes',
          icon: '💥',
          title: 'Crash Test Dummy',
          subtitle: 'Most Collisions & Stuns',
          vid: topCrash.id,
          holder: formatHolder(topCrash),
          strat: topCrash.human ? 'Human' : topCrash.strategy,
          human: topCrash.human,
          mine: topCrash.id === myVid,
          value: crashCount,
          statText: `${crashCount} crash${crashCount === 1 ? '' : 'es'} (−${crashCount * 15} pts)`,
          caption: 'Treating warehouse racks and forklifts like bumper cars since shift start.',
        }
      : {
          id: 'crashes',
          icon: '💥',
          title: 'Crash Test Dummy',
          subtitle: 'Most Collisions & Stuns',
          vid: null,
          holder: 'Floor Accident-Free!',
          strat: null,
          human: false,
          mine: false,
          value: 0,
          statText: '0 crashes so far',
          caption: 'No collisions recorded yet—someone is bound to test the rack bumpers soon.',
        };

  // 2. Butterfingers Award (most boost collision pallet drops)
  const byDrops = [...vehicles].sort(
    (a, b) =>
      (b.palletDrops ?? 0) - (a.palletDrops ?? 0) ||
      (b.incidents ?? 0) - (a.incidents ?? 0) ||
      a.id.localeCompare(b.id),
  );
  const topDrop = byDrops[0];
  const dropCount = topDrop ? (topDrop.palletDrops ?? 0) : 0;
  const dropsAward: SillyAward =
    topDrop && dropCount > 0
      ? {
          id: 'palletDrops',
          icon: '📦',
          title: 'Butterfingers Award',
          subtitle: 'Most Boost-Collision Pallet Drops',
          vid: topDrop.id,
          holder: formatHolder(topDrop),
          strat: topDrop.human ? 'Human' : topDrop.strategy,
          human: topDrop.human,
          mine: topDrop.id === myVid,
          value: dropCount,
          statText: `${dropCount} dropped pallet${dropCount === 1 ? '' : 's'}`,
          caption: 'Boosted straight into an obstacle and launched cargo across the aisle.',
        }
      : {
          id: 'palletDrops',
          icon: '📦',
          title: 'Butterfingers Award',
          subtitle: 'Most Boost-Collision Pallet Drops',
          vid: null,
          holder: 'No Dropped Cargo Yet',
          strat: null,
          human: false,
          mine: false,
          value: 0,
          statText: '0 boost pallet drops',
          caption: 'Hold Shift to boost into a wall with cargo if you want to claim this trophy!',
        };

  // 3. Tokyo Drift Award (most floor spill skids)
  const bySkids = [...vehicles].sort(
    (a, b) =>
      (b.skids ?? 0) - (a.skids ?? 0) ||
      (b.nearMisses ?? 0) - (a.nearMisses ?? 0) ||
      a.id.localeCompare(b.id),
  );
  const topSkid = bySkids[0];
  const skidCount = topSkid ? (topSkid.skids ?? 0) : 0;
  const skidsAward: SillyAward =
    topSkid && skidCount > 0
      ? {
          id: 'skids',
          icon: '🍌',
          title: 'Tokyo Drift Award',
          subtitle: 'Most Floor Spill Skids',
          vid: topSkid.id,
          holder: formatHolder(topSkid),
          strat: topSkid.human ? 'Human' : topSkid.strategy,
          human: topSkid.human,
          mine: topSkid.id === myVid,
          value: skidCount,
          statText: `${skidCount} spill skid${skidCount === 1 ? '' : 's'}`,
          caption: 'Full throttle through floor spills—steering is merely a suggestion.',
        }
      : {
          id: 'skids',
          icon: '🍌',
          title: 'Tokyo Drift Award',
          subtitle: 'Most Floor Spill Skids',
          vid: null,
          holder: 'Dry Tires Only',
          strat: null,
          human: false,
          mine: false,
          value: 0,
          statText: '0 spill skids',
          caption: 'Every forklift has kept traction through the aisles so far.',
        };

  // 4. Close Call Champion (most near misses)
  const byNearMisses = [...vehicles].sort(
    (a, b) =>
      (b.nearMisses ?? 0) - (a.nearMisses ?? 0) ||
      (b.sShipped ?? 0) - (a.sShipped ?? 0) ||
      a.id.localeCompare(b.id),
  );
  const topNear = byNearMisses[0];
  const nearCount = topNear ? (topNear.nearMisses ?? 0) : 0;
  const nearMissAward: SillyAward =
    topNear && nearCount > 0
      ? {
          id: 'nearMisses',
          icon: '😱',
          title: 'Close Call Champion',
          subtitle: 'Most Aisle Near-Misses',
          vid: topNear.id,
          holder: formatHolder(topNear),
          strat: topNear.human ? 'Human' : topNear.strategy,
          human: topNear.human,
          mine: topNear.id === myVid,
          value: nearCount,
          statText: `${nearCount} near miss${nearCount === 1 ? '' : 'es'}`,
          caption: 'Trading paint in narrow aisles without quite triggering an incident report.',
        }
      : {
          id: 'nearMisses',
          icon: '😱',
          title: 'Close Call Champion',
          subtitle: 'Most Aisle Near-Misses',
          vid: null,
          holder: 'Plenty of Elbow Room',
          strat: null,
          human: false,
          mine: false,
          value: 0,
          statText: '0 close calls',
          caption: 'Polite spacing across every aisle on the floor.',
        };

  // 5. Living on the Edge (lowest battery vehicle)
  const byLowBat = [...vehicles].sort(
    (a, b) =>
      Math.round(a.battery) - Math.round(b.battery) ||
      (b.human ? 1 : 0) - (a.human ? 1 : 0) ||
      (b.sShipped ?? 0) - (a.sShipped ?? 0) ||
      a.id.localeCompare(b.id),
  );
  const lowBat = byLowBat[0];
  const lowBatVal = lowBat ? Math.round(lowBat.battery) : 100;
  const lowBatteryAward: SillyAward = lowBat
    ? {
        id: 'lowBattery',
        icon: '🪫',
        title: 'Living on the Edge',
        subtitle: 'Lowest Battery on the Floor',
        vid: lowBat.id,
        holder: formatHolder(lowBat),
        strat: lowBat.human ? 'Human' : lowBat.strategy,
        human: lowBat.human,
        mine: lowBat.id === myVid,
        value: lowBatVal,
        statText: `${lowBatVal}% battery (${lowBat.state})`,
        caption:
          lowBatVal <= 20
            ? 'Allergic to green charging pads—running on pure fumes and optimism!'
            : 'Closest to needing a pit stop at the south wall chargers.',
      }
    : {
        id: 'lowBattery',
        icon: '🪫',
        title: 'Living on the Edge',
        subtitle: 'Lowest Battery on the Floor',
        vid: null,
        holder: 'No Vehicles Active',
        strat: null,
        human: false,
        mine: false,
        value: 0,
        statText: '—',
        caption: 'Waiting for vehicles to roll onto the floor.',
      };

  // 6. Parking Brake Award (lowest deliveries / most chill on the clock)
  const shippedCountOf = (v: World['vehicles'][number]): number =>
    Math.min(v.sShipped ?? 0, v.deliveries ?? v.sShipped ?? 0);
  const byChill = [...vehicles].sort(
    (a, b) =>
      shippedCountOf(a) - shippedCountOf(b) ||
      (b.human ? 1 : 0) - (a.human ? 1 : 0) ||
      (a.sPts ?? 0) - (b.sPts ?? 0) ||
      (b.wait ?? 0) - (a.wait ?? 0) ||
      a.id.localeCompare(b.id),
  );
  const chill = byChill[0];
  const chillShipped = chill ? shippedCountOf(chill) : 0;
  const parkingBrakeAward: SillyAward = chill
    ? {
        id: 'parkingBrake',
        icon: '🐌',
        title: 'Parking Brake Award',
        subtitle: 'Most Chill on the Clock',
        vid: chill.id,
        holder: formatHolder(chill),
        strat: chill.human ? 'Human' : chill.strategy,
        human: chill.human,
        mine: chill.id === myVid,
        value: chillShipped,
        statText: `${chillShipped} shipped · ${Math.round(chill.sPts ?? 0)} pts`,
        caption: 'Taking the scenic route and enjoying a stress-free warehouse tour.',
      }
    : {
        id: 'parkingBrake',
        icon: '🐌',
        title: 'Parking Brake Award',
        subtitle: 'Most Chill on the Clock',
        vid: null,
        holder: 'No Vehicles Active',
        strat: null,
        human: false,
        mine: false,
        value: 0,
        statText: '—',
        caption: 'Waiting for vehicles to roll onto the floor.',
      };

  return [
    crashesAward,
    dropsAward,
    skidsAward,
    nearMissAward,
    lowBatteryAward,
    parkingBrakeAward,
  ];
}

const MODAL_TABS: ReadonlyArray<{ id: LeaderboardModalTab; label: string }> = [
  { id: 'all', label: 'All (Dashboard)' },
  { id: 'standings', label: '🏁 Shift Standings' },
  { id: 'silly', label: '🤪 Silly Superlatives' },
  { id: 'hall', label: '🏛️ Hall of Fame' },
  { id: 'network', label: '🌐 Network Lifetime' },
];

export function mountLeaderboardModal(overlay: HTMLElement, ctx: UiCtx): UiModule {
  const { store, actions } = ctx;

  const subtitleEl = el('p', {
    class: 'intro-subtitle muted',
    text: 'Live shift standings, silly floor superlatives, site hall of fame, and cross-site lifetime records.',
  });
  const callsignBadge = el('span', {
    class: 'lb-modal-callsign-pill num',
    attrs: { 'data-role': 'modal-callsign' },
    text: '',
  });

  const tabButtons = MODAL_TABS.map((t) => {
    const b = button(t.label, 'btn small', () => actions.showLeaderboardModal(true, t.id));
    b.dataset.lbTab = t.id;
    b.setAttribute('role', 'tab');
    return { id: t.id, b };
  });

  const closeBtn = button('✕ Close [Esc]', 'btn drive', () => actions.showLeaderboardModal(false));
  closeBtn.dataset.action = 'close-leaderboard-modal';

  const bodyEl = el('div', { class: 'lb-modal-body' });
  const bodyView = new KeyedView(bodyEl);

  const card = el(
    'div',
    {
      class: 'hud help-card intro-modal lb-modal-card',
      attrs: { role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'lbModalTitle' },
    },
    [
      el('div', { class: 'help-head intro-head' }, [
        el('div', { class: 'intro-head__titles' }, [
          el('div', {
            class: 'intro-eyebrow',
            text: 'LIVE SHIFT STANDINGS · SILLY SUPERLATIVES · NETWORK HALL OF FAME',
          }),
          el('div', { class: 'lb-modal-title-row' }, [
            el('h2', {
              text: '🏆 Warehouse Leaderboard & Floor Awards',
              attrs: { id: 'lbModalTitle' },
            }),
            callsignBadge,
          ]),
          subtitleEl,
        ]),
        el('div', { class: 'intro-head__actions' }, [
          el(
            'div',
            { class: 'intro-tabs', attrs: { role: 'tablist', 'aria-label': 'Leaderboard sections' } },
            tabButtons.map((t) => t.b),
          ),
          closeBtn,
        ]),
      ]),
      bodyEl,
    ],
  );

  overlay.replaceChildren(card);
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) actions.showLeaderboardModal(false);
  });

  function renderStandingsPane(): HTMLElement {
    const w = store.world;
    const myVid = store.renderMyVid();
    const lb = leaderboard(w);
    const byId = new Map<string, Vehicle>();
    for (const v of w.vehicles) byId.set(v.id, v);

    const rows = lb.map((r, idx) => {
      const v = byId.get(r.id);
      const mine = r.id === myVid;
      const who = r.human && r.driver ? `${r.driver} (${r.id})` : r.id;
      const bat = v ? Math.round(v.battery) : 100;
      const crashes = v?.incidents ?? r.incidents ?? 0;
      const nearMisses = v?.nearMisses ?? 0;
      const skids = v?.skids ?? 0;
      const drops = v?.palletDrops ?? 0;
      const streak = v?.streak ?? r.streak ?? 0;
      const ppm = r.ppm ?? 0;
      const teamLabel = r.human
        ? r.runMode === 'freerange'
          ? '🌐 Free Range'
          : '⏱️ 5m Blitz'
        : r.strat;
      return el(
        'tr',
        {
          class: `lb-table-row${mine ? ' row-hl b' : r.human ? ' lb-table-row--human' : ''}`,
          title: `Click to inspect ${r.id} on the floor`,
          onClick: () => {
            actions.select(r.id);
            actions.showLeaderboardModal(false);
          },
        },
        [
          el('td', { class: 'num muted', text: `#${idx + 1}` }),
          el('td', {}, [
            el('div', { class: 'lb-driver-cell' }, [
              swatch(r.human ? teamColor('Human') : teamColor(r.strat)),
              el('span', { text: who }),
              mine ? el('span', { class: 'tag lb-you-tag', text: '★ YOU' }) : null,
              r.human && !mine ? el('span', { class: 'tag', text: 'driver' }) : null,
            ]),
          ]),
          el('td', { class: 'muted small', text: teamLabel }),
          el('td', { class: 'r num b', text: String(Math.round(r.pts)) }),
          el('td', { class: 'r num', text: String(r.shipped) }),
          el('td', { class: 'r num muted', text: `${ppm.toFixed(1)}` }),
          el('td', { class: `r num${streak >= 3 ? ' b' : ' muted'}`, text: streak > 0 ? `🔥×${streak}` : '—' }),
          el('td', { class: `r num${crashes > 0 ? ' bad' : ' muted'}`, text: String(crashes) }),
          el('td', { class: `r num${drops > 0 ? ' warn' : ' muted'}`, text: String(drops) }),
          el('td', { class: `r num${skids > 0 ? ' warn' : ' muted'}`, text: String(skids) }),
          el('td', { class: 'r num muted', text: String(nearMisses) }),
          el('td', {
            class: `r num${bat <= 20 ? ' bad' : ''}`,
            text: `${bat}%`,
          }),
        ],
      );
    });

    return el(
      'section',
      {
        class: 'intro-pane lb-modal-pane',
        attrs: { 'data-pane': 'standings', 'aria-label': 'Live Shift Standings' },
      },
      [
        el('div', { class: 'lb-pane-head' }, [
          el('h3', { class: 'intro-pane__title', text: '🏁 Live Shift Standings (This Site)' }),
          el('span', {
            class: 'muted small num',
            text: `Shift ends in ${shiftLeft(w.t)} · ${lb.length} vehicles`,
          }),
        ]),
        el('p', {
          class: 'hint',
          text: '+10 pts per pallet, +40 pts P0 critical, streak multiplier up to 1.5× (3/5/8 on-time), +6 pts Returns & QA containment, +5 pts cross-site stow, −15 pts per crash.',
        }),
        rows.length
          ? el('div', { class: 'lb-table-scroll' }, [
              el('table', { class: 'lb-modal-table num' }, [
                el('thead', {}, [
                  el('tr', {}, [
                    el('th', { text: '#' }),
                    el('th', { text: 'Callsign / Forklift' }),
                    el('th', { text: 'Mode / Team' }),
                    el('th', { class: 'r', text: 'Pts' }),
                    el('th', { class: 'r', text: 'Shipped' }),
                    el('th', { class: 'r', title: 'Pallets shipped per minute', text: 'PPM' }),
                    el('th', { class: 'r', title: 'Consecutive on-time delivery streak', text: '🔥 Streak' }),
                    el('th', { class: 'r', title: 'Collisions (−15 pts each)', text: '💥 Crashes' }),
                    el('th', { class: 'r', title: 'Boost collision pallet drops', text: '📦 Drops' }),
                    el('th', { class: 'r', title: 'Floor spill skids', text: '🍌 Skids' }),
                    el('th', { class: 'r', title: 'Close calls in aisles', text: '😱 Near' }),
                    el('th', { class: 'r', text: '🔋 Bat' }),
                  ]),
                ]),
                el('tbody', {}, rows),
              ]),
            ])
          : el('div', { class: 'empty', text: 'No vehicles on the floor yet.' }),
      ],
    );
  }

  function renderSillyPane(): HTMLElement {
    const w = store.world;
    const myVid = store.renderMyVid();
    const awards = computeSillyAwards(w, myVid);
    const t = w.totals;

    return el(
      'section',
      {
        class: 'intro-pane lb-modal-pane',
        attrs: { 'data-pane': 'silly', 'aria-label': 'Silly Superlatives' },
      },
      [
        el('div', { class: 'lb-pane-head' }, [
          el('h3', {
            class: 'intro-pane__title',
            text: '🤪 Silly Superlatives — Floor Wall of Shame & Glory',
          }),
          el('span', {
            class: 'muted small num',
            text: `Site totals: ${t.incidents} crashes · ${t.palletDrops ?? 0} pallet drops · ${t.skids ?? 0} skids · ${t.nearMisses} near misses`,
          }),
        ]),
        el('p', {
          class: 'hint',
          text: 'Live lighthearted awards tracked from real 10 Hz warehouse physics—boost into a rack with cargo, drift through a floor spill, or run your battery down to 1% to claim a trophy!',
        }),
        el(
          'div',
          { class: 'silly-awards-grid' },
          awards.map((a) =>
            el(
              'article',
              {
                class: `silly-award-card${a.mine ? ' silly-award-card--mine' : ''}${a.vid ? ' silly-award-card--clickable' : ''}`,
                attrs: { 'data-award': a.id },
                title: a.vid ? `Click to inspect ${a.vid} on the floor` : a.title,
                onClick: () => {
                  if (a.vid) {
                    actions.select(a.vid);
                    actions.showLeaderboardModal(false);
                  }
                },
              },
              [
                el('div', { class: 'silly-award-card__head' }, [
                  el('span', { class: 'silly-award-icon', text: a.icon }),
                  el('div', { class: 'silly-award-titles' }, [
                    el('h4', { class: 'silly-award-title', text: a.title }),
                    el('span', { class: 'muted small', text: a.subtitle }),
                  ]),
                  el('span', { class: 'tag silly-award-stat num', text: a.statText }),
                ]),
                el('div', { class: 'silly-award-holder' }, [
                  a.strat ? swatch(a.human ? teamColor('Human') : teamColor(a.strat)) : null,
                  el('b', { text: a.holder }),
                  a.mine ? el('span', { class: 'tag lb-you-tag', text: '★ YOU' }) : null,
                ]),
                el('p', { class: 'silly-award-caption muted small', text: a.caption }),
              ],
            ),
          ),
        ),
      ],
    );
  }

  function renderHallPane(): HTMLElement {
    const w = store.world;
    return el(
      'section',
      {
        class: 'intro-pane lb-modal-pane',
        attrs: { 'data-pane': 'hall', 'aria-label': 'Site Hall of Fame' },
      },
      [
        el('div', { class: 'lb-pane-head' }, [
          el('h3', { class: 'intro-pane__title', text: '🏛️ Site Hall of Fame (Past Shift Winners)' }),
          el('span', {
            class: 'muted small num',
            text: `${w.totals.wins} human wins in ${w.totals.humanShifts} shifts`,
          }),
        ]),
        w.hallOfFame.length
          ? el(
              'div',
              { class: 'lb-hall-list' },
              w.hallOfFame.slice(0, 10).map((h, i) =>
                el('div', { class: `lb-row num${h.human ? ' row-hl b' : ''}` }, [
                  el('span', { class: 'rank muted', text: `#${i + 1}` }),
                  swatch(h.human ? teamColor('Human') : teamColor(h.strat)),
                  el('span', { class: 'grow ellipsis' }, [
                    `${h.human && h.driver ? h.driver : h.id}${h.human ? ' ★' : ''} `,
                    el('span', {
                      class: 'muted small',
                      text: `${h.strat} · ${h.shift} · ${difficultyLabel(h.diff)}`,
                    }),
                  ]),
                  el('span', { class: 'pts b', text: `${h.scored} pts` }),
                ]),
              ),
            )
          : el('div', {
              class: 'empty',
              text: 'No shifts have finished on this site yet—win the current 8h shift to etch your callsign into the Hall of Fame!',
            }),
      ],
    );
  }

  function renderNetworkPane(): HTMLElement {
    const entries = store.network.leaderboard.filter((e) => !e.isBot).slice(0, 20);
    return el(
      'section',
      {
        class: 'intro-pane lb-modal-pane',
        attrs: { 'data-pane': 'network', 'aria-label': 'Network Lifetime Leaderboard' },
      },
      [
        el('div', { class: 'lb-pane-head' }, [
          el('h3', {
            class: 'intro-pane__title',
            text: '🌐 Network Lifetime Leaderboard (All Sites)',
          }),
          button('↻ Refresh', 'btn small', () => actions.refreshNetwork(), 'Refresh /api/network'),
        ]),
        el('p', {
          class: 'hint',
          text: 'Best 5-Min Blitz scores, normalized pace (PPM), and cumulative lifetime points across DEN-1, SLC-2, PHX-3, and ABQ-4.',
        }),
        entries.length
          ? el(
              'div',
              { class: 'lb-hall-list' },
              entries.map((e, i) => {
                const mine = store.you?.clientId === e.clientId;
                const blitzBadge =
                  typeof e.bestBlitzPts === 'number' && e.bestBlitzPts > 0
                    ? `⏱️ Best Blitz: ${Math.round(e.bestBlitzPts)} pts · `
                    : '';
                const ppmBadge =
                  typeof e.ppm === 'number' && e.ppm > 0 ? `${e.ppm.toFixed(1)} PPM · ` : '';
                return el('div', { class: `lb-row num${mine ? ' row-hl b' : ''}` }, [
                  el('span', { class: 'rank muted', text: `#${i + 1}` }),
                  swatch(teamColor('Human')),
                  el('span', {
                    class: 'grow ellipsis',
                    text: `${e.name}${e.siteId ? ` · ${e.siteId.toUpperCase()}` : ''}${mine ? ' ★ you' : ''}`,
                  }),
                  el('span', {
                    class: 'muted small',
                    text: `${blitzBadge}${ppmBadge}${e.deliveries} shipped`,
                  }),
                  el('span', {
                    class: 'pts b',
                    text: `${Math.round(e.lifetimePoints ?? e.points ?? 0)} pts`,
                  }),
                ]);
              }),
            )
          : el('div', {
              class: 'empty',
              text: store.network.error ?? 'No network lifetime entries recorded yet.',
            }),
      ],
    );
  }

  function renderModalContent(tab: LeaderboardModalTab): Child[] {
    if (!store.welcomed) {
      return [el('div', { class: 'empty', text: 'Waiting for live warehouse telemetry…' })];
    }
    switch (tab) {
      case 'standings':
        return [el('div', { class: 'lb-modal-single' }, [renderStandingsPane()])];
      case 'silly':
        return [el('div', { class: 'lb-modal-single' }, [renderSillyPane()])];
      case 'hall':
        return [el('div', { class: 'lb-modal-single' }, [renderHallPane()])];
      case 'network':
        return [el('div', { class: 'lb-modal-single' }, [renderNetworkPane()])];
      case 'all':
      default:
        return [
          el('div', { class: 'lb-modal-grid' }, [
            renderStandingsPane(),
            renderSillyPane(),
            renderHallPane(),
            renderNetworkPane(),
          ]),
        ];
    }
  }

  return {
    update() {
      const open = store.ui.leaderboardModalOpen;
      if (!open) {
        if (!overlay.hidden) overlay.hidden = true;
        return;
      }
      const wasHidden = overlay.hidden;
      overlay.hidden = false;
      const tab = store.ui.leaderboardModalTab;
      for (const t of tabButtons) {
        const on = t.id === tab;
        t.b.classList.toggle('on', on);
        t.b.setAttribute('aria-selected', String(on));
      }
      const myName = store.you?.name;
      callsignBadge.textContent = myName ? `Your Callsign: ${myName}` : '';
      callsignBadge.hidden = !myName;

      const w = store.world;
      const vKey = w.vehicles
        .map(
          (v) =>
            `${v.id}:${Math.round(v.sPts)}:${v.sShipped}:${v.incidents}:${v.palletDrops ?? 0}:${v.skids ?? 0}:${v.nearMisses}:${Math.round(v.battery)}:${v.state}`,
        )
        .join(',');
      const key = `${store.welcomed}|${tab}|${Math.floor(w.t)}|${vKey}|${w.hallOfFame.length}|${store.network.updatedAt}|${store.you?.name ?? ''}`;
      bodyView.render(key, () => renderModalContent(tab));
      if (wasHidden) closeBtn.focus();
    },
  };
}
