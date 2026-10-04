/**
 * Operator steering.
 *
 * A person watching a GOAT work often knows something the GOAT does not:
 * that a level is about to be swept, that the setup needs confirmation
 * rather than anticipation, that this particular market is a trap. The
 * useful thing to do with that is to tell the agent — not to rewrite what
 * it was asked to do.
 *
 * So a steering note is a separate record with a separate lifetime:
 *
 *   It is not the Goal.  Editing the goal is a decision about what the GOAT
 *                      is for; steering is a decision about what to look at
 *                      next. Only an explicit edit changes the goal, and it
 *                      keeps the same GOAT, thesis and history.
 *   It is not a skill.  A skill is persistent steering that shapes every
 *                      phase; a note is said once and read on the next
 *                      wakeups.
 *   It is not a command. Nothing here reaches execution. The note becomes
 *                      text in the GOAT's reasoning prompt and nothing else,
 *                      so the only thing it can change is what the agent
 *                      decides to do about it.
 *
 * That last point is the reason this is a note rather than an event. An
 * event would be delivered to the deterministic runtime; this is advice for
 * a reasoning step.
 */

import { PersistentJsonStore, getStorageSafely } from './store';

export interface SteeringNote {
  id: string;
  goalId: string;
  /** What the person typed. Stored verbatim: it is their words. */
  text: string;
  createdAt: number;
  /** Set once a GOAT has actually reasoned with it. */
  appliedAt?: number;
  /** The work stage the GOAT was in when it was told. */
  stageAtSend?: string;
}

const MAX_NOTES = 200;

export class SteeringStore extends PersistentJsonStore<SteeringNote> {
  private readonly notes = new Map<string, SteeringNote>();

  constructor(storageKey = 'tradinggoats.steering.v1') {
    super(storageKey);
    this.restoreFromStorage();
  }

  protected isRestorable(item: unknown): boolean {
    if (typeof item !== 'object' || item === null) return false;
    const note = item as Partial<SteeringNote>;
    return typeof note.id === 'string' && typeof note.goalId === 'string' && typeof note.text === 'string';
  }

  protected accept(item: unknown): void {
    const note = item as SteeringNote;
    this.notes.set(note.id, { ...note });
  }

  protected snapshot(): SteeringNote[] {
    return [...this.notes.values()];
  }

  protected persist(items: SteeringNote[]): void {
    const storage = getStorageSafely();
    if (!storage) return;
    storage.setItem(this.storageKey, JSON.stringify(items));
  }

  /** Record one instruction. Returns the stored note. */
  record(input: {
    goalId: string;
    text: string;
    stageAtSend?: string;
    now: number;
  }): SteeringNote {
    const text = input.text.trim();
    if (!text) throw new Error('A steering instruction needs some words in it.');

    const note: SteeringNote = {
      id: `steer_${input.now.toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
      goalId: input.goalId,
      text,
      createdAt: input.now,
      ...(input.stageAtSend ? { stageAtSend: input.stageAtSend } : {}),
    };

    // Stored as a copy, like every other store. Returning the live object
    // let a caller rewrite the instruction after the fact — and this text
    // is injected verbatim into the GOAT's reasoning prompt.
    const stored: SteeringNote = { ...note };
    this.notes.set(stored.id, stored);

    // Bounded overall, dropping the oldest: advice accumulates, and the
    // prompt only ever reads the recent tail of it.
    if (this.notes.size > MAX_NOTES) {
      const ordered = [...this.notes.values()].sort((a, b) => a.createdAt - b.createdAt);
      for (const stale of ordered.slice(0, this.notes.size - MAX_NOTES)) {
        this.notes.delete(stale.id);
      }
    }

    this.markDirty();
    return { ...stored };
  }

  /** Every note for one GOAT, oldest first. */
  listFor(goalId: string): SteeringNote[] {
    return [...this.notes.values()]
      .filter((note) => note.goalId === goalId)
      .sort((left, right) => left.createdAt - right.createdAt)
      .map((note) => ({ ...note }));
  }

  /** The recent tail, which is all a prompt reads. */
  recentFor(goalId: string, limit = 3): SteeringNote[] {
    const notes = this.listFor(goalId);
    return notes.slice(-limit);
  }

  get(id: string): SteeringNote | undefined {
    const note = this.notes.get(id);
    return note ? { ...note } : undefined;
  }

  /** Mark a note as reasoned with, so the UI stops calling it pending. */
  markApplied(id: string, now: number): SteeringNote | undefined {
    const note = this.notes.get(id);
    if (!note) return undefined;
    const updated: SteeringNote = { ...note, appliedAt: now };
    this.notes.set(id, updated);
    this.markDirty();
    return { ...updated };
  }

  removeFor(goalId: string): number {
    let removed = 0;
    for (const note of this.listFor(goalId)) {
      if (this.notes.delete(note.id)) removed += 1;
    }
    if (removed > 0) this.markDirty();
    return removed;
  }
}
