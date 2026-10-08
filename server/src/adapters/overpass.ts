import type { BBox } from '../core/geo.js';
import { buildRoadGraph, type OsmNode, type OsmWay, type RoadGraph } from '../core/graph.js';

export class MapDataUnavailableError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'MapDataUnavailableError';
  }
}

/** Raised in offline mode when a position is outside the map data shipped with the service. */
export class OutsideCoverageError extends Error {
  constructor() {
    super(
      'Offline mode: this location is outside the bundled map area (central Tel Aviv). ' +
        'Run with OFFLINE=false to load roads for any location, or use the simulator inside the bundled area.',
    );
    this.name = 'OutsideCoverageError';
  }
}

/** Used when OFFLINE=true: the service must not reach out to any external host. */
export class OfflineProvider implements RoadGraphProvider {
  async fetch(): Promise<RoadGraph> {
    throw new OutsideCoverageError();
  }
}

/** Source of road network data for an area. The game core never knows where it came from. */
export interface RoadGraphProvider {
  fetch(bbox: BBox): Promise<RoadGraph>;
}

interface OverpassElement {
  type: string;
  id: number;
  lat?: number;
  lon?: number;
  nodes?: number[];
  tags?: Record<string, string>;
}

export interface OverpassOptions {
  /** Tried in order; the next mirror is used when one fails or times out. */
  endpoints: string[];
  timeoutMs: number;
  fetchImpl?: typeof fetch;
}

export class OverpassProvider implements RoadGraphProvider {
  constructor(private readonly options: OverpassOptions) {}

  async fetch(bbox: BBox): Promise<RoadGraph> {
    const box = `${bbox.south},${bbox.west},${bbox.north},${bbox.east}`;
    const serverTimeoutS = Math.max(5, Math.floor(this.options.timeoutMs / 1000) - 2);
    const query = `[out:json][timeout:${serverTimeoutS}];way["highway"](${box});(._;>;);out body qt;`;
    const doFetch = this.options.fetchImpl ?? fetch;

    const failures: string[] = [];
    for (const endpoint of this.options.endpoints) {
      try {
        const response = await doFetch(endpoint, {
          method: 'POST',
          headers: {
            'content-type': 'application/x-www-form-urlencoded',
            'user-agent': 'highlander-navigation-game/1.0 (take-home assessment)',
          },
          body: `data=${encodeURIComponent(query)}`,
          signal: AbortSignal.timeout(this.options.timeoutMs),
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const payload = (await response.json()) as { elements?: OverpassElement[]; remark?: string };
        // Overpass answers 200 with a "remark" when the query ran out of time or memory.
        if (!Array.isArray(payload.elements) || payload.remark?.includes('error')) {
          throw new Error(payload.remark ?? 'malformed response');
        }
        return toGraph(payload.elements, bbox);
      } catch (error) {
        failures.push(`${new URL(endpoint).host}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    throw new MapDataUnavailableError(`Road data could not be loaded (${failures.join('; ')})`);
  }
}

function toGraph(elements: OverpassElement[], bbox: BBox): RoadGraph {
  const nodes: OsmNode[] = [];
  const ways: OsmWay[] = [];
  for (const el of elements) {
    if (el.type === 'node' && typeof el.lat === 'number' && typeof el.lon === 'number') {
      nodes.push({ id: el.id, lat: el.lat, lon: el.lon, tags: el.tags });
    } else if (el.type === 'way' && Array.isArray(el.nodes)) {
      ways.push({ nodes: el.nodes, tags: el.tags });
    }
  }
  return buildRoadGraph(nodes, ways, bbox);
}
