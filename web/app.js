/* global L */
// Game client. The server owns routing, goal placement and the arrival decision; this file
// owns the position sources, the map and the request lifecycle.

const $ = (id) => document.getElementById(id);
const WALK_SPEED_MPS = 1.4; // used only for the ETA
const SIM_SPEED_MPS = 14; // simulator moves fast on purpose, so a demo takes seconds
const SIM_STEP_M = 6;
const SIM_TICK_MS = 40;
const SIM_ACCURACY_M = 5;
const REROUTE_MIN_MOVE_M = 3; // ignore GPS jitter smaller than this
const REROUTE_MIN_INTERVAL_MS = 500;

const state = {
  config: null,
  mode: 'live', // 'live' | 'sim'
  fix: null, // { lat, lon, accuracyM, at, simulated }
  goal: null,
  phase: 'locating', // 'locating' | 'starting' | 'failed' | 'playing' | 'reached'
  gameSeq: 0, // bumped on every new game; responses from an older game are dropped
  startedAt: 0,
  travelledM: 0,
  initialRouteM: 0,
  longestRouteM: 0,
  usedSimulator: false,
  routePoints: [],
  started: false, // true once the player pressed Kick off or Demo mode
};

// ---------------------------------------------------------------- geo helpers

const DEG = Math.PI / 180;
const M_PER_DEG = 111_320;

function distanceM(a, b) {
  const dLat = (b.lat - a.lat) * DEG;
  const dLon = (b.lon - a.lon) * DEG;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * DEG) * Math.cos(b.lat * DEG) * Math.sin(dLon / 2) ** 2;
  return 2 * 6_371_008.8 * Math.asin(Math.min(1, Math.sqrt(h)));
}

function offset(point, eastM, northM) {
  return {
    lat: point.lat + northM / M_PER_DEG,
    lon: point.lon + eastM / (M_PER_DEG * Math.max(0.01, Math.cos(point.lat * DEG))),
  };
}

function stepTowards(from, to, maxM) {
  const d = distanceM(from, to);
  if (d <= maxM) return { point: to, arrived: true };
  const f = maxM / d;
  return { point: { lat: from.lat + (to.lat - from.lat) * f, lon: from.lon + (to.lon - from.lon) * f }, arrived: false };
}

const fmtM = (m) => (m >= 1000 ? `${(m / 1000).toFixed(2)} km` : `${Math.round(m)} m`);
function fmtDuration(seconds) {
  const s = Math.max(0, Math.round(seconds));
  return s < 60 ? `${s} s` : `${Math.floor(s / 60)} min ${String(s % 60).padStart(2, '0')} s`;
}

// ------------------------------------------------------------------------ map

// Opens on the bundled play area as a preview. No player marker is drawn until a real or
// explicitly simulated position exists, so the preview never poses as the player's location.
const PREVIEW_ZOOM = 15;
const map = L.map('map', { zoomControl: false, worldCopyJump: true }).setView([32.0809, 34.7806], PREVIEW_ZOOM);
L.control.zoom({ position: 'bottomright' }).addTo(map);
L.control.scale({ position: 'bottomleft', imperial: false, maxWidth: 120 }).addTo(map);

const playerIcon = L.divIcon({
  className: 'player-icon',
  html: '<img src="/assets/ball.png" alt="Player" />',
  iconSize: [34, 34],
  iconAnchor: [17, 17],
});
const goalIcon = L.divIcon({
  className: 'goal-icon',
  html: '<svg viewBox="0 0 64 46" role="img" aria-label="Goal"><defs><pattern id="goal-net" width="6" height="6" patternUnits="userSpaceOnUse"><path d="M0 0 6 6M6 0 0 6" stroke="rgba(255,255,255,.6)" stroke-width=".8"/></pattern></defs><rect x="5" y="6" width="54" height="34" fill="#0b1220" fill-opacity=".85"/><rect x="5" y="6" width="54" height="34" fill="url(#goal-net)"/><path d="M5 41V6h54v35" fill="none" stroke="#fff" stroke-width="4.5" stroke-linecap="round" stroke-linejoin="round"/><path d="M2 42.5h60" stroke="#34e3a0" stroke-width="3" stroke-linecap="round"/></svg>',
  // Anchored at the middle of the goal line, so the goal stands on the destination point.
  iconSize: [64, 46],
  iconAnchor: [32, 42],
});

const layers = {
  accuracy: L.circle([0, 0], { radius: 1, color: '#38d6f5', weight: 1, fillOpacity: 0.12, interactive: false }),
  goalZone: L.circle([0, 0], { radius: 1, color: '#12b981', weight: 2, dashArray: '4 6', fillOpacity: 0.16, interactive: false }),
  routeCasing: L.polyline([], { color: '#ffffff', weight: 9, opacity: 0.9, interactive: false }),
  route: L.polyline([], { color: '#2563eb', weight: 5, opacity: 0.95, interactive: false }),
  // Dotted link from the real position to where the route begins. It is not part of the route:
  // it only shows how far the player is from the road the route starts on.
  connector: L.polyline([], { color: '#2563eb', weight: 2, dashArray: '2 7', opacity: 0.8, interactive: false }),
  goal: L.marker([0, 0], { icon: goalIcon, interactive: false, zIndexOffset: 500 }),
  player: L.marker([0, 0], { icon: playerIcon, interactive: false, zIndexOffset: 1000 }),
};

layers.goal.bindTooltip('GOAL', { permanent: true, direction: 'top', offset: [0, -40], className: 'goal-flag' });

function show(layer) {
  if (!map.hasLayer(layer)) layer.addTo(map);
}
function hide(layer) {
  if (map.hasLayer(layer)) layer.remove();
}

function fitGame() {
  const points = [];
  if (state.fix) points.push([state.fix.lat, state.fix.lon]);
  if (state.goal) points.push([state.goal.lat, state.goal.lon]);
  for (const p of state.routePoints) points.push([p.lat, p.lon]);
  if (points.length === 0) return;
  if (points.length === 1) return void map.setView(points[0], 17);
  // Keep the game clear of the mission panel: beside it on wide screens, below it on phones.
  const hud = document.querySelector('.hud').getBoundingClientRect();
  const wide = window.innerWidth > 720;
  map.invalidateSize();
  map.fitBounds(L.latLngBounds(points), {
    paddingTopLeft: wide ? [hud.right + 50, 70] : [40, hud.bottom + 50],
    // Bottom-right also clears the zoom buttons.
    paddingBottomRight: wide ? [90, 80] : [70, 110],
    maxZoom: 18,
    animate: false,
  });
}

/** Pans when the ball nears the viewport edge or slides underneath the HUD panel. */
function keepPlayerVisible() {
  if (!state.fix) return;
  const p = map.latLngToContainerPoint([state.fix.lat, state.fix.lon]);
  const size = map.getSize();
  const hud = document.querySelector('.hud').getBoundingClientRect();
  const margin = 50;
  const underHud = p.x < hud.right + margin && p.y < hud.bottom + margin && p.x > hud.left - margin;
  const nearEdge = p.x < margin || p.y < margin || p.x > size.x - margin || p.y > size.y - margin;
  if (!underHud && !nearEdge) return;
  // Aim for the centre of the free area (right of the HUD on wide screens, below it on narrow ones).
  const wide = size.x > 720;
  const target = wide ? L.point((hud.right + size.x) / 2, size.y / 2) : L.point(size.x / 2, (hud.bottom + size.y) / 2);
  map.panBy(p.subtract(target), { animate: true, duration: 0.4 });
}

/**
 * Offline base map: draws the road network itself from the same graph the router uses.
 * Used when hosted tiles are disabled (OFFLINE=true) or fail to load.
 */
const vectorMap = (() => {
  const renderer = L.canvas({ padding: 0.5 });
  let layer = null;
  let edge = null;
  let coveredBox = null;
  let loading = false;
  let wanted = false;

  // Streets are drawn as bands whose width follows the zoom, like a street map, instead of
  // hairlines. The bundled graph carries geometry only (no road classes or names), so every
  // walkable path gets the same style rather than a hierarchy we would have to invent.
  const roadWeight = () => ({ 13: 1, 14: 1.5, 15: 2.5, 16: 4.5, 17: 8, 18: 13 })[Math.round(map.getZoom())] ?? (map.getZoom() < 13 ? 0.8 : 18);
  map.on('zoomend', () => layer?.setStyle({ weight: roadWeight() }));

  async function load() {
    const fix = state.fix ?? state.config?.demoStart;
    if (!wanted || loading || !fix) return;
    const box = coveredBox;
    if (box && fix.lat > box.south && fix.lat < box.north && fix.lon > box.west && fix.lon < box.east) return;
    loading = true;
    try {
      const { bbox, segments } = await api(`/api/roads?lat=${fix.lat}&lon=${fix.lon}`);
      const lines = [];
      for (let i = 0; i < segments.length; i += 4) {
        lines.push([
          [segments[i], segments[i + 1]],
          [segments[i + 2], segments[i + 3]],
        ]);
      }
      layer?.remove();
      edge?.remove();
      layer = L.polyline(lines, {
        renderer,
        color: '#4a5f88',
        weight: roadWeight(),
        opacity: 1,
        lineCap: 'round',
        lineJoin: 'round',
        interactive: false,
      }).addTo(map);
      layer.bringToBack();
      // Where the bundled map data ends, so empty space reads as "no data", not "no streets".
      edge = L.rectangle(
        [
          [bbox.south, bbox.west],
          [bbox.north, bbox.east],
        ],
        { renderer, color: '#38d6f5', weight: 1, opacity: 0.45, dashArray: '6 8', fill: false, interactive: false },
      ).addTo(map);
      coveredBox = bbox;
    } catch {
      // The base map is decoration; the game itself reports map-data problems.
    } finally {
      loading = false;
    }
  }

  return {
    enable() {
      wanted = true;
      // Dark field with our own roads: restyle the route so it stays readable on it.
      document.body.classList.add('is-vector');
      layers.route.setStyle({ color: '#38d6f5' });
      layers.routeCasing.setStyle({ color: '#06101f', weight: 10 });
      layers.connector.setStyle({ color: '#38d6f5' });
      void load();
    },
    refresh: () => void load(),
  };
})();

// ------------------------------------------------------------------------ HUD

function setBadge() {
  const badge = $('source-badge');
  if (!state.fix) {
    badge.textContent = state.started ? 'LOCATING' : 'STANDBY';
    badge.className = 'badge badge--idle';
  } else if (state.fix.simulated) {
    badge.textContent = 'SIMULATED';
    badge.className = 'badge badge--sim';
  } else {
    badge.textContent = 'LIVE';
    badge.className = 'badge badge--live';
  }
  layers.player.getElement()?.classList.toggle('is-sim', Boolean(state.fix?.simulated));
}

function setNav(text, tone = '') {
  $('nav-status').textContent = text;
  $('nav-status').dataset.tone = tone;
}

function setRouteProgress(fraction) {
  const percent = Math.round(Math.min(1, Math.max(0, fraction)) * 100);
  $('progress-fill').style.width = `${percent}%`;
  $('progress-ball').style.insetInlineStart = `${percent}%`;
  $('progress-fill').parentElement.setAttribute('aria-valuenow', String(percent));
}

function setStatus(text) {
  $('status').hidden = !text;
  $('status').textContent = text ?? '';
}

function showBanner(text, actions = []) {
  $('banner-text').textContent = text;
  const box = $('banner-actions');
  box.replaceChildren(
    ...actions.map(({ label, run, accent }) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = accent ? 'btn btn--accent' : 'btn';
      button.textContent = label;
      button.addEventListener('click', () => {
        hideBanner();
        run();
      });
      return button;
    }),
  );
  $('banner').hidden = false;
}
function hideBanner() {
  $('banner').hidden = true;
}

function renderFixTelemetry() {
  const fix = state.fix;
  if (!fix) {
    $('m-accuracy-text').textContent = '—';
    $('signal-bars').dataset.level = '0';
    $('m-age').textContent = '—';
    return;
  }
  // Three honest levels: good enough to navigate, good enough to confirm arrival, neither.
  const level = fix.accuracyM <= 15 ? 3 : fix.accuracyM <= state.config.maxArrivalAccuracyM ? 2 : 1;
  $('signal-bars').dataset.level = String(level);
  $('m-accuracy-text').textContent = `${['', 'Poor', 'Fair', 'Good'][level]} · ± ${fmtM(fix.accuracyM)}`;
  $('m-age').textContent = `${fmtDuration((Date.now() - fix.at) / 1000)} ago`;
}
setInterval(renderFixTelemetry, 1000);

function renderProgress(progress) {
  $('m-distance').textContent = fmtM(progress.route.distanceM);
  $('m-eta').textContent = fmtDuration(progress.route.distanceM / WALK_SPEED_MPS);
  $('m-direct').textContent = fmtM(progress.distanceToGoalM);
  $('m-offroad').textContent = fmtM(progress.offRoadM);
  // Progress is measured against the longest route seen this game, so a detour that makes the
  // route longer moves the bar back instead of pushing it below zero.
  state.longestRouteM = Math.max(state.longestRouteM, progress.route.distanceM);
  setRouteProgress(1 - progress.route.distanceM / state.longestRouteM);
  if (progress.arrival === 'REACHED') setNav('Arrived at the goal', 'ok');
  else if (state.fix && !state.fix.simulated && state.fix.accuracyM > state.config.maxArrivalAccuracyM) {
    setNav(
      `Low location accuracy (± ${fmtM(state.fix.accuracyM)}) · arrival is confirmed at ± ${fmtM(state.config.maxArrivalAccuracyM)} or better`,
      'warn',
    );
  } else if (progress.offRoadM > 25) setNav(`Off the route network by ${fmtM(progress.offRoadM)} · route starts at the nearest path`, 'warn');
  else setNav('On route · follow the line to the goal', 'ok');
}

function clearProgress() {
  for (const id of ['m-distance', 'm-eta', 'm-direct', 'm-offroad']) $(id).textContent = '—';
  setRouteProgress(0);
}

// ------------------------------------------------------------------------ API

class ApiError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

async function api(path, body, signal) {
  let response;
  try {
    response = await fetch(path, {
      method: body ? 'POST' : 'GET',
      headers: body ? { 'content-type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
      signal,
    });
  } catch (error) {
    if (error.name === 'AbortError') throw error;
    throw new ApiError('NETWORK', 'The game server cannot be reached.');
  }
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    throw new ApiError(payload?.error?.code ?? 'INTERNAL', payload?.error?.message ?? `Request failed (${response.status}).`);
  }
  return payload;
}

const wireFix = (fix) => ({
  lat: fix.lat,
  lon: fix.lon,
  accuracyM: fix.accuracyM,
  simulated: fix.simulated,
  ageMs: Math.max(0, Date.now() - fix.at),
});

// ----------------------------------------------------------------- game logic

async function startGame() {
  if (!state.fix) return;
  const seq = ++state.gameSeq;
  routeLoop.cancel();
  sim.stopWalking();
  state.phase = 'starting';
  state.goal = null;
  state.routePoints = [];
  state.usedSimulator = state.fix.simulated;
  for (const layer of [layers.goal, layers.goalZone, layers.route, layers.routeCasing, layers.connector]) hide(layer);
  clearProgress();
  $('win').hidden = true;
  $('btn-new').disabled = true;
  hideBanner();
  setStatus(null);
  setNav('Scouting the streets and placing the goal…');

  const fixAtStart = state.fix;
  try {
    const game = await api('/api/games', { position: wireFix(fixAtStart) });
    if (seq !== state.gameSeq) return; // a newer game superseded this one
    state.goal = game.goal;
    state.phase = 'playing';
    state.startedAt = Date.now();
    state.travelledM = 0;
    state.initialRouteM = game.route.distanceM;
    state.longestRouteM = game.route.distanceM;
    sound.routeReady();
    layers.goal.setLatLng([game.goal.lat, game.goal.lon]);
    layers.goal.getElement()?.classList.remove('is-scored');
    layers.goalZone.setLatLng([game.goal.lat, game.goal.lon]).setRadius(state.config.reachThresholdM);
    show(layers.goalZone);
    show(layers.goal);
    setStatus(null);
    applyProgress(game, fixAtStart);
    fitGame();
    $('btn-new').disabled = false;
    vectorMap.refresh();
    // The player may have moved while the game was being created.
    routeLoop.request();
  } catch (error) {
    if (seq !== state.gameSeq) return;
    // 'failed' waits for the player's choice; new fixes must not retry in a loop.
    state.phase = 'failed';
    setStatus(null);
    setNav('No game in progress', 'warn');
    $('btn-new').disabled = false;
    const retry = { label: 'Try again', run: startGame };
    const demo = { label: 'Use Demo mode at the demo location', run: () => sim.enable(state.config.demoStart) };
    if (error.code === 'OUTSIDE_COVERAGE') {
      // Retrying cannot help here: the position is fine, the bundled map simply does not reach
      // it. Demo mode is offered first, and still only starts when the player chooses it.
      const where = fixAtStart.simulated ? 'This position' : `Your location was found (± ${fmtM(fixAtStart.accuracyM)}), but it`;
      showBanner(
        `${where} is outside the offline map, which covers central Tel Aviv only. ` +
          'Play in Demo mode, or run with OFFLINE=false to use your real location.',
        [{ ...demo, accent: true }, retry],
      );
    } else if (['OFF_NETWORK', 'NO_GOAL_AVAILABLE'].includes(error.code)) {
      showBanner(error.message, [{ ...retry, accent: true }, demo]);
    } else {
      showBanner(error.message, [{ ...retry, accent: true }]);
    }
  }
}

function applyProgress(progress, fixUsed) {
  state.routePoints = progress.route.points;
  const latLngs = progress.route.points.map((p) => [p.lat, p.lon]);
  layers.routeCasing.setLatLngs(latLngs);
  layers.route.setLatLngs(latLngs);
  show(layers.routeCasing);
  show(layers.route);
  if (latLngs.length > 0) {
    layers.connector.setLatLngs([[fixUsed.lat, fixUsed.lon], latLngs[0]]);
    show(layers.connector);
  }
  renderProgress(progress);

  if (progress.arrival === 'REACHED') {
    win();
  } else if (progress.arrival === 'UNCERTAIN') {
    const coarse = fixUsed.accuracyM > state.config.maxArrivalAccuracyM;
    setStatus(
      coarse
        ? `You are inside the goal zone, but the location fix (± ${fmtM(fixUsed.accuracyM)}) is too coarse to confirm it. ` +
            `A fix of ± ${fmtM(state.config.maxArrivalAccuracyM)} or better is required.`
        : 'You are inside the goal zone, but the last location fix is too old to confirm it. Waiting for a fresh fix.',
    );
  } else if (!$('status').textContent.startsWith('No walkable route')) {
    setStatus(null);
  }
}

function win() {
  if (state.phase === 'reached') return; // latch: one goal per game
  state.phase = 'reached';
  routeLoop.cancel();
  sim.stopWalking();
  setStatus(null);
  layers.goal.getElement()?.classList.add('is-scored');
  setRouteProgress(1);
  setNav('Arrived at the goal', 'ok');
  sound.goal();
  const seconds = (Date.now() - state.startedAt) / 1000;
  $('win-stats').textContent = `${fmtDuration(seconds)} · ${fmtM(state.travelledM)} travelled · shortest route was ${fmtM(state.initialRouteM)}`;
  $('win-note').textContent = state.usedSimulator ? 'Played with simulated positions.' : '';
  $('win').hidden = false;
  $('btn-again').focus();
}

/**
 * Keeps the route in sync with the player. At most one request is in flight; movement during
 * a request marks the loop dirty and one follow-up is sent, always with the latest fix.
 */
const routeLoop = (() => {
  let inFlight = null;
  let dirty = false;
  let timer = null;
  let lastRouted = null;
  let lastSentAt = 0;

  async function send() {
    timer = null;
    if (state.phase !== 'playing' || !state.fix || !state.goal) return;
    const seq = state.gameSeq;
    const fix = state.fix;
    inFlight = new AbortController();
    dirty = false;
    lastSentAt = Date.now();
    try {
      const progress = await api('/api/route', { position: wireFix(fix), goal: state.goal }, inFlight.signal);
      if (seq !== state.gameSeq || state.phase !== 'playing') return;
      lastRouted = fix;
      applyProgress(progress, fix);
    } catch (error) {
      if (error.name === 'AbortError' || seq !== state.gameSeq) return;
      // Keep the last good route on screen; the next movement (or the retry below) tries again.
      setStatus(`Route update failed: ${error.message} Showing the last known route.`);
      dirty = true;
    } finally {
      inFlight = null;
      if (dirty && state.phase === 'playing' && seq === state.gameSeq) schedule(retryDelay());
    }
  }

  // Back off after a failure (status line is showing it); otherwise just respect the throttle.
  const retryDelay = () => ($('status').hidden ? REROUTE_MIN_INTERVAL_MS : 3000);

  function schedule(delay) {
    if (timer === null) timer = setTimeout(send, delay);
  }

  return {
    request() {
      if (state.phase !== 'playing' || !state.fix) return;
      if (lastRouted && distanceM(lastRouted, state.fix) < REROUTE_MIN_MOVE_M && lastRouted.accuracyM === state.fix.accuracyM) return;
      if (inFlight) {
        dirty = true;
        return;
      }
      schedule(Math.max(0, REROUTE_MIN_INTERVAL_MS - (Date.now() - lastSentAt)));
    },
    cancel() {
      inFlight?.abort();
      inFlight = null;
      dirty = false;
      lastRouted = null;
      if (timer !== null) clearTimeout(timer);
      timer = null;
    },
  };
})();

/** Single entry point for every position, whatever its source. */
function onFix(fix) {
  const sourceChanged = Boolean(state.fix) && state.fix.simulated !== fix.simulated;
  if (sourceChanged && state.phase !== 'locating') {
    // A game is played entirely with host positions or entirely with simulated ones, never a
    // mix: switching source abandons the current game and starts a fresh one from the new fix.
    routeLoop.cancel();
    state.gameSeq++;
    state.phase = 'locating';
  }
  if (state.fix && state.phase === 'playing') {
    const moved = distanceM(state.fix, fix);
    // Count live movement only when it exceeds the noise floor, so standing still adds nothing.
    if (fix.simulated || moved >= REROUTE_MIN_MOVE_M) state.travelledM += moved;
  }
  const first = !state.fix;
  state.fix = fix;
  if (fix.simulated) state.usedSimulator = true;

  layers.player.setLatLng([fix.lat, fix.lon]);
  layers.accuracy.setLatLng([fix.lat, fix.lon]).setRadius(Math.max(1, fix.accuracyM));
  show(layers.accuracy);
  show(layers.player);
  setBadge();
  renderFixTelemetry();
  hideBannerIfLocating();

  // Not animated: a zoom animation still running when the game arrives would undo fitGame().
  if (first || sourceChanged) map.setView([fix.lat, fix.lon], 17, { animate: false });
  else keepPlayerVisible();

  if (state.phase === 'locating') void startGame();
  else routeLoop.request();
}

function hideBannerIfLocating() {
  if (state.phase === 'locating') hideBanner();
}

// ---------------------------------------------------------------------- sound

/** Three short synthesised cues. No audio files; created on the first user gesture only. */
const sound = (() => {
  let context = null;
  let muted = false;
  try {
    muted = localStorage.getItem('goalrun.muted') === '1';
  } catch {
    // storage can be blocked; sound simply starts unmuted
  }

  function tone(frequency, startS, durationS, type = 'sine', gain = 0.12) {
    if (muted || !context) return;
    const at = context.currentTime + startS;
    const oscillator = context.createOscillator();
    const envelope = context.createGain();
    oscillator.type = type;
    oscillator.frequency.setValueAtTime(frequency, at);
    envelope.gain.setValueAtTime(0.0001, at);
    envelope.gain.exponentialRampToValueAtTime(gain, at + 0.02);
    envelope.gain.exponentialRampToValueAtTime(0.0001, at + durationS);
    oscillator.connect(envelope).connect(context.destination);
    oscillator.start(at);
    oscillator.stop(at + durationS + 0.05);
  }

  function renderMute() {
    const button = $('btn-mute');
    button.setAttribute('aria-pressed', String(muted));
    button.title = muted ? 'Unmute sounds' : 'Mute sounds';
    button.firstElementChild.textContent = muted ? '🔇' : '🔊';
  }
  renderMute();

  return {
    /** Must be called from a user gesture: browsers block audio before one. */
    unlock() {
      try {
        context ??= new (window.AudioContext ?? window.webkitAudioContext)();
        void context.resume();
      } catch {
        context = null;
      }
    },
    toggleMute() {
      muted = !muted;
      try {
        localStorage.setItem('goalrun.muted', muted ? '1' : '0');
      } catch {
        // ignore
      }
      renderMute();
    },
    kickOff() {
      tone(2100, 0, 0.16, 'square', 0.05);
      tone(2100, 0.22, 0.34, 'square', 0.05);
    },
    routeReady() {
      tone(660, 0, 0.12);
      tone(990, 0.1, 0.18);
    },
    goal() {
      [523, 659, 784, 1047].forEach((frequency, i) => tone(frequency, i * 0.11, 0.3, 'triangle', 0.14));
      tone(1319, 0.48, 0.6, 'triangle', 0.14);
    },
  };
})();

// ------------------------------------------------------------ position sources

const live = (() => {
  let watchId = null;

  const reasons = {
    1: 'Location permission was denied. Allow location access for this page in the browser, or use the simulator.',
    2: 'This machine could not determine its location (no GPS/Wi-Fi positioning, or location services are off).',
    3: 'The location request timed out.',
  };

  function fail(message) {
    if (state.mode !== 'live') return;
    // Never fall back to simulated positions silently: the player has to choose it.
    showBanner(message, [
      { label: 'Try again', run: () => live.start(), accent: true },
      { label: 'Use simulator', run: () => sim.enable() },
    ]);
  }

  return {
    start() {
      this.stop();
      if (!window.isSecureContext) {
        return fail('Browsers only expose location on a secure origin. Open the game at http://localhost instead of an IP address.');
      }
      if (!('geolocation' in navigator)) return fail('This browser has no location API.');
      if (!state.fix) setNav('Waiting for a location fix from this device…');
      setBadge();
      watchId = navigator.geolocation.watchPosition(
        (position) => {
          const { latitude, longitude, accuracy } = position.coords;
          if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return;
          onFix({
            lat: latitude,
            lon: longitude,
            accuracyM: Number.isFinite(accuracy) ? accuracy : 9999,
            // The sensor's own timestamp: a cached fix must not look fresh.
            at: Number.isFinite(position.timestamp) ? Math.min(position.timestamp, Date.now()) : Date.now(),
            simulated: false,
          });
        },
        (error) => fail(reasons[error.code] ?? 'Location is unavailable.'),
        { enableHighAccuracy: true, maximumAge: 0, timeout: 20_000 },
      );
    },
    stop() {
      if (watchId !== null) navigator.geolocation.clearWatch(watchId);
      watchId = null;
    },
  };
})();

function clearOffRoadNote() {
  if ($('status').textContent.startsWith('No walkable route')) setStatus(null);
}

const sim = (() => {
  let position = null;
  let waypoints = [];
  let walkToken = 0;
  let frame = null;
  let lastTick = 0;

  function emit() {
    onFix({ ...position, accuracyM: SIM_ACCURACY_M, at: Date.now(), simulated: true });
  }

  // Driven by a timer, not requestAnimationFrame: rAF stops entirely in a background tab,
  // which would freeze a demo that someone left running while reading the code.
  function tick() {
    const now = performance.now();
    frame = null;
    if (state.mode !== 'sim' || waypoints.length === 0) return;
    // Capped so a stalled tab resumes with a short hop instead of a teleport.
    const dt = Math.min(1, (now - lastTick) / 1000);
    lastTick = now;
    const { point, arrived } = stepTowards(position, waypoints[0], SIM_SPEED_MPS * dt);
    position = point;
    if (arrived) waypoints.shift();
    emit();
    if (waypoints.length > 0) frame = setTimeout(tick, SIM_TICK_MS);
  }

  function walk(points) {
    waypoints = points.map((p) => ({ lat: p.lat, lon: p.lon }));
    if (frame === null && waypoints.length > 0) {
      lastTick = performance.now();
      frame = setTimeout(tick, SIM_TICK_MS);
    }
  }

  return {
    /** Starts simulating from `start`, else from the last known position, else the demo location. */
    enable(start) {
      live.stop();
      const usingDemo = !start && !state.fix;
      position = start ?? (state.fix ? { lat: state.fix.lat, lon: state.fix.lon } : state.config.demoStart);
      position = { lat: position.lat, lon: position.lon };
      state.mode = 'sim';
      map.keyboard.disable(); // arrow keys drive the ball instead of panning the map
      renderMode();
      if (start || usingDemo) {
        // Jumping to another place invalidates the current game.
        state.phase = 'locating';
        state.gameSeq++;
        map.setView([position.lat, position.lon], 17, { animate: false });
      }
      emit();
    },
    disable() {
      this.stopWalking();
      map.keyboard.enable();
    },
    nudge(eastM, northM) {
      if (state.mode !== 'sim' || state.phase === 'reached') return;
      this.stopWalking();
      position = offset(position, eastM, northM);
      emit();
    },
    /**
     * Walks to a clicked point along the streets, using the same router as the game. If the
     * point cannot be routed to (far from any path), walks straight there instead, which is
     * also how going off-road can be tried out.
     */
    async walkTo(point) {
      if (state.mode !== 'sim' || state.phase === 'reached' || !position) return;
      const token = ++walkToken;
      clearOffRoadNote();
      let path = [point];
      let offRoad = false;
      try {
        const from = { ...position, accuracyM: SIM_ACCURACY_M, simulated: true, ageMs: 0 };
        const { route } = await api('/api/route', { position: from, goal: point });
        if (route.points.length > 1) path = route.points;
      } catch {
        offRoad = true;
      }
      if (token !== walkToken || state.mode !== 'sim' || state.phase === 'reached') return;
      walk(path);
      // Say so when the ball is not following streets, so a straight hop is never mistaken
      // for a permitted walking route.
      if (offRoad) setTimeout(() => setStatus('No walkable route to that point: the ball is moving off-road in a straight line (simulation only).'), 0);
    },
    followRoute() {
      walkToken++;
      clearOffRoadNote();
      if (state.mode === 'sim' && state.phase === 'playing' && state.goal) walk([...state.routePoints, state.goal]);
    },
    stopWalking() {
      walkToken++; // also drops a click-to-walk request that has not answered yet
      waypoints = [];
      if (frame !== null) clearTimeout(frame);
      frame = null;
    },
  };
})();

function renderMode() {
  $('btn-live').setAttribute('aria-pressed', String(state.mode === 'live'));
  $('btn-sim').setAttribute('aria-pressed', String(state.mode === 'sim'));
  $('sim-panel').hidden = state.mode !== 'sim';
  document.body.classList.toggle('is-sim', state.mode === 'sim');
}

// --------------------------------------------------------------------- wiring

$('btn-live').addEventListener('click', () => {
  if (state.mode === 'live') return;
  sim.disable();
  state.mode = 'live';
  renderMode();
  hideBanner();
  live.start();
});
$('btn-sim').addEventListener('click', () => {
  if (state.mode !== 'sim') {
    state.started = true;
    hideBanner();
    // After a failed start (outside the offline map, no roads nearby) the last known position is
    // exactly the one that cannot be played, so the demo begins at the supported demo location.
    sim.enable(state.phase === 'failed' ? state.config.demoStart : undefined);
  }
});
function kickOff(demo) {
  state.started = true;
  $('intro').hidden = true;
  sound.unlock();
  sound.kickOff();
  setBadge();
  if (demo) sim.enable();
  else live.start();
}
$('btn-kickoff').addEventListener('click', () => kickOff(false));
$('btn-demo').addEventListener('click', () => kickOff(true));
$('btn-mute').addEventListener('click', () => sound.toggleMute());
$('btn-new').addEventListener('click', () => void startGame());
$('btn-again').addEventListener('click', () => void startGame());
$('btn-center').addEventListener('click', fitGame);
$('btn-auto').addEventListener('click', () => sim.followRoute());

map.on('click', (event) => void sim.walkTo({ lat: event.latlng.lat, lon: event.latlng.lng }));

const KEY_MOVES = {
  ArrowUp: [0, 1],
  ArrowDown: [0, -1],
  ArrowLeft: [-1, 0],
  ArrowRight: [1, 0],
  w: [0, 1],
  s: [0, -1],
  a: [-1, 0],
  d: [1, 0],
};
window.addEventListener('keydown', (event) => {
  const move = KEY_MOVES[event.key];
  if (!move || state.mode !== 'sim' || event.ctrlKey || event.metaKey || event.altKey) return;
  if (event.target instanceof HTMLButtonElement && event.key.length === 1) return;
  event.preventDefault();
  sim.nudge(move[0] * SIM_STEP_M, move[1] * SIM_STEP_M);
});

async function boot() {
  try {
    state.config = await api('/api/config');
  } catch (error) {
    return showBanner(error.message, [{ label: 'Reload', run: () => location.reload(), accent: true }]);
  }
  map.attributionControl.addAttribution('&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors');
  if (state.config.tileUrl) {
    // If hosted tiles cannot be reached, fall back to drawing the roads ourselves.
    L.tileLayer(state.config.tileUrl, { maxZoom: 19 })
      .once('tileerror', () => vectorMap.enable())
      .addTo(map);
  } else {
    vectorMap.enable();
  }
  map.setView([state.config.demoStart.lat, state.config.demoStart.lon], PREVIEW_ZOOM, { animate: false });
  if (state.config.offline) {
    $('intro-note').textContent =
      'Offline mode: the bundled map covers central Tel Aviv. Outside it, use Demo mode or run with OFFLINE=false.';
  }
  renderMode();
  // Location is requested only after the player presses Kick off: a permission prompt with
  // no context is the one most people dismiss.
  $('btn-kickoff').focus();
}

void boot();
