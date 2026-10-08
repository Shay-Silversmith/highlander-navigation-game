import { haversineM, LocalProjection, type BBox, type LatLon } from './geo.js';

export interface OsmNode {
  id: number;
  lat: number;
  lon: number;
  tags?: Record<string, string>;
}

export interface OsmWay {
  nodes: number[];
  tags?: Record<string, string>;
}

/** Serialisable form, used for the on-disk cache. */
export interface RoadGraphData {
  bbox: BBox;
  lat: number[];
  lon: number[];
  /** Flat pairs of node indices: [a0, b0, a1, b1, ...]. Every edge is walkable both ways. */
  edges: number[];
}

/**
 * Validates untrusted graph data (a cache file may be truncated, hand-edited or from an older
 * version). Throws rather than letting an out-of-range node index surface later as NaN distances.
 */
export function parseRoadGraphData(value: unknown): RoadGraphData {
  const data = value as Partial<RoadGraphData> | null;
  const isCoords = (list: unknown, limit: number): list is number[] =>
    Array.isArray(list) && list.every((v) => typeof v === 'number' && Number.isFinite(v) && Math.abs(v) <= limit);
  if (!data || !isCoords(data.lat, 90) || !isCoords(data.lon, 180) || data.lat.length !== data.lon.length) {
    throw new Error('invalid graph: coordinates');
  }
  const nodeCount = data.lat.length;
  if (
    !Array.isArray(data.edges) ||
    data.edges.length % 2 !== 0 ||
    !data.edges.every((n) => Number.isInteger(n) && n >= 0 && n < nodeCount)
  ) {
    throw new Error('invalid graph: edges');
  }
  const box = data.bbox;
  if (!box || ![box.south, box.west, box.north, box.east].every((v) => typeof v === 'number' && Number.isFinite(v))) {
    throw new Error('invalid graph: bbox');
  }
  return { bbox: box, lat: data.lat, lon: data.lon, edges: data.edges };
}

const NEVER_WALKABLE = new Set([
  'motorway',
  'motorway_link',
  'trunk',
  'trunk_link',
  'construction',
  'proposed',
  'abandoned',
  'razed',
  'raceway',
  'bus_guideway',
  'busway',
  'corridor',
  'elevator',
  'platform',
  'rest_area',
  'services',
]);
const DENIED = new Set(['no', 'private', 'military', 'customers', 'delivery', 'agricultural', 'forestry']);
const GRANTED = new Set(['yes', 'designated', 'permissive', 'official']);

/**
 * Walking profile. "Permissible" is decided from OSM tags: the road class must be walkable and
 * access must not be denied. `foot=*` is more specific than `access=*`, so it wins in both
 * directions (a private road with foot=yes is allowed; a public cycleway with foot=no is not).
 * One-way restrictions do not apply to pedestrians.
 */
export function isWalkable(tags: Record<string, string> | undefined): boolean {
  const highway = tags?.highway;
  if (!tags || !highway || NEVER_WALKABLE.has(highway)) return false;
  if (tags.area === 'yes' || tags.indoor === 'yes') return false;
  const foot = tags.foot;
  if (foot !== undefined) {
    if (DENIED.has(foot)) return false;
    if (GRANTED.has(foot)) return true;
  }
  if (tags.access !== undefined && DENIED.has(tags.access)) return false;
  return true;
}

const SOLID_BARRIERS = new Set([
  'wall',
  'fence',
  'hedge',
  'retaining_wall',
  'city_wall',
  'guard_rail',
  'handrail',
  'ditch',
  'jersey_barrier',
  'debris',
]);

/**
 * Barriers are mapped as tagged nodes on a way (a gate, a fence across a path). A way can be
 * walkable while a node on it is not, so nodes are checked separately. Gates, bollards, kerbs
 * and similar are passable on foot unless access says otherwise; a locked gate is not.
 */
export function isPassableNode(tags: Record<string, string> | undefined): boolean {
  const barrier = tags?.barrier;
  if (!tags || !barrier) return true;
  const foot = tags.foot;
  if (foot !== undefined) {
    if (DENIED.has(foot)) return false;
    if (GRANTED.has(foot)) return true;
  }
  if (tags.access !== undefined && DENIED.has(tags.access)) return false;
  if (tags.locked === 'yes') return false;
  return !SOLID_BARRIERS.has(barrier);
}

export class RoadGraph {
  readonly nodeCount: number;
  readonly edgeCount: number;
  readonly bbox: BBox;
  readonly lat: Float64Array;
  readonly lon: Float64Array;
  /** Planar coordinates in metres, see LocalProjection. */
  readonly x: Float64Array;
  readonly y: Float64Array;
  readonly edgeA: Int32Array;
  readonly edgeB: Int32Array;
  readonly edgeLengthM: Float64Array;
  readonly projection: LocalProjection;
  /** CSR adjacency: neighbours of node n are adjTarget[adjOffset[n] .. adjOffset[n + 1]). */
  readonly adjOffset: Int32Array;
  readonly adjTarget: Int32Array;
  readonly adjWeight: Float64Array;

  constructor(private readonly data: RoadGraphData) {
    this.bbox = data.bbox;
    this.nodeCount = data.lat.length;
    this.edgeCount = data.edges.length / 2;
    this.lat = Float64Array.from(data.lat);
    this.lon = Float64Array.from(data.lon);
    this.projection = new LocalProjection({
      lat: (data.bbox.south + data.bbox.north) / 2,
      lon: (data.bbox.west + data.bbox.east) / 2,
    });
    this.x = this.lon.map((lon) => this.projection.x(lon));
    this.y = this.lat.map((lat) => this.projection.y(lat));

    this.edgeA = new Int32Array(this.edgeCount);
    this.edgeB = new Int32Array(this.edgeCount);
    this.edgeLengthM = new Float64Array(this.edgeCount);
    const degree = new Int32Array(this.nodeCount + 1);
    for (let e = 0; e < this.edgeCount; e++) {
      const a = data.edges[2 * e]!;
      const b = data.edges[2 * e + 1]!;
      this.edgeA[e] = a;
      this.edgeB[e] = b;
      this.edgeLengthM[e] = haversineM(this.point(a), this.point(b));
      degree[a + 1]!++;
      degree[b + 1]!++;
    }
    for (let n = 0; n < this.nodeCount; n++) degree[n + 1]! += degree[n]!;
    this.adjOffset = degree;
    this.adjTarget = new Int32Array(this.edgeCount * 2);
    this.adjWeight = new Float64Array(this.edgeCount * 2);
    const cursor = this.adjOffset.slice(0, this.nodeCount);
    for (let e = 0; e < this.edgeCount; e++) {
      const a = this.edgeA[e]!;
      const b = this.edgeB[e]!;
      const w = this.edgeLengthM[e]!;
      this.adjTarget[cursor[a]!] = b;
      this.adjWeight[cursor[a]!++] = w;
      this.adjTarget[cursor[b]!] = a;
      this.adjWeight[cursor[b]!++] = w;
    }
  }

  point(node: number): LatLon {
    return { lat: this.lat[node]!, lon: this.lon[node]! };
  }

  toJSON(): RoadGraphData {
    return this.data;
  }
}

/**
 * Builds the routing graph from raw OSM elements.
 *
 * Topology comes only from shared node ids. Two ways that merely cross on the map (a bridge
 * over a road, a tunnel) share no node and therefore stay unconnected, which is what we want.
 */
export function buildRoadGraph(nodes: Iterable<OsmNode>, ways: Iterable<OsmWay>, bbox: BBox): RoadGraph {
  const coords = new Map<number, OsmNode>();
  for (const node of nodes) {
    if (Number.isFinite(node.lat) && Number.isFinite(node.lon)) coords.set(node.id, node);
  }

  const indexOf = new Map<number, number>();
  const lat: number[] = [];
  const lon: number[] = [];
  const edges: number[] = [];
  const seenEdges = new Set<string>();
  const intern = (node: OsmNode): number => {
    let index = indexOf.get(node.id);
    if (index === undefined) {
      index = lat.length;
      indexOf.set(node.id, index);
      lat.push(node.lat);
      lon.push(node.lon);
    }
    return index;
  };

  for (const way of ways) {
    if (!isWalkable(way.tags)) continue;
    for (let i = 1; i < way.nodes.length; i++) {
      const from = coords.get(way.nodes[i - 1]!);
      const to = coords.get(way.nodes[i]!);
      // A way clipped by the bbox can reference nodes we were not given; skip that segment only.
      if (!from || !to || from.id === to.id) continue;
      // A blocked node removes the segments on both sides of it, so nothing routes through.
      if (!isPassableNode(from.tags) || !isPassableNode(to.tags)) continue;
      const a = intern(from);
      const b = intern(to);
      const key = a < b ? `${a}:${b}` : `${b}:${a}`;
      if (seenEdges.has(key)) continue;
      seenEdges.add(key);
      edges.push(a, b);
    }
  }
  return new RoadGraph({ bbox, lat, lon, edges });
}
