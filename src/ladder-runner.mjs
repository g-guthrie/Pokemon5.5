import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {runWebSocketMatch, writeJson} from './match-runner.mjs';
import {parseAgentSpec, publicAgentMetadata, createAgent} from './agent-runtime.mjs';
import {
  ensureRating,
  loadEloStore,
  ratingKeyForAgent,
  ratingsSnapshot,
  saveEloStore,
  updateEloPair,
} from './elo-store.mjs';
import {mergeUsageSummaries, summarizeUsage} from './usage-summary.mjs';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_FORMAT = 'gen9randomdoublesbattle';

export async function runLadderBatch(options = {}) {
  const serverOrigin = options.serverOrigin || process.env.SERVER_ORIGIN || 'http://localhost:3107';
  const battleCount = clampNumber(options.battleCount ?? process.env.BATTLE_COUNT, 1, 10000, 2);
  const maxTurns = clampNumber(options.maxTurns ?? process.env.MAX_TURNS, 1, 10000, 40);
  const moveDelayMs = clampNumber(options.moveDelayMs ?? process.env.MOVE_DELAY_MS, 0, 60000, 20);
  const outDir = options.outDir || process.env.LADDER_DIR || path.join(rootDir, 'artifacts', 'ladder-batch');
  const formatid = options.formatid || process.env.FORMATID || DEFAULT_FORMAT;
  const allowFallback = Boolean(options.allowFallback ?? process.env.ALLOW_FALLBACK === '1');
  const ratingK = Number(options.ratingK ?? process.env.ELO_K ?? 32);
  const ratingStorePath = options.ratingStorePath || process.env.RATING_STORE || path.join(rootDir, 'artifacts', 'ratings-store.json');
  const seedBase = Number(options.seedBase ?? process.env.SEED_BASE ?? 550000);
  const timeoutMs = options.timeoutMs ?? process.env.MATCH_TIMEOUT_MS;
  const signal = options.signal || null;
  const waitIfPaused = typeof options.waitIfPaused === 'function' ? options.waitIfPaused : null;
  const watchLocal = Boolean(options.watchLocal);
  const runId = options.runId || `ladder-${Date.now().toString(36)}`;
  const onBattleEnd = typeof options.onBattleEnd === 'function' ? options.onBattleEnd : null;

  const agentA = await createAgent(parseAgentSpec(options.agentA || process.env.AGENT_A || 'standin'), {name: options.agentAName || process.env.AGENT_A_NAME || 'agent-a'});
  const agentB = await createAgent(parseAgentSpec(options.agentB || process.env.AGENT_B || 'standin'), {name: options.agentBName || process.env.AGENT_B_NAME || 'agent-b'});
  const eloStore = await loadEloStore(ratingStorePath);
  ensureRating(eloStore, agentA);
  ensureRating(eloStore, agentB);

  const summary = {
    schemaVersion: 'showdown-ladder-summary.v1',
    startedAt: new Date().toISOString(),
    runId,
    serverOrigin,
    formatid,
    battleCount,
    maxTurns,
    moveDelayMs,
    allowFallback,
    ratingK,
    ratingStorePath,
    watchLocal,
    agents: {
      a: publicAgentMetadata(agentA),
      b: publicAgentMetadata(agentB),
    },
    ratingKeys: {
      a: ratingKeyForAgent(agentA),
      b: ratingKeyForAgent(agentB),
    },
    ratingsStart: ratingsSnapshot(eloStore, [agentA, agentB]),
    ratings: ratingsSnapshot(eloStore, [agentA, agentB]),
    totals: {
      agentAWins: 0,
      agentBWins: 0,
      drawsOrCaps: 0,
      invalidBenchmarks: 0,
      apiErrorCount: 0,
      fallbackCount: 0,
      invalidChoiceCount: 0,
    },
    battles: [],
    usage: summarizeUsage([]),
    aborted: false,
  };

  for (let index = 0; index < battleCount; index += 1) {
    if (signal?.aborted) {
      summary.aborted = true;
      break;
    }
    if (waitIfPaused) await waitIfPaused({battleIndex: index + 1});
    if (signal?.aborted) {
      summary.aborted = true;
      break;
    }

    const aIsP1 = index % 2 === 0;
    const seed = seedForBattle(index + 1, seedBase);
    const outputPath = path.join(outDir, `battle-${String(index + 1).padStart(3, '0')}.json`);
    const battleId = watchLocal ? 'local' : `${runId}-${String(index + 1).padStart(3, '0')}`;
    const sideMap = {
      p1: aIsP1 ? 'a' : 'b',
      p2: aIsP1 ? 'b' : 'a',
    };

    const run = await runWebSocketMatch({
      serverOrigin,
      battleId,
      outputPath,
      formatid,
      seed,
      maxTurns,
      moveDelayMs,
      allowFallback,
      timeoutMs,
      signal,
      waitIfPaused,
      agents: {
        p1: aIsP1 ? agentA : agentB,
        p2: aIsP1 ? agentB : agentA,
      },
    });

    const winnerSide = run.result?.winnerRole || winnerToSide(run.result?.winner);
    const winnerAgent = winnerSide ? sideMap[winnerSide] : null;
    const scoreA = winnerAgent === 'a' ? 1 : winnerAgent === 'b' ? 0 : 0.5;
    const ratingUpdate = updateEloPair(eloStore, agentA, agentB, scoreA, {
      k: ratingK,
      validBenchmark: run.validBenchmark,
      battle: {
        index: index + 1,
        seed,
        winner: run.result?.winner || null,
        winnerAgent,
        validBenchmark: run.validBenchmark,
      },
    });

    if (winnerAgent === 'a') summary.totals.agentAWins += 1;
    else if (winnerAgent === 'b') summary.totals.agentBWins += 1;
    else summary.totals.drawsOrCaps += 1;
    if (!run.validBenchmark) summary.totals.invalidBenchmarks += 1;
    summary.totals.apiErrorCount += run.apiErrorCount || 0;
    summary.totals.fallbackCount += run.fallbackCount || 0;
    summary.totals.invalidChoiceCount += run.invalidChoiceCount || 0;
    summary.usage = mergeUsageSummaries(summary.usage, run.usage || summarizeUsage(run.modelCalls || []));
    summary.ratings = ratingsSnapshot(eloStore, [agentA, agentB]);
    summary.battles.push({
      index: index + 1,
      battleId: run.battleId,
      outputPath,
      outputHref: artifactHrefFor(outputPath),
      eventsPath: run.eventsPath || '',
      eventsHref: run.eventsHref || artifactHrefFor(run.eventsPath || ''),
      seed,
      sideMap,
      winner: run.result?.winner || null,
      winnerSide,
      winnerAgent,
      turn: run.result?.turn ?? null,
      reason: run.result?.reason || '',
      validBenchmark: run.validBenchmark,
      actions: run.actions?.length || 0,
      apiErrorCount: run.apiErrorCount || 0,
      fallbackCount: run.fallbackCount || 0,
      invalidChoiceCount: run.invalidChoiceCount || 0,
      usage: run.usage || summarizeUsage(run.modelCalls || []),
      ratingUpdate,
      ratingsAfter: ratingsSnapshot(eloStore, [agentA, agentB]),
    });
    if (run.result?.reason === 'ABORTED') summary.aborted = true;
    if (onBattleEnd) await onBattleEnd({summary, battle: summary.battles.at(-1), run});
    if (summary.aborted) break;
  }

  summary.finishedAt = new Date().toISOString();
  summary.summaryPath = path.join(outDir, 'summary-latest.json');
  summary.summaryHref = artifactHrefFor(summary.summaryPath);
  await saveEloStore(ratingStorePath, eloStore);
  await writeJson(summary.summaryPath, summary);
  return summary;
}

export function winnerToSide(winner = '') {
  if (winner === 'Benchmark P1') return 'p1';
  if (winner === 'Benchmark P2') return 'p2';
  return null;
}

export function seedForBattle(index, seedBase = 550000) {
  const base = Number(seedBase || 550000);
  return [base, index, base + index * 17, base + index * 101].map(value => value >>> 0);
}

function artifactHrefFor(filePath = '') {
  if (!filePath) return '';
  const artifactsMarker = `${path.sep}artifacts${path.sep}`;
  const normalized = path.resolve(filePath);
  const index = normalized.lastIndexOf(artifactsMarker);
  if (index < 0) return '';
  return `/artifacts/${normalized.slice(index + artifactsMarker.length).split(path.sep).map(encodeURIComponent).join('/')}`;
}

function clampNumber(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, number));
}
