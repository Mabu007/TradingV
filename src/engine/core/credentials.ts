/**
 * The credential boundary.
 *
 * The rule this file exists to enforce: **a secret is never a value the
 * browser can hold.** Not in a response body, not in bot configuration,
 * not in a Durable Object's state, not in a log line, not in a URL.
 *
 * The browser is told two things and two things only:
 *
 *   Credential: Hyperliquid account
 *   Status:     Connected
 *   Last verified: 2 minutes ago
 *
 * `CredentialStatus` is the only shape that crosses the wire, and it has
 * no field a secret could go in.
 *
 * ## V0 storage
 *
 * V0 has no secret manager. `InMemoryCredentialStore` holds secrets for
 * the lifetime of a process and nothing else, which is the safest thing
 * that works without infrastructure. It is deliberately unsuitable for
 * production and says so in `ready()`.
 *
 * For Cloudflare, the options are `Workers Secrets` (bound per Worker,
 * good for one account, not per user) and an external vault such as
 * AWS Secrets Manager or Infisical behind a `CredentialStore`
 * implementation. Both are identified in `docs/security.md` rather than
 * faked here. **An adapter that pretends to encrypt with a key in the
 * same process is worse than no adapter**, because it teaches reviewers
 * to trust a boundary that does not exist.
 */

import { TradingGOATsError, authError, configError } from './errors';

export type CredentialStatus = 'ABSENT' | 'UNVERIFIED' | 'VERIFIED' | 'INVALID';

/**
 * What the browser is allowed to know.
 *
 * Every field here is safe to serialise. Adding a field means adding
 * something safe to serialise; `secretBytes` is deliberately absent and
 * `assertNoSecrets` below checks that nothing slipped in.
 */
export interface CredentialStatusReport {
  /** Which account this is, e.g. `hyperliquid`. Not an identifier for a user. */
  provider: string;
  /** A non-reversible label the user chose, e.g. "Main account". Never a key. */
  label: string;
  status: CredentialStatus;
  /** When the credential was last proven to work against the venue. */
  lastVerifiedAt: number | null;
  /** When the secret was stored. */
  createdAt: number | null;
  /** The provider's own account identifier, if the venue exposes one. */
  externalAccountId?: string;
}

/** A secret, in memory only. Never serialised. */
export interface SecretMaterial {
  apiKey?: string;
  apiSecret?: string;
  privateKey?: string;
  passphrase?: string;
  [key: string]: string | undefined;
}

export interface StoreCredentialRequest {
  provider: string;
  label: string;
  secret: SecretMaterial;
  /** Whose credential this is. Enforced on every read. */
  userId: string;
  metadata?: Record<string, string>;
}

export interface CredentialStore {
  /**
   * Store or replace a credential.
   *
   * Storing is idempotent on `(userId, provider, label)`: storing the
   * same credential twice does not create a second one.
   */
  storeCredential(request: StoreCredentialRequest): Promise<CredentialStatusReport>;

  /**
   * Retrieve the secret for an outbound call.
   *
   * The only method that returns a secret, and the only place allowed to.
   * It records the access so "was this credential ever used?" is
   * answerable.
   */
  getCredentialForExecution(provider: string, userId: string, label: string): Promise<SecretMaterial>;

  /** The safe-to-serialise status. This is what the API returns. */
  getStatus(provider: string, userId: string, label: string): Promise<CredentialStatusReport>;

  /** Mark the credential as proven against the venue. */
  markVerified(provider: string, userId: string, label: string, at: number): Promise<void>;

  /** Mark the credential as rejected by the venue. */
  markInvalid(provider: string, userId: string, label: string, reason: string): Promise<void>;

  /** Remove the secret. Idempotent. */
  deleteCredential(provider: string, userId: string, label: string): Promise<boolean>;

  /**
   * Replace the secret, keeping the status history.
   *
   * Distinct from `storeCredential` so a rotation is visible as a
   * rotation rather than as a delete-then-create.
   */
  rotateCredential(provider: string, userId: string, label: string, secret: SecretMaterial): Promise<CredentialStatusReport>;

  /**
   * Whether this store can be used in production.
   *
   * `false` means secrets are lost on restart. A deployment that reports
   * LIVE must have checked this.
   */
  durable(): boolean;
}

interface Entry {
  provider: string;
  label: string;
  userId: string;
  secret: SecretMaterial;
  status: CredentialStatus;
  createdAt: number;
  lastVerifiedAt: number | null;
  lastAccessAt: number | null;
  externalAccountId?: string;
  invalidReason?: string;
}

/**
 * Process-local credential storage.
 *
 * Suitable for development and for the V0 test suite. **Not durable**:
 * a restart loses every secret, which is why `durable()` returns false
 * and a LIVE deployment must refuse to start on this store.
 */
export class InMemoryCredentialStore implements CredentialStore {
  private readonly entries = new Map<string, Entry>();
  private readonly accessLog: Array<{ provider: string; userId: string; label: string; at: number }> = [];

  constructor(private readonly now: () => number = () => Date.now()) {}

  durable(): boolean {
    return false;
  }

  async storeCredential(request: StoreCredentialRequest): Promise<CredentialStatusReport> {
    if (!request.userId) throw configError('A credential must have an owner.');
    if (!request.provider) throw configError('A credential must name a provider.');
    if (!request.label) throw configError('A credential must have a label.');
    assertNoEmptySecret(request.secret);

    const key = credentialKey(request.userId, request.provider, request.label);
    const existing = this.entries.get(key);
    const entry: Entry = {
      provider: request.provider,
      label: request.label,
      userId: request.userId,
      // Copied, so a caller mutating its object afterwards cannot change
      // what the adapter will later sign with.
      secret: { ...request.secret },
      // A new or replaced secret is UNVERIFIED, never VERIFIED. Carrying
      // over "verified" from the old secret would let an unproven key
      // trade on the strength of its predecessor.
      status: 'UNVERIFIED',
      createdAt: existing?.createdAt ?? this.now(),
      lastVerifiedAt: null,
      lastAccessAt: null,
      externalAccountId: existing?.externalAccountId,
    };
    this.entries.set(key, entry);
    return statusOf(entry);
  }

  async rotateCredential(provider: string, userId: string, label: string, secret: SecretMaterial): Promise<CredentialStatusReport> {
    const key = credentialKey(userId, provider, label);
    if (!this.entries.has(key)) {
      throw authError('There is no credential to rotate.', { details: { provider, label } });
    }
    assertNoEmptySecret(secret);
    const entry = this.entries.get(key)!;
    entry.secret = { ...secret };
    entry.status = 'UNVERIFIED';
    entry.lastVerifiedAt = null;
    entry.invalidReason = undefined;
    return statusOf(entry);
  }

  async getCredentialForExecution(provider: string, userId: string, label: string): Promise<SecretMaterial> {
    const entry = this.require(userId, provider, label);
    if (entry.status === 'INVALID') {
      throw authError('This credential was rejected by the venue and must be replaced.', {
        details: { provider, label, reason: entry.invalidReason },
      });
    }
    entry.lastAccessAt = this.now();
    this.accessLog.push({ provider, userId, label, at: entry.lastAccessAt });
    // Bounded: an unbounded access log is a slow leak of one record per
    // order attempt.
    if (this.accessLog.length > 1000) this.accessLog.splice(0, this.accessLog.length - 1000);
    return { ...entry.secret };
  }

  async getStatus(provider: string, userId: string, label: string): Promise<CredentialStatusReport> {
    const entry = this.require(userId, provider, label);
    return statusOf(entry);
  }

  async markVerified(provider: string, userId: string, label: string, at: number): Promise<void> {
    const entry = this.require(userId, provider, label);
    entry.status = 'VERIFIED';
    entry.lastVerifiedAt = at;
    entry.invalidReason = undefined;
  }

  async markInvalid(provider: string, userId: string, label: string, reason: string): Promise<void> {
    const entry = this.require(userId, provider, label);
    entry.status = 'INVALID';
    entry.invalidReason = reason;
    // Cleared: a rejected key should not sit in memory waiting to be
    // tried again.
    entry.secret = {};
  }

  async deleteCredential(provider: string, userId: string, label: string): Promise<boolean> {
    return this.entries.delete(credentialKey(userId, provider, label));
  }

  /** Whether a credential has ever been read, for diagnostics. */
  wasAccessed(provider: string, userId: string, label: string): boolean {
    return this.accessLog.some((entry) => entry.userId === userId && entry.provider === provider && entry.label === label);
  }

  private require(userId: string, provider: string, label: string): Entry {
    const entry = this.entries.get(credentialKey(userId, provider, label));
    if (!entry) {
      // The message does not distinguish "no such credential" from "not
      // yours", because telling an attacker which is the case is a free
      // oracle for enumerating other users' accounts.
      throw authError('No credential is configured for this account.', { details: { provider, label } });
    }
    return entry;
  }
}

function credentialKey(userId: string, provider: string, label: string): string {
  return `${userId}\u001f${provider}\u001f${label}`;
}

function statusOf(entry: Entry): CredentialStatusReport {
  return {
    provider: entry.provider,
    label: entry.label,
    status: entry.status,
    lastVerifiedAt: entry.lastVerifiedAt,
    createdAt: entry.createdAt,
    ...(entry.externalAccountId ? { externalAccountId: entry.externalAccountId } : {}),
  };
}

function assertNoEmptySecret(secret: SecretMaterial): void {
  const keys = Object.keys(secret).filter((key) => key !== 'externalAccountId');
  if (keys.length === 0) {
    throw configError('A credential must contain at least one secret field.');
  }
  for (const key of keys) {
    if (typeof secret[key] !== 'string' || secret[key]!.length === 0) {
      // The key name is safe to include; the value never is.
      throw configError(`Credential field "${key}" is empty.`, { details: { field: key } });
    }
  }
}

/**
 * Assert that a value carries nothing secret-shaped.
 *
 * Used on every response that crosses to a browser. `CredentialStatusReport`
 * is the intended shape, and this is the check that keeps it that way as
 * the type grows.
 */
export function assertNoSecrets(value: unknown, path = '$'): void {
  const SECRET_KEY = /^(api[-_]?key|api[-_]?secret|secret|private[-_]?key|signing[-_]?key|passphrase|seed|mnemonic|token)$/i;

  if (typeof value === 'string') {
    if (/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(value) || /\b0x[0-9a-fA-F]{64}\b/.test(value)) {
      throw new Error(`Refusing to serialise a secret-shaped string at ${path}.`);
    }
    return;
  }
  if (value === null || typeof value !== 'object') return;

  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoSecrets(item, `${path}[${index}]`));
    return;
  }
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (SECRET_KEY.test(key)) {
      throw new Error(`Refusing to serialise "${key}" at ${path}: it may contain a secret.`);
    }
    assertNoSecrets(entry, `${path}.${key}`);
  }
}

/** The store the process uses. A single instance, like every other singleton here. */
export const credentialStore: CredentialStore = new InMemoryCredentialStore();
