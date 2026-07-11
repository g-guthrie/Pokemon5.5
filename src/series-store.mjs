import fs from 'node:fs/promises';
import path from 'node:path';

// The running record between two exact model picks. Games accumulate
// piecemeal: a single match, then five more, then one — every finished game
// between the same P1 spec and P2 spec lands in the same series, whether it
// came from a one-off start or a multi-game run. Switching either model
// starts (or resumes) a different series; sides are not interchangeable
// because the arena keeps models pinned to their pads.
const SERIES_SCHEMA_VERSION = 'showdown-series-store.v1';
const MAX_GAMES_PER_SERIES = 500;
const MAX_SERIES = 400;

export function seriesKeyFor(sessionId, agentP1, agentP2) {
  return `${sessionId || 'local'}::${agentP1}::${agentP2}`;
}

export async function loadSeriesStore(storePath) {
  try {
    const store = JSON.parse(await fs.readFile(storePath, 'utf8'));
    if (store?.schemaVersion === SERIES_SCHEMA_VERSION && store.series && typeof store.series === 'object') {
      return store;
    }
  } catch {
    // missing or unreadable store starts fresh
  }
  return {schemaVersion: SERIES_SCHEMA_VERSION, updatedAt: '', series: {}};
}

export async function saveSeriesStore(storePath, store) {
  store.updatedAt = new Date().toISOString();
  pruneSeries(store);
  await fs.mkdir(path.dirname(storePath), {recursive: true});
  const tempPath = `${storePath}.tmp-${process.pid}`;
  await fs.writeFile(tempPath, `${JSON.stringify(store, null, 2)}\n`);
  await fs.rename(tempPath, storePath);
}

export function ensureSeries(store, {sessionId = '', agentP1, agentP2}) {
  const key = seriesKeyFor(sessionId, agentP1, agentP2);
  if (!store.series[key]) {
    store.series[key] = {
      key,
      sessionId: sessionId || '',
      agentP1,
      agentP2,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      totals: {games: 0, p1Wins: 0, p2Wins: 0, draws: 0, invalidGames: 0},
      games: [],
    };
  }
  return store.series[key];
}

// Roll one finished game into its series. Aborted games don't count — a
// viewer stopping a match mid-way should not pollute the record.
export function recordSeriesGame(store, {sessionId = '', agentP1, agentP2}, game) {
  const series = ensureSeries(store, {sessionId, agentP1, agentP2});
  if (series.games.some(existing => existing.gameId === game.gameId)) return series;
  series.games.push(game);
  if (series.games.length > MAX_GAMES_PER_SERIES) {
    series.games = series.games.slice(-MAX_GAMES_PER_SERIES);
  }
  series.totals.games += 1;
  if (game.winnerRole === 'p1') series.totals.p1Wins += 1;
  else if (game.winnerRole === 'p2') series.totals.p2Wins += 1;
  else series.totals.draws += 1;
  if (game.valid === false) series.totals.invalidGames += 1;
  series.updatedAt = new Date().toISOString();
  return series;
}

export function resetSeries(store, {sessionId = '', agentP1, agentP2}) {
  delete store.series[seriesKeyFor(sessionId, agentP1, agentP2)];
}

export function getSeries(store, {sessionId = '', agentP1, agentP2}) {
  return store.series[seriesKeyFor(sessionId, agentP1, agentP2)] || null;
}

function pruneSeries(store) {
  const keys = Object.keys(store.series);
  if (keys.length <= MAX_SERIES) return;
  const byAge = keys.sort((a, b) =>
    String(store.series[a].updatedAt || '').localeCompare(String(store.series[b].updatedAt || '')));
  for (const key of byAge.slice(0, keys.length - MAX_SERIES)) {
    delete store.series[key];
  }
}
