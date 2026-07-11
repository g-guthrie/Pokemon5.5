import {spawn} from 'node:child_process';
import {WebSocket} from 'ws';

const port = Number(process.env.LAZY_BATTLE_SMOKE_PORT || 3223);
const origin = `http://localhost:${port}`;
const battleId = 'lazy-smoke-session';
const server = spawn(process.execPath, ['src/server.mjs'], {
  cwd: new URL('..', import.meta.url),
  env: {...process.env, PORT: String(port)},
  stdio: ['ignore', 'pipe', 'pipe'],
});

let output = '';
const timeout = setTimeout(() => fail('lazy battle smoke timed out'), 15000);

server.stdout.on('data', data => {
  output += String(data);
  if (output.includes(origin)) void run();
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
    const before = await get('/healthz');
    const client = await connectLazy();
    await waitUntil(() => client.waiting, 'lazy socket did not enter waiting state');
    const waiting = await get('/healthz');
    assert(waiting.battles === before.battles, 'lazy socket created a battle before Start');

    const reset = await post('/api/reset', {battleId});
    assert(reset.ok, 'explicit reset did not create battle');
    await waitUntil(() => client.reset && client.state, 'lazy socket did not receive created battle');
    const after = await get('/healthz');
    assert(after.battles === before.battles + 1, 'explicit reset did not add exactly one battle');

    clearTimeout(timeout);
    console.log(JSON.stringify({
      ok: true,
      battlesBefore: before.battles,
      battlesWhileWaiting: waiting.battles,
      battlesAfterStart: after.battles,
      battleId,
    }, null, 2));
    client.ws.close();
    server.kill();
  } catch (error) {
    fail(error.stack || String(error));
  }
}

function connectLazy() {
  return new Promise((resolve, reject) => {
    const client = {waiting: false, reset: false, state: null, ws: null};
    client.ws = new WebSocket(`ws://localhost:${port}/ws?role=p1&battleId=${battleId}&wait=1`);
    client.ws.on('message', data => {
      const message = JSON.parse(String(data));
      if (message.type === 'waiting') client.waiting = true;
      if (message.type === 'reset') client.reset = true;
      if (message.type === 'state') client.state = message.state;
    });
    client.ws.on('open', () => resolve(client));
    client.ws.on('error', reject);
  });
}

async function get(path) {
  const response = await fetch(`${origin}${path}`);
  return response.json();
}

async function post(path, body) {
  const response = await fetch(`${origin}${path}`, {
    method: 'POST',
    headers: {'content-type': 'application/json'},
    body: JSON.stringify(body),
  });
  return response.json();
}

function waitUntil(predicate, message) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const interval = setInterval(() => {
      if (predicate()) {
        clearInterval(interval);
        resolve();
      } else if (Date.now() - started > 8000) {
        clearInterval(interval);
        reject(new Error(message));
      }
    }, 40);
  });
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function fail(message) {
  clearTimeout(timeout);
  if (server.exitCode === null) server.kill();
  console.error(`Lazy battle smoke failed: ${message}`);
  process.exit(1);
}
