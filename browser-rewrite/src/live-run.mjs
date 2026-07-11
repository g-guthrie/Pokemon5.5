// The visitor-facing live-run manager: start/pause/stop commands, the
// multi-game loop, series recording, transcripts, and the /api/run summary
// shape. Extracted from server.mjs so the Node server and the static browser
// build (engine worker) run the exact same orchestration; the host supplies
// storage locations and environment guards through createLiveRunManager.
import fs from 'node:fs/promises';
import path from 'node:path';
import {REQUIRED_ANALYSIS_FIELDS, sanitizeText} from './agent-runtime.mjs';
import {DEFAULT_BATTLE_ID, normalizeBattleId} from './battle-hub.mjs';
import {runWebSocketMatch} from './match-runner.mjs';
import {getSeries, loadSeriesStore, recordSeriesGame, resetSeries, saveSeriesStore} from './series-store.mjs';
import {transcriptFromMatchArtifact, transcriptPathForArtifact} from './transcript.mjs';
import {mergeUsageSummaries, summarizeUsage} from './usage-summary.mjs';

export function clampNumber(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, number));
}

export function normalizeSessionId(value) {
  return String(value || '').trim().toLowerCase().replace(/[^a-z0-9-]+/g, '').slice(0, 24);
}

export function sanitizeAgentSpec(value) {
  return sanitizeText(String(value || 'standin').trim()).slice(0, 160) || 'standin';
}

export function normalizeProviderKeys(body = {}) {
  const keys = {};
  const openrouter = typeof body.openrouterKey === 'string' ? body.openrouterKey.trim() : '';
  if (openrouter && openrouter.length <= 250) keys.openrouter = openrouter;
  return keys;
}

export function parseRunSeed(value) {
  if (!Array.isArray(value)) return null;
  const seed = value.map(Number).filter(Number.isFinite);
  return seed.length === 4 ? seed : null;
}

export function isRunActive(run) {
  return Boolean(run && ['running', 'paused', 'stopping'].includes(run.status));
}

export function createLiveRunManager(options = {}) {
  const artifactsDir = options.artifactsDir;
  const serverOrigin = options.serverOrigin;
  const seriesStorePath = options.seriesStorePath || path.join(artifactsDir, 'series-store.json');
  const maxConcurrentRuns = options.maxConcurrentRuns ?? 3;
  const maxCompletedRuns = options.maxCompletedRuns ?? 250;
  const retentionMs = options.retentionMs ?? 86400000;
  // Server-only guard: the legacy no-session slot shares the machine with
  // batch workflows (ladder/tournament/benchmark). Throws when busy.
  const assertLegacySlotFree = options.assertLegacySlotFree || (() => {});
  // Disk retention is the Node server's concern; the browser build passes a no-op.
  const pruneArtifacts = options.pruneArtifacts || (() => {});
  // Browser persistence bridge: called after every series-store save.
  const afterSeriesSave = options.afterSeriesSave || null;

  const liveRuns = new Map();
  let seriesStoreQueue = Promise.resolve();

  function artifactHrefFor(filePath = '') {
    if (!filePath) return '';
    const relative = path.relative(artifactsDir, path.resolve(filePath));
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) return '';
    return `/artifacts/${relative.split(path.sep).map(encodeURIComponent).join('/')}`;
  }

  function pruneLiveRuns() {
    const now = Date.now();
    const completed = [...liveRuns.entries()]
      .filter(([sessionId, run]) => sessionId && run && !isRunActive(run))
      .sort(([, a], [, b]) => String(b.finishedAt || b.startedAt).localeCompare(String(a.finishedAt || a.startedAt)));
    for (const [index, [sessionId, run]] of completed.entries()) {
      const finishedAt = Date.parse(run.finishedAt || run.startedAt || '') || 0;
      if (index >= maxCompletedRuns || (finishedAt && now - finishedAt > retentionMs)) {
        liveRuns.delete(sessionId);
      }
    }
  }

  function startLiveRun(body = {}, sessionId = '') {
    pruneLiveRuns();
    const existing = liveRuns.get(sessionId);
    if (isRunActive(existing)) throw new Error('You already have a match running — stop it first');
    const activeCount = [...liveRuns.values()].filter(isRunActive).length;
    if (activeCount >= maxConcurrentRuns) {
      throw new Error('The arena is at capacity right now — try again in a few minutes');
    }
    if (!sessionId) assertLegacySlotFree();
    const id = `live-${new Date().toISOString().replace(/[:.]/g, '-')}${sessionId ? `-${sessionId.slice(0, 8)}` : ''}`;
    // Visitor sessions are pinned to their own battle so concurrent matches
    // never collide; the legacy no-session path keeps the shared 'local'.
    const battleId = sessionId
      ? normalizeBattleId(`s-${sessionId}`)
      : normalizeBattleId(body.battleId || body.battle || DEFAULT_BATTLE_ID);
    const outputPath = path.join(artifactsDir, 'live-runs', `${id}.json`);
    void pruneArtifacts();
    const run = {
      id,
      status: body.startPaused ? 'paused' : 'running',
      startedAt: new Date().toISOString(),
      finishedAt: '',
      battleId,
      outputPath,
      eventsPath: '',
      eventsHref: '',
      formatid: typeof body.formatid === 'string' ? body.formatid : 'gen9randomdoublesbattle',
      seed: parseRunSeed(body.seed),
      // How many games this run plays back-to-back. Every finished game also
      // rolls into the persistent series for this exact model pairing.
      gameCount: clampNumber(body.gameCount ?? body.games, 1, 100, 1),
      currentGame: 0,
      games: [],
      series: null,
      transcriptPath: '',
      transcriptHref: '',
      usageTotals: summarizeUsage([]),
      maxTurns: clampNumber(body.maxTurns, 1, 200, 40),
      moveDelayMs: clampNumber(body.moveDelayMs, 0, 5000, 200),
      timeoutMs: clampNumber(body.timeoutMs, 1000, 7200000, 30000),
      modelTimeoutMs: clampNumber(body.modelTimeoutMs, 1000, 600000, 240000),
      allowFallback: Boolean(body.allowFallback),
      agentP1: sanitizeAgentSpec(body.agentP1 || body.agents?.p1 || 'standin'),
      agentP2: sanitizeAgentSpec(body.agentP2 || body.agents?.p2 || 'standin'),
      humanRoles: [],
      // Human play hides the AI's mind by default; the player may flip this to
      // peek at the opponent's live thinking (their game, their call).
      revealOpponentMind: Boolean(body.revealOpponentMind),
      // Visitor-supplied key: memory only. summarizeLiveRun never includes it,
      // and the runner/artifact layers scrub key-shaped strings everywhere.
      providerKeys: normalizeProviderKeys(body),
      paused: Boolean(body.startPaused),
      pauseWaiters: [],
      abortController: new AbortController(),
      result: null,
      error: '',
      currentTurn: 0,
      observationCount: 0,
      modelCallCount: 0,
      actionCount: 0,
      usage: null,
      validBenchmark: true,
      apiErrorCount: 0,
      fallbackCount: 0,
      invalidChoiceCount: 0,
      lastObservation: null,
      lastBoards: {p1: null, p2: null},
      lastModelCall: null,
      lastModelCalls: [],
      lastActions: [],
      roleStates: {
        p1: createLiveRoleState(),
        p2: createLiveRoleState(),
      },
      sessionId,
    };
    // Human play: the visitor drives Player 1 from the decision deck; only one
    // side can be human and it is always P1 (the stage IS Player 1's client).
    run.humanRoles = ['p1', 'p2'].filter(role => (role === 'p1' ? run.agentP1 : run.agentP2) === 'human');
    if (run.agentP2 === 'human') {
      throw new Error('You play Player 1 — set Player 2 to a model or built-in bot');
    }
    liveRuns.set(sessionId, run);
    void runLiveMatch(run);
    return run;
  }

  // The /api/run POST command surface, minus transport concerns (rate
  // limiting stays with the host). Returns the run to summarize.
  function runCommand(command, body = {}, sessionId = '') {
    if (command === 'start') return startLiveRun(body, sessionId);
    const liveRun = liveRuns.get(sessionId) || null;
    if (command === 'pause') {
      if (!isRunActive(liveRun)) throw new Error('No active run to pause');
      liveRun.paused = true;
      liveRun.status = 'paused';
      return liveRun;
    }
    if (command === 'resume') {
      if (!isRunActive(liveRun)) throw new Error('No active run to resume');
      resumeLiveRun(liveRun);
      return liveRun;
    }
    if (command === 'reveal-mind') {
      if (!liveRun) throw new Error('No run to reveal');
      liveRun.revealOpponentMind = Boolean(body.reveal);
      return liveRun;
    }
    if (command === 'stop') {
      if (!isRunActive(liveRun)) throw new Error('No active run to stop');
      liveRun.status = 'stopping';
      liveRun.paused = false;
      resumeLiveRun(liveRun);
      liveRun.abortController.abort();
      return liveRun;
    }
    throw new Error(`Unknown run command: ${command}`);
  }

  async function runLiveMatch(run) {
    try {
      for (let game = 1; game <= run.gameCount; game += 1) {
        if (run.abortController.signal.aborted) break;
        await waitIfLiveRunPaused(run);
        if (run.abortController.signal.aborted) break;
        run.currentGame = game;
        resetLiveGameTelemetry(run);
        const outputPath = run.gameCount === 1
          ? run.outputPath
          : path.join(artifactsDir, 'live-runs', `${run.id}-g${String(game).padStart(2, '0')}.json`);
        const result = await runLiveGame(run, outputPath, game);
        copyMatchTelemetry(run, result);
        run.usageTotals = mergeUsageSummaries(run.usageTotals, result.usage || summarizeUsage(result.modelCalls || []));
        run.result = result.result || null;
        run.outputPath = outputPath;
        run.eventsPath = result.eventsPath || '';
        run.eventsHref = result.eventsHref || '';
        await recordLiveGame(run, result, outputPath, game);
        if (result.result?.reason === 'ABORTED' || run.abortController.signal.aborted) break;
        // Let the winner banner breathe before the next game resets the stage.
        if (game < run.gameCount) await interGamePause(run);
      }
      run.status = run.abortController.signal.aborted || run.result?.reason === 'ABORTED' ? 'stopped' : 'finished';
    } catch (error) {
      run.status = run.abortController.signal.aborted ? 'stopped' : 'error';
      run.error = sanitizeText(error?.message || error);
    } finally {
      // The browser remains the sole long-lived owner of visitor credentials.
      // The per-run server copy exists only while provider calls can use it.
      run.providerKeys = {};
      for (const role of ['p1', 'p2']) {
        run.roleStates[role] = {...run.roleStates[role], phase: 'finished'};
      }
      run.paused = false;
      resumeLiveRun(run);
      run.finishedAt = new Date().toISOString();
    }
  }

  function runLiveGame(run, outputPath, game) {
    return runWebSocketMatch({
        serverOrigin,
        battleId: run.battleId,
        outputPath,
        formatid: run.formatid,
        // An explicit seed pins game 1 only; later games get fresh teams.
        seed: game === 1 ? run.seed : null,
        maxTurns: run.maxTurns,
        moveDelayMs: run.moveDelayMs,
        timeoutMs: run.timeoutMs,
        allowFallback: run.allowFallback,
        signal: run.abortController.signal,
        waitIfPaused: () => waitIfLiveRunPaused(run),
        onObservation: ({run: match, observationRecord}) => {
          copyMatchTelemetry(run, match);
          run.lastObservation = summarizeLiveObservation(observationRecord);
          const role = observationRecord?.role;
          if (role === 'p1' || role === 'p2') {
            run.roleStates[role] = {
              phase: 'thinking',
              turn: observationRecord.turn ?? null,
              requestId: observationRecord.requestId ?? null,
              observationAt: observationRecord.at || new Date().toISOString(),
              decisionAt: '',
              submittedAt: '',
            };
            run.lastBoards[role] = summarizeLiveBoard(observationRecord.observation);
          }
        },
        onModelCall: ({run: match, call, callIndex}) => {
          copyMatchTelemetry(run, match);
          run.lastModelCall = summarizeLiveModelCall(call, callIndex);
          run.lastModelCalls.push(run.lastModelCall);
          run.lastModelCalls = run.lastModelCalls.slice(-14);
          if (call.role === 'p1' || call.role === 'p2') {
            run.roleStates[call.role] = {
              ...run.roleStates[call.role],
              phase: call.error ? 'error' : 'decision-ready',
              decisionAt: call.at || new Date().toISOString(),
            };
          }
        },
        onAction: ({run: match, actionRecord, call}) => {
          copyMatchTelemetry(run, match);
          run.lastActions.push(summarizeLiveAction(actionRecord, call));
          run.lastActions = run.lastActions.slice(-8);
          if (actionRecord.role === 'p1' || actionRecord.role === 'p2') {
            run.roleStates[actionRecord.role] = {
              ...run.roleStates[actionRecord.role],
              phase: 'submitted',
              submittedAt: actionRecord.at || new Date().toISOString(),
            };
          }
        },
        agents: {
          p1: run.agentP1,
          p2: run.agentP2,
        },
        providerKeys: run.providerKeys,
        sessionId: run.sessionId,
    });
  }

  // Between games the telemetry restarts: the viewer's turn counter, boards,
  // and minds belong to the game on stage, not the whole run.
  function resetLiveGameTelemetry(run) {
    run.result = null;
    run.currentTurn = 0;
    run.observationCount = 0;
    run.modelCallCount = 0;
    run.actionCount = 0;
    run.usage = null;
    run.validBenchmark = true;
    run.apiErrorCount = 0;
    run.fallbackCount = 0;
    run.invalidChoiceCount = 0;
    run.lastObservation = null;
    run.lastBoards = {p1: null, p2: null};
    run.lastModelCall = null;
    run.lastModelCalls = [];
    run.lastActions = [];
    run.roleStates = {
      p1: createLiveRoleState(),
      p2: createLiveRoleState(),
    };
  }

  // Write the game's text transcript and roll the result into the persistent
  // series for this pairing. Both are best-effort: a failed write must never
  // kill the run.
  async function recordLiveGame(run, result, outputPath, game) {
    let transcriptHref = '';
    try {
      const transcriptPath = transcriptPathForArtifact(outputPath);
      await fs.writeFile(transcriptPath, transcriptFromMatchArtifact(result));
      transcriptHref = artifactHrefFor(transcriptPath);
      run.transcriptPath = transcriptPath;
      run.transcriptHref = transcriptHref;
    } catch {
      // transcript is a convenience artifact
    }
    const aborted = result.result?.reason === 'ABORTED';
    const gameRecord = {
      gameId: `${run.id}#${game}`,
      game,
      at: new Date().toISOString(),
      runId: run.id,
      winnerRole: result.result?.winnerRole || null,
      winnerName: sanitizeText(String(result.result?.winner || '')),
      turns: result.result?.turn ?? null,
      reason: result.result?.reason || '',
      valid: Boolean(result.validBenchmark),
      aborted,
      outputHref: artifactHrefFor(outputPath),
      transcriptHref,
    };
    run.games.push(gameRecord);
    if (aborted) return;
    try {
      const series = await withSeriesStore(store => recordSeriesGame(store, seriesIdentity(run), gameRecord));
      run.series = summarizeSeries(series);
    } catch {
      // the series record is a convenience; the run result stands on its own
    }
  }

  function seriesIdentity(run) {
    return {sessionId: run.sessionId || '', agentP1: run.agentP1, agentP2: run.agentP2};
  }

  // Serialize every read-modify-write of the series store through one queue so
  // concurrent visitor runs never clobber each other's records.
  function withSeriesStore(fn) {
    const task = seriesStoreQueue.then(async () => {
      const store = await loadSeriesStore(seriesStorePath);
      const result = await fn(store);
      await saveSeriesStore(seriesStorePath, store);
      if (afterSeriesSave) await afterSeriesSave(seriesStorePath);
      return result;
    });
    seriesStoreQueue = task.then(() => {}, () => {});
    return task;
  }

  async function seriesGet(identity) {
    const store = await loadSeriesStore(seriesStorePath);
    return summarizeSeries(getSeries(store, identity));
  }

  async function seriesReset(identity) {
    await withSeriesStore(store => resetSeries(store, identity));
    const activeRun = liveRuns.get(identity.sessionId);
    if (activeRun && activeRun.agentP1 === identity.agentP1 && activeRun.agentP2 === identity.agentP2) {
      activeRun.series = null;
    }
  }

  // A short abort-aware breather so a finished game's banner is visible before
  // the next game of the run resets the stage.
  async function interGamePause(run, ms = 5000) {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      if (run.abortController.signal.aborted) return;
      await waitIfLiveRunPaused(run);
      await new Promise(resolve => setTimeout(resolve, 200));
    }
  }

  function waitIfLiveRunPaused(run) {
    if (!run.paused || !isRunActive(run)) return Promise.resolve();
    run.status = 'paused';
    return new Promise(resolve => {
      run.pauseWaiters.push(resolve);
    });
  }

  function resumeLiveRun(run) {
    if (!run) return;
    run.paused = false;
    if (run.status === 'paused') run.status = 'running';
    const waiters = run.pauseWaiters.splice(0);
    for (const resolve of waiters) resolve();
  }

  function summarizeLiveRun(run) {
    if (!run) return null;
    const summary = summarizeLiveRunFields(run);
    // While a human is playing, the opponent's hand stays hidden: no AI mind
    // (analysis/prompt/reasons), no AI private board. Everything is revealed
    // once the run finishes — the post-game "what was it thinking" is the fun.
    if (run.humanRoles?.length && isRunActive(run) && !run.revealOpponentMind) {
      const hiddenRoles = ['p1', 'p2'].filter(role => !run.humanRoles.includes(role));
      summary.lastModelCalls = (summary.lastModelCalls || []).filter(call => !hiddenRoles.includes(call.role));
      summary.lastModelCall = hiddenRoles.includes(summary.lastModelCall?.role) ? null : summary.lastModelCall;
      summary.lastObservation = hiddenRoles.includes(summary.lastObservation?.role) ? null : summary.lastObservation;
      summary.lastBoards = Object.fromEntries(['p1', 'p2'].map(role =>
        [role, hiddenRoles.includes(role) ? null : summary.lastBoards?.[role] || null]));
      summary.lastActions = (summary.lastActions || []).map(action =>
        hiddenRoles.includes(action.role) ? {...action, reason: ''} : action);
    }
    return summary;
  }

  function summarizeLiveRunFields(run) {
    return {
      id: run.id,
      status: run.status,
      startedAt: run.startedAt,
      finishedAt: run.finishedAt,
      battleId: run.battleId,
      humanRoles: run.humanRoles || [],
      revealOpponentMind: Boolean(run.revealOpponentMind),
      outputPath: run.outputPath,
      outputHref: artifactHrefFor(run.outputPath),
      eventsPath: run.eventsPath,
      eventsHref: run.eventsHref || artifactHrefFor(run.eventsPath),
      transcriptPath: run.transcriptPath || '',
      transcriptHref: run.transcriptHref || '',
      gameCount: run.gameCount || 1,
      currentGame: run.currentGame || 0,
      games: run.games || [],
      series: run.series || null,
      usageTotals: run.usageTotals || null,
      formatid: run.formatid,
      seed: run.seed,
      maxTurns: run.maxTurns,
      moveDelayMs: run.moveDelayMs,
      timeoutMs: run.timeoutMs,
      allowFallback: run.allowFallback,
      agentP1: run.agentP1,
      agentP2: run.agentP2,
      paused: run.paused,
      result: run.result,
      error: run.error,
      phase: liveRunPhase(run),
      roleStates: run.roleStates || null,
      currentTurn: run.currentTurn || 0,
      observationCount: run.observationCount || 0,
      modelCallCount: run.modelCallCount || 0,
      actionCount: run.actionCount || 0,
      usage: run.usage || null,
      validBenchmark: run.validBenchmark,
      apiErrorCount: run.apiErrorCount || 0,
      fallbackCount: run.fallbackCount || 0,
      invalidChoiceCount: run.invalidChoiceCount || 0,
      lastObservation: run.lastObservation || null,
      lastBoards: run.lastBoards || null,
      lastModelCall: run.lastModelCall || null,
      lastModelCalls: run.lastModelCalls || [],
      lastActions: run.lastActions || [],
    };
  }

  return {
    liveRuns,
    startLiveRun,
    runCommand,
    summarizeLiveRun,
    seriesGet,
    seriesReset,
    artifactHrefFor,
    pruneLiveRuns,
  };
}

function createLiveRoleState() {
  return {
    phase: 'idle',
    turn: null,
    requestId: null,
    observationAt: '',
    decisionAt: '',
    submittedAt: '',
  };
}

export function liveRunPhase(run) {
  if (!run) return 'idle';
  if (run.paused || run.status === 'paused') return 'paused';
  if (run.status === 'finished' || run.status === 'stopped') return 'finished';
  if (run.status === 'error') return 'error';
  const phases = Object.values(run.roleStates || {}).map(state => state?.phase);
  if (phases.includes('error')) return 'error';
  if (phases.includes('thinking')) return 'thinking';
  if (phases.includes('decision-ready')) return 'decision-ready';
  if (phases.includes('submitted')) return 'resolving';
  return 'preparing';
}

function copyMatchTelemetry(run, match = {}) {
  run.currentTurn = latestMatchTurn(match);
  run.observationCount = match.observations?.length || 0;
  run.modelCallCount = match.modelCalls?.length || 0;
  run.actionCount = match.actions?.length || 0;
  run.usage = match.usage || run.usage || null;
  run.validBenchmark = Boolean(match.validBenchmark);
  run.apiErrorCount = Number(match.apiErrorCount || 0);
  run.fallbackCount = Number(match.fallbackCount || 0);
  run.invalidChoiceCount = Number(match.invalidChoiceCount || 0);
}

function latestMatchTurn(match = {}) {
  return Math.max(
    0,
    Number(match.result?.turn || 0),
    ...Object.values(match.finalState || {}).map(state => Number(state?.turn || 0)),
    ...(match.observations || []).map(observation => Number(observation.turn || 0)),
    ...(match.actions || []).map(action => Number(action.turn || 0))
  );
}

function activeNames(side = {}) {
  const names = (side.activePokemon || []).map(mon => mon.name || mon.species).filter(Boolean);
  return names.length ? names.join(' + ') : side.active?.name || side.active?.species || '';
}

function summarizeLiveObservation(record = {}) {
  const observation = record.observation || {};
  return {
    at: record.at || '',
    index: record.index ?? null,
    role: record.role || '',
    turn: record.turn ?? observation.turn ?? null,
    requestId: record.requestId ?? observation.requestId ?? null,
    schemaVersion: record.schemaVersion || observation.schemaVersion || '',
    legalActionCount: record.legalActions?.length || observation.legalActions?.length || 0,
    active: activeNames(observation.self),
    opponent: activeNames(observation.opponent),
  };
}

// The Model Mind's "known context" block: exactly what this player can see —
// its own full private team, and only what the opponent has revealed. Same
// hidden-info boundary as the prompt itself.
function summarizeLiveBoard(observation = {}) {
  const own = (observation.self?.team || []).slice(0, 6).map(mon => ({
    name: sanitizeText(mon.name || mon.species || ''),
    species: sanitizeText(mon.species || ''),
    condition: sanitizeText(mon.condition || ''),
    active: Boolean(mon.active),
    item: sanitizeText(mon.item || ''),
    ability: sanitizeText(mon.ability || ''),
    teraType: sanitizeText(mon.teraType || ''),
    terastallized: Boolean(mon.terastallized),
    moves: (mon.moves || []).slice(0, 4).map(move => sanitizeText(String(move))),
  }));
  const opponentSeen = (observation.opponent?.revealedTeam || [])
    .filter(mon => mon && mon.revealed)
    .slice(0, 6)
    .map(mon => ({
      name: sanitizeText(mon.name || mon.species || ''),
      species: sanitizeText(mon.species || ''),
      condition: sanitizeText(mon.condition || ''),
      active: Boolean(mon.active),
      fainted: Boolean(mon.fainted),
      status: sanitizeText(mon.status || ''),
      item: sanitizeText(mon.item || mon.itemLastKnown || ''),
      itemConsumed: Boolean(mon.itemConsumed),
      ability: sanitizeText(mon.ability || ''),
      teraType: sanitizeText(mon.teraType || ''),
      movesRevealed: (mon.movesRevealed || []).slice(0, 4).map(move => sanitizeText(String(move))),
    }));
  return {
    turn: observation.turn ?? null,
    weather: sanitizeText(observation.field?.weather?.name || ''),
    terrain: sanitizeText(observation.field?.terrain?.name || ''),
    own,
    opponentSeen,
  };
}

function summarizeLiveModelCall(call = {}, callIndex = null) {
  return {
    at: call.at || '',
    callIndex,
    observationIndex: call.observationIndex ?? null,
    role: call.role || '',
    provider: call.provider || '',
    agent: call.agent || '',
    model: call.model || '',
    reasoningEffort: call.reasoningEffort || '',
    promptSchemaVersion: call.promptSchemaVersion || '',
    responseSchemaVersion: call.responseSchemaVersion || '',
    requestedChoice: call.requestedChoice || '',
    choice: call.choice || '',
    valid: Boolean(call.valid),
    fallback: Boolean(call.fallback),
    analysisComplete: typeof call.analysisComplete === 'boolean' ? call.analysisComplete : null,
    analysisMissing: Array.isArray(call.analysisMissing) ? call.analysisMissing : [],
    analysis: summarizeDecisionAnalysis(call.analysis),
    reason: sanitizeText(call.reason || '').slice(0, 500),
    error: sanitizeText(call.error || '').slice(0, 500),
    usage: call.usage || null,
    prompt: sanitizeText(call.prompt || '').slice(0, 8000),
    rawText: sanitizeText(call.rawText || '').slice(0, 4000),
    scores: Array.isArray(call.scores) ? call.scores.slice(0, 8).map(item => ({
      choice: sanitizeText(item?.choice || '').slice(0, 160),
      label: sanitizeText(item?.label || '').slice(0, 160),
      score: Number.isFinite(Number(item?.score)) ? Number(item.score) : null,
    })) : [],
  };
}

function summarizeLiveAction(action = {}, call = {}) {
  return {
    at: action.at || '',
    role: action.role || '',
    turn: action.turn ?? null,
    requestId: action.requestId ?? null,
    choice: action.choice || '',
    // The human name of what was pressed ("Active 1: Fake Out → foe 1 / …")
    // so viewer surfaces never have to show protocol strings.
    label: sanitizeText(action.action?.label || '').slice(0, 160),
    observationIndex: action.observationIndex ?? null,
    callIndex: action.callIndex ?? null,
    provider: call.provider || '',
    model: call.model || '',
    valid: Boolean(call.valid),
    fallback: Boolean(call.fallback),
    reason: sanitizeText(call.reason || '').slice(0, 500),
  };
}

function summarizeDecisionAnalysis(analysis = null) {
  if (!analysis || typeof analysis !== 'object') return null;
  const output = {};
  // The response schema owns the analysis field list; never re-declare it.
  for (const key of REQUIRED_ANALYSIS_FIELDS) {
    if (!Array.isArray(analysis[key])) continue;
    output[key] = analysis[key]
      .map(value => sanitizeText(String(value || '')).slice(0, 420))
      .filter(Boolean)
      .slice(0, key === 'candidateChoices' ? 8 : 6);
  }
  return output;
}

function summarizeSeries(series) {
  if (!series) return null;
  return {
    key: series.key,
    sessionId: series.sessionId,
    agentP1: series.agentP1,
    agentP2: series.agentP2,
    createdAt: series.createdAt,
    updatedAt: series.updatedAt,
    totals: series.totals,
    games: (series.games || []).slice(-100),
  };
}
