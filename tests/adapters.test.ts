import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GraphStore } from '../server/src/adapters/graphStore.js';
import { MapDataUnavailableError, OfflineProvider, OutsideCoverageError, OverpassProvider } from '../server/src/adapters/overpass.js';
import { RoadGraph } from '../server/src/core/graph.js';
import { bboxAround, bboxContains, type BBox } from '../server/src/core/geo.js';
const point={lat:0,lon:0};
function makeGraph(bbox:BBox) {return new RoadGraph({bbox,lat:[0,0],lon:[0,0.001],edges:[0,1]});}
const folders:string[]=[];
afterEach(async()=>{await Promise.all(folders.splice(0).map(dir=>rm(dir,{recursive:true,force:true})));});
async function temp() {const dir=await mkdtemp(join(tmpdir(),'highlander-tests-'));folders.push(dir);return dir;}
describe('graph cache',()=>{
  it('coalesces identical concurrent requests and reuses memory',async()=>{
    const fetch=vi.fn(async(bbox:BBox)=>makeGraph(bbox));
    const store=new GraphStore({provider:{fetch},areaHalfSizeM:2000,maxAreasInMemory:2});
    const results=await Promise.all(Array.from({length:8},()=>store.graphCovering([point],100)));
    expect(fetch).toHaveBeenCalledTimes(1); expect(results.every(g=>g===results[0])).toBe(true);
    expect(await store.graphCovering([{lat:0.001,lon:0}],100)).toBe(results[0]); expect(fetch).toHaveBeenCalledTimes(1);
  });
  it('retries after a failed in-flight request instead of poisoning the cache',async()=>{
    const fetch=vi.fn().mockRejectedValueOnce(new Error('offline')).mockImplementation(async(bbox:BBox)=>makeGraph(bbox));
    const store=new GraphStore({provider:{fetch},areaHalfSizeM:2000,maxAreasInMemory:2});
    await expect(store.graphCovering([point],100)).rejects.toThrow('offline');
    expect((await store.graphCovering([point],100)).edgeCount).toBe(1); expect(fetch).toHaveBeenCalledTimes(2);
  });
  it('loads persisted graphs in a fresh store while ignoring truncated files',async()=>{
    const cacheDir=await temp(); const fetch=vi.fn(async(bbox:BBox)=>makeGraph(bbox));
    const options={provider:{fetch},cacheDir,areaHalfSizeM:2000,maxAreasInMemory:2};
    await new GraphStore(options).graphCovering([point],100);
    await writeFile(join(cacheDir,'broken.json'),'{');
    const offline=vi.fn(async()=>{throw new Error('network must not be called');});
    const fresh=new GraphStore({...options,provider:{fetch:offline}});
    expect((await fresh.graphCovering([point],100)).edgeCount).toBe(1);expect(offline).not.toHaveBeenCalled();
  });
  it('evicts least recently used graph when capacity is exceeded',async()=>{
    const fetch=vi.fn(async(bbox:BBox)=>makeGraph(bbox));
    const store=new GraphStore({provider:{fetch},areaHalfSizeM:2000,maxAreasInMemory:1});
    await store.graphCovering([point],100);await store.graphCovering([{lat:1,lon:1}],100);await store.graphCovering([point],100);
    expect(fetch).toHaveBeenCalledTimes(3);expect(store.loadedAreas).toBe(1);
  });
});
const bbox={south:-0.01,west:-0.01,north:0.01,east:0.01};
const payload={elements:[{type:'node',id:1,lat:0,lon:0},{type:'node',id:2,lat:0,lon:0.001},{type:'way',id:3,nodes:[1,2],tags:{highway:'footway'}}]};
describe('Overpass provider',()=>{
  it('falls back from HTTP failure and excludes forbidden roads',async()=>{
    const request=vi.fn().mockResolvedValueOnce(new Response('unavailable',{status:503})).mockResolvedValueOnce(Response.json(payload));
    const provider=new OverpassProvider({endpoints:['https://one.test/api','https://two.test/api'],timeoutMs:1000,fetchImpl:request});
    expect((await provider.fetch(bbox)).edgeCount).toBe(1);expect(request).toHaveBeenCalledTimes(2);
    expect(request.mock.calls[0]?.[1]).toMatchObject({method:'POST'});
    expect(request.mock.calls[0]?.[1].signal).toBeInstanceOf(AbortSignal);
  });
  it('rejects HTTP 200 runtime error remarks and tries another endpoint',async()=>{
    const request=vi.fn().mockResolvedValueOnce(Response.json({...payload,remark:'runtime error: Query timed out'})).mockResolvedValueOnce(Response.json(payload));
    const provider=new OverpassProvider({endpoints:['https://one.test/api','https://two.test/api'],timeoutMs:1000,fetchImpl:request});
    expect((await provider.fetch(bbox)).edgeCount).toBe(1);expect(request).toHaveBeenCalledTimes(2);
  });
  it('returns a domain error when all endpoints fail or return malformed data',async()=>{
    const request=vi.fn().mockRejectedValueOnce(new Error('timeout')).mockResolvedValueOnce(Response.json({wrong:[]}));
    const provider=new OverpassProvider({endpoints:['https://one.test/api','https://two.test/api'],timeoutMs:1000,fetchImpl:request});
    await expect(provider.fetch(bbox)).rejects.toBeInstanceOf(MapDataUnavailableError);
  });
});

describe('cache integrity regression cases',()=>{
  it('does not reuse an in-flight small download for a larger simultaneous coverage request',async()=>{
    const fetch=vi.fn(async(bbox:BBox)=>makeGraph(bbox));
    const store=new GraphStore({provider:{fetch},areaHalfSizeM:100,maxAreasInMemory:2});
    const [,large]=await Promise.all([store.graphCovering([point],50),store.graphCovering([point],2000)]);
    // Approximately 1,000 m north is inside the larger requested region.
    expect(large.bbox.north).toBeGreaterThan(0.009);
  });
  it('rejects parseable cache records with nonexistent edge endpoints',async()=>{
    const cacheDir=await temp();
    await writeFile(join(cacheDir,'invalid.json'),JSON.stringify({bbox:{south:-1,west:-1,north:1,east:1},lat:[0,0],lon:[0,0.001],edges:[0,999]}));
    const fetch=vi.fn(async(bbox:BBox)=>makeGraph(bbox));
    const store=new GraphStore({provider:{fetch},cacheDir,areaHalfSizeM:2000,maxAreasInMemory:2});
    const result=await store.graphCovering([point],100);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(Number.isFinite(result.edgeLengthM[0])).toBe(true);
  });
});


describe('bundled offline maps and precise coverage', () => {
  it('does not merge simultaneous 100m and 110m coverage requests', async () => {
    const fetch = vi.fn(async (box: BBox) => makeGraph(box));
    const store = new GraphStore({ provider: { fetch }, areaHalfSizeM: 100, maxAreasInMemory: 2 });
    const margins = [100, 110];
    const results = await Promise.all(margins.map(margin => store.graphCovering([point], margin)));
    for (const [index, result] of results.entries()) {
      expect(bboxContains(result.bbox, bboxAround(point, margins[index]!))).toBe(true);
    }
  });

  it('serves the shipped real map with no provider or global fetch calls', async () => {
    const providerFetch = vi.fn(async () => { throw new Error('provider must not be called'); });
    const network = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('network must not be called'));
    try {
      const store = new GraphStore({
        provider: { fetch: providerFetch }, bundledDir: join(process.cwd(), 'data/graphs'),
        areaHalfSizeM: 2000, maxAreasInMemory: 1,
      });
      const start = { lat: 32.0809, lon: 34.7806 };
      const result = await store.graphCovering([start], 1200);
      expect(result.nodeCount).toBeGreaterThan(0);
      expect(result.edgeCount).toBeGreaterThan(0);
      expect(bboxContains(result.bbox, bboxAround(start, 1200))).toBe(true);
      expect(providerFetch).not.toHaveBeenCalled();
      expect(network).not.toHaveBeenCalled();
    } finally {
      network.mockRestore();
    }
  });

  it('rejects outside bundled coverage without attempting external network access', async () => {
    const network = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('network must not be called'));
    try {
      const store = new GraphStore({
        provider: new OfflineProvider(), bundledDir: join(process.cwd(), 'data/graphs'),
        areaHalfSizeM: 2000, maxAreasInMemory: 1,
      });
      await expect(store.graphCovering([{lat: 51.5074, lon: -0.1278}], 100)).rejects.toBeInstanceOf(OutsideCoverageError);
      expect(network).not.toHaveBeenCalled();
    } finally {
      network.mockRestore();
    }
  });

  it('keeps shipped graphs available after downloaded graphs are evicted', async () => {
    const bundledDir = await temp();
    await writeFile(join(bundledDir, 'bundled.json'), JSON.stringify(makeGraph(bbox)));
    const fetch = vi.fn(async (box: BBox) => makeGraph(box));
    const store = new GraphStore({ provider: { fetch }, bundledDir, areaHalfSizeM: 2000, maxAreasInMemory: 1 });
    const original = await store.graphCovering([point], 100);
    await store.graphCovering([{lat: 1, lon: 1}], 100);
    await store.graphCovering([{lat: 2, lon: 2}], 100);
    expect(await store.graphCovering([point], 100)).toBe(original);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(store.loadedAreas).toBe(2);
  });
});
