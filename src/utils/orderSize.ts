import { InstrumentMetadata } from '../types/instruments';

/**
 * Order sizing rules shared by every execution entry point.
 *
 * There is exactly one definition of "a valid order size" so the manual
 * ticket, the agent runtime, and the execution guard cannot disagree.
 *
 * Internal contract: order size is always provider instrument units.
 * Lots exist only as a Forex presentation of those units.
 */

export interface SizeValidation {
  valid: boolean;
  reason?: string;
}

export interface SnappedSize {
  /** Size snapped to the instrument's step, in instrument units. */
  value: number;
  /** True when the requested size had to be adjusted. */
  adjusted: boolean;
  /** True when no step is known and the size was passed through. */
  unconstrained: boolean;
}

/** Smallest size increment the instrument accepts, when known. */
export function sizeStepFor(
  metadata: InstrumentMetadata | undefined,
): number | undefined {
  const step = metadata?.sizeStep;

  if (typeof step === 'number' && Number.isFinite(step) && step > 0) {
    return step;
  }

  if (
    typeof metadata?.sizePrecision === 'number' &&
    metadata.sizePrecision >= 0
  ) {
    return 10 ** -metadata.sizePrecision;
  }

  return undefined;
}

/**
 * Snap a requested size onto the instrument's size grid.
 *
 * Used by the UI so a quick-size button or a lot conversion can never
 * produce a size the provider would reject.
 */
export function snapOrderSize(
  requested: number,
  metadata: InstrumentMetadata | undefined,
): SnappedSize {
  if (!Number.isFinite(requested) || requested <= 0) {
    return { value: 0, adjusted: true, unconstrained: false };
  }

  const step = sizeStepFor(metadata);

  if (!step) {
    return { value: requested, adjusted: false, unconstrained: true };
  }

  const steps = Math.round(requested / step);
  const scaled =
    Number(
      (steps * step).toFixed(
        Math.max(
          0,
          metadata?.sizePrecision ?? 0,
        ),
      ),
    );

  return {
    value: scaled,
    adjusted: scaled !== requested,
    unconstrained: false,
  };
}

/**
 * Strict validation used by the execution guard.
 *
 * Off-grid sizes are rejected instead of being silently corrected, so an
 * agent or client cannot believe it filled a size the venue would not
 * accept.
 */
export function validateOrderSize(
  requested: number,
  metadata: InstrumentMetadata | undefined,
): SizeValidation {
  if (typeof requested !== 'number' || !Number.isFinite(requested)) {
    return { valid: false, reason: 'Order size must be a finite number.' };
  }

  if (requested <= 0) {
    return { valid: false, reason: 'Order size must be greater than zero.' };
  }

  if (!metadata) {
    return {
      valid: false,
      reason: 'Unknown instrument: order metadata is unavailable.',
    };
  }

  const step = sizeStepFor(metadata);

  if (step) {
    const steps = requested / step;
    if (Math.abs(steps - Math.round(steps)) > 1e-9) {
      return {
        valid: false,
        reason: `Order size must be a multiple of ${step} ${metadata.symbol} units.`,
      };
    }
  }

  const minimum =
    typeof metadata.minOrderSize === 'number'
      ? metadata.minOrderSize
      : step;

  if (minimum !== undefined && requested < minimum) {
    return {
      valid: false,
      reason: `Order size must be at least ${minimum} ${metadata.symbol} units.`,
    };
  }

  if (
    typeof metadata.maxOrderSize === 'number' &&
    requested > metadata.maxOrderSize
  ) {
    return {
      valid: false,
      reason: `Order size must not exceed ${metadata.maxOrderSize} ${metadata.symbol} units.`,
    };
  }

  return { valid: true };
}

/**
 * Convert a user-facing lot count into provider instrument units.
 *
 * Only instruments whose metadata declares a lot size can be sized in
 * lots; everything else has no lot concept at all.
 */
export function lotsToInstrumentUnits(
  lots: number,
  metadata: InstrumentMetadata | undefined,
): { units: number; valid: boolean; reason?: string } {
  const lotSize = metadata?.lotSize;

  if (
    typeof lotSize !== 'number' ||
    !Number.isFinite(lotSize) ||
    lotSize <= 0
  ) {
    return {
      units: 0,
      valid: false,
      reason: `${metadata?.symbol ?? 'This instrument'} is not sized in lots.`,
    };
  }

  if (!Number.isFinite(lots) || lots <= 0) {
    return {
      units: 0,
      valid: false,
      reason: 'Lot size must be greater than zero.',
    };
  }

  return {
    units: snapOrderSize(lots * lotSize, metadata).value,
    valid: true,
  };
}

/** Express instrument units in lots, only for lot-based instruments. */
export function instrumentUnitsToLots(
  units: number,
  metadata: InstrumentMetadata | undefined,
): number | undefined {
  const lotSize = metadata?.lotSize;

  if (
    typeof lotSize !== 'number' ||
    !Number.isFinite(lotSize) ||
    lotSize <= 0
  ) {
    return undefined;
  }

  return units / lotSize;
}
