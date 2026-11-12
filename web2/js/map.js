/**
 * The chart: Leaflet setup, the graticule, the guess pin, and the reveal
 * (true-location flag, the dashed route between them, and the fly-to).
 * Leaflet is loaded as a classic script before this module, so it lives on window.L.
 */

const WORLD_BOUNDS = [[-58, -170], [75, 190]];
const HOME_ZOOM = 4; // "Start the map near me" opens at about country scale
const GRATICULE_STEP = 30; // degrees between lines of latitude and longitude
const ROUTE_DRAW_MS = 1000;
const FLY_SECONDS = 1.2;

let map = null;
let guessMarker = null;
let truthMarker = null;
let route = null;
let home = null;
let interactive = true;
let routeFrame = 0;
let pendingDraw = null; // the reveal's "draw the route once the flight lands" handler
let onPinPlaced = () => {};

const L = () => window.L;

/* ---------- Markers: two different shapes, not just two colours ---------- */

/** The guess: an ink survey point. */
const guessIcon = () =>
  L().divIcon({
    className: "pin pin--guess",
    iconSize: [22, 22],
    iconAnchor: [11, 11],
    html: `<svg viewBox="0 0 22 22" aria-hidden="true">
      <circle cx="11" cy="11" r="9" fill="#1c1b18" stroke="#f2e9d0" stroke-width="2.5"/>
      <circle cx="11" cy="11" r="2.5" fill="#f2e9d0"/>
    </svg>`,
  });

/** The answer: a green surveyor's flag planted at the spot (anchored at the foot of the pole). */
const truthIcon = () =>
  L().divIcon({
    className: "pin pin--truth",
    iconSize: [30, 40],
    iconAnchor: [6, 38],
    html: `<svg viewBox="0 0 30 40" aria-hidden="true">
      <ellipse cx="6" cy="38" rx="5" ry="1.8" fill="#1c1b18" opacity="0.35"/>
      <path d="M6 38 V3" stroke="#1c1b18" stroke-width="2.5" stroke-linecap="round"/>
      <path d="M7 4 H27 L21 11 L27 18 H7 Z" fill="#58704a" stroke="#1c1b18" stroke-width="1.5" stroke-linejoin="round"/>
      <circle cx="6" cy="3" r="2.2" fill="#1c1b18"/>
    </svg>`,
  });

/** Faint lines every 30° of latitude and longitude, like an old chart. */
function drawGraticule(target) {
  const style = { className: "graticule", weight: 1, opacity: 0.2, interactive: false };
  const equator = { ...style, weight: 1.5, opacity: 0.38 };

  for (let lat = -60; lat <= 60; lat += GRATICULE_STEP) {
    L().polyline([[lat, -540], [lat, 540]], lat === 0 ? equator : style).addTo(target);
  }
  for (let lng = -540; lng <= 540; lng += GRATICULE_STEP) {
    L().polyline([[-85, lng], [85, lng]], style).addTo(target);
  }
}

/* ---------- Setup ---------- */

/**
 * Create the map once. Later calls just resize it.
 * @param {HTMLElement} element
 * @param {{ onPin: (point: {lat: number, lng: number}) => void, onTileError: () => void }} handlers
 */
export function initMap(element, { onPin, onTileError }) {
  if (map) {
    map.invalidateSize();
    return;
  }

  onPinPlaced = onPin;
  map = L().map(element, {
    worldCopyJump: true,
    minZoom: 1,
    maxZoom: 16,
    zoomSnap: 0.5,
    // Stop panning past the poles; east–west wraps freely.
    maxBounds: [[-85, -100000], [85, 100000]],
    maxBoundsViscosity: 1,
  });

  const tiles = L().tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
  });

  // Report a tile failure once, not once per tile.
  let tileErrorReported = false;
  tiles.on("tileerror", () => {
    if (!tileErrorReported) {
      tileErrorReported = true;
      onTileError();
    }
  });

  tiles.addTo(map);
  map.attributionControl.setPrefix(false);
  drawGraticule(map);
  resetView();

  map.on("click", (event) => {
    if (interactive) placeGuess(event.latlng);
  });
}

/** Remember where the player is, for "Start the map near me". */
export function setHome(lat, lng) {
  home = [lat, lng];
}

/** Show the player's home region, or the whole world. */
export function resetView() {
  if (!map) return;
  if (home) {
    map.setView(home, HOME_ZOOM);
  } else {
    map.fitBounds(WORLD_BOUNDS);
  }
}

/** Allow or block placing pins (blocked while the answer is shown). */
export function setInteractive(value) {
  interactive = value;
  map?.getContainer().classList.toggle("is-locked", !value);
}

/* ---------- Guessing ---------- */

/**
 * Put the guess pin at a point, from a click or from the country picker.
 * @param {{lat: number, lng: number}} latlng
 * @param {{ pan?: boolean }} options pan the chart to the pin (used by the keyboard picker)
 */
export function placeGuess(latlng, { pan = false } = {}) {
  if (guessMarker) {
    guessMarker.setLatLng(latlng);
  } else {
    guessMarker = L().marker(latlng, { icon: guessIcon(), keyboard: false, interactive: false }).addTo(map);
  }
  if (pan) map.panTo(latlng);

  const wrapped = L().latLng(latlng).wrap();
  onPinPlaced({ lat: wrapped.lat, lng: wrapped.lng });
}

/** Clear everything from the last plate: pins, route, any running animation. */
export function clearPlate() {
  cancelAnimationFrame(routeFrame);
  if (pendingDraw) {
    map.off("moveend", pendingDraw);
    clearTimeout(pendingDraw.timer);
    pendingDraw = null;
  }
  for (const layer of [guessMarker, truthMarker, route]) layer?.remove();
  guessMarker = truthMarker = route = null;
}

/* ---------- The reveal ---------- */

/**
 * Show the answer: fit both points, draw a dashed route from the guess, then plant the flag.
 * @param {{lat: number, lon: number}} truth
 * @param {{ animate: boolean }} options false under prefers-reduced-motion
 */
export function showReveal(truth, { animate }) {
  const from = guessMarker.getLatLng();
  // Draw the short way round: pick the copy of the answer's longitude nearest the guess.
  const lng = truth.lon + 360 * Math.round((from.lng - truth.lon) / 360);
  const to = L().latLng(truth.lat, lng);

  const bounds = L().latLngBounds([from, to]);
  const fitOptions = { padding: [56, 56], maxZoom: 9 };

  route = L()
    .polyline([from, from], {
      className: "route",
      weight: 2.5,
      dashArray: "7 7",
      interactive: false,
    })
    .addTo(map);

  const plantFlag = () => {
    truthMarker = L()
      .marker(to, { icon: truthIcon(), keyboard: false, interactive: false, zIndexOffset: 500 })
      .addTo(map);
  };

  if (!animate) {
    map.fitBounds(bounds, { ...fitOptions, animate: false });
    route.setLatLngs([from, to]);
    plantFlag();
    return;
  }

  // Draw once the flight lands, or after its duration if the view barely needed to move.
  const draw = () => {
    if (pendingDraw !== draw) return; // already drawn, or the plate was cleared
    map.off("moveend", draw);
    clearTimeout(draw.timer);
    pendingDraw = null;
    drawRoute(from, to, plantFlag);
  };
  pendingDraw = draw;
  map.flyToBounds(bounds, { ...fitOptions, duration: FLY_SECONDS });
  map.on("moveend", draw);
  draw.timer = setTimeout(draw, FLY_SECONDS * 1000 + 300);
}

/** Grow the route from the guess to the answer over about a second. */
function drawRoute(from, to, done) {
  const start = performance.now();
  const step = (now) => {
    if (!route) return; // the plate was cleared mid-animation
    const t = Math.min(1, (now - start) / ROUTE_DRAW_MS);
    const eased = 1 - (1 - t) ** 3;
    route.setLatLngs([
      from,
      [from.lat + (to.lat - from.lat) * eased, from.lng + (to.lng - from.lng) * eased],
    ]);
    if (t < 1) {
      routeFrame = requestAnimationFrame(step);
    } else {
      done();
    }
  };
  routeFrame = requestAnimationFrame(step);
}
