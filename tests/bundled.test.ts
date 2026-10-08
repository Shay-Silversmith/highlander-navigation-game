import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { startGame, trackProgress, type GameRules } from '../server/src/core/game.js';
import { haversineM } from '../server/src/core/geo.js';
import { parseRoadGraphData, RoadGraph } from '../server/src/core/graph.js';
import { snapToRoad, type Snap } from '../server/src/core/routing.js';

// The real OpenStreetMap graph shipped in the image, not a hand-made fixture.
const graph = new RoadGraph(parseRoadGraphData(JSON.parse(readFileSync('data/graphs/tel-aviv-centre.json', 'utf8'))));
const rules: GameRules = {goalMinRouteM:300,goalMaxRouteM:800,reachThresholdM:20,maxArrivalAccuracyM:50,maxFixAgeMs:30000,maxSnapM:250};

// Independent oracle: array-scan Dijkstra over the raw edge list. Shares no adjacency, heap or
// heuristic code with the production A*.
const neighbours: [number, number][][] = Array.from({length: graph.nodeCount}, () => []);
for (let e = 0; e < graph.edgeCount; e++) {
  const a = graph.edgeA[e]!; const b = graph.edgeB[e]!; const w = graph.edgeLengthM[e]!;
  neighbours[a]!.push([b, w]); neighbours[b]!.push([a, w]);
}
function oracle(from: Snap, to: Snap): number {
  let best = from.edge === to.edge ? Math.abs(from.t - to.t) * graph.edgeLengthM[from.edge]! : Infinity;
  const dist = new Map<number, number>();
  const open = new Map<number, number>();
  const seed = (s: Snap): [number, number][] => [[graph.edgeA[s.edge]!, s.t * graph.edgeLengthM[s.edge]!], [graph.edgeB[s.edge]!, (1 - s.t) * graph.edgeLengthM[s.edge]!]];
  for (const [node, d] of seed(from)) open.set(node, Math.min(d, open.get(node) ?? Infinity));
  while (open.size > 0) {
    let node = -1; let d = Infinity;
    for (const [n, value] of open) if (value < d) { node = n; d = value; }
    open.delete(node); dist.set(node, d);
    if (d > 2500) break; // every game route is far shorter
    for (const [next, w] of neighbours[node]!) {
      if (!dist.has(next) && d + w < (open.get(next) ?? Infinity)) open.set(next, d + w);
    }
  }
  for (const [node, d] of seed(to)) best = Math.min(best, (dist.get(node) ?? Infinity) + d);
  return best;
}

const edgeKeys = new Set<string>();
for (let e = 0; e < graph.edgeCount; e++) {
  const a = graph.edgeA[e]!; const b = graph.edgeB[e]!;
  edgeKeys.add(`${Math.min(a, b)}-${Math.max(a, b)}`);
}
const nodeAt = new Map<string, number[]>();
for (let n = 0; n < graph.nodeCount; n++) {
  const key = `${graph.lat[n]},${graph.lon[n]}`;
  nodeAt.set(key, [...(nodeAt.get(key) ?? []), n]);
}

function seeded(seed: number) {
  return () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 2 ** 32; };
}

describe('bundled Tel Aviv graph', () => {
  const random = seeded(20261008);
  const starts = Array.from({length: 25}, () => ({lat: 32.0809 + (random() - 0.5) * 0.012, lon: 34.7806 + (random() - 0.5) * 0.014, accuracyM: 5, ageMs: 0}));

  it('places a reachable goal inside the radius and returns the shortest road route', () => {
    for (const fix of starts) {
      const {goal, progress} = startGame(graph, fix, rules, random);
      const from = snapToRoad(graph, fix)!; const to = snapToRoad(graph, goal)!;
      expect(progress.arrival).toBe('EN_ROUTE');
      expect(progress.route.distanceM).toBeGreaterThanOrEqual(rules.goalMinRouteM);
      expect(progress.route.distanceM).toBeLessThanOrEqual(rules.goalMaxRouteM);
      expect(haversineM(from.point, goal)).toBeLessThanOrEqual(rules.goalMaxRouteM);
      expect(progress.route.distanceM).toBeCloseTo(oracle(from, to), 4);

      // The line follows road geometry: its length is the reported distance, and every interior
      // step is an actual graph edge rather than a shortcut across blocks.
      const points = progress.route.points;
      expect(points.slice(1).reduce((sum, p, i) => sum + haversineM(points[i]!, p), 0)).toBeCloseTo(progress.route.distanceM, 3);
      expect(haversineM(points.at(-1)!, goal)).toBeLessThan(0.01);
      const interior = points.slice(1, -1).map(p => nodeAt.get(`${p.lat},${p.lon}`));
      for (let i = 1; i < interior.length; i++) {
        const joined = interior[i - 1]!.some(a => interior[i]!.some(b => edgeKeys.has(`${Math.min(a, b)}-${Math.max(a, b)}`)));
        expect(joined, `route step ${i} is not a road segment`).toBe(true);
      }
    }
  });

  it('keeps the goal fixed and shortens the optimal route as the player advances along it', () => {
    const fix = starts[0]!;
    const {goal, progress} = startGame(graph, fix, rules, seeded(7));
    const frozen = {...goal};
    let previous = progress.route.distanceM;
    for (const point of progress.route.points.slice(1)) {
      const next = trackProgress(graph, {...point, accuracyM: 5, ageMs: 0}, goal, rules);
      expect(next.route.distanceM).toBeLessThanOrEqual(previous + 1e-6);
      expect(next.route.distanceM).toBeCloseTo(oracle(snapToRoad(graph, point)!, snapToRoad(graph, goal)!), 4);
      previous = next.route.distanceM;
    }
    expect(previous).toBeLessThan(0.01);
    expect(trackProgress(graph, {...goal, accuracyM: 5, ageMs: 0}, goal, rules).arrival).toBe('REACHED');
    expect(goal).toEqual(frozen);
  });
});
