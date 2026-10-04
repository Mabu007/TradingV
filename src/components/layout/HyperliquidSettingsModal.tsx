import React from 'react';
import { ShieldCheck, TriangleAlert } from 'lucide-react';
import {
  VENUE_ENVIRONMENTS,
  describeVenue,
  venueFor,
  type VenueEnvironment,
} from '../../config/venue';

interface Props {
  isOpen: boolean;
  /** The environment the client is currently bound to. */
  environment: VenueEnvironment;
  /** What the connection is doing, for the honest label under the picker. */
  status?: string;
  onSave: (environment: VenueEnvironment) => void;
  onClose: () => void;
}

/**
 * The venue settings.
 *
 * The environment is stated in words as well as in the picker, because
 * "Mainnet" and "Testnet" differ by exactly one character and by the
 * difference between a simulation and someone's account. The user is told
 * which one they are in, what that means, and what it would take for a
 * GOAT to be allowed to trade there.
 */
export const HyperliquidSettingsModal: React.FC<Props> = ({
  isOpen,
  environment,
  status,
  onSave,
  onClose,
}) => {
  if (!isOpen) return null;
  const venue = venueFor(environment);

  return (
    <div className="fixed inset-0 z-50 bg-overlay flex items-center justify-center p-4">
      <div className="w-full max-w-md rounded-2xl border border-line bg-surface p-5 shadow-2xl">
        <h2 className="text-base font-bold text-ink">Hyperliquid Connection</h2>
        <p className="mt-1 text-xs text-ink-3">
          Public market data uses REST and WebSocket. Trading is simulated in this build.
        </p>

        <label className="mt-5 block text-xs font-mono text-ink-3">Market data environment</label>
        <select
          value={environment}
          onChange={(event) => onSave(event.target.value as VenueEnvironment)}
          className="mt-2 w-full rounded-lg border border-line bg-surface-3 px-3 py-2 text-sm text-ink"
        >
          {VENUE_ENVIRONMENTS.map((option) => (
            <option key={option} value={option}>
              {option === 'MAINNET' ? 'Hyperliquid Mainnet' : 'Hyperliquid Testnet'}
            </option>
          ))}
        </select>

        <div
          className={`mt-3 flex items-start gap-2 rounded-lg border px-3 py-2.5 text-[11px] ${
            venue.isLive
              ? 'border-amber-500/30 bg-amber-500/10 text-amber-300'
              : 'border-line bg-surface-3 text-ink-3'
          }`}
        >
          {venue.isLive ? (
            <TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          ) : (
            <ShieldCheck className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          )}
          <div>
            <div className="font-semibold">{describeVenue(environment)}</div>
            <div className="mt-0.5 font-mono text-[10px] opacity-80">{venue.host}</div>
          </div>
        </div>

        <p className="mt-3 text-[11px] text-ink-3">
          A GOAT is deployed to one environment, and it cannot act in the other. Switching here
          re-reads every market from {venue.isLive ? 'Mainnet' : 'Testnet'}; nothing from the
          previous environment is carried across.
        </p>

        <div className="mt-3 flex items-center gap-2 text-[11px] text-ink-3">
          <span
            className={`h-1.5 w-1.5 rounded-full ${
              status === 'CONNECTED'
                ? 'bg-emerald-400'
                : status === 'STALE'
                  ? 'bg-amber-400'
                  : status === 'ERROR'
                    ? 'bg-red-400'
                    : 'bg-ink-3/50'
            }`}
          />
          Feed: {status?.toLowerCase() ?? 'not connected'}
        </div>

        <p className="mt-3 text-[11px] text-warn">
          Wallet keys and signing credentials are not accepted or stored by this frontend.
        </p>

        <div className="mt-5 flex justify-end">
          <button
            onClick={onClose}
            className="rounded-lg bg-accent-strong px-4 py-2 text-xs font-semibold text-accent-contrast"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
};
