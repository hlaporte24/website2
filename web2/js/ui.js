/**
 * DOM rendering: screens, the message banner, the plate, the verdict,
 * the country card, and the summary logbook. No game logic lives here.
 */

const $ = (selector) => document.querySelector(selector);

const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)");

/** True when the player has asked for less motion. */
export const prefersReducedMotion = () => reduceMotion.matches;

/* ---------- Formatting ---------- */

const NUMERALS = ["I", "II", "III", "IV", "V", "VI", "VII", "VIII", "IX", "X"];

/** 1 → "I", 5 → "V". Plates only ever run from one to ten. */
export function toRoman(n) {
  return NUMERALS[n - 1] ?? String(n);
}

const numberFormat = new Intl.NumberFormat("en");
export const formatNumber = (n) => numberFormat.format(n);

/** 0.4 → "400 m", 12.3 → "12.3 km", 4567.8 → "4,568 km" */
export function formatDistance(km) {
  if (km < 1) return `${Math.round(km * 1000)} m`;
  if (km < 100) return `${km.toFixed(1)} km`;
  return `${formatNumber(Math.round(km))} km`;
}

/**
 * Format a coordinate pair the way a surveyor would write it.
 * @param {{lat: number, lng: number}} point
 * @returns {string} e.g. "48.86° N, 2.29° E"
 */
export function formatCoords({ lat, lng }) {
  const ns = lat >= 0 ? "N" : "S";
  const ew = lng >= 0 ? "E" : "W";
  return `${Math.abs(lat).toFixed(2)}° ${ns}, ${Math.abs(lng).toFixed(2)}° ${ew}`;
}

/** "Hindi, English and 9 more" */
function shortList(items, limit = 3) {
  if (items.length <= limit) return items.join(", ");
  return `${items.slice(0, limit).join(", ")} and ${items.length - limit} more`;
}

/* ---------- Counting up, like a typewriter ticking over ---------- */

const counters = new WeakMap();

/**
 * Tick a number up from `from` to `to` in a dozen or so jumps.
 * Shows the final value at once under prefers-reduced-motion.
 */
export function countUp(element, to, { from = 0, duration = 900 } = {}) {
  clearInterval(counters.get(element));
  if (prefersReducedMotion() || to === from) {
    element.textContent = formatNumber(to);
    return;
  }
  const ticks = 14;
  let tick = 0;
  const timer = setInterval(() => {
    tick += 1;
    const value = tick >= ticks ? to : Math.round(from + ((to - from) * tick) / ticks);
    element.textContent = formatNumber(value);
    if (tick >= ticks) clearInterval(timer);
  }, duration / ticks);
  counters.set(element, timer);
}

/* ---------- Banner and screens ---------- */

const banner = $("#banner");
const bannerText = $("#banner-text");
$("#banner-close").addEventListener("click", hideBanner);

/** Show a friendly message in the single aria-live banner. */
export function showBanner(message) {
  bannerText.textContent = message;
  banner.hidden = false;
}

export function hideBanner() {
  banner.hidden = true;
  bannerText.textContent = "";
}

/**
 * Reveal one screen and hide the rest. The masthead shows during play only.
 * @param {"start" | "round" | "summary"} name
 */
export function showScreen(name) {
  for (const screen of document.querySelectorAll(".screen")) {
    screen.hidden = screen.id !== `screen-${name}`;
  }
  $("#masthead").hidden = name === "start";
  window.scrollTo(0, 0);
}

/** Polite screen-reader announcement for results (errors go to the banner). */
export function announce(message) {
  $("#announcer").textContent = message;
}

/* ---------- Start screen ---------- */

export function renderRecords({ best, gamesPlayed }) {
  $("#best-score").textContent = gamesPlayed ? formatNumber(best) : "—";
  $("#games-played").textContent = gamesPlayed
    ? `${gamesPlayed} ${gamesPlayed === 1 ? "voyage" : "voyages"} logged`
    : "";
}

/* ---------- The round: plate and controls ---------- */

const plateFrame = $("#plate-frame");
const plateSkeleton = $("#plate-skeleton");
const plateFailure = $("#plate-failure");
const plateCaption = $("#plate-caption");
const plateCredit = $("#plate-credit");

/** Label every part of the screen with the current plate number, and reset the round's UI. */
export function setRoundLabels(round, totalRounds) {
  const numeral = toRoman(round);
  $("#tally-plate").textContent = `${numeral} of ${toRoman(totalRounds)}`;
  $("#tally-plate").closest(".tally").hidden = false;
  $("#round-heading").textContent = `Plate ${numeral}: where was this photograph taken?`;
  setCaption(round, "Unknown locality");
  plateCredit.hidden = true;
  plateCredit.replaceChildren();

  $("#pin-readout").textContent = "Not yet placed";
  $("#country-select").value = "";
  $("#guess-controls").hidden = false;
  $("#verdict").hidden = true;
  $("#dossier").hidden = true;
  $("#next-round").textContent = round === totalRounds ? "Open the logbook" : "Next plate";
}

function setCaption(round, text) {
  const number = document.createElement("span");
  number.className = "plate__number";
  number.textContent = `Plate ${toRoman(round)}:`;
  plateCaption.replaceChildren(number, ` ${text}`);
}

/** Take the current photo out of the frame and free its blob: URL. */
function removePhoto() {
  const photo = plateFrame.querySelector(".plate__photo");
  if (!photo) return;
  if (photo.src.startsWith("blob:")) URL.revokeObjectURL(photo.src);
  photo.remove();
}

/** Empty the frame and show the "Developing plate…" skeleton. */
export function showPlateLoading() {
  removePhoto();
  plateFailure.hidden = true;
  plateSkeleton.hidden = false;
}

/**
 * Mount a loaded photo in the plate. The alt text names the plate, never the place.
 * @param {HTMLImageElement} img an already-loaded image
 */
export function showPhoto(img, round) {
  removePhoto();
  img.className = "plate__photo";
  img.alt = `Mystery photo, plate ${toRoman(round)}`;
  plateSkeleton.hidden = true;
  plateFailure.hidden = true;
  plateFrame.prepend(img);
}

/** No photo could be found: offer a retry inside the plate itself. */
export function showPlateFailure() {
  removePhoto();
  plateSkeleton.hidden = true;
  plateFailure.hidden = false;
}

export function setPinReadout(point) {
  $("#pin-readout").textContent = formatCoords(point);
}

/** Fill the keyboard picker with country names. */
export function populateCountries(countries) {
  const select = $("#country-select");
  if (select.options.length > 1) return;
  select.append(...countries.map(({ code, name }) => new Option(name, code)));
  $("#picker").hidden = countries.length === 0;
}

/* ---------- The reveal ---------- */

const REMARKS = [
  [25, "Right on the mark. A surveyor's eye."],
  [250, "A fine piece of navigation."],
  [1000, "Close enough to smell the sea air."],
  [3000, "The right corner of the globe."],
  [8000, "Somewhat off course."],
  [Infinity, "A long way from the mark. The next plate awaits."],
];

/**
 * Show the distance, points and photo credit once a guess is locked in.
 * @param {{ round: number, photo: object, countryName: string, distanceKm: number, points: number }} result
 */
export function showVerdict({ round, photo, countryName, distanceKm, points }) {
  const remark = REMARKS.find(([limit]) => distanceKm < limit)[1];

  $("#guess-controls").hidden = true;
  $("#verdict").hidden = false;
  $("#verdict-distance").textContent = formatDistance(distanceKm);
  countUp($("#verdict-points"), points);
  $("#verdict-remark").textContent = remark;

  const locality =
    countryName && countryName !== photo.placeName ? `${photo.placeName}, ${countryName}` : photo.placeName;
  setCaption(round, locality);
  renderCredit(photo);

  announce(
    `${locality}. Your pin was ${formatDistance(distanceKm)} away: ${formatNumber(points)} points. ${remark}`,
  );
}

/** "“Edinburgh Castle” by Michael D Beckwith, CC0, via Wikimedia Commons" */
function renderCredit({ title, artist, license, pageUrl }) {
  if (!title) return;
  const parts = [];
  if (pageUrl) {
    const link = document.createElement("a");
    link.href = pageUrl;
    link.textContent = `“${title}”`;
    parts.push(link);
  } else {
    parts.push(`“${title}”`);
  }
  if (artist) parts.push(` by ${artist}`);
  if (license) parts.push(`, ${license}`);
  parts.push(", via Wikimedia Commons");
  plateCredit.replaceChildren(...parts);
  plateCredit.hidden = false;
}

export function setRunningTotal(total, previous) {
  countUp($("#tally-score"), total, { from: previous });
}

/* ---------- "Meet the country" ---------- */

export function showDossierLoading() {
  $("#dossier").hidden = false;
  $("#dossier-loading").hidden = false;
  $("#dossier-note").hidden = true;
  $("#passport").hidden = true;
}

/** The fact card couldn't be filled: a single quiet line instead. */
export function showDossierFailure() {
  $("#dossier-loading").hidden = true;
  $("#dossier-note").hidden = false;
  $("#passport").hidden = true;
}

/** Fill the passport page; any fact Wikidata lacks is simply left out. */
export function showCountryFacts(facts) {
  $("#passport-name").textContent = facts.name;

  const stamp = $("#passport-stamp");
  stamp.replaceChildren();
  if (facts.flagUrl) {
    const flag = new Image(108, 72);
    flag.className = "passport__flag";
    flag.alt = `Flag of ${facts.name}`;
    flag.decoding = "async";
    flag.addEventListener("error", () => flag.remove());
    flag.src = facts.flagUrl;
    stamp.append(flag);
  }

  const rows = [
    [facts.capitals.length > 1 ? "Capitals" : "Capital", facts.capitals.join(", ")],
    ["Population", facts.population ? formatNumber(facts.population) : ""],
    [facts.languages.length > 1 ? "Languages" : "Language", shortList(facts.languages)],
    [facts.currencies.length > 1 ? "Currencies" : "Currency", shortList(facts.currencies, 2)],
    ["Continent", facts.continents.join(", ")],
    ["Highest point", facts.highestPoint],
  ];

  const list = $("#passport-facts");
  list.replaceChildren();
  for (const [label, value] of rows) {
    if (!value) continue;
    const dt = document.createElement("dt");
    dt.textContent = label;
    const dd = document.createElement("dd");
    dd.textContent = value;
    if (label === "Population") dd.className = "mono";
    list.append(dt, dd);
  }

  $("#dossier-loading").hidden = true;
  $("#dossier-note").hidden = true;
  $("#passport").hidden = false;
}

/* ---------- Summary ---------- */

const RANKS = [
  [22000, "Cartographer Royal"],
  [17000, "Master Navigator"],
  [11000, "Able Seaman"],
  [5000, "Deckhand"],
  [0, "Landlubber"],
];

export const rankFor = (score) => RANKS.find(([min]) => score >= min)[1];

const dateFormat = new Intl.DateTimeFormat("en", { day: "numeric", month: "short", year: "numeric" });

function ledgerRow(result) {
  const row = document.createElement("tr");

  const plate = document.createElement("td");
  plate.className = "ledger__plate";
  plate.textContent = toRoman(result.round);

  const place = document.createElement("td");
  place.textContent = result.placeName;
  if (result.countryName && result.countryName !== result.placeName) {
    const country = document.createElement("span");
    country.className = "ledger__country";
    country.textContent = result.countryName;
    place.append(country);
  }

  const distance = document.createElement("td");
  distance.className = "ledger__num";
  distance.textContent = formatDistance(result.distanceKm);

  const points = document.createElement("td");
  points.className = "ledger__num";
  points.textContent = formatNumber(result.points);

  row.append(plate, place, distance, points);
  return row;
}

function historyItem({ score, date }) {
  const item = document.createElement("li");
  item.className = "history__item";

  const when = document.createElement("span");
  when.className = "history__date";
  const parsed = new Date(date);
  when.textContent = Number.isNaN(parsed.getTime()) ? "Earlier" : dateFormat.format(parsed);

  const points = document.createElement("span");
  points.textContent = `${formatNumber(score)} · ${rankFor(score)}`;

  item.append(when, points);
  return item;
}

/**
 * @param {{ total: number, results: object[], isPersonalBest: boolean, saved: boolean, history: object[] }} summary
 */
export function renderSummary({ total, results, isPersonalBest, saved, history }) {
  $("#summary-rank").textContent = rankFor(total);
  countUp($("#summary-score"), total, { duration: 1400 });
  $("#summary-best").hidden = !isPersonalBest;
  $("#storage-note").hidden = saved;
  $("#ledger-rows").replaceChildren(...results.map(ledgerRow));

  // Earlier voyages: the one just finished is first in the history.
  const earlier = history.slice(1);
  $("#history").hidden = earlier.length === 0;
  $("#history-list").replaceChildren(...earlier.map(historyItem));

  $("#tally-plate").closest(".tally").hidden = true; // no current plate on the logbook page
}
