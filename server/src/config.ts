import { resolve } from 'node:path';
import { z } from 'zod';

const number = (fallback: number, min: number, max: number) =>
  z.coerce.number().finite().min(min).max(max).default(fallback);

const schema = z
  .object({
    PORT: number(8080, 1, 65535),
    HOST: z.string().default('0.0.0.0'),
    LOG_LEVEL: z.string().default('info'),
    /** true: no outbound requests at all. Roads come from BUNDLED_GRAPH_DIR, the map is drawn from them. */
    OFFLINE: z.enum(['true', 'false', '1', '0', '']).default('false'),
    BUNDLED_GRAPH_DIR: z.string().default(resolve(process.cwd(), 'data/graphs')),
    WEB_DIR: z.string().default(resolve(process.cwd(), 'web')),
    GRAPH_CACHE_DIR: z.string().default(resolve(process.cwd(), '.cache/graphs')),
    OVERPASS_URLS: z
      .string()
      .default('https://overpass-api.de/api/interpreter,https://overpass.kumi.systems/api/interpreter'),
    OVERPASS_TIMEOUT_MS: number(25_000, 1_000, 120_000),
    TILE_URL: z.string().default('https://tile.openstreetmap.org/{z}/{x}/{y}.png'),
    GOAL_MIN_M: number(300, 30, 5_000),
    GOAL_MAX_M: number(800, 50, 5_000),
    REACH_THRESHOLD_M: number(20, 1, 500),
    MAX_ARRIVAL_ACCURACY_M: number(50, 1, 5_000),
    MAX_SNAP_M: number(250, 1, 5_000),
    MAX_FIX_AGE_MS: number(30_000, 1_000, 3_600_000),
    /** Where the simulator starts when the host has no usable location. Default: Tel Aviv. */
    DEMO_START: z
      .string()
      .regex(/^-?\d+(\.\d+)?,-?\d+(\.\d+)?$/)
      .default('32.0809,34.7806'),
  })
  .refine((env) => env.GOAL_MIN_M < env.GOAL_MAX_M, { message: 'GOAL_MIN_M must be below GOAL_MAX_M' })
  .refine((env) => env.REACH_THRESHOLD_M < env.GOAL_MIN_M, {
    message: 'REACH_THRESHOLD_M must be below GOAL_MIN_M, otherwise a game could start already won',
  });

export type Config = ReturnType<typeof loadConfig>;

/** Fails fast at boot on a bad value instead of misbehaving at the first request. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env) {
  const parsed = schema.parse(env);
  const offline = parsed.OFFLINE === 'true' || parsed.OFFLINE === '1';
  const [demoLat, demoLon] = parsed.DEMO_START.split(',').map(Number) as [number, number];
  return {
    port: parsed.PORT,
    host: parsed.HOST,
    logLevel: parsed.LOG_LEVEL,
    webDir: parsed.WEB_DIR,
    graphCacheDir: parsed.GRAPH_CACHE_DIR,
    overpassUrls: parsed.OVERPASS_URLS.split(',')
      .map((url) => url.trim())
      .filter(Boolean),
    overpassTimeoutMs: parsed.OVERPASS_TIMEOUT_MS,
    offline,
    bundledGraphDir: parsed.BUNDLED_GRAPH_DIR,
    tileUrl: offline ? '' : parsed.TILE_URL,
    demoStart: { lat: demoLat, lon: demoLon },
    rules: {
      goalMinRouteM: parsed.GOAL_MIN_M,
      goalMaxRouteM: parsed.GOAL_MAX_M,
      reachThresholdM: parsed.REACH_THRESHOLD_M,
      maxArrivalAccuracyM: parsed.MAX_ARRIVAL_ACCURACY_M,
      maxSnapM: parsed.MAX_SNAP_M,
      maxFixAgeMs: parsed.MAX_FIX_AGE_MS,
    },
  };
}
