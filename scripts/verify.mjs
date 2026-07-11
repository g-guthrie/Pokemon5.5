import {spawn} from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {runLadderBatch} from '../src/ladder-runner.mjs';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const artifactsDir = path.join(rootDir, 'artifacts');
const reportDir = path.join(artifactsDir, 'verification');
const startedAt = new Date().toISOString();
const report = {
  schemaVersion: 'showdown-production-verify.v1',
  startedAt,
  finishedAt: '',
  ok: false,
  noPaidProviderCalls: true,
  optionalPaidPreflight: {
    requested: process.env.RUN_PAID_PREFLIGHT === '1',
    openaiKeyPresent: usableSecret(process.env.OPENAI_API_KEY),
    openrouterKeyPresent: usableSecret(process.env.OPENROUTER_API_KEY),
    ran: [],
    skipped: [],
  },
  checks: [],
};

const smokeCommands = [
  ['smoke', ['npm', 'run', 'smoke']],
  ['extractor', ['npm', 'run', 'smoke:extractor']],
  ['control', ['npm', 'run', 'smoke:control']],
  ['websocket', ['npm', 'run', 'smoke:ws']],
  ['choices', ['npm', 'run', 'smoke:choices']],
  ['legal-canonical', ['npm', 'run', 'smoke:legal-canonical']],
  ['hidden-info', ['npm', 'run', 'smoke:hidden']],
  ['runner', ['npm', 'run', 'smoke:runner']],
  ['isolation', ['npm', 'run', 'smoke:isolation']],
  ['usage', ['npm', 'run', 'smoke:usage']],
  ['stale-state', ['npm', 'run', 'smoke:stale-state']],
  ['events', ['npm', 'run', 'smoke:events']],
  ['reproducibility', ['npm', 'run', 'smoke:repro']],
  ['prompt', ['npm', 'run', 'smoke:prompt']],
  ['live-run-api', ['npm', 'run', 'smoke:live']],
  ['human-play', ['npm', 'run', 'smoke:human']],
  ['frontend-ui', ['npm', 'run', 'smoke:frontend']],
  ['provider-config', ['npm', 'run', 'smoke:provider-config']],
  ['provider-artifact', ['npm', 'run', 'smoke:provider-artifact']],
  ['provider-abort', ['npm', 'run', 'smoke:abort']],
  ['runner-redaction', ['npm', 'run', 'smoke:redaction']],
  ['ladder-ui', ['npm', 'run', 'smoke:ladder-ui']],
  ['tournament', ['npm', 'run', 'smoke:tournament']],
  ['tournament-api', ['npm', 'run', 'smoke:tournament-api']],
  ['benchmark-suite', ['npm', 'run', 'smoke:benchmark-suite']],
  ['benchmark-api', ['npm', 'run', 'smoke:benchmark-api']],
];

try {
  await fs.mkdir(reportDir, {recursive: true});
  await runCommandChecks(smokeCommands);
  await runStandaloneLadderCheck();
  await runSecretScanCheck();
  await runOptionalPaidPreflight();
} finally {
  report.finishedAt = new Date().toISOString();
  report.ok = report.checks.every(check => check.ok);
  report.summaryPath = path.join(reportDir, 'verify-latest.json');
  await fs.writeFile(report.summaryPath, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify({
    ok: report.ok,
    checks: report.checks.length,
    failed: report.checks.filter(check => !check.ok).map(check => check.name),
    summaryPath: report.summaryPath,
    paidPreflight: report.optionalPaidPreflight,
  }, null, 2));
  if (!report.ok) process.exit(1);
}

async function runCommandChecks(commands) {
  for (const [name, command] of commands) {
    await recordCheck(name, async () => {
      const result = await runCommand(command, {timeoutMs: timeoutFor(name)});
      return {
        command: command.join(' '),
        exitCode: result.exitCode,
        stdoutTail: tail(result.stdout),
        stderrTail: tail(result.stderr),
      };
    });
  }
}

async function runStandaloneLadderCheck() {
  await recordCheck('standin-ladder-batch', async () => {
    const port = Number(process.env.VERIFY_LADDER_PORT || 3210);
    const serverOrigin = `http://localhost:${port}`;
    const server = spawn(process.execPath, ['src/server.mjs'], {
      cwd: rootDir,
      env: {...process.env, PORT: String(port)},
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    try {
      await waitForServer(server, serverOrigin);
      const outDir = path.join(reportDir, 'ladder-batch');
      await fs.rm(outDir, {recursive: true, force: true});
      const summary = await runLadderBatch({
        serverOrigin,
        agentA: 'standin',
        agentB: 'standin:verify',
        battleCount: 1,
        maxTurns: 40,
        moveDelayMs: 5,
        timeoutMs: 20000,
        outDir,
        seedBase: 990000,
        watchLocal: false,
      });
      assert(summary.schemaVersion === 'showdown-ladder-summary.v1', 'wrong ladder summary schema');
      assert(summary.battles.length === 1, 'ladder did not record one battle');
      assert(summary.battles[0].eventsPath, 'ladder battle missing event log');
      return {
        summaryPath: summary.summaryPath,
        completedBattles: summary.battles.length,
      };
    } finally {
      if (server.exitCode === null) server.kill();
    }
  });
}

async function runSecretScanCheck() {
  await recordCheck('secret-scan', async () => {
    const findings = [];
    for await (const filePath of walk(rootDir)) {
      const relative = path.relative(rootDir, filePath);
      if (shouldSkipSecretPath(relative)) continue;
      for (const pattern of sensitivePatterns()) {
        if (pattern.test(relative)) {
          findings.push({file: relative, line: 0, kind: 'sensitive-path'});
          pattern.lastIndex = 0;
        }
      }
      if (!isTextLikePath(relative)) continue;
      let text = '';
      try {
        text = await fs.readFile(filePath, 'utf8');
      } catch {
        continue;
      }
      const lines = text.split(/\r?\n/);
      lines.forEach((line, index) => {
        for (const pattern of [...secretPatterns(), ...sensitivePatterns()]) {
          if (pattern.test(line)) {
            findings.push({file: relative, line: index + 1});
            pattern.lastIndex = 0;
          }
        }
      });
    }
    assert(findings.length === 0, `secret scan found ${findings.length} secret or private-data findings`);
    return {findings};
  });
}

async function runOptionalPaidPreflight() {
  const paid = report.optionalPaidPreflight;
  if (!paid.requested) {
    paid.skipped.push('RUN_PAID_PREFLIGHT is not 1');
    return;
  }
  if (paid.openaiKeyPresent) {
    await recordCheck('paid-openai-preflight', async () => {
      const result = await runCommand(['npm', 'run', 'openai:preflight'], {timeoutMs: 60000});
      paid.ran.push('openai');
      return {command: 'npm run openai:preflight', stdoutTail: tail(result.stdout), stderrTail: tail(result.stderr)};
    });
  } else {
    paid.skipped.push('OPENAI_API_KEY is not set');
  }
  if (paid.openrouterKeyPresent) {
    await recordCheck('paid-openrouter-preflight', async () => {
      const result = await runCommand(['npm', 'run', 'provider:preflight'], {
        timeoutMs: 60000,
        env: {AGENT: process.env.OPENROUTER_PREFLIGHT_AGENT || 'openrouter:openai/gpt-4o-mini:low'},
      });
      paid.ran.push('openrouter');
      return {command: 'npm run provider:preflight', stdoutTail: tail(result.stdout), stderrTail: tail(result.stderr)};
    });
  } else {
    paid.skipped.push('OPENROUTER_API_KEY is not set');
  }
}

async function recordCheck(name, fn) {
  const started = Date.now();
  const check = {
    name,
    ok: false,
    startedAt: new Date(started).toISOString(),
    finishedAt: '',
    durationMs: 0,
    details: null,
    error: '',
  };
  try {
    console.log(`verify ${name}...`);
    check.details = await fn();
    check.ok = true;
  } catch (error) {
    check.error = sanitize(String(error?.stack || error?.message || error));
  } finally {
    check.finishedAt = new Date().toISOString();
    check.durationMs = Date.now() - started;
    report.checks.push(check);
  }
  return check;
}

function runCommand(command, options = {}) {
  const [bin, ...args] = command;
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, {
      cwd: rootDir,
      env: {...process.env, ...(options.env || {})},
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: false,
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`${command.join(' ')} timed out after ${options.timeoutMs}ms`));
    }, options.timeoutMs || 30000);
    child.stdout.on('data', data => {
      stdout += sanitize(String(data));
    });
    child.stderr.on('data', data => {
      stderr += sanitize(String(data));
    });
    child.on('error', error => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('exit', exitCode => {
      clearTimeout(timer);
      if (exitCode) {
        reject(new Error(`${command.join(' ')} exited ${exitCode}\n${tail(stdout)}\n${tail(stderr)}`));
        return;
      }
      resolve({exitCode, stdout, stderr});
    });
  });
}

function waitForServer(server, expectedText) {
  return new Promise((resolve, reject) => {
    let output = '';
    const timer = setTimeout(() => reject(new Error(`server did not start: ${tail(output)}`)), 10000);
    server.stdout.on('data', data => {
      output += String(data);
      if (output.includes(expectedText)) {
        clearTimeout(timer);
        resolve();
      }
    });
    server.stderr.on('data', data => {
      output += String(data);
    });
    server.on('exit', code => {
      clearTimeout(timer);
      reject(new Error(`server exited before ready with ${code}: ${tail(output)}`));
    });
  });
}

async function* walk(dir) {
  const entries = await fs.readdir(dir, {withFileTypes: true});
  for (const entry of entries) {
    const filePath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      yield* walk(filePath);
    } else if (entry.isFile()) {
      yield filePath;
    }
  }
}

function shouldSkipSecretPath(relative) {
  const parts = relative.split(path.sep);
  return (
    parts.includes('node_modules') ||
    parts.includes('vendor') ||
    parts.includes('asset-cache') ||
    parts.includes('.git')
  );
}

function isTextLikePath(relative) {
  return /\.(mjs|js|json|jsonl|html|css|md|txt|toml|env|py)$/i.test(relative) || !path.extname(relative);
}

function secretPatterns() {
  return [
    /sk-or-v1-[A-Za-z0-9_-]{10,}/g,
    /sk-[A-Za-z0-9_-]{16,}/g,
  ];
}

function sensitivePatterns() {
  const terms = [
    ['ultra', 'sound'],
    ['patient', 'name'],
    ['date', 'of', 'birth'],
    ['diagnostic', 'imaging'],
    ['icd', '10'],
    ['medical', 'order'],
  ];
  return [
    /\b\d{3}[-.]\d{3}[-.]\d{4}\b/g,
    /\bN\s*P\s*I\b/g,
    ...terms.map(parts => new RegExp(parts.join('[\\s_-]*'), 'gi')),
  ];
}

function timeoutFor(name) {
  if (['runner', 'reproducibility', 'live-run-api', 'human-play', 'frontend-ui', 'ladder-ui', 'tournament', 'tournament-api', 'benchmark-api'].includes(name)) return 90000;
  return 30000;
}

function tail(text = '', max = 2000) {
  return sanitize(String(text)).slice(-max);
}

function sanitize(text = '') {
  return String(text)
    .replace(/sk-or-v1-[A-Za-z0-9_-]+/g, '[redacted-secret]')
    .replace(/sk-[A-Za-z0-9_-]{16,}/g, '[redacted-secret]');
}

function usableSecret(value = '') {
  const text = String(value || '').trim();
  return text.length > 12 && text !== '...' && !text.includes('sk-...');
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
