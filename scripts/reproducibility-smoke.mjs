import {spawn} from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {runWebSocketMatch} from '../src/match-runner.mjs';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const port = Number(process.env.REPRO_SMOKE_PORT || 3208);
const serverOrigin = `http://localhost:${port}`;
const outDir = path.join(rootDir, 'artifacts', 'reproducibility-smoke');
const seed = [661000, 2, 661034, 661202];
const server = spawn(process.execPath, ['src/server.mjs'], {
  cwd: rootDir,
  env: {...process.env, PORT: String(port)},
  stdio: ['ignore', 'pipe', 'pipe'],
});

let output = '';
const timeout = setTimeout(() => fail('reproducibility smoke timed out'), 30000);

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
    const first = await runOne('first');
    const second = await runOne('second');

    assert(first.seed.join(',') === seed.join(','), 'first match did not preserve seed');
    assert(second.seed.join(',') === seed.join(','), 'second match did not preserve seed');
    for (const role of ['p1', 'p2']) {
      assert(first.teamSnapshots?.[role]?.team?.length === 6, `${role} first team snapshot missing`);
      assert(second.teamSnapshots?.[role]?.team?.length === 6, `${role} second team snapshot missing`);
      assert(first.teamSnapshots[role].teamHash === second.teamSnapshots[role].teamHash, `${role} team hash changed for same seed`);
      assert(JSON.stringify(first.teamSnapshots[role].team) === JSON.stringify(second.teamSnapshots[role].team), `${role} team snapshot changed for same seed`);
      for (const mon of first.teamSnapshots[role].team) {
        assert(mon.species && mon.item && mon.ability && mon.nature && mon.teraType, `${role} snapshot missing full set fields`);
        assert(Array.isArray(mon.moves) && mon.moves.length > 0, `${role} snapshot missing moves`);
      }
    }

    const eventLines = (await fs.readFile(first.eventsPath, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    assert(eventLines[0]?.teamSnapshots?.p1?.teamHash === first.teamSnapshots.p1.teamHash, 'event start missing p1 team hash');
    assert(eventLines[0]?.teamSnapshots?.p2?.teamHash === first.teamSnapshots.p2.teamHash, 'event start missing p2 team hash');

    clearTimeout(timeout);
    console.log(JSON.stringify({
      ok: true,
      seed,
      p1TeamHash: first.teamSnapshots.p1.teamHash,
      p2TeamHash: first.teamSnapshots.p2.teamHash,
      outputPaths: [first.outputPath, second.outputPath],
    }, null, 2));
    server.kill();
    process.exit(0);
  } catch (error) {
    fail(error.stack || String(error));
  }
}

async function runOne(label) {
  const outputPath = path.join(outDir, `${label}.json`);
  const match = await runWebSocketMatch({
    serverOrigin,
    battleId: `repro-${label}`,
    outputPath,
    seed,
    maxTurns: 2,
    moveDelayMs: 1,
    timeoutMs: 10000,
    agents: {
      p1: {provider: 'standin', name: `repro-${label}-p1`},
      p2: {provider: 'standin', name: `repro-${label}-p2`},
    },
  });
  match.outputPath = outputPath;
  return match;
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function fail(message) {
  clearTimeout(timeout);
  if (server.exitCode === null) server.kill();
  console.error(`Reproducibility smoke failed: ${message}`);
  process.exit(1);
}
