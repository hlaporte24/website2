/**
 * Pin Drop: game state and screen flow.
 *
 *   start ──Play──▶ round (guess) ──Lock in──▶ round (reveal) ──Next──▶ … ×5 ──▶ summary
 *     ▲                                                                         │
 *     └────────────────────────── Title page / Play again ◀────────────────────┘
 */

import { fetchJson, findPhotos, preloadImage, shuffle, fetchCountryFacts } from "./api.js";
import { haversineKm, scoreForDistance } from "./scoring.js";
import { loadRecords, recordGame } from "./storage.js";
import {
  initMap,
  clearPlate,
  placeGuess,
  resetView,
  setHome,
  setInteractive,
  showReveal,
} from "./map.js";
import * as ui from "./ui.js";

const TOTAL_ROUNDS = 5;
const MAX_PLACE_ATTEMPTS = 5; // places to search before giving up on Commons for a plate
const MAX_PHOTOS_PER_PLACE = 3; // broken image files to skip before moving on
const MAX_CONNECTION_FAILURES = 2; // timeouts or network errors in a row before going offline

const $ = (selector) => document.querySelector(selector);

// Tell the stylesheet the scripts are running (hides the "game hasn't started" notice).
document.documentElement.classList.add("js-ready");

const state = {
  places: [],
  countries: [],
  fallbackPhotos: [],
  usedPlaces: new Set(),
  usedFallback: new Set(),
  offline: false, // Commons unreachable: use the bundled plates for the rest of the game
  round: 0,
  phase: "idle", // "guess" | "reveal" | "idle"
  photo: null,
  guess: null,
  total: 0,
  results: [],
  nextPlate: null, // the following plate, fetched during the reveal
  loadToken: 0, // bumps on every load, so an outdated request can't overwrite a newer one
};

const FRIENDLY_ERRORS = {
  timeout: "Wikimedia Commons is taking too long to answer.",
  network: "Wikimedia Commons can't be reached. Check your connection.",
  "rate-limited": "Wikimedia Commons asked us to slow down for a moment.",
  http: "Wikimedia Commons had a problem answering.",
  "bad-response": "Wikimedia Commons sent back something unexpected.",
};

/* ---------- Finding a plate ---------- */

/**
 * Search Commons around up to five unused places, trying up to three photos at
 * each, until one actually loads. Gives up early when Commons itself looks unreachable.
 * @returns {Promise<{photo: object, img: HTMLImageElement}>}
 * @throws the last ApiError, or an Error if no place had a usable photo
 */
async function findCommonsPlate() {
  const candidates = shuffle(state.places.filter((p) => !state.usedPlaces.has(p.name)));
  let lastError = null;
  let connectionFailures = 0;

  for (const place of candidates.slice(0, MAX_PLACE_ATTEMPTS)) {
    state.usedPlaces.add(place.name);

    let photos;
    try {
      photos = await findPhotos(place);
      connectionFailures = 0;
    } catch (error) {
      lastError = error;
      if (error.kind === "rate-limited") break; // more requests will only be refused too
      if (error.kind === "timeout" || error.kind === "network") {
        connectionFailures += 1;
        if (connectionFailures >= MAX_CONNECTION_FAILURES) break;
      }
      continue;
    }

    for (const photo of photos.slice(0, MAX_PHOTOS_PER_PLACE)) {
      try {
        return { photo, img: await preloadImage(photo.src) };
      } catch {
        // A broken or slow image file: try the next photo at this place.
      }
    }
  }

  throw lastError ?? new Error("No usable photograph near any of the places tried");
}

/** A plate from the bundled reserve, for when Commons can't be reached. */
async function findFallbackPlate() {
  for (const photo of shuffle(state.fallbackPhotos.filter((p) => !state.usedFallback.has(p.src)))) {
    state.usedFallback.add(photo.src);
    try {
      return { photo, img: await preloadImage(photo.src) };
    } catch {
      // Missing file: try the next.
    }
  }
  throw new Error("The reserve plates are used up");
}

/**
 * The next plate from Commons, or from the bundled reserve.
 * - Commons unreachable or failing: the rest of the voyage uses the reserve, with a notice.
 * - Commons fine but no usable photo near five places: this one plate comes from the reserve, silently.
 */
async function findPlate() {
  if (!state.offline) {
    try {
      return await findCommonsPlate();
    } catch (error) {
      if (state.fallbackPhotos.length === 0) throw error;
      if (["timeout", "network", "rate-limited", "http", "bad-response"].includes(error.kind)) {
        state.offline = true;
        ui.showBanner(
          `${FRIENDLY_ERRORS[error.kind]} The voyage continues with the atlas's own reserve of plates.`,
        );
      }
    }
  }
  return findFallbackPlate();
}

async function loadPlate() {
  const token = ++state.loadToken;
  const pending = state.nextPlate ?? findPlate();
  state.nextPlate = null;
  state.photo = null;
  updateLockIn();
  ui.showPlateLoading();

  try {
    const { photo, img } = await pending;
    if (token !== state.loadToken) return;
    state.photo = photo;
    ui.showPhoto(img, state.round);
    updateLockIn();
  } catch (error) {
    if (token !== state.loadToken) return;
    const reason = FRIENDLY_ERRORS[error.kind] ?? "No suitable photograph turned up nearby.";
    ui.showBanner(`${reason} Try another plate in a moment.`);
    ui.showPlateFailure();
  }
}

/* ---------- Guessing ---------- */

function updateLockIn() {
  $("#lock-in").disabled = !(state.phase === "guess" && state.photo && state.guess);
}

function handlePin(point) {
  if (state.phase !== "guess") return;
  state.guess = point;
  ui.setPinReadout(point);
  updateLockIn();
}

function startRound() {
  state.round += 1;
  state.phase = "guess";
  state.guess = null;
  clearPlate();
  setInteractive(true);
  resetView();
  ui.setRoundLabels(state.round, TOTAL_ROUNDS);
  updateLockIn();
  loadPlate();
}

/* ---------- The reveal ---------- */

function countryName(code) {
  return state.countries.find((c) => c.code === code)?.name ?? "";
}

async function lockIn() {
  if (state.phase !== "guess" || !state.photo || !state.guess) return;
  state.phase = "reveal";
  setInteractive(false);

  const { photo, guess } = state;
  const distanceKm = haversineKm({ lat: guess.lat, lon: guess.lng }, photo);
  const points = scoreForDistance(distanceKm);
  const previousTotal = state.total;
  state.total += points;

  const result = {
    round: state.round,
    placeName: photo.placeName,
    countryName: countryName(photo.countryCode),
    distanceKm,
    points,
  };
  state.results.push(result);

  const animate = !ui.prefersReducedMotion();
  ui.showVerdict({ ...result, photo });
  ui.setRunningTotal(state.total, previousTotal);
  showReveal(photo, { animate });
  swingCompass(animate);
  $("#next-round").focus({ preventScroll: true });

  // Start fetching the next plate while the player reads about this one.
  if (state.round < TOTAL_ROUNDS) {
    state.nextPlate = findPlate();
    state.nextPlate.catch(() => {}); // handled when the next round awaits it
  }

  ui.showDossierLoading();
  const round = state.round;
  try {
    const facts = await fetchCountryFacts(photo.countryCode);
    if (round === state.round && state.phase === "reveal") ui.showCountryFacts(facts);
  } catch {
    if (round === state.round && state.phase === "reveal") ui.showDossierFailure();
  }
}

/** The compass rose swings as the chart flies to the answer, then settles back. */
function swingCompass(animate) {
  if (!animate) return;
  const compass = $("#compass");
  compass.classList.add("is-swinging");
  setTimeout(() => compass.classList.remove("is-swinging"), 1400);
}

function nextRound() {
  if (state.round < TOTAL_ROUNDS) {
    startRound();
    $("#round-heading").focus({ preventScroll: true });
  } else {
    finishGame();
  }
}

/* ---------- The end of a voyage ---------- */

function finishGame() {
  state.phase = "idle";
  const { records, isPersonalBest, saved } = recordGame(state.total);
  ui.renderSummary({
    total: state.total,
    results: state.results,
    isPersonalBest,
    saved,
    history: records.history,
  });
  ui.showScreen("summary");
  $("#summary-rank").focus({ preventScroll: true });
}

function showTitlePage() {
  state.phase = "idle";
  ui.renderRecords(loadRecords());
  ui.showScreen("start");
  ui.hideBanner();
}

/* ---------- "Start the map near me" ---------- */

const GEO_MESSAGES = {
  1: "Location access was declined, so the chart opens on the whole world. You can still play as normal.",
  2: "Your location couldn't be worked out, so the chart opens on the whole world.",
  3: "Finding your location took too long, so the chart opens on the whole world.",
};

function locatePlayer() {
  if (!("geolocation" in navigator)) {
    ui.showBanner("This browser can't share its location, so the chart opens on the whole world.");
    return;
  }
  navigator.geolocation.getCurrentPosition(
    ({ coords }) => {
      setHome(coords.latitude, coords.longitude);
      // Recentre now unless the player has already started pinning.
      if (state.phase === "guess" && !state.guess) resetView();
    },
    (error) => ui.showBanner(GEO_MESSAGES[error.code] ?? GEO_MESSAGES[2]),
    { timeout: 10000, maximumAge: 10 * 60 * 1000 },
  );
}

/* ---------- Starting a game ---------- */

/**
 * Load the bundled data once. The three files are independent, so one failing
 * never blocks the others; only having no places at all is fatal.
 */
async function loadAtlas() {
  if (state.places.length || state.fallbackPhotos.length) return true;

  const [places, countries, fallback] = await Promise.allSettled([
    fetchJson("data/places.json"),
    fetchJson("data/countries.json"),
    fetchJson("data/fallback.json"),
  ]);
  const list = (result) => (result.status === "fulfilled" && Array.isArray(result.value) ? result.value : []);

  state.places = list(places);
  state.countries = list(countries);
  state.fallbackPhotos = list(fallback);
  ui.populateCountries(state.countries);

  if (state.places.length === 0 && state.fallbackPhotos.length === 0) {
    ui.showBanner("The atlas of places couldn't be opened. Reload the page to try again.");
    return false;
  }
  if (state.places.length === 0) state.offline = true;
  return true;
}

async function startGame() {
  ui.hideBanner();
  if (!window.L) {
    ui.showBanner("The map library couldn't load. Check your connection and reload the page.");
    return;
  }
  if (!(await loadAtlas())) return;

  Object.assign(state, {
    round: 0,
    total: 0,
    results: [],
    nextPlate: null,
    offline: state.places.length === 0,
  });
  state.usedPlaces.clear();
  state.usedFallback.clear();
  $("#tally-score").textContent = "0";

  ui.showScreen("round");
  initMap($("#map"), {
    onPin: handlePin,
    onTileError: () =>
      ui.showBanner("Some map tiles couldn't load. You can still place a pin; coastlines may be missing."),
  });
  if ($("#near-me").checked) locatePlayer();
  startRound();
}

/* ---------- Wiring ---------- */

$("#start-form").addEventListener("submit", (event) => {
  event.preventDefault();
  startGame();
});

$("#lock-in").addEventListener("click", lockIn);
$("#next-round").addEventListener("click", nextRound);
$("#play-again").addEventListener("click", startGame);
$("#to-start").addEventListener("click", showTitlePage);

$("#retry-photo").addEventListener("click", () => {
  ui.hideBanner();
  loadPlate();
});

// Keyboard alternative to clicking the map: pin the centre of a chosen country.
$("#picker").addEventListener("submit", (event) => {
  event.preventDefault();
  const country = state.countries.find((c) => c.code === $("#country-select").value);
  if (country && state.phase === "guess") {
    placeGuess({ lat: country.lat, lng: country.lon }, { pan: true });
  }
});

ui.renderRecords(loadRecords());
