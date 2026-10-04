/**
 * The Tracker SDK.
 *
 * This is the only surface a GOAT uses to create and manage trackers. It
 * is deliberately narrow and deliberately boring: typed, validated,
 * permissioned, observable, deterministic, testable.
 *
 * The reason it exists as a separate layer from `TrackerRuntime` is a
 * boundary. The runtime executes whatever is registered; the SDK decides
 * what an agent is *allowed* to register. Without that split, a skill
 * that could reach the registry could put an unbounded number of
 * trackers on a market, and the runtime would be right to execute them.
 *
 * So the SDK enforces, before anything reaches the runtime:
 *
 *   - the agent holds the capability it is exercising
 *   - the target thesis belongs to that agent
 *   - the target tracker belongs to one of the agent's theses
 *   - the spec passes the runtime's validation
 *   - the ceilings have room
 *
 * Every one of those is a rejection with a code, not a silent no-op,
 * so the agent learns why it could not do what it asked.
 */

import { AgentCapability, CapabilityContext } from '../agents/types';
import { TrackerRuntime, TrackerRuntimeError } from '../agents/trackers/runtime';
import {
  Tracker,
  TrackerDataRequirement,
  TrackerEventType,
  TrackerKind,
  TrackerRequest,
  TrackerStatus,
} from './types';

/**
 * Explicit capabilities.
 *
 * A GOAT agent is given these by name, through the same skill-granted
 * allowlist the existing capability registry uses. Nothing here is
 * implied by holding another capability: being allowed to create a
 * tracker says nothing about being allowed to remove one.
 */
export const GOAT_CAPABILITIES = {
  createTracker: 'CREATE_TRACKER',
  updateTracker: 'UPDATE_TRACKER',
  pauseTracker: 'PAUSE_TRACKER',
  resumeTracker: 'RESUME_TRACKER',
  removeTracker: 'REMOVE_TRACKER',
  readTrackers: 'READ_TRACKERS',
} as const;

export type GoatCapability = (typeof GOAT_CAPABILITIES)[keyof typeof GOAT_CAPABILITIES];

export const ALL_GOAT_CAPABILITIES: GoatCapability[] = Object.values(GOAT_CAPABILITIES);

/**
 * A permission failure.
 *
 * Distinct from an invalid spec on purpose. "You may not do this" and
 * "this is malformed" are different problems and the agent should not
 * have to guess which one it hit.
 */
export class TrackerPermissionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TrackerPermissionError';
  }
}

export interface TrackerSdkDeps {
  runtime: TrackerRuntime;
  /**
   * Thesis ids the agent owns.
   *
   * Supplied by the caller rather than looked up, so the SDK cannot be
   * tricked into treating another agent's thesis as its own.
   */
  resolveOwnedThesisIds(agentId: string): string[];
  /** The capabilities actually granted to this agent. */
  resolveGrantedCapabilities(agentId: string): string[];
  /**
   * The watch ceiling the agent's goal's skills impose, if any.
   *
   * Resolved by the caller so the SDK does not need the skill registry, and
   * optional so a caller that does not track skills gets no ceiling rather
   * than a wrong one.
   */
  maxTrackersForGoal?(agentId: string): number | undefined;
  clock?: () => number;
}

/**
 * The tracker API handed to one GOAT.
 *
 * One instance per agent. Holding a reference is not authority: every
 * method re-checks the grant, so a leaked SDK cannot exceed what the
 * agent was permitted to do at construction time.
 */
export class TrackerSdk {
  constructor(
    readonly agentId: string,
    private readonly deps: TrackerSdkDeps,
  ) {}

  private assertGranted(capability: GoatCapability): void {
    if (!this.deps.resolveGrantedCapabilities(this.agentId).includes(capability)) {
      throw new TrackerPermissionError(
        `Agent ${this.agentId} does not hold ${capability}. Grant it through a skill before asking for it.`,
      );
    }
  }

  private assertOwnsThesis(thesisId: string): void {
    if (!this.deps.resolveOwnedThesisIds(this.agentId).includes(thesisId)) {
      throw new TrackerPermissionError(
        `Thesis ${thesisId} does not belong to agent ${this.agentId}.`,
      );
    }
  }

  private assertOwnsTracker(tracker: Tracker): void {
    if (tracker.agentId !== this.agentId) {
      throw new TrackerPermissionError(
        `Tracker ${tracker.id} does not belong to agent ${this.agentId}.`,
      );
    }
    if (tracker.thesisId) this.assertOwnsThesis(tracker.thesisId);
  }

  /** Deploy a tracker for one of this agent's theses. */
  create(thesisId: string, request: TrackerRequest): Tracker {
    this.assertGranted(GOAT_CAPABILITIES.createTracker);
    this.assertOwnsThesis(thesisId);
    /*
     * The goal's own skill ceiling, applied where a watch is actually made.
     *
     * `MAX_TRACKERS` was declared by six shipped skills, validated, described
     * to the user and printed in the composer — and never checked by
     * anything. A skill that says "watch no more than eight" was decoration.
     * The SDK is the only surface that can create a watch, so this is the
     * only place the claim can be true, and it is checked here rather than in
     * the runtime so a non-GOAT agent keeps its own separate ceilings.
     *
     * Cancellation frees the budget again: the limit is about what is being
     * watched at once, not about what was ever watched.
     */
    const limit = this.deps.maxTrackersForGoal?.(this.agentId);
    if (limit !== undefined) {
      const live = this.deps.runtime
        .listForThesis(thesisId)
        .filter((tracker) => tracker.lifecycle.status !== 'CANCELLED' && tracker.lifecycle.status !== 'EXPIRED').length;
      if (live >= limit) {
        throw new TrackerRuntimeError(
          `The skills on this goal allow at most ${limit} watches at once, and it already has ${live}.`,
          'LIMIT_REACHED',
        );
      }
    }
    return this.deps.runtime.createTracker(thesisId, this.agentId, request);
  }

  /** Redefine a tracker in place, preserving its identity and history. */
  update(trackerId: string, request: Partial<TrackerRequest>): Tracker {
    this.assertGranted(GOAT_CAPABILITIES.updateTracker);
    const tracker = this.requireTracker(trackerId);
    this.assertOwnsTracker(tracker);
    return this.deps.runtime.updateTracker(trackerId, request);
  }

  pause(trackerId: string): Tracker {
    this.assertGranted(GOAT_CAPABILITIES.pauseTracker);
    const tracker = this.requireTracker(trackerId);
    this.assertOwnsTracker(tracker);
    return this.deps.runtime.pauseTracker(trackerId);
  }

  resume(trackerId: string): Tracker {
    this.assertGranted(GOAT_CAPABILITIES.resumeTracker);
    const tracker = this.requireTracker(trackerId);
    this.assertOwnsTracker(tracker);
    return this.deps.runtime.resumeTracker(trackerId);
  }

  /**
   * Stop a tracker for good.
   *
   * Removal is not reversible. A tracker that is merely not wanted right
   * now should be paused, and the distinction is kept because "GOAT gave
   * up on this" and "GOAT is not watching this yet" are different things
   * to tell the user.
   */
  remove(trackerId: string, reason?: string): Tracker {
    this.assertGranted(GOAT_CAPABILITIES.removeTracker);
    const tracker = this.requireTracker(trackerId);
    this.assertOwnsTracker(tracker);
    return this.deps.runtime.cancelTracker(trackerId, reason);
  }

  /**
   * What is this GOAT watching?
   *
   * Readable, including purpose, owner, data needs, last evaluation and
   * expiry. Transparency without configuration: the user can always see
   * the plan, and can never hand-edit it.
   */
  read(thesisId?: string): Tracker[] {
    this.assertGranted(GOAT_CAPABILITIES.readTrackers);
    const owned = this.deps.resolveOwnedThesisIds(this.agentId);
    if (thesisId) {
      if (!owned.includes(thesisId)) {
        throw new TrackerPermissionError(
          `Thesis ${thesisId} does not belong to agent ${this.agentId}.`,
        );
      }
      return this.deps.runtime.listForThesis(thesisId);
    }
    return owned.flatMap((id) => this.deps.runtime.listForThesis(id));
  }

  get(trackerId: string): Tracker {
    this.assertGranted(GOAT_CAPABILITIES.readTrackers);
    const tracker = this.requireTracker(trackerId);
    this.assertOwnsTracker(tracker);
    return tracker;
  }

  private requireTracker(trackerId: string): Tracker {
    const tracker = this.deps.runtime.get(trackerId);
    if (!tracker) {
      throw new TrackerRuntimeError(`Unknown tracker ${trackerId}.`, 'UNKNOWN_TRACKER');
    }
    return tracker;
  }
}

export interface TrackerCapabilityBinding {
  runtime: TrackerRuntime;
  getSdk(agentId: string): TrackerSdk;
}

/**
 * Build the tracker capabilities, bound to a runtime.
 *
 * Returning capabilities rather than a bare object is what keeps the
 * permission model intact. Registering these into the existing
 * `CapabilityRegistry` means the agent runtime's allowlist
 * intersection, its input validation and its audit trail all apply
 * unchanged, and a skill has to explicitly list `CREATE_TRACKER` to
 * grant it.
 */
export function buildTrackerCapabilities(
  binding: TrackerCapabilityBinding,
): AgentCapability[] {
  return [
    {
      id: GOAT_CAPABILITIES.createTracker,
      name: 'Deploy Tracker',
      description:
        'Deploy a deterministic monitoring process that watches for one specific piece of evidence. Use this when you need to know whether something happened rather than looking again now.',
      category: 'structure',
      inputSchema: {
        thesisId: { type: 'string', required: true },
        purpose: { type: 'string', required: true },
        kind: { type: 'string', required: true },
        symbol: { type: 'string' },
        timeframe: { type: 'string' },
        config: { type: 'object', required: true },
        eventType: { type: 'string' },
        priority: { type: 'number' },
        cooldownMs: { type: 'number' },
        maxEventsPerMinute: { type: 'number' },
        expiresAt: { type: 'number' },
        dependencies: { type: 'array' } as unknown as Record<string, unknown>,
        dataRequirements: { type: 'array' } as unknown as Record<string, unknown>,
      },
      outputSchema: {
        trackerId: { type: 'string' },
        purpose: { type: 'string' },
        status: { type: 'string' },
      },
      execute: async (input: unknown, context: CapabilityContext) => {
        const request = input as TrackerRequest & { thesisId: string };
        const tracker = binding
          .getSdk(context.agentId)
          .create(request.thesisId, request);
        return {
          trackerId: tracker.id,
          purpose: tracker.purpose,
          status: tracker.lifecycle.status,
        };
      },
    },
    {
      id: GOAT_CAPABILITIES.updateTracker,
      name: 'Modify Tracker',
      description: 'Change what an existing tracker watches for, keeping its history.',
      category: 'structure',
      inputSchema: {
        trackerId: { type: 'string', required: true },
        purpose: { type: 'string' },
        kind: { type: 'string' },
        symbol: { type: 'string' },
        timeframe: { type: 'string' },
        config: { type: 'object' },
        priority: { type: 'number' },
        cooldownMs: { type: 'number' },
        maxEventsPerMinute: { type: 'number' },
        expiresAt: { type: 'number' },
      },
      outputSchema: { trackerId: { type: 'string' }, status: { type: 'string' } },
      execute: async (input: unknown, context: CapabilityContext) => {
        const { trackerId, ...changes } = input as { trackerId: string } & Partial<TrackerRequest>;
        const tracker = binding.getSdk(context.agentId).update(trackerId, changes);
        return { trackerId: tracker.id, status: tracker.lifecycle.status };
      },
    },
    {
      id: GOAT_CAPABILITIES.pauseTracker,
      name: 'Pause Tracker',
      description: 'Stop a tracker temporarily without discarding it.',
      category: 'structure',
      inputSchema: { trackerId: { type: 'string', required: true } },
      outputSchema: { trackerId: { type: 'string' }, status: { type: 'string' } },
      execute: async (input: unknown, context: CapabilityContext) => {
        const { trackerId } = input as { trackerId: string };
        const tracker = binding.getSdk(context.agentId).pause(trackerId);
        return { trackerId: tracker.id, status: tracker.lifecycle.status };
      },
    },
    {
      id: GOAT_CAPABILITIES.resumeTracker,
      name: 'Resume Tracker',
      description: 'Restart a paused tracker.',
      category: 'structure',
      inputSchema: { trackerId: { type: 'string', required: true } },
      outputSchema: { trackerId: { type: 'string' }, status: { type: 'string' } },
      execute: async (input: unknown, context: CapabilityContext) => {
        const { trackerId } = input as { trackerId: string };
        const tracker = binding.getSdk(context.agentId).resume(trackerId);
        return { trackerId: tracker.id, status: tracker.lifecycle.status };
      },
    },
    {
      id: GOAT_CAPABILITIES.removeTracker,
      name: 'Remove Tracker',
      description:
        'Retire a tracker permanently, because the thesis no longer needs the evidence it was collecting.',
      category: 'structure',
      inputSchema: {
        trackerId: { type: 'string', required: true },
        reason: { type: 'string' },
      },
      outputSchema: { trackerId: { type: 'string' }, status: { type: 'string' } },
      execute: async (input: unknown, context: CapabilityContext) => {
        const { trackerId, reason } = input as { trackerId: string; reason?: string };
        const tracker = binding.getSdk(context.agentId).remove(trackerId, reason);
        return { trackerId: tracker.id, status: tracker.lifecycle.status };
      },
    },
    {
      id: GOAT_CAPABILITIES.readTrackers,
      name: 'Read Trackers',
      description:
        'List what is currently being watched, what each tracker is waiting for, and when it expires.',
      category: 'structure',
      inputSchema: { thesisId: { type: 'string' } },
      outputSchema: { trackers: { type: 'array' } as unknown as Record<string, unknown> },
      execute: async (input: unknown, context: CapabilityContext) => {
        const { thesisId } = (input ?? {}) as { thesisId?: string };
        return { trackers: binding.getSdk(context.agentId).read(thesisId) };
      },
    },
  ];
}

/**
 * A description of the tracker vocabulary, for the model.
 *
 * Shipped with the agent rather than left implicit, because a tracker
 * the agent cannot describe is a tracker it will not deploy.
 */
export const TRACKER_SDK_GUIDE = `
### Deploying Trackers

You do not poll the market. You deploy trackers and go dormant. A
tracker runs in the deterministic runtime, costs no reasoning while it
waits, and wakes you only when the evidence you asked for occurs.

Use ${GOAT_CAPABILITIES.createTracker} when you know what specific thing
you need to see. Do not re-check the market yourself to find out whether
something happened: that is what the tracker is for, and doing it
directly is how an agent ends up reasoning continuously instead of
reacting.

Available tracker kinds:
- PRICE_THRESHOLD  - price reaches a level
- PRICE_CROSS      - price crosses a level
- INDICATOR_CROSS  - an indicator crosses another, or crosses a level
- BREAKOUT         - price breaks a level or a range
- VOLATILITY_CHANGE - ATR expands or contracts
- SPREAD_CHANGE    - spread widens or narrows
- SESSION_START / SESSION_END - a trading session boundary
- NEW_BAR          - a timeframe closes
- SCHEDULED        - a time window opens
- CUSTOM           - a condition tree becomes true

Every tracker must state its \`purpose\`: the specific evidence you are
waiting for, in one sentence. A tracker you cannot describe is a
tracker you should not deploy.

Give each tracker:
- \`priority\` - higher is reported first when several are ready
- \`cooldownMs\` - minimum gap between events, so one observation cannot
  wake you repeatedly
- \`expiresAt\` - when this line of enquiry stops being worth the budget

A tracker event is a fact, not a signal. It says something relevant
happened. It never says buy or sell, and you decide what it means for
the thesis every time.
`.trim();
