import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../server/src/app.js';
import { loadConfig } from '../server/src/config.js';
import { GraphStore } from '../server/src/adapters/graphStore.js';
import { MapDataUnavailableError } from '../server/src/adapters/overpass.js';
import { RoadGraph } from '../server/src/core/graph.js';

const apps: FastifyInstance[] = [];
const position = {lat: 0, lon: 0, accuracyM: 5};
const graph = new RoadGraph({
  bbox: {south: -0.1, west: -0.1, north: 0.1, east: 0.1},
  lat: [0, 0, 0, 0], lon: [0, 0.003, 0.006, 0.009], edges: [0,1,1,2,2,3],
});
async function setup(fail?: Error) {
  const fetch = vi.fn(async () => {if(fail) throw fail; return graph;});
  const graphs = new GraphStore({provider: {fetch}, areaHalfSizeM: 2000, maxAreasInMemory: 2});
  const app = await buildApp({config: loadConfig({LOG_LEVEL: 'silent'}), graphs, random: () => 0});
  apps.push(app);
  return {app, fetch};
}
afterEach(async () => {await Promise.all(apps.splice(0).map(app => app.close()));});

describe('Part 1 HTTP contract', () => {
  it('serves health without downloading map data', async () => {
    const {app, fetch} = await setup();
    const res = await app.inject('/healthz');
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe('ok');
    expect(fetch).not.toHaveBeenCalled();
  });
  it('starts, reroutes to the unchanged goal, and detects accurate arrival', async () => {
    const {app} = await setup();
    const start = await app.inject({method: 'POST', url: '/api/games', payload: {position}});
    expect(start.statusCode).toBe(200);
    const state = start.json();
    expect(state.route.distanceM).toBeGreaterThanOrEqual(300);
    expect(state.route.distanceM).toBeLessThanOrEqual(800);
    expect(state.arrival).toBe('EN_ROUTE');
    const arrival = await app.inject({method: 'POST', url: '/api/route', payload: {position: {...state.goal, accuracyM: 5}, goal: state.goal}});
    expect(arrival.statusCode).toBe(200);
    expect(arrival.json().arrival).toBe('REACHED');
    const uncertain = await app.inject({method: 'POST', url: '/api/route', payload: {position: {...state.goal, accuracyM: 100}, goal: state.goal}});
    expect(uncertain.json().arrival).toBe('UNCERTAIN');
  });
  it.each([{}, {position: null}, {position: {...position, lat: 91}}, {position: {...position, lon: -181}}, {position: {...position, accuracyM: -1}}, {position: {...position, lat: '0'}}, {position, extra: true}])('rejects invalid input before graph access: %j', async payload => {
    const {app, fetch} = await setup();
    const res = await app.inject({method:'POST',url:'/api/games',payload});
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('INVALID_REQUEST');
    expect(fetch).not.toHaveBeenCalled();
  });
  it('bounds JSON size and rejects malformed JSON', async () => {
    const {app, fetch} = await setup();
    for (const [payload, status] of [['{',400], [JSON.stringify({padding:'x'.repeat(5000)}),413]] as const) {
      const res = await app.inject({method:'POST',url:'/api/games',headers:{'content-type':'application/json'},payload});
      expect(res.statusCode).toBe(status);
    }
    expect(fetch).not.toHaveBeenCalled();
  });
  it('rejects remote goals before unbounded map downloads', async () => {
    const {app, fetch} = await setup();
    const res = await app.inject({method:'POST',url:'/api/route',payload:{position,goal:{lat:40,lon:30}}});
    expect(res.statusCode).toBe(422);
    expect(fetch).not.toHaveBeenCalled();
  });
  it('returns retriable map failures without leaking provider details', async () => {
    const {app} = await setup(new MapDataUnavailableError('internal provider details'));
    const res = await app.inject({method:'POST',url:'/api/games',payload:{position}});
    expect(res.statusCode).toBe(503);
    expect(res.headers['retry-after']).toBe('10');
    expect(res.body).not.toContain('internal provider details');
  });
  it('hides unexpected internal errors', async () => {
    const {app} = await setup(new Error('private server details'));
    const res = await app.inject({method:'POST',url:'/api/games',payload:{position}});
    expect(res.statusCode).toBe(500);
    expect(res.body).not.toContain('private server details');
  });
  it('serves Leaflet locally', async () => {
    const {app} = await setup();
    const res = await app.inject('/vendor/leaflet/leaflet.js');
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('Leaflet');
  });
  it('preserves simulated provenance on start and route responses', async () => {
    const {app} = await setup();
    const start = await app.inject({method:'POST',url:'/api/games',payload:{position:{...position,simulated:true,ageMs:0}}});
    expect(start.statusCode).toBe(200);
    expect(start.json().positionSource).toBe('simulated');
    const goal=start.json().goal;
    const route=await app.inject({method:'POST',url:'/api/route',payload:{position:{...goal,accuracyM:5,simulated:true,ageMs:0},goal}});
    expect(route.statusCode).toBe(200);
    expect(route.json().positionSource).toBe('simulated');
  });
  it('does not award arrival for a stale fix', async () => {
    const {app} = await setup();
    const goal={lat:0,lon:0.003};
    const res=await app.inject({method:'POST',url:'/api/route',payload:{position:{...goal,accuracyM:5,ageMs:3600000,simulated:false},goal}});
    expect(res.statusCode).toBe(200);
    expect(res.json().arrival).toBe('UNCERTAIN');
    expect(res.json().positionSource).toBe('host');
  });
  it.each([{simulated:'true'},{ageMs:-1},{ageMs:'old'}])('rejects invalid source/freshness metadata %j',async metadata=>{
    const {app,fetch}=await setup();
    const res=await app.inject({method:'POST',url:'/api/games',payload:{position:{...position,...metadata}}});
    expect(res.statusCode).toBe(400);
    expect(fetch).not.toHaveBeenCalled();
  });
});
