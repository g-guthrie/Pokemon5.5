import {spawn} from 'node:child_process';
import {WebSocket} from 'ws';

const port = Number(process.env.ISOLATION_SMOKE_PORT || 3202);
const serverOrigin = `http://localhost:${port}`;
const alpha = 'isolation-alpha';
const beta = 'isolation-beta';
const server = spawn(process.execPath, ['src/server.mjs'], {
  cwd: new URL('..', import.meta.url),
  env: {...process.env, PORT: String(port)},
  stdio: ['ignore', 'pipe', 'pipe'],
});

let output = '';
let started = false;
const timeout = setTimeout(() => fail('isolation smoke timed out'), 18000);

server.stdout.on('data', data => {
  output += String(data);
  if (!started && output.includes(serverOrigin)) {
    started = true;
    void run();
  }
});
server.stderr.on('data', data => {
  output += String(data);
});
server.on('exit', code => {
  if (code && code !== 0) fail(`server exited early with ${code}\n${output}`);
});

async function run() {
  try {
    await reset(alpha, [1, 2, 3, 4]);
    await reset(beta, [5, 6, 7, 8]);
    const initialAlpha = await waitForBattleActions(alpha);
    const initialBeta = await waitForBattleActions(beta);
    assert(initialAlpha.p1.seed.join(',') === '1,2,3,4', 'alpha seed mismatch');
    assert(initialBeta.p1.seed.join(',') === '5,6,7,8', 'beta seed mismatch');
    assert(initialAlpha.p1.turn === 1 && initialBeta.p1.turn === 1, 'expected both battles at turn 1');

    const p1 = await connect(alpha, 'p1');
    const p2 = await connect(alpha, 'p2');
    await waitUntil(() => p1.state?.legalActions?.length && p2.state?.legalActions?.length, 'alpha websocket actions');
    p1.ws.send(JSON.stringify({type: 'choose', choice: pickChoice(p1.state.legalActions)}));
    p2.ws.send(JSON.stringify({type: 'choose', choice: pickChoice(p2.state.legalActions)}));
    await waitUntil(() => p1.state?.turn >= 2 && p2.state?.turn >= 2, 'alpha turn 2');

    const afterAlpha = await fetchState(alpha);
    const afterBeta = await fetchState(beta);
    assert(afterAlpha.p1.turn >= 2, 'alpha did not advance');
    assert(afterBeta.p1.turn === 1, 'beta changed when alpha advanced');
    assert(afterBeta.p1.seed.join(',') === '5,6,7,8', 'beta seed changed');

    const listed = await fetchJson(`${serverOrigin}/api/battles`);
    const ids = listed.battles.map(battle => battle.battleId);
    assert(ids.includes(alpha) && ids.includes(beta) && ids.includes('local'), 'battle list missing scoped sessions');

    clearTimeout(timeout);
    p1.ws.close();
    p2.ws.close();
    server.kill();
    console.log(JSON.stringify({
      ok: true,
      alpha: {seed: afterAlpha.p1.seed, turn: afterAlpha.p1.turn},
      beta: {seed: afterBeta.p1.seed, turn: afterBeta.p1.turn},
      battles: ids.sort(),
    }, null, 2));
    process.exit(0);
  } catch (error) {
    fail(error.stack || String(error));
  }
}

async function reset(battleId, seed) {
  const response = await fetch(`${serverOrigin}/api/reset`, {
    method: 'POST',
    headers: {'content-type': 'application/json'},
    body: JSON.stringify({battleId, formatid: 'gen9randomdoublesbattle', seed}),
  });
  if (!response.ok) throw new Error(`reset ${battleId} failed: ${response.status}`);
  return response.json();
}

async function waitForBattleActions(battleId) {
  await waitUntil(async () => {
    const state = await fetchState(battleId);
    return state.p1?.legalActions?.length && state.p2?.legalActions?.length;
  }, `${battleId} actions`);
  return fetchState(battleId);
}

async function fetchState(battleId) {
  return fetchJson(`${serverOrigin}/api/state?battleId=${encodeURIComponent(battleId)}`);
}

async function fetchJson(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url} HTTP ${response.status}`);
  return response.json();
}

function connect(battleId, role) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://localhost:${port}/ws?battleId=${encodeURIComponent(battleId)}&role=${role}`);
    const client = {role, ws, state: null};
    ws.on('message', data => {
      const message = JSON.parse(String(data));
      if (message.type === 'state') client.state = message.state;
    });
    ws.on('open', () => resolve(client));
    ws.on('error', reject);
  });
}

function waitUntil(predicate, label) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const interval = setInterval(async () => {
      try {
        if (await predicate()) {
          clearInterval(interval);
          resolve();
        } else if (Date.now() - started > 12000) {
          clearInterval(interval);
          reject(new Error(`waiting for ${label}`));
        }
      } catch (error) {
        clearInterval(interval);
        reject(error);
      }
    }, 50);
  });
}

function pickChoice(actions) {
  const action = actions.find(candidate => candidate.type === 'double-choice' && !candidate.hasTerastallize && !candidate.hasSwitch) ||
    actions.find(candidate => candidate.type === 'double-choice' && !candidate.choice.includes('terastallize')) ||
    actions[0];
  if (!action) throw new Error('no legal action');
  return action.choice;
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function fail(message) {
  clearTimeout(timeout);
  if (server.exitCode === null) server.kill();
  console.error(`Isolation smoke failed: ${message}`);
  process.exit(1);
}
