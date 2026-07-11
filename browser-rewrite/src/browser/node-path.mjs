// Minimal POSIX path shim for the browser bundle. The engine only ever deals
// in virtual artifact paths ("/artifacts/live-runs/x.json"), so this covers
// exactly the operations src/ modules use: join, resolve, normalize, dirname,
// basename, relative, isAbsolute, sep.
export const sep = '/';

export function normalize(inputPath = '') {
  const isAbs = inputPath.startsWith('/');
  const parts = [];
  for (const part of String(inputPath).split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') {
      if (parts.length && parts.at(-1) !== '..') parts.pop();
      else if (!isAbs) parts.push('..');
      continue;
    }
    parts.push(part);
  }
  const joined = parts.join('/');
  return (isAbs ? '/' : '') + joined || (isAbs ? '/' : '.');
}

export function join(...segments) {
  return normalize(segments.filter(Boolean).join('/'));
}

export function resolve(...segments) {
  let resolved = '';
  for (const segment of segments) {
    if (!segment) continue;
    resolved = String(segment).startsWith('/') ? String(segment) : `${resolved}/${segment}`;
  }
  return normalize(resolved || '/');
}

export function isAbsolute(inputPath = '') {
  return String(inputPath).startsWith('/');
}

export function dirname(inputPath = '') {
  const normalized = normalize(inputPath);
  const index = normalized.lastIndexOf('/');
  if (index < 0) return '.';
  if (index === 0) return '/';
  return normalized.slice(0, index);
}

export function basename(inputPath = '') {
  const normalized = normalize(inputPath);
  return normalized.slice(normalized.lastIndexOf('/') + 1);
}

export function relative(from, to) {
  const fromParts = resolve(from).split('/').filter(Boolean);
  const toParts = resolve(to).split('/').filter(Boolean);
  let common = 0;
  while (common < fromParts.length && common < toParts.length && fromParts[common] === toParts[common]) common += 1;
  return [...fromParts.slice(common).map(() => '..'), ...toParts.slice(common)].join('/');
}

export default {sep, normalize, join, resolve, isAbsolute, dirname, basename, relative};
