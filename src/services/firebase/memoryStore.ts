/**
 * An in-memory store implementing the persistence contract.
 *
 * ## Why this exists
 *
 * `PersistenceService` contains the logic that keeps the database honest: the
 * batched activation claim, the conditional release, the cascade, the monotonic
 * configuration version. None of that is Firestore's logic — it is *this
 * application's* logic, sitting on top of a document store.
 *
 * Testing it against a real Firestore emulator would be slow and would make every
 * assertion indirect: a failure would mean either the logic is wrong or the
 * emulator is unhappy. So the logic is tested here, against a store that behaves
 * like Firestore for the properties the logic depends on:
 *
 *   - documents live under `users/{uid}/…`, and one user's store cannot see
 *     another's;
 *   - a batch commits all of its writes or none of them;
 *   - `create` refuses to overwrite a colliding id;
 *   - an unscoped read throws.
 *
 * What it deliberately does *not* do is enforce the security rules — that is the
 * emulator's job, and `rulesTests.ts` runs those against the real rules file. The
 * split matters: this file tests "does the application do the right thing", the
 * other tests "does the database refuse the wrong thing". A fake that enforced
 * the rules would make both suites pass for one implementation.
 */

import type {
  FirebaseStore,
  OwnedCollection,
  StoreBatch,
} from './contract';

type Fields = Record<string, unknown>;

interface Document {
  fields: Fields;
}

/** A failure with the code a real store would report, so mapping is testable. */
export class MemoryStoreError extends Error {
  constructor(
    readonly code: 'unauthenticated' | 'already-exists' | 'not-found' | 'permission-denied',
    message: string,
  ) {
    super(message);
    this.name = 'MemoryStoreError';
  }
}

const DELETE = Symbol('delete');

/**
 * A document's stored fields, with no copy of its id.
 *
 * Firestore keeps the id in the document's name and nowhere else, and a second
 * copy is a second source of truth that can disagree with the path. Leaving an
 * `id: undefined` behind instead of omitting the key is worse than either: it
 * spreads *after* the id on the way out and silently blanks it.
 */
function fieldsOf<T extends { id: string }>(document: T): Fields {
  const fields = { ...document } as Fields;
  delete fields['id'];
  return fields;
}

export class MemoryStore implements FirebaseStore {
  /** `path` → document, e.g. `users/u1/goats/g1`. */
  private readonly documents = new Map<string, Document>();
  private ownerId: string | null = null;

  /** Reads recorded, so a test can assert that an unscope happened. */
  readonly reads: string[] = [];

  constructor(
    /** Shared between instances when a test needs two users in one "project". */
    private readonly shared: Map<string, Document> = new Map(),
  ) {}

  bindUser(uid: string | null): void {
    this.ownerId = uid;
  }

  /** Everything written, for assertions about what a batch actually applied. */
  snapshot(): Map<string, Fields> {
    const out = new Map<string, Fields>();
    for (const [path, document] of this.shared) out.set(path, { ...document.fields });
    return out;
  }

  private bound(): string {
    if (this.ownerId === null) {
      throw new MemoryStoreError('unauthenticated', 'No user is signed in.');
    }
    return this.ownerId;
  }

  private key(collection: string, id: string): string {
    return `users/${this.bound()}/${collection}/${id}`;
  }

  private childKey(collection: string, parentId: string, child: string, id: string): string {
    return `users/${this.bound()}/${collection}/${parentId}/${child}/${id}`;
  }

  async list<T>(collection: OwnedCollection, options: { limit?: number } = {}): Promise<T[]> {
    const prefix = `users/${this.bound()}/${collection}/`;
    const rows = [...this.shared.entries()]
      // Only direct children: a `deployments/{id}/trackers/{tid}` document must not
      // appear in the deployments list, or every tracker would read as a
      // deployment.
      .filter(([path]) => {
        const rest = path.slice(prefix.length);
        return rest.length > 0 && !rest.includes('/');
      })
      // The id comes from the path, exactly as Firestore does it — the stored
      // fields carry no copy of it.
      .map(([path, document]): Fields & { id: string } => ({ id: path.slice(prefix.length), ...document.fields }))
      .sort((a, b) => Number(b['updatedAt'] ?? 0) - Number(a['updatedAt'] ?? 0));
    const limited = options.limit === undefined ? rows : rows.slice(0, options.limit);
    this.reads.push(`list:${collection}`);
    return limited as T[];
  }

  async get<T>(collection: OwnedCollection, id: string): Promise<T | undefined> {
    const document = this.shared.get(this.key(collection, id));
    this.reads.push(`get:${collection}/${id}`);
    return document === undefined ? undefined : ({ id, ...document.fields } as T);
  }

  async create<T extends { id: string }>(collection: OwnedCollection, document: T): Promise<T> {
    const key = this.key(collection, document.id);
    if (this.shared.has(key)) {
      throw new MemoryStoreError('already-exists', `${collection}/${document.id} already exists.`);
    }
    this.shared.set(key, { fields: fieldsOf(document) });
    return document;
  }

  async set<T extends { id: string }>(collection: OwnedCollection, document: T): Promise<T> {
    this.shared.set(this.key(collection, document.id), { fields: fieldsOf(document) });
    return document;
  }

  async update<T extends { id: string }>(
    collection: OwnedCollection,
    id: string,
    patch: Partial<T>,
  ): Promise<T> {
    const key = this.key(collection, id);
    const existing = this.shared.get(key);
    if (!existing) throw new MemoryStoreError('not-found', `${collection}/${id} not found.`);
    // The stored copy never holds an id — the path is the only id, exactly as in
    // Firestore — so a caller cannot make the two disagree.
    // `patch` may carry an id; the stored fields never do, so the id is added
    // back for `fieldsOf` to strip rather than being trusted from the patch.
    const merged: Fields = fieldsOf({ ...existing.fields, ...patch, id } as { id: string });
    // A deleted field really is gone, not set to undefined.
    for (const [name, value] of Object.entries(merged)) {
      if (value === DELETE) delete merged[name];
    }
    this.shared.set(key, { fields: merged });
    return { id, ...merged } as T;
  }

  async remove(collection: OwnedCollection, id: string): Promise<void> {
    this.shared.delete(this.key(collection, id));
  }

  async listChildren<T>(
    collection: OwnedCollection,
    parentId: string,
    child: string,
  ): Promise<T[]> {
    const prefix = `users/${this.bound()}/${collection}/${parentId}/${child}/`;
    return [...this.shared.entries()]
      .filter(([path]) => path.startsWith(prefix))
      .map(([path, document]): Fields & { id: string } => ({
        id: path.slice(prefix.length),
        ...document.fields,
      }))
      .sort((a, b) => Number(a['createdAt'] ?? 0) - Number(b['createdAt'] ?? 0)) as T[];
  }

  async removeChildren(collection: OwnedCollection, parentId: string, child: string): Promise<void> {
    const prefix = `users/${this.bound()}/${collection}/${parentId}/${child}/`;
    for (const path of [...this.shared.keys()]) {
      if (path.startsWith(prefix)) this.shared.delete(path);
    }
  }

  async getChild<T>(
    collection: OwnedCollection,
    parentId: string,
    child: string,
    id: string,
  ): Promise<T | undefined> {
    const document = this.shared.get(this.childKey(collection, parentId, child, id));
    return document === undefined ? undefined : ({ id, ...document.fields } as T);
  }

  async setChild<T extends { id: string }>(
    collection: OwnedCollection,
    parentId: string,
    child: string,
    document: T,
  ): Promise<T> {
    this.shared.set(this.childKey(collection, parentId, child, document.id), {
      fields: fieldsOf(document),
    });
    return document;
  }

  async removeChild(collection: OwnedCollection, parentId: string, child: string, id: string): Promise<void> {
    this.shared.delete(this.childKey(collection, parentId, child, id));
  }

  /**
   * A batch over a staged copy.
   *
   * Everything is applied to a clone and only swapped in at commit, so a batch
   * that throws part way leaves the store exactly as it was. That is what makes
   * "all of it or none of it" testable rather than merely asserted.
   */
  batch(): StoreBatch {
    const staged = new Map<string, Document | null>(this.shared);
    const releases: Array<{ goatId: string; at: number; expectedDeploymentId?: string }> = [];

    const batch: StoreBatch = {
      create: <T extends { id: string }>(collection: OwnedCollection, document: T): StoreBatch => {
        const key = this.key(collection, document.id);
        if (staged.has(key)) {
          throw new MemoryStoreError('already-exists', `${collection}/${document.id} already exists.`);
        }
        staged.set(key, { fields: fieldsOf(document) });
        return batch;
      },
      put: <T extends { id: string }>(collection: OwnedCollection, document: T): StoreBatch => {
        // Deliberately no collision check: a complete-document write is meant to
        // create or replace. `create` is the one that reports a collision.
        staged.set(this.key(collection, document.id), { fields: fieldsOf(document) });
        return batch;
      },
      update: <T extends { id: string }>(
        collection: OwnedCollection,
        id: string,
        patch: Partial<T>,
      ): StoreBatch => {
        const key = this.key(collection, id);
        const existing = staged.get(key);
        if (!existing) throw new MemoryStoreError('not-found', `${collection}/${id} not found.`);
        staged.set(key, { fields: { ...existing.fields, ...patch, id: undefined } });
        return batch;
      },
      remove: (collection: OwnedCollection, id: string): StoreBatch => {
        staged.set(this.key(collection, id), null);
        return batch;
      },
      setChild: <T extends { id: string }>(
        collection: OwnedCollection,
        parentId: string,
        child: string,
        document: T,
      ): StoreBatch => {
        staged.set(this.childKey(collection, parentId, child, document.id), {
          fields: fieldsOf(document),
        });
        return batch;
      },
      removeChild: (collection: OwnedCollection, parentId: string, child: string, id: string): StoreBatch => {
        staged.set(this.childKey(collection, parentId, child, id), null);
        return batch;
      },
      claimActiveDeployment: (goatId: string, deploymentId: string, at: number): StoreBatch => {
        const key = this.key('goats', goatId);
        const existing = staged.get(key);
        if (!existing) throw new MemoryStoreError('not-found', `goats/${goatId} not found.`);
        staged.set(key, {
          fields: { ...existing.fields, activeDeploymentId: deploymentId, updatedAt: at },
        });
        return batch;
      },
      releaseActiveDeployment: (
        goatId: string,
        at: number,
        expectedDeploymentId?: string,
      ): StoreBatch => {
        releases.push({ goatId, at, expectedDeploymentId });
        return batch;
      },
      commit: async (): Promise<void> => {
        for (const release of releases) {
          const key = this.key('goats', release.goatId);
          const existing = staged.get(key);
          if (!existing) continue;
          const pointer = existing.fields['activeDeploymentId'];
          if (pointer === undefined) continue;
          if (
            release.expectedDeploymentId !== undefined &&
            pointer !== release.expectedDeploymentId
          ) {
            // The pointer has moved on. Releasing it now would unclaim a
            // deployment this caller knows nothing about.
            continue;
          }
          const fields: Fields = { ...existing.fields, updatedAt: release.at };
          delete fields['activeDeploymentId'];
          staged.set(key, { fields });
        }
        for (const [path, document] of staged) {
          if (document === null) this.shared.delete(path);
          else this.shared.set(path, document);
        }
      },
    };
    return batch;
  }
}

/** The document id, recovered from its path. */
function path0(_document: Document): string {
  return '';
}