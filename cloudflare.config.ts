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
    },
  },
});
