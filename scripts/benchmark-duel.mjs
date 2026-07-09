import {spawn} from 'node:child_process';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = process.env.BENCH_DIR || path.join(rootDir, 'artifacts', 'benchmark-duels');

const child = spawn(process.execPath, ['scripts/ladder-batch.mjs'], {
  cwd: rootDir,
  stdio: 'inherit',
  env: {
    ...process.env,
    LADDER_DIR: process.env.LADDER_DIR || outDir,
    AGENT_A: process.env.AGENT_A || process.env.AGENT_P1 || 'standin',
    AGENT_B: process.env.AGENT_B || process.env.AGENT_P2 || 'standin',
  },
});

child.on('exit', code => process.exit(code ?? 0));
child.on('error', error => {
  console.error(error.message);
  process.exit(1);
});
