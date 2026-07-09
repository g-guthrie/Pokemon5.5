import {chooseWithAgent, createAgent} from '../src/agent-runtime.mjs';

const previousFetch = globalThis.fetch;
const openAIEnvName = ['OPENAI', 'API', 'KEY'].join('_');
const openRouterEnvName = ['OPENROUTER', 'API', 'KEY'].join('_');
const previousOpenAIKey = process.env[openAIEnvName];
const previousOpenRouterKey = process.env[openRouterEnvName];

try {
  process.env[openAIEnvName] = 'test-openai-provider-abort';
  process.env[openRouterEnvName] = 'test-openrouter-provider-abort';

  const openai = await assertProviderAbort({
    provider: 'openai',
    model: 'abort-test-openai',
    envName: openAIEnvName,
    expectedUrl: 'https://api.openai.com/v1/responses',
  });
  const openrouter = await assertProviderAbort({
    provider: 'openrouter',
    model: 'abort-test-openrouter',
    envName: openRouterEnvName,
    expectedUrl: 'https://openrouter.ai/api/v1/chat/completions',
  });

  console.log(JSON.stringify({
    ok: true,
    openai,
    openrouter,
  }, null, 2));
} finally {
  globalThis.fetch = previousFetch;
  restoreEnv(openAIEnvName, previousOpenAIKey);
  restoreEnv(openRouterEnvName, previousOpenRouterKey);
}

async function assertProviderAbort({provider, model, envName, expectedUrl}) {
  const controller = new AbortController();
  const calls = [];
  globalThis.fetch = (url, options = {}) => new Promise((resolve, reject) => {
    calls.push({
      url: String(url),
      method: options.method || '',
      hasSignal: Boolean(options.signal),
      sameSignal: options.signal === controller.signal,
      authorization: options.headers?.authorization ? '[present]' : '',
    });
    if (!options.signal) {
      reject(new Error('provider fetch did not receive AbortSignal'));
      return;
    }
    if (options.signal.aborted) {
      reject(abortError());
      return;
    }
    options.signal.addEventListener('abort', () => reject(abortError()), {once: true});
  });

  const agent = await createAgent({
    provider,
    model,
    reasoningEffort: 'low',
    name: `${provider}-abort-smoke`,
    capturePrompts: false,
  });

  const promise = chooseWithAgent(agent, 'p1', observation(), legalActions(), {
    allowFallback: false,
    signal: controller.signal,
  });
  setTimeout(() => controller.abort(), 10);

  let aborted = false;
  try {
    await promise;
  } catch (error) {
    aborted = error?.name === 'AbortError';
  }

  assert(aborted, `${provider} choice did not reject with AbortError`);
  assert(calls.length === 1, `${provider} should make one fetch call`);
  assert(calls[0].url === expectedUrl, `${provider} called wrong URL`);
  assert(calls[0].method === 'POST', `${provider} should POST`);
  assert(calls[0].hasSignal && calls[0].sameSignal, `${provider} fetch did not use the provided signal`);
  assert(calls[0].authorization === '[present]', `${provider} missing authorization header`);

  return {
    url: calls[0].url,
    signalPassed: calls[0].sameSignal,
    aborted,
    envName,
  };
}

function observation() {
  return {
    schemaVersion: 'showdown-observation.v1',
    perspective: 'p1',
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
      team: [{name: 'Testmon A', species: 'Pikachu', condition: '100/100', moves: ['Thunderbolt']}],
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

function abortError() {
  const error = new Error('The operation was aborted');
  error.name = 'AbortError';
  return error;
}

function restoreEnv(name, value) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

function assert(condition, message) {
  if (!condition) {
    console.error(`Provider abort smoke failed: ${message}`);
    process.exit(1);
  }
}
