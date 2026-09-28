import React, { useState, useEffect } from 'react';
import {
  User as UserIcon,
  Mail,
  ShieldCheck,
  Briefcase,
  Bot,
  Layers,
  Save,
  CheckCircle2,
  ArrowLeft,
  LogOut,
} from 'lucide-react';
import { User, userService } from '../../services/userService';

interface ProfileViewProps {
  onBack: () => void;
  onUserUpdated?: (user: User) => void;
}

export const ProfileView: React.FC<ProfileViewProps> = ({ onBack, onUserUpdated }) => {
  const [user, setUser] = useState<User | null>(null);
  const [username, setUsername] = useState('');
  const [email, setEmail] = useState('');
  const [isSaving, setIsSaving] = useState(false);
  const [saveSuccess, setSaveSuccess] = useState(false);

  useEffect(() => {
    userService.getCurrentUser().then((u) => {
      setUser(u);
      setUsername(u.username);
      setEmail(u.email);
    });
  }, []);

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!username.trim() || !email.trim()) return;

    setIsSaving(true);
    const updated = await userService.updateProfile({
      username: username.trim(),
      email: email.trim(),
    });
    setUser(updated);
    if (onUserUpdated) onUserUpdated(updated);
    setIsSaving(false);
    setSaveSuccess(true);
    setTimeout(() => setSaveSuccess(false), 2500);
  };

  if (!user) {
    return (
      <div className="flex-1 flex items-center justify-center p-6 text-slate-400 text-xs">
        Loading profile...
      </div>
    );
  }

  return (
    <div className="flex-1 overflow-y-auto px-4 py-5 pb-24 md:pb-8 max-w-2xl mx-auto w-full space-y-6">
      {/* Top Header */}
      <div className="flex items-center gap-3">
        <button
          onClick={onBack}
          className="p-2 rounded-xl text-slate-300 hover:text-white hover:bg-[#162032] border border-[#1e293b] transition-colors"
          title="Go back"
        >
          <ArrowLeft className="w-4 h-4" />
        </button>
        <div>
          <h1 className="text-lg font-bold text-white tracking-tight">User Profile</h1>
          <p className="text-xs text-slate-400">Manage your TradingVibe trader identity and account stats</p>
        </div>
      </div>

      {/* Avatar Hero Card */}
      <div className="p-6 rounded-2xl bg-gradient-to-br from-[#0e1728] via-[#0b1220] to-[#080d16] border border-[#1e293b] flex flex-col sm:flex-row items-center gap-4 text-center sm:text-left shadow-lg">
        <div className="relative">
          <div className="w-20 h-20 rounded-full bg-gradient-to-tr from-sky-500 via-indigo-500 to-purple-600 flex items-center justify-center text-white text-3xl font-bold font-mono shadow-md border-2 border-white/10">
            {username.charAt(0).toUpperCase()}
          </div>
          <span className="absolute bottom-0 right-0 w-5 h-5 rounded-full bg-emerald-500 border-2 border-[#0c121e]" />
        </div>

        <div className="space-y-1 flex-1">
          <div className="flex flex-wrap items-center justify-center sm:justify-start gap-2">
            <h2 className="text-xl font-bold text-white font-sans">{username}</h2>
            <span className="px-2.5 py-0.5 rounded-full text-[11px] font-bold font-mono bg-sky-500/20 text-sky-300 border border-sky-500/30">
              {user.tier} TRADER
            </span>
          </div>
          <div className="text-xs text-slate-400 font-mono">{email}</div>
          <div className="text-[11px] text-slate-500 pt-0.5">
            Member since {new Date(user.createdAt).toLocaleDateString(undefined, { month: 'short', year: 'numeric' })}
          </div>
        </div>
      </div>

      {/* Profile Form */}
      <form onSubmit={handleSave} className="space-y-5">
        {/* Personal Information */}
        <div className="space-y-3">
          <h3 className="text-xs font-bold uppercase tracking-wider text-slate-400 px-1">
            Personal Information
          </h3>

          <div className="p-4 rounded-2xl bg-[#0b1220] border border-[#1e293b] space-y-3.5 shadow-xs">
            <div>
              <label className="text-xs text-slate-300 font-semibold block mb-1.5 flex items-center gap-1.5">
                <UserIcon className="w-3.5 h-3.5 text-sky-400" />
                <span>Username</span>
              </label>
              <input
                type="text"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                className="w-full bg-[#080d16] border border-[#1e293b] rounded-xl px-3.5 py-2.5 text-xs text-white placeholder-slate-500 focus:outline-none focus:border-sky-500 transition-colors"
                placeholder="Enter username"
                required
              />
            </div>

            <div>
              <label className="text-xs text-slate-300 font-semibold block mb-1.5 flex items-center gap-1.5">
                <Mail className="w-3.5 h-3.5 text-sky-400" />
                <span>Email Address</span>
              </label>
              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                className="w-full bg-[#080d16] border border-[#1e293b] rounded-xl px-3.5 py-2.5 text-xs text-white placeholder-slate-500 focus:outline-none focus:border-sky-500 transition-colors"
                placeholder="Enter email address"
                required
              />
            </div>
          </div>
        </div>

        {/* Account Activity Summary */}
        <div className="space-y-3">
          <h3 className="text-xs font-bold uppercase tracking-wider text-slate-400 px-1">
            Account Stats
          </h3>

          <div className="grid grid-cols-3 gap-2.5">
            <div className="p-3.5 rounded-2xl bg-[#0b1220] border border-[#1e293b] text-center shadow-xs">
              <div className="p-2 w-fit rounded-xl bg-sky-500/10 text-sky-400 mx-auto mb-1.5">
                <Briefcase className="w-4 h-4" />
              </div>
              <div className="text-lg font-bold font-mono text-white">{user.tradingAccountsCount}</div>
              <div className="text-[11px] text-slate-400">Accounts</div>
            </div>

            <div className="p-3.5 rounded-2xl bg-[#0b1220] border border-[#1e293b] text-center shadow-xs">
              <div className="p-2 w-fit rounded-xl bg-purple-500/10 text-purple-400 mx-auto mb-1.5">
                <Bot className="w-4 h-4" />
              </div>
              <div className="text-lg font-bold font-mono text-white">{user.botsCount}</div>
              <div className="text-[11px] text-slate-400">Bots</div>
            </div>

            <div className="p-3.5 rounded-2xl bg-[#0b1220] border border-[#1e293b] text-center shadow-xs">
              <div className="p-2 w-fit rounded-xl bg-emerald-500/10 text-emerald-400 mx-auto mb-1.5">
                <Layers className="w-4 h-4" />
              </div>
              <div className="text-lg font-bold font-mono text-white">{user.tradesCount}</div>
              <div className="text-[11px] text-slate-400">Trades</div>
            </div>
          </div>
        </div>

        {/* Save Button */}
        <div className="pt-2">
          <button
            type="submit"
            disabled={isSaving}
            className={`w-full py-3.5 rounded-xl font-bold text-xs transition-all flex items-center justify-center gap-2 shadow-md ${
              saveSuccess
                ? 'bg-emerald-600 text-white shadow-emerald-950'
                : 'bg-sky-600 hover:bg-sky-500 text-white shadow-sky-950 active:scale-98'
            }`}
          >
            {saveSuccess ? <CheckCircle2 className="w-4 h-4" /> : <Save className="w-4 h-4" />}
            <span>{saveSuccess ? 'Changes Saved Successfully!' : isSaving ? 'Saving...' : 'Save Changes'}</span>
          </button>
        </div>
      </form>
    </div>
  );
};
