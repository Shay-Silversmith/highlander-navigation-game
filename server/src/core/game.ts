import { haversineM, type LatLon } from './geo.js';
import type { RoadGraph } from './graph.js';
import { pickGoal, shortestPath, snapToRoad, type Route } from './routing.js';

export interface GameRules {
  goalMinRouteM: number;
  goalMaxRouteM: number;
  /** Proximity threshold for "goal reached". */
  reachThresholdM: number;
  /** A fix less accurate than this cannot confirm arrival. */
  maxArrivalAccuracyM: number;
  /** A fix older than this cannot confirm arrival (the player may have moved since). */
  maxFixAgeMs?: number;
  /** Beyond this distance from any walkable road the player is considered off the network. */
  maxSnapM: number;
}

export type GameErrorCode = 'OFF_NETWORK' | 'NO_GOAL_AVAILABLE' | 'NO_ROUTE';

export class GameError extends Error {
  constructor(
    readonly code: GameErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'GameError';
  }
}

/**
 * REACHED    inside the threshold with a trustworthy fix.
 * UNCERTAIN  inside the threshold, but the fix is too inaccurate or too old to be sure; no win
 *            is awarded.
 * EN_ROUTE   not there yet.
 */
export type Arrival = 'REACHED' | 'UNCERTAIN' | 'EN_ROUTE';

export interface Fix extends LatLon {
  /** 68% confidence radius in metres, as reported by the location source. */
  accuracyM: number;
  /**
   * Age of the fix when it was sent. An age, not a timestamp, so the check does not depend on
   * the client and server clocks agreeing.
   */
  ageMs?: number;
}

export interface Progress {
  route: Route;
  /** Straight line from the real position to the goal. This, not the route, decides arrival. */
  distanceToGoalM: number;
  /** How far the real position is from the road the route starts on. */
  offRoadM: number;
  arrival: Arrival;
}

export function evaluateArrival(fix: Fix, goal: LatLon, rules: GameRules): Arrival {
  if (haversineM(fix, goal) > rules.reachThresholdM) return 'EN_ROUTE';
  const fresh = (fix.ageMs ?? 0) <= (rules.maxFixAgeMs ?? Infinity);
  return fresh && fix.accuracyM <= rules.maxArrivalAccuracyM ? 'REACHED' : 'UNCERTAIN';
}

function snapOrThrow(graph: RoadGraph, position: LatLon, rules: GameRules, who: string) {
  const snap = snapToRoad(graph, position);
  if (!snap || snap.offsetM > rules.maxSnapM) {
    throw new GameError('OFF_NETWORK', `${who} is not within ${rules.maxSnapM} m of a walkable route.`);
  }
  return snap;
}

export function trackProgress(graph: RoadGraph, fix: Fix, goal: LatLon, rules: GameRules): Progress {
  const from = snapOrThrow(graph, fix, rules, 'The player');
  const to = snapOrThrow(graph, goal, rules, 'The goal');
  const route = shortestPath(graph, from, to);
  if (!route) throw new GameError('NO_ROUTE', 'No walkable route connects the player to the goal.');
  return {
    route,
    distanceToGoalM: haversineM(fix, goal),
    offRoadM: from.offsetM,
    arrival: evaluateArrival(fix, goal, rules),
  };
}

export function startGame(
  graph: RoadGraph,
  fix: Fix,
  rules: GameRules,
  random: () => number,
): { goal: LatLon; progress: Progress } {
  const from = snapOrThrow(graph, fix, rules, 'The player');
  const picked = pickGoal(graph, from, {
    minRouteM: rules.goalMinRouteM,
    maxRouteM: rules.goalMaxRouteM,
    // Well clear of the arrival zone even with a fix at the accuracy limit.
    minDirectM: Math.max(rules.goalMinRouteM / 2, rules.reachThresholdM + rules.maxArrivalAccuracyM),
    origin: fix,
    random,
  });
  if (!picked) {
    throw new GameError(
      'NO_GOAL_AVAILABLE',
      `No reachable point lies between ${rules.goalMinRouteM} m and ${rules.goalMaxRouteM} m of walking from here.`,
    );
  }
  const goal = graph.point(picked.node);
  return { goal, progress: trackProgress(graph, fix, goal, rules) };
}
