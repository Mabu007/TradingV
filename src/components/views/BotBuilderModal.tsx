import React, { useMemo, useState } from 'react';
import { ArrowLeft, Check, ChevronRight, Play, Plus, Sparkles, Trash2, X } from 'lucide-react';
import {
  BotDefinition,
  BotTrigger,
  CURRENT_BOT_SCHEMA_VERSION,
  Deployment,
  createDeployment,
  compileQuickBuild,
  validateBotDefinition,
} from '../../engine/agents/botDefinition';
import { BotBacktestProgress, BotBacktestResult, BotBacktestTriggerStat } from '../../engine/agents/backtest';

interface BotBuilderModalProps {
  onClose: () => void;
  onSave: (definition: BotDefinition) => void;
  onDeploy: (definition: BotDefinition, deployment: Deployment) => void;
  onBacktest: (definition: BotDefinition, marketId: string, timeframe: string, initialBalance: number, start: number, end: number, onProgress: (progress: BotBacktestProgress) => void) => Promise<BotBacktestResult>;
  initialDefinition?: BotDefinition | null;
}

type Stage = 'method' | 'build' | 'review' | 'test' | 'deploy';

const emptyDefinition = (): BotDefinition => {
  const now = Date.now();
  return {
    schemaVersion: CURRENT_BOT_SCHEMA_VERSION,
    source: 'user',
    identity: { id: `bot-${now}`, name: 'New Trading Bot', description: 'A reusable AI trading agent.' },
    intent: {
      objective: 'Evaluate high-quality market opportunities in context.',
      longBias: 'Prefer long opportunities when broader structure supports them.',
      shortBias: 'Prefer short opportunities when broader structure supports them.',
      guidance: ['Consider market structure.', 'Consider momentum and volatility.', 'Wait when conditions are unclear.'],
    },
    skills: { marketAnalysis: ['market-observation'], indicators: ['technical-analysis'], patterns: [], context: ['risk-management'] },
    capabilities: { marketData: true, accountData: true, orders: false, positions: true, automation: false },
    triggers: [newTrigger('new-bar', now)],
    risk: { riskPerTrade: 0.01, maxDailyLoss: 500, maxPositions: 1, maxExposure: 50000, cooldown: 900000 },
    execution: { orderType: 'market', executionRules: ['Require a protective stop loss.', 'Respect deterministic risk validation.'] },
    ai: { provider: 'openrouter', model: 'anthropic/claude-3.5-sonnet', reasoningMode: 'advisory', confidenceThreshold: 0.7, decisionPolicy: 'Investigate each trigger and wait when evidence is unclear.' },
    createdAt: now,
    updatedAt: now,
  };
};

const skillOptions = [
  ['market-observation', 'Market analysis', 'Quotes, spread, sessions, and market context.'],
  ['technical-analysis', 'Trend and indicators', 'EMA, SMA, RSI, ATR, structure, and breakout context.'],
  ['risk-management', 'Risk management', 'Deterministic risk, exposure, and loss-limit checks.'],
  ['position-sizing', 'Position sizing', 'Calculate volume from equity and protective stop distance.'],
  ['trade-management', 'Position context', 'Monitor and manage active positions.'],
] as const;

const markets = [
  { id: 'EUR/USD', label: 'EUR/USD', group: 'Forex' },
  { id: 'GBP/USD', label: 'GBP/USD', group: 'Forex' },
  { id: 'USD/JPY', label: 'USD/JPY', group: 'Forex' },
  { id: 'Gold', label: 'Gold', group: 'Commodities' },
  { id: 'Silver', label: 'Silver', group: 'Commodities' },
  { id: 'WTI', label: 'WTI', group: 'Commodities' },
  { id: 'Brent', label: 'Brent', group: 'Commodities' },
  { id: 'Copper', label: 'Copper', group: 'Commodities' },
  { id: 'Natural Gas', label: 'Natural Gas', group: 'Commodities' },
  { id: 'Platinum', label: 'Platinum', group: 'Commodities' },
  { id: 'Palladium', label: 'Palladium', group: 'Commodities' },
  { id: 'S&P 500', label: 'S&P 500', group: 'Indices' },
  { id: 'Japan 225', label: 'Japan 225', group: 'Indices' },
  { id: 'Korea 200', label: 'Korea 200', group: 'Indices' },
  { id: 'US 500', label: 'US 500', group: 'Indices' },
  { id: 'US Tech 100', label: 'US Tech 100', group: 'Indices' },
  { id: 'Small 2000', label: 'Small 2000', group: 'Indices' },
];

export const BotBuilderModal: React.FC<BotBuilderModalProps> = ({ onClose, onSave, onDeploy, onBacktest, initialDefinition }) => {
  const [stage, setStage] = useState<Stage>(initialDefinition ? 'build' : 'method');
  const [definition, setDefinition] = useState<BotDefinition>(initialDefinition || emptyDefinition());
  const [prompt, setPrompt] = useState('');
  const [error, setError] = useState('');
  const [market, setMarket] = useState('EUR/USD');
  const [mode, setMode] = useState<'paper' | 'demo'>('paper');
  const [accountId, setAccountId] = useState('paper-account');
  const [saved, setSaved] = useState(false);
  const [testMarket, setTestMarket] = useState('EUR/USD');
  const [testTimeframe, setTestTimeframe] = useState('15m');
  const [testBalance, setTestBalance] = useState(10000);
  const [testPeriod, setTestPeriod] = useState('30D');
  const [testResult, setTestResult] = useState<BotBacktestResult | null>(null);
  const [isTesting, setIsTesting] = useState(false);
  const [testProgress, setTestProgress] = useState<BotBacktestProgress>({ phase: 'preparing', processed: 0, total: 0 });

  const update = (patch: Partial<BotDefinition>) => setDefinition((current) => ({ ...current, ...patch, updatedAt: Date.now() }));
  const updateIntent = (key: keyof BotDefinition['intent'], value: string | string[]) => update({ intent: { ...definition.intent, [key]: value } });
  const activeSkills = useMemo(() => Object.values(definition.skills).flat().length, [definition.skills]);

  const validate = (nextStage: Stage) => {
    try {
      validateBotDefinition(definition);
      setError('');
      setStage(nextStage);
      if (nextStage === 'test') setSaved(false);
    } catch (validationError) {
      setError(validationError instanceof Error ? validationError.message : 'Complete the required configuration.');
    }
  };

  const generate = () => {
    try {
      const result = compileQuickBuild(prompt);
      setDefinition(result.definition);
      setError('');
      setStage('build');
    } catch (generationError) {
      setError(generationError instanceof Error ? generationError.message : 'Describe the bot you want to build.');
    }
  };

  const save = () => {
    try {
      validateBotDefinition(definition);
      onSave(definition);
      setSaved(true);
      setStage('deploy');
      setError('');
    } catch (validationError) {
      setError(validationError instanceof Error ? validationError.message : 'Complete the required configuration.');
    }
  };

  const deploy = () => {
    try {
      const deployment = createDeployment({ id: `${definition.identity.id}-${Date.now()}`, botId: definition.identity.id, marketId: market, accountId, mode, status: 'active' });
      onDeploy(definition, deployment);
      onClose();
    } catch (deploymentError) {
      setError(deploymentError instanceof Error ? deploymentError.message : 'Choose a valid account before deploying.');
    }
  };

  const runTest = async () => {
    setIsTesting(true);
    setError('');
    try {
      const end = Date.now();
      const start = end - periodMilliseconds(testPeriod);
      setTestResult(await onBacktest(definition, testMarket, testTimeframe, testBalance, start, end, setTestProgress));
    } catch (backtestError) {
      setError(backtestError instanceof Error ? backtestError.message : 'Historical simulation failed.');
    } finally {
      setIsTesting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/80 backdrop-blur-xs p-0 sm:p-4">
      <div className="w-full max-w-5xl max-h-[94vh] overflow-hidden rounded-t-2xl sm:rounded-2xl border border-[#1e293b] bg-[#0b1220] text-slate-200 shadow-2xl flex flex-col">
        <div className="flex items-center justify-between border-b border-[#1e293b] bg-[#0f172a] p-4">
          <div className="flex items-center gap-3">
            {stage !== 'method' && <button onClick={() => setStage(stage === 'build' ? 'method' : stage === 'review' ? 'build' : stage === 'test' ? 'review' : 'test')} className="rounded-lg p-2 text-slate-400 hover:bg-[#1e293b] hover:text-white"><ArrowLeft className="h-4 w-4" /></button>}
            <div><div className="flex items-center gap-2 text-sm font-bold text-white"><Sparkles className="h-4 w-4 text-sky-400" />Build an intelligent bot</div><div className="mt-1 text-[11px] text-slate-400">{stage === 'method' ? 'Choose how to begin' : '1 Build  ·  2 Review  ·  3 Test  ·  4 Deploy'}</div></div>
          </div>
          <button onClick={onClose} className="rounded-lg p-2 text-slate-400 hover:bg-[#1e293b] hover:text-white"><X className="h-4 w-4" /></button>
        </div>

        <div className="flex-1 overflow-y-auto p-4 sm:p-6">
          {stage === 'method' && <MethodStep onQuick={() => setStage('build')} onManual={() => { setDefinition(emptyDefinition()); setStage('build'); }} />}
          {stage === 'build' && <BuildStep definition={definition} update={update} updateIntent={updateIntent} activeSkills={activeSkills} prompt={prompt} setPrompt={setPrompt} generate={generate} error={error} />}
          {stage === 'review' && <ReviewStep definition={definition} />}
          {stage === 'test' && <TestStep definition={definition} saved={saved} result={testResult} progress={testProgress} market={testMarket} timeframe={testTimeframe} period={testPeriod} balance={testBalance} setMarket={setTestMarket} setTimeframe={setTestTimeframe} setPeriod={setTestPeriod} setBalance={setTestBalance} runTest={runTest} isTesting={isTesting} />}
          {stage === 'deploy' && <DeployStep definition={definition} market={market} setMarket={setMarket} mode={mode} setMode={setMode} accountId={accountId} setAccountId={setAccountId} />}
        </div>

        {error && <div className="mx-4 mb-3 rounded-xl border border-rose-800/50 bg-rose-950/30 px-3 py-2 text-xs text-rose-300">{error}</div>}
        {stage !== 'method' && <div className="flex flex-col-reverse gap-2 border-t border-[#1e293b] bg-[#0f172a] p-4 sm:flex-row sm:justify-end">
          {stage === 'build' && <button onClick={() => validate('review')} className="flex items-center justify-center gap-2 rounded-xl bg-sky-600 px-5 py-3 text-xs font-bold text-white hover:bg-sky-500">Review configuration <ChevronRight className="h-4 w-4" /></button>}
          {stage === 'review' && <button onClick={() => validate('test')} className="flex items-center justify-center gap-2 rounded-xl bg-indigo-600 px-5 py-3 text-xs font-bold text-white hover:bg-indigo-500">Ready to backtest <ChevronRight className="h-4 w-4" /></button>}
          {stage === 'test' && <><button onClick={runTest} disabled={isTesting} className="flex items-center justify-center gap-2 rounded-xl bg-indigo-600 px-5 py-3 text-xs font-bold text-white hover:bg-indigo-500 disabled:opacity-50"><Play className="h-4 w-4 fill-current" />{isTesting ? 'Running simulation...' : 'Run backtest'}</button><button onClick={save} disabled={!testResult} className="flex items-center justify-center gap-2 rounded-xl bg-emerald-600 px-5 py-3 text-xs font-bold text-white hover:bg-emerald-500 disabled:opacity-40"><Check className="h-4 w-4" />Save BotDefinition</button></>}
          {stage === 'deploy' && <button onClick={deploy} className="flex items-center justify-center gap-2 rounded-xl bg-sky-600 px-5 py-3 text-xs font-bold text-white hover:bg-sky-500">Deploy to {market} <ChevronRight className="h-4 w-4" /></button>}
        </div>}
      </div>
    </div>
  );
};

const MethodStep: React.FC<{ onQuick: () => void; onManual: () => void }> = ({ onQuick, onManual }) => <div className="mx-auto grid max-w-2xl gap-3 py-6 sm:grid-cols-2 sm:py-14">
  <button onClick={onQuick} className="rounded-2xl border border-sky-700/50 bg-sky-950/20 p-6 text-left transition hover:border-sky-400 hover:bg-sky-950/40"><Sparkles className="mb-8 h-7 w-7 text-sky-400" /><div className="text-base font-bold text-white">Quick Build</div><div className="mt-2 text-xs leading-relaxed text-slate-400">Describe what you want. AI builds a complete editable configuration for you.</div></button>
  <button onClick={onManual} className="rounded-2xl border border-[#334155] bg-[#0f172a] p-6 text-left transition hover:border-slate-400 hover:bg-[#162032]"><Plus className="mb-8 h-7 w-7 text-emerald-400" /><div className="text-base font-bold text-white">Manual Build</div><div className="mt-2 text-xs leading-relaxed text-slate-400">Build the same BotDefinition yourself, one clear section at a time.</div></button>
</div>;

const BuildStep: React.FC<any> = ({ definition, update, updateIntent, activeSkills, prompt, setPrompt, generate, error }) => {
  const [advanced, setAdvanced] = useState(false);
  const toggleSkill = (id: string) => {
    const group = id === 'market-observation' ? 'marketAnalysis' : id === 'technical-analysis' ? 'indicators' : id === 'risk-management' || id === 'position-sizing' ? 'context' : 'context';
    const values = definition.skills[group] as string[];
    update({ skills: { ...definition.skills, [group]: values.includes(id) ? values.filter((value) => value !== id) : [...values, id] } });
  };
  const toggleCapability = (key: keyof BotDefinition['capabilities']) => {
    const value = !definition.capabilities[key];
    const next = { ...definition.capabilities, [key]: value };
    if (key === 'automation' && !value) next.orders = false;
    if (key === 'orders' && value) next.automation = true;
    update({ capabilities: next });
  };
  return <div className="grid gap-5 lg:grid-cols-[1fr_280px]">
    <div className="space-y-5">
      <section className="rounded-2xl border border-[#1e293b] bg-[#0f172a] p-4 sm:p-5"><div className="mb-4"><div className="text-sm font-bold text-white">Bot identity</div><div className="mt-1 text-[11px] text-slate-400">Give your reusable agent a clear identity. Markets are selected later during deployment.</div></div><div className="grid gap-3 sm:grid-cols-2"><Field label="Name" value={definition.identity.name} onChange={(value) => update({ identity: { ...definition.identity, name: value } })} /><Field label="Description" value={definition.identity.description} onChange={(value) => update({ identity: { ...definition.identity, description: value } })} /></div></section>
      <section className="rounded-2xl border border-sky-900/50 bg-sky-950/10 p-4 sm:p-5"><SectionTitle title="Intent" subtitle="What should this bot look for? These guide the AI; they are not rigid rules." /><div className="space-y-3"><TextArea label="Objective" value={definition.intent.objective} onChange={(value) => updateIntent('objective', value)} /><TextArea label="Long bias" value={definition.intent.longBias} onChange={(value) => updateIntent('longBias', value)} /><TextArea label="Short bias" value={definition.intent.shortBias} onChange={(value) => updateIntent('shortBias', value)} /><TextArea label="Guidance (one point per line)" value={definition.intent.guidance.join('\n')} onChange={(value) => updateIntent('guidance', value.split('\n').map((line) => line.trim()).filter(Boolean))} /></div></section>
      <section className="rounded-2xl border border-[#1e293b] bg-[#0f172a] p-4 sm:p-5"><SectionTitle title="When should your bot wake up?" subtitle="Triggers wake the AI. They do not automatically mean trade." /><div className="space-y-2">{definition.triggers.map((trigger: BotTrigger, index: number) => <div key={trigger.id} className="flex items-center gap-3 rounded-xl border border-[#1e293b] bg-[#0b1220] p-3"><button onClick={() => update({ triggers: definition.triggers.map((item: BotTrigger, itemIndex: number) => itemIndex === index ? { ...item, enabled: !item.enabled } : item) })} className={`h-5 w-9 rounded-full p-0.5 ${trigger.enabled ? 'bg-emerald-500' : 'bg-slate-700'}`}><span className={`block h-4 w-4 rounded-full bg-white transition ${trigger.enabled ? 'translate-x-4' : ''}`} /></button><div className="min-w-0 flex-1"><div className="text-xs font-bold text-white">{trigger.type === 'NEW_BAR' ? 'New candle' : trigger.type.replaceAll('_', ' ')}</div><div className="text-[11px] text-slate-400">{trigger.timeframe || 'Event-driven'} · cooldown {Math.round((trigger.cooldownMs || 0) / 1000)}s</div></div><button onClick={() => update({ triggers: definition.triggers.filter((_: BotTrigger, itemIndex: number) => itemIndex !== index) })} className="p-1 text-slate-500 hover:text-rose-300"><Trash2 className="h-4 w-4" /></button></div>)}<button onClick={() => update({ triggers: [...definition.triggers, newTrigger(`trigger-${definition.triggers.length + 1}`, Date.now())] })} className="flex w-full items-center justify-center gap-2 rounded-xl border border-dashed border-slate-600 py-3 text-xs font-semibold text-slate-300 hover:border-sky-500 hover:text-sky-300"><Plus className="h-4 w-4" />New candle trigger</button></div></section>
      <section className="rounded-2xl border border-amber-900/50 bg-amber-950/10 p-4 sm:p-5"><SectionTitle title="Risk protection" subtitle="These limits are enforced by TradingVibe. The AI cannot override them." /><div className="grid gap-3 sm:grid-cols-2"><NumberField label="Risk per trade" value={definition.risk.riskPerTrade * 100} suffix="%" onChange={(value) => update({ risk: { ...definition.risk, riskPerTrade: value / 100 } })} /><NumberField label="Maximum daily loss" value={definition.risk.maxDailyLoss || 0} suffix="$" onChange={(value) => update({ risk: { ...definition.risk, maxDailyLoss: value } })} /><NumberField label="Maximum positions" value={definition.risk.maxPositions} onChange={(value) => update({ risk: { ...definition.risk, maxPositions: Math.max(1, Math.round(value)) } })} /><NumberField label="Cooldown" value={definition.risk.cooldown / 60000} suffix="min" onChange={(value) => update({ risk: { ...definition.risk, cooldown: Math.max(0, value * 60000) } })} /></div></section>
      <button onClick={() => setAdvanced(!advanced)} className="flex w-full items-center justify-between rounded-xl border border-[#1e293b] bg-[#0f172a] px-4 py-3 text-left text-xs font-bold text-white"><span>Advanced configuration</span><ChevronRight className={`h-4 w-4 transition ${advanced ? 'rotate-90' : ''}`} /></button>
      {advanced && <div className="space-y-5"><section className="rounded-2xl border border-[#1e293b] bg-[#0f172a] p-4 sm:p-5"><SectionTitle title="Skills" subtitle="What can your AI use to investigate the market?" /><div className="grid gap-2 sm:grid-cols-2">{skillOptions.map(([id, label, description]) => <button key={id} onClick={() => toggleSkill(id)} className={`rounded-xl border p-3 text-left ${skillValues(definition).some((values) => values.includes(id)) ? 'border-sky-500/60 bg-sky-950/30' : 'border-[#1e293b] bg-[#0b1220]'}`}><div className="flex items-center justify-between text-xs font-bold text-white"><span>{label}</span><span className="text-sky-400">{skillValues(definition).some((values) => values.includes(id)) ? 'ON' : 'OFF'}</span></div><div className="mt-1 text-[11px] text-slate-400">{description}</div></button>)}</div></section><section className="rounded-2xl border border-[#1e293b] bg-[#0f172a] p-4 sm:p-5"><SectionTitle title="Capabilities" subtitle="Permissions define what the AI may access or do." /><div className="space-y-2">{(['marketData', 'accountData', 'positions', 'orders', 'automation'] as const).map((key) => <Toggle key={key} label={key === 'marketData' ? 'Market data' : key === 'accountData' ? 'Account data' : key[0].toUpperCase() + key.slice(1)} value={definition.capabilities[key]} onChange={() => toggleCapability(key)} />)}</div></section><section className="rounded-2xl border border-[#1e293b] bg-[#0f172a] p-4 sm:p-5"><SectionTitle title="Execution" /><div className="grid gap-3 sm:grid-cols-2"><SelectField label="Order type" value={definition.execution.orderType} options={['market', 'limit', 'either']} onChange={(value) => update({ execution: { ...definition.execution, orderType: value as BotDefinition['execution']['orderType'] } })} /><NumberField label="Slippage tolerance" value={definition.execution.slippage || 0} onChange={(value) => update({ execution: { ...definition.execution, slippage: value } })} /></div></section><section className="rounded-2xl border border-[#1e293b] bg-[#0f172a] p-4 sm:p-5"><SectionTitle title="AI behavior" /><SelectField label="Reasoning mode" value={definition.ai.reasoningMode} options={['autonomous', 'confirm', 'advisory', 'strict']} onChange={(value) => update({ ai: { ...definition.ai, reasoningMode: value as BotDefinition['ai']['reasoningMode'] } })} /><div className="mt-3"><NumberField label="Confidence threshold" value={definition.ai.confidenceThreshold * 100} suffix="%" onChange={(value) => update({ ai: { ...definition.ai, confidenceThreshold: Math.min(100, Math.max(0, value)) / 100 } })} /></div><div className="mt-3"><TextArea label="Decision policy" value={definition.ai.decisionPolicy} onChange={(value) => update({ ai: { ...definition.ai, decisionPolicy: value } })} /></div></section></div>}
    </div>
    <Summary definition={definition} activeSkills={activeSkills} prompt={prompt} setPrompt={setPrompt} generate={generate} error={error} />
  </div>;
};

const Summary: React.FC<any> = ({ definition, activeSkills, prompt, setPrompt, generate }) => <aside className="h-fit space-y-3 lg:sticky lg:top-0"><div className="rounded-2xl border border-[#1e293b] bg-[#0f172a] p-4"><div className="text-[10px] font-bold uppercase tracking-wider text-slate-500">Live summary</div><div className="mt-2 text-base font-bold text-white">{definition.identity.name}</div><div className="mt-1 text-xs leading-relaxed text-slate-400">{definition.intent.objective}</div><div className="mt-4 grid grid-cols-2 gap-2 text-[11px]"><Stat label="Risk / trade" value={`${(definition.risk.riskPerTrade * 100).toFixed(2)}%`} /><Stat label="Max positions" value={String(definition.risk.maxPositions)} /><Stat label="Skills equipped" value={String(activeSkills)} /><Stat label="Triggers active" value={String(definition.triggers.filter((trigger: BotTrigger) => trigger.enabled).length)} /></div><div className="mt-4 border-t border-[#1e293b] pt-3 text-[11px] text-slate-400">{definition.ai.reasoningMode.toUpperCase()} · {definition.capabilities.automation ? 'Automation on' : 'Advisory access'}</div></div><div className="rounded-2xl border border-sky-900/50 bg-sky-950/10 p-4"><div className="text-xs font-bold text-sky-300">Quick Build</div><div className="mt-1 text-[11px] text-slate-400">Regenerate the same editable BotDefinition from a description.</div><textarea value={prompt} onChange={(event) => setPrompt(event.target.value)} placeholder="Describe your bot..." rows={3} className="mt-3 w-full resize-none rounded-xl border border-[#1e293b] bg-[#080d16] p-2 text-xs text-white outline-none focus:border-sky-500" /><button onClick={generate} disabled={!prompt.trim()} className="mt-2 flex w-full items-center justify-center gap-2 rounded-xl bg-sky-600 py-2.5 text-xs font-bold text-white disabled:opacity-40"><Sparkles className="h-3.5 w-3.5" />Generate configuration</button></div></aside>;

const ReviewStep: React.FC<{ definition: BotDefinition }> = ({ definition }) => <div className="mx-auto max-w-3xl space-y-4"><div className="rounded-2xl border border-emerald-800/40 bg-emerald-950/20 p-5"><div className="text-xs font-bold uppercase tracking-wider text-emerald-300">Your bot is taking shape</div><div className="mt-2 text-xl font-bold text-white">{definition.identity.name}</div><div className="mt-1 text-sm text-slate-300">{definition.identity.description}</div></div><div className="grid gap-3 sm:grid-cols-2"><ReviewCard title="Intent" value={definition.intent.objective} /><ReviewCard title="Triggers" value={definition.triggers.map((trigger) => `${trigger.type.replaceAll('_', ' ')}${trigger.timeframe ? ` · ${trigger.timeframe}` : ''}`).join(' · ')} /><ReviewCard title="Skills" value={Object.values(definition.skills).flat().join(' · ') || 'None selected'} /><ReviewCard title="Risk" value={`${definition.risk.riskPerTrade * 100}% per trade · ${definition.risk.maxPositions} max positions`} /><ReviewCard title="AI mode" value={`${definition.ai.reasoningMode.toUpperCase()} · ${definition.ai.confidenceThreshold * 100}% confidence`} /></div></div>;
const TestStep: React.FC<any> = ({ definition, saved, result, progress, market, timeframe, period, balance, setMarket, setTimeframe, setPeriod, setBalance, runTest, isTesting }) => <div className="mx-auto max-w-4xl space-y-4"><div className="grid gap-3 rounded-2xl border border-[#1e293b] bg-[#0f172a] p-4 sm:grid-cols-4"><SelectField label="Market context" value={market} options={markets.map((item) => item.id)} onChange={setMarket} /><SelectField label="Timeframe" value={timeframe} options={['5m', '15m', '1h', '4h', '1d']} onChange={setTimeframe} /><SelectField label="Historical period" value={period} options={['7D', '30D', '90D', '6M', '1Y']} onChange={setPeriod} /><NumberField label="Initial balance" value={balance} suffix="$" onChange={setBalance} /></div><div className="rounded-2xl border border-indigo-800/50 bg-indigo-950/20 p-5"><div className="flex flex-wrap items-center justify-between gap-3"><div><div className="text-[10px] font-bold uppercase tracking-wider text-indigo-300">Historical simulation</div><div className="mt-1 text-base font-bold text-white">{isTesting ? progress.phase === 'preparing' ? 'Preparing historical data...' : progress.phase === 'settling' ? 'Settling positions...' : `Replaying market conditions · ${progress.processed}/${progress.total} candles` : result ? 'Backtest complete' : 'See what your bot would have done'}</div><div className="mt-1 text-xs text-slate-400">{result ? `${result.trades.length} trades · ${result.triggerStats.reduce((sum: number, stat: BotBacktestTriggerStat) => sum + stat.fired, 0)} trigger wakes` : 'TradingVibe will fetch the selected historical range and replay it one candle at a time.'}</div></div>{!result && <button onClick={runTest} disabled={isTesting} className="rounded-xl bg-indigo-600 px-4 py-2.5 text-xs font-bold text-white disabled:opacity-50">{isTesting ? 'Simulating...' : 'Run now'}</button>}</div>{isTesting && <div className="mt-4 h-1.5 overflow-hidden rounded-full bg-indigo-950"><div className="h-full bg-indigo-400 transition-all" style={{ width: `${progress.total ? Math.round((progress.processed / progress.total) * 100) : 0}%` }} /></div>}{result && <ResultShowcase result={result} />}</div><div className="grid gap-2 sm:grid-cols-3"><Stat label="Triggers configured" value={String(definition.triggers.length)} /><Stat label="Risk protected" value="Yes" /><Stat label="Decision mode" value={definition.ai.reasoningMode} /></div></div>;

const ResultShowcase: React.FC<{ result: BotBacktestResult }> = ({ result }) => {
  const max = Math.max(...result.equityCurve.map((point) => point.equity), result.initialBalance);
  const min = Math.min(...result.equityCurve.map((point) => point.equity), result.initialBalance);
  const range = Math.max(1, max - min);
  const points = result.equityCurve.map((point, index) => `${(index / Math.max(1, result.equityCurve.length - 1)) * 100},${100 - ((point.equity - min) / range) * 88 - 6}`).join(' ');
  const activity = result.events.filter((event) => event.type !== 'TRIGGER_EVALUATED').slice(-5);
  return <div className="mt-5 space-y-4"><div className="grid gap-3 sm:grid-cols-4"><div className={`rounded-xl border p-3 ${result.netPnl >= 0 ? 'border-emerald-800/50 bg-emerald-950/20' : 'border-rose-800/50 bg-rose-950/20'}`}><div className="text-[10px] text-slate-400">Net P&L</div><div className={`mt-1 text-xl font-bold ${result.netPnl >= 0 ? 'text-emerald-300' : 'text-rose-300'}`}>{result.netPnl >= 0 ? '+' : ''}${result.netPnl.toFixed(2)}</div><div className="text-[11px] text-slate-400">{result.returnPct >= 0 ? '+' : ''}{result.returnPct}% return</div></div><Stat label="Win rate" value={`${result.winRate}%`} /><Stat label="Profit factor" value={String(result.profitFactor)} /><Stat label="Max drawdown" value={`$${result.maxDrawdown.toFixed(2)}`} /></div>{result.gaps.length > 0 && <div className="rounded-xl border border-amber-800/50 bg-amber-950/20 p-3 text-xs text-amber-200">Historical data contains {result.gaps.length} legitimate market-data gap{result.gaps.length === 1 ? '' : 's'}; no candles were fabricated.</div>}<div className="rounded-xl border border-[#1e293b] bg-[#0b1220] p-3"><div className="mb-2 flex items-center justify-between"><span className="text-xs font-bold text-white">Equity curve</span><span className="text-[10px] text-slate-500">Historical simulation</span></div><svg viewBox="0 0 100 100" preserveAspectRatio="none" className="h-40 w-full"><polyline points={points} fill="none" stroke={result.netPnl >= 0 ? '#34d399' : '#fb7185'} strokeWidth="1.5" vectorEffect="non-scaling-stroke" /></svg></div><div className="grid gap-2 sm:grid-cols-2"><div className="rounded-xl border border-[#1e293b] bg-[#0b1220] p-3"><div className="mb-2 text-xs font-bold text-white">Trigger wakes</div>{result.triggerStats.map((stat) => <div key={stat.triggerId} className="flex justify-between py-1 text-[11px] text-slate-400"><span>{stat.type.replaceAll('_', ' ')}</span><span className="text-slate-200">{stat.fired} fired / {stat.evaluations} evaluations</span></div>)}</div><div className="rounded-xl border border-[#1e293b] bg-[#0b1220] p-3"><div className="mb-2 text-xs font-bold text-white">Bot activity</div>{activity.map((event) => <div key={event.id} className="flex gap-2 border-t border-[#1e293b] py-1.5 text-[11px]"><span className="text-slate-500">{event.type}</span><span className="text-slate-300">{event.type === 'TRIGGER' ? String((event.data as { reason?: string }).reason || 'Trigger fired') : event.type === 'DECISION' ? String((event.data as { reason?: string }).reason || 'Decision recorded') : 'Simulation event'}</span></div>)}</div></div><div className="rounded-xl border border-[#1e293b] bg-[#0b1220] p-3"><div className="mb-2 text-xs font-bold text-white">Trades</div>{result.trades.length === 0 ? <div className="text-xs text-slate-500">No simulated trades were generated.</div> : result.trades.map((trade) => <div key={trade.id} className="flex items-center justify-between border-t border-[#1e293b] py-2 text-xs"><span className={trade.side === 'BUY' ? 'text-emerald-300' : 'text-rose-300'}>{trade.side === 'BUY' ? 'LONG' : 'SHORT'}</span><span className="text-slate-400">{trade.entryPrice} → {trade.exitPrice}</span><span className={trade.pnl >= 0 ? 'text-emerald-300' : 'text-rose-300'}>{trade.pnl >= 0 ? '+' : ''}${trade.pnl.toFixed(2)}</span></div>)}</div></div>;
};
const DeployStep: React.FC<any> = ({ definition, market, setMarket, mode, setMode, accountId, setAccountId }) => <div className="mx-auto max-w-2xl space-y-4"><div><div className="text-base font-bold text-white">Deploy {definition.identity.name}</div><div className="mt-1 text-xs text-slate-400">This is where a reusable BotDefinition gets bound to a market. You can create more deployments later.</div></div><div className="grid gap-2 sm:grid-cols-2">{markets.map((item) => <button key={item.id} onClick={() => setMarket(item.id)} className={`rounded-xl border p-3 text-left ${market === item.id ? 'border-sky-500 bg-sky-950/30' : 'border-[#1e293b] bg-[#0f172a]'}`}><div className="text-xs font-bold text-white">{item.label}</div><div className="mt-1 text-[10px] text-slate-500">{item.group}</div></button>)}</div><div className="grid gap-3 sm:grid-cols-2"><Field label="Account" value={accountId} onChange={setAccountId} /><SelectField label="Mode" value={mode} options={['paper', 'demo']} onChange={(value) => setMode(value as 'paper' | 'demo')} /></div></div>;

const skillValues = (definition: BotDefinition): string[][] => Object.values(definition.skills);
const periodMilliseconds = (period: string): number => ({ '7D': 7, '30D': 30, '90D': 90, '6M': 180, '1Y': 365 }[period] || 30) * 24 * 60 * 60 * 1000;
const newTrigger = (id: string, now: number): BotTrigger => ({ id, type: 'NEW_BAR', enabled: true, timeframe: '15m', config: {}, cooldownMs: 0, createdAt: now, updatedAt: now });
const SectionTitle: React.FC<{ title: string; subtitle?: string }> = ({ title, subtitle }) => <div className="mb-4"><div className="text-sm font-bold text-white">{title}</div>{subtitle && <div className="mt-1 text-[11px] leading-relaxed text-slate-400">{subtitle}</div>}</div>;
const Field: React.FC<{ label: string; value: string; onChange: (value: string) => void }> = ({ label, value, onChange }) => <label className="text-[11px] text-slate-400">{label}<input value={value} onChange={(event) => onChange(event.target.value)} className="mt-1 w-full rounded-xl border border-[#1e293b] bg-[#080d16] p-2.5 text-xs text-white outline-none focus:border-sky-500" /></label>;
const TextArea: React.FC<{ label: string; value: string; onChange: (value: string) => void }> = ({ label, value, onChange }) => <label className="block text-[11px] text-slate-400">{label}<textarea value={value} onChange={(event) => onChange(event.target.value)} rows={2} className="mt-1 w-full resize-y rounded-xl border border-[#1e293b] bg-[#080d16] p-2.5 text-xs text-white outline-none focus:border-sky-500" /></label>;
const NumberField: React.FC<{ label: string; value: number; suffix?: string; onChange: (value: number) => void }> = ({ label, value, suffix, onChange }) => <label className="text-[11px] text-slate-400">{label}<div className="mt-1 flex items-center rounded-xl border border-[#1e293b] bg-[#080d16]"><input type="number" min="0" value={value} onChange={(event) => onChange(Number(event.target.value))} className="w-full bg-transparent p-2.5 text-xs text-white outline-none" />{suffix && <span className="pr-3 text-[11px] text-slate-500">{suffix}</span>}</div></label>;
const SelectField: React.FC<{ label: string; value: string; options: string[]; onChange: (value: string) => void }> = ({ label, value, options, onChange }) => <label className="block text-[11px] text-slate-400">{label}<select value={value} onChange={(event) => onChange(event.target.value)} className="mt-1 w-full rounded-xl border border-[#1e293b] bg-[#080d16] p-2.5 text-xs text-white outline-none">{options.map((option) => <option key={option}>{option}</option>)}</select></label>;
const Toggle: React.FC<{ label: string; value: boolean; onChange: () => void }> = ({ label, value, onChange }) => <button onClick={onChange} className="flex w-full items-center justify-between rounded-xl border border-[#1e293b] bg-[#0b1220] p-3 text-xs"><span className="text-slate-200">{label}</span><span className={`rounded-full px-2 py-0.5 text-[10px] font-bold ${value ? 'bg-emerald-500/20 text-emerald-300' : 'bg-slate-800 text-slate-500'}`}>{value ? 'ON' : 'OFF'}</span></button>;
const Stat: React.FC<{ label: string; value: string }> = ({ label, value }) => <div className="rounded-xl border border-[#1e293b] bg-[#0b1220] p-3"><div className="text-[10px] text-slate-500">{label}</div><div className="mt-1 text-xs font-bold text-white">{value}</div></div>;
const ReviewCard: React.FC<{ title: string; value: string }> = ({ title, value }) => <div className="rounded-xl border border-[#1e293b] bg-[#0f172a] p-4"><div className="text-[10px] font-bold uppercase tracking-wider text-slate-500">{title}</div><div className="mt-2 text-xs leading-relaxed text-slate-200">{value}</div></div>;
