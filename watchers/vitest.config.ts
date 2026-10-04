import { defineConfig } from 'vitest/config';

/**
 * The default suite runs the decision logic with no Cloudflare runtime.
 *
 * That is not a compromise: `watcher.ts`, `wake-queue.ts`, `contract.ts`
 * and `health.ts` import no Cloudflare types, so the parts that actually
 * break - duplicate delivery, a stale latch, a queue under pressure, a
 * restart - are all covered here, and they run in milliseconds.
 *
 * The Durable Object and Worker plumbing lives in `vitest.runtime.config.ts`
 * and needs the Cloudflare runtime, which is a separate command. Keeping
 * them apart means a missing runtime is reported as a missing runtime
 * rather than as a green suite that quietly tested nothing.
 */
export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
  },
});
