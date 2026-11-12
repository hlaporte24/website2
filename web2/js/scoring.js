/**
 * Scoring: how far was the guess, and how many points is that worth?
 * Pure functions with no DOM access, so they are easy to read and to test.
 */

const EARTH_RADIUS_KM = 6371; // mean radius
export const MAX_POINTS = 5000; // per plate
const FALLOFF_KM = 1500; // the distance at which a guess keeps about 37% (1/e) of the points

const toRadians = (degrees) => (degrees * Math.PI) / 180;

/**
 * Great-circle distance between two points, using the haversine formula.
 * @param {{lat: number, lon: number}} a
 * @param {{lat: number, lon: number}} b
 * @returns {number} kilometres
 */
export function haversineKm(a, b) {
  const dLat = toRadians(b.lat - a.lat);
  const dLon = toRadians(b.lon - a.lon);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRadians(a.lat)) * Math.cos(toRadians(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(h)));
}

/**
 * Points for a guess: 5000 at the exact spot, decaying smoothly with distance.
 *   0 km → 5000    500 km → 3583    1,500 km → 1839    5,000 km → 178    10,000 km → 6
 * @param {number} distanceKm
 * @returns {number} a whole number from 0 to 5000
 */
export function scoreForDistance(distanceKm) {
  return Math.round(MAX_POINTS * Math.exp(-distanceKm / FALLOFF_KM));
}
