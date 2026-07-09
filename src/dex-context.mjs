// Screen-tooltip equivalents from the official vendored Showdown dex.
//
// A human on the Showdown screen can hover any move button or Pokemon and
// read: move type/category/base power/accuracy/PP, species typing and base
// stats, the species' possible abilities, and (for opponents) computed stat
// estimates. The benchmark contract is screen-equivalent knowledge, so the
// prompt must carry the same facts instead of relying on model memory.

import path from 'node:path';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';

const require = createRequire(import.meta.url);
const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const showdownRoot = path.join(rootDir, 'vendor', 'pokemon-showdown');
const {Dex} = require(showdownRoot);

const STAT_KEYS = ['hp', 'atk', 'def', 'spa', 'spd', 'spe'];

export function moveCard(nameOrId) {
  const move = Dex.moves.get(toID(nameOrId));
  if (!move || !move.exists) return null;
  return stripEmpty({
    name: move.name,
    type: move.type,
    category: move.category,
    basePower: move.basePower || undefined,
    accuracy: move.accuracy === true ? 'never misses' : move.accuracy,
    maxPP: move.pp ? Math.floor(move.pp * 8 / 5) : undefined,
    priority: move.priority || undefined,
    target: move.target || undefined,
    effect: (move.shortDesc || '').slice(0, 200) || undefined,
  });
}

export function speciesCard(nameOrId) {
  const species = Dex.species.get(toID(nameOrId));
  if (!species || !species.exists) return null;
  return {
    name: species.name,
    types: species.types,
    baseStats: species.baseStats,
    // What the tooltip lists when the ability has not been revealed yet.
    possibleAbilities: Object.values(species.abilities || {}).filter(Boolean),
  };
}

export function currentTypes(speciesName, teraTypeIfTerastallized) {
  if (teraTypeIfTerastallized) return [teraTypeIfTerastallized];
  return speciesCard(speciesName)?.types || undefined;
}

// Gen 9 random battles give every set 85 EVs, 31 IVs, and a neutral nature,
// so the tooltip's "stat range" is effectively an exact number once the
// level is visible on the nameplate.
export function randomBattleStatEstimate(speciesName, level) {
  const species = Dex.species.get(toID(speciesName));
  const lvl = Number(level);
  if (!species || !species.exists || !Number.isFinite(lvl) || lvl <= 0) return null;
  const stats = {};
  for (const key of STAT_KEYS) {
    const base = species.baseStats[key];
    const core = Math.floor((2 * base + 31 + Math.floor(85 / 4)) * lvl / 100);
    stats[key] = key === 'hp'
      ? (species.name === 'Shedinja' ? 1 : core + lvl + 10)
      : core + 5;
  }
  stats.assumption = 'gen 9 random battle spread: 85 EVs, 31 IVs, neutral nature';
  return stats;
}

// The duration facts a tooltip states next to an active condition.
const STANDARD_DURATIONS = {
  raindance: '5 turns (8 with Damp Rock)',
  rain: '5 turns (8 with Damp Rock)',
  sunnyday: '5 turns (8 with Heat Rock)',
  sun: '5 turns (8 with Heat Rock)',
  sandstorm: '5 turns (8 with Smooth Rock)',
  sand: '5 turns (8 with Smooth Rock)',
  snow: '5 turns (8 with Icy Rock)',
  snowscape: '5 turns (8 with Icy Rock)',
  hail: '5 turns (8 with Icy Rock)',
  electricterrain: '5 turns (8 with Terrain Extender)',
  grassyterrain: '5 turns (8 with Terrain Extender)',
  mistyterrain: '5 turns (8 with Terrain Extender)',
  psychicterrain: '5 turns (8 with Terrain Extender)',
  trickroom: '5 turns',
  gravity: '5 turns',
  tailwind: '4 turns',
  reflect: '5 turns (8 with Light Clay)',
  lightscreen: '5 turns (8 with Light Clay)',
  auroraveil: '5 turns (8 with Light Clay)',
  safeguard: '5 turns',
  mist: '5 turns',
  luckychant: '5 turns',
  stealthrock: 'until removed',
  spikes: 'until removed',
  toxicspikes: 'until removed',
  stickyweb: 'until removed',
};

export function enrichCondition(condition, currentTurn) {
  if (!condition || typeof condition !== 'object') return condition;
  const since = Number(condition.startedTurn);
  const turn = Number(currentTurn);
  const standardDuration = STANDARD_DURATIONS[toID(condition.name)] || undefined;
  return stripEmpty({
    ...condition,
    turnsElapsed: Number.isFinite(since) && Number.isFinite(turn) ? Math.max(0, turn - since) : undefined,
    standardDuration,
  });
}

export function enrichConditionMap(conditions = {}, currentTurn) {
  return Object.fromEntries(
    Object.entries(conditions || {}).map(([key, value]) => [key, enrichCondition(value, currentTurn)])
  );
}

function toID(value = '') {
  return String(value).toLowerCase().replace(/[^a-z0-9]+/g, '');
}

function stripEmpty(value = {}) {
  return Object.fromEntries(
    Object.entries(value).filter(([, entry]) => entry !== undefined && entry !== null && entry !== '')
  );
}
