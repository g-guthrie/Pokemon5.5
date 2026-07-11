import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {
  chooseWithAgent,
  createAgent,
  loadAllowedEnvValue,
  publicAgentMetadata,
  validateProviderConfig,
} from '../src/agent-runtime.mjs';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const envPath = path.join(rootDir, '.env');
const openAIEnvName = ['OPENAI', 'API', 'KEY'].join('_');
const openRouterEnvName = ['OPENROUTER', 'API', 'KEY'].join('_');
const previousFetch = globalThis.fetch;
const previousOpenAIKey = process.env[openAIEnvName];
const previousOpenRouterKey = process.env[openRouterEnvName];
let previousDotEnv = null;
let dotEnvExisted = false;

try {
  try {
    previousDotEnv = await fs.readFile(envPath, 'utf8');
    dotEnvExisted = true;
  } catch {}

  delete process.env[openAIEnvName];
  delete process.env[openRouterEnvName];
  await fs.writeFile(envPath, [
    `${openAIEnvName}=test-openai-from-dotenv-should-not-load`,
    `${openRouterEnvName}=test-openrouter-from-dotenv-should-not-load`,
    '',
  ].join('\n'));

  assert(validateProviderConfig('standin').ok, 'standin should not need a key');
  assert(!validateProviderConfig('openai:test-model:low').ok, 'OpenAI config should ignore project .env');
  assert(!validateProviderConfig('openrouter:test/model:low').ok, 'OpenRouter config should ignore project .env');
  assert(await loadAllowedEnvValue(openAIEnvName) === '', 'OpenAI loader should ignore project .env');
  assert(await loadAllowedEnvValue(openRouterEnvName) === '', 'OpenRouter loader should ignore project .env');

  let unsupportedRejected = false;
  try {
    await loadAllowedEnvValue('NOT_A_PROVIDER_KEY');
  } catch {
    unsupportedRejected = true;
  }
  assert(unsupportedRejected, 'loader should reject unsupported secret env names');

  process.env[openAIEnvName] = 'test-openai-env-only-key';
  process.env[openRouterEnvName] = 'test-openrouter-env-only-key';
  assert(validateProviderConfig('openai:test-model:low').ok, 'OpenAI config should accept env key');
  assert(validateProviderConfig('openrouter:test/model:low').ok, 'OpenRouter config should accept env key');
  assertPublicMetadataRedaction();

  const openaiCall = await fakeProviderChoice({
    provider: 'openai',
    model: 'provider-config-openai',
    expectedUrl: 'https://api.openai.com/v1/responses',
  });
  const openrouterCall = await fakeProviderChoice({
    provider: 'openrouter',
    model: 'provider-config-openrouter',
    expectedUrl: 'https://openrouter.ai/api/v1/chat/completions',
  });

  console.log(JSON.stringify({
    ok: true,
    envOnly: true,
    providers: {
      openai: {
        config: redactConfig(validateProviderConfig('openai:test-model:low')),
        url: openaiCall.url,
        promptContainsSeed: openaiCall.promptContainsSeed,
        promptContainsKey: openaiCall.promptContainsKey,
      },
      openrouter: {
        config: redactConfig(validateProviderConfig('openrouter:test/model:low')),
        url: openrouterCall.url,
        promptContainsSeed: openrouterCall.promptContainsSeed,
        promptContainsKey: openrouterCall.promptContainsKey,
      },
    },
  }, null, 2));
} finally {
  globalThis.fetch = previousFetch;
  restoreEnv(openAIEnvName, previousOpenAIKey);
  restoreEnv(openRouterEnvName, previousOpenRouterKey);
  if (dotEnvExisted) await fs.writeFile(envPath, previousDotEnv);
  else await fs.rm(envPath, {force: true});
}

async function fakeProviderChoice({provider, model, expectedUrl}) {
  const calls = [];
  globalThis.fetch = async (url, options = {}) => {
    const requestBody = JSON.parse(String(options.body || '{}'));
    const prompt = provider === 'openai' ? String(requestBody.input || '') : String(requestBody.messages?.at(-1)?.content || '');
    const responseFormat = provider === 'openai' ? requestBody.text?.format : requestBody.response_format;
    calls.push({
      url: String(url),
      method: options.method || '',
      hasAuth: Boolean(options.headers?.authorization),
      promptContainsSeed: prompt.includes('1,2,3,4') || prompt.includes('550000'),
      promptContainsKey: prompt.includes('test-openai-env-only-key') || prompt.includes('test-openrouter-env-only-key'),
      responseFormat,
    });
    const content = JSON.stringify({
      gameStateSummary: ['Test board is simple.'],
      winConditions: ['Use the only legal action to advance the benchmark.'],
      loseConditions: ['Stalling out the clock is the only way to lose from here.'],
      setupLines: [],
      sweepPlans: ['Use the only legal move.'],
      safeSwitches: [],
      opponentLikelyPlan: ['Opponent has one revealed active.'],
      biggestThreats: ['No immediate benchmark threat.'],
      riskAssessment: ['No alternate legal action exists.'],
      candidateChoices: ['move 1 1, move 1 1: only legal benchmark choice; no alternate risk.'],
      choice: 'move 1 1, move 1 1',
      reason: 'Only legal benchmark choice.',
    });
    return {
      ok: true,
      status: 200,
      json: async () => provider === 'openai' ?
        {id: 'fake-openai-response', model, output_text: content, usage: {input_tokens: 10, output_tokens: 8, total_tokens: 18}} :
        {id: 'fake-openrouter-response', model, choices: [{message: {content}}], usage: {prompt_tokens: 10, completion_tokens: 8, total_tokens: 18}},
    };
  };

  const agent = await createAgent({
    provider,
    model,
    reasoningEffort: 'low',
    capturePrompts: false,
  });
  const decision = await chooseWithAgent(agent, 'p1', observation(), legalActions(), {allowFallback: false});
  assert(decision.action?.choice === 'move 1 1, move 1 1', `${provider} fake response did not select legal choice`);
  assert(decision.call.analysisComplete === true, `${provider} fake response did not satisfy analysis contract`);
  assert(calls.length === 1, `${provider} should call fetch once`);
  assert(calls[0].url === expectedUrl, `${provider} called wrong endpoint`);
  assert(calls[0].method === 'POST', `${provider} should POST`);
  assert(calls[0].hasAuth, `${provider} missing auth header`);
  assert(!calls[0].promptContainsSeed, `${provider} prompt leaked benchmark seed`);
  assert(!calls[0].promptContainsKey, `${provider} prompt leaked API key`);
  if (provider === 'openai') {
    assert(calls[0].responseFormat?.type === 'json_schema', 'OpenAI request missing JSON schema format');
    assert(calls[0].responseFormat?.schema?.properties?.choice?.enum?.includes('move 1 1, move 1 1'), 'OpenAI schema missing exact legal choice enum');
  } else {
    assert(calls[0].responseFormat?.type === 'json_schema', 'OpenRouter request missing JSON schema response format');
    assert(calls[0].responseFormat?.json_schema?.schema?.properties?.choice?.enum?.includes('move 1 1, move 1 1'), 'OpenRouter schema missing exact legal choice enum');
  }
  return calls[0];
}

function observation() {
  return {
    schemaVersion: 'showdown-observation.v1',
    perspective: 'p1',
    opponentRole: 'p2',
    formatid: 'gen9randomdoublesbattle',
    seed: [1, 2, 3, 4],
    turn: 1,
    waiting: false,
    requestId: 1,
    requestFresh: true,
    source: {
      engine: 'pokemon-showdown BattleStream',
      hiddenInfoPolicy: 'official private request + role protocol + own generated team only',
      opponentHiddenTeamIncluded: false,
    },
    self: {
      activePokemon: [{name: 'Testmon A', species: 'Pikachu', condition: '100/100', moves: ['Thunderbolt']}],
      team: [{name: 'Testmon A', species: 'Pikachu', condition: '100/100', item: 'Light Ball', ability: 'Static', nature: 'Timid', teraType: 'Electric', moves: ['Thunderbolt']}],
      sideConditions: {},
    },
    opponent: {
      activePokemon: [{name: 'Testmon B', species: 'Charizard', condition: '100/100', movesRevealed: []}],
      revealedTeam: [{name: 'Testmon B', species: 'Charizard', condition: '100/100', movesRevealed: []}],
      sideConditions: {},
    },
    field: {},
    history: {text: ['Turn 1.'], protocol: ['|turn|1']},
  };
}

function legalActions() {
  return [
    {
      type: 'double-choice',
      choice: 'move 1 1, move 1 1',
      command: 'move 1 1, move 1 1',
      label: 'Test legal doubles choice',
      choices: [
        {type: 'move', choice: 'move 1 1', command: 'move 1 1', move: 'Thunderbolt', activeSlot: 1, targetSlot: 1},
      ],
    },
  ];
}

function redactConfig(config = {}) {
  return {
    ok: Boolean(config.ok),
    provider: config.provider || '',
    model: config.model || '',
    reasoningEffort: config.reasoningEffort || '',
    envName: config.envName || '',
    keyPresent: Boolean(config.keyPresent),
    message: config.message || '',
  };
}

function assertPublicMetadataRedaction() {
  const keyLike = ['sk', 'or', 'v1', 'testsecretthatmustberemoved'].join('-');
  const agent = {
    provider: 'openrouter',
    model: `model-${keyLike}`,
    name: `name-${keyLike}`,
    reasoningEffort: 'low',
  };
  const metadata = publicAgentMetadata(agent);
  assert(!JSON.stringify(metadata).includes(keyLike), 'public metadata leaked key-like agent text');
}

function restoreEnv(name, value) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
