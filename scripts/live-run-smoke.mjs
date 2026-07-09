import {spawn} from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const port = Number(process.env.LIVE_RUN_SMOKE_PORT || 3204);
const serverOrigin = `http://localhost:${port}`;
const server = spawn(process.execPath, ['src/server.mjs'], {
  cwd: rootDir,
  env: {...process.env, PORT: String(port)},
  stdio: ['ignore', 'pipe', 'pipe'],
});

let output = '';
const timeout = setTimeout(() => fail('live run smoke timed out'), 25000);

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
    const start = await post('/api/run', {
      command: 'start',
      battleId: 'local',
      agentP1: 'standin',
      agentP2: 'standin',
      seed: [550000, 1, 550017, 550101],
      maxTurns: 40,
      moveDelayMs: 5,
      startPaused: true,
    });
    assert(start.ok, 'start did not return ok');
    assert(start.run?.status === 'paused', 'run did not enter paused status');
    assert(start.run?.battleId === 'local', 'live run should attach to local battle');
    const paused = await get('/api/run');
    assert(paused.run?.status === 'paused', 'run status did not report paused');
    const resumed = await post('/api/run', {command: 'resume'});
    assert(resumed.run?.status === 'running', 'run did not resume');

    const final = await pollRun();
    assert(final.status === 'finished', `run did not finish cleanly: ${final.status}`);
    assert(final.result?.winner, 'finished run missing winner');
    assert(final.outputPath && final.eventsPath, 'finished run missing artifacts');
    assert(final.currentTurn > 0, 'finished run missing current turn telemetry');
    assert(final.actionCount > 0, 'finished run missing action count telemetry');
    assert(final.modelCallCount >= final.actionCount, 'finished run missing model call telemetry');
    assert(final.observationCount >= final.actionCount, 'finished run missing observation telemetry');
    assert(final.usage?.calls === final.modelCallCount, 'finished run usage did not track model calls');
    assert(final.validBenchmark === true, 'finished run should report valid benchmark telemetry');
    assert(final.apiErrorCount === 0 && final.fallbackCount === 0 && final.invalidChoiceCount === 0, 'stand-in run should not report invalid telemetry');
    assert(final.lastObservation?.legalActionCount > 0, 'finished run missing last observation summary');
    assert(final.lastModelCall?.choice, 'finished run missing last model call summary');
    assert(Array.isArray(final.lastActions) && final.lastActions.length > 0, 'finished run missing last action summaries');
    const artifact = JSON.parse(await fs.readFile(final.outputPath, 'utf8'));
    assert(artifact.battleId === 'local', 'artifact was not for local battle');
    assert(artifact.validBenchmark === true, 'stand-in live run should be a valid benchmark');
    assert(artifact.actions.length > 0, 'live run artifact missing actions');
    assert(final.lastActions.at(-1).choice === artifact.actions.at(-1).choice, 'live telemetry last action did not match artifact');
    const eventLines = (await fs.readFile(final.eventsPath, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    assert(eventLines[0]?.type === 'match_start', 'event log missing start');
    assert(eventLines.at(-1)?.type === 'match_end', 'event log missing end');

    clearTimeout(timeout);
    console.log(JSON.stringify({
      ok: true,
      status: final.status,
      winner: final.result.winner,
      turn: final.result.turn,
      outputPath: final.outputPath,
      eventsPath: final.eventsPath,
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

async function pollRun() {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const body = await get('/api/run');
    if (body.run && !['running', 'paused', 'stopping'].includes(body.run.status)) return body.run;
    await new Promise(resolve => setTimeout(resolve, 150));
  }
  throw new Error('run did not settle');
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function fail(message) {
  clearTimeout(timeout);
  if (server.exitCode === null) server.kill();
  console.error(`Live run smoke failed: ${message}`);
  process.exit(1);
}
