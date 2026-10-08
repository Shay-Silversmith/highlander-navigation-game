import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { GraphStore } from '../server/src/adapters/graphStore.js';
import { OfflineProvider, OutsideCoverageError } from '../server/src/adapters/overpass.js';
import { bboxAround } from '../server/src/core/geo.js';

const centre = { lat: 32.08, lon: 34.78 };
const folders: string[] = [];
afterEach(async () => {
  await Promise.all(folders.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

/** An offline store whose only data is one bundled graph of +/- 2000 m around `centre`. */
async function offlineStore() {
  const bundledDir = await mkdtemp(join(tmpdir(), 'highlander-edge-'));
  folders.push(bundledDir);
  const data = { bbox: bboxAround(centre, 2000), lat: [32.08, 32.08], lon: [34.78, 34.781], edges: [0, 1] };
  await writeFile(join(bundledDir, 'area.json'), JSON.stringify(data));
  return new GraphStore({ provider: new OfflineProvider(), bundledDir, areaHalfSizeM: 1850, maxAreasInMemory: 2 });
}

// Roughly `metres` north of the centre.
const north = (metres: number) => ({ lat: centre.lat + metres / 111_195, lon: centre.lon });

describe('offline coverage near the edge of the bundled map', () => {
  it('serves a position inside the map even when the 1200 m margin crosses its edge', async () => {
    const store = await offlineStore();
    const graph = await store.graphCovering([north(1700)], 1200);
    expect(graph.edgeCount).toBe(1);
  });

  it('still serves a position whose full margin fits', async () => {
    const store = await offlineStore();
    expect((await store.graphCovering([north(300)], 1200)).edgeCount).toBe(1);
  });

  it('rejects a position outside the map', async () => {
    const store = await offlineStore();
    await expect(store.graphCovering([north(2300)], 1200)).rejects.toBeInstanceOf(OutsideCoverageError);
  });

  it('rejects when one of two points (player, goal) is outside the map', async () => {
    const store = await offlineStore();
    await expect(store.graphCovering([north(1700), north(2300)], 400)).rejects.toBeInstanceOf(OutsideCoverageError);
  });
});
