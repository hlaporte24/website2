/**
 * Safe localStorage helpers. Every read and write is wrapped in try/catch:
 * private browsing, blocked cookies or a full quota must never break the game.
 */

const KEY = "pin-drop:records:v1";
const HISTORY_LENGTH = 10;

const emptyRecords = () => ({ best: 0, gamesPlayed: 0, history: [] });

// This session's records, used when localStorage can't be read or written.
let memory = null;

/** Can this browser keep records at all? */
export function storageAvailable() {
  try {
    const probe = `${KEY}:probe`;
    window.localStorage.setItem(probe, "1");
    window.localStorage.removeItem(probe);
    return true;
  } catch {
    return false;
  }
}

/**
 * Read the saved records, falling back to this session's records (or empty ones)
 * if storage is unavailable or the saved data is damaged.
 * @returns {{ best: number, gamesPlayed: number, history: {score: number, date: string}[] }}
 */
export function loadRecords() {
  try {
    const saved = JSON.parse(window.localStorage.getItem(KEY));
    if (!saved || typeof saved !== "object") return memory ?? emptyRecords();
    return {
      best: Number.isFinite(saved.best) ? saved.best : 0,
      gamesPlayed: Number.isFinite(saved.gamesPlayed) ? saved.gamesPlayed : 0,
      history: Array.isArray(saved.history)
        ? saved.history.filter((g) => Number.isFinite(g?.score)).slice(0, HISTORY_LENGTH)
        : [],
    };
  } catch {
    return memory ?? emptyRecords();
  }
}

/**
 * Log a finished game.
 * @param {number} score the game's total
 * @returns {{ records: object, isPersonalBest: boolean, saved: boolean }}
 */
export function recordGame(score) {
  const previous = loadRecords();
  const isPersonalBest = previous.gamesPlayed > 0 ? score > previous.best : score > 0;
  const records = {
    best: Math.max(previous.best, score),
    gamesPlayed: previous.gamesPlayed + 1,
    history: [{ score, date: new Date().toISOString() }, ...previous.history].slice(0, HISTORY_LENGTH),
  };

  memory = records;
  let saved = false;
  try {
    window.localStorage.setItem(KEY, JSON.stringify(records));
    saved = true;
  } catch {
    // Storage is blocked or full: the game goes on, the record just isn't kept.
  }
  return { records, isPersonalBest, saved };
}
