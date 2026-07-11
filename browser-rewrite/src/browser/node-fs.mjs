// In-memory filesystem shim for the browser bundle (aliases node:fs/promises).
// Artifacts, transcripts, and the series store live in this map for the life
// of the page; the engine exposes reads over /artifacts/ and mirrors the
// series store out to localStorage via the persistence bridge.
import {dirname, normalize} from './node-path.mjs';

export const files = new Map();
const directories = new Set(['/']);

function ensureDir(dirPath) {
  let current = normalize(dirPath);
  while (current && current !== '/' && current !== '.') {
    directories.add(current);
    current = dirname(current);
  }
}

export async function mkdir(dirPath, _options = {}) {
  ensureDir(dirPath);
}

export async function writeFile(filePath, data) {
  const key = normalize(String(filePath));
  ensureDir(dirname(key));
  files.set(key, typeof data === 'string' ? data : String(data));
}

export async function readFile(filePath, _encoding) {
  const key = normalize(String(filePath));
  if (!files.has(key)) {
    const error = new Error(`ENOENT: no such file, open '${key}'`);
    error.code = 'ENOENT';
    throw error;
  }
  return files.get(key);
}

export async function rename(fromPath, toPath) {
  const from = normalize(String(fromPath));
  const to = normalize(String(toPath));
  if (!files.has(from)) {
    const error = new Error(`ENOENT: no such file, rename '${from}'`);
    error.code = 'ENOENT';
    throw error;
  }
  files.set(to, files.get(from));
  files.delete(from);
}

export async function rm(filePath, _options = {}) {
  files.delete(normalize(String(filePath)));
}

export async function readdir(dirPath) {
  const prefix = `${normalize(String(dirPath))}/`;
  const names = new Set();
  for (const key of files.keys()) {
    if (!key.startsWith(prefix)) continue;
    names.add(key.slice(prefix.length).split('/')[0]);
  }
  return [...names];
}

export async function stat(filePath) {
  const key = normalize(String(filePath));
  if (files.has(key)) {
    return {isFile: () => true, isDirectory: () => false, mtimeMs: Date.now(), size: files.get(key).length};
  }
  if (directories.has(key)) {
    return {isFile: () => false, isDirectory: () => true, mtimeMs: Date.now(), size: 0};
  }
  const error = new Error(`ENOENT: no such file or directory, stat '${key}'`);
  error.code = 'ENOENT';
  throw error;
}

export default {mkdir, writeFile, readFile, rename, rm, readdir, stat};
