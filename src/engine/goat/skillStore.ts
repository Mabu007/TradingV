/**
 * User-authored skill storage.
 *
 * A built-in skill ships with the app. A user skill is written by the
 * user, in the app, in markdown, and has to survive a reload — a skill
 * that vanishes on refresh is a skill nobody will invest the ten minutes
 * in writing properly.
 *
 * The store keeps the *document*, not the parsed skill. Markdown is the
 * source of truth, which means a skill can be exported and imported, and
 * a parse that improves later re-reads better without a migration.
 *
 * Built-in skills are registered from code and are not stored here, so
 * deleting a user skill can never remove something the product needs.
 */

import { PersistentJsonStore, StoreState, getStorageSafely } from './store';
import { SkillPackage } from './skills';
import { parseSkillMarkdown } from './skillMarkdown';

export interface SkillDocument {
  id: string;
  /** The markdown the user wrote. The source of truth. */
  markdown: string;
  createdAt: number;
  updatedAt: number;
}

export interface SkillStore {
  save(document: SkillDocument): void;
  get(id: string): SkillDocument | undefined;
  list(): SkillDocument[];
  remove(id: string): boolean;
  /** Every document that currently parses into a skill. */
  listUsable(): SkillDocument[];
  storageState?: StoreState;
  flush?(): void;
}

export class InMemorySkillStore implements SkillStore {
  private readonly documents = new Map<string, SkillDocument>();

  save(document: SkillDocument): void {
    this.documents.set(document.id, { ...document });
  }

  get(id: string): SkillDocument | undefined {
    const found = this.documents.get(id);
    return found ? { ...found } : undefined;
  }

  list(): SkillDocument[] {
    return [...this.documents.values()]
      .map((document) => ({ ...document }))
      .sort((a, b) => a.createdAt - b.createdAt);
  }

  listUsable(): SkillDocument[] {
    return this.list().filter((document) => parseSkillMarkdown(document.markdown).ok);
  }

  remove(id: string): boolean {
    return this.documents.delete(id);
  }
}

/**
 * Browser-persistent skills.
 *
 * A corrupt document is skipped rather than allowed to fail the
 * constructor, and the store reports itself as `FAILED` so the app can
 * say what was lost instead of silently starting with fewer skills.
 */
export class PersistentSkillStore extends PersistentJsonStore<SkillDocument> implements SkillStore {
  private readonly documents = new Map<string, SkillDocument>();

  constructor() {
    super('tradinggoats.skills.v1', 200);
    this.restoreFromStorage();
  }

  protected snapshot(): SkillDocument[] {
    return [...this.documents.values()];
  }

  protected persist(items: SkillDocument[]): void {
    const storage = getStorageSafely();
    if (!storage) return;
    storage.setItem(this.storageKey, JSON.stringify(items));
  }

  protected isRestorable(item: unknown): boolean {
    if (typeof item !== 'object' || item === null) return false;
    const candidate = item as Partial<SkillDocument>;
    return (
      typeof candidate.id === 'string' &&
      candidate.id.length > 0 &&
      typeof candidate.markdown === 'string' &&
      typeof candidate.createdAt === 'number'
    );
  }

  protected accept(item: unknown): void {
    const document = item as SkillDocument;
    this.documents.set(document.id, { ...document });
  }

  save(document: SkillDocument): void {
    this.documents.set(document.id, { ...document });
    this.markDirty();
  }

  get(id: string): SkillDocument | undefined {
    const found = this.documents.get(id);
    return found ? { ...found } : undefined;
  }

  list(): SkillDocument[] {
    return [...this.documents.values()]
      .map((document) => ({ ...document }))
      .sort((a, b) => a.createdAt - b.createdAt);
  }

  listUsable(): SkillDocument[] {
    return this.list().filter((document) => parseSkillMarkdown(document.markdown).ok);
  }

  remove(id: string): boolean {
    const removed = this.documents.delete(id);
    if (removed) this.markDirty();
    return removed;
  }
}

export interface SkillSaveResult {
  document?: SkillDocument;
  skill?: SkillPackage;
  problems: string[];
}

/**
 * Validate, store and register a skill document in one step.
 *
 * The order matters: nothing is stored until it parses, and nothing is
 * registered until it is stored. A GOAT can therefore never be attached
 * to a skill that failed validation, which is the failure mode where a
 * user believes their limits are in force and they are not.
 */
export function prepareSkillDocument(input: {
  markdown: string;
  now: number;
  previous?: SkillDocument;
}): SkillSaveResult {
  const parsed = parseSkillMarkdown(input.markdown);
  if (!parsed.ok || !parsed.skill) {
    return { problems: parsed.problems.length > 0 ? parsed.problems : ['The skill could not be read.'] };
  }
  const document: SkillDocument = {
    id: parsed.skill.id,
    markdown: input.markdown,
    createdAt: input.previous?.createdAt ?? input.now,
    updatedAt: input.now,
  };
  return { document, skill: parsed.skill, problems: [] };
}
