import { mkdir, readdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { bboxAround, bboxContains, haversineM, type BBox, type LatLon } from '../core/geo.js';
import { parseRoadGraphData, RoadGraph } from '../core/graph.js';
import type { RoadGraphProvider } from './overpass.js';

/** How far outside a held graph's box a point may be and still be served from it. */
const EDGE_SLACK_M = 150;

export interface GraphStoreOptions {
  provider: RoadGraphProvider;
  /** Directory for the on-disk cache; omit to keep graphs in memory only. */
  cacheDir?: string;
  /** Read-only directory of graphs shipped with the service; these work with no network at all. */
  bundledDir?: string;
  /** Half-size of the square downloaded around a new area. */
  areaHalfSizeM: number;
  /** Loaded areas kept in memory (least recently used is dropped first). */
  maxAreasInMemory: number;
  log?: (message: string, details?: Record<string, unknown>) => void;
}

/**
 * Hands out a road graph that covers a set of points plus a margin.
 *
 * Areas are downloaded once and reused: any area whose box contains the requested box is a
 * hit, so walking a few hundred metres does not trigger a new download. Concurrent requests
 * for the same new area share one download.
 *
 * When the requested margin cannot be obtained, a held graph that still contains the points is
 * used rather than failing (see graphCovering).
 */
export class GraphStore {
  private readonly areas: RoadGraph[] = [];
  /** Shipped graphs: never evicted, never rewritten. */
  private readonly bundled: RoadGraph[] = [];
  private readonly inFlight: { bbox: BBox; graph: Promise<RoadGraph> }[] = [];
  private diskLoaded: Promise<void> | undefined;

  constructor(private readonly options: GraphStoreOptions) {}

  async graphCovering(points: LatLon[], marginM: number): Promise<RoadGraph> {
    const needed = boundingBox(points.map((p) => bboxAround(p, marginM)));
    await (this.diskLoaded ??= this.loadFromDisk());

    const shipped = this.bundled.find((area) => bboxContains(area.bbox, needed));
    if (shipped) return shipped;

    const hit = this.areas.findIndex((area) => bboxContains(area.bbox, needed));
    if (hit >= 0) {
      const [area] = this.areas.splice(hit, 1);
      this.areas.unshift(area!);
      return area!;
    }

    const center = { lat: (needed.south + needed.north) / 2, lon: (needed.west + needed.east) / 2 };
    const span = Math.max(...points.map((p) => haversineM(center, p)));
    const bbox = bboxAround(center, Math.max(this.options.areaHalfSizeM, span + marginM));
    // Share a download already under way only if its box really covers what is needed here;
    // sharing by "roughly the same place" would hand a larger request an undersized graph.
    let pending = this.inFlight.find((download) => bboxContains(download.bbox, needed))?.graph;
    if (!pending) {
      const download = { bbox, graph: this.download(bbox) };
      this.inFlight.push(download);
      const forget = () => void this.inFlight.splice(this.inFlight.indexOf(download), 1);
      download.graph.then(forget, forget);
      pending = download.graph;
    }
    try {
      return await pending;
    } catch (error) {
      // No more map data can be obtained (offline, or the provider is down). The margin is a
      // preference, not a requirement: if a graph we already hold contains the points
      // themselves, play on it. Near the edge of the bundled map this is the difference
      // between a game with fewer goal candidates and no game at all.
      // A little slack past the box: roads that cross the boundary are stored whole, so a goal
      // picked on one of them can sit just outside it and must still be routable.
      const partial = [...this.bundled, ...this.areas].find((area) =>
        points.every((p) => isWithin(area.bbox, p, EDGE_SLACK_M)),
      );
      if (!partial) throw error;
      this.options.log?.('map margin unavailable, using the graph that contains the position', {
        reason: error instanceof Error ? error.name : String(error),
      });
      return partial;
    }
  }

  get loadedAreas(): number {
    return this.areas.length + this.bundled.length;
  }

  private async download(bbox: BBox): Promise<RoadGraph> {
    const started = Date.now();
    const graph = await this.options.provider.fetch(bbox);
    this.options.log?.('road graph downloaded', {
      nodes: graph.nodeCount,
      edges: graph.edgeCount,
      ms: Date.now() - started,
    });
    this.remember(graph);
    await this.saveToDisk(graph);
    return graph;
  }

  private remember(graph: RoadGraph): void {
    this.areas.unshift(graph);
    this.areas.length = Math.min(this.areas.length, this.options.maxAreasInMemory);
  }

  private async loadFromDisk(): Promise<void> {
    await this.loadDir(this.options.bundledDir, this.bundled, false);
    await this.loadDir(this.options.cacheDir, this.areas, true);
    this.areas.length = Math.min(this.areas.length, this.options.maxAreasInMemory);
  }

  private async loadDir(dir: string | undefined, into: RoadGraph[], create: boolean): Promise<void> {
    if (!dir) return;
    try {
      if (create) await mkdir(dir, { recursive: true });
      for (const file of (await readdir(dir)).filter((name) => name.endsWith('.json'))) {
        try {
          const data = parseRoadGraphData(JSON.parse(await readFile(join(dir, file), 'utf8')));
          into.push(new RoadGraph(data));
        } catch (error) {
          // A truncated or corrupt cache file must not take the service down; it is re-downloaded.
          this.options.log?.('ignoring unreadable graph cache file', { file, error: String(error) });
        }
      }
    } catch (error) {
      this.options.log?.('graph directory unavailable, continuing without it', { dir, error: String(error) });
    }
  }

  private async saveToDisk(graph: RoadGraph): Promise<void> {
    const dir = this.options.cacheDir;
    if (!dir) return;
    const { south, west, north, east } = graph.bbox;
    const name = [south, west, north, east].map((v) => v.toFixed(5)).join('_');
    try {
      // Write-then-rename so a crash mid-write never leaves a half file under the final name.
      const tmp = join(dir, `${name}.${process.pid}.tmp`);
      await writeFile(tmp, JSON.stringify(graph));
      await rename(tmp, join(dir, `${name}.json`));
    } catch (error) {
      this.options.log?.('could not persist graph cache', { error: String(error) });
    }
  }
}

/** True when the point is inside the box or at most `slackM` metres outside it. */
function isWithin(box: BBox, point: LatLon, slackM: number): boolean {
  const reach = bboxAround(point, slackM);
  return reach.north >= box.south && reach.south <= box.north && reach.east >= box.west && reach.west <= box.east;
}

function boundingBox(boxes: BBox[]): BBox {
  return {
    south: Math.min(...boxes.map((b) => b.south)),
    west: Math.min(...boxes.map((b) => b.west)),
    north: Math.max(...boxes.map((b) => b.north)),
    east: Math.max(...boxes.map((b) => b.east)),
  };
}
