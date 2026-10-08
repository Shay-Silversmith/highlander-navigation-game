// Optional real-browser smoke test. Install Playwright separately or set PLAYWRIGHT_MODULE
// to its package directory. Uses an installed Edge browser by default; no browser download.
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');

(async () => {
  const browser = await chromium.launch({channel: process.env.BROWSER_CHANNEL || 'msedge', headless: true});
  try {
    const context = await browser.newContext({viewport: {width: 1280, height: 800}});
    await context.addInitScript(() => {
      Object.defineProperty(navigator, 'geolocation', {value: {
        watchPosition(_ok, fail) {queueMicrotask(() => fail({code:1})); return 1;},
        clearWatch() {},
      }});
    });
    const page = await context.newPage();
    const errors = []; const positions = []; const requests = [];
    const realApi = process.env.REAL_API === 'true';
    const base = process.env.BASE_URL || 'http://localhost:8080';
    page.on('pageerror', error => errors.push(error.message));
    page.on('request', request => {
      requests.push(request.url());
      if (realApi && request.method() === 'POST' && /\/api\/(games|route)$/.test(request.url())) positions.push(request.postDataJSON().position);
    });
    await page.route('https://tile.openstreetmap.org/**', route => route.abort());
    let goal;
    const progress = position => ({
      route: {points: [position, goal], distanceM: Math.abs(position.lon-goal.lon)*94000},
      distanceToGoalM: Math.abs(position.lon-goal.lon)*94000, offRoadM: 0,
      arrival: Math.abs(position.lon-goal.lon)*94000 <= 20 ? 'REACHED' : 'EN_ROUTE',
    });
    if (!realApi) await page.route('**/api/games', async route => {
      const {position} = route.request().postDataJSON(); positions.push(position);
      goal = {lat: position.lat, lon: position.lon+0.0005};
      await route.fulfill({json:{goal,...progress(position)}});
    });
    let delayRoute = false; let delayedRoutes = 0;
    if (!realApi) await page.route('**/api/route', async route => {
      const body = route.request().postDataJSON(); positions.push(body.position);
      assert.deepEqual(body.goal, goal, 'Goal must remain fixed during movement');
      if (delayRoute) {
        // Answer late with a recognisable bogus distance: it belongs to a game that was restarted.
        delayedRoutes++;
        const stale = {...progress(body.position), route:{points:[body.position, body.goal], distanceM:9999}};
        await new Promise(resolve => setTimeout(resolve, 1500));
        await route.fulfill({json:stale}).catch(() => {});
        return;
      }
      await route.fulfill({json:progress(body.position)});
    });
    await page.goto(base);
    // Location is requested only after the player presses Kick off.
    await page.locator('#btn-kickoff').waitFor({state:'visible'});
    assert.equal(await page.locator('#source-badge').innerText(), 'STANDBY');
    assert.equal(await page.locator('#banner').isHidden(), true, 'No location request before Kick off');
    await page.locator('#btn-kickoff').click();
    await page.getByText('Location permission was denied.', {exact:false}).waitFor();
    assert.equal(positions.length, 0, 'Permission denial must not silently start simulation');
    await page.getByRole('button', {name:'Use simulator',exact:true}).click();
    await page.waitForFunction(() => document.querySelector('#source-badge').textContent === 'SIMULATED');
    await page.waitForFunction(() => !document.querySelector('#btn-new').disabled);
    if (realApi) await page.locator('#map canvas').waitFor({state:'visible'});
    // Let Leaflet's initial fit animation finish before reviewing marker placement.
    await page.waitForTimeout(500);
    await fs.mkdir('test-results', {recursive:true});
    await page.screenshot({path:realApi ? 'test-results/browser-offline-game.png' : 'test-results/browser-game.png'});
    if (!realApi) {
      // Restart while a route update is in flight: its late answer must not reach the new game.
      delayRoute = true;
      await page.keyboard.press('ArrowRight');
      for (let i = 0; i < 40 && delayedRoutes === 0; i++) await page.waitForTimeout(50);
      assert.equal(delayedRoutes, 1, 'A route update must be in flight before the restart');
      delayRoute = false;
      await page.locator('#btn-new').click();
      await page.waitForFunction(() => !document.querySelector('#btn-new').disabled);
      await page.waitForTimeout(2000);
      assert.notEqual(await page.locator('#m-distance').innerText(), '10.00 km', 'Stale route response must be dropped after a restart');
      console.log('PASS: stale route response ignored after restart.');
    }
    await page.getByRole('button', {name:'Auto-walk the route'}).click();
    await page.locator('#win').waitFor({state:'visible',timeout:realApi ? 90000 : 15000});
    assert.match(await page.locator('#win-note').innerText(), /simulated/i);
    await page.getByRole('button',{name:'Play again'}).click();
    await page.waitForFunction(() => document.querySelector('#win').hidden && !document.querySelector('#btn-new').disabled);
    assert.deepEqual(errors, [], 'No uncaught browser errors');
    console.log(`PASS: permission denial, explicit simulation, auto-walk, labelled win, restart, no browser errors. ${realApi ? 'Real API and bundled maps; host geolocation was mocked.' : 'API replies and geolocation were mocked; this does not prove real sensors/maps.'}`);
    assert.ok(positions.every(p => p.simulated === true || p.source === 'simulated'), 'Every simulated position must carry simulation provenance on the wire');
    console.log('PASS: simulated position provenance on every request.');
    if (realApi) {
      assert.ok(requests.every(url=>new URL(url).origin===new URL(base).origin),'Offline browser flow must request only local resources');
      console.log('PASS: real offline browser flow requested only local resources.');
    }
  } finally {await browser.close();}
})().catch(error => {console.error(error);process.exitCode=1;});
