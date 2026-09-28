import { InstrumentMetadata } from '../../../types/instruments';
import { ITradingEnvironment } from '../types';

/**
 * Instrument metadata access for agent capabilities.
 *
 * Capabilities ask the environment what it can trade. They never infer
 * instrument facts from a symbol name, and they never assume a provider.
 */
export async function resolveInstrument(
  env: ITradingEnvironment,
  symbol: string,
): Promise<InstrumentMetadata | undefined> {
  if (!env.getInstruments) return undefined;

  try {
    const instruments = await env.getInstruments();

    if (!Array.isArray(instruments)) return undefined;

    return instruments.find(
      (candidate) =>
        candidate.symbol === symbol ||
        candidate.providerSymbol === symbol ||
        candidate.displayName === symbol,
    );
  } catch {
    return undefined;
  }
}

export async function resolveInstruments(
  env: ITradingEnvironment,
): Promise<InstrumentMetadata[]> {
  if (!env.getInstruments) return [];

  try {
    const instruments = await env.getInstruments();

    return Array.isArray(instruments) ? instruments : [];
  } catch {
    return [];
  }
}

/** Pip size, only when the instrument actually declares one. */
export function pipSizeFor(
  metadata: InstrumentMetadata | undefined,
): number | undefined {
  const pipSize = metadata?.pipSize;

  return typeof pipSize === 'number' && pipSize > 0
    ? pipSize
    : undefined;
}

/** Lot size, only when the instrument is sized in lots. */
export function lotSizeFor(
  metadata: InstrumentMetadata | undefined,
): number | undefined {
  const lotSize = metadata?.lotSize;

  return typeof lotSize === 'number' && lotSize > 0
    ? lotSize
    : undefined;
}
