/**
 * Credential-shaped strings, removed before anything is logged or shown.
 *
 * Its own module because both the provider and the failure classifier need
 * it, and a re-export through the provider would make those two import
 * each other.
 *
 * Applied to every string on its way to a log or a user. The reason to do
 * it at the boundary rather than trusting each call site is that the value
 * being redacted is usually a response body from a provider that has
 * nothing to redact it — and a provider error page can echo back the
 * credential that was sent to it.
 */
export function redactSecrets(value: string): string {
  return value
    .replace(/sk-or-v1-[A-Za-z0-9_-]{4,}/g, '[redacted]')
    .replace(/Bearer\s+[A-Za-z0-9._-]{8,}/gi, 'Bearer [redacted]')
    .replace(/\bsk-[A-Za-z0-9_-]{16,}/g, '[redacted]')
    .replace(/eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{4,}/g, '[redacted]');
}
