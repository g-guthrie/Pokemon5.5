// The battle-session registry and per-client message routing, shared by the
// Node server (real WebSockets) and the static browser build (in-page socket
// shims). A "socket" here is anything with send(string), close(), readyState,
// an OPEN constant, and on('message'|'close', fn).
import {BattleSession} from './battle-session.mjs';

export const DEFAULT_BATTLE_ID = 'local';
export const DEFAULT_FORMAT = 'gen9randomdoublesbattle';

export function normalizeBattleId(value) {
  const id = String(value || DEFAULT_BATTLE_ID).trim().toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '');
  return id.slice(0, 80) || DEFAULT_BATTLE_ID;
}

export function normalizeRole(role) {
  if (role === 'p1' || role === 'p2') return role;
  return 'spectator';
}

export function createBattleHub(options = {}) {
  const maxBattleSessions = options.maxBattleSessions ?? 300;
  const idleMs = options.idleMs ?? 3600000;
  const battleSessions = new Map();
  const clients = new Map();

  function send(ws, payload) {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(payload));
  }

  function broadcastBattleEvent(battleId, sourceBattle, event) {
    if (battleSessions.get(battleId) !== sourceBattle) return;
    for (const [ws, client] of clients) {
      if (client.battleId !== battleId) continue;
      const role = client.role;
      if (event.type === 'protocol') {
        // Players get only their own channel (it already contains the public
        // lines plus their private requests); spectators get the public channel.
        if (role === 'p1' || role === 'p2') {
          if (event.role === role) send(ws, event);
        } else if (event.role === 'spectator') {
          send(ws, event);
        }
      } else if (event.type === 'state') {
        if (event.role === role) send(ws, event);
      } else if (event.type === 'choice') {
        if (event.role === role || role === 'spectator') send(ws, event);
      } else {
        send(ws, event);
      }
    }
  }

  function getBattle(battleId = DEFAULT_BATTLE_ID) {
    const id = normalizeBattleId(battleId);
    if (!battleSessions.has(id)) createBattle(id);
    return battleSessions.get(id);
  }

  function createBattle(battleId = DEFAULT_BATTLE_ID, sessionOptions = {}) {
    const id = normalizeBattleId(battleId);
    // Every session is a full simulator battle; a stranger cycling random
    // battleIds (via any battle-scoped endpoint or /api/reset) must not be
    // able to grow the map without bound.
    if (!battleSessions.has(id)) {
      if (battleSessions.size >= maxBattleSessions) pruneBattleSessions();
      if (battleSessions.size >= maxBattleSessions) {
        throw new Error('Too many concurrent battles — try again shortly');
      }
    }
    const battle = new BattleSession(sessionOptions);
    battle.createdAt = Date.now();
    battle.onEvent(event => broadcastBattleEvent(id, battle, event));
    battleSessions.set(id, battle);
    return battle;
  }

  function resetBattle(battleId = DEFAULT_BATTLE_ID, sessionOptions = {}) {
    const id = normalizeBattleId(battleId);
    const battle = createBattle(id, sessionOptions);
    for (const [ws, client] of clients) {
      if (client.battleId !== id) continue;
      send(ws, {type: 'reset', role: client.role, battleId: id, formatid: battle.formatid, seed: battle.seed});
      send(ws, {type: 'state', role: client.role, state: battle.extractState(client.role)});
    }
    return battle;
  }

  function pruneBattleSessions() {
    const now = Date.now();
    for (const [battleId, battle] of battleSessions) {
      if (battleId === DEFAULT_BATTLE_ID) continue;
      const clientCount = [...clients.values()].filter(client => client.battleId === battleId).length;
      if (clientCount > 0) continue;
      // Ended battles go as soon as nobody is watching; abandoned unfinished
      // ones (a visitor created it and left) go after an idle hour.
      const abandoned = now - (battle.createdAt || 0) > idleMs;
      if (battle.public?.ended || abandoned) {
        battleSessions.delete(battleId);
      }
    }
  }

  function protocolBacklogFor(battle, role) {
    if (role === 'p1' || role === 'p2') {
      return [...(battle.protocol[role] || [])];
    }
    return battle.protocol.spectator?.length ? battle.protocol.spectator : battle.protocol.omniscient || [];
  }

  function summarizeBattle(battleId, battle) {
    const spectator = battle.extractState('spectator');
    return {
      battleId,
      formatid: battle.formatid,
      seed: battle.seed,
      turn: spectator.turn,
      ended: spectator.ended,
      winner: spectator.winner,
      clients: [...clients.values()].filter(client => client.battleId === battleId).length,
    };
  }

  function handleClientMessage(ws, battleId, role, message) {
    const battle = getBattle(battleId);
    if (message.type === 'choose') {
      if (role !== 'p1' && role !== 'p2') throw new Error('Only p1 and p2 can choose');
      battle.choose(role, message.choice, message.rqid ?? null);
      return;
    }
    if (message.type === 'auto') {
      if (role !== 'p1' && role !== 'p2') throw new Error('Only p1 and p2 can choose');
      const choice = battle.autoChoose(role);
      send(ws, {type: 'auto', choice});
      return;
    }
    if (message.type === 'reset') {
      resetBattle(battleId, {
        formatid: message.formatid,
        seed: Array.isArray(message.seed) ? message.seed.map(Number) : undefined,
      });
      return;
    }
    throw new Error(`Unknown message type: ${message.type}`);
  }

  // Attach one client socket. `params` carries the parsed connection query:
  // {role, battleId, waitForStart}. Mirrors the server's handleWsConnection.
  function attachClient(ws, params = {}) {
    const role = normalizeRole(params.role);
    const battleId = normalizeBattleId(params.battleId);
    const waitForStart = Boolean(params.waitForStart);
    const battle = battleSessions.get(battleId) || (waitForStart ? null : getBattle(battleId));
    clients.set(ws, {role, battleId, waitForStart});
    send(ws, {
      type: 'hello',
      role,
      battleId,
      formatid: battle?.formatid || DEFAULT_FORMAT,
      seed: battle?.seed || null,
      ready: Boolean(battle),
    });
    if (battle) {
      for (const chunk of protocolBacklogFor(battle, role)) {
        send(ws, {type: 'protocol', role, chunk});
      }
      send(ws, {type: 'state', role, state: battle.extractState(role)});
    } else {
      send(ws, {type: 'waiting', role, battleId, reason: 'BATTLE_NOT_STARTED'});
    }

    ws.on('message', message => {
      try {
        handleClientMessage(ws, battleId, role, JSON.parse(String(message)));
      } catch (error) {
        send(ws, {type: 'error', error: String(error?.message || error)});
      }
    });
    ws.on('close', () => {
      clients.delete(ws);
      pruneBattleSessions();
    });
  }

  return {
    battleSessions,
    clients,
    getBattle,
    createBattle,
    resetBattle,
    pruneBattleSessions,
    protocolBacklogFor,
    summarizeBattle,
    attachClient,
    send,
  };
}
