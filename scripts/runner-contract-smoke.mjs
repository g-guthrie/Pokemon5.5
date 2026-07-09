import {spawn} from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {runWebSocketMatch} from '../src/match-runner.mjs';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const port = Number(process.env.RUNNER_SMOKE_PORT || 3201);
const serverOrigin = `http://localhost:${port}`;
const outputPath = path.join(rootDir, 'artifacts', 'runner-contract-smoke.json');
const server = spawn(process.execPath, ['src/server.mjs'], {
  cwd: rootDir,
  env: {...process.env, PORT: String(port)},
  stdio: ['ignore', 'pipe', 'pipe'],
});

let output = '';
const timeout = setTimeout(() => fail('runner contract timed out'), 20000);

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
    const match = await runWebSocketMatch({
      serverOrigin,
      outputPath,
      seed: [550000, 1, 550017, 550101],
      maxTurns: 40,
      moveDelayMs: 5,
      timeoutMs: 15000,
      agents: {
        p1: {provider: 'standin', name: 'runner-standin-p1'},
        p2: {provider: 'standin', name: 'runner-standin-p2'},
      },
    });
    assert(match.schemaVersion === 'showdown-match-artifact.v1', 'wrong match artifact schema');
    assert(match.formatid === 'gen9randomdoublesbattle', 'runner changed default format');
    assert(Array.isArray(match.seed) && match.seed.join(',') === '550000,1,550017,550101', 'runner did not preserve seed');
    assert(match.validBenchmark === true, 'stand-in runner should produce valid benchmark artifact');
    assert(match.result?.winner, 'stand-in runner should finish with a winner for deterministic seed');
    assert(match.actions.length > 0, 'runner recorded no actions');
    assert(match.modelCalls.length >= match.actions.length, 'runner missing model call records');
    assert(match.observations.length >= match.actions.length, 'runner missing observations');
    assert(match.protocol.length > 0, 'runner missing protocol replay data');
    assert(match.eventsPath && match.eventsHref, 'runner missing event log path metadata');
    assert(match.teamSnapshots?.p1?.team?.length === 6, 'runner missing p1 team snapshot');
    assert(match.teamSnapshots?.p2?.team?.length === 6, 'runner missing p2 team snapshot');
    assert(match.teamSnapshots.p1.teamHash && match.teamSnapshots.p2.teamHash, 'runner missing team hashes');
    for (const role of ['p1', 'p2']) {
      for (const mon of match.teamSnapshots[role].team) {
        assert(mon.species && mon.item && mon.ability && mon.nature && mon.teraType, `${role} team snapshot missing set detail`);
        assert(Array.isArray(mon.moves) && mon.moves.length > 0, `${role} team snapshot missing moves`);
      }
    }
    assert(match.apiErrorCount === 0 && match.fallbackCount === 0 && match.invalidChoiceCount === 0, 'runner counted invalid stand-in choices');

    for (const action of match.actions) {
      const observation = match.observations[action.observationIndex];
      assert(observation, `missing observation for ${action.role} turn ${action.turn}`);
      assert(observation.role === action.role, `observation role mismatch for ${action.choice}`);
      assert(observation.turn === action.turn, `observation turn mismatch for ${action.choice}`);
      assert(observation.legalActions.some(candidate => candidate.choice === action.choice), `action not present in legal set: ${action.choice}`);
      const call = match.modelCalls[action.callIndex];
      assert(call?.observationIndex === action.observationIndex, `model call did not point at action observation for ${action.choice}`);
    }

    const persisted = JSON.parse(await fs.readFile(outputPath, 'utf8'));
    assert(persisted.result?.winner === match.result.winner, 'persisted artifact winner mismatch');
    assert(persisted.eventsPath === match.eventsPath, 'persisted artifact event path mismatch');
    const eventLines = (await fs.readFile(match.eventsPath, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    assert(eventLines[0]?.type === 'match_start', 'event log missing match_start');
    assert(eventLines[0]?.teamSnapshots?.p1?.teamHash === match.teamSnapshots.p1.teamHash, 'event log missing p1 team hash');
    assert(eventLines[0]?.teamSnapshots?.p2?.teamHash === match.teamSnapshots.p2.teamHash, 'event log missing p2 team hash');
    assert(eventLines.at(-1)?.type === 'match_end', 'event log missing match_end');
    assert(eventLines.some(event => event.type === 'observation' && event.legalActionCount > 0), 'event log missing legal observation');
    assert(eventLines.some(event => event.type === 'action'), 'event log missing action events');
    assert(eventLines.some(event => event.type === 'model_call'), 'event log missing model call events');

    clearTimeout(timeout);
    console.log(JSON.stringify({
      ok: true,
      winner: match.result.winner,
      turn: match.result.turn,
      actions: match.actions.length,
      observations: match.observations.length,
      modelCalls: match.modelCalls.length,
      outputPath,
      eventsPath: match.eventsPath,
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
  console.error(`Runner contract failed: ${message}`);
  process.exit(1);
}
