/**
 * Network wrappers: Wikimedia Commons photo search and Wikidata country facts.
 * Every request has a timeout, and every failure becomes an ApiError with a `kind`
 * the UI can turn into a friendly message.
 */

const COMMONS_API = "https://commons.wikimedia.org/w/api.php";
const TIMEOUT_MS = 8000;
const SEARCH_RADIUS_M = 10000; // Commons caps geosearch at 10 km
const MIN_WIDTH = 1000;
const MAX_ASPECT = 2; // wider panoramas would be cropped to a blurry strip in the 4:3 plate

/**
 * Words in a file title that usually mean the photo is not a scene: signs, maps,
 * logos, diagrams, interiors, and close-ups of wildlife, flowers or people.
 * Matched as whole words, case-insensitive ("bird" spares "bird's eye view").
 */
const UNWANTED_TITLE = new RegExp(
  "\\b(" +
    [
      "sign", "signs", "signage", "plaque", "inscription", "poster", "notice", "banner",
      "map", "maps", "plan", "chart", "diagram", "logo", "emblem", "coat of arms", "flag",
      "interior", "interiors", "inside", "indoor", "intérieur", "innen", "interno",
      "screenshot", "document", "ticket", "menu", "label",
      "portrait", "selfie", "macro", "close up", "closeup", "detail",
      "owl", "bird(?!['’]?s? eye)", "birds", "insect", "butterfly", "moth", "bee", "spider", "flower", "flowers",
      "food", "dish", "coin", "stamp",
    ].join("|") +
    ")\\b",
  "i",
);

export class ApiError extends Error {
  /**
   * @param {"timeout" | "network" | "rate-limited" | "http" | "bad-response"} kind
   * @param {string} message
   */
  constructor(kind, message) {
    super(message);
    this.name = "ApiError";
    this.kind = kind;
  }
}

/**
 * fetch() that gives up after `timeoutMs` and normalises every failure into an ApiError.
 * @returns {Promise<any>} the parsed JSON body
 */
export async function fetchJson(url, { timeoutMs = TIMEOUT_MS, headers } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let response;
  try {
    response = await fetch(url, { signal: controller.signal, headers });
  } catch (error) {
    throw error.name === "AbortError"
      ? new ApiError("timeout", `No answer within ${timeoutMs / 1000} seconds`)
      : new ApiError("network", "The request couldn't reach the server");
  } finally {
    clearTimeout(timer);
  }

  if (response.status === 429) {
    throw new ApiError("rate-limited", "Too many requests; the server asked us to slow down");
  }
  if (!response.ok) {
    throw new ApiError("http", `The server answered ${response.status}`);
  }

  try {
    return await response.json();
  } catch {
    throw new ApiError("bad-response", "The server's answer wasn't valid JSON");
  }
}

/** Build the Commons geosearch URL for files within 10 km of a point. */
function commonsSearchUrl(lat, lon) {
  const params = new URLSearchParams({
    action: "query",
    generator: "geosearch",
    ggscoord: `${lat}|${lon}`,
    ggsradius: String(SEARCH_RADIUS_M),
    ggsnamespace: "6", // the File: namespace
    ggslimit: "50",
    prop: "imageinfo|coordinates",
    iiprop: "url|size|mime|extmetadata",
    iiextmetadatafilter: "Artist|LicenseShortName",
    iiurlwidth: "1280",
    format: "json",
    formatversion: "2",
    origin: "*", // anonymous CORS
  });
  return `${COMMONS_API}?${params}`;
}

/**
 * Is this Commons page a usable mystery photo?
 * Landscape JPEG no wider than 2:1, at least 1000px wide in the ORIGINAL (the API's
 * thumbwidth reports 1280 even when the original is smaller), and no giveaway title.
 */
export function isUsablePhoto(page) {
  const info = page?.imageinfo?.[0];
  if (!info) return false;
  return (
    info.mime === "image/jpeg" &&
    info.width >= MIN_WIDTH &&
    info.width > info.height &&
    info.width / info.height <= MAX_ASPECT &&
    !UNWANTED_TITLE.test(page.title.replace(/^File:/, "").replace(/[_\-.()]/g, " "))
  );
}

/** Strip the HTML Commons puts in metadata ("<a href=…>Jane Doe</a>") down to text. */
function plainText(html) {
  if (!html) return "";
  return new DOMParser().parseFromString(html, "text/html").body.textContent.trim();
}

/**
 * Turn a Commons page into the photo object the game uses.
 * The true location is the photo's own coordinates when Commons has them,
 * otherwise the place we searched around.
 */
function toPhoto(page, place) {
  const info = page.imageinfo[0];
  const coords = page.coordinates?.[0];
  const meta = info.extmetadata ?? {};

  return {
    src: info.thumburl || info.url,
    width: info.width,
    height: info.height,
    lat: coords?.lat ?? place.lat,
    lon: coords?.lon ?? place.lon,
    countryCode: place.countryCode,
    placeName: place.name,
    // Only shown after the guess: titles and credits can give the location away.
    title: page.title.replace(/^File:/, "").replace(/\.jpe?g$/i, ""),
    pageUrl: info.descriptionurl,
    artist: plainText(meta.Artist?.value),
    license: plainText(meta.LicenseShortName?.value),
  };
}

/**
 * All usable photos near a place, shuffled.
 * @returns {Promise<object[]>} possibly empty
 * @throws {ApiError} when Commons can't be reached
 */
export async function findPhotos(place) {
  const data = await fetchJson(commonsSearchUrl(place.lat, place.lon));
  if (data?.error) {
    throw new ApiError("bad-response", data.error.info ?? "Commons returned an error");
  }

  const pages = data?.query?.pages ?? []; // no "query" at all when nothing is nearby
  return shuffle(pages.filter(isUsablePhoto)).map((page) => toPhoto(page, place));
}

/** Fisher–Yates shuffle, returning a new array. */
export function shuffle(items) {
  const copy = [...items];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

/**
 * Download a photo and mount it from an anonymous blob: URL, so the file name
 * (which often names the place) never appears in the page. Wikimedia's image
 * servers allow CORS. If the blob route fails at the network level, fall back
 * to loading the URL directly so the game still works.
 * @returns {Promise<HTMLImageElement>} a fully decoded image
 */
export async function preloadImage(src, timeoutMs = TIMEOUT_MS * 2) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let blob;
  try {
    const response = await fetch(src, { signal: controller.signal });
    if (!response.ok) throw new ApiError("http", `The photograph answered ${response.status}`);
    blob = await response.blob();
  } catch (error) {
    if (error instanceof ApiError) throw error;
    if (error.name === "AbortError") {
      throw new ApiError("timeout", "The photograph took too long to arrive");
    }
    return loadImage(src, timeoutMs); // CORS or network trouble: try a plain <img>
  } finally {
    clearTimeout(timer);
  }

  if (!blob.type.startsWith("image/")) {
    throw new ApiError("bad-response", "The file wasn't an image");
  }

  const objectUrl = URL.createObjectURL(blob);
  try {
    return await loadImage(objectUrl, timeoutMs);
  } catch (error) {
    URL.revokeObjectURL(objectUrl);
    throw error;
  }
}

/** Resolve once an <img> has loaded and decoded `src`. */
function loadImage(src, timeoutMs) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const timer = setTimeout(() => {
      img.removeAttribute("src");
      reject(new ApiError("timeout", "The photograph took too long to arrive"));
    }, timeoutMs);

    img.addEventListener("load", () => {
      clearTimeout(timer);
      resolve(img);
    });
    img.addEventListener("error", () => {
      clearTimeout(timer);
      reject(new ApiError("network", "The photograph couldn't be loaded"));
    });
    img.decoding = "async";
    img.src = src;
  });
}

/* ---------- Wikidata: "Meet the country" facts ---------- */

const WIKIDATA_SPARQL = "https://query.wikidata.org/sparql";

// Wikidata's labels for a few codes read oddly on a card.
const DISPLAY_NAMES = { AQ: "Antarctica", CN: "China", NL: "Netherlands" };

const factsCache = new Map();

/**
 * One row per country code. Multi-valued facts (capitals, languages…) are joined
 * with "|" so a country with three capitals still comes back as a single row.
 */
function countryQuery(code) {
  return `
SELECT ?code (SAMPLE(?name) AS ?country) (SAMPLE(?flagFile) AS ?flag) (MAX(?pop) AS ?population)
  (GROUP_CONCAT(DISTINCT ?capName; separator="|") AS ?capitals)
  (GROUP_CONCAT(DISTINCT ?langName; separator="|") AS ?languages)
  (GROUP_CONCAT(DISTINCT ?curName; separator="|") AS ?currencies)
  (GROUP_CONCAT(DISTINCT ?contName; separator="|") AS ?continents)
  (SAMPLE(?peakName) AS ?highestPoint)
WHERE {
  VALUES ?code { "${code}" }
  ?c wdt:P297 ?code; rdfs:label ?name. FILTER(LANG(?name) = "en")
  FILTER NOT EXISTS { ?c wdt:P576 ?dissolved }
  OPTIONAL { ?c wdt:P41 ?flagFile }
  OPTIONAL { ?c wdt:P1082 ?pop }
  OPTIONAL { ?c wdt:P36 ?cap. ?cap rdfs:label ?capName. FILTER(LANG(?capName) = "en") }
  OPTIONAL { ?c wdt:P37 ?lang. ?lang rdfs:label ?langName. FILTER(LANG(?langName) = "en") }
  OPTIONAL { ?c wdt:P38 ?cur. ?cur rdfs:label ?curName. FILTER(LANG(?curName) = "en") }
  OPTIONAL { ?c wdt:P30 ?cont. ?cont rdfs:label ?contName. FILTER(LANG(?contName) = "en") }
  OPTIONAL { ?c wdt:P610 ?peak. ?peak rdfs:label ?peakName. FILTER(LANG(?peakName) = "en") }
}
GROUP BY ?code`;
}

const splitList = (binding) => (binding?.value ? binding.value.split("|").filter(Boolean) : []);

/**
 * Facts about a country for the reveal card. Results are cached per code.
 * @param {string} code ISO 3166-1 alpha-2, e.g. "FR"
 * @returns {Promise<{ code: string, name: string, flagUrl: string, population: number|null,
 *   capitals: string[], languages: string[], currencies: string[], continents: string[],
 *   highestPoint: string }>}
 * @throws {ApiError}
 */
export function fetchCountryFacts(code) {
  if (!/^[A-Z]{2}$/.test(code)) {
    return Promise.reject(new ApiError("bad-response", "Not a country code"));
  }
  if (!factsCache.has(code)) {
    const request = loadCountryFacts(code);
    factsCache.set(code, request);
    request.catch(() => factsCache.delete(code)); // let a later reveal try again
  }
  return factsCache.get(code);
}

async function loadCountryFacts(code) {
  const params = new URLSearchParams({ query: countryQuery(code), format: "json" });
  const data = await fetchJson(`${WIKIDATA_SPARQL}?${params}`);
  const row = data?.results?.bindings?.[0];
  if (!row) throw new ApiError("bad-response", `Wikidata has no country with code ${code}`);

  const population = Number(row.population?.value);
  const flagFile = row.flag?.value ?? "";

  return {
    code,
    name: DISPLAY_NAMES[code] ?? row.country?.value ?? code,
    // Special:FilePath redirects to a PNG rendering of the SVG flag at this width.
    flagUrl: flagFile ? `${flagFile.replace(/^http:/, "https:")}?width=240` : "",
    population: Number.isFinite(population) && population > 0 ? population : null,
    capitals: splitList(row.capitals),
    languages: splitList(row.languages),
    currencies: splitList(row.currencies),
    continents: splitList(row.continents),
    highestPoint: row.highestPoint?.value ?? "",
  };
}
