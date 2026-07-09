import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {runWebSocketMatch} from '../src/match-runner.mjs';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outputPath = process.env.BENCH_OUT || path.join(rootDir, 'artifacts', 'openai-duel-latest.json');
const model = process.env.OPENAI_MODEL || 'gpt-5.5';
const reasoningEffort = process.env.OPENAI_REASONING_EFFORT || 'low';

const run = await runWebSocketMatch({
  outputPath,
  agents: {
    p1: {
      provider: 'openai',
      model: process.env.OPENAI_MODEL_P1 || model,
      reasoningEffort: process.env.OPENAI_REASONING_EFFORT_P1 || reasoningEffort,
      name: 'openai-p1',
    },
    p2: {
      provider: 'openai',
      model: process.env.OPENAI_MODEL_P2 || model,
      reasoningEffort: process.env.OPENAI_REASONING_EFFORT_P2 || reasoningEffort,
      name: 'openai-p2',
    },
  },
  maxTurns: Number(process.env.MAX_TURNS || 3),
  moveDelayMs: Number(process.env.MOVE_DELAY_MS || 750),
  allowFallback: process.env.ALLOW_FALLBACK === '1',
});

console.log(JSON.stringify(run.result, null, 2));
console.log(`wrote ${outputPath}`);
