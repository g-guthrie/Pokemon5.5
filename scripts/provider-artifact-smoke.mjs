import {spawn} from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {runWebSocketMatch} from '../src/match-runner.mjs';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const port = Number(process.env.PROVIDER_ARTIFACT_SMOKE_PORT || 3214);
const serverOrigin = `http://localhost:${port}`;
const outputPath = path.join(rootDir, 'artifacts', 'provider-artifact-smoke.json');
const openAIEnvName = ['OPENAI', 'API', 'KEY'].join('_');
const openRouterEnvName = ['OPENROUTER', 'API', 'KEY'].join('_');
const fakeOpenAIKey = ['test', 'openai', 'artifact', 'key'].join('-');
const fakeOpenRouterKey = ['test', 'openrouter', 'artifact', 'key'].join('-');
const previousFetch = globalThis.fetch;
const previousOpenAIKey = process.env[openAIEnvName];
const previousOpenRouterKey = process.env[openRouterEnvName];

process.env[openAIEnvName] = fakeOpenAIKey;
process.env[openRouterEnvName] = fakeOpenRouterKey;

const providerCalls = [];
globalThis.fetch = async (url, options = {}) => {
  const textUrl = String(url);
  if (textUrl.startsWith(serverOrigin)) return previousFetch(url, options);
  const provider = textUrl.includes('openrouter.ai') ? 'openrouter' : textUrl.includes('api.openai.com') ? 'openai' : '';
  if (!provider) return previousFetch(url, options);

  const requestBody = JSON.parse(String(options.body || '{}'));
  const prompt = provider === 'openai' ? String(requestBody.input || '') : String(requestBody.messages?.at(-1)?.content || '');
  const payload = parsePromptPayload(prompt);
  const choice = chooseLegalAction(payload.legalActions || []);
  // Answer whichever schema the payload asked for: the turn questionnaire or
  // the focused replacement mind.
  const content = JSON.stringify(payload.decisionFrame?.decisionType === 'replacement' ? {
    replacementMatchups: [`${choice}: legal smoke send-in with deterministic adapter proof.`],
    replacementRisks: ['This no-paid smoke send-in only proves adapter and artifact contracts.'],
    replacementPlan: ['Resolve the forced replacement and continue the smoke battle.'],
    choice,
    reason: 'Selected a legal no-paid smoke replacement.',
  } : {
    gameStateSummary: [`${payload.role || 'agent'} has an actionable doubles request.`],
    setArchetypes: ['Revealed actives read as generic smoke-battle sets.'],
    unknownInformation: ['Opponent items and bench remain unrevealed in this smoke.'],
    opponentLikelyPlan: ['Opponent will choose from its own exact legal action set.'],
    biggestThreats: ['The opposing active slots are the immediate benchmark threats.'],
    winConditions: ['Use exact legal choices and keep pressure on revealed active Pokemon.'],
    loseConditions: ['Losing tempo to repeated protects is the main imminent loss path.'],
    teraAndSwitchCheck: ['No smoke Terastallization or proactive switch is needed this turn.'],
    candidateOutcomes: ['Into any legal response, the smoke action still resolves the turn.'],
    decisionCheck: ['This no-paid smoke only proves adapter and artifact contracts.'],
    candidateChoices: [
      `${choice}: legal smoke action with deterministic adapter proof; risk is max-turn cap in this short run.`,
    ],
    choice,
    reason: 'Selected a legal no-paid smoke action.',
  });

  providerCalls.push({
    provider,
    url: textUrl,
    method: options.method || '',
    hasAuth: Boolean(options.headers?.authorization),
    promptChars: prompt.length,
    promptContainsOpenAIKey: prompt.includes(fakeOpenAIKey),
    promptContainsOpenRouterKey: prompt.includes(fakeOpenRouterKey),
    promptContainsSeed: prompt.includes('550000') || prompt.includes('550017'),
    choice,
  });

  if (provider === 'openai') {
    return {
      ok: true,
      status: 200,
      json: async () => ({
        id: 'fake-provider-artifact-openai',
        model: requestBody.model || 'fake-openai',
        output_text: content,
        usage: {input_tokens: 40, output_tokens: 20, total_tokens: 60},
      }),
    };
  }
  return {
    ok: true,
    status: 200,
    json: async () => ({
      id: 'fake-provider-artifact-openrouter',
      model: requestBody.model || 'fake-openrouter',
      choices: [{message: {content}}],
      usage: {prompt_tokens: 44, completion_tokens: 22, total_tokens: 66},
      openrouter_metadata: {total_cost: 0.000001},
    }),
  };
};

const server = spawn(process.execPath, ['src/server.mjs'], {
  cwd: rootDir,
  env: {...process.env, PORT: String(port)},
  stdio: ['ignore', 'pipe', 'pipe'],
});

let output = '';
const timeout = setTimeout(() => fail('provider artifact smoke timed out'), 30000);

server.stdout.on('data', data => {
  output += String(data);
  if (output.includes(serverOrigin)) void run();
});
server.stderr.on('data', data => {
  output += String(data);
});
server.on('exit', code => {
  if (code && code !== 0) fail(`server exited early with ${code}\n${output}`);
});

async function run() {
  server.stdout.removeAllListeners('data');
  try {
    const runArtifact = await runWebSocketMatch({
      serverOrigin,
      outputPath,
      seed: [550000, 1, 550017, 550101],
      maxTurns: 4,
      moveDelayMs: 1,
      timeoutMs: 20000,
      allowFallback: false,
      agents: {
        p1: {provider: 'openai', model: 'provider-artifact-openai', name: 'provider-artifact-openai'},
        p2: {provider: 'openrouter', model: 'provider/artifact-openrouter', name: 'provider-artifact-openrouter'},
      },
    });
    const artifact = JSON.parse(await fs.readFile(outputPath, 'utf8'));
    const events = (await fs.readFile(runArtifact.eventsPath, 'utf8')).trim().split('\n').map(line => JSON.parse(line));

    assert(providerCalls.some(call => call.provider === 'openai'), 'OpenAI adapter was not called');
    assert(providerCalls.some(call => call.provider === 'openrouter'), 'OpenRouter adapter was not called');
    assert(providerCalls.every(call => call.method === 'POST' && call.hasAuth), 'provider calls should POST with auth headers');
    assert(providerCalls.every(call => !call.promptContainsOpenAIKey && !call.promptContainsOpenRouterKey), 'provider prompt leaked fake key');
    assert(providerCalls.every(call => !call.promptContainsSeed), 'provider prompt leaked benchmark seed');
    assert(artifact.modelCalls.some(call => call.provider === 'openai'), 'artifact missing OpenAI model call');
    assert(artifact.modelCalls.some(call => call.provider === 'openrouter'), 'artifact missing OpenRouter model call');
    assert(artifact.modelCalls.every(call => call.promptSchemaVersion === 'showdown-choice-prompt.v9'), 'artifact model calls missing prompt schema');
    assert(artifact.modelCalls.every(call => call.responseSchemaVersion === 'showdown-choice-response.v9'), 'artifact model calls missing response schema');
    assert(artifact.modelCalls.every(call => call.prompt && call.rawText && call.analysisComplete === true), 'artifact missing prompt/raw response/analysis contract');
    // Turn calls compare candidateChoices; forced replacements compare
    // replacementMatchups. Every call must carry one of the two reviews.
    assert(artifact.modelCalls.every(call => call.analysis?.candidateChoices?.length || call.analysis?.replacementMatchups?.length), 'artifact missing candidate choice or replacement matchup review');
    assert(artifact.modelCalls.every(call => call.usage), 'artifact missing provider usage metadata');
    assert(!JSON.stringify(artifact).includes(fakeOpenAIKey), 'artifact leaked fake OpenAI key');
    assert(!JSON.stringify(artifact).includes(fakeOpenRouterKey), 'artifact leaked fake OpenRouter key');
    assert(!artifact.modelCalls.some(call => String(call.prompt || '').includes('550000')), 'artifact prompt leaked benchmark seed');
    const serializedEvents = JSON.stringify(events);
    assert(events.some(event => event.type === 'model_call' && event.promptRef?.sha256 && event.rawTextRef?.sha256), 'event log missing provider prompt/response refs');
    assert(!serializedEvents.includes('screenObservation'), 'event log should not duplicate full prompts');

    clearTimeout(timeout);
    console.log(JSON.stringify({
      ok: true,
      result: artifact.result,
      validBenchmark: artifact.validBenchmark,
      providerCalls: providerCalls.length,
      outputPath,
      eventsPath: runArtifact.eventsPath,
    }, null, 2));
    cleanupAndExit(0);
  } catch (error) {
    fail(error.stack || String(error));
  }
}

function parsePromptPayload(prompt) {
  const index = prompt.indexOf('{');
  assert(index >= 0, 'prompt missing JSON payload');
  return JSON.parse(prompt.slice(index));
}

function chooseLegalAction(legalActions = []) {
  return legalActions.find(choice => !choice.includes('terastallize') && !choice.includes('switch')) ||
    legalActions.find(choice => !choice.includes('terastallize')) ||
    legalActions[0] ||
    '';
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function fail(message) {
  clearTimeout(timeout);
  console.error(`Provider artifact smoke failed: ${message}`);
  cleanupAndExit(1);
}

function cleanupAndExit(code) {
  globalThis.fetch = previousFetch;
  restoreEnv(openAIEnvName, previousOpenAIKey);
  restoreEnv(openRouterEnvName, previousOpenRouterKey);
  if (server.exitCode === null) server.kill();
  process.exit(code);
}

function restoreEnv(name, value) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}
