import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {
  buildOpenRouterBenchmarkPlan,
  runOpenRouterBenchmarkSuite,
  writeBenchmarkPlan,
} from '../src/benchmark-suite.mjs';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const command = String(process.argv[2] || process.env.BENCHMARK_MODE || 'plan').trim().toLowerCase();
const runId = process.env.BENCHMARK_RUN_ID || `openrouter-top-${new Date().toISOString().replace(/[:.]/g, '-')}`;
const outDir = process.env.BENCHMARK_DIR || path.join(rootDir, 'artifacts', 'benchmark-suites', runId);

if (command === 'plan') {
  const plan = await buildOpenRouterBenchmarkPlan({
    name: process.env.BENCHMARK_SUITE_NAME || 'openrouter-top-vs-openai',
  });
  const planPath = path.join(outDir, 'suite-plan.json');
  await writeBenchmarkPlan(plan, planPath);
  console.log(JSON.stringify({
    ok: true,
    mode: 'plan',
    planPath,
    openrouterModels: plan.openrouterModels.length,
    openaiBaselines: plan.openaiBaselines.length,
    pairs: plan.pairs.length,
    excluded: plan.excludedOpenRouterCandidates.length,
    firstOpenRouterModels: plan.openrouterModels.slice(0, 10).map(model => ({
      rank: model.rank,
      id: model.id,
      name: model.name,
      source: model.selectionSource,
    })),
  }, null, 2));
} else if (command === 'run') {
  if (process.env.RUN_PAID_BENCHMARK !== '1') {
    throw new Error('Refusing paid benchmark run unless RUN_PAID_BENCHMARK=1 is set');
  }
  const summary = await runOpenRouterBenchmarkSuite({
    runId,
    outDir,
  });
  console.log(JSON.stringify({
    ok: true,
    mode: 'run',
    summaryPath: summary.summaryPath,
    planPath: summary.planPath,
    pairs: summary.pairs.length,
    completedBattles: summary.totals.completedBattles,
    invalidBenchmarks: summary.totals.invalidBenchmarks,
    usage: summary.usage,
  }, null, 2));
} else {
  throw new Error(`Unknown benchmark suite command: ${command}`);
}
