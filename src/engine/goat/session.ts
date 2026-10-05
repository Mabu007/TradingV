/**
 * Session identity.
 *
 * ## The invariant
 *
 * Every asynchronous mutation belongs to exactly one `(userId, goatId, sessionId,
 * generation)`, and it is applied only if that session is still the current one.
 * An event from a superseded session must be harmless — not merely ignored by the
 * UI, but refused at the point of mutation.
 *
 * ## Why a generation and not just a session id
 *
 * Both are needed and they answer different questions.
 *
 * A `sessionId` is an identity: "which session is this?" It is what the durable
 * runtime is registered under, what the database rows are stamped with, and what a
 * callback carries so it can be routed to the right session. It is stable for the
 * life of a session and changes when CLEAR creates a new one.
 *
 * A `generation` is an ordering. Work started in session A and delivered after
 * CLEAR carries session A's id, and comparing ids is enough — but only if the id
 * is compared against *current* state at the moment of delivery, which is the part
 * that is easy to get wrong. The generation makes the ordering explicit and gives
 * a cheap way to reject a callback that arrives for a session this process has
 * already superseded twice: `17 < 18` is decidable without looking anything up.
 *
 * ## Why CLEAR cannot be a flag
 *
 * A `cleared: true` boolean on the GOAT is the tempting implementation and it is
 * wrong, because it only describes the UI. The stores would still hold the old
 * thesis, the timeline would still hold the old events, and a reload would restore
 * both. CLEAR is therefore an operation on state — delete what the session wrote,
 * keep what the GOAT is — and this module is the part that names *which session* is
 * being replaced.
 */

/** The identity every piece of session work carries. */
export interface GoatSessionIdentity {
  /** The user, when sessions are owned rather than device-local. */
  userId?: string;
  /** Stable for a GOAT. */
  goatId: string;
  /** Stable for one session; changes on every CLEAR. */
  sessionId: string;
  /** Monotonic. Increases on every CLEAR, never reused. */
  generation: number;
  /** Epoch ms. */
  startedAt: number;
}

export interface SessionRegistry {
  /** The current session, creating the first one if none exists. */
  current(goatId: string): GoatSessionIdentity;
  /** The current session, or undefined when the GOAT has never run. */
  peek(goatId: string): GoatSessionIdentity | undefined;
  /**
   * Destroy the current session and return the new one.
   *
   * The new identity is a *different* object with a new id and a higher
   * generation, so anything holding the old one can detect that it has been
   * superseded by comparing.
   */
  supersede(goatId: string, at: number): GoatSessionIdentity;
  /**
   * Whether work carrying this identity may still mutate the GOAT.
   *
   * The single choke point. Every asynchronous path asks this immediately before
   * it writes, and the answer is `false` for anything from a superseded session.
   */
  isCurrent(identity: GoatSessionIdentity): boolean;
}

/**
 * In-memory session registry.
 *
 * Deliberately not persisted. The generation is an ordering *within this runtime's
 * view of a session*, and restoring it from storage would reintroduce the bug this
 * exists to prevent: a reload that reads generation 17 back and then accepts a
 * callback that was issued against it. A reload legitimately starts a new session —
 * that is what "no activity yet" after a refresh means — so the registry beginning
 * empty is correct, and the store-backed state is what CLEAR deletes.
 */
export function createSessionRegistry(now: () => number = () => Date.now()): SessionRegistry {
  const sessions = new Map<string, GoatSessionIdentity>();
  const counters = new Map<string, number>();

  const mint = (goatId: string, at: number, generation: number): GoatSessionIdentity => ({
    goatId,
    sessionId: `s_${goatId}_${generation}_${Math.random().toString(36).slice(2, 8)}`,
    generation,
    startedAt: at,
  });

  return {
    current(goatId: string): GoatSessionIdentity {
      const existing = sessions.get(goatId);
      if (existing) return existing;
      const at = now();
      const first = mint(goatId, at, 1);
      sessions.set(goatId, first);
      counters.set(goatId, 1);
      return first;
    },

    peek(goatId: string): GoatSessionIdentity | undefined {
      return sessions.get(goatId);
    },

    supersede(goatId: string, at: number): GoatSessionIdentity {
      const previous = counters.get(goatId) ?? 0;
      const next = previous + 1;
      counters.set(goatId, next);
      const identity = mint(goatId, at, next);
      sessions.set(goatId, identity);
      return identity;
    },

    isCurrent(identity: GoatSessionIdentity): boolean {
      const active = sessions.get(identity.goatId);
      if (!active) return false;
      // Both are compared. The id catches "a different session"; the generation
      // catches "an older one", which is the case a naive id comparison would miss
      // if two sessions were ever minted with the same id.
      return active.sessionId === identity.sessionId && active.generation === identity.generation;
    },
  };
}

/**
 * How a stale callback is reported.
 *
 * A rejection is not an error: the work was valid when it was started, and the
 * session it belonged to has since been cleared. Distinguishing this from a real
 * failure is what lets a caller log it as a note rather than alarming anybody, and
 * it is why nothing throws here.
 */
export interface StaleWorkReport {
  stale: true;
  reason: string;
  /** The session that is current now, for a log line. */
  currentGeneration?: number;
}

/** The message used everywhere a stale write is refused, so it reads consistently. */
export function staleWorkMessage(what: string, identity: GoatSessionIdentity): StaleWorkReport {
  return {
    stale: true,
    reason: `${what} belonged to session ${identity.sessionId} (generation ${identity.generation}), which has been cleared. It was not applied.`,
    currentGeneration: identity.generation,
  };
}
