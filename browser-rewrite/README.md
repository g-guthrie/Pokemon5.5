# Browser rewrite (parked)

Work-in-progress conversion of the arena into a static, serverless browser app
(Option A: visitors bring their own OpenRouter key; deployable to Cloudflare
Pages). Parked here on 2026-07-11 at the user's request; the main tree was
restored to the server-driven build.

## Status when parked

Done and verified:

- **Feasibility proven**: `@pkmn/sim` + `@pkmn/randoms` (installed as dev
  deps at the time, since removed — `npm i -D esbuild @pkmn/sim @pkmn/randoms`
  to resume) run a full `gen9randomdoublesbattle` headlessly in place of the
  vendored simulator, which cannot be bundled (dynamic `require`s in
  `dex.js`/`teams.js`/`dex-formats.js`).
- `src/battle-hub.mjs` — battle-session registry + client socket routing,
  extracted verbatim from `server.mjs` as a transport-agnostic factory.
- `src/live-run.mjs` — the whole live-run orchestration (start/pause/stop,
  multi-game loop, series recording, transcripts, `/api/run` summary shape)
  extracted from `server.mjs` as `createLiveRunManager(options)`.
- `src/showdown-lib.mjs` — single doorway to the simulator (Node: vendored
  checkout; browser: aliased to `src/browser/showdown-lib.mjs` = @pkmn/sim).
- `src/browser/` shims: in-memory `node:fs/promises`, POSIX `node:path`,
  sync-sha256 `node:crypto`, `node:url`, and a `ws` shim whose `WebSocket`
  routes match-runner connections straight into the in-worker battle hub.
- `src/browser/engine-core.mjs` — the worker-side `server.mjs` equivalent:
  same battle hub + live-run manager behind `handleApi()` (mirrors
  `/api/run`, `/api/series`, `/api/reset`, `/api/dex`, `/artifacts/*`) and
  `connectSocket()`; intercepts `fetch('http://arena.local/...')` so
  match-runner runs unchanged. Transport-free so a Node smoke can drive it.

The extraction refactor of `server.mjs` (using battle-hub + live-run) was
completed and passed the full 28-check verify suite before being reverted,
so these modules are known-compatible with the server's behavior.

## Not yet done

- Web Worker entry (`postMessage` bridge binding `handleApi`/`connectSocket`
  to MessagePorts) and an esbuild bundle script (aliases: `ws`,
  `node:fs/promises`, `node:path`, `node:crypto`, `node:url`,
  `../showdown-lib.mjs` → the browser shims; inject a `process.env` stub).
- Page-side wire: `window.__arenaWire` socket shim + `apiFetch()` wrapper in
  `arena.js`; `showdown-adapter.js` falls back to a parent-provided wire.
- Static-mode replacements for `/api/models` and `/api/key/validate`
  (both are direct OpenRouter fetches; CORS-safe from the browser).
- Series persistence bridge (worker memfs → `localStorage`) and transcript
  download UI.
- Static frame assets: ship `vendor/pokemon-showdown-client` `/ps/js` +
  `/ps/style`; point `Config.routes.client` at `play.pokemonshowdown.com`
  so sprites/`/data/*` load from the official CDN.
- Build script assembling the deploy directory + `wrangler.toml`;
  `wrangler pages deploy`.
