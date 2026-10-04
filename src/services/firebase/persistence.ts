/**
 * Firebase-backed product data.
 *
 * ## The state boundary
 *
 * This module is the durable product definition. It is not the runtime.
 *
 * ```
 *   FIREBASE                     WHAT DOES THE USER HAVE?
 *     goat definition            what the agent is for and how it is set up
 *     deployment definition      which market, which mode, which account
 *     tracker configuration      the conditions, their resolution, their version
 *     ownership                  who may read or write any of it
 *     history                    backtests, deployments, plans — durable
 *
 *   DURABLE OBJECT               WHAT IS THIS DEPLOYED TRACKER DOING NOW?
 *     last evaluation            when it last looked, and what it saw
 *     cooldowns                  what it is not allowed to report yet
 *     pending wake               a request to act that must not be lost
 *     last heartbeat             whether it is alive at all
 *     in-flight state            an operation that must not be repeated
 *     recovery metadata          generation, config version it last applied
 * ```
 *
 * Two rules make that boundary hold rather than merely being described:
 *
 *   1. **Nothing here is high-frequency.** A tracker evaluation, a price tick
 *      and an agent log line all belong to the runtime. Writing them here would
 *      cost money per event and answer no question a user has. So there is no
 *      write path in this file that a per-minute tick would want to use.
 *   2. **Configuration changes flow one way.** This module is the source of
 *      truth for a tracker *definition*; the runtime holds the truth for what
 *      that tracker is currently doing. A configuration edit bumps
 *      `configurationVersion`, which is the same value the runtime keys its work
 *      on, so the two cannot quietly diverge — and the runtime transitions to
 *      the new version rather than being restarted into a second one.
 *
 * ## Ownership
 *
 * Every document lives under `users/{uid}/…`. That is not a convenience: it is
 * what lets a Firestore rule deny cross-user access without this application
 * remembering to check, and it is asserted against the rules file in the test
 * suite rather than left to agreement.
 */

import {
  OWNED_COLLECTIONS,
  SCHEMA_VERSION,
  ownedPath,
  type DeploymentRecord,
  type FirebaseStore,
  type GoatRecord,
  type HistoryRecord,
  type OwnedCollection,
  type PreferenceRecord,
  type TrackerRecord,
} from './contract';

export {
  SCHEMA_VERSION,
  OWNED_COLLECTIONS,
  ownedPath,
  type DeploymentRecord,
  type GoatRecord,
  type HistoryRecord,
  type PreferenceRecord,
  type TrackerRecord,
  type OwnedCollection,
};

/** Everything the repository writes needs an owner and a clock. */
interface Owned {
  ownerId: string;
  schemaVersion: number;
  createdAt: number;
  updatedAt: number;
}

export class PersistenceError extends Error {
  constructor(
    message: string,
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'PersistenceError';
  }
}

/**
 * The application's data operations.
 *
 * Every method requires the signed-in user's id and takes it from the caller
 * rather than reading a global, which is what makes ownership checkable: there
 * is no code path that can write somewhere it did not name.
 */
export class PersistenceService {
  constructor(
    private readonly store: FirebaseStore | undefined,
    private readonly clock: () => number = () => Date.now(),
    readonly unavailableReason: string | null = null,
  ) {}

  get available(): boolean {
    return this.store !== undefined;
  }

  private require(): FirebaseStore {
    if (!this.store) {
      throw new PersistenceError(
        this.unavailableReason ?? 'Data persistence is not configured for this build.',
      );
    }
    return this.store;
  }

  // ---------------------------------------------------------------------
  // GOATs
  // ---------------------------------------------------------------------

  /**
   * Create a GOAT.
   *
   * `id` is the caller's to choose and must be stable: the goal id is the join
   * key between this record, the runtime's deployment and the tracker tier, and
   * a generated id here would orphan the two the moment the user reloaded.
   */
  async createGoat(ownerId: string, input: Omit<GoatRecord, 'ownerId' | 'schemaVersion' | 'createdAt' | 'updatedAt'>): Promise<GoatRecord> {
    if (!ownerId) throw new PersistenceError('A GOAT needs an owner.');
    if (!input.id) throw new PersistenceError('A GOAT needs a stable id.');
    const now = this.clock();
    const record: GoatRecord = {
      ...input,
      ownerId,
      schemaVersion: SCHEMA_VERSION,
      createdAt: now,
      updatedAt: now,
      status: input.status ?? 'UNDEPLOYED',
    };
    return this.require().create<GoatRecord>('goats', record);
  }

  listGoats(ownerId: string): Promise<GoatRecord[]> {
    this.require();
    return this.store!.list<GoatRecord>('goats');
  }

  getGoat(ownerId: string, goatId: string): Promise<GoatRecord | undefined> {
    this.require();
    return this.store!.get<GoatRecord>('goats', goatId);
  }

  async updateGoat(ownerId: string, goatId: string, patch: Partial<GoatRecord>): Promise<GoatRecord> {
    this.require();
    return this.store!.update<GoatRecord>('goats', goatId, {
      ...patch,
      ownerId,
      updatedAt: this.clock(),
    });
  }

  /**
   * Delete a GOAT and everything hanging off it.
   *
   * The cascade is not a convenience, it is correctness: a deployment or a
   * tracker whose GOAT is gone is an orphan that still reads as "active" to
   * anything that lists by owner. Children first, parent last, so a failure part
   * way leaves the parent visible rather than the reverse.
   */
  async deleteGoat(ownerId: string, goatId: string): Promise<{ deployments: number; trackers: number }> {
    this.require();
    const deployments = (await this.store!.list<DeploymentRecord>('deployments')).filter(
      (deployment) => deployment.goatId === goatId,
    );
    let trackers = 0;
    for (const deployment of deployments) {
      trackers += (await this.store!.listChildren<TrackerRecord>('deployments', deployment.id, 'trackers')).length;
      await this.store!.removeChildren('deployments', deployment.id, 'trackers');
      await this.store!.remove('deployments', deployment.id);
    }
    await this.store!.remove('goats', goatId);
    return { deployments: deployments.length, trackers };
  }

  // ---------------------------------------------------------------------
  // Deployments
  // ---------------------------------------------------------------------

  /**
   * Add a deployment.
   *
   * When it is created *active*, this writes two documents in one batch: the
   * deployment, and the GOAT's `activeDeploymentId` pointing at it. That is not
   * tidiness — it is the mechanism the rules use to allow exactly one active
   * deployment per GOAT, and a single-document write would be denied. Two tabs
   * racing to start the same GOAT cannot both win, because the second one would
   * write a pointer that no longer matches its own claim.
   */
  async addDeployment(
    ownerId: string,
    input: Omit<DeploymentRecord, 'ownerId' | 'schemaVersion' | 'createdAt' | 'updatedAt'>,
  ): Promise<DeploymentRecord> {
    this.require();
    if (!input.id) throw new PersistenceError('A deployment needs a stable id.');
    const now = this.clock();
    const record: DeploymentRecord = {
      ...input,
      ownerId,
      schemaVersion: SCHEMA_VERSION,
      createdAt: now,
      updatedAt: now,
    };

    if (record.status === 'active') {
      await this.store!
        .batch()
        .put<DeploymentRecord>('deployments', record)
        .claimActiveDeployment(record.goatId, record.id, now)
        .commit();
    } else {
      await this.store!.create<DeploymentRecord>('deployments', record);
    }
    return record;
  }

  listDeployments(ownerId: string): Promise<DeploymentRecord[]> {
    this.require();
    return this.store!.list<DeploymentRecord>('deployments');
  }

  getDeployment(ownerId: string, deploymentId: string): Promise<DeploymentRecord | undefined> {
    this.require();
    return this.store!.get<DeploymentRecord>('deployments', deploymentId);
  }

  /**
   * Update a deployment.
   *
   * Becoming active takes the same batched path as being created active, for the
   * same reason: the rules require the GOAT's pointer to name this deployment in
   * the same atomic write.
   *
   * Leaving the active state also clears the pointer — but only when it actually
   * names this deployment. Clearing it unconditionally would let a stale tab
   * deactivate the *new* deployment by stopping an old one.
   */
  async updateDeployment(
    ownerId: string,
    deploymentId: string,
    patch: Partial<DeploymentRecord>,
  ): Promise<DeploymentRecord> {
    this.require();
    const now = this.clock();
    const update = { ...patch, ownerId, updatedAt: now };

    const existing = await this.store!.get<DeploymentRecord>('deployments', deploymentId);
    const becomingActive = patch.status === 'active' && existing?.status !== 'active';
    const leavingActive = existing?.status === 'active' && patch.status !== undefined && patch.status !== 'active';

    if (becomingActive) {
      const updated = { ...existing, ...update } as DeploymentRecord;
      await this.store!
        .batch()
        .put<DeploymentRecord>('deployments', updated)
        .claimActiveDeployment(updated.goatId, deploymentId, now)
        .commit();
      return updated;
    }

    if (leavingActive) {
      const goat = await this.store!.get<GoatRecord>('goats', existing.goatId);
      if (goat?.activeDeploymentId === deploymentId) {
        const updated = { ...existing, ...update } as DeploymentRecord;
        await this.store!
          .batch()
          .put<DeploymentRecord>('deployments', updated)
          // Naming the deployment makes the release conditional, so a stale tab
          // cannot clear a pointer that has since been claimed by another one.
          .releaseActiveDeployment(existing.goatId, now, deploymentId)
          .commit();
        return updated;
      }
    }

    return this.store!.update<DeploymentRecord>('deployments', deploymentId, update);
  }

  /**
   * Delete a deployment.
   *
   * The caller is responsible for stopping the runtime *before* calling this —
   * see `GoatOrchestrator.undeployGoat`, which cancels trackers and unregisters
   * the executor first. That order is deliberate and is asserted in the runtime
   * tests: a deployment record that disappears while its tracker is still armed
   * leaves an object that keeps evaluating a configuration nobody can see, which
   * is the orphan this method cannot reach on its own.
   */
  async deleteDeployment(ownerId: string, deploymentId: string): Promise<{ trackers: number }> {
    this.require();
    const trackers = (await this.store!.listChildren<TrackerRecord>('deployments', deploymentId, 'trackers')).length;
    await this.store!.removeChildren('deployments', deploymentId, 'trackers');

    /*
     * The GOAT's pointer is released in the same batch as the deletion.
     *
     * Leaving it behind would make the GOAT permanently unactivatable: every
     * future activation would be denied by the rules because the pointer names a
     * deployment that no longer exists, and nothing in the UI explains why a
     * button that says "start" cannot start.
     */
    const existing = await this.store!.get<DeploymentRecord>('deployments', deploymentId);
    const goat = existing ? await this.store!.get<GoatRecord>('goats', existing.goatId) : undefined;
    if (existing && goat?.activeDeploymentId === deploymentId) {
      await this.store!
        .batch()
        .remove('deployments', deploymentId)
        .releaseActiveDeployment(existing.goatId, this.clock(), deploymentId)
        .commit();
    } else {
      await this.store!.remove('deployments', deploymentId);
    }
    return { trackers };
  }

  // ---------------------------------------------------------------------
  // Trackers
  // ---------------------------------------------------------------------

  /**
   * Create or replace a tracker's configuration.
   *
   * The document id is the tracker's own id, so an edit updates one document
   * rather than adding a second watch. That is the whole duplicate-prevention
   * story on this side of the boundary: the runtime tier is keyed on
   * `(userId, goatId, deploymentId)`, and the tracker list hangs off the
   * deployment, so there is exactly one place a tracker's configuration can
   * live.
   */
  async saveTracker(
    ownerId: string,
    deploymentId: string,
    input: Omit<TrackerRecord, 'ownerId' | 'schemaVersion' | 'createdAt' | 'updatedAt' | 'configurationVersion'> & {
      configurationVersion?: number;
    },
  ): Promise<TrackerRecord> {
    this.require();
    const now = this.clock();
    const existing = await this.store!.getChild<TrackerRecord>('deployments', deploymentId, 'trackers', input.id);
    const record: TrackerRecord = {
      ...input,
      ownerId,
      schemaVersion: SCHEMA_VERSION,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
      // Monotonic, and never taken from the caller: a configuration version
      // that can go backwards is a version the runtime cannot order.
      configurationVersion: Math.max(input.configurationVersion ?? 0, (existing?.configurationVersion ?? 0) + 1),
    };
    await this.store!.setChild<TrackerRecord>('deployments', deploymentId, 'trackers', record);
    return record;
  }

  listTrackers(ownerId: string, deploymentId: string): Promise<TrackerRecord[]> {
    this.require();
    return this.store!.listChildren<TrackerRecord>('deployments', deploymentId, 'trackers');
  }

  async updateTracker(
    ownerId: string,
    deploymentId: string,
    trackerId: string,
    patch: Partial<TrackerRecord>,
  ): Promise<TrackerRecord> {
    this.require();
    const existing = await this.store!.getChild<TrackerRecord>('deployments', deploymentId, 'trackers', trackerId);
    if (!existing) throw new PersistenceError(`Unknown tracker ${trackerId}.`);
    const record: TrackerRecord = {
      ...existing,
      ...patch,
      id: trackerId,
      ownerId,
      schemaVersion: SCHEMA_VERSION,
      updatedAt: this.clock(),
      configurationVersion: Math.max(existing.configurationVersion + 1, patch.configurationVersion ?? 0),
    };
    await this.store!.setChild<TrackerRecord>('deployments', deploymentId, 'trackers', record);
    return record;
  }

  async deleteTracker(ownerId: string, deploymentId: string, trackerId: string): Promise<void> {
    this.require();
    await this.store!.removeChild('deployments', deploymentId, 'trackers', trackerId);
  }

  // ---------------------------------------------------------------------
  // History and preferences
  // ---------------------------------------------------------------------

  /**
   * Append a durable history record.
   *
   * Bounded on purpose: the caller passes a summary and a small metric set.
   * Anything that grows with the length of a run — a log, a tick series — does
   * not belong here and must not be passed in.
   */
  async appendHistory(ownerId: string, input: Omit<HistoryRecord, 'ownerId' | 'schemaVersion' | 'at'>): Promise<HistoryRecord> {
    this.require();
    const record: HistoryRecord = {
      ...input,
      ownerId,
      schemaVersion: SCHEMA_VERSION,
      at: this.clock(),
    };
    return this.store!.create<HistoryRecord>('history', record);
  }

  listHistory(ownerId: string, options: { limit?: number } = {}): Promise<HistoryRecord[]> {
    this.require();
    return this.store!.list<HistoryRecord>('history', options);
  }

  savePreferences(ownerId: string, patch: Omit<PreferenceRecord, 'ownerId' | 'schemaVersion' | 'updatedAt'>): Promise<PreferenceRecord> {
    this.require();
    const record: PreferenceRecord = {
      ...patch,
      ownerId,
      schemaVersion: SCHEMA_VERSION,
      updatedAt: this.clock(),
    };
    return this.store!.set<PreferenceRecord>('preferences', record);
  }

  getPreferences(ownerId: string): Promise<PreferenceRecord | undefined> {
    this.require();
    return this.store!.get<PreferenceRecord>('preferences', 'current');
  }
}
