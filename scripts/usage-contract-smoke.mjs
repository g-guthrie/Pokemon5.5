import {mergeUsageSummaries, summarizeUsage} from '../src/usage-summary.mjs';

const openaiCalls = [
  {
    role: 'p1',
    provider: 'openai',
    model: 'gpt-test',
    valid: true,
    usage: {
      input_tokens: 100,
      output_tokens: 25,
      total_tokens: 125,
      input_tokens_details: {cached_tokens: 10},
      output_tokens_details: {reasoning_tokens: 5},
    },
  },
  {
    role: 'p2',
    provider: 'openrouter',
    model: 'router-test',
    valid: false,
    fallback: true,
    error: 'invalid choice',
    usage: {
      prompt_tokens: 80,
      completion_tokens: 20,
      total_tokens: 100,
      cost: 0.0012,
    },
  },
];

const first = summarizeUsage(openaiCalls);
assert(first.calls === 2, 'wrong call count');
assert(first.validCalls === 1, 'wrong valid count');
assert(first.invalidCalls === 1, 'wrong invalid count');
assert(first.fallbackCalls === 1, 'wrong fallback count');
assert(first.errorCalls === 1, 'wrong error count');
assert(first.promptTokens === 180, 'wrong prompt token count');
assert(first.completionTokens === 45, 'wrong completion token count');
assert(first.totalTokens === 225, 'wrong total token count');
assert(first.cachedTokens === 10, 'wrong cached token count');
assert(first.reasoningTokens === 5, 'wrong reasoning token count');
assert(first.costKnown === true && first.costUsd === 0.0012, 'wrong cost aggregation');
assert(first.byRole.p1.totalTokens === 125, 'wrong p1 role usage');
assert(first.byProvider.openrouter.costUsd === 0.0012, 'wrong provider cost');

const merged = mergeUsageSummaries(first, first);
assert(merged.calls === 4, 'merged call count wrong');
assert(merged.totalTokens === 450, 'merged tokens wrong');
assert(merged.costUsd === 0.0024, 'merged cost wrong');
assert(merged.byModel['gpt-test'].calls === 2, 'merged model bucket wrong');

console.log(JSON.stringify({
  ok: true,
  first: {
    calls: first.calls,
    totalTokens: first.totalTokens,
    costUsd: first.costUsd,
  },
  merged: {
    calls: merged.calls,
    totalTokens: merged.totalTokens,
    costUsd: merged.costUsd,
  },
}, null, 2));

function assert(condition, message) {
  if (!condition) {
    console.error(`Usage contract failed: ${message}`);
    process.exit(1);
  }
}
