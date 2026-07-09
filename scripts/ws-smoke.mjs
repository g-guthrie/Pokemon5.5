import {spawn} from 'node:child_process';
import {WebSocket} from 'ws';

const port = 3199;
const server = spawn(process.execPath, ['src/server.mjs'], {
  cwd: new URL('..', import.meta.url),
  env: {...process.env, PORT: String(port)},
  stdio: ['ignore', 'pipe', 'pipe'],
});

let output = '';
let clientsStarted = false;
const timeout = setTimeout(() => fail('WebSocket smoke timed out'), 15000);

server.stdout.on('data', data => {
  output += String(data);
  if (!clientsStarted && output.includes(`http://localhost:${port}`)) {
    clientsStarted = true;
    void runClients();
  }
});
server.stderr.on('data', data => {
  output += String(data);
});
server.on('exit', code => {
  if (code && code !== 0) fail(`Server exited early with code ${code}\n${output}`);
});

async function runClients() {
  try {
    const p1 = await connect('p1');
    const p2 = await connect('p2');
    autoChooseUntilTurn(p1, 2);
    autoChooseUntilTurn(p2, 2);
    await waitForTurn(p1, p2, 2);
    clearTimeout(timeout);
    console.log(JSON.stringify({
      ok: true,
      p1Turn: p1.state.turn,
      p2Turn: p2.state.turn,
      p1Actions: p1.state.legalActions.length,
      p2Actions: p2.state.legalActions.length,
    }, null, 2));
    p1.ws.close();
    p2.ws.close();
    server.kill();
  } catch (error) {
    fail(error.stack || String(error));
  }
}

function connect(role) {
  return new Promise((resolve, reject) => {
    const client = {role, state: null, choices: new Set(), ws: new WebSocket(`ws://localhost:${port}/ws?role=${role}`)};
    client.ws.on('message', data => {
      const message = JSON.parse(String(data));
      if (message.type === 'state') client.state = message.state;
    });
    client.ws.on('open', () => resolve(client));
    client.ws.on('error', reject);
  });
}

function autoChooseUntilTurn(client, targetTurn) {
  const interval = setInterval(() => {
    if (client.ws.readyState !== WebSocket.OPEN || client.state?.turn >= targetTurn || client.state?.ended) {
      clearInterval(interval);
      return;
    }
    const actions = client.state?.legalActions || [];
    if (client.state?.waiting || !actions.length) return;
    const key = `${client.state.turn}:${client.state.request?.rqid ?? client.state.extracted?.requestId ?? 'request'}:${actions.map(action => action.choice).join('/')}`;
    if (client.choices.has(key)) return;
    client.choices.add(key);
    client.ws.send(JSON.stringify({type: 'choose', choice: pickChoice(actions)}));
  }, 30);
}

function waitForTurn(p1, p2, turn) {
  return waitUntil(
    () => p1.state?.turn >= turn && p2.state?.turn >= turn,
    () => `waiting for turn ${turn}; p1=${p1.state?.turn || 0} p2=${p2.state?.turn || 0}`
  );
}

function waitUntil(predicate, describe) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const interval = setInterval(() => {
      if (predicate()) {
        clearInterval(interval);
        resolve();
      } else if (Date.now() - started > 10000) {
        clearInterval(interval);
        reject(new Error(describe ? describe() : 'condition was not met'));
      }
    }, 50);
  });
}

function pickChoice(actions) {
  const action = actions.find(candidate => candidate.type === 'double-choice' && !candidate.choice.includes('terastallize')) ||
    actions.find(candidate => candidate.type === 'move' && !candidate.choice.includes('terastallize')) ||
    actions[0];
  if (!action) throw new Error('No legal action to choose');
  return action.choice;
}

function fail(message) {
  clearTimeout(timeout);
  if (server.exitCode === null) server.kill();
  console.error(`Smoke failed: ${message}`);
  process.exit(1);
}
