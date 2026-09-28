import React, { useState } from 'react';
import { Brain, Check, Plus, Edit2, Shield, TrendingUp, Sliders, Clock } from 'lucide-react';
import { AISkill } from '../../types/trading';

interface SkillsViewProps {
  skills: AISkill[];
  onToggleSkill: (skillId: string) => void;
  onCreateCustomSkill: (skill: Omit<AISkill, 'id'>) => void;
}

export const SkillsView: React.FC<SkillsViewProps> = ({
  skills,
  onToggleSkill,
  onCreateCustomSkill,
}) => {
  const [filter, setFilter] = useState<'All' | 'Strategy' | 'Indicator' | 'Risk' | 'Session'>('All');
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [name, setName] = useState('');
  const [desc, setDesc] = useState('');
  const [instructions, setInstructions] = useState('');
  const [category, setCategory] = useState<AISkill['category']>('Strategy');

  const filtered = skills.filter((s) => (filter === 'All' ? true : s.category === filter));

  const handleCreate = (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim() || !instructions.trim()) return;
    onCreateCustomSkill({
      name: name.trim(),
      description: desc.trim(),
      instructions: instructions.trim(),
      category,
      enabled: true,
      examples: ['Custom Rule'],
    });
    setName('');
    setDesc('');
    setInstructions('');
    setShowCreateModal(false);
  };

  const getCategoryIcon = (cat: AISkill['category']) => {
    switch (cat) {
      case 'Strategy': return <TrendingUp className="w-4 h-4 text-sky-400" />;
      case 'Indicator': return <Sliders className="w-4 h-4 text-amber-400" />;
      case 'Risk': return <Shield className="w-4 h-4 text-rose-400" />;
      case 'Session': return <Clock className="w-4 h-4 text-emerald-400" />;
    }
  };

  return (
    <div className="flex-1 h-full overflow-y-auto p-6 bg-[#090d14] text-slate-200">
      <div className="max-w-6xl mx-auto space-y-6">
        {/* Header */}
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 pb-4 border-b border-[#1e293b]">
          <div>
            <h1 className="text-xl font-bold text-white tracking-tight">AI Strategy Skills</h1>
            <p className="text-xs text-slate-400 mt-0.5">
              Domain knowledge modules injected into the AI reasoning context when building and debugging strategies
            </p>
          </div>

          <div className="flex items-center gap-2">
            <div className="flex items-center bg-[#111927] p-0.5 rounded border border-[#1e293b] text-xs">
              {(['All', 'Strategy', 'Indicator', 'Risk', 'Session'] as const).map((cat) => (
                <button
                  key={cat}
                  onClick={() => setFilter(cat)}
                  className={`px-2.5 py-1 rounded transition-colors ${
                    filter === cat
                      ? 'bg-[#1e293b] text-white font-medium'
                      : 'text-slate-400 hover:text-slate-200'
                  }`}
                >
                  {cat}
                </button>
              ))}
            </div>

            <button
              onClick={() => setShowCreateModal(true)}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-sky-600 hover:bg-sky-500 text-white text-xs font-semibold transition-colors shadow-sm"
            >
              <Plus className="w-3.5 h-3.5" />
              <span>New Skill</span>
            </button>
          </div>
        </div>

        {/* Skills Cards Grid */}
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {filtered.map((skill) => (
            <div
              key={skill.id}
              className={`bg-[#0c121e] border rounded-lg p-4 flex flex-col justify-between transition-colors shadow-xs ${
                skill.enabled ? 'border-sky-500/40 bg-sky-950/10' : 'border-[#1e293b]'
              }`}
            >
              <div>
                <div className="flex items-start justify-between gap-2 mb-2">
                  <div className="flex items-center gap-2">
                    <div className="p-1.5 rounded bg-[#131c2e] border border-[#1e293b]">
                      {getCategoryIcon(skill.category)}
                    </div>
                    <h3 className="text-sm font-semibold text-white tracking-tight">{skill.name}</h3>
                  </div>

                  <span className="text-[10px] font-mono text-slate-400 uppercase">
                    {skill.category}
                  </span>
                </div>

                <p className="text-xs text-slate-400 mb-3 leading-relaxed">
                  {skill.description}
                </p>

                <div className="p-2.5 rounded bg-[#111927] border border-[#1e293b]/60 text-[11px] text-slate-300 font-sans mb-3">
                  <span className="text-[10px] text-slate-400 block uppercase font-mono mb-1">
                    System Instruction
                  </span>
                  {skill.instructions}
                </div>

                {skill.examples && skill.examples.length > 0 && (
                  <div className="flex flex-wrap gap-1 mb-3">
                    {skill.examples.map((ex, i) => (
                      <span
                        key={i}
                        className="text-[10px] font-mono px-1.5 py-0.2 rounded bg-[#162032] text-slate-300 border border-[#1e293b]"
                      >
                        {ex}
                      </span>
                    ))}
                  </div>
                )}
              </div>

              <div className="flex items-center justify-between pt-3 border-t border-[#1e293b]/60">
                <span className="text-[11px] text-slate-400 font-sans">
                  Status: <strong className={skill.enabled ? 'text-emerald-400' : 'text-slate-500'}>{skill.enabled ? 'Active in AI Context' : 'Disabled'}</strong>
                </span>

                <button
                  onClick={() => onToggleSkill(skill.id)}
                  className={`flex items-center gap-1.5 px-3 py-1 rounded text-xs font-medium transition-colors ${
                    skill.enabled
                      ? 'bg-emerald-600 hover:bg-emerald-500 text-white'
                      : 'bg-[#1e293b] hover:bg-[#334155] text-slate-300'
                  }`}
                >
                  {skill.enabled && <Check className="w-3 h-3" />}
                  <span>{skill.enabled ? 'Active' : 'Enable'}</span>
                </button>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Create Skill Modal */}
      {showCreateModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-xs p-4">
          <div className="w-full max-w-md bg-[#0c121e] border border-[#1e293b] rounded-lg shadow-2xl p-5 text-slate-200">
            <h3 className="text-sm font-bold text-white mb-1">Create Custom AI Skill</h3>
            <p className="text-xs text-slate-400 mb-4">
              Add domain guidance to direct how the AI structures your algorithms.
            </p>

            <form onSubmit={handleCreate} className="space-y-3 text-xs">
              <div>
                <label className="block text-slate-300 font-medium mb-1">Skill Name</label>
                <input
                  type="text"
                  required
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="e.g. Asia High/Low Liquidity Sweep"
                  className="w-full bg-[#131c2e] text-white border border-[#1e293b] rounded px-3 py-1.5 focus:outline-none focus:border-sky-500 text-xs"
                />
              </div>

              <div>
                <label className="block text-slate-300 font-medium mb-1">Category</label>
                <select
                  value={category}
                  onChange={(e) => setCategory(e.target.value as any)}
                  className="w-full bg-[#131c2e] text-white border border-[#1e293b] rounded px-2.5 py-1.5 focus:outline-none focus:border-sky-500 text-xs"
                >
                  <option value="Strategy">Strategy</option>
                  <option value="Indicator">Indicator</option>
                  <option value="Risk">Risk</option>
                  <option value="Session">Session</option>
                </select>
              </div>

              <div>
                <label className="block text-slate-300 font-medium mb-1">Short Description</label>
                <input
                  type="text"
                  value={desc}
                  onChange={(e) => setDesc(e.target.value)}
                  placeholder="e.g. Rules for identifying liquidity grabs outside the Asian session high"
                  className="w-full bg-[#131c2e] text-white border border-[#1e293b] rounded px-3 py-1.5 focus:outline-none focus:border-sky-500 text-xs"
                />
              </div>

              <div>
                <label className="block text-slate-300 font-medium mb-1">Instructions for AI Agent</label>
                <textarea
                  rows={4}
                  required
                  value={instructions}
                  onChange={(e) => setInstructions(e.target.value)}
                  placeholder="e.g. When generating code, always require a check for Asian session high/low before opening a London position..."
                  className="w-full bg-[#131c2e] text-white border border-[#1e293b] rounded px-3 py-1.5 focus:outline-none focus:border-sky-500 text-xs font-sans"
                />
              </div>

              <div className="flex items-center justify-end gap-2 pt-3 border-t border-[#1e293b]">
                <button
                  type="button"
                  onClick={() => setShowCreateModal(false)}
                  className="px-3 py-1.5 rounded text-xs text-slate-300 hover:text-white bg-[#1e293b] transition-colors"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="px-4 py-1.5 rounded text-xs font-semibold text-white bg-sky-600 hover:bg-sky-500 transition-colors shadow-sm"
                >
                  Add Skill
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
};
