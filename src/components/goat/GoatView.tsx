import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  AlertTriangle,
  ArrowLeft,
  Check,
  ChevronDown,
  ChevronRight,
  History,
  Loader2,
  Plus,
  Rocket,
  Sparkles,
} from 'lucide-react';

import { GoalComposer, type ComposerSkill, type GoalDraft } from './GoalComposer';
import { GoatExplorer } from './GoatExplorer';
import { LiveGoatCard } from './LiveGoatCard';
import { MyGoatCard } from './MyGoatCard';
import { GoatWorkspace } from './GoatWorkspace';
import { WorkPlan } from './WorkPlan';
import { SkillsSurface } from './SkillsSurface';
import { BacktestSurface } from './BacktestSurface';
import type { GoatOrchestrator } from '../../engine/goat/orchestrator';
import type { GoatMission } from '../../engine/goat/mission';
import type { Goal } from '../../engine/goat/types';
import { starterProfiles } from '../../engine/goat/starterGoats';

export interface GoatViewProps {
  /**
   * The orchestrator this view reads and drives.
   *
   * Injected rather than imported so the view can be rendered against
   * an in-memory instance in a test or a backtest, and so the
   * dependency is visible at the call site rather than global.
   */
  orchestrator: GoatOrchestrator;
  /** Tradeable markets the user can deploy to. */
  markets?: string[];
  onGoalCreated?: (goal: Goal) => void;
  /**
   * Open the AI settings.
   *
   * Offered when a GOAT could not be read because there is no API key: the
   * advice "write a better goal" is wrong for that failure.
   */
  onOpenAISettings?: () => void;
  /**
   * Ask this view to re-read the orchestrator.
   *
   * Registered by the view and called by the application when something
   * outside the GOAT screen changed a GOAT — the assistant stopping one, for
   * instance. The view's own poll would catch it anyway; this only makes it
   * immediate rather than up to two seconds away.
   */
  onRefreshRequest?: (request: () => void) => void;
}

/**
 * Where the user is.
 *
 * 'home'      Live GOATs first, then MY GOATs | EXPLORE GOATs.
 * 'create'    write a goal
 * 'review'    what was created, what it will do, and the two real choices
 * 'deploy'    choose the market it runs on
 * 'detail'    one GOAT: what it is doing, what it believes, what it watches
 * 'backtest'  the same GOAT, in a historical world
 *
 * Every step has a way back, and the GOAT it was working on is still there
 * on return. Losing a GOAT to a dead end is the failure this ordering
 * exists to prevent.
 *
 * 'backtest' is an *environment* rather than a separate product, which is why
 * it is a screen on the GOAT list and not a tab of its own: the same agent, the
 * same surfaces, a different clock and a different market.
 */
type Screen = 'home' | 'create' | 'review' | 'deploy' | 'detail' | 'backtest';

/**
 * The three things a person can be looking at from the GOATs screen.
 *
 * Skills are here rather than buried in the composer because "what can my
 * GOAT actually do?" is a standing question, and it used to be unanswerable
 * without starting to write a GOAT.
 */
type Tab = 'mine' | 'explore' | 'skills';

type Activity = 'idle' | 'creating' | 'deploying' | 'starting' | 'stopping' | 'archiving' | 'reading';

export const GoatView: React.FC<GoatViewProps> = ({
  orchestrator,
  markets = [],
  onGoalCreated,
  onOpenAISettings,
  onRefreshRequest,
}) => {
  const [screen, setScreen] = useState<Screen>('home');
  const [selectedGoalId, setSelectedGoalId] = useState<string | undefined>();
  const [activity, setActivity] = useState<Activity>('idle');
  const [error, setError] = useState<string | undefined>();
  const [notice, setNotice] = useState<string | undefined>();
  const [editing, setEditing] = useState<GoalDraft | undefined>();
  const [market, setMarket] = useState('');
  const [creatingStarter, setCreatingStarter] = useState<string | undefined>();
  const [tab, setTab] = useState<Tab>('mine');
  const [revision, setRevision] = useState(0);
  /**
   * The GOAT a replay is about, when the replay was started from one.
   *
   * Held as a mission rather than a goal id so the surface can inherit the
   * objective, the skills, the market and the resolutions without re-reading
   * the orchestrator and hoping nothing changed in between.
   */
  const [backtestSeed, setBacktestSeed] = useState<GoatMission | undefined>();

  const busy = activity !== 'idle';
  const viewToken = useRef(0);
  const lastSignature = useRef('');

  /*
   * A projection of runtime state, polled but change-gated.
   *
   * The alternative is a timer that re-renders a GOAT screen every two
   * seconds whether or not anything happened, which is both wasteful and
   * the reason browsers complain about long message handlers. Nothing here
   * mutates engine state.
   */
  useEffect(() => {
    const timer = window.setInterval(() => {
      if (document.hidden) return;
      const next = missionsSignature(orchestrator);
      if (next === lastSignature.current) return;
      lastSignature.current = next;
      setRevision((value) => value + 1);
    }, 2000);
    return () => window.clearInterval(timer);
  }, [orchestrator]);

  const live = orchestrator.liveMissions();
  const mine = orchestrator.missions().filter((mission) => !starterGoatContext().has(mission.goalId));
  const mission = selectedGoalId ? orchestrator.mission(selectedGoalId) : undefined;

  const goHome = useCallback(() => {
    viewToken.current += 1;
    setScreen('home');
    setError(undefined);
    setNotice(undefined);
    setEditing(undefined);
  }, []);

  /**
   * Replay this GOAT.
   *
   * The mental model is GOAT first: you open a GOAT, you press Backtest, and the
   * replay inherits that GOAT rather than asking you to rebuild it. Nothing
   * here prompts for a strategy, because there is no strategy to choose.
   */
  const backtestGoat = useCallback(
    (mission: GoatMission) => {
      setBacktestSeed(mission);
      setError(undefined);
      setNotice(undefined);
      setScreen('backtest');
    },
    [],
  );

  const openGoat = useCallback(
    (goalId: string) => {
      setSelectedGoalId(goalId);
      setScreen('detail');
      setError(undefined);
      setNotice(undefined);
      setMarket(orchestrator.currentDeployment(goalId)?.marketId ?? '');
    },
    [orchestrator],
  );

  const refresh = useCallback(() => {
    lastSignature.current = missionsSignature(orchestrator);
    setRevision((value) => value + 1);
  }, [orchestrator]);

  useEffect(() => {
    onRefreshRequest?.(refresh);
    return () => onRefreshRequest?.(() => undefined);
  }, [onRefreshRequest, refresh]);

  const afterCreate = useCallback(
    (result: { goal: Goal }) => {
      setSelectedGoalId(result.goal.id);
      setMarket('');
      setNotice(undefined);
      setScreen('review');
      onGoalCreated?.(result.goal);
      refresh();
    },
    [onGoalCreated, refresh],
  );

  const submit = useCallback(
    async (draft: GoalDraft) => {
      if (busy) return;
      setActivity('creating');
      setError(undefined);
      try {
        afterCreate(await orchestrator.createGoat(draft));
      } catch (caught) {
        setError(describe(caught));
      } finally {
        setActivity('idle');
      }
    },
    [afterCreate, busy, orchestrator],
  );

  /**
   * A starter takes the same path a typed goal does.
   *
   * `createGoatFromStarter` delegates to `createGoat`, so what lands here is
   * an ordinary GOAT: reviewable, editable, deployable, and identical to one
   * the user wrote. That is the only way the Explorer can be honest about
   * what it is offering.
   */
  const useStarter = useCallback(
    async (starterId: string) => {
      if (busy) return;
      setActivity('creating');
      setCreatingStarter(starterId);
      setError(undefined);
      try {
        afterCreate(await orchestrator.createGoatFromStarter(starterId));
      } catch (caught) {
        setError(describe(caught));
      } finally {
        setCreatingStarter(undefined);
        setActivity('idle');
      }
    },
    [afterCreate, busy, orchestrator],
  );

  const deploy = useCallback(async () => {
    if (!selectedGoalId || busy) return;
    const token = viewToken.current;
    setError(undefined);
    setNotice(undefined);
    setActivity('deploying');
    let deployed = false;
    try {
      const deployment = orchestrator.deployGoat({ goalId: selectedGoalId, market });
      deployed = true;
      setActivity('starting');

      /*
       * Into the workspace now, not after the model answers.
       *
       * The user used to sit on the deploy screen watching a button say
       * "Starting GOAT…" through an unbounded model call, with nothing to
       * read. Deployment *is* agent work — it reads the market, forms a
       * hypothesis and arms watches — so the honest fix is to show that work
       * happening rather than to hide it behind a spinner. The agent log fills
       * with real events while this runs, and the GOAT's own workspace is
       * already on screen to receive them.
       *
       * The screen only moves if the user is still here; navigating away
       * during the round trip is respected rather than overridden.
       */
      if (viewToken.current === token) setScreen('detail');

      const report = await orchestrator.investigateGoal(selectedGoalId);

      /*
       * The outcome is reported whatever the user did during the round trip:
       * it happened, and hiding it would be the one thing worse than
       * interrupting. The screen only moves if they are still here.
       *
       * `report.outcome` decides how it is shown, because "the deployment
       * failed" and "the GOAT deployed and has no thesis yet" are not the
       * same event and must not look like one. A GOAT that deployed and
       * formed no thesis is a normal first pass over a quiet market, and
       * the screen must not invite a redeploy as though nothing happened.
       */
      if (report.ok) {
        setNotice(report.message);
        setError(undefined);
      } else if (report.deployed) {
        setNotice(report.message);
        setError(undefined);
      } else {
        setNotice(undefined);
        setError(report.message);
      }
      setMarket(deployment.marketId);
      if (viewToken.current === token) setScreen('detail');
      refresh();
    } catch (caught) {
      /*
       * A throw here means the *deployment* itself failed — no market, an
       * unknown GOAT, or a LIVE deployment this build refuses to honour.
       * The GOAT is not running, and saying so is the whole message.
       */
      if (viewToken.current === token) {
        setNotice(undefined);
        setError(
          deployed
            ? describe(caught)
            : `This GOAT could not be started: ${describe(caught)}`,
        );
      }
    } finally {
      setActivity('idle');
      refresh();
    }
  }, [busy, market, orchestrator, refresh, selectedGoalId]);

  const startEdit = useCallback(
    (goalId: string) => {
      const goal = orchestrator.getGoal(goalId);
      if (!goal) return;
      setEditing({
        ...(goal.name ? { name: goal.name } : {}),
        ...(goal.description ? { description: goal.description } : {}),
        goal: goal.statement,
        skillIds: [...goal.skillIds],
      });
      setSelectedGoalId(goalId);
      setScreen('create');
    },
    [orchestrator],
  );

  const saveEdit = useCallback(
    async (draft: GoalDraft) => {
      if (!selectedGoalId || busy) return;
      setActivity('reading');
      setError(undefined);
      try {
        // A rename or a rewording never creates a second GOAT: the same
        // goal, thesis, evidence and deployments are all kept.
        orchestrator.updateGoatProfile(selectedGoalId, {
          name: draft.name ?? '',
          description: draft.description ?? '',
        });
        orchestrator.updateGoalStatement(selectedGoalId, draft.goal);
        const goal = orchestrator.getGoal(selectedGoalId);
        if (goal) {
          for (const skillId of goal.skillIds) {
            if (draft.skillIds.includes(skillId)) continue;
            orchestrator.attachSkill(selectedGoalId, skillId, false);
          }
          for (const skillId of draft.skillIds) {
            if (goal.skillIds.includes(skillId)) continue;
            orchestrator.attachSkill(selectedGoalId, skillId, true);
          }
        }
        setEditing(undefined);
        setScreen('review');
        refresh();
      } catch (caught) {
        setError(describe(caught));
      } finally {
        setActivity('idle');
      }
    },
    [busy, orchestrator, refresh, selectedGoalId],
  );

  const archive = useCallback(
    async (goalId: string) => {
      if (busy) return;
      setActivity('archiving');
      setError(undefined);
      try {
        const result = await orchestrator.archiveGoat(goalId);
        setNotice(
          result.archived
            ? `Deleted from your list. Its ${result.kept.theses} thesis record(s) and ${
                result.kept.evidence
              } evidence record(s) were kept, because what a GOAT worked out is part of its record.`
            : 'That GOAT was already gone.',
        );
        if (selectedGoalId === goalId) {
          setSelectedGoalId(undefined);
          setScreen('home');
        }
        refresh();
      } catch (caught) {
        setError(describe(caught));
      } finally {
        setActivity('idle');
      }
    },
    [busy, orchestrator, refresh, selectedGoalId],
  );

  const readAgain = useCallback(async () => {
    if (!selectedGoalId || busy) return;
    setActivity('reading');
    setError(undefined);
    try {
      const result = await orchestrator.refreshInterpretation(selectedGoalId);
      setNotice(
        result.interpretation.understood
          ? 'Read again. See the work plan below for what it will do next.'
          : 'Still no reading available. Check the model in AI settings.',
      );
      setScreen('review');
      refresh();
    } catch (caught) {
      setError(describe(caught));
    } finally {
      setActivity('idle');
    }
  }, [busy, orchestrator, refresh, selectedGoalId]);

  const skills: ComposerSkill[] = (() => {
    const userIds = orchestrator.listUserSkills().map((document) => document.id);
    return orchestrator.skills.listEnabled().map((skill) => ({
      id: skill.id,
      name: skill.name,
      description: skill.description,
      user: userIds.includes(skill.id),
    }));
  })();

  return (
    <div className="flex-1 overflow-y-auto overflow-x-hidden bg-bg-alt">
      {/*
        Bottom clearance for the mobile navigation, which is `fixed bottom-0
        z-40` and therefore covers whatever sits at the bottom of the viewport.

        Without it, the GOAT card's action row — Edit, Deploy, and above all the
        destructive Delete — scrolls underneath the bar and cannot be tapped at
        all on a phone. Found by measuring what `elementFromPoint` returned for
        the Delete button at 390px: the navigation bar, not the button. On
        desktop the bar is a sidebar, so the padding is mobile-only.
      */}
      <div
        className="mx-auto w-full max-w-5xl space-y-6 px-4 py-6 pb-28 sm:px-6 md:pb-6"
        data-revision={revision}
      >
        {screen !== 'home' && (
          <button
            type="button"
            onClick={goHome}
            className="inline-flex items-center gap-1.5 text-[11px] font-semibold text-ink-3 transition-colors hover:text-ink"
          >
            <ArrowLeft className="h-3.5 w-3.5" />
            All GOATs
          </button>
        )}

        {screen === 'home' && (
          <>
            <header className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <h1 className="text-xl font-bold tracking-tight text-ink">GOATs</h1>
                <p className="mt-1 max-w-prose text-[11px] leading-relaxed text-ink-3">
                  You give a GOAT a goal. It works out what it needs to know, watches the market,
                  gathers evidence, and produces a trade plan when the evidence supports one.
                </p>
              </div>
              {/*
                One entry point, in the place someone already is.

                A backtest here is the same GOAT in another environment rather
                than a separate product, so it belongs beside the list of GOATs
                and not in a tab of its own. It opens the agentic workspace
                directly — pressing START puts you in the log, not in a wizard.
              */}
              <button
                type="button"
                onClick={() => {
                  setError(undefined);
                  setNotice(undefined);
                  setScreen('backtest');
                }}
                data-testid="open-backtest"
                className="inline-flex items-center gap-1.5 rounded-lg border border-line px-3 py-2 text-[11px] font-semibold text-ink-2 transition-colors hover:border-accent/50 hover:text-ink"
              >
                <History className="h-3.5 w-3.5" aria-hidden="true" />
                Backtest a GOAT
              </button>
            </header>

            {/*
              Live first. A deployed GOAT is the thing a user came to look
              at, and burying it under an "explore" catalogue would make the
              operational view the second tab of two.
            */}
            <section>
              <div className="flex items-end justify-between gap-3">
                <div>
                  <h2 className="text-base font-bold text-ink">Live GOATs</h2>
                  <p className="mt-0.5 text-[11px] text-ink-3">
                    What is running right now, and what each one is doing.
                  </p>
                </div>
              </div>

              {live.length === 0 ? (
                <div className="mt-3 rounded-2xl border border-dashed border-line px-5 py-6 text-center">
                  <Sparkles className="mx-auto h-5 w-5 text-ink-4" />
                  <p className="mt-2 text-[11px] leading-relaxed text-ink-3">
                    Nothing is running yet. Create a GOAT or pick one from Explore, then deploy it
                    and it will start here.
                  </p>
                </div>
              ) : (
                <div className="mt-3 grid gap-4 md:grid-cols-2">
                  {live.map((entry) => (
                    <LiveGoatCard key={entry.goalId} mission={entry} onOpen={openGoat} />
                  ))}
                </div>
              )}
            </section>

            {/* MY GOATs | EXPLORE GOATs — one product, two ways in. */}
            <section>
              <SegmentedControl
                value={tab}
                onChange={setTab}
                options={[
                  { id: 'mine', label: 'MY GOATs', count: mine.length },
                  { id: 'explore', label: 'EXPLORE GOATs', count: starterProfiles().length },
                  { id: 'skills', label: 'SKILLS', count: skills.length },
                ]}
              />

              {tab === 'mine' ? (
                <div className="mt-4 space-y-4">
                  <div className="flex flex-wrap items-end justify-between gap-3">
                    <div>
                      <h3 className="text-base font-bold text-ink">MY GOATs</h3>
                      <p className="mt-0.5 text-[11px] text-ink-3">
                        Your agents, goals and trading systems.
                      </p>
                    </div>
                    <button
                      type="button"
                      onClick={() => {
                        setEditing(undefined);
                        setScreen('create');
                      }}
                      className="inline-flex items-center gap-1.5 rounded-lg bg-accent-strong px-3 py-2 text-[11px] font-bold text-accent-contrast transition-colors hover:bg-accent"
                    >
                      <Plus className="h-3.5 w-3.5" />
                      Create a GOAT
                    </button>
                  </div>

                  {mine.length === 0 ? (
                    <div className="rounded-2xl border border-dashed border-line px-5 py-8 text-center">
                      <p className="text-[11px] leading-relaxed text-ink-3">
                        You have not created a GOAT yet. Write a goal in a sentence — the GOAT works
                        out the rest.
                      </p>
                      <button
                        type="button"
                        onClick={() => setScreen('create')}
                        className="mt-3 rounded-lg border border-line px-3 py-2 text-[11px] font-semibold text-ink-2 transition-colors hover:border-accent/50"
                      >
                        Create your first GOAT
                      </button>
                    </div>
                  ) : (
                    <div className="grid gap-4 sm:grid-cols-2">
                      {mine.map((entry) => (
                        <MyGoatCard
                          key={entry.goalId}
                          mission={entry}
                          busy={busy}
                          onOpen={openGoat}
                          onEdit={startEdit}
                          onDeploy={(goalId) => {
                            setSelectedGoalId(goalId);
                            setScreen('deploy');
                          }}
                          onArchive={(goalId) => void archive(goalId)}
                        />
                      ))}
                    </div>
                  )}
                </div>
              ) : tab === 'skills' ? (
                <div className="mt-4">
                  <SkillsSurface
                    skills={orchestrator.skills.list()}
                    userSkillIds={orchestrator.listUserSkills().map((document) => document.id)}
                    attachedCount={mine.filter((mission) => mission.skillIds.length > 0).length}
                    busy={busy}
                    onSave={(markdown) => {
                      const result = orchestrator.saveUserSkill(markdown);
                      if (result.problems.length === 0) refresh();
                      return result.problems;
                    }}
                    onDelete={(id) => {
                      orchestrator.deleteUserSkill(id);
                      refresh();
                    }}
                    onLoadMarkdown={(id) => orchestrator.exportSkill(id)}
                    onToggle={(id, enabled) => {
                      orchestrator.setSkillEnabled(id, enabled);
                      refresh();
                    }}
                  />
                </div>
              ) : (
                <div className="mt-4">
                  <GoatExplorer
                    starters={starterProfiles()}
                    onUse={useStarter}
                    busy={busy}
                    creatingId={creatingStarter}
                    onCreateNew={() => {
                      setEditing(undefined);
                      setScreen('create');
                    }}
                  />
                </div>
              )}
            </section>
          </>
        )}

        {screen === 'create' && (
          <GoalComposer
            initial={editing}
            onSubmit={editing && selectedGoalId ? saveEdit : submit}
            skills={skills}
            userSkills={orchestrator.listUserSkills().map((document) => document.id)}
            onSaveSkill={(markdown) => {
              const result = orchestrator.saveUserSkill(markdown);
              if (result.problems.length === 0) refresh();
              return result.problems;
            }}
            onDeleteSkill={(id) => {
              orchestrator.deleteUserSkill(id);
              refresh();
            }}
            busy={activity === 'creating'}
            submitLabel={editing && selectedGoalId ? 'Save changes' : 'Create GOAT'}
          />
        )}

        {mission && screen === 'review' && (
          <ReviewPanel
            mission={mission}
            busy={busy}
            notice={notice}
            onDeploy={() => setScreen('deploy')}
            onReadAgain={() => void readAgain()}
            onOpenAISettings={onOpenAISettings}
          />
        )}

        {screen === 'backtest' && (
          <BacktestSurface
            markets={markets.length > 0 ? markets : ['EUR/USD']}
            {...(backtestSeed ? { seed: backtestSeed } : {})}
            onExit={goHome}
          />
        )}

        {mission && screen === 'deploy' && (
          <DeployPanel
            markets={markets}
            mission={mission}
            market={market}
            busy={busy}
            busyLabel={activity === 'deploying' ? 'Deploying…' : undefined}
            error={error}
            onMarketChange={setMarket}
            onDeploy={() => void deploy()}
            onCancel={() => setScreen(mission.deployment ? 'detail' : 'review')}
          />
        )}

        {mission && screen === 'detail' && (
          <>
            {notice && <Notice tone="good" text={notice} onDismiss={() => setNotice(undefined)} />}
            <GoatWorkspace
              orchestrator={orchestrator}
              mission={mission}
              busy={busy}
              error={error}
              onDismissError={() => setError(undefined)}
              onChanged={refresh}
              onDeploy={() => setScreen('deploy')}
              onBacktest={() => backtestGoat(mission)}
              onArchive={() => void archive(mission.goalId)}
            />
          </>
        )}

        {screen === 'review' && error && (
          <Notice tone="bad" text={error} onDismiss={() => setError(undefined)} />
        )}
      </div>
    </div>
  );
};

/* -------------------------------------------------------------------------- */

function describe(caught: unknown): string {
  return caught instanceof Error ? caught.message : String(caught);
}

function starterGoatContext(): Set<string> {
  return new Set(starterProfiles().map((starter) => `starter:${starter.id}`));
}

/**
 * A cheap fingerprint of every mission.
 *
 * Only what the screens render, so two polls that produced the same visible
 * result do not cause a second render.
 */
function missionsSignature(orchestrator: GoatOrchestrator): string {
  return JSON.stringify(
    orchestrator.missions().map((mission) => [
      mission.goalId,
      mission.stage,
      mission.runtime,
      mission.updatedAt,
      mission.activeTrackerCount,
      mission.tradePlan?.status,
      mission.thesis?.state,
      mission.steering.pending,
    ]),
  );
}

const SegmentedControl: React.FC<{
  value: Tab;
  onChange: (value: Tab) => void;
  options: Array<{ id: Tab; label: string; count: number }>;
}> = ({ value, onChange, options }) => (
  <div
    role="tablist"
    className="inline-flex rounded-xl border border-line bg-surface p-1 text-[11px] font-semibold"
  >
    {options.map((option) => (
      <button
        key={option.id}
        type="button"
        role="tab"
        aria-selected={value === option.id}
        onClick={() => onChange(option.id)}
        className={`flex items-center gap-2 rounded-lg px-3.5 py-2 transition-colors ${
          value === option.id ? 'bg-accent-soft text-ink' : 'text-ink-3 hover:text-ink-2'
        }`}
      >
        {option.label}
        <span className="rounded-full border border-line px-1.5 py-px font-mono text-[9px] text-ink-3">
          {option.count}
        </span>
      </button>
    ))}
  </div>
);

const Notice: React.FC<{ tone: 'good' | 'bad'; text: string; onDismiss: () => void }> = ({
  tone,
  text,
  onDismiss,
}) => (
  <div
    role="status"
    className={`flex items-start gap-2 rounded-xl border px-3.5 py-3 text-[11px] leading-relaxed ${
      tone === 'good'
        ? 'border-pos/40 bg-pos-soft text-pos'
        : 'border-red-500/30 bg-red-500/10 text-red-300'
    }`}
  >
    {tone === 'good' ? (
      <Check className="mt-px h-3.5 w-3.5 shrink-0" />
    ) : (
      <AlertTriangle className="mt-px h-3.5 w-3.5 shrink-0" />
    )}
    <span className="min-w-0 flex-1 break-words">{text}</span>
    <button type="button" onClick={onDismiss} className="shrink-0 text-[10px] font-semibold underline">
      Dismiss
    </button>
  </div>
);

/**
 * The review: what was created, and what it intends to do.
 *
 * The work plan is the point of this screen. A user who has just created an
 * agent should be able to see that it has an intention, not just that the
 * form accepted their sentence.
 */
const ReviewPanel: React.FC<{
  mission: GoatMission;
  busy?: boolean;
  notice?: string;
  onDeploy: () => void;
  onReadAgain: () => void;
  onOpenAISettings?: () => void;
}> = ({ mission, busy, notice, onDeploy, onReadAgain, onOpenAISettings }) => (
  <div className="space-y-4">
    <section className="rounded-2xl border border-line bg-surface px-5 py-4">
      <div className="flex items-start gap-3">
        <div className="rounded-xl bg-accent-soft p-2 text-accent">
          <Sparkles className="h-4 w-4" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="text-[10px] font-semibold uppercase tracking-wide text-ink-3">
            Your GOAT
          </div>
          <h1 className="mt-0.5 text-base font-bold text-ink">{mission.name}</h1>
          {mission.description && (
            <p className="mt-1 text-[11px] leading-relaxed text-ink-2">{mission.description}</p>
          )}
          <p className="mt-2 whitespace-pre-wrap break-words text-[12px] leading-relaxed text-ink">
            {mission.goal}
          </p>
          {mission.skillIds.length > 0 && (
            <div className="mt-3">
              <div className="text-[10px] font-semibold uppercase tracking-wide text-ink-3">
                Skills
              </div>
              <div className="mt-1 flex flex-wrap gap-1.5">
                {mission.skillIds.map((id) => (
                  <span
                    key={id}
                    className="rounded-full border border-line px-2 py-0.5 text-[10px] text-ink-2"
                  >
                    {id}
                  </span>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
    </section>

    {!mission.thesis && (
      <section className="rounded-2xl border border-line bg-surface px-5 py-4">
        <WorkPlan steps={mission.workPlan} title="Work plan" />
        <p className="mt-3 text-[11px] leading-relaxed text-ink-3">
          {mission.interpretation
            ? 'This is how the GOAT read your goal. Deploy it and it starts on the first step.'
            : 'The GOAT has not read the goal yet — that happens on its first reasoning step, which needs an AI model.'}
        </p>
        {!mission.interpretation && (
          <div className="mt-3 flex flex-wrap gap-2">
            {onOpenAISettings && (
              <button
                type="button"
                onClick={onOpenAISettings}
                className="rounded-lg bg-accent-strong px-3 py-2 text-[11px] font-bold text-accent-contrast transition-colors hover:bg-accent"
              >
                Open AI settings
              </button>
            )}
            <button
              type="button"
              onClick={onReadAgain}
              disabled={busy}
              className="inline-flex items-center gap-1.5 rounded-lg border border-line px-3 py-2 text-[11px] font-semibold text-ink-2 transition-colors hover:border-accent/50 disabled:opacity-40"
            >
              {busy ? <Loader2 className="h-3 w-3 animate-spin" /> : null}
              Read my goal again
            </button>
          </div>
        )}
      </section>
    )}

    {notice && <Notice tone="good" text={notice} onDismiss={() => undefined} />}

    <div className="flex flex-wrap items-center gap-3">
      <button
        type="button"
        onClick={onDeploy}
        disabled={busy}
        className="inline-flex items-center gap-2 rounded-lg bg-accent-strong px-4 py-2.5 text-xs font-bold text-accent-contrast transition-colors hover:bg-accent disabled:cursor-not-allowed disabled:opacity-40"
      >
        <Rocket className="h-3.5 w-3.5" />
        Deploy GOAT
      </button>
      <span className="text-[11px] text-ink-3">
        Deploying asks for one thing: the market. Everything else is the GOAT's work.
      </span>
    </div>
  </div>
);

/**
 * Choosing where the GOAT runs.
 *
 * Market only. Timeframe used to be asked for here and was a mistake: it is
 * an analysis decision, and the GOAT has tools that read several temporal
 * resolutions of the same market. Making the user pick one narrowed the
 * agent to whatever the dropdown offered.
 *
 * SHADOW is not a choice on this screen, and it is stated rather than
 * implied: "it is watching but not trading" and "it is trading" are
 * different products, and a user should never be unsure which one they
 * have.
 */
const DeployPanel: React.FC<{
  markets: string[];
  mission: GoatMission;
  market: string;
  busy?: boolean;
  busyLabel?: string;
  /**
   * A deployment failure.
   *
   * Rendered here rather than only on the screens either side, because a
   * refused deployment leaves the user sitting on the deploy screen with
   * nothing having happened and no visible reason why.
   */
  error?: string;
  onMarketChange: (market: string) => void;
  onDeploy: () => void;
  onCancel: () => void;
}> = ({ markets, mission, market, busy, busyLabel, error, onMarketChange, onDeploy, onCancel }) => {
  const [expanded, setExpanded] = useState(true);
  const canDeploy = market.trim().length > 0 && !busy;

  return (
    <div className="rounded-2xl border border-line bg-surface">
      <button
        type="button"
        onClick={() => setExpanded((open) => !open)}
        className="flex w-full items-center gap-2 px-5 py-4 text-left"
      >
        {expanded ? (
          <ChevronDown className="h-3.5 w-3.5 shrink-0 text-ink-3" />
        ) : (
          <ChevronRight className="h-3.5 w-3.5 shrink-0 text-ink-3" />
        )}
        <Rocket className="h-4 w-4 shrink-0 text-accent" />
        <div className="min-w-0 flex-1">
          <div className="text-sm font-bold text-ink">
            {mission.deployment ? 'Move to a different market' : 'Deploy GOAT'}
          </div>
          <div className="mt-0.5 text-[11px] text-ink-3">
            {mission.name} · SHADOW: real market data, real decisions, no orders.
          </div>
        </div>
      </button>

      {expanded && (
        <div className="space-y-3 border-t border-line px-5 py-4">
          <div className="min-w-0">
            <label
              htmlFor="goat-market"
              className="mb-1.5 block text-[11px] font-semibold uppercase tracking-wide text-ink-3"
            >
              Market
            </label>
            {markets.length > 0 ? (
              <select
                id="goat-market"
                value={market}
                onChange={(event) => onMarketChange(event.target.value)}
                className="w-full rounded-xl border border-line bg-surface-2 px-3 py-2.5 text-sm text-ink focus:border-accent focus:outline-none"
              >
                <option value="">Choose a market</option>
                {markets.map((option) => (
                  <option key={option} value={option}>
                    {option}
                  </option>
                ))}
              </select>
            ) : (
              <input
                id="goat-market"
                value={market}
                onChange={(event) => onMarketChange(event.target.value)}
                placeholder="EUR/USD"
                className="w-full rounded-xl border border-line bg-surface-2 px-3 py-2.5 text-sm text-ink placeholder:text-ink-4 focus:border-accent focus:outline-none"
              />
            )}
          </div>

          {error && (
            <p
              role="alert"
              className="flex items-start gap-1.5 rounded-xl border border-red-500/30 bg-red-500/10 px-3 py-2 text-[11px] leading-relaxed text-red-300"
            >
              <AlertTriangle className="mt-px h-3 w-3 shrink-0" />
              <span className="min-w-0 flex-1 break-words">{error}</span>
            </p>
          )}

          {markets.length === 0 && (
            <p className="flex items-start gap-1.5 text-[10px] leading-relaxed text-warn">
              <AlertTriangle className="mt-px h-3 w-3 shrink-0" />
              No markets have been discovered yet. Type one exactly as the venue labels it, for
              example EUR/USD.
            </p>
          )}

          <div className="flex flex-wrap items-center gap-3">
            <button
              type="button"
              onClick={onDeploy}
              disabled={!canDeploy}
              className="inline-flex items-center gap-2 rounded-lg bg-accent-strong px-4 py-2.5 text-xs font-bold text-accent-contrast transition-colors hover:bg-accent disabled:cursor-not-allowed disabled:opacity-40"
            >
              {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Rocket className="h-3.5 w-3.5" />}
              {busyLabel ?? (mission.deployment ? 'Move GOAT here' : 'Deploy in SHADOW')}
            </button>
            <button
              type="button"
              onClick={onCancel}
              disabled={busy}
              className="text-[11px] font-semibold text-ink-3 underline-offset-2 hover:text-ink hover:underline"
            >
              Cancel
            </button>
          </div>

          <p className="text-[10px] leading-relaxed text-ink-3">
            Deploying starts the GOAT: it reads the market, forms a thesis, and deploys trackers to
            watch for it. That takes a moment and the result is reported where you can read it.
          </p>
        </div>
      )}
    </div>
  );
};
