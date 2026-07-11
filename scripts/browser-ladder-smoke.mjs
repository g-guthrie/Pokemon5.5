import {spawn} from 'node:child_process';
import fs from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import path from 'node:path';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const port = Number(process.env.BROWSER_LADDER_SMOKE_PORT || 3205);
const serverOrigin = `http://localhost:${port}`;
const server = spawn(process.execPath, ['src/server.mjs'], {
  cwd: rootDir,
  env: {...process.env, PORT: String(port)},
  stdio: ['ignore', 'pipe', 'pipe'],
});

let output = '';
const timeout = setTimeout(() => fail('browser ladder smoke timed out'), 30000);

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
    const start = await post('/api/ladder', {
      command: 'start',
      agentA: 'standin',
      agentB: 'standin',
      battleCount: 1,
      maxTurns: 40,
      moveDelayMs: 5,
      watchLocal: true,
      startPaused: true,
    });
    assert(start.ok, 'start did not return ok');
    assert(start.ladder?.status === 'paused', 'ladder did not start paused');
    assert(start.ladder?.watchLocal === true, 'ladder should target local watched battle');

    const resumed = await post('/api/ladder', {command: 'resume'});
    assert(resumed.ladder?.status === 'running', 'ladder did not resume');

    const final = await pollLadder();
    assert(final.status === 'finished', `ladder did not finish cleanly: ${final.status}`);
    assert(final.currentBattle === 1, 'ladder did not record one battle');
    assert(final.summaryPath && final.summaryHref, 'ladder missing summary path');

    const summary = JSON.parse(await fs.readFile(final.summaryPath, 'utf8'));
    assert(summary.schemaVersion === 'showdown-ladder-summary.v1', 'wrong summary schema');
    assert(summary.watchLocal === true, 'summary did not record watchLocal');
    assert(summary.battles.length === 1, 'summary missing battle');
    assert(summary.battles[0].battleId === 'local', 'watched ladder should use local battle');
    assert(summary.battles[0].eventsPath, 'battle missing event artifact');

    clearTimeout(timeout);
    console.log(JSON.stringify({
      ok: true,
      status: final.status,
      currentBattle: final.currentBattle,
      winnerAgent: summary.battles[0].winnerAgent,
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

async function pollLadder() {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    const body = await get('/api/ladder');
    if (body.ladder && !['running', 'paused', 'stopping'].includes(body.ladder.status)) return body.ladder;
    await new Promise(resolve => setTimeout(resolve, 150));
  }
  throw new Error('ladder did not settle');
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function fail(message) {
  clearTimeout(timeout);
  if (server.exitCode === null) server.kill();
  console.error(`Browser ladder smoke failed: ${message}`);
  process.exit(1);
}
