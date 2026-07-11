import {spawn} from 'node:child_process';
import fs from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import path from 'node:path';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const port = Number(process.env.TOURNAMENT_API_SMOKE_PORT || 3207);
const serverOrigin = `http://localhost:${port}`;
const server = spawn(process.execPath, ['src/server.mjs'], {
  cwd: rootDir,
  env: {...process.env, PORT: String(port)},
  stdio: ['ignore', 'pipe', 'pipe'],
});

let output = '';
const timeout = setTimeout(() => fail('tournament API smoke timed out'), 90000);

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
    const start = await post('/api/tournament', {
      command: 'start',
      agents: 'standin, heuristic, standin:alt',
      battlesPerPair: 1,
      maxTurns: 8,
      moveDelayMs: 1,
      timeoutMs: 12000,
      watchLocal: false,
      startPaused: true,
    });
    assert(start.ok, 'start did not return ok');
    assert(start.tournament?.status === 'paused', 'tournament did not start paused');
    assert(start.tournament?.pairCount === 3, 'wrong tournament pair count');

    const resumed = await post('/api/tournament', {command: 'resume'});
    assert(resumed.tournament?.status === 'running', 'tournament did not resume');

    const final = await pollTournament();
    assert(final.status === 'finished', `tournament did not finish cleanly: ${final.status}`);
    assert(final.currentPair === 3, 'tournament did not record all pairs');
    assert(final.completedBattles === 3, 'tournament did not record all battles');
    assert(final.summaryPath && final.summaryHref, 'tournament missing summary path');

    const summary = JSON.parse(await fs.readFile(final.summaryPath, 'utf8'));
    assert(summary.schemaVersion === 'showdown-tournament-summary.v1', 'wrong summary schema');
    assert(summary.pairs.length === 3, 'summary missing pairs');
    assert(summary.completedBattles === 3, 'summary missing battles');

    clearTimeout(timeout);
    console.log(JSON.stringify({
      ok: true,
      status: final.status,
      currentPair: final.currentPair,
      completedBattles: final.completedBattles,
      summaryPath: final.summaryPath,
    }, null, 2));
    server.kill();
    process.exit(0);
  } catch (error) {
    fail(error.stack || String(error));
  }
}

async function post(urlPath, body) {
  const response = await fetch(`${serverOrigin}${urlPath}`, {
    method: 'POST',
    headers: {'content-type': 'application/json'},
    body: JSON.stringify(body),
  });
  const parsed = await response.json();
  if (!response.ok) throw new Error(parsed.error || `HTTP ${response.status}`);
  return parsed;
}

async function get(urlPath) {
  const response = await fetch(`${serverOrigin}${urlPath}`);
  const parsed = await response.json();
  if (!response.ok) throw new Error(parsed.error || `HTTP ${response.status}`);
  return parsed;
}

async function pollTournament() {
  for (let attempt = 0; attempt < 180; attempt += 1) {
    const body = await get('/api/tournament');
    if (body.tournament && !['running', 'paused', 'stopping'].includes(body.tournament.status)) return body.tournament;
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  throw new Error('tournament did not settle');
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function fail(message) {
  clearTimeout(timeout);
  if (server.exitCode === null) server.kill();
  console.error(`Tournament API smoke failed: ${message}`);
  process.exit(1);
}
