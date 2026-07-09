import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {runWebSocketMatch} from '../src/match-runner.mjs';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outputPath = process.env.BENCH_OUT || path.join(rootDir, 'artifacts', 'model-duel-latest.json');

const run = await runWebSocketMatch({
  outputPath,
  agentP1: process.env.AGENT_P1 || 'standin',
  agentP2: process.env.AGENT_P2 || 'standin',
  maxTurns: Number(process.env.MAX_TURNS || 25),
  moveDelayMs: Number(process.env.MOVE_DELAY_MS || 200),
  allowFallback: process.env.ALLOW_FALLBACK === '1',
});

console.log(JSON.stringify(run.result, null, 2));
console.log(`wrote ${outputPath}`);
