import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {WebSocketServer} from 'ws';
import {sanitizeText} from './agent-runtime.mjs';
import {BattleSession} from './battle-session.mjs';
import {
  buildOpenRouterBenchmarkPlan,
  runOpenRouterBenchmarkSuite,
  writeBenchmarkPlan,
} from './benchmark-suite.mjs';
import {runLadderBatch} from './ladder-runner.mjs';
import {runWebSocketMatch} from './match-runner.mjs';
import {runTournamentBatch} from './tournament-runner.mjs';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const publicDir = path.join(rootDir, 'public');
const showdownClientDir = path.join(rootDir, 'vendor', 'pokemon-showdown-client', 'play.pokemonshowdown.com');
const artifactsDir = path.join(rootDir, 'artifacts');
const assetCacheDir = path.join(rootDir, 'artifacts', 'asset-cache');
const remoteAssetOrigin = 'https://play.pokemonshowdown.com';
const port = Number(process.env.PORT || 3107);
const DEFAULT_BATTLE_ID = 'local';

const battleSessions = new Map();
const clients = new Map();
// Visitor-session runs: sessionId -> run. The '' key is the legacy operator
// slot (battle 'local', no session), which CLI smokes and the operator page
// use unchanged.
const liveRuns = new Map();
const MAX_CONCURRENT_RUNS = clampNumber(process.env.MAX_CONCURRENT_RUNS, 1, 16, 3);
let ladderRun = null;
let tournamentRun = null;
let benchmarkRun = null;
getBattle(DEFAULT_BATTLE_ID);

const server = http.createServer((req, res) => {
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
  if (url.pathname === '/api/artifacts') {
    void listArtifacts(res);
    return;
  }
  if (url.pathname === '/api/replays') {
    void listReplays(res, normalizeSessionId(url.searchParams.get('session')));
    return;
  }
  if (url.pathname === '/api/models') {
    void listPickableModels(res);
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
    serveStaticFrom(showdownClientDir, url.pathname.slice('/ps'.length), res);
    return;
  }
  if (isShowdownAssetPath(url.pathname)) {
    serveShowdownAsset(url.pathname, res);
    return;
  }
  serveStatic(url.pathname, res);
});

const wss = new WebSocketServer({server, path: '/ws'});

wss.on('connection', (ws, req) => {
  const url = new URL(req.url || '/', `http://${req.headers.host}`);
  const role = normalizeRole(url.searchParams.get('role'));
  const battleId = normalizeBattleId(url.searchParams.get('battleId') || url.searchParams.get('battle'));
  const battle = getBattle(battleId);
  clients.set(ws, {role, battleId});
  send(ws, {type: 'hello', role, battleId, formatid: battle.formatid, seed: battle.seed});
  for (const chunk of protocolBacklogFor(battle, role)) {
    send(ws, {type: 'protocol', role, chunk});
  }
  send(ws, {type: 'state', role, state: battle.extractState(role)});

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
});

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
    maxTurns: clampNumber(body.maxTurns, 1, 200, 40),
    moveDelayMs: clampNumber(body.moveDelayMs, 0, 5000, 200),
    timeoutMs: clampNumber(body.timeoutMs, 1000, 7200000, 30000),
    modelTimeoutMs: clampNumber(body.modelTimeoutMs, 1000, 600000, 240000),
    allowFallback: Boolean(body.allowFallback),
    agentP1: sanitizeAgentSpec(body.agentP1 || body.agents?.p1 || 'standin'),
    agentP2: sanitizeAgentSpec(body.agentP2 || body.agents?.p2 || 'standin'),
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
    sessionId,
  };
  liveRuns.set(sessionId, run);
  void runLiveMatch(run);
  return run;
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
  const run = {
    id,
    status: body.startPaused ? 'paused' : 'running',
    startedAt: new Date().toISOString(),
    finishedAt: '',
    outDir,
    summaryPath: path.join(outDir, 'summary-latest.json'),
    summaryHref: '',
    ratingStorePath: path.join(artifactsDir, 'ratings-store.json'),
    ratingStoreHref: '/artifacts/ratings-store.json',
    battleCount: clampNumber(body.battleCount, 1, 100, 2),
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
      ratingStorePath: run.ratingStorePath,
      battleCount: run.battleCount,
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
    ratingStorePath: run.ratingStorePath,
    ratingStoreHref: run.ratingStoreHref || artifactHrefFor(run.ratingStorePath),
    lastBattle: run.lastBattle,
    totals: run.summary?.totals || null,
    ratings: run.summary?.ratings || null,
    usage: run.summary?.usage || null,
    error: run.error,
  };
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
    ratingStorePath: path.join(artifactsDir, 'ratings-store.json'),
    ratingStoreHref: '/artifacts/ratings-store.json',
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
      ratingStorePath: run.ratingStorePath,
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
    ratingStorePath: run.ratingStorePath,
    ratingStoreHref: run.ratingStoreHref || artifactHrefFor(run.ratingStorePath),
    lastPair: run.lastPair,
    totals: run.summary?.totals || null,
    standings: run.summary?.standings || null,
    ratings: run.summary?.ratings || null,
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
}

async function startServerBenchmark(body = {}) {
  if (!paidBenchmarkConfirmed(body)) {
    throw new Error('Refusing paid benchmark run unless runPaidBenchmark is true');
  }
  if (isBenchmarkActive(benchmarkRun)) throw new Error(`Benchmark already active: ${benchmarkRun.id}`);
  if (isTournamentActive(tournamentRun)) throw new Error(`Tournament already active: ${tournamentRun.id}`);
  if (isLadderActive(ladderRun)) throw new Error(`Ladder already active: ${ladderRun.id}`);
  if (isRunActive(liveRuns.get(''))) throw new Error(`Run already active: ${liveRuns.get('').id}`);

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
    ratingStorePath: path.join(artifactsDir, 'ratings-store.json'),
    ratingStoreHref: '/artifacts/ratings-store.json',
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
      ratingStorePath: run.ratingStorePath,
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
    ratingStorePath: run.ratingStorePath,
    ratingStoreHref: run.ratingStoreHref || artifactHrefFor(run.ratingStorePath),
    lastPair: run.lastPair,
    totals: run.summary?.totals || null,
    ratings: run.summary?.ratings || null,
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
    const result = await runWebSocketMatch({
      serverOrigin: `http://localhost:${port}`,
      battleId: run.battleId,
      outputPath: run.outputPath,
      formatid: run.formatid,
      seed: run.seed,
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
          run.lastBoards[role] = summarizeLiveBoard(observationRecord.observation);
        }
      },
      onModelCall: ({run: match, call, callIndex}) => {
        copyMatchTelemetry(run, match);
        run.lastModelCall = summarizeLiveModelCall(call, callIndex);
        run.lastModelCalls.push(run.lastModelCall);
        run.lastModelCalls = run.lastModelCalls.slice(-14);
      },
      onAction: ({run: match, actionRecord, call}) => {
        copyMatchTelemetry(run, match);
        run.lastActions.push(summarizeLiveAction(actionRecord, call));
        run.lastActions = run.lastActions.slice(-8);
      },
      agents: {
        p1: run.agentP1,
        p2: run.agentP2,
      },
      providerKeys: run.providerKeys,
      sessionId: run.sessionId,
    });
    copyMatchTelemetry(run, result);
    run.status = result.result?.reason === 'ABORTED' ? 'stopped' : 'finished';
    run.result = result.result || null;
    run.eventsPath = result.eventsPath || '';
    run.eventsHref = result.eventsHref || '';
  } catch (error) {
    run.status = run.abortController.signal.aborted ? 'stopped' : 'error';
    run.error = sanitizeText(error?.message || error);
  } finally {
    run.paused = false;
    resumeLiveRun(run);
    run.finishedAt = new Date().toISOString();
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
  };
}

function summarizeLiveAction(action = {}, call = {}) {
  return {
    at: action.at || '',
    role: action.role || '',
    turn: action.turn ?? null,
    requestId: action.requestId ?? null,
    choice: action.choice || '',
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
  for (const key of [
    'gameStateSummary',
    'winConditions',
    'loseConditions',
    'setupLines',
    'sweepPlans',
    'safeSwitches',
    'opponentLikelyPlan',
    'biggestThreats',
    'riskAssessment',
    'candidateChoices',
  ]) {
    if (!Array.isArray(analysis[key])) continue;
    output[key] = analysis[key]
      .map(value => sanitizeText(String(value || '')).slice(0, 420))
      .filter(Boolean)
      .slice(0, key === 'candidateChoices' ? 8 : 6);
  }
  return output;
}

function summarizeLiveRun(run) {
  if (!run) return null;
  return {
    id: run.id,
    status: run.status,
    startedAt: run.startedAt,
    finishedAt: run.finishedAt,
    battleId: run.battleId,
    outputPath: run.outputPath,
    outputHref: artifactHrefFor(run.outputPath),
    eventsPath: run.eventsPath,
    eventsHref: run.eventsHref || artifactHrefFor(run.eventsPath),
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

// Validates a visitor's OpenRouter key against the free auth endpoint and
// returns only non-secret account facts. The key is not logged or stored.
async function handleKeyValidateRequest(req, res) {
  try {
    const body = await readJsonBody(req);
    const key = typeof body.openrouterKey === 'string' ? body.openrouterKey.trim() : '';
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
      balance: Number.isFinite(balance) ? Math.round(balance * 100) / 100 : null,
      limitRemaining: Number.isFinite(Number(auth.limit_remaining)) ? Math.round(Number(auth.limit_remaining) * 100) / 100 : null,
    });
  } catch (error) {
    sendJson(res, {ok: false, error: 'Could not reach OpenRouter to validate the key'}, 200);
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
  const battle = new BattleSession(options);
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
  for (const [battleId, battle] of battleSessions) {
    if (battleId === DEFAULT_BATTLE_ID) continue;
    const clientCount = [...clients.values()].filter(client => client.battleId === battleId).length;
    if (clientCount === 0 && battle.public?.ended) {
      battleSessions.delete(battleId);
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

async function listArtifacts(res) {
  try {
    const files = await listJsonArtifacts(artifactsDir);
    files.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    sendJson(res, {artifacts: files});
  } catch (error) {
    res.writeHead(500, {'content-type': 'application/json; charset=utf-8'});
    res.end(JSON.stringify({error: String(error?.message || error)}));
  }
}

const replayIndexCache = new Map();

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

async function listReplays(res, sessionId = '') {
  try {
    const files = await listJsonArtifacts(artifactsDir);
    const replays = [];
    for (const file of files) {
      // Test fixtures are not user-facing replays.
      if (file.name.startsWith('verification/') || /-smoke(\.events)?\.json$/.test(file.name)) continue;
      const filePath = path.join(artifactsDir, ...file.name.split('/'));
      const summary = await summarizeReplayArtifact(filePath, file);
      if (!summary) continue;
      // A visitor sees their own matches plus the unscoped local/CLI gallery.
      if (sessionId && summary.sessionId && summary.sessionId !== sessionId) continue;
      replays.push(summary);
    }
    replays.sort((a, b) => String(b.startedAt).localeCompare(String(a.startedAt)));
    sendJson(res, {replays: replays.slice(0, 200)});
  } catch (error) {
    sendJson(res, {ok: false, error: sanitizeText(error?.message || error)}, 500);
  }
}

async function summarizeReplayArtifact(filePath, file) {
  const cached = replayIndexCache.get(filePath);
  if (cached && cached.updatedAt === file.updatedAt) return cached.summary;
  let summary = null;
  try {
    const head = await readFileHead(filePath, 2048);
    if (head.includes('showdown-match-artifact.v1')) {
      const artifact = JSON.parse(await fs.promises.readFile(filePath, 'utf8'));
      if (artifact.schemaVersion === 'showdown-match-artifact.v1' && Array.isArray(artifact.protocol) && artifact.protocol.length) {
        summary = {
          id: file.name,
          href: file.href,
          bytes: file.bytes,
          sessionId: sanitizeText(String(artifact.sessionId || '')).slice(0, 24),
          startedAt: artifact.startedAt || file.updatedAt,
          finishedAt: artifact.finishedAt || '',
          battleId: artifact.battleId || '',
          formatid: artifact.formatid || '',
          agents: {
            p1: replayAgentSummary(artifact.agents?.p1),
            p2: replayAgentSummary(artifact.agents?.p2),
          },
          result: artifact.result || null,
          decisions: Array.isArray(artifact.actions) ? artifact.actions.length : 0,
          validBenchmark: Boolean(artifact.validBenchmark),
          usage: artifact.usage
            ? {costUsd: Number(artifact.usage.costUsd) || 0, totalTokens: Number(artifact.usage.totalTokens) || 0}
            : null,
        };
      }
    }
  } catch {
    summary = null;
  }
  replayIndexCache.set(filePath, {updatedAt: file.updatedAt, summary});
  return summary;
}

function replayAgentSummary(agent = {}) {
  return {
    name: sanitizeText(String(agent?.name || 'unknown')),
    provider: sanitizeText(String(agent?.provider || '')),
    model: sanitizeText(String(agent?.model || '')),
    reasoningEffort: sanitizeText(String(agent?.reasoningEffort || '')),
  };
}

async function readFileHead(filePath, bytes) {
  const handle = await fs.promises.open(filePath, 'r');
  try {
    const buffer = Buffer.alloc(bytes);
    const {bytesRead} = await handle.read(buffer, 0, bytes, 0);
    return buffer.subarray(0, bytesRead).toString('utf8');
  } finally {
    await handle.close();
  }
}

async function listJsonArtifacts(dir, prefix = '') {
  const entries = await fs.promises.readdir(dir, {withFileTypes: true});
  const files = [];
  for (const entry of entries) {
    const filePath = path.join(dir, entry.name);
    const relativeName = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory() && !relativeName.includes('asset-cache')) {
      files.push(...await listJsonArtifacts(filePath, relativeName));
    } else if (entry.isFile() && entry.name.endsWith('.json')) {
      const stat = await fs.promises.stat(filePath);
      files.push({
        name: relativeName,
        href: `/artifacts/${relativeName}`,
        bytes: stat.size,
        updatedAt: stat.mtime.toISOString(),
      });
    }
  }
  return files;
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

function serveStaticFrom(baseDir, urlPath, res) {
  const cleanPath = urlPath === '/' ? '/index.html' : urlPath;
  const filePath = path.resolve(baseDir, `.${decodeURIComponent(cleanPath)}`);
  if (!filePath.startsWith(baseDir)) {
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
    res.writeHead(200, {'content-type': contentType(filePath)});
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
