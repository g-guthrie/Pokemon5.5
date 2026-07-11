// The static build's stand-in for server.mjs: the same battle hub and
// live-run manager, addressed through in-memory sockets and a tiny local API
// dispatcher instead of HTTP/WebSockets. Transport-free by design — the
// worker entry bridges page MessagePorts to connectSocket()/handleApi(), and
// the Node engine smoke drives the same functions directly.
import {sanitizeText} from '../agent-runtime.mjs';
import {createBattleHub, normalizeBattleId} from '../battle-hub.mjs';
import {moveCard, speciesCard} from '../dex-context.mjs';
import {createLiveRunManager, normalizeSessionId, sanitizeAgentSpec} from '../live-run.mjs';
import {files as memfs} from './node-fs.mjs';
import {createLocalSocketPair, setConnectionRouter} from './ws-shim.mjs';

const SERVER_ORIGIN = 'http://arena.local';
const ARTIFACTS_DIR = '/artifacts';
const SERIES_STORE_PATH = '/artifacts/series-store.json';

export function createEngine(options = {}) {
  // Everything in this engine belongs to one visitor's browser, so the pool
  // caps exist only to bound memory, not to arbitrate strangers.
  const battleHub = createBattleHub({maxBattleSessions: 40, idleMs: 3600000});

  if (typeof options.initialSeriesJson === 'string' && options.initialSeriesJson.trim()) {
    memfs.set(SERIES_STORE_PATH, options.initialSeriesJson);
  }

  const liveRunManager = createLiveRunManager({
    artifactsDir: ARTIFACTS_DIR,
    serverOrigin: SERVER_ORIGIN,
    seriesStorePath: SERIES_STORE_PATH,
    maxConcurrentRuns: 1,
    afterSeriesSave: async () => {
      if (options.persistSeries) options.persistSeries(memfs.get(SERIES_STORE_PATH) || '');
    },
  });

  // match-runner reaches the hub through the 'ws' shim...
  setConnectionRouter((serverSocket, params) => battleHub.attachClient(serverSocket, params));

  // ...and resets battles through fetch(`${serverOrigin}/api/reset`). Route
  // engine-origin fetches back into handleApi so match-runner runs unchanged.
  const nativeFetch = globalThis.fetch.bind(globalThis);
  globalThis.fetch = async (resource, init = {}) => {
    const url = String(resource?.url || resource || '');
    if (!url.startsWith(SERVER_ORIGIN)) return nativeFetch(resource, init);
    const parsed = new URL(url);
    const body = init.body ? JSON.parse(String(init.body)) : {};
    const result = await handleApi(parsed.pathname, {
      method: (init.method || 'GET').toUpperCase(),
      body,
      searchParams: parsed.searchParams,
    });
    return new Response(typeof result.payload === 'string' ? result.payload : JSON.stringify(result.payload), {
      status: result.status,
      headers: {'content-type': typeof result.payload === 'string' ? 'text/plain; charset=utf-8' : 'application/json; charset=utf-8'},
    });
  };

  // Open one client socket into the hub (page deck/spectator/frame sockets).
  function connectSocket(params = {}) {
    const [clientSide, serverSide] = createLocalSocketPair();
    clientSide.readyState = clientSide.OPEN;
    serverSide.readyState = serverSide.OPEN;
    queueMicrotask(() => battleHub.attachClient(serverSide, params));
    return clientSide;
  }

  // The local API dispatcher: same paths, methods, and response shapes as the
  // Node server's handleHttpRequest, minus transport/static/batch concerns.
  async function handleApi(pathname, {method = 'GET', body = {}, searchParams = new URLSearchParams()} = {}) {
    try {
      if (pathname === '/api/run' && method === 'GET') {
        const sessionId = normalizeSessionId(searchParams.get('session'));
        return ok({ok: true, run: liveRunManager.summarizeLiveRun(liveRunManager.liveRuns.get(sessionId) || null)});
      }
      if (pathname === '/api/run' && method === 'POST') {
        const command = String(body.command || body.action || 'start').trim().toLowerCase();
        const sessionId = normalizeSessionId(body.sessionId);
        const run = liveRunManager.runCommand(command, body, sessionId);
        return ok({ok: true, run: liveRunManager.summarizeLiveRun(run)});
      }
      if (pathname === '/api/series' && method === 'GET') {
        const identity = {
          sessionId: normalizeSessionId(searchParams.get('session')),
          agentP1: sanitizeAgentSpec(searchParams.get('agentP1')),
          agentP2: sanitizeAgentSpec(searchParams.get('agentP2')),
        };
        return ok({ok: true, series: await liveRunManager.seriesGet(identity)});
      }
      if (pathname === '/api/series' && method === 'POST') {
        const command = String(body.command || body.action || '').trim().toLowerCase();
        if (command !== 'reset') throw new Error(`Unknown series command: ${command}`);
        await liveRunManager.seriesReset({
          sessionId: normalizeSessionId(body.sessionId),
          agentP1: sanitizeAgentSpec(body.agentP1),
          agentP2: sanitizeAgentSpec(body.agentP2),
        });
        return ok({ok: true, series: null});
      }
      if (pathname === '/api/reset' && method === 'POST') {
        const battleId = normalizeBattleId(body.battleId || body.battle || searchParams.get('battleId') || searchParams.get('battle'));
        const battle = battleHub.resetBattle(battleId, {
          formatid: typeof body.formatid === 'string' ? body.formatid : undefined,
          seed: Array.isArray(body.seed) ? body.seed.map(Number).filter(Number.isFinite) : undefined,
          playerNames: body.playerNames && typeof body.playerNames === 'object'
            ? {p1: body.playerNames.p1, p2: body.playerNames.p2}
            : undefined,
        });
        return ok({ok: true, battleId, formatid: battle.formatid, seed: battle.seed});
      }
      if (pathname === '/api/dex') {
        // Move/species cards for the decision deck — same tooltip facts the
        // prompt's dexContext carries, straight from the bundled dex.
        const names = param => String(searchParams.get(param) || '').split(',').map(name => name.trim()).filter(Boolean).slice(0, 80);
        return ok({
          moves: Object.fromEntries(names('moves').map(name => [name, moveCard(name)]).filter(([, card]) => card)),
          species: Object.fromEntries(names('species').map(name => [name, speciesCard(name)]).filter(([, card]) => card)),
        });
      }
      if (pathname === '/healthz') {
        return ok({ok: true, activeRuns: 0, battles: battleHub.battleSessions.size});
      }
      if (pathname.startsWith('/artifacts/')) {
        const key = decodeURIComponent(pathname.replace(/^\/artifacts/, ARTIFACTS_DIR));
        if (!memfs.has(key)) return {status: 404, payload: {ok: false, error: 'Not found'}};
        return {status: 200, payload: memfs.get(key)};
      }
      return {status: 404, payload: {ok: false, error: `No local route: ${pathname}`}};
    } catch (error) {
      return {status: 400, payload: {ok: false, error: sanitizeText(error?.message || error)}};
    }
  }

  return {handleApi, connectSocket, battleHub, liveRunManager};
}

function ok(payload) {
  return {status: 200, payload};
}
