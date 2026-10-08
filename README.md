# High Lander navigation game

A single-player navigation game for Part 1 of the assessment. The ball follows the host browser's location, a fixed goal is selected on the walkable road network, and the shortest route updates as the player moves. Reaching the goal with an accurate, recent location fix displays the result.

## Run with Docker

Requires Docker with Compose. No host Node.js installation is needed.

```sh
docker compose up --build -d
docker compose ps
```

Open http://localhost:8080 (use `localhost`, not an IP address: browsers expose location only on a secure origin). Then choose one of:

- **Kick off** asks the browser for this machine's location and plays with it. The badge shows `LIVE`. Docker does not provide GPS; the position comes from the host browser, and a desktop fix may be coarse and stationary.
- **Demo mode** plays with a simulated position at the bundled demo location. The badge shows `SIMULATED`. Move with the arrow keys, click the map, or choose **Auto-walk the route**. Simulated play is labelled in the UI and on every request, and does not demonstrate host sensor integration.

**Compose defaults to offline mode.** A real OpenStreetMap road graph for central Tel Aviv is bundled and drawn locally, with no outbound requests from the server or the page. Real-location play therefore requires a fix inside that coverage; anywhere else, Kick off reports that the position is outside the map and offers the simulator. To play with a real location elsewhere, run with `OFFLINE=false` (see below), which uses external map services.

The bundled graph covers approximately 32.0643–32.0975 latitude and 34.7610–34.8002 longitude. Starting a game also needs a 1,200 m map margin with default settings, so supported starting positions are inside that boundary. Outside coverage produces an explicit error rather than fabricated roads or silently relocated real positions.

```sh
docker compose logs --tail=100 app
docker compose down
```

To change the host port or enable online maps, copy `.env.example` to `.env`. `HOST_PORT` defaults to `8080`; `OFFLINE=false` enables Overpass downloads and hosted OpenStreetMap tiles beyond bundled coverage. Those are external public services outside this project's control: when they are slow or down, starting a game outside the bundled area fails with a "road data could not be loaded" message until they recover. Online mode is optional and best-effort; the offline default is the supported, reproducible configuration. Apply changes with `docker compose up -d`. The named volume keeps downloaded graphs between runs. Building requires internet for the pinned Node image and locked npm dependencies; offline runtime does not fetch map services. OS/browser location services may have their own connectivity requirements.

## Develop and test

Requires Node 22 or later:

```sh
npm ci
npm run typecheck
npm test
npm run build
npm start
```

Run the same unit/API suite without host Node.js using `docker build --target test .`.

`npm run dev` starts the development server. Unlike Compose, local npm execution uses the application's default online mode; set `OFFLINE=true` in the process environment for offline development. npm does not automatically read the Compose `.env` file.

With the service running:

```sh
node tests/runtime-smoke.mjs
```

This checks health, static assets, game creation, arrival and accuracy gating using explicitly simulated positions at the demo location. Unit/API tests use injected graphs, including an independent shortest-path oracle, disconnected routes, access restrictions, goal bounds, cache failures and malformed requests. `tests/bundled.test.ts` repeats the shortest-path comparison on the real bundled graph and checks that every route step is a road segment.

For an offline runtime check with a fresh instance and no cache or network (POSIX shell):

```sh
docker run --rm --network none \
  --mount "type=bind,source=$(pwd)/tests,target=/qa,readonly" \
  --entrypoint node highlander-app /qa/container-offline.mjs
```

Use the absolute `tests` directory as the mount source on Windows. The image name above assumes the default Compose project name `highlander`.

Optional UI check: `node tests/browser-smoke.cjs` requires Playwright (`playwright` or `playwright-core`; neither is a project dependency) and an installed Edge browser. Set `PLAYWRIGHT_MODULE` to the package directory if it is installed elsewhere; set `BROWSER_CHANNEL=chrome` to use Chrome. It mocks geolocation/API replies to test that location is requested only after Kick off, permission denial, explicit simulation, fixed goals, a late route response arriving after a restart, auto-walk, labelled wins and Play again. Set `REAL_API=true` to use the actual local offline API and bundled map instead; this also checks that browser requests stay local. Screenshots go to ignored `test-results/`.

Real sensor acquisition cannot be automated. Manual check: open http://localhost:8080, press **Kick off**, allow location, and confirm the badge reads `LIVE` and the ball sits at your position (inside bundled coverage, or with `OFFLINE=false`).

## Architecture and assumptions

One Node/TypeScript service serves the Fastify API, Leaflet and the static frontend. Pure geographic/routing functions are separated from map I/O; the graph provider supports bundled data, a bounded memory cache, disk caching and optional Overpass. The client holds the fixed goal, so no database or session infrastructure is required. Inputs and query extent are bounded. The container runs as a non-root user with a health check and persistent cache.

Routing uses A* with distance in metres and edge-interior snapping. Goals are selected from reachable nodes 300–800 m away by route distance, excluding points already within the arrival zone. Arrival uses the raw position with a 20 m proximity threshold and maximum 50 m reported accuracy; old fixes cannot confirm arrival. See `server/src/config.ts` for environment settings. Goal radius is interpreted as route distance.

Routes are shortest within the loaded graph and supported walking profile. Dataset boundaries can omit external detours; OpenStreetMap completeness and complex access restrictions limit real-world validity. The dotted off-road connector is not a validated walking route. Client-provided location is not authenticated and the app is not an anti-cheat system. Part 2 multiplayer and CI/CD are excluded.

## Known limitations

- Offline coverage is central Tel Aviv only. Elsewhere, real-location play needs `OFFLINE=false`, which depends on the public Overpass API and OpenStreetMap tiles. Their availability is not guaranteed: during final verification both Overpass mirrors were returning errors, so online mode was not verified end to end for this submission.
- Desktop Wi-Fi positioning is often worse than 50 m; inside the goal zone the game then reports the fix as too coarse instead of awarding a win.
- A desktop does not move, so reaching the goal on one normally requires Demo mode.
- Turn restrictions, opening hours and conditional access tags are not modelled; one-way restrictions are ignored on purpose because they do not apply to pedestrians.
- Browsers throttle timers in background tabs, so the simulated walk moves in larger, slower hops there.
- Location works on `localhost` only; a phone on the LAN would need HTTPS.

## Attribution

Map data © OpenStreetMap contributors, licensed under the Open Database License (ODbL) 1.0: https://www.openstreetmap.org/copyright. `data/graphs/tel-aviv-centre.json` is a database derived from OpenStreetMap and is distributed under the same ODbL terms; `scripts/build-bundled-graph.ts` regenerates it. The attribution is also shown on the map. In online mode, tiles are served by openstreetmap.org under its tile usage policy. Leaflet is used under the BSD 2-Clause licence. The supplied ball and goal images are used for the assessment.
