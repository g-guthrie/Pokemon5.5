const OBSERVATION_SCHEMA_VERSION = 'showdown-observation.v1';

export function createPlayerObservation({
  role,
  opponent,
  formatid,
  seed,
  publicState,
  request,
  requestTurn,
  requestIsFresh,
  legalActions,
  selfTeam,
  view,
}) {
  const selfSide = view.sides.self || createEmptySide();
  const opponentSide = view.sides.opponent || createEmptySide();
  const requestId = requestIsFresh ? request?.rqid ?? null : null;
  const waiting = Boolean(!request || request.wait || !requestIsFresh);
  const privateTeam = selfTeam.map(mon => createPrivateTeamSet(mon));
  const selfActive = privateTeam
    .filter(mon => mon.active)
    .sort((a, b) => Number(a.activeSlot || a.slot || 0) - Number(b.activeSlot || b.slot || 0));
  const opponentActive = getActiveKnownPokemon(opponentSide);

  return {
    schemaVersion: OBSERVATION_SCHEMA_VERSION,
    type: 'PlayerObservation',
    perspective: role,
    opponentRole: opponent,
    formatid,
    seed,
    turn: publicState.turn,
    ended: publicState.ended,
    winner: publicState.winner,
    requestId,
    requestTurn: requestIsFresh ? requestTurn : null,
    requestFresh: Boolean(requestIsFresh),
    waiting,
    source: {
      engine: 'pokemon-showdown BattleStream',
      hiddenInfoPolicy: 'official private request + role protocol + own generated team only',
      opponentHiddenTeamIncluded: false,
    },
    legalActions: legalActions.map(action => createLegalChoice(action, {turn: publicState.turn, requestId})),
    self: {
      active: selfActive[0] || null,
      activePokemon: selfActive,
      team: privateTeam,
      sideConditions: normalizeSideConditions(selfSide.sideConditions),
    },
    opponent: {
      active: opponentActive[0] || null,
      activePokemon: opponentActive,
      revealedTeam: Object.values(opponentSide.pokemon || {}).map(mon => createKnownPokemon(mon)),
      sideConditions: normalizeSideConditions(opponentSide.sideConditions),
    },
    field: normalizeField(view.field),
    history: getHistoryView(view),
  };
}

export function createSpectatorObservation({formatid, seed, publicState, view}) {
  return {
    schemaVersion: OBSERVATION_SCHEMA_VERSION,
    type: 'BattleObservation',
    perspective: 'spectator',
    formatid,
    seed,
    turn: publicState.turn,
    ended: publicState.ended,
    winner: publicState.winner,
    source: {
      engine: 'pokemon-showdown BattleStream',
      hiddenInfoPolicy: 'spectator public protocol only',
      opponentHiddenTeamIncluded: false,
    },
    legalActions: [],
    waiting: true,
    public: publicState,
    sides: {
      p1: normalizePublicSide(view.sides.p1 || createEmptySide()),
      p2: normalizePublicSide(view.sides.p2 || createEmptySide()),
    },
    field: normalizeField(view.field),
    history: getHistoryView(view),
  };
}

export function createPublicEvent(view, parts, raw, text) {
  return {
    turn: view.turn,
    tag: parts[0],
    text: text || raw,
    raw,
    args: parts.slice(1),
    meta: parseProtocolMetadata(parts.slice(1)),
  };
}

function createLegalChoice(action, context = {}) {
  return {
    schemaType: 'LegalChoice',
    turn: context.turn ?? null,
    requestId: context.requestId ?? null,
    command: action.choice,
    ...action,
  };
}

function getHistoryView(view) {
  const events = view.history || [];
  return {
    recent: events.slice(-60),
    text: events.slice(-100).map(event => event.text).filter(Boolean),
    protocol: events.slice(-100).map(event => event.raw),
  };
}

function normalizeField(field = {}) {
  return {
    weather: normalizeConditionValue(field.weather),
    terrain: normalizeConditionValue(field.terrain),
    conditions: normalizeSideConditions(field.conditions),
  };
}

export function createCondition(name, turn, args = []) {
  return {
    name,
    startedTurn: turn || 0,
    lastUpdatedTurn: turn || 0,
    layers: 1,
    args,
    meta: parseProtocolMetadata(args),
  };
}

export function touchCondition(existing, turn, args = []) {
  if (!existing) return null;
  return {
    ...existing,
    lastUpdatedTurn: turn || existing.lastUpdatedTurn || 0,
    layers: Number(existing.layers || 1) + 1,
    args,
    meta: parseProtocolMetadata(args),
  };
}

function parseProtocolMetadata(args = []) {
  const meta = {};
  for (const arg of args) {
    const match = String(arg).match(/^\[([^\]]+)\]\s*(.*)$/);
    if (!match) continue;
    const key = match[1].trim();
    const value = match[2].trim();
    if (!meta[key]) meta[key] = [];
    meta[key].push(value || true);
  }
  return meta;
}

function createPrivateTeamSet(mon) {
  return {
    schemaType: 'PrivateTeamSet',
    knowledge: 'full-own-team',
    ...mon,
  };
}

function createKnownPokemon(mon) {
  if (!mon) return null;
  return {
    schemaType: 'KnownPokemon',
    knowledge: 'observed-public-protocol',
    key: mon.key,
    ident: mon.ident,
    name: mon.name,
    species: mon.species,
    level: mon.level,
    gender: mon.gender,
    details: mon.details,
    condition: mon.condition,
    active: Boolean(mon.active),
    activeSlot: mon.activeSlot || null,
    revealed: Boolean(mon.revealed),
    fainted: Boolean(mon.fainted),
    status: mon.status || '',
    statusTurn: mon.statusTurn ?? null,
    nature: mon.nature || '',
    evs: mon.evs || null,
    ivs: mon.ivs || null,
    item: mon.item || '',
    itemLastKnown: mon.itemLastKnown || '',
    itemConsumed: Boolean(mon.itemConsumed),
    itemKnownFrom: mon.itemKnownFrom || '',
    ability: mon.ability || '',
    abilityKnownFrom: mon.abilityKnownFrom || '',
    teraType: mon.teraType || '',
    movesRevealed: mon.movesRevealed || [],
    boosts: mon.boosts || {},
    volatiles: normalizeSideConditions(mon.volatiles),
    transformedInto: mon.transformedInto || null,
    lastActivation: mon.lastActivation || null,
  };
}

function normalizePublicSide(side) {
  const activePokemon = getActiveKnownPokemon(side);
  return {
    active: activePokemon[0] || null,
    activePokemon,
    revealedTeam: Object.values(side.pokemon || {}).map(mon => createKnownPokemon(mon)),
    sideConditions: normalizeSideConditions(side.sideConditions),
  };
}

function getActiveKnownPokemon(side) {
  const pokemon = side.pokemon || {};
  const activeKeys = Object.entries(side.activeSlots || {})
    .sort(([a], [b]) => Number(a) - Number(b))
    .map(([, key]) => key)
    .filter(Boolean);
  const keys = activeKeys.length ? activeKeys : Object.values(pokemon)
    .filter(mon => mon.active)
    .sort((a, b) => Number(a.activeSlot || 0) - Number(b.activeSlot || 0))
    .map(mon => mon.key);
  if (!keys.length && side.active) keys.push(side.active);
  return keys
    .map(key => pokemon[key])
    .filter(Boolean)
    .map(mon => createKnownPokemon(mon));
}

function normalizeSideConditions(conditions = {}) {
  return Object.fromEntries(
    Object.entries(conditions).map(([name, value]) => [name, normalizeConditionValue(value, name)])
  );
}

function normalizeConditionValue(value, fallbackName = '') {
  if (!value) return null;
  if (value === true) return {name: fallbackName, startedTurn: 0, lastUpdatedTurn: 0, layers: 1, args: [], meta: {}};
  if (typeof value === 'string') return {name: value, startedTurn: 0, lastUpdatedTurn: 0, layers: 1, args: [], meta: {}};
  return value;
}

function createEmptySide() {
  return {
    active: null,
    activeSlots: {},
    pokemon: {},
    sideConditions: {},
  };
}
