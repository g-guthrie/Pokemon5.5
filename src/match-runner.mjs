import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import path from 'node:path';
import {WebSocket} from 'ws';
import {
  chooseWithAgent,
  createAgent,
  firstSafeAction,
  publicAgentMetadata,
  sanitizeText,
} from './agent-runtime.mjs';
import {
  artifactHrefForPath,
  eventPathForArtifact,
  eventsFromMatchArtifact,
  writeJsonl,
} from './event-log.mjs';
import {summarizeUsage} from './usage-summary.mjs';

const DEFAULT_FORMAT = 'gen9randomdoublesbattle';
const DEFAULT_BATTLE_ID = 'local';

export async function runWebSocketMatch(options = {}) {
  const serverOrigin = options.serverOrigin || process.env.SERVER_ORIGIN || 'http://localhost:3107';
  const battleId = normalizeBattleId(options.battleId || process.env.BATTLE_ID || makeBattleId());
  const serverUrl = options.serverUrl || process.env.WS_URL || `${serverOrigin.replace(/^http/, 'ws')}/ws`;
  const maxTurns = Number(options.maxTurns ?? process.env.MAX_TURNS ?? 40);
  const moveDelayMs = Number(options.moveDelayMs ?? process.env.MOVE_DELAY_MS ?? 200);
  const allowFallback = Boolean(options.allowFallback ?? process.env.ALLOW_FALLBACK === '1');
  const formatid = options.formatid || process.env.FORMATID || DEFAULT_FORMAT;
  const seed = options.seed || parseSeed(process.env.SEED);
  const outputPath = options.outputPath || '';
  const signal = options.signal || null;
  const waitIfPaused = typeof options.waitIfPaused === 'function' ? options.waitIfPaused : null;
  const onObservation = typeof options.onObservation === 'function' ? options.onObservation : null;
  const onModelCall = typeof options.onModelCall === 'function' ? options.onModelCall : null;
  const onAction = typeof options.onAction === 'function' ? options.onAction : null;
  // Floor high enough that paid models thinking for tens of seconds per
  // decision never hit the match timeout with default settings.
  const timeoutMs = Number(options.timeoutMs ?? Math.max(120000, maxTurns * Math.max(moveDelayMs, 50) * 8));
  const modelTimeoutMs = Number(options.modelTimeoutMs ?? process.env.MODEL_TIMEOUT_MS ?? Math.min(timeoutMs, 240000));
  const providerKeys = options.providerKeys || {};
  const agents = {
    p1: await normalizeAgent(options.agents?.p1 || options.agentP1 || process.env.AGENT_P1 || 'standin', providerKeys),
    p2: await normalizeAgent(options.agents?.p2 || options.agentP2 || process.env.AGENT_P2 || 'standin', providerKeys),
  };
  // The native client displays these as the trainer names: the chosen models,
  // not anonymous benchmark seats. Mirror matches get a seat suffix.
  const playerNames = {
    p1: playerDisplayName(agents.p1),
    p2: playerDisplayName(agents.p2),
  };
  if (playerNames.p1 === playerNames.p2) {
    playerNames.p1 = `${playerNames.p1} P1`.slice(0, 22);
    playerNames.p2 = `${playerNames.p2} P2`.slice(0, 22);
  }

  if (options.reset !== false) {
    await resetBattle({serverOrigin, battleId, formatid, seed, playerNames});
  }

  // Human-controlled sides: the runner never chooses for them. Their choices
  // arrive straight from the player's browser socket to the battle session,
  // and the runner records them off the resulting 'choice' broadcast.
  const humanRoles = ['p1', 'p2'].filter(role => agents[role].provider === 'human');

  const run = {
    schemaVersion: 'showdown-match-artifact.v1',
    startedAt: new Date().toISOString(),
    serverOrigin,
    serverUrl,
    // Which visitor session produced this match (empty = local/CLI/legacy).
    sessionId: sanitizeText(String(options.sessionId || '')).slice(0, 24),
    battleId,
    formatid,
    humanRoles,
    seed: seed || null,
    maxTurns,
    moveDelayMs,
    modelTimeoutMs,
    allowFallback,
    agents: {
      p1: publicAgentMetadata(agents.p1),
      p2: publicAgentMetadata(agents.p2),
    },
    playerNames,
    validBenchmark: true,
    apiErrorCount: 0,
    fallbackCount: 0,
    invalidChoiceCount: 0,
    actions: [],
    observations: [],
    modelCalls: [],
    teamSnapshots: {
      schemaVersion: 'showdown-team-snapshots.v1',
      source: 'first private PlayerObservation.self.team captured for each role',
      hiddenInfoPolicy: 'artifact-only full teams; model prompts receive only their own team and revealed opponent info',
      p1: null,
      p2: null,
    },
    usage: summarizeUsage([]),
    protocol: [],
    hello: {},
    finalState: {},
    result: null,
  };

  const clients = {
    p1: connect(serverUrl, 'p1', battleId),
    p2: connect(serverUrl, 'p2', battleId),
    spectator: connect(serverUrl, 'spectator', battleId),
  };
  let finished = false;
  let finishResolve;
  let finishReject;
  const finishedPromise = new Promise((resolve, reject) => {
    finishResolve = resolve;
    finishReject = reject;
  });
  // The match clock never runs while the viewer has the run paused: a single
  // monitor loop (not the per-client waiters, which would double-count)
  // measures each pause and pushes the deadline out by exactly that long.
  let matchDeadline = Date.now() + timeoutMs;
  let timeout = setTimeout(onMatchTimeout, timeoutMs);
  function onMatchTimeout() {
    const remaining = matchDeadline - Date.now();
    if (remaining > 250) {
      timeout = setTimeout(onMatchTimeout, remaining);
      return;
    }
    void finish({winner: null, turn: latestTurn(run), reason: `TIMEOUT_MS=${timeoutMs}`});
  }
  if (waitIfPaused) {
    void (async () => {
      while (!finished) {
        const pausedAt = Date.now();
        await waitIfPaused({role: 'match-clock'});
        matchDeadline += Date.now() - pausedAt;
        await new Promise(resolve => setTimeout(resolve, 400));
      }
    })();
  }
  if (signal) {
    if (signal.aborted) {
      setTimeout(() => abortRun(), 0);
    } else {
      signal.addEventListener('abort', abortRun, {once: true});
    }
  }

  for (const client of Object.values(clients)) {
    client.ws.on('message', data => {
      let message;
      try {
        message = JSON.parse(String(data));
      } catch (error) {
        void finish({winner: null, turn: latestTurn(run), reason: 'BAD_WEBSOCKET_JSON', error: sanitizeText(error.message)});
        return;
      }
      if (message.type === 'hello') run.hello[client.role] = sanitizeMessage(message);
      if (message.type === 'hello') {
        if (message.battleId) run.battleId = message.battleId;
        if (!run.seed && Array.isArray(message.seed)) run.seed = message.seed;
        if (message.formatid) run.formatid = message.formatid;
      }
      if (message.type === 'protocol') {
        run.protocol.push({
          at: new Date().toISOString(),
          role: message.role,
          chunk: sanitizeText(message.chunk || ''),
        });
      }
      if (message.type === 'state') {
        run.finalState[client.role] = summarizeState(message.state);
        if (client.role === 'p1' || client.role === 'p2') {
          void handleState(client, message.state).catch(error => {
            void finish({winner: null, turn: message.state?.turn ?? latestTurn(run), reason: 'RUNNER_ERROR', error: sanitizeText(error.message)});
          });
        }
      }
      if (message.type === 'choice' && message.role === client.role && humanRoles.includes(client.role)) {
        recordHumanAction(client.role, message);
      }
      if (message.type === 'end') void finish(message.data);
      if (message.type === 'error') {
        run.validBenchmark = false;
        void finish({winner: null, turn: latestTurn(run), reason: 'SERVER_ERROR', error: sanitizeText(message.error)});
      }
    });
    client.ws.on('error', error => {
      void finish({winner: null, turn: latestTurn(run), reason: 'WEBSOCKET_ERROR', error: sanitizeText(error.message)});
    });
  }

  async function handleState(client, state) {
    if (finished || !state || state.ended) {
      if (state?.ended) await finish({winner: state.winner, turn: state.turn});
      return;
    }
    if (state.turn > maxTurns) {
      run.validBenchmark = false;
      await finish({winner: null, turn: state.turn, reason: `MAX_TURNS=${maxTurns}`});
      return;
    }

    const observation = state.extracted || state.observation || state;
    const legalActions = observation?.legalActions || state.legalActions || [];
    if (!observation || observation.waiting || !legalActions.length) return;

    const requestId = state.request?.rqid ?? observation.requestId ?? state.turn;
    const choiceKey = choiceKeyFor(state.turn, requestId, legalActions);
    if (client.choices.has(choiceKey) || client.choosing.has(choiceKey)) return;
    client.choosing.add(choiceKey);
    if (waitIfPaused) await waitIfPaused({role: client.role, turn: state.turn, requestId});
    if (finished || signal?.aborted) {
      client.choosing.delete(choiceKey);
      return;
    }

    const agent = agents[client.role];
    const observationIndex = run.observations.length;
    const observationRecord = {
      at: new Date().toISOString(),
      index: observationIndex,
      role: client.role,
      turn: state.turn,
      requestId,
      schemaVersion: observation.schemaVersion || null,
      observation,
      legalActions,
    };
    run.observations.push(observationRecord);
    captureTeamSnapshot(run, client.role, observation, observationRecord);
    notify(onObservation, {run, observationRecord});

    if (agent.provider === 'human') {
      // The player answers from their own browser; mark the request seen so
      // re-broadcasts of the same state don't duplicate the observation.
      client.choosing.delete(choiceKey);
      client.choices.add(choiceKey);
      return;
    }

    let decision;
    let recordedCallIndex = null;
    try {
      decision = await chooseWithAgent(agent, client.role, observation, legalActions, {allowFallback, signal, modelTimeoutMs});
    } catch (error) {
      client.choosing.delete(choiceKey);
      const metadata = publicAgentMetadata(agent);
      const call = error.call || {
        at: new Date().toISOString(),
        role: client.role,
        provider: metadata.provider,
        agent: metadata.name,
        model: metadata.model,
        reasoningEffort: metadata.reasoningEffort || '',
        valid: false,
        fallback: false,
        error: sanitizeText(error.message),
      };
      call.observationIndex = observationIndex;
      call.error = sanitizeText(error.message);
      run.validBenchmark = false;
      if (error.name === 'InvalidModelChoiceError') run.invalidChoiceCount += 1;
      else if (agent.provider !== 'standin') run.apiErrorCount += 1;
      // One failed decision is one record: the safe fallback move is folded
      // into this same call rather than pushed as a second wrapped copy,
      // which double counted the failure in invalid/fallback/usage totals.
      const action = allowFallback ? firstSafeAction(legalActions) : null;
      if (action) {
        call.choice = action.choice;
        call.fallback = true;
        run.fallbackCount += 1;
      }
      run.modelCalls.push(call);
      run.usage = summarizeUsage(run.modelCalls);
      recordedCallIndex = run.modelCalls.length - 1;
      notify(onModelCall, {run, call, callIndex: recordedCallIndex, observationRecord});
      if (!allowFallback) {
        await finish({
          winner: null,
          turn: state.turn,
          reason: error.name === 'InvalidModelChoiceError' ? 'INVALID_MODEL_CHOICE' : 'MODEL_API_ERROR',
          error: sanitizeText(error.message),
        });
        return;
      }
      decision = {action, call};
    }

    client.choosing.delete(choiceKey);
    if (!decision?.action || finished) return;
    client.choices.add(choiceKey);
    decision.call.observationIndex = observationIndex;
    const callIndex = recordedCallIndex ?? run.modelCalls.length;
    if (recordedCallIndex == null) {
      if (!decision.call.valid) run.invalidChoiceCount += 1;
      if (decision.call.fallback) run.fallbackCount += 1;
      if (!decision.call.valid || decision.call.fallback) run.validBenchmark = false;
      run.modelCalls.push(decision.call);
      run.usage = summarizeUsage(run.modelCalls);
      notify(onModelCall, {run, call: decision.call, callIndex, observationRecord});
    }

    setTimeout(() => {
      if (finished || client.ws.readyState !== WebSocket.OPEN) return;
      client.ws.send(JSON.stringify({type: 'choose', choice: decision.action.choice, rqid: requestId}));
      const actionRecord = {
        at: new Date().toISOString(),
        role: client.role,
        turn: state.turn,
        requestId,
        choice: decision.action.choice,
        action: decision.action,
        observationIndex,
        callIndex,
      };
      run.actions.push(actionRecord);
      notify(onAction, {run, actionRecord, call: decision.call, observationRecord});
      console.log(`${client.role} turn ${state.turn}: ${decision.action.choice}`);
    }, moveDelayMs);
  }

  // A human's submitted choice, echoed back by the battle session. Recorded
  // as an action plus a pseudo model-call so artifact links (callIndex,
  // observationIndex) and the event log stay uniform.
  function recordHumanAction(role, message) {
    if (finished) return;
    const observationRecord = [...run.observations].reverse().find(record =>
      record.role === role &&
      (message.rqid == null || record.requestId == null || Number(record.requestId) === Number(message.rqid)));
    const legal = observationRecord?.legalActions || [];
    const matchedAction = legal.find(item => item.choice === message.choice) || null;
    const callIndex = run.modelCalls.length;
    const call = {
      at: new Date().toISOString(),
      role,
      provider: 'human',
      agent: agents[role].name,
      model: 'human',
      reasoningEffort: '',
      observationIndex: observationRecord?.index ?? null,
      requestedChoice: message.choice,
      choice: message.choice,
      // valid certifies the choice was one of the legal actions we showed;
      // input arriving outside that set (tampered client) must not be
      // stamped valid in the artifact.
      valid: Boolean(matchedAction),
      fallback: false,
      reason: matchedAction ? 'human player input' : 'human input did not match a known legal action',
    };
    run.modelCalls.push(call);
    run.usage = summarizeUsage(run.modelCalls);
    notify(onModelCall, {run, call, callIndex, observationRecord});
    const actionRecord = {
      at: new Date().toISOString(),
      role,
      turn: message.turn ?? observationRecord?.turn ?? null,
      requestId: message.rqid ?? null,
      choice: message.choice,
      action: matchedAction || {choice: message.choice, command: message.choice, label: message.choice},
      observationIndex: observationRecord?.index ?? null,
      callIndex,
    };
    run.actions.push(actionRecord);
    notify(onAction, {run, actionRecord, call, observationRecord});
  }

  async function finish(data = {}) {
    if (finished) return;
    finished = true;
    clearTimeout(timeout);
    if (signal) signal.removeEventListener?.('abort', abortRun);
    run.finishedAt = new Date().toISOString();
    run.result = {
      done: true,
      winner: data.winner || null,
      winnerRole: data.winnerRole
        || (data.winner === playerNames.p1 ? 'p1' : data.winner === playerNames.p2 ? 'p2' : null),
      turn: data.turn ?? latestTurn(run),
      reason: data.reason || '',
      error: data.error ? sanitizeText(data.error) : '',
    };
    run.usage = summarizeUsage(run.modelCalls);
    for (const client of Object.values(clients)) {
      try {
        client.ws.close();
      } catch {}
    }
    try {
      if (outputPath) {
        run.eventsPath = eventPathForArtifact(outputPath);
        run.eventsHref = artifactHrefForPath(run.eventsPath);
        await writeJson(outputPath, run);
        await writeJsonl(run.eventsPath, eventsFromMatchArtifact(run));
      }
      finishResolve(run);
    } catch (error) {
      finishReject(error);
    }
  }

  function abortRun() {
    run.validBenchmark = false;
    void finish({winner: null, turn: latestTurn(run), reason: 'ABORTED'});
  }

  return finishedPromise;
}

export async function resetBattle({serverOrigin, battleId = DEFAULT_BATTLE_ID, formatid = DEFAULT_FORMAT, seed = null, playerNames = undefined} = {}) {
  const response = await fetch(`${serverOrigin}/api/reset`, {
    method: 'POST',
    headers: {'content-type': 'application/json'},
    body: JSON.stringify({battleId: normalizeBattleId(battleId), formatid, seed, playerNames}),
  });
  if (!response.ok) throw new Error(`Reset failed: HTTP ${response.status}`);
  return response.json().catch(() => ({ok: true}));
}

// "anthropic/claude-sonnet-4.6" → "claude-sonnet-4.6"; stand-ins keep their
// plain names. Kept short and protocol-safe for the Showdown player field.
function playerDisplayName(agent = {}) {
  if (agent.provider === 'human') return 'Human';
  if (agent.provider === 'standin' || agent.provider === 'heuristic') return agent.provider;
  const model = String(agent.model || agent.name || 'player');
  const base = model.includes('/') ? model.split('/').pop() : model;
  const clean = base.replace(/[|,\n\r]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 22);
  return clean || 'player';
}

export async function writeJson(outputPath, payload) {
  await fs.mkdir(path.dirname(outputPath), {recursive: true});
  await fs.writeFile(outputPath, `${JSON.stringify(payload, null, 2)}\n`);
}

function connect(serverUrl, role, battleId) {
  const url = new URL(serverUrl);
  url.searchParams.set('role', role);
  url.searchParams.set('battleId', battleId);
  const ws = new WebSocket(url);
  ws.on('open', () => console.log(`${role} connected`));
  return {role, ws, choices: new Set(), choosing: new Set()};
}

async function normalizeAgent(spec, providerKeys = {}) {
  const agent = spec?.provider ? await createAgent(spec) : await createAgent(spec || 'standin');
  if (!agent.apiKey && providerKeys[agent.provider]) agent.apiKey = providerKeys[agent.provider];
  return agent;
}

function choiceKeyFor(turn, requestId, legalActions) {
  return `${turn}:${requestId ?? 'no-rqid'}:${legalActions.map(action => action.choice || action.command).join('/')}`;
}

function summarizeState(state) {
  if (!state) return null;
  return {
    role: state.role,
    turn: state.turn,
    formatid: state.formatid,
    seed: state.seed,
    ended: state.ended,
    winner: state.winner,
    waiting: state.waiting,
    schemaVersion: state.extracted?.schemaVersion || null,
    active: activeNames(state.extracted?.self),
    opponent: activeNames(state.extracted?.opponent),
    legalActionCount: state.extracted?.legalActions?.length || state.legalActions?.length || 0,
  };
}

function captureTeamSnapshot(run, role, observation = {}, record = {}) {
  if (run.teamSnapshots?.[role] || (role !== 'p1' && role !== 'p2')) return;
  const team = observation.self?.team;
  if (!Array.isArray(team) || !team.length) return;
  const snapshot = team.map(summarizeTeamSet);
  run.teamSnapshots[role] = {
    role,
    capturedAt: record.at || new Date().toISOString(),
    observationIndex: record.index ?? null,
    turn: record.turn ?? observation.turn ?? null,
    requestId: record.requestId ?? observation.requestId ?? null,
    formatid: observation.formatid || run.formatid || '',
    teamSize: snapshot.length,
    teamHash: digestJson(snapshot),
    team: snapshot,
  };
}

function summarizeTeamSet(mon = {}) {
  return {
    slot: mon.slot ?? null,
    name: mon.name || '',
    species: mon.species || '',
    level: mon.level ?? null,
    gender: mon.gender || '',
    shiny: Boolean(mon.shiny),
    item: mon.item || '',
    ability: mon.ability || '',
    nature: mon.nature || '',
    evs: mon.evs || null,
    ivs: mon.ivs || null,
    moves: mon.moves || [],
    teraType: mon.teraType || '',
  };
}

function digestJson(value) {
  return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function activeNames(side = {}) {
  const names = (side.activePokemon || []).map(mon => mon.name).filter(Boolean);
  return names.length ? names.join(' + ') : side.active?.name || null;
}

function latestTurn(run) {
  return Math.max(
    0,
    ...Object.values(run.finalState || {}).map(state => Number(state?.turn || 0)),
    ...run.actions.map(action => Number(action.turn || 0))
  );
}

function sanitizeMessage(message) {
  return JSON.parse(sanitizeText(JSON.stringify(message)));
}

function notify(callback, payload) {
  if (!callback) return;
  try {
    callback(payload);
  } catch (error) {
    console.warn(`runner callback failed: ${sanitizeText(error?.message || error)}`);
  }
}

function parseSeed(value = '') {
  const parts = String(value || '').split(',').map(part => Number(part.trim())).filter(Number.isFinite);
  return parts.length === 4 ? parts : null;
}

function makeBattleId() {
  return `match-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function normalizeBattleId(value) {
  const id = String(value || DEFAULT_BATTLE_ID).trim().toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '');
  return id.slice(0, 80) || DEFAULT_BATTLE_ID;
}
