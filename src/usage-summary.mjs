export function summarizeUsage(modelCalls = []) {
  const summary = createBucket();
  summary.byRole = {};
  summary.byProvider = {};
  summary.byModel = {};

  for (const call of modelCalls || []) {
    const usage = normalizeUsage(call);
    addToBucket(summary, usage);
    addToBucket(bucketFor(summary.byRole, call.role || 'unknown'), usage);
    addToBucket(bucketFor(summary.byProvider, call.provider || 'unknown'), usage);
    addToBucket(bucketFor(summary.byModel, call.model || call.responseModel || 'unknown'), usage);
  }

  finalizeCost(summary);
  for (const group of [summary.byRole, summary.byProvider, summary.byModel]) {
    for (const bucket of Object.values(group)) finalizeCost(bucket);
  }
  return summary;
}

function normalizeUsage(call = {}) {
  const usage = call.usage || {};
  const promptTokens = numberFrom(
    usage.input_tokens,
    usage.prompt_tokens,
    usage.promptTokens,
    usage.inputTokens
  );
  const completionTokens = numberFrom(
    usage.output_tokens,
    usage.completion_tokens,
    usage.completionTokens,
    usage.outputTokens
  );
  const totalTokens = numberFrom(
    usage.total_tokens,
    usage.totalTokens,
    promptTokens + completionTokens
  );
  const reasoningTokens = numberFrom(
    usage.output_tokens_details?.reasoning_tokens,
    usage.completion_tokens_details?.reasoning_tokens,
    usage.reasoning_tokens,
    usage.reasoningTokens
  );
  const cachedTokens = numberFrom(
    usage.input_tokens_details?.cached_tokens,
    usage.prompt_tokens_details?.cached_tokens,
    usage.cached_tokens,
    usage.cachedTokens
  );
  const costUsd = costFrom(call);

  return {
    calls: 1,
    validCalls: call.valid ? 1 : 0,
    invalidCalls: call.valid ? 0 : 1,
    fallbackCalls: call.fallback ? 1 : 0,
    errorCalls: call.error ? 1 : 0,
    promptTokens,
    completionTokens,
    reasoningTokens,
    cachedTokens,
    totalTokens,
    costUsd,
    costKnown: costUsd !== null,
  };
}

export function mergeUsageSummaries(...summaries) {
  const merged = createBucket();
  merged.byRole = {};
  merged.byProvider = {};
  merged.byModel = {};
  for (const summary of summaries.filter(Boolean)) {
    addSummaryBucket(merged, summary);
    mergeGroup(merged.byRole, summary.byRole || {});
    mergeGroup(merged.byProvider, summary.byProvider || {});
    mergeGroup(merged.byModel, summary.byModel || {});
  }
  finalizeCost(merged);
  for (const group of [merged.byRole, merged.byProvider, merged.byModel]) {
    for (const bucket of Object.values(group)) finalizeCost(bucket);
  }
  return merged;
}

function addToBucket(bucket, usage) {
  bucket.calls += usage.calls;
  bucket.validCalls += usage.validCalls;
  bucket.invalidCalls += usage.invalidCalls;
  bucket.fallbackCalls += usage.fallbackCalls;
  bucket.errorCalls += usage.errorCalls;
  bucket.promptTokens += usage.promptTokens;
  bucket.completionTokens += usage.completionTokens;
  bucket.reasoningTokens += usage.reasoningTokens;
  bucket.cachedTokens += usage.cachedTokens;
  bucket.totalTokens += usage.totalTokens;
  if (usage.costKnown) {
    bucket.costUsd = (bucket.costUsd || 0) + usage.costUsd;
    bucket.costKnown = true;
  }
}

function addSummaryBucket(target, source) {
  target.calls += Number(source.calls || 0);
  target.validCalls += Number(source.validCalls || 0);
  target.invalidCalls += Number(source.invalidCalls || 0);
  target.fallbackCalls += Number(source.fallbackCalls || 0);
  target.errorCalls += Number(source.errorCalls || 0);
  target.promptTokens += Number(source.promptTokens || 0);
  target.completionTokens += Number(source.completionTokens || 0);
  target.reasoningTokens += Number(source.reasoningTokens || 0);
  target.cachedTokens += Number(source.cachedTokens || 0);
  target.totalTokens += Number(source.totalTokens || 0);
  if (source.costKnown) {
    target.costUsd = (target.costUsd || 0) + Number(source.costUsd || 0);
    target.costKnown = true;
  }
}

function mergeGroup(targetGroup, sourceGroup) {
  for (const [key, source] of Object.entries(sourceGroup)) {
    addSummaryBucket(bucketFor(targetGroup, key), source);
  }
}

function createBucket() {
  return {
    calls: 0,
    validCalls: 0,
    invalidCalls: 0,
    fallbackCalls: 0,
    errorCalls: 0,
    promptTokens: 0,
    completionTokens: 0,
    reasoningTokens: 0,
    cachedTokens: 0,
    totalTokens: 0,
    costUsd: null,
    costKnown: false,
  };
}

function bucketFor(group, key) {
  if (!group[key]) group[key] = createBucket();
  return group[key];
}

function finalizeCost(bucket) {
  if (bucket.costKnown) bucket.costUsd = Number(bucket.costUsd.toFixed(8));
}

function numberFrom(...values) {
  for (const value of values) {
    const number = Number(value);
    if (Number.isFinite(number)) return number;
  }
  return 0;
}

function costFrom(call = {}) {
  const usage = call.usage || {};
  const metadata = call.openrouterMetadata || {};
  const candidates = [
    usage.cost,
    usage.cost_usd,
    usage.costUsd,
    usage.total_cost,
    usage.totalCost,
    metadata.cost,
    metadata.cost_usd,
    metadata.total_cost,
  ];
  for (const value of candidates) {
    const number = Number(value);
    if (Number.isFinite(number)) return number;
  }
  return null;
}
