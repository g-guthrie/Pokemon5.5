import {spawn} from 'node:child_process';
import fs from 'node:fs/promises';
import {existsSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const port = Number(process.env.FRONTEND_SCREENSHOT_SMOKE_PORT || 3216);
const serverOrigin = `http://localhost:${port}`;
const outputPath = path.join(rootDir, 'artifacts', 'frontend-screenshot-smoke.png');
const narrowOutputPath = path.join(rootDir, 'artifacts', 'frontend-narrow-arena-smoke.png');
const chromePath = process.env.CHROME_BIN || firstExisting([
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
]);

if (!chromePath) {
  console.error('Frontend screenshot smoke failed: Chrome/Chromium executable was not found; set CHROME_BIN to enable frontend screenshot smoke');
  process.exit(1);
}

const server = spawn(process.execPath, ['src/server.mjs'], {
  cwd: rootDir,
  env: {...process.env, PORT: String(port)},
  stdio: ['ignore', 'pipe', 'pipe'],
});

let output = '';
const timeout = setTimeout(() => fail('frontend screenshot smoke timed out'), 45000);

server.stdout.on('data', data => {
  output += String(data);
  if (output.includes(serverOrigin)) void run();
});
server.stderr.on('data', data => {
  output += String(data);
});
server.on('exit', code => {
  if (code && code !== 0) fail(`server exited early with ${code}\n${tail(output)}`);
});

async function run() {
  server.stdout.removeAllListeners('data');
  try {
    await fs.mkdir(path.dirname(outputPath), {recursive: true});
    await fs.rm(outputPath, {force: true});
    await fs.rm(narrowOutputPath, {force: true});
    await runChrome([
      '--headless=new',
      '--disable-gpu',
      '--hide-scrollbars',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-background-networking',
      '--disable-component-update',
      '--disable-sync',
      '--window-size=1440,1600',
      '--virtual-time-budget=3500',
      `--screenshot=${outputPath}`,
      serverOrigin,
    ]);

    await runChrome([
      '--headless=new',
      '--disable-gpu',
      '--hide-scrollbars',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-background-networking',
      '--disable-component-update',
      '--disable-sync',
      '--window-size=705,832',
      '--virtual-time-budget=3500',
      `--screenshot=${narrowOutputPath}`,
      serverOrigin,
    ]);

    const arenaDom = await runChrome([
      '--headless=new',
      '--disable-gpu',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-background-networking',
      '--disable-component-update',
      '--disable-sync',
      '--virtual-time-budget=3500',
      '--dump-dom',
      serverOrigin,
    ]);

    // The Model Minds are hosted by the native client iframe, so verify that
    // document directly instead of pretending iframe DOM is part of the
    // parent page's --dump-dom output.
    const mindDom = await runChrome([
      '--headless=new',
      '--disable-gpu',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-background-networking',
      '--disable-component-update',
      '--disable-sync',
      '--virtual-time-budget=3500',
      '--dump-dom',
      `${serverOrigin}/showdown-frame.html?role=p1&theme=dark&drive=parent&hidecontrols=1&minds=1&wait=1`,
    ]);

    const image = await inspectPng(outputPath);
    const narrowImage = await inspectPng(narrowOutputPath);
    assert(image.bytes > 50000, `screenshot too small: ${image.bytes} bytes`);
    assert(image.width === 1440 && image.height === 1600, `unexpected screenshot size ${image.width}x${image.height}`);
    assert(narrowImage.bytes > 25000, `narrow screenshot too small: ${narrowImage.bytes} bytes`);
    assert(narrowImage.width === 705 && narrowImage.height === 832, `unexpected narrow screenshot size ${narrowImage.width}x${narrowImage.height}`);
    for (const needle of [
      'LLM Arena',
      'Player 1 agent',
      'Player 2 agent',
      'Start match',
      'games',
    ]) {
      assert(arenaDom.includes(needle), `arena DOM missing ${needle}`);
    }
    assert(mindDom.includes('Model mind'), 'native client frame DOM missing Model mind');
    assert(mindDom.includes('Waiting for the first decision'), 'native client frame DOM missing Model mind placeholder');

    clearTimeout(timeout);
    console.log(JSON.stringify({
      ok: true,
      outputPath,
      narrowOutputPath,
      bytes: image.bytes,
      narrowBytes: narrowImage.bytes,
      width: image.width,
      height: image.height,
      narrowWidth: narrowImage.width,
      narrowHeight: narrowImage.height,
      serverOrigin,
    }, null, 2));
    cleanupAndExit(0);
  } catch (error) {
    fail(error.stack || String(error));
  }
}

function runChrome(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(chromePath, args, {
      cwd: rootDir,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`Chrome timed out\n${tail(stderr)}`));
    }, 45000);
    child.stdout.on('data', data => {
      stdout += String(data);
    });
    child.stderr.on('data', data => {
      stderr += String(data);
    });
    child.on('error', error => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('exit', code => {
      clearTimeout(timer);
      if (code) {
        reject(new Error(`Chrome exited ${code}\n${tail(stderr)}`));
        return;
      }
      resolve(stdout);
    });
  });
}

async function inspectPng(filePath) {
  const bytes = await fs.readFile(filePath);
  const signature = bytes.subarray(0, 8).toString('hex');
  assert(signature === '89504e470d0a1a0a', 'screenshot is not a PNG');
  return {
    bytes: bytes.length,
    width: bytes.readUInt32BE(16),
    height: bytes.readUInt32BE(20),
  };
}

function firstExisting(paths) {
  return paths.find(candidate => existsSync(candidate)) || '';
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function tail(text = '', max = 2000) {
  return String(text).slice(-max);
}

function fail(message) {
  clearTimeout(timeout);
  console.error(`Frontend screenshot smoke failed: ${message}`);
  cleanupAndExit(1);
}

async function cleanupAndExit(code) {
  if (server.exitCode === null) server.kill();
  process.exit(code);
}
