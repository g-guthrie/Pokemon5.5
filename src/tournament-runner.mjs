import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createAgent, parseAgentSpec, publicAgentMetadata} from './agent-runtime.mjs';
import {runLadderBatch} from './ladder-runner.mjs';
import {writeJson} from './match-runner.mjs';
import {mergeUsageSummaries, summarizeUsage} from './usage-summary.mjs';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_FORMAT = 'gen9randomdoublesbattle';
const DEFAULT_AGENTS = ['standin', 'heuristic', 'standin:alt'];

export async function runTournamentBatch(options = {}) {
  const serverOrigin = options.serverOrigin || process.env.SERVER_ORIGIN || 'http://localhost:3107';
  const agentSpecs = normalizeAgentSpecs(options.agents ?? process.env.TOURNAMENT_AGENTS);
  const battlesPerPair = clampNumber(options.battlesPerPair ?? process.env.BATTLES_PER_PAIR, 1, 10000, 1);
  const maxTurns = clampNumber(options.maxTurns ?? process.env.MAX_TURNS, 1, 10000, 40);
  const moveDelayMs = clampNumber(options.moveDelayMs ?? process.env.MOVE_DELAY_MS, 0, 60000, 20);
  const outDir = options.outDir || process.env.TOURNAMENT_DIR || path.join(rootDir, 'artifacts', 'tournament-batch');
  const formatid = options.formatid || process.env.FORMATID || DEFAULT_FORMAT;
  const allowFallback = Boolean(options.allowFallback ?? process.env.ALLOW_FALLBACK === '1');
  const seedBase = Number(options.seedBase ?? process.env.SEED_BASE ?? 770000);
  const timeoutMs = options.timeoutMs ?? process.env.MATCH_TIMEOUT_MS;
  const signal = options.signal || null;
  const waitIfPaused = typeof options.waitIfPaused === 'function' ? options.waitIfPaused : null;
  const watchLocal = Boolean(options.watchLocal);
  const runId = options.runId || `tournament-${Date.now().toString(36)}`;
  const onPairEnd = typeof options.onPairEnd === 'function' ? options.onPairEnd : null;

  const agents = await Promise.all(agentSpecs.map(spec => createAgent(parseAgentSpec(spec))));
  assertDistinctAgentKeys(agents);

  const pairs = createPairs(agents);
  const summary = {
    schemaVersion: 'showdown-tournament-summary.v1',
    startedAt: new Date().toISOString(),
    runId,
    serverOrigin,
    formatid,
    agentCount: agents.length,
    pairCount: pairs.length,
    battlesPerPair,
    scheduledBattles: pairs.length * battlesPerPair,
    maxTurns,
    moveDelayMs,
    timeoutMs: timeoutMs ? Number(timeoutMs) : null,
    allowFallback,
    watchLocal,
    agents: agents.map(publicAgentMetadata),
    standings: createStandings(agents),
    totals: createTotals(pairs.length, battlesPerPair),
    pairs: [],
    usage: summarizeUsage([]),
    aborted: false,
  };

  for (const pair of pairs) {
    if (signal?.aborted) {
      summary.aborted = true;
      break;
    }
    if (waitIfPaused) await waitIfPaused({pairIndex: pair.index});
    if (signal?.aborted) {
      summary.aborted = true;
      break;
    }

    const pairId = `pair-${String(pair.index).padStart(3, '0')}-${safePathPart(pair.a.name)}-vs-${safePathPart(pair.b.name)}`;
    const pairOutDir = path.join(outDir, pairId);
    const pairSummary = await runLadderBatch({
      serverOrigin,
      runId: `${runId}-${pairId}`,
      outDir: pairOutDir,
      battleCount: battlesPerPair,
      maxTurns,
      moveDelayMs,
      formatid,
      allowFallback,
      timeoutMs,
      seedBase: seedBase + pair.index * 10000,
      signal,
      waitIfPaused,
      watchLocal,
      agentA: pair.aSpec,
      agentB: pair.bSpec,
      agentAName: pair.a.name,
      agentBName: pair.b.name,
    });

    const pairRecord = summarizePair(pair, pairId, pairOutDir, pairSummary);
    summary.pairs.push(pairRecord);
    addPairToTotals(summary.totals, pairSummary);
    addPairToStandings(summary.standings, pair, pairSummary);
    summary.usage = mergeUsageSummaries(summary.usage, pairSummary.usage || summarizeUsage([]));
    if (pairSummary.aborted) summary.aborted = true;
    if (onPairEnd) await onPairEnd({summary, pair: pairRecord, pairSummary});
    if (summary.aborted) break;
  }

  summary.finishedAt = new Date().toISOString();
  summary.completedPairs = summary.pairs.length;
  summary.completedBattles = summary.totals.completedBattles;
  summary.summaryPath = path.join(outDir, 'summary-latest.json');
  summary.summaryHref = artifactHrefFor(summary.summaryPath);
  await writeJson(summary.summaryPath, summary);
  return summary;
}

function normalizeAgentSpecs(value) {
  const raw = Array.isArray(value) ? value : String(value || '').split(',');
  const specs = raw
    .map(spec => typeof spec === 'string' ? spec.trim() : spec)
    .filter(Boolean);
  const selected = specs.length ? specs : DEFAULT_AGENTS;
  if (selected.length < 2) throw new Error('Tournament needs at least two agents');
  if (selected.length > 32) throw new Error('Tournament supports at most 32 agents per batch');
  return selected;
}

function createPairs(agents) {
  const pairs = [];
  for (let i = 0; i < agents.length; i += 1) {
    for (let j = i + 1; j < agents.length; j += 1) {
      pairs.push({
        index: pairs.length + 1,
        a: agents[i],
        b: agents[j],
        aSpec: agentSpecForRunner(agents[i]),
        bSpec: agentSpecForRunner(agents[j]),
      });
    }
  }
  return pairs;
}

function summarizePair(pair, pairId, outDir, pairSummary) {
  return {
    index: pair.index,
    pairId,
    outDir,
    outHref: artifactHrefFor(outDir),
    summaryPath: pairSummary.summaryPath,
    summaryHref: pairSummary.summaryHref || artifactHrefFor(pairSummary.summaryPath),
    agents: {
      a: publicAgentMetadata(pair.a),
      b: publicAgentMetadata(pair.b),
    },
    battles: pairSummary.battles.length,
    battleCount: pairSummary.battleCount,
    totals: pairSummary.totals,
    usage: pairSummary.usage,
    aborted: Boolean(pairSummary.aborted),
  };
}

function createTotals(pairCount, battlesPerPair) {
  return {
    pairCount,
    scheduledBattles: pairCount * battlesPerPair,
    completedBattles: 0,
    invalidBenchmarks: 0,
    apiErrorCount: 0,
    fallbackCount: 0,
    invalidChoiceCount: 0,
    drawsOrCaps: 0,
  };
}

function addPairToTotals(totals, pairSummary) {
  totals.completedBattles += pairSummary.battles.length;
  totals.invalidBenchmarks += pairSummary.totals?.invalidBenchmarks || 0;
  totals.apiErrorCount += pairSummary.totals?.apiErrorCount || 0;
  totals.fallbackCount += pairSummary.totals?.fallbackCount || 0;
  totals.invalidChoiceCount += pairSummary.totals?.invalidChoiceCount || 0;
  totals.drawsOrCaps += pairSummary.totals?.drawsOrCaps || 0;
}

function createStandings(agents) {
  return Object.fromEntries(agents.map(agent => [
    agentKeyFor(agent),
    {
      agent: publicAgentMetadata(agent),
      games: 0,
      wins: 0,
      losses: 0,
      drawsOrCaps: 0,
      invalidBenchmarks: 0,
    },
  ]));
}

function addPairToStandings(standings, pair, pairSummary) {
  const keyA = agentKeyFor(pair.a);
  const keyB = agentKeyFor(pair.b);
  for (const battle of pairSummary.battles || []) {
    standings[keyA].games += 1;
    standings[keyB].games += 1;
    if (!battle.validBenchmark) {
      // Same semantics as the ladder: an invalid benchmark is counted but its
      // outcome never contributes wins, losses, or draws to the standings.
      standings[keyA].invalidBenchmarks += 1;
      standings[keyB].invalidBenchmarks += 1;
      continue;
    }
    if (battle.winnerAgent === 'a') {
      standings[keyA].wins += 1;
      standings[keyB].losses += 1;
    } else if (battle.winnerAgent === 'b') {
      standings[keyA].losses += 1;
      standings[keyB].wins += 1;
    } else {
      standings[keyA].drawsOrCaps += 1;
      standings[keyB].drawsOrCaps += 1;
    }
  }
}

// Identity string for standings and duplicate detection — the agent's exact
// provider:model:effort coordinates plus its distinguishing name.
function agentKeyFor(agent) {
  return `${agent.provider}:${agent.model}:${agent.reasoningEffort || 'none'}${agent.name ? `#${agent.name}` : ''}`;
}

function assertDistinctAgentKeys(agents) {
  const seen = new Map();
  for (const agent of agents) {
    const key = agentKeyFor(agent);
    if (seen.has(key)) {
      throw new Error(`Duplicate tournament agent: ${key}`);
    }
    seen.set(key, agent);
  }
}

function agentSpecForRunner(agent) {
  return {
    provider: agent.provider,
    model: agent.model,
    reasoningEffort: agent.reasoningEffort || '',
    name: agent.name,
    maxTokens: agent.maxTokens,
    temperature: agent.temperature,
    capturePrompts: agent.capturePrompts,
  };
}

function artifactHrefFor(filePath = '') {
  if (!filePath) return '';
  const artifactsMarker = `${path.sep}artifacts${path.sep}`;
  const normalized = path.resolve(filePath);
  const index = normalized.lastIndexOf(artifactsMarker);
  if (index < 0) return '';
  return `/artifacts/${normalized.slice(index + artifactsMarker.length).split(path.sep).map(encodeURIComponent).join('/')}`;
}

function safePathPart(value = '') {
  return String(value || 'agent')
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64) || 'agent';
}

function clampNumber(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, number));
}
