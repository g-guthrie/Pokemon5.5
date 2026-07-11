import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {WebSocketServer} from 'ws';
import {REQUIRED_ANALYSIS_FIELDS, sanitizeText} from './agent-runtime.mjs';
import {BattleSession} from './battle-session.mjs';
import {moveCard, speciesCard} from './dex-context.mjs';
import {
  buildOpenRouterBenchmarkPlan,
  runOpenRouterBenchmarkSuite,
  writeBenchmarkPlan,
} from './benchmark-suite.mjs';
import {runLadderBatch} from './ladder-runner.mjs';
import {runWebSocketMatch} from './match-runner.mjs';
import {getSeries, loadSeriesStore, recordSeriesGame, resetSeries, saveSeriesStore} from './series-store.mjs';
import {runTournamentBatch} from './tournament-runner.mjs';
import {transcriptFromMatchArtifact, transcriptPathForArtifact} from './transcript.mjs';
import {mergeUsageSummaries, summarizeUsage} from './usage-summary.mjs';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const publicDir = path.join(rootDir, 'public');
const showdownClientDir = path.join(rootDir, 'vendor', 'pokemon-showdown-client', 'play.pokemonshowdown.com');
const artifactsDir = path.join(rootDir, 'artifacts');
const assetCacheDir = path.join(rootDir, 'artifacts', 'asset-cache');
const remoteAssetOrigin = 'https://play.pokemonshowdown.com';
const port = Number(process.env.PORT || 3107);
const DEFAULT_BATTLE_ID = 'local';
const DEFAULT_FORMAT = 'gen9randomdoublesbattle';

const battleSessions = new Map();
const clients = new Map();
// One running record per (session, exact model pairing): every finished game
// rolls in, whether it came from a single start or a multi-game run.
const seriesStorePath = path.join(artifactsDir, 'series-store.json');
let seriesStoreQueue = Promise.resolve();
// Visitor-session runs: sessionId -> run. The '' key is the legacy operator
// slot (battle 'local', no session), which CLI smokes and the operator page
// use unchanged.
const liveRuns = new Map();
const MAX_CONCURRENT_RUNS = clampNumber(process.env.MAX_CONCURRENT_RUNS, 1, 16, 3);
const MAX_BATTLE_SESSIONS = clampNumber(process.env.MAX_BATTLE_SESSIONS, 10, 10000, 300);
const BATTLE_SESSION_IDLE_MS = clampNumber(process.env.BATTLE_SESSION_IDLE_MS, 60000, 86400000, 3600000);
const MAX_COMPLETED_LIVE_RUNS = clampNumber(process.env.MAX_COMPLETED_LIVE_RUNS, 20, 5000, 250);
const LIVE_RUN_RETENTION_MS = clampNumber(process.env.LIVE_RUN_RETENTION_MS, 60000, 604800000, 86400000);
let ladderRun = null;
let tournamentRun = null;
let benchmarkRun = null;
let benchmarkTransition = null;
getBattle(DEFAULT_BATTLE_ID);

const server = http.createServer((req, res) => {
  // A synchronous throw here (malformed percent-encoding in the URL, a
  // battle-session cap, anything unexpected) must answer 400, never kill the
  // whole public server.
  try {
    handleHttpRequest(req, res);
  } catch (error) {
    if (!res.headersSent) {
      sendJson(res, {ok: false, error: sanitizeText(error?.message || 'Bad request')}, 400);
    } else {
      res.end();
    }
  }
});

function handleHttpRequest(req, res) {
  const url = new URL(req.url || '/', `http://${req.headers.host}`);
  if (url.pathname === '/api/state') {
    const battle = getBattleFromUrl(url);
    sendJson(res, {
      battleId: normalizeBattleId(url.searchParams.get('battleId') || url.searchParams.get('battle')),
      p1: battle.extractState('p1'),
      p2: battle.extractState('p2'),
      spectator: battle.extractState('spectator'),
    });
    return;
  }
  if (url.pathname === '/api/extract') {
    const battle = getBattleFromUrl(url);
    const role = normalizeRole(url.searchParams.get('role'));
    const state = battle.extractState(role);
    sendJson(res, state.extracted || state);
    return;
  }
  if (url.pathname === '/api/observations') {
    const battle = getBattleFromUrl(url);
    sendJson(res, {
      battleId: normalizeBattleId(url.searchParams.get('battleId') || url.searchParams.get('battle')),
      p1: battle.extractState('p1').extracted,
      p2: battle.extractState('p2').extracted,
      spectator: battle.extractState('spectator').extracted,
    });
    return;
  }
  if (url.pathname === '/api/battles') {
    pruneBattleSessions();
    sendJson(res, {
      defaultBattleId: DEFAULT_BATTLE_ID,
      battles: [...battleSessions.entries()].map(([battleId, battle]) => summarizeBattle(battleId, battle)),
    });
    return;
  }
  if (url.pathname === '/api/series' && req.method === 'GET') {
    void handleSeriesGetRequest(res, url);
    return;
  }
  if (url.pathname === '/api/series' && req.method === 'POST') {
    void handleSeriesPostRequest(req, res);
    return;
  }
  if (url.pathname === '/api/models') {
    void listPickableModels(res);
    return;
  }
  if (url.pathname === '/api/dex') {
    // Move/species cards for the decision deck — same tooltip facts the
    // prompt's dexContext carries, straight from the vendored dex.
    const names = param => String(url.searchParams.get(param) || '').split(',').map(name => name.trim()).filter(Boolean).slice(0, 80);
    sendJson(res, {
      moves: Object.fromEntries(names('moves').map(name => [name, moveCard(name)]).filter(([, card]) => card)),
      species: Object.fromEntries(names('species').map(name => [name, speciesCard(name)]).filter(([, card]) => card)),
    });
    return;
  }
  if (url.pathname === '/api/credits' && req.method === 'POST') {
    // The footer balance ticker polls this during runs; cheaper than a full
    // key validation (one upstream call) and rate-limited accordingly.
    if (!rateLimit(req, 'credits', 30, 60000)) {
      sendJson(res, {ok: false, error: 'Too many balance checks — wait a minute'}, 429);
      return;
    }
    void handleCreditsRequest(req, res);
    return;
  }
  if (url.pathname === '/api/key/validate' && req.method === 'POST') {
    if (!rateLimit(req, 'key-validate', 10, 60000)) {
      sendJson(res, {ok: false, error: 'Too many key checks — wait a minute'}, 429);
      return;
    }
    void handleKeyValidateRequest(req, res);
    return;
  }
  if (url.pathname === '/healthz') {
    sendJson(res, {ok: true, activeRuns: [...liveRuns.values()].filter(isRunActive).length, battles: battleSessions.size});
    return;
  }
  if (url.pathname === '/api/run' && req.method === 'GET') {
    const sessionId = normalizeSessionId(url.searchParams.get('session'));
    sendJson(res, {ok: true, run: summarizeLiveRun(liveRuns.get(sessionId) || null)});
    return;
  }
  if (url.pathname === '/api/run' && req.method === 'POST') {
    void handleRunRequest(req, res);
    return;
  }
  if (url.pathname === '/api/ladder' && req.method === 'GET') {
    sendJson(res, {ok: true, ladder: summarizeLadderRun(ladderRun)});
    return;
  }
  if (url.pathname === '/api/ladder' && req.method === 'POST') {
    void handleLadderRequest(req, res);
    return;
  }
  if (url.pathname === '/api/tournament' && req.method === 'GET') {
    sendJson(res, {ok: true, tournament: summarizeTournamentRun(tournamentRun)});
    return;
  }
  if (url.pathname === '/api/tournament' && req.method === 'POST') {
    void handleTournamentRequest(req, res);
    return;
  }
  if (url.pathname === '/api/benchmark' && req.method === 'GET') {
    sendJson(res, {ok: true, benchmark: summarizeBenchmarkRun(benchmarkRun)});
    return;
  }
  if (url.pathname === '/api/benchmark' && req.method === 'POST') {
    void handleBenchmarkRequest(req, res);
    return;
  }
  if (url.pathname === '/api/reset' && req.method === 'POST') {
    void handleResetRequest(req, res);
    return;
  }
  if (url.pathname.startsWith('/artifacts/')) {
    serveStaticFrom(artifactsDir, url.pathname.slice('/artifacts'.length), res);
    return;
  }
  if (url.pathname.startsWith('/ps/')) {
    serveStaticFrom(showdownClientDir, url.pathname.slice('/ps'.length), res, 'public, max-age=3600');
    return;
  }
  if (isShowdownAssetPath(url.pathname)) {
    serveShowdownAsset(url.pathname, res);
    return;
  }
  serveStatic(url.pathname, res);
}

const wss = new WebSocketServer({server, path: '/ws'});

wss.on('connection', (ws, req) => {
  try {
    handleWsConnection(ws, req);
  } catch (error) {
    send(ws, {type: 'error', error: sanitizeText(error?.message || error)});
    ws.close();
  }
});

function handleWsConnection(ws, req) {
  const url = new URL(req.url || '/', `http://${req.headers.host}`);
  const role = normalizeRole(url.searchParams.get('role'));
  const battleId = normalizeBattleId(url.searchParams.get('battleId') || url.searchParams.get('battle'));
  const waitForStart = url.searchParams.get('wait') === '1';
  const battle = battleSessions.get(battleId) || (waitForStart ? null : getBattle(battleId));
  clients.set(ws, {role, battleId, waitForStart});
  send(ws, {
    type: 'hello',
    role,
    battleId,
    formatid: battle?.formatid || DEFAULT_FORMAT,
    seed: battle?.seed || null,
    ready: Boolean(battle),
  });
  if (battle) {
    for (const chunk of protocolBacklogFor(battle, role)) {
      send(ws, {type: 'protocol', role, chunk});
    }
    send(ws, {type: 'state', role, state: battle.extractState(role)});
  } else {
    send(ws, {type: 'waiting', role, battleId, reason: 'BATTLE_NOT_STARTED'});
  }

  ws.on('message', message => {
    try {
      handleClientMessage(ws, battleId, role, JSON.parse(String(message)));
    } catch (error) {
      send(ws, {type: 'error', error: String(error?.message || error)});
    }
  });
  ws.on('close', () => {
    clients.delete(ws);
    pruneBattleSessions();
  });
}

server.listen(port, () => {
  console.log(`Pokemon Showdown benchmark harness running at http://localhost:${port}`);
});

for (const signalName of ['SIGTERM', 'SIGINT']) {
  process.on(signalName, () => {
    console.log(`${signalName} received; shutting down`);
    for (const run of liveRuns.values()) {
      if (isRunActive(run)) run.abortController.abort();
    }
    wss.close();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 5000).unref();
  });
}

function handleClientMessage(ws, battleId, role, message) {
  const battle = getBattle(battleId);
  if (message.type === 'choose') {
    if (role !== 'p1' && role !== 'p2') throw new Error('Only p1 and p2 can choose');
    battle.choose(role, message.choice, message.rqid ?? null);
    return;
  }
  if (message.type === 'auto') {
    if (role !== 'p1' && role !== 'p2') throw new Error('Only p1 and p2 can choose');
    const choice = battle.autoChoose(role);
    send(ws, {type: 'auto', choice});
    return;
  }
  if (message.type === 'reset') {
    resetBattle(battleId, {
      formatid: message.formatid,
      seed: Array.isArray(message.seed) ? message.seed.map(Number) : undefined,
    });
    return;
  }
  throw new Error(`Unknown message type: ${message.type}`);
}

function resetBattle(battleId = DEFAULT_BATTLE_ID, options = {}) {
  const id = normalizeBattleId(battleId);
  const battle = createBattle(id, options);
  for (const [ws, client] of clients) {
    if (client.battleId !== id) continue;
    send(ws, {type: 'reset', role: client.role, battleId: id, formatid: battle.formatid, seed: battle.seed});
    send(ws, {type: 'state', role: client.role, state: battle.extractState(client.role)});
  }
  return battle;
}

async function handleResetRequest(req, res) {
  try {
    const url = new URL(req.url || '/', `http://${req.headers.host}`);
    const body = await readJsonBody(req);
    const battleId = normalizeBattleId(body.battleId || body.battle || url.searchParams.get('battleId') || url.searchParams.get('battle'));
    const battle = resetBattle(battleId, {
      formatid: typeof body.formatid === 'string' ? body.formatid : undefined,
      seed: Array.isArray(body.seed) ? body.seed.map(Number).filter(Number.isFinite) : undefined,
      playerNames: body.playerNames && typeof body.playerNames === 'object'
        ? {p1: body.playerNames.p1, p2: body.playerNames.p2}
        : undefined,
    });
    sendJson(res, {ok: true, battleId, formatid: battle.formatid, seed: battle.seed});
  } catch (error) {
    res.writeHead(400, {'content-type': 'application/json; charset=utf-8'});
    res.end(JSON.stringify({ok: false, error: String(error?.message || error)}));
  }
}

async function handleRunRequest(req, res) {
  try {
    const body = await readJsonBody(req);
    const command = String(body.command || body.action || 'start').trim().toLowerCase();
    const sessionId = normalizeSessionId(body.sessionId);
    if (command === 'start') {
      if (!rateLimit(req, 'run-start', 6, 60000)) throw new Error('Too many match starts — wait a minute');
      const run = startLiveRun(body, sessionId);
      sendJson(res, {ok: true, run: summarizeLiveRun(run)});
      return;
    }
    const liveRun = liveRuns.get(sessionId) || null;
    if (command === 'pause') {
      if (!isRunActive(liveRun)) throw new Error('No active run to pause');
      liveRun.paused = true;
      liveRun.status = 'paused';
      sendJson(res, {ok: true, run: summarizeLiveRun(liveRun)});
      return;
    }
    if (command === 'resume') {
      if (!isRunActive(liveRun)) throw new Error('No active run to resume');
      resumeLiveRun(liveRun);
      sendJson(res, {ok: true, run: summarizeLiveRun(liveRun)});
      return;
    }
    if (command === 'reveal-mind') {
      if (!liveRun) throw new Error('No run to reveal');
      liveRun.revealOpponentMind = Boolean(body.reveal);
      sendJson(res, {ok: true, run: summarizeLiveRun(liveRun)});
      return;
    }
    if (command === 'stop') {
      if (!isRunActive(liveRun)) throw new Error('No active run to stop');
      liveRun.status = 'stopping';
      liveRun.paused = false;
      resumeLiveRun(liveRun);
      liveRun.abortController.abort();
      sendJson(res, {ok: true, run: summarizeLiveRun(liveRun)});
      return;
    }
    throw new Error(`Unknown run command: ${command}`);
  } catch (error) {
    sendJson(res, {ok: false, error: sanitizeText(error?.message || error)}, 400);
  }
}

function startLiveRun(body = {}, sessionId = '') {
  pruneLiveRuns();
  const existing = liveRuns.get(sessionId);
  if (isRunActive(existing)) throw new Error('You already have a match running — stop it first');
  const activeCount = [...liveRuns.values()].filter(isRunActive).length;
  if (activeCount >= MAX_CONCURRENT_RUNS) {
    throw new Error('The arena is at capacity right now — try again in a few minutes');
  }
  if (!sessionId) {
    // Legacy operator slot shares the machine with batch workflows.
    if (isLadderActive(ladderRun)) throw new Error(`Ladder already active: ${ladderRun.id}`);
    if (isTournamentActive(tournamentRun)) throw new Error(`Tournament already active: ${tournamentRun.id}`);
    if (isBenchmarkActive(benchmarkRun)) throw new Error(`Benchmark already active: ${benchmarkRun.id}`);
  }
  const id = `live-${new Date().toISOString().replace(/[:.]/g, '-')}${sessionId ? `-${sessionId.slice(0, 8)}` : ''}`;
  // Visitor sessions are pinned to their own battle so concurrent matches
  // never collide; the legacy no-session path keeps the shared 'local'.
  const battleId = sessionId
    ? normalizeBattleId(`s-${sessionId}`)
    : normalizeBattleId(body.battleId || body.battle || DEFAULT_BATTLE_ID);
  const outputPath = path.join(artifactsDir, 'live-runs', `${id}.json`);
  void pruneLiveArtifacts();
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

async function handleLadderRequest(req, res) {
  try {
    const body = await readJsonBody(req);
    const command = String(body.command || body.action || 'start').trim().toLowerCase();
    if (command === 'start') {
      const ladder = startServerLadder(body);
      sendJson(res, {ok: true, ladder: summarizeLadderRun(ladder)});
      return;
    }
    if (command === 'pause') {
      if (!isLadderActive(ladderRun)) throw new Error('No active ladder to pause');
      ladderRun.paused = true;
      ladderRun.status = 'paused';
      sendJson(res, {ok: true, ladder: summarizeLadderRun(ladderRun)});
      return;
    }
    if (command === 'resume') {
      if (!isLadderActive(ladderRun)) throw new Error('No active ladder to resume');
      resumeLadderRun(ladderRun);
      sendJson(res, {ok: true, ladder: summarizeLadderRun(ladderRun)});
      return;
    }
    if (command === 'stop') {
      if (!isLadderActive(ladderRun)) throw new Error('No active ladder to stop');
      ladderRun.status = 'stopping';
      ladderRun.paused = false;
      resumeLadderRun(ladderRun);
      ladderRun.abortController.abort();
      sendJson(res, {ok: true, ladder: summarizeLadderRun(ladderRun)});
      return;
    }
    throw new Error(`Unknown ladder command: ${command}`);
  } catch (error) {
    sendJson(res, {ok: false, error: sanitizeText(error?.message || error)}, 400);
  }
}

function startServerLadder(body = {}) {
  if (isLadderActive(ladderRun)) throw new Error(`Ladder already active: ${ladderRun.id}`);
  if (isRunActive(liveRuns.get(''))) throw new Error(`Run already active: ${liveRuns.get('').id}`);
  if (isTournamentActive(tournamentRun)) throw new Error(`Tournament already active: ${tournamentRun.id}`);
  if (isBenchmarkActive(benchmarkRun)) throw new Error(`Benchmark already active: ${benchmarkRun.id}`);
  const id = `ladder-${new Date().toISOString().replace(/[:.]/g, '-')}`;
  const outDir = path.join(artifactsDir, 'browser-ladders', id);
  const bestOf = normalizeBestOf(body.bestOf);
  const run = {
    id,
    status: body.startPaused ? 'paused' : 'running',
    startedAt: new Date().toISOString(),
    finishedAt: '',
    outDir,
    summaryPath: path.join(outDir, 'summary-latest.json'),
    summaryHref: '',
    battleCount: bestOf || clampNumber(body.battleCount, 1, 100, 2),
    bestOf,
    currentBattle: 0,
    maxTurns: clampNumber(body.maxTurns, 1, 200, 40),
    moveDelayMs: clampNumber(body.moveDelayMs, 0, 5000, 200),
    timeoutMs: clampNumber(body.timeoutMs, 1000, 300000, 30000),
    modelTimeoutMs: clampNumber(body.modelTimeoutMs, 1000, 600000, 240000),
    allowFallback: Boolean(body.allowFallback),
    watchLocal: body.watchLocal !== false,
    agentA: sanitizeAgentSpec(body.agentA || body.agentP1 || 'standin'),
    agentB: sanitizeAgentSpec(body.agentB || body.agentP2 || 'standin'),
    paused: Boolean(body.startPaused),
    pauseWaiters: [],
    abortController: new AbortController(),
    summary: null,
    lastBattle: null,
    error: '',
  };
  ladderRun = run;
  void runServerLadder(run);
  return run;
}

async function runServerLadder(run) {
  try {
    const summary = await runLadderBatch({
      serverOrigin: `http://localhost:${port}`,
      runId: run.id,
      outDir: run.outDir,
      battleCount: run.battleCount,
      bestOf: run.bestOf,
      maxTurns: run.maxTurns,
      moveDelayMs: run.moveDelayMs,
      timeoutMs: run.timeoutMs,
      modelTimeoutMs: run.modelTimeoutMs,
      allowFallback: run.allowFallback,
      watchLocal: run.watchLocal,
      agentA: run.agentA,
      agentB: run.agentB,
      signal: run.abortController.signal,
      waitIfPaused: () => waitIfLadderPaused(run),
      onBattleEnd: ({summary: partialSummary, battle}) => {
        run.currentBattle = partialSummary.battles.length;
        run.lastBattle = battle || null;
        run.summary = partialSummary;
      },
    });
    run.summary = summary;
    run.summaryPath = summary.summaryPath;
    run.summaryHref = summary.summaryHref || artifactHrefFor(summary.summaryPath);
    run.status = summary.aborted || run.abortController.signal.aborted ? 'stopped' : 'finished';
  } catch (error) {
    run.status = run.abortController.signal.aborted ? 'stopped' : 'error';
    run.error = sanitizeText(error?.message || error);
  } finally {
    run.paused = false;
    resumeLadderRun(run);
    run.finishedAt = new Date().toISOString();
  }
}

function waitIfLadderPaused(run) {
  if (!run.paused || !isLadderActive(run)) return Promise.resolve();
  run.status = 'paused';
  return new Promise(resolve => {
    run.pauseWaiters.push(resolve);
  });
}

function resumeLadderRun(run) {
  if (!run) return;
  run.paused = false;
  if (run.status === 'paused') run.status = 'running';
  const waiters = run.pauseWaiters.splice(0);
  for (const resolve of waiters) resolve();
}

function summarizeLadderRun(run) {
  if (!run) return null;
  return {
    id: run.id,
    status: run.status,
    startedAt: run.startedAt,
    finishedAt: run.finishedAt,
    battleCount: run.battleCount,
    bestOf: run.bestOf,
    currentBattle: run.currentBattle,
    maxTurns: run.maxTurns,
    moveDelayMs: run.moveDelayMs,
    timeoutMs: run.timeoutMs,
    modelTimeoutMs: run.modelTimeoutMs,
    allowFallback: run.allowFallback,
    watchLocal: run.watchLocal,
    agentA: run.agentA,
    agentB: run.agentB,
    paused: run.paused,
    outDir: run.outDir,
    summaryPath: run.summaryPath,
    summaryHref: run.summaryHref || artifactHrefFor(run.summaryPath),
    lastBattle: run.lastBattle,
    totals: run.summary?.totals || null,
    seriesWinner: run.summary?.seriesWinner || null,
    seriesValid: run.summary?.seriesValid ?? null,
    usage: run.summary?.usage || null,
    error: run.error,
  };
}

function normalizeBestOf(value) {
  const number = Number(value || 0);
  if (!Number.isFinite(number) || number < 1) return 0;
  const integer = Math.min(99, Math.floor(number));
  return integer % 2 === 1 ? integer : Math.max(1, integer - 1);
}

function isLadderActive(run) {
  return Boolean(run && ['running', 'paused', 'stopping'].includes(run.status));
}

async function handleTournamentRequest(req, res) {
  try {
    const body = await readJsonBody(req);
    const command = String(body.command || body.action || 'start').trim().toLowerCase();
    if (command === 'start') {
      const tournament = startServerTournament(body);
      sendJson(res, {ok: true, tournament: summarizeTournamentRun(tournament)});
      return;
    }
    if (command === 'pause') {
      if (!isTournamentActive(tournamentRun)) throw new Error('No active tournament to pause');
      tournamentRun.paused = true;
      tournamentRun.status = 'paused';
      sendJson(res, {ok: true, tournament: summarizeTournamentRun(tournamentRun)});
      return;
    }
    if (command === 'resume') {
      if (!isTournamentActive(tournamentRun)) throw new Error('No active tournament to resume');
      resumeTournamentRun(tournamentRun);
      sendJson(res, {ok: true, tournament: summarizeTournamentRun(tournamentRun)});
      return;
    }
    if (command === 'stop') {
      if (!isTournamentActive(tournamentRun)) throw new Error('No active tournament to stop');
      tournamentRun.status = 'stopping';
      tournamentRun.paused = false;
      resumeTournamentRun(tournamentRun);
      tournamentRun.abortController.abort();
      sendJson(res, {ok: true, tournament: summarizeTournamentRun(tournamentRun)});
      return;
    }
    throw new Error(`Unknown tournament command: ${command}`);
  } catch (error) {
    sendJson(res, {ok: false, error: sanitizeText(error?.message || error)}, 400);
  }
}

function startServerTournament(body = {}) {
  if (isTournamentActive(tournamentRun)) throw new Error(`Tournament already active: ${tournamentRun.id}`);
  if (isLadderActive(ladderRun)) throw new Error(`Ladder already active: ${ladderRun.id}`);
  if (isRunActive(liveRuns.get(''))) throw new Error(`Run already active: ${liveRuns.get('').id}`);
  if (isBenchmarkActive(benchmarkRun)) throw new Error(`Benchmark already active: ${benchmarkRun.id}`);
  const agentSpecs = parseTournamentAgents(body.agents || body.agentSpecs);
  const id = `tournament-${new Date().toISOString().replace(/[:.]/g, '-')}`;
  const outDir = path.join(artifactsDir, 'browser-tournaments', id);
  const pairCount = agentSpecs.length * (agentSpecs.length - 1) / 2;
  const run = {
    id,
    status: body.startPaused ? 'paused' : 'running',
    startedAt: new Date().toISOString(),
    finishedAt: '',
    outDir,
    summaryPath: path.join(outDir, 'summary-latest.json'),
    summaryHref: '',
    agentSpecs,
    agentCount: agentSpecs.length,
    pairCount,
    currentPair: 0,
    battlesPerPair: clampNumber(body.battlesPerPair, 1, 100, 1),
    completedBattles: 0,
    scheduledBattles: pairCount * clampNumber(body.battlesPerPair, 1, 100, 1),
    maxTurns: clampNumber(body.maxTurns, 1, 200, 40),
    moveDelayMs: clampNumber(body.moveDelayMs, 0, 5000, 200),
    timeoutMs: clampNumber(body.timeoutMs, 1000, 120000, 30000),
    modelTimeoutMs: clampNumber(body.modelTimeoutMs, 1000, 600000, 240000),
    allowFallback: Boolean(body.allowFallback),
    watchLocal: body.watchLocal !== false,
    paused: Boolean(body.startPaused),
    pauseWaiters: [],
    abortController: new AbortController(),
    summary: null,
    lastPair: null,
    error: '',
  };
  tournamentRun = run;
  void runServerTournament(run);
  return run;
}

async function runServerTournament(run) {
  try {
    const summary = await runTournamentBatch({
      serverOrigin: `http://localhost:${port}`,
      runId: run.id,
      outDir: run.outDir,
      agents: run.agentSpecs,
      battlesPerPair: run.battlesPerPair,
      maxTurns: run.maxTurns,
      moveDelayMs: run.moveDelayMs,
      timeoutMs: run.timeoutMs,
      modelTimeoutMs: run.modelTimeoutMs,
      allowFallback: run.allowFallback,
      watchLocal: run.watchLocal,
      signal: run.abortController.signal,
      waitIfPaused: () => waitIfTournamentPaused(run),
      onPairEnd: ({summary: partialSummary, pair}) => {
        run.currentPair = partialSummary.pairs.length;
        run.completedBattles = partialSummary.totals.completedBattles;
        run.lastPair = pair || null;
        run.summary = partialSummary;
      },
    });
    run.summary = summary;
    run.currentPair = summary.pairs.length;
    run.completedBattles = summary.completedBattles || summary.totals?.completedBattles || 0;
    run.summaryPath = summary.summaryPath;
    run.summaryHref = summary.summaryHref || artifactHrefFor(summary.summaryPath);
    run.status = summary.aborted || run.abortController.signal.aborted ? 'stopped' : 'finished';
  } catch (error) {
    run.status = run.abortController.signal.aborted ? 'stopped' : 'error';
    run.error = sanitizeText(error?.message || error);
  } finally {
    run.paused = false;
    resumeTournamentRun(run);
    run.finishedAt = new Date().toISOString();
  }
}

function waitIfTournamentPaused(run) {
  if (!run.paused || !isTournamentActive(run)) return Promise.resolve();
  run.status = 'paused';
  return new Promise(resolve => {
    run.pauseWaiters.push(resolve);
  });
}

function resumeTournamentRun(run) {
  if (!run) return;
  run.paused = false;
  if (run.status === 'paused') run.status = 'running';
  const waiters = run.pauseWaiters.splice(0);
  for (const resolve of waiters) resolve();
}

function summarizeTournamentRun(run) {
  if (!run) return null;
  return {
    id: run.id,
    status: run.status,
    startedAt: run.startedAt,
    finishedAt: run.finishedAt,
    agentSpecs: run.agentSpecs,
    agentCount: run.agentCount,
    pairCount: run.pairCount,
    currentPair: run.currentPair,
    battlesPerPair: run.battlesPerPair,
    completedBattles: run.completedBattles,
    scheduledBattles: run.scheduledBattles,
    maxTurns: run.maxTurns,
    moveDelayMs: run.moveDelayMs,
    timeoutMs: run.timeoutMs,
    modelTimeoutMs: run.modelTimeoutMs,
    allowFallback: run.allowFallback,
    watchLocal: run.watchLocal,
    paused: run.paused,
    outDir: run.outDir,
    summaryPath: run.summaryPath,
    summaryHref: run.summaryHref || artifactHrefFor(run.summaryPath),
    lastPair: run.lastPair,
    totals: run.summary?.totals || null,
    standings: run.summary?.standings || null,
    usage: run.summary?.usage || null,
    error: run.error,
  };
}

function isTournamentActive(run) {
  return Boolean(run && ['running', 'paused', 'stopping'].includes(run.status));
}

async function handleBenchmarkRequest(req, res) {
  try {
    const body = await readJsonBody(req);
    const command = String(body.command || body.action || 'plan').trim().toLowerCase();
    if (command === 'plan' || command === 'preview') {
      const benchmark = await planServerBenchmark(body);
      sendJson(res, {ok: true, benchmark: summarizeBenchmarkRun(benchmark)});
      return;
    }
    if (command === 'start' || command === 'run') {
      const benchmark = await startServerBenchmark(body);
      sendJson(res, {ok: true, benchmark: summarizeBenchmarkRun(benchmark)});
      return;
    }
    if (command === 'pause') {
      if (!isBenchmarkActive(benchmarkRun)) throw new Error('No active benchmark to pause');
      benchmarkRun.paused = true;
      benchmarkRun.status = 'paused';
      sendJson(res, {ok: true, benchmark: summarizeBenchmarkRun(benchmarkRun)});
      return;
    }
    if (command === 'resume') {
      if (!isBenchmarkActive(benchmarkRun)) throw new Error('No active benchmark to resume');
      resumeBenchmarkRun(benchmarkRun);
      sendJson(res, {ok: true, benchmark: summarizeBenchmarkRun(benchmarkRun)});
      return;
    }
    if (command === 'stop') {
      if (!isBenchmarkActive(benchmarkRun)) throw new Error('No active benchmark to stop');
      benchmarkRun.status = 'stopping';
      benchmarkRun.paused = false;
      resumeBenchmarkRun(benchmarkRun);
      benchmarkRun.abortController.abort();
      sendJson(res, {ok: true, benchmark: summarizeBenchmarkRun(benchmarkRun)});
      return;
    }
    throw new Error(`Unknown benchmark command: ${command}`);
  } catch (error) {
    sendJson(res, {ok: false, error: sanitizeText(error?.message || error)}, 400);
  }
}

async function planServerBenchmark(body = {}) {
  if (isBenchmarkActive(benchmarkRun)) throw new Error(`Benchmark already active: ${benchmarkRun.id}`);
  const transition = claimBenchmarkTransition('planning');
  try {
    const id = `benchmark-${new Date().toISOString().replace(/[:.]/g, '-')}`;
    const outDir = path.join(artifactsDir, 'benchmark-suites', id);
    const plan = await buildServerBenchmarkPlan(body);
    const planPath = path.join(outDir, 'suite-plan.json');
    await writeBenchmarkPlan(plan, planPath);
    const run = createBenchmarkRun({
      body,
      id,
      outDir,
      plan,
      planPath,
      status: 'planned',
    });
    benchmarkRun = run;
    return run;
  } finally {
    releaseBenchmarkTransition(transition);
  }
}

async function startServerBenchmark(body = {}) {
  if (!paidBenchmarkConfirmed(body)) {
    throw new Error('Refusing paid benchmark run unless runPaidBenchmark is true');
  }
  if (isBenchmarkActive(benchmarkRun)) throw new Error(`Benchmark already active: ${benchmarkRun.id}`);
  if (isTournamentActive(tournamentRun)) throw new Error(`Tournament already active: ${tournamentRun.id}`);
  if (isLadderActive(ladderRun)) throw new Error(`Ladder already active: ${ladderRun.id}`);
  if (isRunActive(liveRuns.get(''))) throw new Error(`Run already active: ${liveRuns.get('').id}`);
  const transition = claimBenchmarkTransition('starting');
  try {
    const usePlanned = benchmarkRun?.status === 'planned' && body.usePlanned !== false && benchmarkRun.plan;
    const id = usePlanned ? benchmarkRun.id : `benchmark-${new Date().toISOString().replace(/[:.]/g, '-')}`;
    const outDir = usePlanned ? benchmarkRun.outDir : path.join(artifactsDir, 'benchmark-suites', id);
    const plan = usePlanned ? benchmarkRun.plan : await buildServerBenchmarkPlan(body);
    const planPath = usePlanned ? benchmarkRun.planPath : path.join(outDir, 'suite-plan.json');
    if (!usePlanned) await writeBenchmarkPlan(plan, planPath);

    const run = createBenchmarkRun({
      body,
      id,
      outDir,
      plan,
      planPath,
      status: body.startPaused ? 'paused' : 'running',
    });
    run.startedAt = new Date().toISOString();
    run.runPaidBenchmark = true;
    benchmarkRun = run;
    void runServerBenchmark(run);
    return run;
  } finally {
    releaseBenchmarkTransition(transition);
  }
}

function claimBenchmarkTransition(kind) {
  if (benchmarkTransition) {
    throw new Error(`Benchmark ${benchmarkTransition.kind} already in progress`);
  }
  const token = Symbol(kind);
  benchmarkTransition = {token, kind, startedAt: new Date().toISOString()};
  return token;
}

function releaseBenchmarkTransition(token) {
  if (benchmarkTransition?.token === token) benchmarkTransition = null;
}

function createBenchmarkRun({body = {}, id, outDir, plan, planPath, status}) {
  const battlesPerPair = clampNumber(body.battlesPerPair ?? body.battleCount, 1, 100, 2);
  const pairCount = plan?.pairs?.length || 0;
  return {
    id,
    status,
    plannedAt: new Date().toISOString(),
    startedAt: '',
    finishedAt: '',
    outDir,
    planPath,
    planHref: artifactHrefFor(planPath),
    summaryPath: path.join(outDir, 'summary-latest.json'),
    summaryHref: '',
    openRouterLimit: clampNumber(body.openRouterLimit, 1, 32, 10),
    openaiBaselines: benchmarkList(body.openaiBaselines, ['openai:gpt-5.5:low', 'openai:gpt-5.5:medium']),
    battlesPerPair,
    pairCount,
    currentPair: 0,
    completedBattles: 0,
    scheduledBattles: pairCount * battlesPerPair,
    maxTurns: clampNumber(body.maxTurns, 1, 200, 40),
    moveDelayMs: clampNumber(body.moveDelayMs, 0, 5000, 20),
    timeoutMs: clampNumber(body.timeoutMs, 1000, 300000, 180000),
    modelTimeoutMs: clampNumber(body.modelTimeoutMs, 1000, 600000, 240000),
    allowFallback: Boolean(body.allowFallback),
    watchLocal: body.watchLocal !== false,
    runPaidBenchmark: paidBenchmarkConfirmed(body),
    paused: Boolean(body.startPaused),
    pauseWaiters: [],
    abortController: new AbortController(),
    plan,
    summary: null,
    lastPair: null,
    error: '',
  };
}

async function buildServerBenchmarkPlan(body = {}) {
  return buildOpenRouterBenchmarkPlan({
    name: sanitizeText(String(body.name || 'openrouter-top-vs-openai')).slice(0, 120),
    modelCatalog: Array.isArray(body.modelCatalog) ? body.modelCatalog : undefined,
    rankedCandidates: Array.isArray(body.rankedCandidates) ? body.rankedCandidates : undefined,
    openRouterLimit: clampNumber(body.openRouterLimit, 1, 32, 10),
    openaiBaselines: benchmarkList(body.openaiBaselines, ['openai:gpt-5.5:low', 'openai:gpt-5.5:medium']),
    reasoningEffort: sanitizeText(String(body.reasoningEffort || 'low')).slice(0, 20),
  });
}

async function runServerBenchmark(run) {
  try {
    const summary = await runOpenRouterBenchmarkSuite({
      serverOrigin: `http://localhost:${port}`,
      runId: run.id,
      outDir: run.outDir,
      plan: run.plan,
      battlesPerPair: run.battlesPerPair,
      maxTurns: run.maxTurns,
      moveDelayMs: run.moveDelayMs,
      timeoutMs: run.timeoutMs,
      allowFallback: run.allowFallback,
      watchLocal: run.watchLocal,
      signal: run.abortController.signal,
      waitIfPaused: () => waitIfBenchmarkPaused(run),
      onPairEnd: ({summary: partialSummary, pair}) => {
        run.currentPair = partialSummary.totals?.completedPairs || partialSummary.pairs?.length || 0;
        run.completedBattles = partialSummary.totals?.completedBattles || 0;
        run.lastPair = pair || null;
        run.summary = partialSummary;
      },
    });
    run.summary = summary;
    run.currentPair = summary.totals?.completedPairs || summary.pairs?.length || 0;
    run.completedBattles = summary.totals?.completedBattles || 0;
    run.summaryPath = summary.summaryPath;
    run.summaryHref = summary.summaryHref || artifactHrefFor(summary.summaryPath);
    run.status = summary.aborted || run.abortController.signal.aborted ? 'stopped' : 'finished';
  } catch (error) {
    run.status = run.abortController.signal.aborted ? 'stopped' : 'error';
    run.error = sanitizeText(error?.message || error);
  } finally {
    run.paused = false;
    resumeBenchmarkRun(run);
    run.finishedAt = new Date().toISOString();
  }
}

function waitIfBenchmarkPaused(run) {
  if (!run.paused || !isBenchmarkActive(run)) return Promise.resolve();
  run.status = 'paused';
  return new Promise(resolve => {
    run.pauseWaiters.push(resolve);
  });
}

function resumeBenchmarkRun(run) {
  if (!run) return;
  run.paused = false;
  if (run.status === 'paused') run.status = 'running';
  const waiters = run.pauseWaiters.splice(0);
  for (const resolve of waiters) resolve();
}

function summarizeBenchmarkRun(run) {
  if (!run) return null;
  const planSummary = summarizeBenchmarkPlan(run.plan);
  return {
    id: run.id,
    status: run.status,
    plannedAt: run.plannedAt,
    startedAt: run.startedAt,
    finishedAt: run.finishedAt,
    openRouterLimit: run.openRouterLimit,
    openaiBaselines: planSummary.openaiBaselines,
    openrouterModels: planSummary.openrouterModels,
    excludedOpenRouterCandidates: planSummary.excludedOpenRouterCandidates,
    pairCount: run.pairCount,
    currentPair: run.currentPair,
    battlesPerPair: run.battlesPerPair,
    completedBattles: run.completedBattles,
    scheduledBattles: run.scheduledBattles,
    maxTurns: run.maxTurns,
    moveDelayMs: run.moveDelayMs,
    timeoutMs: run.timeoutMs,
    modelTimeoutMs: run.modelTimeoutMs,
    allowFallback: run.allowFallback,
    watchLocal: run.watchLocal,
    runPaidBenchmark: run.runPaidBenchmark,
    paused: run.paused,
    outDir: run.outDir,
    planPath: run.planPath,
    planHref: run.planHref || artifactHrefFor(run.planPath),
    summaryPath: run.summaryPath,
    summaryHref: run.summaryHref || artifactHrefFor(run.summaryPath),
    lastPair: run.lastPair,
    totals: run.summary?.totals || null,
    usage: run.summary?.usage || null,
    error: run.error,
  };
}

function summarizeBenchmarkPlan(plan = {}) {
  return {
    openaiBaselines: (plan.openaiBaselines || []).map(agent => ({
      provider: agent.provider,
      model: agent.model,
      name: agent.name,
      agentSpec: agent.agentSpec,
      reasoningEffort: agent.reasoningEffort,
    })),
    openrouterModels: (plan.openrouterModels || []).map(model => ({
      rank: model.rank,
      id: model.id,
      name: model.name,
      agentSpec: model.agentSpec,
      reasoningEffort: model.reasoningEffort,
      selectionSource: model.selectionSource,
    })),
    excludedOpenRouterCandidates: (plan.excludedOpenRouterCandidates || []).map(item => ({
      rank: item.rank,
      id: item.id,
      label: item.label,
      reason: item.reason,
    })),
  };
}

function isBenchmarkActive(run) {
  return Boolean(run && ['running', 'paused', 'stopping'].includes(run.status));
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
      serverOrigin: `http://localhost:${port}`,
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
    await fs.promises.writeFile(transcriptPath, transcriptFromMatchArtifact(result));
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
    return result;
  });
  seriesStoreQueue = task.then(() => {}, () => {});
  return task;
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

async function handleSeriesGetRequest(res, url) {
  try {
    const identity = {
      sessionId: normalizeSessionId(url.searchParams.get('session')),
      agentP1: sanitizeAgentSpec(url.searchParams.get('agentP1')),
      agentP2: sanitizeAgentSpec(url.searchParams.get('agentP2')),
    };
    const store = await loadSeriesStore(seriesStorePath);
    sendJson(res, {ok: true, series: summarizeSeries(getSeries(store, identity))});
  } catch (error) {
    sendJson(res, {ok: false, error: sanitizeText(error?.message || error)}, 400);
  }
}

async function handleSeriesPostRequest(req, res) {
  try {
    const body = await readJsonBody(req);
    const command = String(body.command || body.action || '').trim().toLowerCase();
    if (command !== 'reset') throw new Error(`Unknown series command: ${command}`);
    const identity = {
      sessionId: normalizeSessionId(body.sessionId),
      agentP1: sanitizeAgentSpec(body.agentP1),
      agentP2: sanitizeAgentSpec(body.agentP2),
    };
    await withSeriesStore(store => resetSeries(store, identity));
    const activeRun = liveRuns.get(identity.sessionId);
    if (activeRun && activeRun.agentP1 === identity.agentP1 && activeRun.agentP2 === identity.agentP2) {
      activeRun.series = null;
    }
    sendJson(res, {ok: true, series: null});
  } catch (error) {
    sendJson(res, {ok: false, error: sanitizeText(error?.message || error)}, 400);
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
      .slice(0, key === 'candidateChoices' || key === 'replacementMatchups' ? 8 : 6);
  }
  return output;
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

function liveRunPhase(run) {
  if (!run) return 'idle';
  if (run.paused || run.status === 'paused') return 'paused';
  // A stopped run is not a finished one: the viewer killed it mid-game, and
  // the status pill must say so instead of presenting a phantom result.
  if (run.status === 'stopped') return 'stopped';
  if (run.status === 'finished') return 'finished';
  if (run.status === 'error') return 'error';
  const phases = Object.values(run.roleStates || {}).map(state => state?.phase);
  if (phases.includes('error')) return 'error';
  if (phases.includes('thinking')) return 'thinking';
  if (phases.includes('decision-ready')) return 'decision-ready';
  if (phases.includes('submitted')) return 'resolving';
  return 'preparing';
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

function isRunActive(run) {
  return Boolean(run && ['running', 'paused', 'stopping'].includes(run.status));
}

function artifactHrefFor(filePath = '') {
  if (!filePath) return '';
  const relative = path.relative(artifactsDir, path.resolve(filePath));
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) return '';
  return `/artifacts/${relative.split(path.sep).map(encodeURIComponent).join('/')}`;
}

function normalizeSessionId(value) {
  return String(value || '').trim().toLowerCase().replace(/[^a-z0-9-]+/g, '').slice(0, 24);
}

// Fixed-window per-IP rate limiter for the endpoints a stranger could abuse.
const rateBuckets = new Map();

function requestIp(req) {
  if (process.env.TRUST_PROXY === '1') {
    const forwarded = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
    if (forwarded) return forwarded;
  }
  return req.socket?.remoteAddress || 'unknown';
}

function rateLimit(req, bucketName, limit, windowMs) {
  const key = `${bucketName}:${requestIp(req)}`;
  const now = Date.now();
  const bucket = rateBuckets.get(key) || [];
  const fresh = bucket.filter(at => now - at < windowMs);
  if (fresh.length >= limit) {
    rateBuckets.set(key, fresh);
    return false;
  }
  fresh.push(now);
  rateBuckets.set(key, fresh);
  if (rateBuckets.size > 5000) rateBuckets.clear(); // crude memory bound
  return true;
}

// Keep the newest N live-run artifacts (json + events pairs); a public server
// should not grow its disk without bound.
const MAX_LIVE_ARTIFACTS = clampNumber(process.env.MAX_LIVE_ARTIFACTS, 20, 100000, 400);
let pruning = false;

async function pruneLiveArtifacts() {
  if (pruning) return;
  pruning = true;
  try {
    const dir = path.join(artifactsDir, 'live-runs');
    const entries = (await fs.promises.readdir(dir).catch(() => []))
      .filter(name => name.endsWith('.json') && !name.endsWith('.events.jsonl'));
    if (entries.length <= MAX_LIVE_ARTIFACTS) return;
    const stats = await Promise.all(entries.map(async name => ({
      name,
      mtime: (await fs.promises.stat(path.join(dir, name)).catch(() => ({mtimeMs: 0}))).mtimeMs || 0,
    })));
    stats.sort((a, b) => b.mtime - a.mtime);
    for (const {name} of stats.slice(MAX_LIVE_ARTIFACTS)) {
      await fs.promises.rm(path.join(dir, name), {force: true});
      await fs.promises.rm(path.join(dir, name.replace(/\.json$/, '.events.jsonl')), {force: true});
      await fs.promises.rm(path.join(dir, name.replace(/\.json$/, '.transcript.txt')), {force: true});
    }
  } catch {
    // retention is best-effort
  } finally {
    pruning = false;
  }
}

function normalizeProviderKeys(body = {}) {
  const keys = {};
  const openrouter = typeof body.openrouterKey === 'string' ? body.openrouterKey.trim() : '';
  if (openrouter && openrouter.length <= 250) keys.openrouter = openrouter;
  return keys;
}

// Remaining OpenRouter balance for the footer ticker. The key is never
// logged or stored; only the balance number is returned.
async function handleCreditsRequest(req, res) {
  try {
    const body = await readJsonBody(req);
    const rawKey = body.key || body.openrouterKey;
    const key = typeof rawKey === 'string' ? rawKey.trim() : '';
    if (!key || key.length > 250) {
      sendJson(res, {ok: false, error: 'No key provided'}, 400);
      return;
    }
    const response = await fetch('https://openrouter.ai/api/v1/credits', {headers: {authorization: `Bearer ${key}`}});
    if (!response.ok) {
      sendJson(res, {ok: false, error: `OpenRouter rejected the key (HTTP ${response.status})`}, 200);
      return;
    }
    const credits = (await response.json().catch(() => ({}))).data || {};
    const balance = Number(credits.total_credits || 0) - Number(credits.total_usage || 0);
    sendJson(res, {ok: true, balance: Number.isFinite(balance) ? Math.round(balance * 10000) / 10000 : null});
  } catch {
    sendJson(res, {ok: false, error: 'Could not reach OpenRouter'}, 200);
  }
}

// Validates a visitor key without making an inference call. The key is never
// logged or stored; only non-secret account/provider facts are returned.
async function handleKeyValidateRequest(req, res) {
  try {
    const body = await readJsonBody(req);
    const provider = 'openrouter';
    const rawKey = body.key || body.openrouterKey;
    const key = typeof rawKey === 'string' ? rawKey.trim() : '';
    if (!key || key.length > 250) {
      sendJson(res, {ok: false, error: 'No key provided'}, 400);
      return;
    }
    const [authResponse, creditsResponse] = await Promise.all([
      fetch('https://openrouter.ai/api/v1/auth/key', {headers: {authorization: `Bearer ${key}`}}),
      fetch('https://openrouter.ai/api/v1/credits', {headers: {authorization: `Bearer ${key}`}}),
    ]);
    if (!authResponse.ok) {
      sendJson(res, {ok: false, error: `OpenRouter rejected the key (HTTP ${authResponse.status})`}, 200);
      return;
    }
    const auth = (await authResponse.json().catch(() => ({}))).data || {};
    const credits = (await creditsResponse.json().catch(() => ({}))).data || {};
    const balance = Number(credits.total_credits || 0) - Number(credits.total_usage || 0);
    sendJson(res, {
      ok: true,
      provider,
      balance: Number.isFinite(balance) ? Math.round(balance * 100) / 100 : null,
      limitRemaining: Number.isFinite(Number(auth.limit_remaining)) ? Math.round(Number(auth.limit_remaining) * 100) / 100 : null,
    });
  } catch (error) {
    sendJson(res, {ok: false, error: 'Could not reach the provider to validate the key'}, 200);
  }
}

function sanitizeAgentSpec(value) {
  return sanitizeText(String(value || 'standin').trim()).slice(0, 160) || 'standin';
}

function parseTournamentAgents(value) {
  const raw = Array.isArray(value) ? value : String(value || 'standin, heuristic, standin:alt').split(',');
  const agents = raw
    .map(sanitizeAgentSpec)
    .filter(Boolean)
    .slice(0, 16);
  if (agents.length < 2) throw new Error('Tournament needs at least two agents');
  return agents;
}

function benchmarkList(value, fallback = []) {
  const raw = Array.isArray(value) ? value : String(value || '').split(',');
  const items = raw
    .map(item => sanitizeText(String(item || '').trim()).slice(0, 160))
    .filter(Boolean)
    .slice(0, 32);
  return items.length ? items : fallback;
}

function paidBenchmarkConfirmed(body = {}) {
  return body.runPaidBenchmark === true || body.confirmPaid === true;
}

function clampNumber(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, number));
}

function parseRunSeed(value) {
  if (!Array.isArray(value)) return null;
  const seed = value.map(Number).filter(Number.isFinite);
  return seed.length === 4 ? seed : null;
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', chunk => {
      body += chunk;
      if (body.length > 10000) {
        reject(new Error('Request body too large'));
        req.destroy();
      }
    });
    req.on('end', () => {
      if (!body.trim()) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(body));
      } catch {
        reject(new Error('Invalid JSON body'));
      }
    });
    req.on('error', reject);
  });
}

function broadcastBattleEvent(battleId, sourceBattle, event) {
  if (battleSessions.get(battleId) !== sourceBattle) return;
  for (const [ws, client] of clients) {
    if (client.battleId !== battleId) continue;
    const role = client.role;
    if (event.type === 'protocol') {
      // Players get only their own channel (it already contains the public
      // lines plus their private requests); spectators get the public channel.
      if (role === 'p1' || role === 'p2') {
        if (event.role === role) send(ws, event);
      } else if (event.role === 'spectator') {
        send(ws, event);
      }
    } else if (event.type === 'state') {
      if (event.role === role) send(ws, event);
    } else if (event.type === 'choice') {
      if (event.role === role || role === 'spectator') send(ws, event);
    } else {
      send(ws, event);
    }
  }
}

function getBattleFromUrl(url) {
  return getBattle(normalizeBattleId(url.searchParams.get('battleId') || url.searchParams.get('battle')));
}

function getBattle(battleId = DEFAULT_BATTLE_ID) {
  const id = normalizeBattleId(battleId);
  if (!battleSessions.has(id)) createBattle(id);
  return battleSessions.get(id);
}

function createBattle(battleId = DEFAULT_BATTLE_ID, options = {}) {
  const id = normalizeBattleId(battleId);
  // Every session is a full simulator battle; a stranger cycling random
  // battleIds (via any battle-scoped endpoint or /api/reset) must not be
  // able to grow the map without bound.
  if (!battleSessions.has(id)) {
    if (battleSessions.size >= MAX_BATTLE_SESSIONS) pruneBattleSessions();
    if (battleSessions.size >= MAX_BATTLE_SESSIONS) {
      throw new Error('Too many concurrent battles — try again shortly');
    }
  }
  const battle = new BattleSession(options);
  battle.createdAt = Date.now();
  battle.onEvent(event => broadcastBattleEvent(id, battle, event));
  battleSessions.set(id, battle);
  return battle;
}

function normalizeBattleId(value) {
  const id = String(value || DEFAULT_BATTLE_ID).trim().toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '');
  return id.slice(0, 80) || DEFAULT_BATTLE_ID;
}

function normalizeRole(role) {
  if (role === 'p1' || role === 'p2') return role;
  return 'spectator';
}

function protocolBacklogFor(battle, role) {
  if (role === 'p1' || role === 'p2') {
    return [...(battle.protocol[role] || [])];
  }
  return battle.protocol.spectator?.length ? battle.protocol.spectator : battle.protocol.omniscient || [];
}

function summarizeBattle(battleId, battle) {
  const spectator = battle.extractState('spectator');
  return {
    battleId,
    formatid: battle.formatid,
    seed: battle.seed,
    turn: spectator.turn,
    ended: spectator.ended,
    winner: spectator.winner,
    clients: [...clients.values()].filter(client => client.battleId === battleId).length,
  };
}

function pruneBattleSessions() {
  const now = Date.now();
  for (const [battleId, battle] of battleSessions) {
    if (battleId === DEFAULT_BATTLE_ID) continue;
    const clientCount = [...clients.values()].filter(client => client.battleId === battleId).length;
    if (clientCount > 0) continue;
    // Ended battles go as soon as nobody is watching; abandoned unfinished
    // ones (a visitor created it and left) go after an idle hour.
    const abandoned = now - (battle.createdAt || 0) > BATTLE_SESSION_IDLE_MS;
    if (battle.public?.ended || abandoned) {
      battleSessions.delete(battleId);
    }
  }
}

function pruneLiveRuns() {
  const now = Date.now();
  const completed = [...liveRuns.entries()]
    .filter(([sessionId, run]) => sessionId && run && !isRunActive(run))
    .sort(([, a], [, b]) => String(b.finishedAt || b.startedAt).localeCompare(String(a.finishedAt || a.startedAt)));
  for (const [index, [sessionId, run]] of completed.entries()) {
    const finishedAt = Date.parse(run.finishedAt || run.startedAt || '') || 0;
    if (index >= MAX_COMPLETED_LIVE_RUNS || (finishedAt && now - finishedAt > LIVE_RUN_RETENTION_MS)) {
      liveRuns.delete(sessionId);
    }
  }
}

function send(ws, payload) {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(payload));
}

function sendJson(res, payload, status = 200) {
  res.writeHead(status, {'content-type': 'application/json; charset=utf-8'});
  res.end(JSON.stringify(payload, null, 2));
}

// OpenRouter model catalog for the arena's model picker: no auth required,
// cached for an hour, filtered to models that advertise strict structured
// outputs (the benchmark requires exact-legal-choice JSON).
let modelCatalogCache = {at: 0, models: []};

async function listPickableModels(res) {
  const maxAgeMs = 60 * 60 * 1000;
  if (Date.now() - modelCatalogCache.at > maxAgeMs) {
    try {
      const response = await fetch('https://openrouter.ai/api/v1/models');
      if (response.ok) {
        const body = await response.json();
        const models = (body.data || [])
          .filter(model => {
            const parameters = model.supported_parameters || [];
            return parameters.includes('structured_outputs') || parameters.includes('response_format');
          })
          .map(model => ({
            id: sanitizeText(String(model.id || '')).slice(0, 120),
            name: sanitizeText(String(model.name || model.id || '')).slice(0, 160),
            promptPricePerM: Math.round(Number(model.pricing?.prompt || 0) * 1e6 * 1000) / 1000,
            completionPricePerM: Math.round(Number(model.pricing?.completion || 0) * 1e6 * 1000) / 1000,
            contextLength: Number(model.context_length || 0) || null,
            // Whether the model advertises a tunable reasoning-effort dial.
            reasoning: (model.supported_parameters || []).includes('reasoning'),
          }))
          .filter(model => model.id)
          .sort((a, b) => a.id.localeCompare(b.id));
        if (models.length) modelCatalogCache = {at: Date.now(), models};
      }
    } catch {
      // fall through to whatever is cached
    }
  }
  sendJson(res, {
    fetchedAt: modelCatalogCache.at ? new Date(modelCatalogCache.at).toISOString() : '',
    count: modelCatalogCache.models.length,
    models: modelCatalogCache.models,
  });
}

function serveStatic(urlPath, res) {
  serveStaticFrom(publicDir, urlPath, res);
}

function isShowdownAssetPath(urlPath) {
  return (
    urlPath.startsWith('/data/') ||
    urlPath.startsWith('/sprites/') ||
    urlPath.startsWith('/audio/') ||
    urlPath.startsWith('/fx/')
  );
}

function serveShowdownAsset(urlPath, res) {
  const cleanPath = safeRelativePath(urlPath);
  if (!cleanPath) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }

  const localPath = path.join(showdownClientDir, cleanPath);
  fs.readFile(localPath, (localError, localData) => {
    if (!localError) {
      res.writeHead(200, {'content-type': contentType(localPath), 'cache-control': 'public, max-age=3600'});
      res.end(localData);
      return;
    }
    void serveCachedRemoteAsset(cleanPath, res);
  });
}

async function serveCachedRemoteAsset(cleanPath, res) {
  const cachePath = path.join(assetCacheDir, cleanPath);
  try {
    const cachedData = await fs.promises.readFile(cachePath);
    res.writeHead(200, {'content-type': contentType(cachePath), 'cache-control': 'public, max-age=3600'});
    res.end(cachedData);
    return;
  } catch {}

  try {
    const response = await fetch(`${remoteAssetOrigin}/${cleanPath}`);
    if (!response.ok) {
      res.writeHead(response.status);
      res.end(`Remote asset ${response.status}`);
      return;
    }
    const data = Buffer.from(await response.arrayBuffer());
    await fs.promises.mkdir(path.dirname(cachePath), {recursive: true});
    await fs.promises.writeFile(cachePath, data);
    res.writeHead(200, {
      'content-type': response.headers.get('content-type') || contentType(cachePath),
      'cache-control': 'public, max-age=3600',
    });
    res.end(data);
  } catch (error) {
    res.writeHead(502);
    res.end(`Could not fetch remote asset: ${String(error?.message || error)}`);
  }
}

function serveStaticFrom(baseDir, urlPath, res, cacheControl = 'no-cache') {
  const cleanPath = urlPath === '/' ? '/index.html' : urlPath;
  const filePath = path.resolve(baseDir, `.${decodeURIComponent(cleanPath)}`);
  if (filePath !== baseDir && !filePath.startsWith(baseDir + path.sep)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }
  fs.readFile(filePath, (error, data) => {
    if (error) {
      res.writeHead(404);
      res.end('Not found');
      return;
    }
    // App assets default to no-cache: without it browsers heuristically
    // cache and serve stale arena code after every deploy.
    res.writeHead(200, {'content-type': contentType(filePath), 'cache-control': cacheControl});
    res.end(data);
  });
}

function safeRelativePath(urlPath) {
  const cleanPath = path.normalize(decodeURIComponent(urlPath)).replace(/^\/+/, '');
  if (!cleanPath || cleanPath.startsWith('..') || path.isAbsolute(cleanPath)) return '';
  return cleanPath;
}

function contentType(filePath) {
  if (filePath.endsWith('.html')) return 'text/html; charset=utf-8';
  if (filePath.endsWith('.js')) return 'text/javascript; charset=utf-8';
  if (filePath.endsWith('.css')) return 'text/css; charset=utf-8';
  if (filePath.endsWith('.json')) return 'application/json; charset=utf-8';
  if (filePath.endsWith('.jsonl')) return 'application/x-ndjson; charset=utf-8';
  if (filePath.endsWith('.txt')) return 'text/plain; charset=utf-8';
  if (filePath.endsWith('.png')) return 'image/png';
  if (filePath.endsWith('.jpg') || filePath.endsWith('.jpeg')) return 'image/jpeg';
  if (filePath.endsWith('.gif')) return 'image/gif';
  if (filePath.endsWith('.webp')) return 'image/webp';
  if (filePath.endsWith('.svg')) return 'image/svg+xml';
  if (filePath.endsWith('.woff')) return 'font/woff';
  if (filePath.endsWith('.woff2')) return 'font/woff2';
  if (filePath.endsWith('.ttf')) return 'font/ttf';
  if (filePath.endsWith('.mp3')) return 'audio/mpeg';
  if (filePath.endsWith('.wav')) return 'audio/wav';
  return 'application/octet-stream';
}
