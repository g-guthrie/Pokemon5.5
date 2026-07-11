import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {runLadderBatch} from './ladder-runner.mjs';
import {writeJson} from './match-runner.mjs';
import {mergeUsageSummaries, summarizeUsage} from './usage-summary.mjs';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_MODELS_URL = 'https://openrouter.ai/api/v1/models?output_modalities=text';
const DEFAULT_FORMAT = 'gen9randomdoublesbattle';
const DEFAULT_REASONING_EFFORT = 'low';
const DEFAULT_OPENAI_BASELINES = ['openai:gpt-5.5:low', 'openai:gpt-5.5:medium'];

export const OPENROUTER_WEEKLY_USAGE_TOP_CANDIDATES = [
  {rank: 1, id: 'tencent/hy3-preview', label: 'Hy3 Preview'},
  {rank: 2, id: 'moonshotai/kimi-k2.6', label: 'Kimi K2.6'},
  {rank: 3, id: 'anthropic/claude-sonnet-4.6', label: 'Claude Sonnet 4.6'},
  {rank: 4, id: 'google/gemini-3-flash-preview', label: 'Gemini 3 Flash Preview'},
  {rank: 5, id: 'anthropic/claude-opus-4.7', label: 'Claude Opus 4.7'},
  {rank: 6, id: 'deepseek/deepseek-v4-flash', label: 'DeepSeek V4 Flash'},
  {rank: 7, id: 'deepseek/deepseek-v3.2', label: 'DeepSeek V3.2'},
  {rank: 8, id: 'minimax/minimax-m2.7', label: 'MiniMax M2.7'},
  {rank: 9, id: 'x-ai/grok-4.3', label: 'Grok 4.3'},
  {rank: 10, id: 'deepseek/deepseek-v4-pro', label: 'DeepSeek V4 Pro'},
];

export async function fetchOpenRouterModelCatalog(options = {}) {
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  if (typeof fetchImpl !== 'function') throw new Error('fetch is not available');
  const response = await fetchImpl(options.modelsUrl || DEFAULT_MODELS_URL, {
    headers: openRouterHeaders(options.apiKey || process.env.OPENROUTER_API_KEY || ''),
  });
  if (!response.ok) throw new Error(`OpenRouter models API ${response.status}`);
  const body = await response.json();
  if (!Array.isArray(body.data)) throw new Error('OpenRouter models API returned no data array');
  return body.data;
}

export async function buildOpenRouterBenchmarkPlan(options = {}) {
  const generatedAt = new Date().toISOString();
  const catalog = options.modelCatalog || await fetchOpenRouterModelCatalog(options);
  const openRouterLimit = clampNumber(options.openRouterLimit ?? process.env.OPENROUTER_BENCHMARK_LIMIT, 1, 32, 10);
  const reasoningEffort = String(options.reasoningEffort || process.env.OPENROUTER_REASONING_EFFORT || DEFAULT_REASONING_EFFORT);
  const openaiBaselines = normalizeOpenAIBaselines(options.openaiBaselines ?? process.env.OPENAI_BASELINES);
  const rankedCandidates = normalizeRankedCandidates(options.rankedCandidates ?? process.env.OPENROUTER_TOP_MODELS);
  const requireStructuredOutputs = options.requireStructuredOutputs ?? process.env.OPENROUTER_REQUIRE_STRUCTURED !== '0';
  const fillFromCatalog = options.fillFromCatalog ?? process.env.OPENROUTER_FILL_FROM_CATALOG !== '0';
  const selected = [];
  const excluded = [];
  const seen = new Set();

  for (const candidate of rankedCandidates) {
    const model = resolveModel(candidate, catalog);
    if (!model) {
      excluded.push(excludedCandidate(candidate, 'missing-from-model-catalog'));
      continue;
    }
    if (seen.has(model.id)) continue;
    if (requireStructuredOutputs && !supportsStructuredChoice(model)) {
      excluded.push(excludedCandidate(candidate, 'missing-response-format-or-structured-outputs', model));
      continue;
    }
    selected.push(openRouterAgentFromModel(model, {candidate, reasoningEffort, selectionSource: 'openrouter-weekly-usage-ranking'}));
    seen.add(model.id);
    if (selected.length >= openRouterLimit) break;
  }

  if (fillFromCatalog && selected.length < openRouterLimit) {
    for (const model of catalogFillModels(catalog, {requireStructuredOutputs})) {
      if (seen.has(model.id)) continue;
      selected.push(openRouterAgentFromModel(model, {
        candidate: {rank: null, id: model.id, label: model.name},
        reasoningEffort,
        selectionSource: 'openrouter-model-catalog-latest-structured-fill',
      }));
      seen.add(model.id);
      if (selected.length >= openRouterLimit) break;
    }
  }

  const openai = openaiBaselines.map((spec, index) => openAIAgentFromSpec(spec, index + 1));
  const pairs = createBenchmarkPairs(openai, selected);
  return {
    schemaVersion: 'showdown-openrouter-benchmark-suite.v1',
    generatedAt,
    name: options.name || process.env.BENCHMARK_SUITE_NAME || 'openrouter-top-vs-openai',
    formatid: options.formatid || process.env.FORMATID || DEFAULT_FORMAT,
    source: {
      ranking: {
        title: 'OpenRouter LLM Leaderboard weekly usage top candidates',
        url: 'https://openrouter.ai/rankings',
        note: 'The ranking page is dynamic; this suite records candidate IDs and resolves them against the current OpenRouter models API at plan time.',
      },
      modelCatalog: {
        url: options.modelsUrl || DEFAULT_MODELS_URL,
        count: catalog.length,
      },
      docs: {
        modelsApi: 'https://openrouter.ai/docs/api-reference/models/get-models',
      },
    },
    selection: {
      openRouterLimit,
      reasoningEffort,
      requireStructuredOutputs,
      fillFromCatalog,
      rankedCandidates,
      selectedOpenRouterCount: selected.length,
      excludedOpenRouterCount: excluded.length,
      openaiBaselineCount: openai.length,
      pairCount: pairs.length,
    },
    openaiBaselines: openai,
    openrouterModels: selected,
    excludedOpenRouterCandidates: excluded,
    pairs,
  };
}

export async function writeBenchmarkPlan(plan, outputPath) {
  await writeJson(outputPath, plan);
  return outputPath;
}

export async function runOpenRouterBenchmarkSuite(options = {}) {
  const plan = options.plan || await buildOpenRouterBenchmarkPlan(options);
  const runId = options.runId || process.env.BENCHMARK_RUN_ID || `openrouter-top-${Date.now().toString(36)}`;
  const outDir = options.outDir || process.env.BENCHMARK_DIR || path.join(rootDir, 'artifacts', 'benchmark-suites', runId);
  const planPath = path.join(outDir, 'suite-plan.json');
  const summaryPath = path.join(outDir, 'summary-latest.json');
  const battleCount = clampNumber(options.battlesPerPair ?? process.env.BATTLES_PER_PAIR, 1, 10000, 2);
  const maxTurns = clampNumber(options.maxTurns ?? process.env.MAX_TURNS, 1, 10000, 40);
  const moveDelayMs = clampNumber(options.moveDelayMs ?? process.env.MOVE_DELAY_MS, 0, 60000, 20);
  const timeoutMs = options.timeoutMs ?? process.env.MATCH_TIMEOUT_MS;
  const seedBase = Number(options.seedBase ?? process.env.SEED_BASE ?? 880000);
  const serverOrigin = options.serverOrigin || process.env.SERVER_ORIGIN || 'http://localhost:3107';
  const formatid = options.formatid || plan.formatid || DEFAULT_FORMAT;
  const allowFallback = Boolean(options.allowFallback ?? process.env.ALLOW_FALLBACK === '1');
  const watchLocal = Boolean(options.watchLocal ?? process.env.BENCHMARK_WATCH_LOCAL === '1');
  const signal = options.signal || null;
  const waitIfPaused = typeof options.waitIfPaused === 'function' ? options.waitIfPaused : null;
  const onPairEnd = typeof options.onPairEnd === 'function' ? options.onPairEnd : null;

  const summary = {
    schemaVersion: 'showdown-openrouter-benchmark-run.v1',
    startedAt: new Date().toISOString(),
    runId,
    planPath,
    summaryPath,
    serverOrigin,
    formatid,
    battleCount,
    maxTurns,
    moveDelayMs,
    timeoutMs: timeoutMs ? Number(timeoutMs) : null,
    allowFallback,
    watchLocal,
    plan,
    totals: {
      pairs: plan.pairs.length,
      completedPairs: 0,
      scheduledBattles: plan.pairs.length * battleCount,
      completedBattles: 0,
      invalidBenchmarks: 0,
      apiErrorCount: 0,
      fallbackCount: 0,
      invalidChoiceCount: 0,
      drawsOrCaps: 0,
    },
    pairs: [],
    usage: summarizeUsage([]),
    aborted: false,
  };

  await writeBenchmarkPlan(plan, planPath);
  for (const pair of plan.pairs) {
    if (signal?.aborted) {
      summary.aborted = true;
      break;
    }
    if (waitIfPaused) await waitIfPaused({pairIndex: pair.index});
    if (signal?.aborted) {
      summary.aborted = true;
      break;
    }
    const pairDir = path.join(outDir, `pair-${String(pair.index).padStart(3, '0')}-${safePathPart(pair.openai.name)}-vs-${safePathPart(pair.openrouter.name)}`);
    const pairSummary = await runLadderBatch({
      serverOrigin,
      runId: `${runId}-pair-${String(pair.index).padStart(3, '0')}`,
      outDir: pairDir,
      battleCount,
      maxTurns,
      moveDelayMs,
      timeoutMs,
      formatid,
      allowFallback,
      seedBase: seedBase + pair.index * 10000,
      watchLocal,
      signal,
      waitIfPaused,
      agentA: pair.openai.agentConfig,
      agentB: pair.openrouter.agentConfig,
    });
    const record = {
      index: pair.index,
      pairId: pair.pairId,
      outDir: pairDir,
      summaryPath: pairSummary.summaryPath,
      summaryHref: pairSummary.summaryHref || artifactHrefFor(pairSummary.summaryPath),
      openai: pair.openai,
      openrouter: pair.openrouter,
      battleCount: pairSummary.battleCount,
      battles: pairSummary.battles.length,
      totals: pairSummary.totals,
      usage: pairSummary.usage,
      aborted: Boolean(pairSummary.aborted),
    };
    summary.pairs.push(record);
    summary.totals.completedPairs += 1;
    summary.totals.completedBattles += pairSummary.battles.length;
    summary.totals.invalidBenchmarks += pairSummary.totals?.invalidBenchmarks || 0;
    summary.totals.apiErrorCount += pairSummary.totals?.apiErrorCount || 0;
    summary.totals.fallbackCount += pairSummary.totals?.fallbackCount || 0;
    summary.totals.invalidChoiceCount += pairSummary.totals?.invalidChoiceCount || 0;
    summary.totals.drawsOrCaps += pairSummary.totals?.drawsOrCaps || 0;
    summary.usage = mergeUsageSummaries(summary.usage, pairSummary.usage || summarizeUsage([]));
    if (onPairEnd) await onPairEnd({summary, pair: record, pairSummary});
    if (pairSummary.aborted) summary.aborted = true;
    if (summary.aborted) break;
  }

  summary.finishedAt = new Date().toISOString();
  await writeJson(summaryPath, summary);
  return summary;
}

function normalizeOpenAIBaselines(value) {
  const specs = Array.isArray(value) ? value : String(value || '').split(',');
  const cleaned = specs.map(spec => String(spec || '').trim()).filter(Boolean);
  return cleaned.length ? cleaned : DEFAULT_OPENAI_BASELINES;
}

function normalizeRankedCandidates(value) {
  if (Array.isArray(value)) {
    return value.map((candidate, index) => normalizeCandidate(candidate, index + 1)).filter(Boolean);
  }
  const raw = String(value || '').split(',').map(item => item.trim()).filter(Boolean);
  if (!raw.length) return OPENROUTER_WEEKLY_USAGE_TOP_CANDIDATES;
  return raw.map((id, index) => normalizeCandidate({rank: index + 1, id, label: id}, index + 1)).filter(Boolean);
}

function normalizeCandidate(candidate, fallbackRank) {
  if (typeof candidate === 'string') return {rank: fallbackRank, id: candidate, label: candidate};
  if (!candidate || typeof candidate !== 'object') return null;
  return {
    rank: candidate.rank ?? fallbackRank,
    id: String(candidate.id || candidate.model || '').trim(),
    label: String(candidate.label || candidate.name || candidate.id || '').trim(),
  };
}

function resolveModel(candidate, catalog = []) {
  if (!candidate?.id) return null;
  const exact = catalog.find(model => model.id === candidate.id || model.canonical_slug === candidate.id);
  if (exact) return exact;
  const wanted = normalizeLookup(candidate.id || candidate.label);
  return catalog.find(model => normalizeLookup(model.id) === wanted || normalizeLookup(model.name) === wanted) || null;
}

function supportsStructuredChoice(model = {}) {
  const supported = new Set(model.supported_parameters || []);
  return supported.has('response_format') || supported.has('structured_outputs');
}

function catalogFillModels(catalog = [], options = {}) {
  return [...catalog]
    .filter(model => !options.requireStructuredOutputs || supportsStructuredChoice(model))
    .filter(model => textOutputModel(model))
    .sort((a, b) => Number(b.created || 0) - Number(a.created || 0));
}

function textOutputModel(model = {}) {
  const outputs = model.architecture?.output_modalities || [];
  return !outputs.length || outputs.includes('text');
}

function openRouterAgentFromModel(model, options = {}) {
  const candidate = options.candidate || {};
  const reasoningEffort = options.reasoningEffort || DEFAULT_REASONING_EFFORT;
  return {
    provider: 'openrouter',
    rank: candidate.rank,
    id: model.id,
    model: model.id,
    name: model.name || model.id,
    agentSpec: `openrouter:${model.id}:${reasoningEffort}`,
    reasoningEffort,
    selectionSource: options.selectionSource || '',
    catalog: publicModelMetadata(model),
    agentConfig: {
      provider: 'openrouter',
      model: model.id,
      reasoningEffort,
      name: `or-${safePathPart(model.id)}`,
    },
  };
}

function openAIAgentFromSpec(spec, rank) {
  const parts = String(spec || '').split(':');
  const provider = (parts.shift() || 'openai').trim() || 'openai';
  const reasoningEffort = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh'].includes(parts.at(-1)) ? parts.pop() : DEFAULT_REASONING_EFFORT;
  const model = parts.join(':') || 'gpt-5.5';
  const normalized = `${provider}:${model}:${reasoningEffort}`;
  return {
    provider,
    rank,
    model,
    name: `${provider}-${safePathPart(model)}-${reasoningEffort}`,
    agentSpec: normalized,
    reasoningEffort,
    agentConfig: {
      provider,
      model,
      reasoningEffort,
      name: `${provider}-${safePathPart(model)}-${reasoningEffort}`,
    },
  };
}

function createBenchmarkPairs(openaiBaselines = [], openrouterModels = []) {
  const pairs = [];
  for (const openai of openaiBaselines) {
    for (const openrouter of openrouterModels) {
      pairs.push({
        index: pairs.length + 1,
        pairId: `${safePathPart(openai.name)}-vs-${safePathPart(openrouter.id)}`,
        openai,
        openrouter,
      });
    }
  }
  return pairs;
}

function excludedCandidate(candidate, reason, model = null) {
  return {
    rank: candidate.rank ?? null,
    id: candidate.id || '',
    label: candidate.label || '',
    reason,
    catalog: model ? publicModelMetadata(model) : null,
  };
}

function publicModelMetadata(model = {}) {
  return {
    id: model.id || '',
    canonicalSlug: model.canonical_slug || '',
    name: model.name || '',
    created: model.created || null,
    contextLength: model.context_length || null,
    pricing: {
      prompt: model.pricing?.prompt || '0',
      completion: model.pricing?.completion || '0',
      request: model.pricing?.request || '0',
    },
    supportedParameters: model.supported_parameters || [],
    topProvider: {
      contextLength: model.top_provider?.context_length || null,
      maxCompletionTokens: model.top_provider?.max_completion_tokens || null,
      isModerated: model.top_provider?.is_moderated ?? null,
    },
  };
}

function openRouterHeaders(apiKey = '') {
  const headers = {'accept': 'application/json'};
  if (apiKey) headers.authorization = `Bearer ${apiKey}`;
  return headers;
}

function normalizeLookup(value = '') {
  return String(value).toLowerCase().replace(/[^a-z0-9]+/g, '');
}

function safePathPart(value = '') {
  return String(value || 'agent')
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) || 'agent';
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
