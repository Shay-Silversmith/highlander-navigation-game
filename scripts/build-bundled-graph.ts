// Regenerates the road graph shipped in data/graphs (the only step that needs the internet).
// Usage: npx tsx scripts/build-bundled-graph.ts [lat] [lon] [halfSizeMetres] [name]
import { mkdir, writeFile } from 'node:fs/promises';
import { OverpassProvider } from '../server/src/adapters/overpass.js';
import { bboxAround } from '../server/src/core/geo.js';

const [lat = '32.0809', lon = '34.7806', halfSizeM = '2000', name = 'tel-aviv-centre'] = process.argv.slice(2);

const provider = new OverpassProvider({
  endpoints: ['https://overpass-api.de/api/interpreter', 'https://overpass.kumi.systems/api/interpreter'],
  timeoutMs: 90_000,
});
const graph = await provider.fetch(bboxAround({ lat: Number(lat), lon: Number(lon) }, Number(halfSizeM)));
await mkdir('data/graphs', { recursive: true });
await writeFile(`data/graphs/${name}.json`, JSON.stringify(graph));
console.log(`data/graphs/${name}.json: ${graph.nodeCount} nodes, ${graph.edgeCount} edges`);
