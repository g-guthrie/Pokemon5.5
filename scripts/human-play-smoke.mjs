import fs from 'node:fs/promises';
import {spawn} from 'node:child_process';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {WebSocket} from 'ws';

// Human-vs-AI contract: a live run with agentP1 'human' never chooses for
// P1 — choices arrive from the player's own p1 websocket (here: this script,
// standing in for the browser deck). The run must finish, record the human's
// actions, hide the AI's mind while live, and count into the series.

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const port = Number(process.env.HUMAN_SMOKE_PORT || 3218);
const serverOrigin = `http://localhost:${port}`;
const sessionId = 'humansmoke';
const battleId = `s-${sessionId}`;

const server = spawn(process.execPath, ['src/server.mjs'], {
  cwd: rootDir,
  env: {...process.env, PORT: String(port)},
  stdio: ['ignore', 'pipe', 'pipe'],
});

let output = '';
const timeout = setTimeout(() => fail('human play smoke timed out'), 60000);

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
    await resetSeries();
    const start = await post('/api/run', {
      command: 'start',
      sessionId,
      agentP1: 'human',
      agentP2: 'standin',
      gameCount: 1,
      maxTurns: 40,
      moveDelayMs: 1,
      timeoutMs: 60000,
      allowFallback: true,
    });
    assert(start.ok, `start failed: ${start.error || 'no error'}`);
    assert(Array.isArray(start.run.humanRoles) && start.run.humanRoles[0] === 'p1', 'run should mark p1 as human');

    const rejected = await post('/api/run', {command: 'start', sessionId: 'humansmoke2', agentP1: 'standin', agentP2: 'human'});
    assert(!rejected.ok && /Player 1/.test(rejected.error || ''), 'human as P2 should be rejected');

    playAsHuman();
    let sawHiddenMind = false;
    let sawRevealedMind = false;
    let run;
    for (let attempt = 0; attempt < 300; attempt += 1) {
      run = (await get(`/api/run?session=${sessionId}`)).run;
      if (['finished', 'error', 'stopped'].includes(run?.status)) break;
      if (run?.status === 'running' && !sawHiddenMind) {
        // While live (and unrevealed), the AI's mind and board are withheld.
        assert((run.lastModelCalls || []).every(call => call.role !== 'p2'), 'AI mind leaked during human play');
        assert(!run.lastBoards?.p2, 'AI private board leaked during human play');
        sawHiddenMind = true;
        // The player may peek: flip the reveal flag mid-game.
        const revealed = await post('/api/run', {command: 'reveal-mind', reveal: true, sessionId});
        assert(revealed.ok && revealed.run.revealOpponentMind === true, 'reveal-mind command failed');
      } else if (run?.status === 'running' && sawHiddenMind && !sawRevealedMind) {
        if ((run.lastModelCalls || []).some(call => call.role === 'p2')) sawRevealedMind = true;
      }
      await sleep(200);
    }
    assert(run?.status === 'finished', `run did not finish cleanly: ${run?.status} ${run?.error || ''}`);
    assert(sawHiddenMind, 'never observed the run in its live (hidden-mind) state');
    assert(sawRevealedMind, 'reveal-mind never exposed the AI mind mid-game');
    assert(run.result?.done, 'run missing result');
    // Post-game the AI mind is revealed again.
    assert((run.lastModelCalls || []).some(call => call.role === 'p2'), 'finished run should reveal AI calls');

    const artifact = JSON.parse(await fs.readFile(run.outputPath, 'utf8'));
    assert(artifact.humanRoles?.[0] === 'p1', 'artifact missing humanRoles');
    const humanCalls = artifact.modelCalls.filter(call => call.provider === 'human');
    const humanActions = artifact.actions.filter(action => action.role === 'p1');
    assert(humanCalls.length > 0, 'artifact missing human pseudo-calls');
    assert(humanActions.length > 0, 'artifact missing human actions');
    assert(humanActions.every(action => Number.isInteger(action.callIndex)), 'human actions missing call linkage');

    const transcript = await fs.readFile(run.transcriptPath, 'utf8');
    assert(transcript.includes('Human'), 'transcript missing human label');
    assert(transcript.includes('casual human-vs-AI game'), 'transcript missing human validity note');

    const series = (await get(`/api/series?session=${sessionId}&agentP1=human&agentP2=standin`)).series;
    assert(series?.totals?.games === 1, 'human game did not count into the series');

    clearTimeout(timeout);
    console.log(JSON.stringify({
      ok: true,
      result: run.result,
      humanDecisions: humanActions.length,
      seriesTotals: series.totals,
      transcriptPath: run.transcriptPath,
    }, null, 2));
    server.kill();
    process.exit(0);
  } catch (error) {
    fail(error.stack || String(error));
  }
}

// The stand-in human: answer every fresh actionable request with its first
// legal choice, exactly as the browser deck would submit it.
function playAsHuman() {
  const socket = new WebSocket(`${serverOrigin.replace('http', 'ws')}/ws?role=p1&battleId=${battleId}`);
  const answered = new Set();
  socket.on('message', data => {
    let message;
    try {
      message = JSON.parse(String(data));
    } catch {
      return;
    }
    if (message.type !== 'state') return;
    const observation = message.state?.extracted;
    const legalActions = observation?.legalActions || [];
    if (!observation || observation.waiting || observation.ended || !legalActions.length) return;
    const rqid = observation.requestId ?? message.state?.request?.rqid ?? null;
    const key = String(rqid ?? `${message.state.turn}:${legalActions.map(action => action.choice).join('/')}`);
    if (answered.has(key)) return;
    answered.add(key);
    // Slow enough that the poll loop can observe hidden and revealed states.
    setTimeout(() => {
      if (socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({type: 'choose', choice: legalActions[0].choice, rqid}));
      }
    }, 150);
  });
  socket.on('error', () => {});
}

async function resetSeries() {
  await post('/api/series', {command: 'reset', sessionId, agentP1: 'human', agentP2: 'standin'});
}

async function post(urlPath, body) {
  const response = await fetch(`${serverOrigin}${urlPath}`, {
    method: 'POST',
    headers: {'content-type': 'application/json'},
    body: JSON.stringify(body),
  });
  return response.json();
}

async function get(urlPath) {
  const response = await fetch(`${serverOrigin}${urlPath}`);
  return response.json();
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function fail(message) {
  clearTimeout(timeout);
  console.error(`Human play smoke failed: ${message}`);
  server.kill();
  process.exit(1);
}
