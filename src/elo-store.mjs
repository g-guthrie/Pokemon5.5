import fs from 'node:fs/promises';
import path from 'node:path';
import {sanitizeText} from './agent-runtime.mjs';

export const ELO_STORE_SCHEMA_VERSION = 'showdown-elo-store.v1';

export async function loadEloStore(filePath) {
  if (!filePath) return createEloStore();
  try {
    const parsed = JSON.parse(await fs.readFile(filePath, 'utf8'));
    if (parsed.schemaVersion !== ELO_STORE_SCHEMA_VERSION || typeof parsed.ratings !== 'object') {
      return createEloStore();
    }
    return parsed;
  } catch {
    return createEloStore();
  }
}

export async function saveEloStore(filePath, store) {
  if (!filePath) return;
  const next = {
    ...store,
    schemaVersion: ELO_STORE_SCHEMA_VERSION,
    updatedAt: new Date().toISOString(),
  };
  await fs.mkdir(path.dirname(filePath), {recursive: true});
  await fs.writeFile(filePath, `${JSON.stringify(next, null, 2)}\n`);
}

export function ensureRating(store, agent) {
  const key = ratingKeyForAgent(agent);
  if (!store.ratings[key]) {
    store.ratings[key] = {
      rating: 1500,
      games: 0,
      wins: 0,
      losses: 0,
      draws: 0,
      invalidGames: 0,
      agent: {
        name: sanitizeText(agent.name),
        aliases: [sanitizeText(agent.name)].filter(Boolean),
        provider: sanitizeText(agent.provider),
        model: sanitizeText(agent.model),
        reasoningEffort: sanitizeText(agent.reasoningEffort || ''),
        ratingKey: key,
      },
    };
  } else {
    const aliases = new Set([
      store.ratings[key].agent?.name,
      ...(store.ratings[key].agent?.aliases || []),
      sanitizeText(agent.name),
    ].filter(Boolean).map(sanitizeText));
    store.ratings[key].agent = {
      ...store.ratings[key].agent,
      name: sanitizeText(store.ratings[key].agent?.name || agent.name),
      aliases: [...aliases],
      provider: sanitizeText(agent.provider),
      model: sanitizeText(agent.model),
      reasoningEffort: sanitizeText(agent.reasoningEffort || ''),
      ratingKey: key,
    };
  }
  return store.ratings[key];
}

export function updateEloPair(store, agentA, agentB, scoreA, options = {}) {
  const keyA = ratingKeyForAgent(agentA);
  const keyB = ratingKeyForAgent(agentB);
  const entryA = ensureRating(store, agentA);
  const entryB = ensureRating(store, agentB);
  if (keyA === keyB) {
    const rating = Number(entryA.rating || 1500);
    entryA.games += 1;
    entryA.draws += 1;
    if (options.validBenchmark === false) entryA.invalidGames += 1;
    store.events.push({
      at: new Date().toISOString(),
      agentA: keyA,
      agentB: keyB,
      scoreA,
      validBenchmark: options.validBenchmark !== false,
      k: Number(options.k || 32),
      selfPlay: true,
      before: {agentA: rating, agentB: rating},
      after: {agentA: rating, agentB: rating},
      battle: options.battle || null,
    });
    if (store.events.length > 1000) store.events = store.events.slice(-1000);
    return {keyA, keyB, ratingA: rating, ratingB: rating, selfPlay: true};
  }
  const ratingA = Number(entryA.rating || 1500);
  const ratingB = Number(entryB.rating || 1500);
  const k = Number(options.k || 32);
  const expectedA = expectedScore(ratingA, ratingB);
  const expectedB = 1 - expectedA;
  const scoreB = 1 - scoreA;

  entryA.rating = roundRating(ratingA + k * (scoreA - expectedA));
  entryB.rating = roundRating(ratingB + k * (scoreB - expectedB));
  entryA.games += 1;
  entryB.games += 1;
  if (scoreA === 1) {
    entryA.wins += 1;
    entryB.losses += 1;
  } else if (scoreA === 0) {
    entryA.losses += 1;
    entryB.wins += 1;
  } else {
    entryA.draws += 1;
    entryB.draws += 1;
  }
  if (options.validBenchmark === false) {
    entryA.invalidGames += 1;
    entryB.invalidGames += 1;
  }

  store.events.push({
    at: new Date().toISOString(),
    agentA: keyA,
    agentB: keyB,
    scoreA,
    validBenchmark: options.validBenchmark !== false,
    k,
    before: {agentA: ratingA, agentB: ratingB},
    after: {agentA: entryA.rating, agentB: entryB.rating},
    battle: options.battle || null,
  });
  if (store.events.length > 1000) store.events = store.events.slice(-1000);

  return {
    keyA,
    keyB,
    ratingA: entryA.rating,
    ratingB: entryB.rating,
  };
}

export function ratingKeyForAgent(agent) {
  return sanitizeText(agent.ratingKey || `${agent.provider}:${agent.model}:${agent.reasoningEffort || 'none'}`);
}

export function ratingsSnapshot(store, agents = []) {
  const result = {};
  for (const agent of agents) {
    const key = ratingKeyForAgent(agent);
    const entry = store.ratings[key];
    result[key] = entry ? {
      rating: entry.rating,
      games: entry.games,
      wins: entry.wins,
      losses: entry.losses,
      draws: entry.draws,
      invalidGames: entry.invalidGames,
      agent: entry.agent,
    } : null;
  }
  return result;
}

function createEloStore() {
  return {
    schemaVersion: ELO_STORE_SCHEMA_VERSION,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ratings: {},
    events: [],
  };
}

function expectedScore(ratingA, ratingB) {
  return 1 / (1 + Math.pow(10, (ratingB - ratingA) / 400));
}

function roundRating(value) {
  return Number(value.toFixed(2));
}
