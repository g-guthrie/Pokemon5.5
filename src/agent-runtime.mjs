import path from 'node:path';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import * as PromptPipeline from './prompt-pipeline.mjs';

const require = createRequire(import.meta.url);
const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const showdownRoot = path.join(rootDir, 'vendor', 'pokemon-showdown');
const {Dex} = require(showdownRoot);

const REASONING_EFFORTS = new Set(['none', 'minimal', 'low', 'medium', 'high', 'xhigh']);
const SECRET_PATTERNS = [
  /sk-or-v1-[A-Za-z0-9_-]+/g,
  /sk-[A-Za-z0-9_-]{16,}/g,
];
const PROVIDER_KEY_ENV = {
  openai: 'OPENAI_API_KEY',
  openrouter: 'OPENROUTER_API_KEY',
};

export {
  PROMPT_SCHEMA_VERSION,
  REQUIRED_ANALYSIS_FIELDS,
  RESPONSE_SCHEMA_VERSION,
  normalizeDecisionAnalysis,
} from './prompt-pipeline.mjs';

export function parseAgentSpec(spec = 'standin') {
  if (typeof spec === 'object' && spec) return normalizeAgentConfig(spec);
  const parts = String(spec || 'standin').split(':');
  const provider = (parts.shift() || 'standin').trim().toLowerCase();
  let reasoningEffort = '';
  if (parts.length && REASONING_EFFORTS.has(parts.at(-1).trim().toLowerCase())) {
    reasoningEffort = parts.pop().trim().toLowerCase();
  }
  const model = parts.join(':').trim();
  return normalizeAgentConfig({provider, model, reasoningEffort});
}

export function normalizeAgentConfig(config = {}) {
  const provider = (config.provider || 'standin').trim().toLowerCase();
  const model = config.model || defaultModelFor(provider);
  const reasoningEffort = config.reasoningEffort || defaultReasoningFor(provider);
  const publicModel = sanitizeText(model);
  return {
    provider,
    model,
    reasoningEffort,
    name: sanitizeText(config.name || `${provider}:${publicModel}${reasoningEffort ? `:${reasoningEffort}` : ''}`),
    ratingKey: sanitizeText(config.ratingKey || `${provider}:${publicModel}:${reasoningEffort || 'none'}`),
    // Very generous by default: the tactical analysis is the product, so the
    // answer must never be squeezed. Providers bill actual usage, not this
    // ceiling. (OpenRouter pre-reserves maxTokens x price against the account
    // balance per request, so near-empty accounts may need AGENT_MAX_TOKENS
    // lowered.)
    maxTokens: Number(config.maxTokens || process.env.AGENT_MAX_TOKENS || 16384),
    temperature: Number(config.temperature ?? process.env.AGENT_TEMPERATURE ?? 0.2),
    capturePrompts: config.capturePrompts ?? process.env.CAPTURE_PROMPTS !== '0',
    // Per-run key (e.g. a website visitor's own OpenRouter key). Held in
    // memory only: publicAgentMetadata never includes it, and artifact
    // sanitization scrubs key-shaped strings as a second line of defense.
    apiKey: typeof config.apiKey === 'string' && config.apiKey.trim() ? config.apiKey.trim() : '',
  };
}

export async function createAgent(spec = 'standin', options = {}) {
  const config = normalizeAgentConfig(typeof spec === 'string' ? parseAgentSpec(spec) : spec);
  if (options.name) config.name = sanitizeText(options.name);
  return {
    ...config,
    metadata: publicAgentMetadata(config),
  };
}

export function publicAgentMetadata(agent) {
  return {
    name: sanitizeText(agent.name),
    provider: sanitizeText(agent.provider),
    model: sanitizeText(agent.model),
    reasoningEffort: sanitizeText(agent.reasoningEffort || ''),
    ratingKey: sanitizeText(agent.ratingKey || `${agent.provider}:${agent.model}:${agent.reasoningEffort || 'none'}`),
    maxTokens: agent.maxTokens || null,
    temperature: Number.isFinite(agent.temperature) ? agent.temperature : null,
  };
}

export async function chooseWithAgent(agent, role, observation, legalActions, context = {}) {
  const actions = normalizeLegalActions(legalActions);
  if (!actions.length) {
    return {
      action: null,
      call: createBaseCall(agent, role, {
        valid: false,
        requestedChoice: '',
        choice: '',
        reason: 'no legal actions',
      }),
    };
  }

  if (agent.provider === 'standin' || agent.provider === 'heuristic') {
    return chooseWithStandin(agent, role, observation, actions);
  }
  const chooser = agent.provider === 'openai'
    ? chooseWithOpenAI
    : agent.provider === 'openrouter'
      ? chooseWithOpenRouter
      : null;
  if (!chooser) throw new Error(`Unsupported agent provider: ${agent.provider}`);

  // Providers occasionally return transient garbage — an empty body, a
  // truncated stream, a 5xx — through no fault of the model's play. Retry
  // those transport/format failures (some routes flake twice in a row) and
  // record the retries. Invalid *choices* are a benchmark signal and are
  // never retried here.
  const maxAttempts = 3;
  for (let attempt = 1; ; attempt += 1) {
    try {
      const decision = await chooser(agent, role, observation, actions, context);
      if (decision?.call && attempt > 1) decision.call.retries = attempt - 1;
      return decision;
    } catch (error) {
      const retryable = !context.signal?.aborted &&
        error?.name !== 'InvalidModelChoiceError' &&
        isTransientProviderError(error) &&
        attempt < maxAttempts;
      if (!retryable) throw error;
      await new Promise(resolve => setTimeout(resolve, 1500 * attempt));
    }
  }
}

function reasoningAllowance(effort = '') {
  if (effort === 'high') return 32768;
  if (effort === 'medium') return 16384;
  return 12288;
}

function isTransientProviderError(error) {
  const message = String(error?.message || '');
  return (
    /Model did not return JSON/.test(message) ||
    /truncated at max_tokens|hit max_tokens/.test(message) ||
    /API 5\d\d|API 429|Provider returned error/.test(message) ||
    /fetch failed|network|socket|ECONNRESET|ETIMEDOUT/i.test(message)
  );
}

export function buildModelInput(role, observation, legalActions) {
  return PromptPipeline.buildModelInput(role, observation, legalActions);
}

export function buildChoicePrompt(role, observation, legalActions) {
  return PromptPipeline.buildChoicePrompt(role, observation, legalActions);
}

export function compactLegalActions(legalActions = []) {
  return PromptPipeline.compactLegalActions(legalActions);
}

export function compactExtractedState(extracted = {}) {
  return PromptPipeline.compactExtractedState(extracted);
}

export function firstSafeAction(legalActions = []) {
  return (
    legalActions.find(action => action.type === 'double-choice' && !String(action.choice).includes('terastallize')) ||
    legalActions.find(action => action.type === 'double-choice') ||
    legalActions.find(action => action.type === 'move' && !String(action.choice).includes('terastallize')) ||
    legalActions.find(action => action.type === 'switch' || action.type === 'force-switch') ||
    legalActions[0] ||
    null
  );
}

export function extractOutputText(body = {}) {
  if (typeof body.output_text === 'string') return body.output_text;
  if (Array.isArray(body.output)) {
    return body.output
      .flatMap(item => item.content || [])
      .map(content => content.text || '')
      .join('\n')
      .trim();
  }
  if (Array.isArray(body.choices)) {
    return body.choices
      .map(choice => choice.message?.content || choice.text || choice.delta?.content || '')
      .join('\n')
      .trim();
  }
  return '';
}

export function parseJsonObject(text = '') {
  try {
    return JSON.parse(text);
  } catch {}
  // Some models emit a valid JSON object followed by trailing text (or a
  // second object) despite response_format. Extract the first balanced
  // top-level object, respecting strings and escapes.
  const source = String(text);
  const start = source.indexOf('{');
  if (start >= 0) {
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let i = start; i < source.length; i++) {
      const ch = source[i];
      if (escaped) {
        escaped = false;
      } else if (ch === '\\') {
        escaped = inString;
      } else if (ch === '"') {
        inString = !inString;
      } else if (!inString && ch === '{') {
        depth += 1;
      } else if (!inString && ch === '}') {
        depth -= 1;
        if (depth === 0) {
          try {
            return JSON.parse(source.slice(start, i + 1));
          } catch {
            break;
          }
        }
      }
    }
  }
  throw new Error(`Model did not return JSON: ${source.slice(0, 200)}`);
}

export function sanitizeText(value = '') {
  let text = String(value);
  for (const pattern of SECRET_PATTERNS) text = text.replace(pattern, '[redacted-secret]');
  return text;
}

export async function loadAllowedEnvValue(name) {
  if (!Object.values(PROVIDER_KEY_ENV).includes(name)) {
    throw new Error(`Unsupported secret env var: ${name}`);
  }
  const value = process.env[name] || '';
  return isUsableSecretValue(value) ? value : '';
}

export function providerKeyEnvName(provider = '') {
  return PROVIDER_KEY_ENV[String(provider || '').toLowerCase()] || '';
}

export function validateProviderConfig(agentOrSpec = 'standin', env = process.env) {
  const agent = typeof agentOrSpec === 'string' ? parseAgentSpec(agentOrSpec) : normalizeAgentConfig(agentOrSpec);
  const envName = providerKeyEnvName(agent.provider);
  if (!envName) {
    return {
      ok: agent.provider === 'standin' || agent.provider === 'heuristic',
      provider: agent.provider,
      model: sanitizeText(agent.model),
      reasoningEffort: agent.reasoningEffort || '',
      envName: '',
      keyPresent: false,
      message: agent.provider === 'standin' || agent.provider === 'heuristic' ? 'No API key required' : `Unsupported agent provider: ${agent.provider}`,
    };
  }
  const keyPresent = isUsableSecretValue(env[envName] || '');
  return {
    ok: keyPresent,
    provider: agent.provider,
    model: sanitizeText(agent.model),
    reasoningEffort: agent.reasoningEffort || '',
    envName,
    keyPresent,
    message: keyPresent ? `${envName} is set` : `${envName} is not set`,
  };
}

async function postOpenRouter(apiKey, requestBody, signal) {
  let response;
  try {
    response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${apiKey}`,
        'content-type': 'application/json',
        'HTTP-Referer': 'http://localhost:3107',
        'X-OpenRouter-Title': 'Pokemon Showdown Benchmark Harness',
        'X-OpenRouter-Experimental-Metadata': 'enabled',
      },
      body: JSON.stringify(requestBody),
      signal,
    });
  } catch (error) {
    if (error?.name === 'AbortError') throw error;
    throw new Error(sanitizeText(error?.message || error));
  }
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(providerErrorMessage('OpenRouter', response.status, body));
  }
  return body;
}

// Providers wrap upstream errors ("Provider returned error") in ways that
// hide the actionable detail; surface the raw upstream message too so failed
// calls are debuggable straight from the artifact.
function providerErrorMessage(providerLabel, status, body = {}) {
  const parts = [body.error?.message || `${providerLabel} API ${status}`];
  const raw = body.error?.metadata?.raw;
  if (raw && !parts[0].includes(String(raw))) {
    parts.push(`upstream: ${String(raw).slice(0, 400)}`);
  }
  return sanitizeText(parts.join(' | ')).slice(0, 600);
}

function createModelCallSignal(parentSignal, timeoutMs) {
  const timeout = Number(timeoutMs || 0);
  if (!Number.isFinite(timeout) || timeout <= 0) {
    return {
      signal: parentSignal,
      timeoutMs: 0,
      timedOut: () => false,
      cleanup: () => {},
    };
  }
  const controller = new AbortController();
  let didTimeout = false;
  const timer = setTimeout(() => {
    didTimeout = true;
    controller.abort();
  }, timeout);
  const abortFromParent = () => controller.abort();
  if (parentSignal) {
    if (parentSignal.aborted) {
      controller.abort();
    } else {
      parentSignal.addEventListener('abort', abortFromParent, {once: true});
    }
  }
  return {
    signal: controller.signal,
    timeoutMs: timeout,
    timedOut: () => didTimeout,
    cleanup: () => {
      clearTimeout(timer);
      parentSignal?.removeEventListener?.('abort', abortFromParent);
    },
  };
}

async function chooseWithOpenAI(agent, role, observation, legalActions, context = {}) {
  const apiKey = await loadAllowedEnvValue(providerKeyEnvName('openai'));
  if (!apiKey) throw new Error('OPENAI_API_KEY is not set');

  const prompt = buildChoicePrompt(role, observation, legalActions);
  const requestBody = {
    model: agent.model,
    input: prompt,
    max_output_tokens: agent.maxTokens,
    text: {
      format: PromptPipeline.buildOpenAIResponseFormat(legalActions),
      verbosity: 'low',
    },
  };
  if (agent.reasoningEffort && agent.reasoningEffort !== 'none') {
    requestBody.reasoning = {effort: agent.reasoningEffort};
  }

  const startedAt = new Date().toISOString();
  const callSignal = createModelCallSignal(context.signal, context.modelTimeoutMs);
  let response;
  try {
    response = await fetch('https://api.openai.com/v1/responses', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${apiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(requestBody),
      signal: callSignal.signal,
    });
  } catch (error) {
    if (!callSignal.timedOut() && error?.name === 'AbortError') throw error;
    throw new Error(callSignal.timedOut() ? `MODEL_TIMEOUT_MS=${callSignal.timeoutMs}` : sanitizeText(error?.message || error));
  } finally {
    callSignal.cleanup();
  }
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(providerErrorMessage('OpenAI', response.status, body));
  }

  return resultFromModelText({
    agent,
    role,
    legalActions,
    text: extractOutputText(body),
    responseId: body.id || '',
    responseModel: body.model || agent.model,
    usage: body.usage || null,
    prompt: agent.capturePrompts ? prompt : '',
    startedAt,
    context,
  });
}

async function chooseWithOpenRouter(agent, role, observation, legalActions, context = {}) {
  const apiKey = agent.apiKey || await loadAllowedEnvValue(providerKeyEnvName('openrouter'));
  if (!apiKey) throw new Error('No OpenRouter key: add your API key in the arena, or set OPENROUTER_API_KEY');

  const prompt = buildChoicePrompt(role, observation, legalActions);
  const requestBody = {
    model: agent.model,
    messages: [
      {
        role: 'system',
        content: 'Return one exact legal Pokemon Showdown doubles choice as JSON only.',
      },
      {role: 'user', content: prompt},
    ],
    // Reasoning tokens share the completion budget on many providers, and
    // "low" effort can still think for thousands of tokens (GLM measured >4k
    // on ordinary turns). Reasoning-enabled calls get the answer budget plus
    // an explicit thinking allowance so the JSON never gets starved.
    max_tokens: agent.reasoningEffort && agent.reasoningEffort !== 'none'
      ? Math.max(agent.maxTokens, 2048) + reasoningAllowance(agent.reasoningEffort)
      : agent.maxTokens,
    temperature: Number.isFinite(agent.temperature) ? agent.temperature : 0.2,
    response_format: PromptPipeline.buildChatCompletionResponseFormat(legalActions),
  };
  if (agent.reasoningEffort && agent.reasoningEffort !== 'none') {
    requestBody.reasoning = {effort: agent.reasoningEffort};
  }
  // Only route to upstream hosts that fully support every parameter we send
  // (structured outputs, reasoning). Hosts that silently drop response_format
  // are the main source of empty/truncated garbage responses.
  requestBody.provider = {require_parameters: true};

  const startedAt = new Date().toISOString();
  const callSignal = createModelCallSignal(context.signal, context.modelTimeoutMs);
  let body;
  try {
    body = await postOpenRouter(apiKey, requestBody, callSignal.signal);
  } catch (error) {
    // Non-reasoning models have no endpoint that satisfies a reasoning
    // parameter under require_parameters; degrade by dropping reasoning
    // (structured output is non-negotiable) and trying once more.
    if (requestBody.reasoning && /No endpoints found/i.test(String(error?.message || ''))) {
      delete requestBody.reasoning;
      body = await postOpenRouter(apiKey, requestBody, callSignal.signal);
    } else if (!callSignal.timedOut() && error?.name === 'AbortError') {
      throw error;
    } else if (callSignal.timedOut()) {
      throw new Error(`MODEL_TIMEOUT_MS=${callSignal.timeoutMs}`);
    } else {
      throw error;
    }
  } finally {
    callSignal.cleanup();
  }
  if (body.choices?.[0]?.finish_reason === 'length') {
    const emitted = String(extractOutputText(body)).trim();
    throw new Error(
      emitted
        ? 'Model response truncated at max_tokens mid-answer (reasoning shares the budget); raise AGENT_MAX_TOKENS'
        : 'Model hit max_tokens before emitting content (reasoning likely consumed the budget); raise AGENT_MAX_TOKENS or use reasoning effort "none"'
    );
  }

  return resultFromModelText({
    agent,
    role,
    legalActions,
    text: extractOutputText(body),
    responseId: body.id || '',
    responseModel: body.model || agent.model,
    usage: body.usage || null,
    openrouterMetadata: body.openrouter_metadata || null,
    prompt: agent.capturePrompts ? prompt : '',
    startedAt,
    context,
  });
}

function resultFromModelText({
  agent,
  role,
  legalActions,
  text,
  responseId,
  responseModel,
  usage,
  openrouterMetadata = null,
  prompt,
  startedAt,
  context,
}) {
  let parsed;
  try {
    parsed = parseJsonObject(text);
  } catch (error) {
    const call = createBaseCall(agent, role, {
      at: startedAt,
      responseId,
      responseModel,
      valid: false,
      fallback: false,
      error: sanitizeText(error?.message || error),
      rawText: sanitizeText(text).slice(0, 4000),
      usage,
      openrouterMetadata,
      prompt,
      promptSchemaVersion: PromptPipeline.PROMPT_SCHEMA_VERSION,
      responseSchemaVersion: PromptPipeline.RESPONSE_SCHEMA_VERSION,
    });
    const wrapped = new Error(sanitizeText(error?.message || error));
    wrapped.call = call;
    throw wrapped;
  }
  const requestedChoice = String(parsed.choice || '').trim();
  const action = legalActions.find(candidate => candidate.choice === requestedChoice || candidate.command === requestedChoice) || null;
  const fallback = !action && context.allowFallback ? firstSafeAction(legalActions) : null;
  const selectedAction = action || fallback;
  const analysis = PromptPipeline.normalizeDecisionAnalysis(parsed);
  const analysisMissing = missingAnalysisFields(parsed, analysis);
  const call = createBaseCall(agent, role, {
    at: startedAt,
    responseId,
    responseModel,
    requestedChoice,
    choice: selectedAction?.choice || '',
    valid: Boolean(action),
    fallback: Boolean(fallback),
    reason: sanitizeText(parsed.reason || parsed.finalReason || ''),
    analysis,
    rawText: sanitizeText(text).slice(0, 8000),
    usage,
    openrouterMetadata,
    prompt,
    analysisComplete: analysisMissing.length === 0,
    analysisMissing,
    promptSchemaVersion: PromptPipeline.PROMPT_SCHEMA_VERSION,
    responseSchemaVersion: PromptPipeline.RESPONSE_SCHEMA_VERSION,
  });
  if (!action && !fallback) throw new InvalidModelChoiceError(`Model returned invalid choice: ${requestedChoice || '(empty)'}`, call);
  return {action: selectedAction, call};
}

function chooseWithStandin(agent, role, observation, legalActions) {
  const scored = legalActions.map(action => ({
    action,
    score: scoreAction(action, observation),
  })).sort((a, b) => b.score - a.score);
  const best = scored[0];
  const action = best?.action || null;
  return {
    action,
    call: createBaseCall(agent, role, {
      requestedChoice: action?.choice || '',
      choice: action?.choice || '',
      valid: Boolean(action),
      reason: best ? `${role} picked highest heuristic score ${best.score.toFixed(1)}` : 'no legal action',
      scores: scored.slice(0, 8).map(item => ({
        choice: item.action.choice,
        label: item.action.move || item.action.pokemon || item.action.label || item.action.choice,
        score: Number(item.score.toFixed(2)),
      })),
    }),
  };
}

function createBaseCall(agent, role, details = {}) {
  return {
    at: details.at || new Date().toISOString(),
    role,
    provider: sanitizeText(agent.provider),
    agent: sanitizeText(agent.name),
    model: sanitizeText(agent.model),
    reasoningEffort: sanitizeText(agent.reasoningEffort || ''),
    requestedChoice: details.requestedChoice || '',
    choice: details.choice || '',
    valid: Boolean(details.valid),
    fallback: Boolean(details.fallback),
    reason: details.reason || '',
    responseId: sanitizeText(details.responseId || ''),
    responseModel: sanitizeText(details.responseModel || ''),
    error: sanitizeText(details.error || ''),
    promptSchemaVersion: details.promptSchemaVersion || PromptPipeline.PROMPT_SCHEMA_VERSION,
    responseSchemaVersion: details.responseSchemaVersion || PromptPipeline.RESPONSE_SCHEMA_VERSION,
    usage: details.usage || null,
    openrouterMetadata: details.openrouterMetadata || null,
    rawText: details.rawText || '',
    prompt: details.prompt || '',
    analysis: details.analysis || null,
    analysisComplete: typeof details.analysisComplete === 'boolean' ? details.analysisComplete : null,
    analysisMissing: details.analysisMissing || undefined,
    scores: details.scores || undefined,
  };
}

const OPTIONAL_EMPTY_ANALYSIS_FIELDS = new Set(['setupLines', 'sweepPlans', 'safeSwitches']);
const ANALYSIS_FIELD_ALIASES = {
  gameStateSummary: ['gameStateSummary', 'stateSummary', 'summary'],
  winConditions: ['winConditions', 'winCons', 'pathToWin', 'pathsToWin'],
  loseConditions: ['loseConditions', 'losingConditions', 'lossConditions', 'pathsToLoss'],
  setupLines: ['setupLines', 'possibleSetups', 'setupApproaches'],
  sweepPlans: ['sweepPlans', 'sweeperApproaches', 'damagePlans'],
  safeSwitches: ['safeSwitches', 'easySwitches', 'switches'],
  opponentLikelyPlan: ['opponentLikelyPlan', 'opponentPlan', 'opponentMostLikely'],
  biggestThreats: ['biggestThreats', 'threats'],
  riskAssessment: ['riskAssessment', 'risks', 'failureModes'],
  candidateChoices: ['candidateChoices', 'candidateChoiceReview', 'choiceReview', 'consideredChoices', 'shortlist'],
};

function missingAnalysisFields(parsed = {}, analysis = {}) {
  return PromptPipeline.REQUIRED_ANALYSIS_FIELDS.filter(field => {
    if (!fieldWasReturned(parsed, field)) return true;
    if (OPTIONAL_EMPTY_ANALYSIS_FIELDS.has(field)) return false;
    return !Array.isArray(analysis[field]) || !analysis[field].length;
  });
}

function fieldWasReturned(parsed = {}, field) {
  return (ANALYSIS_FIELD_ALIASES[field] || [field]).some(alias => Object.hasOwn(parsed, alias));
}

function normalizeLegalActions(legalActions = []) {
  return legalActions
    .map(action => ({
      ...action,
      choice: action.choice || action.command,
      command: action.command || action.choice,
    }))
    .filter(action => action.choice);
}

function isUsableSecretValue(value = '') {
  const text = String(value || '').trim();
  if (text.length < 12) return false;
  if (text.includes('your_') || text.includes('sk-...') || text === '...') return false;
  return true;
}

function compactActionPart(action = {}) {
  return {
    choice: action.choice || action.command,
    type: action.type,
    label: action.label || action.move || action.pokemon || action.choice || action.command,
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
  };
}

function compactOwnPokemon(mon) {
  if (!mon) return null;
  return {
    slot: mon.slot,
    activeSlot: mon.activeSlot || null,
    name: mon.name,
    species: mon.species,
    level: mon.level,
    gender: mon.gender,
    condition: mon.condition,
    active: mon.active,
    item: mon.item,
    ability: mon.ability,
    nature: mon.nature,
    evs: mon.evs,
    ivs: mon.ivs,
    moves: mon.moves,
    teraType: mon.teraType,
    stats: mon.active ? mon.stats : undefined,
    boosts: mon.boosts,
    terastallized: mon.terastallized || undefined,
  };
}

function compactKnownPokemon(mon) {
  if (!mon) return null;
  return {
    key: mon.key,
    ident: mon.ident,
    name: mon.name,
    species: mon.species,
    level: mon.level,
    gender: mon.gender,
    condition: mon.condition,
    active: mon.active,
    activeSlot: mon.activeSlot || null,
    revealed: mon.revealed,
    fainted: mon.fainted,
    status: mon.status || undefined,
    nature: mon.nature || undefined,
    evs: mon.evs || undefined,
    ivs: mon.ivs || undefined,
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

function scoreAction(action, observation) {
  if (action.type === 'double-choice') {
    return (action.choices || []).reduce((total, part) => {
      if (part.type === 'pass') return total;
      return total + scoreAction(part, observation);
    }, 0);
  }
  if (action.type === 'force-switch') return scoreSwitch(action, observation) + 100;
  if (action.type === 'switch') return scoreSwitch(action, observation);
  if (action.type !== 'move') return 0;

  const move = Dex.moves.get(action.id || toID(action.move));
  if (!move || !move.exists) return 10;
  if (Number(action.pp) <= 0) return -1000;
  if (move.category === 'Status') return scoreStatusMove(move, observation);

  const active = pokemonForActiveSlot(observation.self, action.activeSlot) || {};
  const opponent = pokemonForActiveSlot(observation.opponent, action.targetSlot) || observation.opponent?.active || {};
  const species = Dex.species.get(toID(active.species || active.name));
  const stab = species.types?.includes(move.type) ? 1.5 : 1;
  const typeMod = typeModifier(move.type, opponent.species || opponent.name);
  const accuracy = move.accuracy === true ? 1 : Math.max(0.5, Number(move.accuracy || 100) / 100);
  const priority = Number(move.priority || 0) * 12;
  const teraBonus = String(action.choice).includes('terastallize') ? 8 : 0;
  const lowHpBonus = hpRatio(active.condition) < 0.25 && priority > 0 ? 15 : 0;
  const basePower = Number(move.basePower || 50);
  return basePower * stab * typeMod * accuracy + priority + teraBonus + lowHpBonus;
}

function scoreSwitch(action, observation) {
  const activeHp = hpRatio(pokemonForActiveSlot(observation.self, action.activeSlot)?.condition);
  if (activeHp > 0 && activeHp < 0.25) return 42;
  if (activeHp > 0 && activeHp < 0.4) return 18;
  return 3;
}

function scoreStatusMove(move, observation) {
  const id = move.id;
  const turn = Number(observation.turn || 0);
  const activeHp = hpRatio(observation.self?.active?.condition || observation.self?.activePokemon?.[0]?.condition);
  if (isHealingMove(id)) return activeHp > 0 && activeHp < 0.55 ? 85 : 12;
  if (isSetupMove(id)) return turn <= 3 ? 52 - turn * 7 : 9;
  if (isHazardMove(id)) return turn <= 5 ? 44 : 12;
  if (isDisruptionMove(id)) return 30;
  return 18;
}

function pokemonForActiveSlot(side = {}, activeSlot = 1) {
  const activePokemon = side.activePokemon || [];
  return activePokemon.find(mon => Number(mon.activeSlot || mon.slot) === Number(activeSlot)) ||
    activePokemon[Number(activeSlot || 1) - 1] ||
    side.active ||
    null;
}

function typeModifier(moveType, targetSpeciesName) {
  try {
    const targetSpecies = Dex.species.get(toID(targetSpeciesName));
    if (!targetSpecies.exists || !targetSpecies.types?.length) return 1;
    let modifier = 0;
    for (const type of targetSpecies.types) modifier += Dex.getEffectiveness(moveType, type);
    return Math.pow(2, modifier);
  } catch {
    return 1;
  }
}

function hpRatio(condition = '') {
  const match = String(condition).match(/^(\d+)\/(\d+)/);
  if (!match) return 1;
  const current = Number(match[1]);
  const max = Number(match[2]);
  return max ? current / max : 1;
}

function isHealingMove(id) {
  return ['recover', 'roost', 'slackoff', 'synthesis', 'morningsun', 'milkdrink', 'softboiled', 'wish', 'strengthsap'].includes(id);
}

function isSetupMove(id) {
  return ['swordsdance', 'nastyplot', 'calmmind', 'dragondance', 'quiverdance', 'bulkup', 'coil', 'shellsmash', 'rockpolish', 'agility', 'shiftgear'].includes(id);
}

function isHazardMove(id) {
  return ['stealthrock', 'spikes', 'toxicspikes', 'stickyweb'].includes(id);
}

function isDisruptionMove(id) {
  return ['taunt', 'encore', 'willowisp', 'thunderwave', 'toxic', 'spore', 'sleeppowder', 'leechseed', 'substitute'].includes(id);
}

function defaultModelFor(provider) {
  if (provider === 'openai') return process.env.OPENAI_MODEL || 'gpt-5.5';
  if (provider === 'openrouter') return process.env.OPENROUTER_MODEL || '~openai/gpt-latest';
  return 'standin-dex-heuristic-v1';
}

function defaultReasoningFor(provider) {
  if (provider === 'openai') return process.env.OPENAI_REASONING_EFFORT || 'low';
  if (provider === 'openrouter') return process.env.OPENROUTER_REASONING_EFFORT || 'low';
  return '';
}

function toID(value = '') {
  return String(value).toLowerCase().replace(/[^a-z0-9]+/g, '');
}

export class InvalidModelChoiceError extends Error {
  constructor(message, call) {
    super(message);
    this.name = 'InvalidModelChoiceError';
    this.call = call;
  }
}
