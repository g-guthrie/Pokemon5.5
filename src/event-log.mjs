import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {sanitizeText} from './agent-runtime.mjs';

const EVENT_SCHEMA_VERSION = 'showdown-event-log.v1';
const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const artifactsDir = path.join(rootDir, 'artifacts');

export function eventPathForArtifact(outputPath = '') {
  const target = String(outputPath || '').trim();
  if (!target) return '';
  return target.endsWith('.json') ? target.replace(/\.json$/u, '.events.jsonl') : `${target}.events.jsonl`;
}

export function artifactHrefForPath(filePath = '') {
  if (!filePath) return '';
  const relative = path.relative(artifactsDir, path.resolve(filePath));
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) return '';
  return `/artifacts/${relative.split(path.sep).map(encodeURIComponent).join('/')}`;
}

export async function writeJsonl(outputPath, events = []) {
  if (!outputPath) return;
  await fs.mkdir(path.dirname(outputPath), {recursive: true});
  const lines = events.map(event => JSON.stringify(sanitizeJson(event)));
  await fs.writeFile(outputPath, `${lines.join('\n')}\n`);
}

export function eventsFromMatchArtifact(match = {}) {
  const rawEvents = [];
  let order = 0;
  const push = (type, at, payload = {}) => {
    rawEvents.push(sanitizeJson({
      schemaVersion: EVENT_SCHEMA_VERSION,
      battleId: match.battleId || '',
      type,
      at: at || match.startedAt || new Date(0).toISOString(),
      ...payload,
      _order: order,
    }));
    order += 1;
  };

  push('match_start', match.startedAt, {
    matchSchemaVersion: match.schemaVersion || '',
    formatid: match.formatid || '',
    seed: Array.isArray(match.seed) ? match.seed : null,
    serverOrigin: match.serverOrigin || '',
    serverUrl: match.serverUrl || '',
    maxTurns: match.maxTurns ?? null,
    moveDelayMs: match.moveDelayMs ?? null,
    allowFallback: Boolean(match.allowFallback),
    agents: match.agents || {},
    teamSnapshots: summarizeTeamSnapshots(match.teamSnapshots),
    eventsPath: match.eventsPath || '',
    eventsHref: match.eventsHref || '',
  });

  for (const [role, hello] of Object.entries(match.hello || {})) {
    push('hello', match.startedAt, {role, hello});
  }

  for (const [protocolIndex, protocol] of (match.protocol || []).entries()) {
    push('protocol', protocol.at || match.startedAt, {
      protocolIndex,
      role: protocol.role || '',
      lineCount: String(protocol.chunk || '').split('\n').filter(Boolean).length,
      chunk: protocol.chunk || '',
    });
  }

  for (const [fallbackIndex, record] of (match.observations || []).entries()) {
    const observation = record.observation || {};
    const legalActions = record.legalActions || observation.legalActions || [];
    push('observation', record.at || match.startedAt, {
      observationIndex: record.index ?? fallbackIndex,
      role: record.role || observation.perspective || '',
      turn: record.turn ?? observation.turn ?? null,
      requestId: record.requestId ?? observation.requestId ?? null,
      requestFresh: Boolean(observation.requestFresh),
      waiting: Boolean(observation.waiting),
      ended: Boolean(observation.ended),
      winner: observation.winner || '',
      active: activeNames(observation.self),
      opponentActive: activeNames(observation.opponent),
      ownTeam: (observation.self?.team || []).map(summarizeOwnPokemon),
      opponentRevealed: (observation.opponent?.revealedTeam || []).map(summarizeKnownPokemon),
      field: observation.field || {},
      legalActionCount: legalActions.length,
      legalChoices: legalActions.map(summarizeLegalAction),
      source: {
        opponentHiddenTeamIncluded: Boolean(observation.source?.opponentHiddenTeamIncluded),
        protocolRole: observation.source?.protocolRole || '',
        requestFresh: Boolean(observation.source?.requestFresh ?? observation.requestFresh),
      },
    });
  }

  for (const [callIndex, call] of (match.modelCalls || []).entries()) {
    push('model_call', call.at || match.startedAt, summarizeModelCall(call, callIndex));
  }

  for (const [actionIndex, action] of (match.actions || []).entries()) {
    push('action', action.at || match.startedAt, {
      actionIndex,
      observationIndex: action.observationIndex ?? null,
      callIndex: action.callIndex ?? null,
      role: action.role || '',
      turn: action.turn ?? null,
      requestId: action.requestId ?? null,
      choice: action.choice || action.action?.choice || '',
      action: summarizeLegalAction(action.action || action),
    });
  }

  push('match_end', match.finishedAt || match.result?.at || match.startedAt, {
    finishedAt: match.finishedAt || '',
    result: match.result || null,
    validBenchmark: Boolean(match.validBenchmark),
    apiErrorCount: Number(match.apiErrorCount || 0),
    fallbackCount: Number(match.fallbackCount || 0),
    invalidChoiceCount: Number(match.invalidChoiceCount || 0),
    actionCount: (match.actions || []).length,
    observationCount: (match.observations || []).length,
    modelCallCount: (match.modelCalls || []).length,
    usage: match.usage || null,
  });

  const start = rawEvents.filter(event => event.type === 'match_start');
  const end = rawEvents.filter(event => event.type === 'match_end');
  const middle = rawEvents
    .filter(event => event.type !== 'match_start' && event.type !== 'match_end')
    .sort((a, b) => timestamp(a.at) - timestamp(b.at) || a._order - b._order);

  return [...start, ...middle, ...end].map((event, eventIndex) => {
    const {_order, ...cleanEvent} = event;
    return {eventIndex, ...cleanEvent};
  });
}

function summarizeModelCall(call = {}, callIndex) {
  const prompt = String(call.prompt || '');
  const rawText = String(call.rawText || '');
  return {
    callIndex,
    observationIndex: call.observationIndex ?? null,
    role: call.role || '',
    provider: call.provider || '',
    agent: call.agent || '',
    model: call.model || '',
    reasoningEffort: call.reasoningEffort || '',
    responseId: call.responseId || '',
    responseModel: call.responseModel || '',
    promptSchemaVersion: call.promptSchemaVersion || '',
    responseSchemaVersion: call.responseSchemaVersion || '',
    requestedChoice: call.requestedChoice || '',
    choice: call.choice || '',
    valid: Boolean(call.valid),
    fallback: Boolean(call.fallback),
    error: call.error || '',
    reason: call.reason || '',
    analysis: call.analysis || null,
    analysisComplete: typeof call.analysisComplete === 'boolean' ? call.analysisComplete : null,
    analysisMissing: call.analysisMissing || undefined,
    usage: call.usage || null,
    openrouterMetadata: call.openrouterMetadata || null,
    scores: call.scores || undefined,
    promptRef: prompt ? {availableInJsonArtifact: true, chars: prompt.length, sha256: digest(prompt)} : null,
    rawTextRef: rawText ? {availableInJsonArtifact: true, chars: rawText.length, sha256: digest(rawText)} : null,
    rawText: rawText ? sanitizeText(rawText).slice(0, 2000) : '',
  };
}

function summarizeTeamSnapshots(teamSnapshots = {}) {
  return {
    schemaVersion: teamSnapshots.schemaVersion || '',
    p1: summarizeTeamSnapshot(teamSnapshots.p1),
    p2: summarizeTeamSnapshot(teamSnapshots.p2),
  };
}

function summarizeTeamSnapshot(snapshot = null) {
  if (!snapshot) return null;
  return {
    role: snapshot.role || '',
    capturedAt: snapshot.capturedAt || '',
    observationIndex: snapshot.observationIndex ?? null,
    turn: snapshot.turn ?? null,
    requestId: snapshot.requestId ?? null,
    teamSize: snapshot.teamSize ?? snapshot.team?.length ?? 0,
    teamHash: snapshot.teamHash || '',
    species: (snapshot.team || []).map(mon => mon.species || mon.name || ''),
  };
}

function summarizeLegalAction(action = {}) {
  const summary = {
    choice: action.choice || action.command || '',
    command: action.command || action.choice || '',
    type: action.type || '',
    label: action.label || action.move || action.pokemon || action.choice || action.command || '',
    activeSlot: action.activeSlot ?? null,
    slot: action.slot ?? null,
    move: action.move || '',
    id: action.id || '',
    pp: action.pp ?? null,
    maxpp: action.maxpp ?? null,
    target: action.target || '',
    targetLoc: action.targetLoc ?? null,
    targetSlot: action.targetSlot ?? null,
    allyTargetSlot: action.allyTargetSlot ?? null,
    pokemon: action.pokemon || '',
    condition: action.condition || '',
    hasSwitch: Boolean(action.hasSwitch),
    hasTerastallize: Boolean(action.hasTerastallize),
  };
  if (Array.isArray(action.choices)) summary.parts = action.choices.map(summarizeLegalAction);
  return summary;
}

function summarizeOwnPokemon(mon = {}) {
  return {
    slot: mon.slot ?? null,
    activeSlot: mon.activeSlot ?? null,
    name: mon.name || '',
    species: mon.species || '',
    level: mon.level ?? null,
    gender: mon.gender || '',
    condition: mon.condition || '',
    active: Boolean(mon.active),
    item: mon.item || '',
    ability: mon.ability || '',
    nature: mon.nature || '',
    evs: mon.evs || undefined,
    ivs: mon.ivs || undefined,
    moves: mon.moves || [],
    teraType: mon.teraType || '',
    stats: mon.stats || undefined,
    boosts: mon.boosts || undefined,
    terastallized: mon.terastallized || undefined,
  };
}

function summarizeKnownPokemon(mon = {}) {
  return {
    key: mon.key || '',
    ident: mon.ident || '',
    name: mon.name || '',
    species: mon.species || '',
    level: mon.level ?? null,
    gender: mon.gender || '',
    condition: mon.condition || '',
    active: Boolean(mon.active),
    activeSlot: mon.activeSlot ?? null,
    revealed: Boolean(mon.revealed),
    fainted: Boolean(mon.fainted),
    status: mon.status || undefined,
    item: mon.item || undefined,
    itemLastKnown: mon.itemLastKnown || undefined,
    itemConsumed: mon.itemConsumed || undefined,
    itemKnownFrom: mon.itemKnownFrom || undefined,
    ability: mon.ability || undefined,
    abilityKnownFrom: mon.abilityKnownFrom || undefined,
    teraType: mon.teraType || undefined,
    movesRevealed: mon.movesRevealed?.length ? mon.movesRevealed : undefined,
    boosts: Object.keys(mon.boosts || {}).length ? mon.boosts : undefined,
    volatiles: Object.keys(mon.volatiles || {}).length ? mon.volatiles : undefined,
    transformedInto: mon.transformedInto || undefined,
    lastActivation: mon.lastActivation || undefined,
  };
}

function activeNames(side = {}) {
  const names = (side.activePokemon || []).map(mon => mon.name || mon.species).filter(Boolean);
  return names.length ? names.join(' + ') : side.active?.name || side.active?.species || '';
}

function digest(text = '') {
  return crypto.createHash('sha256').update(String(text)).digest('hex');
}

function timestamp(value = '') {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function sanitizeJson(value) {
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') return sanitizeText(value);
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (Array.isArray(value)) return value.map(sanitizeJson);
  if (typeof value === 'object') {
    const clean = {};
    for (const [key, child] of Object.entries(value)) {
      if (child !== undefined) clean[key] = sanitizeJson(child);
    }
    return clean;
  }
  return String(value);
}
