import { defineWorkersConfig } from '@cloudflare/vitest-pool-workers/config';

/**
 * Durable Object and Worker integration.
 *
 * Runs inside the real Workers runtime via Miniflare, so identity,
 * storage, routing and the authorisation gate are exercised as deployed
 * rather than mocked.
 *
 * Requires the Cloudflare runtime. If it is unavailable this suite fails
 * loudly; it is never counted as passing.
 */
export default defineWorkersConfig({
  test: {
    include: ['test-runtime/**/*.test.ts'],
    poolOptions: {
      workers: {
        wrangler: { configPath: './wrangler.toml' },
      },
    },
  },
});
