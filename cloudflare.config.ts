import { bindings, defineConfig } from 'cf/config';
import * as entrypoint from './src/worker/index.ts' with { type: 'cf-worker' };

export default defineConfig({
  worker: {
    name: 'quest-traffic-simulation',
    compatibilityDate: '2026-11-23',
    entrypoint,
    observability: { enabled: true },
    assets: {
      notFoundHandling: 'single-page-application',
      runWorkerFirst: ['/api/*'],
    },
    env: {
      SCENARIOS: bindings.kv(),
      // Per-client request limits for the two endpoints that do real work.
      SIMULATE_LIMIT: bindings.rateLimit({ namespace: '1001', simple: { limit: 20, period: 60 } }),
      SAVE_LIMIT: bindings.rateLimit({ namespace: '1002', simple: { limit: 30, period: 60 } }),
    },
  },
});
