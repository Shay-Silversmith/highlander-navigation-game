import { GraphStore } from './adapters/graphStore.js';
import { OfflineProvider, OverpassProvider } from './adapters/overpass.js';
import { buildApp } from './app.js';
import { loadConfig } from './config.js';

const config = loadConfig();
const graphs = new GraphStore({
  provider: config.offline
    ? new OfflineProvider()
    : new OverpassProvider({ endpoints: config.overpassUrls, timeoutMs: config.overpassTimeoutMs }),
  cacheDir: config.graphCacheDir,
  bundledDir: config.bundledGraphDir,
  areaHalfSizeM: config.rules.goalMaxRouteM * 2 + config.rules.maxSnapM,
  maxAreasInMemory: 8,
  log: (message, details) => app.log.info(details ?? {}, message),
});
const app = await buildApp({ config, graphs });

// Finish in-flight requests on `docker stop` instead of dropping them.
for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.once(signal, () => {
    app.log.info({ signal }, 'shutting down');
    void app.close().then(() => process.exit(0));
  });
}

await app.listen({ port: config.port, host: config.host });
