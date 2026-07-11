import {spawn} from 'node:child_process';
import fs from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import path from 'node:path';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const port = Number(process.env.BENCHMARK_API_SMOKE_PORT || 3209);
const serverOrigin = `http://localhost:${port}`;
const server = spawn(process.execPath, ['src/server.mjs'], {
  cwd: rootDir,
  env: {...process.env, PORT: String(port)},
  stdio: ['ignore', 'pipe', 'pipe'],
});

let output = '';
const timeout = setTimeout(() => fail('benchmark API smoke timed out'), 30000);

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
    const concurrentPayload = {
      command: 'plan',
      modelCatalog,
      rankedCandidates: [{rank: 1, id: 'ranked/supported-a', label: 'Supported A'}],
      openRouterLimit: 1,
      openaiBaselines: 'openai:gpt-5.5:low',
      battlesPerPair: 1,
      watchLocal: false,
    };
    const concurrent = await Promise.all([
      post('/api/benchmark', concurrentPayload, {expectOk: false}),
      post('/api/benchmark', concurrentPayload, {expectOk: false}),
    ]);
    assert(concurrent.filter(result => result.ok).length === 1, 'exactly one concurrent benchmark plan should own the transition');
    const transitionRefusal = concurrent.find(result => !result.ok);
    assert(/already in progress/.test(String(transitionRefusal?.error || '')), 'concurrent benchmark plan should be refused by the transition lock');

    const planned = await post('/api/benchmark', {
      command: 'plan',
      modelCatalog,
      rankedCandidates: [
        {rank: 1, id: 'ranked/supported-a', label: 'Supported A'},
        {rank: 2, id: 'ranked/unsupported-b', label: 'Unsupported B'},
      ],
      openRouterLimit: 2,
      openaiBaselines: 'openai:gpt-5.5:low, openai:gpt-5.5:medium',
      battlesPerPair: 1,
      watchLocal: false,
    });
    assert(planned.ok, 'plan did not return ok');
    assert(planned.benchmark?.status === 'planned', 'benchmark did not enter planned status');
    assert(planned.benchmark?.openrouterModels?.length === 2, 'plan did not select/fill two OpenRouter models');
    assert(planned.benchmark?.openaiBaselines?.length === 2, 'plan did not keep two OpenAI baselines');
    assert(planned.benchmark?.pairCount === 4, 'plan did not create OpenAI-vs-OpenRouter pair matrix');
    assert(planned.benchmark?.planPath && planned.benchmark?.planHref, 'plan missing artifact links');
    assert(planned.benchmark?.runPaidBenchmark === false, 'plan should not be marked paid');

    const plan = JSON.parse(await fs.readFile(planned.benchmark.planPath, 'utf8'));
    assert(plan.schemaVersion === 'showdown-openrouter-benchmark-suite.v1', 'wrong plan schema');
    assert(plan.pairs.length === 4, 'written plan has wrong pair count');

    const refused = await post('/api/benchmark', {
      command: 'start',
      modelCatalog,
      openRouterLimit: 1,
      openaiBaselines: 'openai:gpt-5.5:low',
      battlesPerPair: 1,
      watchLocal: false,
    }, {expectOk: false});
    assert(refused.ok === false, 'unconfirmed paid run should be refused');
    assert(String(refused.error || '').includes('runPaidBenchmark'), 'refusal should name paid confirmation');

    const status = await get('/api/benchmark');
    assert(status.benchmark?.status === 'planned', 'refused run should leave planned benchmark intact');

    clearTimeout(timeout);
    console.log(JSON.stringify({
      ok: true,
      status: planned.benchmark.status,
      pairCount: planned.benchmark.pairCount,
      planPath: planned.benchmark.planPath,
      refused: refused.error,
      concurrentTransitionRefused: transitionRefusal.error,
    }, null, 2));
    server.kill();
    process.exit(0);
  } catch (error) {
    fail(error.stack || String(error));
  }
}

async function post(urlPath, body, options = {}) {
  const response = await fetch(`${serverOrigin}${urlPath}`, {
    method: 'POST',
    headers: {'content-type': 'application/json'},
    body: JSON.stringify(body),
  });
  const parsed = await response.json();
  if (options.expectOk === false) return parsed;
  if (!response.ok) throw new Error(parsed.error || `HTTP ${response.status}`);
  return parsed;
}

async function get(urlPath) {
  const response = await fetch(`${serverOrigin}${urlPath}`);
  const parsed = await response.json();
  if (!response.ok) throw new Error(parsed.error || `HTTP ${response.status}`);
  return parsed;
}

function model({id, name, created, supportedParameters}) {
  return {
    id,
    canonical_slug: id,
    name,
    created,
    context_length: 131072,
    architecture: {input_modalities: ['text'], output_modalities: ['text']},
    pricing: {prompt: '0.0000001', completion: '0.0000002', request: '0'},
    supported_parameters: supportedParameters,
    top_provider: {context_length: 131072, max_completion_tokens: 4096, is_moderated: true},
  };
}

const modelCatalog = [
  model({
    id: 'ranked/supported-a',
    name: 'Ranked Supported A',
    created: 10,
    supportedParameters: ['response_format', 'structured_outputs'],
  }),
  model({
    id: 'ranked/unsupported-b',
    name: 'Ranked Unsupported B',
    created: 20,
    supportedParameters: ['temperature'],
  }),
  model({
    id: 'fill/newer-c',
    name: 'Fill Newer C',
    created: 40,
    supportedParameters: ['response_format'],
  }),
];

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function fail(message) {
  clearTimeout(timeout);
  if (server.exitCode === null) server.kill();
  console.error(`Benchmark API smoke failed: ${message}`);
  process.exit(1);
}
