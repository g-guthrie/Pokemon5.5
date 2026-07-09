import {spawn} from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {runWebSocketMatch} from '../src/match-runner.mjs';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const port = Number(process.env.RUNNER_REDACTION_SMOKE_PORT || 3213);
const serverOrigin = `http://localhost:${port}`;
const outputPath = path.join(rootDir, 'artifacts', 'runner-redaction-smoke.json');
const keyLike = ['sk', 'or', 'v1', 'runnerredactiontestsecret'].join('-');
const openAIEnvName = ['OPENAI', 'API', 'KEY'].join('_');
const previousOpenAIKey = process.env[openAIEnvName];
delete process.env[openAIEnvName];

const server = spawn(process.execPath, ['src/server.mjs'], {
  cwd: rootDir,
  env: {...process.env, PORT: String(port), [openAIEnvName]: ''},
  stdio: ['ignore', 'pipe', 'pipe'],
});

let output = '';
const timeout = setTimeout(() => fail('runner redaction smoke timed out'), 20000);

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
    await runWebSocketMatch({
      serverOrigin,
      outputPath,
      seed: [550000, 1, 550017, 550101],
      maxTurns: 1,
      moveDelayMs: 1,
      timeoutMs: 10000,
      allowFallback: false,
      agents: {
        p1: {
          provider: 'openai',
          model: `bad-model-${keyLike}`,
          name: `bad-name-${keyLike}`,
          ratingKey: `bad-rating-${keyLike}`,
        },
        p2: {provider: 'standin', name: 'runner-redaction-p2'},
      },
    });
    const artifact = JSON.parse(await fs.readFile(outputPath, 'utf8'));
    const serialized = JSON.stringify(artifact);
    assert(artifact.validBenchmark === false, 'missing-key provider run should be invalid');
    assert(artifact.apiErrorCount >= 1, 'missing-key provider run should count API error');
    assert(!serialized.includes(keyLike), 'runner artifact leaked key-like agent metadata');
    assert(serialized.includes('[redacted-secret]'), 'runner artifact should retain redaction marker for auditability');

    clearTimeout(timeout);
    console.log(JSON.stringify({
      ok: true,
      result: artifact.result,
      apiErrorCount: artifact.apiErrorCount,
      outputPath,
    }, null, 2));
    cleanupAndExit(0);
  } catch (error) {
    fail(error.stack || String(error));
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function fail(message) {
  clearTimeout(timeout);
  console.error(`Runner redaction smoke failed: ${message}`);
  cleanupAndExit(1);
}

function cleanupAndExit(code) {
  restoreEnv(openAIEnvName, previousOpenAIKey);
  if (server.exitCode === null) server.kill();
  process.exit(code);
}

function restoreEnv(name, value) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}
