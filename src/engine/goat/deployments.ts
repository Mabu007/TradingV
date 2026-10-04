/**
 * Deployment persistence.
 *
 * A GOAT is a goal plus skills. A deployment is the binding of that GOAT
 * to one market, one account, and one execution mode.
 *
 * Keeping them apart is the whole point: the same GOAT is worth having
 * whatever market it is pointed at, and the moment a user commits to a
 * market is the moment they are told what mode it will run in and what
 * it is allowed to do. A GOAT with a market baked into it cannot be
 * reused, and a GOAT with a mode baked into it cannot be tried safely
 * before it is trusted.
 *
 * The record is the existing validated `GoatDeployment`, so a deployment
 * is checked by the same code that has always checked one, and the
 * stores follow the same rules as every other store in this layer: keep
 * what is usable, say what was lost, never let a corrupt entry take down
 * a constructor.
 */

import { GoatDeployment } from './definition';
import { PersistentJsonStore, StoreState, getStorageSafely } from './store';

export interface DeploymentStore {
  save(deployment: GoatDeployment): void;
  get(id: string): GoatDeployment | undefined;
  list(): GoatDeployment[];
  /** The deployment a GOAT is currently running, if any. */
  currentFor(goatId: string): GoatDeployment | undefined;
  /** Every deployment a GOAT has ever had, newest first. */
  historyFor(goatId: string): GoatDeployment[];
  remove(id: string): boolean;
  storageState?: StoreState;
  flush?(): void;
}

function copy<T>(value: T): T {
  if (typeof structuredClone === 'function') {
    try {
      return structuredClone(value);
    } catch {
      /* fall through to JSON */
    }
  }
  return JSON.parse(JSON.stringify(value)) as T;
}

export class InMemoryDeploymentStore implements DeploymentStore {
  private readonly deployments = new Map<string, GoatDeployment>();

  save(deployment: GoatDeployment): void {
    this.deployments.set(deployment.id, copy(deployment));
  }

  get(id: string): GoatDeployment | undefined {
    const found = this.deployments.get(id);
    return found ? copy(found) : undefined;
  }

  list(): GoatDeployment[] {
    return [...this.deployments.values()].map(copy);
  }

  currentFor(goatId: string): GoatDeployment | undefined {
    return this.list()
      .filter((deployment) => deployment.goatId === goatId && deployment.status === 'active')
      .sort((a, b) => b.createdAt - a.createdAt)
      .at(0);
  }

  historyFor(goatId: string): GoatDeployment[] {
    return this.list()
      .filter((deployment) => deployment.goatId === goatId)
      .sort((a, b) => b.createdAt - a.createdAt);
  }

  remove(id: string): boolean {
    return this.deployments.delete(id);
  }
}

export class PersistentDeploymentStore extends PersistentJsonStore<GoatDeployment> implements DeploymentStore {
  private readonly deployments = new Map<string, GoatDeployment>();

  constructor() {
    super('tradinggoats.deployments.v1', 250);
    // After the map exists — see PersistentJsonStore's constructor note.
    this.restoreFromStorage();
  }

  protected snapshot(): GoatDeployment[] {
    return [...this.deployments.values()];
  }

  protected persist(items: GoatDeployment[]): void {
    const storage = getStorageSafely();
    if (!storage) return;
    storage.setItem(this.storageKey, JSON.stringify(items));
  }

  protected isRestorable(item: unknown): boolean {
    if (typeof item !== 'object' || item === null) return false;
    const candidate = item as Partial<GoatDeployment>;
    /*
     * One condition per line, not one `&&` chain: the chain miscompiled
     * under the test runner and rejected every deployment it was asked to
     * restore, which meant a GOAT lost its market on every reload while
     * the code above it read as correct.
     */
    if (typeof candidate.id !== 'string') return false;
    if (candidate.id.length === 0) return false;
    // `goatId` is the agent's id; a deployment has no separate goal id.
    if (typeof candidate.goatId !== 'string') return false;
    if (typeof candidate.marketId !== 'string') return false;
    if (typeof candidate.status !== 'string') return false;
    return true;
  }

  protected accept(item: unknown): void {
    const deployment = item as GoatDeployment;
    this.deployments.set(deployment.id, { ...deployment });
  }

  save(deployment: GoatDeployment): void {
    this.deployments.set(deployment.id, copy(deployment));
    this.markDirty();
  }

  get(id: string): GoatDeployment | undefined {
    const found = this.deployments.get(id);
    return found ? copy(found) : undefined;
  }

  list(): GoatDeployment[] {
    return [...this.deployments.values()].map(copy);
  }

  currentFor(goatId: string): GoatDeployment | undefined {
    return this.list()
      .filter((deployment) => deployment.goatId === goatId && deployment.status === 'active')
      .sort((a, b) => b.createdAt - a.createdAt)
      .at(0);
  }

  historyFor(goatId: string): GoatDeployment[] {
    return this.list()
      .filter((deployment) => deployment.goatId === goatId)
      .sort((a, b) => b.createdAt - a.createdAt);
  }

  remove(id: string): boolean {
    const removed = this.deployments.delete(id);
    if (removed) this.markDirty();
    return removed;
  }
}
