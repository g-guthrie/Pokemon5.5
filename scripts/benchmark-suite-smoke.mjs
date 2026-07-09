import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {
  buildOpenRouterBenchmarkPlan,
  writeBenchmarkPlan,
} from '../src/benchmark-suite.mjs';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outputPath = path.join(rootDir, 'artifacts', 'benchmark-suite-smoke.json');

const modelCatalog = [
  model({
    id: 'ranked/supported-a',
    name: 'Ranked Supported A',
    created: 10,
    supportedParameters: ['max_tokens', 'response_format', 'structured_outputs', 'temperature'],
  }),
  model({
    id: 'ranked/unsupported-b',
    name: 'Ranked Unsupported B',
    created: 20,
    supportedParameters: ['max_tokens', 'temperature'],
  }),
  model({
    id: 'fill/newer-c',
    name: 'Fill Newer C',
    created: 40,
    supportedParameters: ['max_tokens', 'response_format', 'structured_outputs'],
  }),
  model({
    id: 'fill/older-d',
    name: 'Fill Older D',
    created: 30,
    supportedParameters: ['max_tokens', 'response_format'],
  }),
];

const plan = await buildOpenRouterBenchmarkPlan({
  modelCatalog,
  openRouterLimit: 3,
  openaiBaselines: ['openai:gpt-5.5:low', 'openai:gpt-5.5:medium'],
  rankedCandidates: [
    {rank: 1, id: 'ranked/supported-a', label: 'Supported A'},
    {rank: 2, id: 'ranked/unsupported-b', label: 'Unsupported B'},
    {rank: 3, id: 'ranked/missing-c', label: 'Missing C'},
  ],
});

assert(plan.schemaVersion === 'showdown-openrouter-benchmark-suite.v1', 'wrong suite schema');
assert(plan.formatid === 'gen9randomdoublesbattle', 'suite must keep random doubles default');
assert(plan.openrouterModels.length === 3, 'suite should fill to requested OpenRouter limit');
assert(plan.openrouterModels[0].id === 'ranked/supported-a', 'ranked supported model should stay first');
assert(plan.openrouterModels[1].id === 'fill/newer-c', 'catalog fill should use newest structured model first');
assert(plan.openrouterModels[2].id === 'fill/older-d', 'catalog fill should continue by created time');
assert(plan.excludedOpenRouterCandidates.some(item => item.reason === 'missing-response-format-or-structured-outputs'), 'unsupported ranked model should be excluded');
assert(plan.excludedOpenRouterCandidates.some(item => item.reason === 'missing-from-model-catalog'), 'missing ranked model should be excluded');
assert(plan.openaiBaselines.length === 2, 'OpenAI baselines missing');
assert(plan.pairs.length === 6, 'cross-provider pair count should be OpenAI baselines times OpenRouter models');
assert(plan.pairs.every(pair => pair.openai.provider === 'openai' && pair.openrouter.provider === 'openrouter'), 'pairs should be OpenAI vs OpenRouter only');
assert(!JSON.stringify(plan).match(/sk-or-v1-|sk-[A-Za-z0-9_-]{16,}/), 'suite plan leaked a secret-looking value');

await writeBenchmarkPlan(plan, outputPath);
console.log(JSON.stringify({
  ok: true,
  outputPath,
  openrouterModels: plan.openrouterModels.map(model => model.id),
  excluded: plan.excludedOpenRouterCandidates.map(item => ({id: item.id, reason: item.reason})),
  pairs: plan.pairs.length,
}, null, 2));

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

function assert(condition, message) {
  if (!condition) {
    console.error(`Benchmark suite smoke failed: ${message}`);
    process.exit(1);
  }
}
