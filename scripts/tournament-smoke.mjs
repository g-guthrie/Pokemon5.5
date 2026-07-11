import {spawn} from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {runTournamentBatch} from '../src/tournament-runner.mjs';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const port = Number(process.env.TOURNAMENT_SMOKE_PORT || 3206);
const serverOrigin = `http://localhost:${port}`;
const outDir = path.join(rootDir, 'artifacts', 'tournament-smoke');
const server = spawn(process.execPath, ['src/server.mjs'], {
  cwd: rootDir,
  env: {...process.env, PORT: String(port)},
  stdio: ['ignore', 'pipe', 'pipe'],
});

let output = '';
const timeout = setTimeout(() => fail('tournament smoke timed out'), 90000);

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
    await fs.rm(outDir, {recursive: true, force: true});
    const summary = await runTournamentBatch({
      serverOrigin,
      agents: ['standin', 'heuristic', 'standin:alt'],
      battlesPerPair: 1,
      maxTurns: 8,
      moveDelayMs: 1,
      timeoutMs: 12000,
      outDir,
      seedBase: 880000,
      watchLocal: false,
    });

    assert(summary.schemaVersion === 'showdown-tournament-summary.v1', 'wrong tournament schema');
    assert(summary.pairCount === 3, 'wrong pair count');
    assert(summary.completedBattles === 3, 'wrong completed battle count');
    assert(summary.pairs.length === 3, 'missing pair summaries');
    assert(Object.keys(summary.standings || {}).length === 3, 'standings should include all agents');
    assert(summary.summaryPath, 'missing summary path');
    JSON.parse(await fs.readFile(summary.summaryPath, 'utf8'));
    for (const pair of summary.pairs) {
      assert(pair.summaryPath, 'pair missing summary path');
      const pairSummary = JSON.parse(await fs.readFile(pair.summaryPath, 'utf8'));
      assert(pairSummary.schemaVersion === 'showdown-ladder-summary.v1', 'pair did not use ladder summary');
      assert(pairSummary.battles.length === 1, 'pair missing battle');
      assert(pairSummary.battles[0].eventsPath, 'battle missing event artifact');
      await fs.access(pairSummary.battles[0].eventsPath);
    }

    clearTimeout(timeout);
    console.log(JSON.stringify({
      ok: true,
      pairs: summary.pairCount,
      completedBattles: summary.completedBattles,
      summaryPath: summary.summaryPath,
    }, null, 2));
    server.kill();
    process.exit(0);
  } catch (error) {
    fail(error.stack || String(error));
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function fail(message) {
  clearTimeout(timeout);
  if (server.exitCode === null) server.kill();
  console.error(`Tournament smoke failed: ${message}`);
  process.exit(1);
}
