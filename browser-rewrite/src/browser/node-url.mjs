// node:url shim for the browser bundle. Only fileURLToPath is used (to anchor
// the virtual artifacts directory); any URL maps to its pathname so every
// bundled module agrees on "/" as the root.
export function fileURLToPath(url) {
  try {
    return new URL(String(url)).pathname || '/';
  } catch {
    return '/';
  }
}

export default {fileURLToPath};
