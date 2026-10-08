import { describe, expect, it } from 'vitest';
import { bboxAround, bboxContains, haversineM, LocalProjection } from '../server/src/core/geo.js';
import { buildRoadGraph, isWalkable, RoadGraph } from '../server/src/core/graph.js';
import { MinHeap } from '../server/src/core/heap.js';
import { distancesWithin, pickGoal, shortestPath, snapToRoad, type Snap } from '../server/src/core/routing.js';

const bbox = { south: -0.01, west: -0.01, north: 0.01, east: 0.01 };
function graph(points: [number, number][], edges: number[]) {
  return new RoadGraph({ bbox, lat: points.map(p => p[0]), lon: points.map(p => p[1]), edges });
}
function snap(g: RoadGraph, edge: number, t: number): Snap {
  const a = g.point(g.edgeA[edge]!); const b = g.point(g.edgeB[edge]!);
  return { edge, t, offsetM: 0, point: { lat: a.lat + t * (b.lat - a.lat), lon: a.lon + t * (b.lon - a.lon) } };
}

// Independent Floyd-Warshall oracle: no production adjacency/search helper is reused.
function oracle(g: RoadGraph, from: Snap, to: Snap) {
  const n = g.nodeCount + 2; const start = n - 2; const finish = n - 1;
  const d = Array.from({ length: n }, (_, i) => Array.from({ length: n }, (_, j) => i === j ? 0 : Infinity));
  const connect = (a: number, b: number, w: number) => { d[a]![b] = Math.min(d[a]![b]!, w); d[b]![a] = Math.min(d[b]![a]!, w); };
  for (let e = 0; e < g.edgeCount; e++) connect(g.edgeA[e]!, g.edgeB[e]!, g.edgeLengthM[e]!);
  for (const [s, virtual] of [[from, start], [to, finish]] as const) {
    connect(virtual, g.edgeA[s.edge]!, s.t * g.edgeLengthM[s.edge]!);
    connect(virtual, g.edgeB[s.edge]!, (1 - s.t) * g.edgeLengthM[s.edge]!);
  }
  if (from.edge === to.edge) connect(start, finish, Math.abs(from.t - to.t) * g.edgeLengthM[from.edge]!);
  for (let k = 0; k < n; k++) for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) d[i]![j] = Math.min(d[i]![j]!, d[i]![k]! + d[k]![j]!);
  return d[start]![finish]!;
}

describe('geographic calculations', () => {
  it('handles coincident, known equatorial, and antipodal points', () => {
    expect(haversineM({lat:0,lon:0}, {lat:0,lon:0})).toBe(0);
    expect(haversineM({lat:0,lon:0}, {lat:0,lon:1})).toBeCloseTo(111195.08, 1);
    expect(haversineM({lat:0,lon:0}, {lat:0,lon:180})).toBeCloseTo(20015114.44, 1);
  });
  it('round-trips projected coordinates and includes boundary boxes', () => {
    const p = new LocalProjection({lat:32,lon:34});
    expect(p.toLatLon(p.x(34.01), p.y(32.02))).toEqual({lat:32.02,lon:34.01});
    const b = bboxAround({lat:32,lon:34}, 1000);
    expect(bboxContains(b, b)).toBe(true);
    expect(bboxContains(b, {...b, north:b.north + 0.00001})).toBe(false);
  });
});

describe('permissible OSM graph', () => {
  it.each(['motorway', 'trunk', 'construction', 'proposed'])('excludes %s', highway => expect(isWalkable({highway})).toBe(false));
  it('honors pedestrian permissions in both directions', () => {
    expect(isWalkable({highway:'residential',access:'private',foot:'yes'})).toBe(true);
    expect(isWalkable({highway:'cycleway',access:'yes',foot:'no'})).toBe(false);
    expect(isWalkable({highway:'service',access:'private'})).toBe(false);
    expect(isWalkable({highway:'footway',area:'yes'})).toBe(false);
    expect(isWalkable(undefined)).toBe(false);
  });
  it('deduplicates reversed segments, skips missing nodes, and keeps crossings disconnected', () => {
    const nodes = [{id:1,lat:0,lon:-0.001},{id:2,lat:0,lon:0.001},{id:3,lat:-0.001,lon:0},{id:4,lat:0.001,lon:0}];
    const g = buildRoadGraph(nodes, [
      {nodes:[1,2],tags:{highway:'footway'}}, {nodes:[2,1],tags:{highway:'footway'}},
      {nodes:[3,4],tags:{highway:'residential',oneway:'yes'}}, {nodes:[1,999,3],tags:{highway:'footway'}},
      {nodes:[2,3],tags:{highway:'motorway'}},
    ], bbox);
    expect(g.edgeCount).toBe(2);
    expect(shortestPath(g,snap(g,0,0.5),snap(g,1,0.5))).toBeUndefined();
    expect(shortestPath(g,snap(g,1,1),snap(g,1,0))?.distanceM).toBeCloseTo(g.edgeLengthM[1]!,8);
  });
});

describe('road snapping and shortest permissible paths', () => {
  const g = graph([[0,0],[0,0.001],[0.001,0.001],[0.001,0],[0.0005,0.0005],[0.003,0],[0.003,0.001]], [0,1,1,2,2,3,3,0,0,4,4,2,5,6]);
  it('snaps to the edge interior and clamps beyond endpoints', () => {
    const line = graph([[0,0],[0,0.001]],[0,1]);
    expect(snapToRoad(line,{lat:0.0001,lon:0.0005})?.t).toBeCloseTo(0.5,10);
    expect(snapToRoad(line,{lat:0,lon:-0.001})?.t).toBe(0);
    expect(snapToRoad(line,{lat:0,lon:0.002})?.t).toBe(1);
    expect(snapToRoad(graph([],[]),{lat:0,lon:0})).toBeUndefined();
  });
  it('handles zero-length road segments without NaN', () => {
    const zero = graph([[0,0],[0,0]],[0,1]);
    const s = snapToRoad(zero,{lat:0,lon:0})!;
    expect(s.t).toBe(0); expect(s.offsetM).toBe(0);
    expect(shortestPath(zero,s,s)).toEqual({points:[{lat:0,lon:0}],distanceM:0});
  });
  it('matches an independent oracle across all edge pairs and interior positions', () => {
    for(let a=0;a<g.edgeCount;a++) for(let b=0;b<g.edgeCount;b++) for(const t of [0,0.23,0.8,1]) {
      const from=snap(g,a,t); const to=snap(g,b,1-t); const expected=oracle(g,from,to);
      const route=shortestPath(g,from,to);
      if (!Number.isFinite(expected)) expect(route).toBeUndefined();
      else {
        expect(route?.distanceM).toBeCloseTo(expected,6);
        expect(route?.points[0]).toEqual(from.point);
        expect(route?.points.at(-1)).toEqual(to.point);
        expect(route!.points.slice(1).reduce((sum,p,i)=>sum+haversineM(route!.points[i]!,p),0)).toBeCloseTo(expected,5);
      }
    }
  });
  it('does not turn a disconnected crossing into a straight-line route', () => {
    expect(shortestPath(g,snap(g,0,0),snap(g,6,0))).toBeUndefined();
  });
});

describe('bounded goal generation', () => {
  const g = graph([[0,0],[0,0.001],[0,0.002],[0.003,0],[0.003,0.001]],[0,1,1,2,3,4]);
  const from=snap(g,0,0); const step=g.edgeLengthM[0]!;
  it('includes exact range boundaries but excludes farther and disconnected nodes', () => {
    const d=distancesWithin(g,from,step);
    expect([...d.keys()].sort()).toEqual([0,1]);
    expect(pickGoal(g,from,{minRouteM:step,maxRouteM:step,random:()=>0})).toEqual({node:1,routeM:step});
    expect(pickGoal(g,from,{minRouteM:step+0.001,maxRouteM:step,random:()=>0})).toBeUndefined();
  });
  it('is deterministic and never silently relaxes the minimum', () => {
    expect(pickGoal(g,from,{minRouteM:50,maxRouteM:300,random:()=>0})).toEqual({node:1,routeM:step});
    expect(pickGoal(g,from,{minRouteM:50,maxRouteM:300,random:()=>0.999})).toEqual({node:2,routeM:2*step});
    expect(pickGoal(g,from,{minRouteM:250,maxRouteM:300,random:()=>0})).toBeUndefined();
  });
});

describe('search priority queue', () => {
  it('returns increasing priorities with duplicate entries and supports reuse', () => {
    const heap=new MinHeap();
    const priorities=Array.from({length:150},(_,i)=>(i*71)%37);
    priorities.forEach((p,i)=>heap.push(i,p));
    const actual=[]; while(heap.size) actual.push(heap.pop()!.priority);
    expect(actual).toEqual([...priorities].sort((a,b)=>a-b));
    expect(heap.pop()).toBeUndefined(); expect(heap.peekPriority()).toBe(Infinity);
    heap.push(1,3); expect(heap.pop()).toEqual({node:1,priority:3});
  });
});
