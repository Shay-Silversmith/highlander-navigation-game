// Run inside the built runtime image with --network none and tests mounted at /qa.
import assert from 'node:assert/strict';
import { buildApp } from '/app/dist/app.js';
import { loadConfig } from '/app/dist/config.js';
import { GraphStore } from '/app/dist/adapters/graphStore.js';
import { OfflineProvider } from '/app/dist/adapters/overpass.js';

const config = loadConfig({...process.env,OFFLINE:'true',LOG_LEVEL:'silent'});
const graphs = new GraphStore({provider:new OfflineProvider(),bundledDir:config.bundledGraphDir,areaHalfSizeM:2000,maxAreasInMemory:2});
const app = await buildApp({config,graphs,random:()=>0.5});
try {
  // Fresh instance, no writable cache: all road data must come from the image.
  const base = await app.listen({host:'127.0.0.1',port:0});
  process.argv[2] = base;
  await import('./runtime-smoke.mjs');
  const cfg = await (await fetch(`${base}/api/config`)).json();
  assert.equal(cfg.offline,true);
  assert.equal(cfg.tileUrl,'');
  const roads = await (await fetch(`${base}/api/roads?lat=${cfg.demoStart.lat}&lon=${cfg.demoStart.lon}`)).json();
  assert.ok(roads.segments.length>0);
  const outside = await fetch(`${base}/api/games`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({position:{lat:0,lon:0,accuracyM:5,simulated:true,ageMs:0}})});
  assert.equal(outside.status,422);
  assert.equal((await outside.json()).error.code,'OUTSIDE_COVERAGE');
  console.log('PASS: fresh image, no cache, no network; bundled road geometry and explicit outside-coverage failure.');
} finally {await app.close();}
