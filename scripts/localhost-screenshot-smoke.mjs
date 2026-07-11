import {spawn} from 'node:child_process';
import fs from 'node:fs/promises';
import {existsSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const serverOrigin = process.env.LOCALHOST_SMOKE_ORIGIN || 'http://localhost:3107';
const outputPath = path.join(rootDir, 'artifacts', 'localhost-3107-smoke.png');
const chromePath = process.env.CHROME_BIN || firstExisting([
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
]);

if (!chromePath) {
  console.error('Localhost screenshot smoke failed: Chrome/Chromium executable was not found; set CHROME_BIN to enable it');
  process.exit(1);
}

await assertReachable(serverOrigin);
await fs.mkdir(path.dirname(outputPath), {recursive: true});
await fs.rm(outputPath, {force: true});

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

const image = await inspectPng(outputPath);
assert(image.bytes > 50000, `screenshot too small: ${image.bytes} bytes`);
assert(image.width === 1440 && image.height === 1600, `unexpected screenshot size ${image.width}x${image.height}`);
for (const needle of [
  'LLM Arena',
  'Start match',
]) {
  assert(arenaDom.includes(needle), `arena DOM missing ${needle}`);
}

console.log(JSON.stringify({
  ok: true,
  serverOrigin,
  outputPath,
  bytes: image.bytes,
  width: image.width,
  height: image.height,
}, null, 2));

async function assertReachable(origin) {
  let response;
  try {
    response = await fetch(origin);
  } catch (error) {
    throw new Error(`Could not reach ${origin}: ${error.message}`);
  }
  assert(response.ok, `${origin} returned HTTP ${response.status}`);
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
