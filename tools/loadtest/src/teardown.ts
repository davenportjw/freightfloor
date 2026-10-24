import { Firestore } from '@google-cloud/firestore';
import { SITE_IDS } from '@warehouse/protocol';

export interface TeardownOptions {
  projectId?: string;
  prefix?: string;
  resetSnapshots?: boolean;
  customStore?: TeardownStore;
}

export interface TeardownReport {
  deletedPlayerDocs: number;
  resetSnapshotDocs: number;
}

export interface TeardownStore {
  listPlayers(): Promise<Array<{ id: string; name?: string; clientId?: string }>>;
  deletePlayers(ids: string[]): Promise<void>;
  resetSiteSnapshots(siteIds: readonly string[]): Promise<number>;
}

const TEST_PREFIXES = ['loadtest-', 'pilot-', 'smoke-'] as const;

export function isTestPlayerDoc(doc: {
  id: string;
  name?: string;
  clientId?: string;
}): boolean {
  const candidates = [doc.id, doc.name ?? '', doc.clientId ?? ''];
  return candidates.some((val) => TEST_PREFIXES.some((p) => val.startsWith(p)));
}

class FirestoreTeardownStore implements TeardownStore {
  private readonly db: Firestore;
  private readonly prefix: string;

  constructor(projectId: string, prefix: string) {
    this.db = new Firestore({ projectId });
    this.prefix = prefix;
  }

  public async listPlayers(): Promise<
    Array<{ id: string; name?: string; clientId?: string }>
  > {
    const snap = await this.db.collection(`${this.prefix}players`).get();
    return snap.docs.map((d) => {
      const data = d.data();
      return {
        id: d.id,
        name: typeof data?.name === 'string' ? data.name : undefined,
        clientId: typeof data?.clientId === 'string' ? data.clientId : undefined,
      };
    });
  }

  public async deletePlayers(ids: string[]): Promise<void> {
    if (ids.length === 0) return;
    const col = this.db.collection(`${this.prefix}players`);
    for (let i = 0; i < ids.length; i += 400) {
      const chunk = ids.slice(i, i + 400);
      const batch = this.db.batch();
      for (const id of chunk) {
        batch.delete(col.doc(id));
      }
      await batch.commit();
    }
  }

  public async resetSiteSnapshots(siteIds: readonly string[]): Promise<number> {
    let count = 0;
    const batch = this.db.batch();
    for (const siteId of siteIds) {
      const ref = this.db
        .collection(`${this.prefix}sites`)
        .doc(siteId)
        .collection('snapshots')
        .doc('latest');
      batch.delete(ref);
      count++;
    }
    if (count > 0) {
      await batch.commit();
    }
    return count;
  }
}

export async function runLoadtestTeardown(
  options: TeardownOptions = {}
): Promise<TeardownReport> {
  const projectId = options.projectId ?? process.env.GCP_PROJECT_ID ?? 'davenporter-freightfloor';
  const prefix = options.prefix ?? process.env.FIRESTORE_PREFIX ?? '';
  const resetSnapshots = options.resetSnapshots ?? true;

  const store = options.customStore ?? new FirestoreTeardownStore(projectId, prefix);
  const players = await store.listPlayers();
  const toDelete = players.filter(isTestPlayerDoc).map((p) => p.id);

  await store.deletePlayers(toDelete);

  let resetSnapshotDocs = 0;
  if (resetSnapshots) {
    resetSnapshotDocs = await store.resetSiteSnapshots(SITE_IDS);
  }

  return {
    deletedPlayerDocs: toDelete.length,
    resetSnapshotDocs,
  };
}
