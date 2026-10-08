import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import fastifyStatic from '@fastify/static';
import Fastify, { type FastifyInstance } from 'fastify';
import { z } from 'zod';
import { MapDataUnavailableError, OutsideCoverageError } from './adapters/overpass.js';
import type { GraphStore } from './adapters/graphStore.js';
import type { Config } from './config.js';
import { GameError, startGame, trackProgress, type Progress } from './core/game.js';
import { haversineM } from './core/geo.js';

const latLon = z.object({
  lat: z.number().finite().min(-90).max(90),
  lon: z.number().finite().min(-180).max(180),
});
const fix = latLon.extend({
  accuracyM: z.number().finite().min(0).max(1_000_000),
  /** Provenance travels with every position: a simulated fix is never mistaken for a host fix. */
  simulated: z.boolean().default(false),
  ageMs: z.number().finite().min(0).default(0),
});

const startGameBody = z.object({ position: fix }).strict();
const routeBody = z.object({ position: fix, goal: latLon }).strict();

export interface AppDeps {
  config: Config;
  graphs: GraphStore;
  random?: () => number;
}

const round = (value: number) => Math.round(value * 10) / 10;

function toDto(progress: Progress, position: { simulated: boolean }) {
  return {
    positionSource: position.simulated ? 'simulated' : 'host',
    route: { points: progress.route.points, distanceM: round(progress.route.distanceM) },
    distanceToGoalM: round(progress.distanceToGoalM),
    offRoadM: round(progress.offRoadM),
    arrival: progress.arrival,
  };
}

export async function buildApp({ config, graphs, random = Math.random }: AppDeps): Promise<FastifyInstance> {
  const app = Fastify({
    logger: { level: config.logLevel },
    bodyLimit: 4 * 1024,
  });
  const { rules } = config;
  // Extra map around the play area so a route may detour slightly outside the goal radius.
  const marginM = rules.maxSnapM + 150;

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof z.ZodError) {
      return reply.status(400).send({
        error: { code: 'INVALID_REQUEST', message: error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ') },
      });
    }
    if (error instanceof GameError) {
      return reply.status(422).send({ error: { code: error.code, message: error.message } });
    }
    if (error instanceof OutsideCoverageError) {
      return reply.status(422).send({ error: { code: 'OUTSIDE_COVERAGE', message: error.message } });
    }
    if (error instanceof MapDataUnavailableError) {
      request.log.warn({ err: error }, 'map data unavailable');
      return reply
        .status(503)
        .header('retry-after', '10')
        .send({ error: { code: 'MAP_DATA_UNAVAILABLE', message: 'Road data for this area could not be loaded. Try again shortly.' } });
    }
    const status = (error as { statusCode?: number }).statusCode;
    if (status && status >= 400 && status < 500) {
      return reply.status(status).send({ error: { code: 'INVALID_REQUEST', message: (error as Error).message } });
    }
    request.log.error({ err: error }, 'unhandled error');
    return reply.status(500).send({ error: { code: 'INTERNAL', message: 'Unexpected server error.' } });
  });

  app.get('/healthz', async () => ({ status: 'ok', loadedAreas: graphs.loadedAreas }));

  app.get('/api/config', async () => ({
    offline: config.offline,
    tileUrl: config.tileUrl,
    demoStart: config.demoStart,
    reachThresholdM: rules.reachThresholdM,
    maxArrivalAccuracyM: rules.maxArrivalAccuracyM,
    maxFixAgeMs: rules.maxFixAgeMs,
    goalMaxRouteM: rules.goalMaxRouteM,
  }));

  app.post('/api/games', async (request) => {
    const { position } = startGameBody.parse(request.body);
    const graph = await graphs.graphCovering([position], rules.goalMaxRouteM + marginM);
    const { goal, progress } = startGame(graph, position, rules, random);
    return { goal, ...toDto(progress, position) };
  });

  app.post('/api/route', async (request) => {
    const { position, goal } = routeBody.parse(request.body);
    // The client holds the goal (the server keeps no session), so bound what it can ask for:
    // a "goal" on another continent would otherwise make us download an arbitrary area.
    if (haversineM(position, goal) > rules.goalMaxRouteM * 4) {
      throw new GameError('OFF_NETWORK', 'The player is too far from the goal of this game. Start a new game.');
    }
    const graph = await graphs.graphCovering([position, goal], marginM);
    return toDto(trackProgress(graph, position, goal, rules), position);
  });

  // Road geometry of the play area, so the client can draw the map itself when hosted tiles
  // are disabled or unreachable. Coordinates are flat [lat, lon, lat, lon] per segment.
  app.get('/api/roads', async (request) => {
    const center = latLon.parse({
      lat: Number((request.query as Record<string, string>).lat),
      lon: Number((request.query as Record<string, string>).lon),
    });
    const graph = await graphs.graphCovering([center], marginM);
    const segments: number[] = [];
    const r = (value: number) => Math.round(value * 1e6) / 1e6;
    for (let e = 0; e < graph.edgeCount; e++) {
      const a = graph.edgeA[e]!;
      const b = graph.edgeB[e]!;
      segments.push(r(graph.lat[a]!), r(graph.lon[a]!), r(graph.lat[b]!), r(graph.lon[b]!));
    }
    return { bbox: graph.bbox, segments };
  });

  const leafletDist = join(dirname(createRequire(import.meta.url).resolve('leaflet/package.json')), 'dist');
  await app.register(fastifyStatic, { root: config.webDir, cacheControl: false });
  // Leaflet is served from our own origin so the page has no CDN dependency.
  await app.register(fastifyStatic, { root: leafletDist, prefix: '/vendor/leaflet/', decorateReply: false });

  return app;
}
