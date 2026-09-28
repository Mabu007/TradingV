import { InstrumentMetadata } from '../types/instruments';
import { instrumentUnitsToLots } from './orderSize';

/**
 * Render an executed size without assuming a 100,000-unit Forex lot.
 *
 * Lot labels appear only for instruments whose metadata declares a lot
 * size (Forex). HIP-3 commodities and indices are always shown in the
 * instrument's own units.
 */
export function formatPositionSize(
  volume: number,
  metadata?: InstrumentMetadata | null,
): string {
  if (!Number.isFinite(volume)) {
    return '—';
  }

  const units = volume.toLocaleString();
  const lots = instrumentUnitsToLots(volume, metadata ?? undefined);

  return typeof lots === 'number' && Number.isFinite(lots)
    ? `${lots.toFixed(2)} Lots (${units} units)`
    : `${units} units`;
}
