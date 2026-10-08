// Runs against the built service. All test positions are explicitly simulated.
// Node 22+: node tests/runtime-smoke.mjs [http://localhost:8080]
import assert from 'node:assert/strict';

const base = process.argv[2] || 'http://localhost:8080';
async function request(path, body) {
  const response = await fetch(new URL(path, base), {
    method: body ? 'POST' : 'GET',
    headers: body ? {'content-type':'application/json'} : undefined,
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(65000),
  });
  assert.equal(response.status, 200, `${path}: ${response.status} ${response.ok ? '' : await response.text()}`);
  return response;
}
const fix = point => ({...point,accuracyM:5,simulated:true,ageMs:0});
assert.equal((await (await request('/healthz')).json()).status,'ok');
for (const asset of ['/','/app.js','/style.css','/assets/ball.png','/assets/goal.png','/vendor/leaflet/leaflet.js']) {
  assert.ok((await (await request(asset)).arrayBuffer()).byteLength > 0, `${asset} must not be empty`);
}
const config = await (await request('/api/config')).json();
const start = await (await request('/api/games',{position:fix(config.demoStart)})).json();
assert.equal(start.arrival,'EN_ROUTE','A new game must not start already won');
assert.equal(start.positionSource,'simulated');
assert.ok(start.route.points.length>=2);
assert.ok(start.route.distanceM>config.reachThresholdM);
const arrival = await (await request('/api/route',{position:fix(start.goal),goal:start.goal})).json();
assert.equal(arrival.arrival,'REACHED');
assert.equal(arrival.distanceToGoalM,0);
const uncertain = await (await request('/api/route',{
  position:{...fix(start.goal),accuracyM:config.maxArrivalAccuracyM+1},goal:start.goal,
})).json();
assert.equal(uncertain.arrival,'UNCERTAIN');
console.log(`PASS: health, all static assets, simulated game start (${start.route.distanceM} m), accurate arrival and poor-accuracy rejection. Real host sensors were not tested.`);
