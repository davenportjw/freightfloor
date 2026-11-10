/**
 * Retention report from the lobby's per-player return-visit ledger (`players/{clientId}`:
 * `firstSeenDay`, `lastSeenDay`, `activeDays`, written by lobby `recordVisit`).
 *
 * The ledger keeps first/last day and a count, not every active day, so this reports
 * **unbounded** retention: the share of an eligible cohort that came back on or after day N
 * (`lastSeenDay - firstSeenDay >= N`). Classic "active exactly on day N" retention lives in GA4
 * (cohort exploration over `return_visit`).
 *
 * Read-only: queries Firestore with ADC and creates no resources.
 *
 *   npm run report:retention -- [--as-of YYYY-MM-DD] [--json]
 */
import { Firestore } from '@google-cloud/firestore';
import { addDays, dayKey, daysBetween, DAY_KEY_PATTERN } from '@warehouse/protocol';
import { fileURLToPath } from 'node:url';

export interface LedgerRow {
  firstSeenDay?: unknown;
  lastSeenDay?: unknown;
  activeDays?: unknown;
  isBot?: unknown;
  name?: unknown;
}

export interface RetentionBucket {
  day: number;
  /** Players whose first day is at least `day` days before `asOf`. */
  eligible: number;
  returned: number;
  /** returned / eligible, or null when nobody is eligible yet. */
  rate: number | null;
}

export interface RetentionReport {
  asOf: string;
  players: number;
  skipped: number;
  meanActiveDays: number | null;
  buckets: RetentionBucket[];
}

const BOT_PREFIXES = ['loadtest-', 'pilot-', 'smoke-'];
const isDay = (v: unknown): v is string => typeof v === 'string' && DAY_KEY_PATTERN.test(v);

export function computeRetention(
  rows: Iterable<LedgerRow>,
  asOf: string,
  days: readonly number[] = [1, 7, 30],
): RetentionReport {
  const ledgers: Array<{ first: string; last: string; active: number }> = [];
  let skipped = 0;
  for (const r of rows) {
    const name = typeof r.name === 'string' ? r.name.toLowerCase() : '';
    if (r.isBot === true || BOT_PREFIXES.some((p) => name.startsWith(p))) continue;
    if (!isDay(r.firstSeenDay) || !isDay(r.lastSeenDay) || r.firstSeenDay > asOf) {
      skipped++;
      continue;
    }
    const active = typeof r.activeDays === 'number' && r.activeDays >= 1 ? r.activeDays : 1;
    ledgers.push({ first: r.firstSeenDay, last: r.lastSeenDay, active });
  }
  const buckets = days.map((day) => {
    const cutoff = addDays(asOf, -day);
    const eligible = ledgers.filter((l) => l.first <= cutoff);
    const returned = eligible.filter((l) => daysBetween(l.first, l.last) >= day).length;
    return {
      day,
      eligible: eligible.length,
      returned,
      rate: eligible.length ? returned / eligible.length : null,
    };
  });
  return {
    asOf,
    players: ledgers.length,
    skipped,
    meanActiveDays: ledgers.length
      ? ledgers.reduce((s, l) => s + l.active, 0) / ledgers.length
      : null,
    buckets,
  };
}

export function formatRetention(r: RetentionReport): string {
  const pct = (x: number | null) => (x === null ? '   n/a' : `${(x * 100).toFixed(1).padStart(5)}%`);
  const lines = [
    `Freight Floor retention as of ${r.asOf} (UTC days, unbounded)`,
    `players with a ledger: ${r.players}  (skipped without ledger: ${r.skipped})`,
    `mean active days: ${r.meanActiveDays === null ? 'n/a' : r.meanActiveDays.toFixed(2)}`,
    '',
    '  day  eligible  returned    rate',
    ...r.buckets.map(
      (b) =>
        `  D${String(b.day).padEnd(3)} ${String(b.eligible).padStart(8)}  ${String(b.returned).padStart(8)}  ${pct(b.rate)}`,
    ),
  ];
  return lines.join('\n');
}

async function main(argv: string[]): Promise<void> {
  const asOfIdx = argv.indexOf('--as-of');
  const asOf = asOfIdx >= 0 ? argv[asOfIdx + 1] : dayKey(Date.now());
  if (!isDay(asOf)) throw new Error(`--as-of must be YYYY-MM-DD, got ${asOf}`);
  const db = new Firestore({
    projectId: process.env.GOOGLE_CLOUD_PROJECT || process.env.GCP_PROJECT_ID || 'davenporter-freightfloor',
    databaseId: process.env.FIRESTORE_DATABASE_ID || '(default)',
  });
  const col = `players${process.env.SUFFIX || ''}`;
  const snap = await db
    .collection(col)
    .select('firstSeenDay', 'lastSeenDay', 'activeDays', 'isBot', 'name')
    .get();
  const report = computeRetention(
    snap.docs.map((d) => d.data() as LedgerRow),
    asOf,
  );
  console.log(argv.includes('--json') ? JSON.stringify(report, null, 2) : formatRetention(report));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main(process.argv.slice(2)).catch((err: unknown) => {
    console.error('[report:retention] failed:', err);
    process.exit(1);
  });
}
