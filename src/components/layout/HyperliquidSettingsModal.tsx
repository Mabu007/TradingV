import React from 'react';

interface Props { isOpen: boolean; network: 'testnet' | 'mainnet'; onSave: (network: 'testnet' | 'mainnet') => void; onClose: () => void }

export const HyperliquidSettingsModal: React.FC<Props> = ({ isOpen, network, onSave, onClose }) => {
  if (!isOpen) return null;
  return <div className="fixed inset-0 z-50 bg-black/70 flex items-center justify-center p-4">
    <div className="w-full max-w-md rounded-2xl border border-[#1e293b] bg-[#0b1220] p-5 shadow-2xl">
      <h2 className="text-base font-bold text-white">Hyperliquid Connection</h2>
      <p className="mt-1 text-xs text-slate-400">Public market data uses REST and WebSocket. Demo execution is simulated locally.</p>
      <label className="mt-5 block text-xs font-mono text-slate-400">Market data network</label>
      <select value={network} onChange={(event) => onSave(event.target.value as 'testnet' | 'mainnet')} className="mt-2 w-full rounded-lg border border-[#1e293b] bg-[#111927] px-3 py-2 text-sm text-white">
        <option value="mainnet">Hyperliquid Mainnet (public data)</option><option value="testnet">Hyperliquid Testnet</option>
      </select>
      <p className="mt-3 text-[11px] text-amber-300">Wallet keys and signing credentials are not accepted or stored by this frontend.</p>
      <div className="mt-5 flex justify-end"><button onClick={onClose} className="rounded-lg bg-sky-600 px-4 py-2 text-xs font-semibold text-white">Close</button></div>
    </div>
  </div>;
};
