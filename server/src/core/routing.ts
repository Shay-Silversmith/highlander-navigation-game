import { haversineM, type LatLon } from './geo.js';
import type { RoadGraph } from './graph.js';
import { MinHeap } from './heap.js';

/** A position projected onto the nearest road segment. */
export interface Snap {
  edge: number;
  /** Fraction along the edge from edgeA (0) to edgeB (1). */
  t: number;
  point: LatLon;
  /** Straight-line distance from the original position to the road. */
  offsetM: number;
}

export interface Route {
  /** Polyline from the snapped start to the snapped end, following road geometry. */
  points: LatLon[];
  distanceM: number;
}

/**
 * Nearest point on the road network.
 *
 * Snaps to the nearest *segment*, not the nearest node: on a long straight street the nearest
 * node can be 100 m behind the player, which would make the route start by walking backwards.
 * Linear scan is deliberate: a game area holds ~10^4 segments, well under a millisecond.
 */
export function snapToRoad(graph: RoadGraph, position: LatLon): Snap | undefined {
  const px = graph.projection.x(position.lon);
  const py = graph.projection.y(position.lat);
  let best = -1;
  let bestT = 0;
  let bestD2 = Infinity;
  for (let e = 0; e < graph.edgeCount; e++) {
    const a = graph.edgeA[e]!;
    const b = graph.edgeB[e]!;
    const ax = graph.x[a]!;
    const ay = graph.y[a]!;
    const dx = graph.x[b]! - ax;
    const dy = graph.y[b]! - ay;
    const len2 = dx * dx + dy * dy;
    const t = len2 === 0 ? 0 : Math.min(1, Math.max(0, ((px - ax) * dx + (py - ay) * dy) / len2));
    const ex = ax + t * dx - px;
    const ey = ay + t * dy - py;
    const d2 = ex * ex + ey * ey;
    if (d2 < bestD2) {
      bestD2 = d2;
      best = e;
      bestT = t;
    }
  }
  if (best < 0) return undefined;
  const a = graph.edgeA[best]!;
  const b = graph.edgeB[best]!;
  const point = graph.projection.toLatLon(
    graph.x[a]! + bestT * (graph.x[b]! - graph.x[a]!),
    graph.y[a]! + bestT * (graph.y[b]! - graph.y[a]!),
  );
  return { edge: best, t: bestT, point, offsetM: haversineM(position, point) };
}

/** Distances from a mid-edge point to that edge's two end nodes. */
function legs(graph: RoadGraph, snap: Snap): [node: number, distanceM: number][] {
  const length = graph.edgeLengthM[snap.edge]!;
  return [
    [graph.edgeA[snap.edge]!, snap.t * length],
    [graph.edgeB[snap.edge]!, (1 - snap.t) * length],
  ];
}

/**
 * Shortest path by distance between two points that may each lie mid-segment.
 *
 * A* with the straight-line distance as heuristic. It is admissible and consistent because
 * every edge weight is the great-circle length of the segment, so the first time the search
 * can no longer beat the best complete route, that route is optimal.
 *
 * Start and end are handled as virtual nodes: the search is seeded from both ends of the start
 * segment and may finish through either end of the goal segment.
 */
export function shortestPath(graph: RoadGraph, from: Snap, to: Snap): Route | undefined {
  const dist = new Float64Array(graph.nodeCount).fill(Infinity);
  const prev = new Int32Array(graph.nodeCount).fill(-1);
  const heap = new MinHeap();
  const target = to.point;
  const heuristic = (node: number): number => haversineM(graph.point(node), target);

  // Both points on the same segment: walking along it is a candidate, though a loop around
  // the block can never be shorter than the segment itself, so this is also the optimum.
  let bestTotal = Infinity;
  let bestExit = -1;
  if (from.edge === to.edge) {
    bestTotal = Math.abs(from.t - to.t) * graph.edgeLengthM[from.edge]!;
  }

  const exitCost = new Map<number, number>();
  for (const [node, d] of legs(graph, to)) exitCost.set(node, Math.min(d, exitCost.get(node) ?? Infinity));

  for (const [node, d] of legs(graph, from)) {
    if (d < dist[node]!) {
      dist[node] = d;
      heap.push(node, d + heuristic(node));
    }
  }

  while (heap.size > 0 && heap.peekPriority() < bestTotal) {
    const { node, priority } = heap.pop()!;
    const g = dist[node]!;
    if (priority > g + heuristic(node) + 1e-9) continue; // stale heap entry
    const exit = exitCost.get(node);
    if (exit !== undefined && g + exit < bestTotal) {
      bestTotal = g + exit;
      bestExit = node;
    }
    for (let i = graph.adjOffset[node]!; i < graph.adjOffset[node + 1]!; i++) {
      const next = graph.adjTarget[i]!;
      const candidate = g + graph.adjWeight[i]!;
      if (candidate < dist[next]!) {
        dist[next] = candidate;
        prev[next] = node;
        heap.push(next, candidate + heuristic(next));
      }
    }
  }

  if (bestTotal === Infinity) return undefined;
  const points: LatLon[] = [to.point];
  for (let node = bestExit; node >= 0; node = prev[node]!) points.push(graph.point(node));
  points.push(from.point);
  points.reverse();
  return { points: dropRepeats(points), distanceM: bestTotal };
}

function dropRepeats(points: LatLon[]): LatLon[] {
  return points.filter((p, i) => i === 0 || p.lat !== points[i - 1]!.lat || p.lon !== points[i - 1]!.lon);
}

/** Walking distance from a snapped point to every node within `limitM` (bounded Dijkstra). */
export function distancesWithin(graph: RoadGraph, from: Snap, limitM: number): Map<number, number> {
  const dist = new Map<number, number>();
  const heap = new MinHeap();
  for (const [node, d] of legs(graph, from)) {
    if (d <= limitM && d < (dist.get(node) ?? Infinity)) {
      dist.set(node, d);
      heap.push(node, d);
    }
  }
  while (heap.size > 0) {
    const { node, priority } = heap.pop()!;
    if (priority > dist.get(node)!) continue;
    for (let i = graph.adjOffset[node]!; i < graph.adjOffset[node + 1]!; i++) {
      const next = graph.adjTarget[i]!;
      const candidate = priority + graph.adjWeight[i]!;
      if (candidate <= limitM && candidate < (dist.get(next) ?? Infinity)) {
        dist.set(next, candidate);
        heap.push(next, candidate);
      }
    }
  }
  return dist;
}

export interface GoalOptions {
  /** Goal must be at least this far by road, so the game is not won on the first fix. */
  minRouteM: number;
  /** Radius: the goal is at most this far by road, hence also at most this far in a straight line. */
  maxRouteM: number;
  /**
   * Minimum straight-line distance from `origin` (default: the snapped start). Road distance
   * alone is not enough: on a U-shaped street a point 300 m away by road can be 10 m away as
   * the crow flies, and the game would start already won.
   */
  minDirectM?: number;
  origin?: LatLon;
  /** Returns a number in [0, 1). Injected so goal placement is reproducible in tests. */
  random: () => number;
}

/**
 * Picks the goal among nodes the player can actually walk to.
 *
 * Candidates come from a search outward from the player, so a point in the sea, inside a
 * building, or on a road island cut off from the player can never be chosen. There is no
 * retry loop: either a candidate exists or we report that none does.
 */
export function pickGoal(graph: RoadGraph, from: Snap, options: GoalOptions): { node: number; routeM: number } | undefined {
  const reachable = distancesWithin(graph, from, options.maxRouteM);
  const origin = options.origin ?? from.point;
  const minDirectM = options.minDirectM ?? 0;
  const candidates = [...reachable].filter(
    ([node, routeM]) => routeM >= options.minRouteM && haversineM(origin, graph.point(node)) >= minDirectM,
  );
  if (candidates.length === 0) return undefined;
  // Map iteration order depends on search order; sort so a seeded RNG gives a stable pick.
  candidates.sort((x, y) => x[0] - y[0]);
  const index = Math.min(candidates.length - 1, Math.floor(options.random() * candidates.length));
  const [node, routeM] = candidates[index]!;
  return { node, routeM };
}
