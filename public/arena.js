// Showdown LLM Arena: the stage is literally the native Showdown client.
//
// The models play headlessly: each receives a structured observation and
// returns one exact legal choice string. The stage is Player 1's native
// client (dark theme) with the battle log replaced by the Model Minds: the
// client itself hosts P1's mind left of the field and P2's mind on the right
// where the log used to be (mind-card.js renders them in-frame; this file
// streams content in over sd-mind messages). A cursor animates pressing the
// real native buttons for every structured choice.

const ROLES = ['p1', 'p2'];
// The client canvas is three columns: P1's Model Mind (310px), the battle
// field (640px), P2's Model Mind (310px, where the battle log used to live).
// The minds are INSIDE the frame — rendered by the client itself; the parent
// streams content in over sd-mind messages. The 310px column width is
// hardcoded in arena.css (.controls-overlay) and showdown-frame.css /
// mind-card.css alongside this 310 + 640 + 310 total.
const CLIENT_BASE_WIDTH = 1260;
const CLIENT_BASE_HEIGHT = 760;
const CLIENT_BATTLE_WIDTH = 640;
const CLIENT_MIND_WIDTH = 310;
const MOBILE_STAGE_BREAKPOINT = 760;
const MOBILE_FOCUS_KEY = 'arena-mobile-focus';
let mobileFocus = localStorage.getItem(MOBILE_FOCUS_KEY) || 'battle';
// Proven in real matches/preflights through the OpenRouter adapter.
const AGENT_PRESETS = [
  'standin',
  'openrouter:anthropic/claude-sonnet-4.6:low',
  'openrouter:openai/gpt-4o-mini:low',
  'openrouter:z-ai/glm-5.2:low',
  'openrouter:minimax/minimax-m3:low',
  'openrouter:deepseek/deepseek-v4-flash:low',
];
const $ = id => document.getElementById(id);
const wsProtocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
const DEFAULT_NOTE_HTML = document.getElementById('live-note').innerHTML;

// Every browser gets its own session: its own battle on the server, its own
// run slot, its own series records. Concurrent visitors never collide.
const SESSION_ID = (() => {
  const existing = localStorage.getItem('arena-session');
  if (existing && /^[a-z0-9-]{6,24}$/.test(existing)) return existing;
  const fresh = (crypto.randomUUID ? crypto.randomUUID() : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`)
    .toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, 16);
  localStorage.setItem('arena-session', fresh);
  return fresh;
})();
const BATTLE_ID = `s-${SESSION_ID}`;

// The live frames attach to this session's battle.
for (const frame of document.querySelectorAll('iframe[data-frame-src]')) {
  frame.src = `${frame.dataset.frameSrc}&battleId=${encodeURIComponent(BATTLE_ID)}`;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function parseAgentSpec(spec) {
  const text = String(spec || '').trim();
  if (!text) return {provider: 'local', model: 'unknown', effort: ''};
  if (text === 'human') return {provider: 'human', model: 'human', effort: ''};
  const parts = text.split(':');
  if (parts.length === 1) return {provider: 'local', model: parts[0], effort: ''};
  return {
    provider: parts[0],
    model: parts.slice(1, -1).join(':') || parts[1] || text,
    effort: parts.length > 2 ? parts.at(-1) : '',
  };
}

function renderPlate(plate, agent) {
  const info = typeof agent === 'string'
    ? parseAgentSpec(agent)
    : {
        provider: agent?.provider || 'local',
        model: agent?.model || agent?.name || 'unknown',
        effort: agent?.reasoningEffort || '',
      };
  plate.querySelector('.provider').textContent = displayProvider(info.provider || 'local');
  plate.querySelector('.model-name').textContent = displayModelName(info.model || 'unknown');
  plate.querySelector('.effort').textContent = info.effort ? `${info.effort} effort` : '';
}

// Built-in players get names a viewer can parse; "standin-dex-heuristic-v1"
// is an artifact id, not television.
function displayModelName(model) {
  const name = String(model || '');
  if (/^human$/i.test(name)) return 'You';
  if (/standin/i.test(name)) return 'Demo Bot';
  if (/heuristic/i.test(name)) return 'Greedy Bot';
  return name;
}

function displayProvider(provider) {
  if (String(provider || '') === 'human') return 'human';
  return ['local', 'standin', 'heuristic'].includes(String(provider || '')) ? 'built-in' : provider;
}

function shortName(agent) {
  if (!agent) return 'unknown';
  if (typeof agent === 'string') return displayModelName(parseAgentSpec(agent).model);
  return displayModelName(agent.model || agent.name || 'unknown');
}

function queuedName(agent) {
  const info = parseAgentSpec(agent);
  const model = displayModelName(info.model);
  return info.effort ? `${model} · ${info.effort}` : model;
}

function setStatusPill(pill, status, label) {
  pill.dataset.status = status;
  pill.textContent = label || status;
}

// A new turn is a downbeat: the ring pulses once when the number changes.
function setTurnCounter(el, value) {
  const next = String(value);
  if (el.textContent === next) return;
  el.textContent = next;
  const ring = el.closest('.turn-ring');
  if (!ring) return;
  ring.classList.remove('pulse');
  void ring.offsetWidth; // restart the animation
  ring.classList.add('pulse');
}

function compactCost(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return '';
  return n >= 0.01 ? `$${n.toFixed(2)}` : `$${n.toFixed(4)}`;
}

/* ---------------- model minds (rendered inside the client frame) ---------------- */

// The Model Minds live INSIDE the native client now: the frame hosts a P1
// column left of the field and a P2 column where the battle log used to be
// (mind-card.js renders them). The parent just streams content in. State is
// kept per view so a frame reload (new battle) can be re-flushed on its
// sd-ready.
const mindBuses = {
  live: {frame: () => $('live-frame-battle'), state: {p1: {}, p2: {}}},
};

function postToMindFrame(view, payload) {
  // A hard-paused live stage repaints nothing; the buffered state (already
  // stored by the callers) replays via flushMinds on resume.
  if (view === 'live' && live.showPaused) return;
  const frameWindow = mindBuses[view].frame()?.contentWindow;
  if (!frameWindow) return;
  try {
    const bridge = frameWindow.ArenaMindBridge;
    if (payload.type === 'sd-mind' && bridge?.render) {
      bridge.render(payload.role, payload.data, payload.options);
      return;
    }
    if (payload.type === 'sd-mind-meta' && bridge?.setMeta) {
      bridge.setMeta(payload.role, payload);
      return;
    }
  } catch {
    // A frame navigating between documents can briefly reject direct access.
    // Its sd-ready event will flush the canonical buffered state again.
  }
  frameWindow.postMessage({scope: 'showdown-arena', ...payload}, '*');
}

function sendMind(view, role, data, options = {}) {
  const state = mindBuses[view].state[role];
  state.data = data;
  state.options = options;
  postToMindFrame(view, {type: 'sd-mind', role, data, options});
}

function sendMindMeta(view, role, meta) {
  const state = mindBuses[view].state[role];
  state.meta = {...state.meta, ...meta, fresh: false};
  postToMindFrame(view, {type: 'sd-mind-meta', role, ...meta});
}

// A (re)loaded frame boots with placeholder minds; replay the latest state.
function flushMinds(view) {
  for (const role of ROLES) {
    const state = mindBuses[view].state[role];
    if (state.meta) postToMindFrame(view, {type: 'sd-mind-meta', role, ...state.meta});
    if (state.options) postToMindFrame(view, {type: 'sd-mind', role, data: state.data ?? null, options: state.options});
  }
}

// Reveal pacing is owned by mind-card.js (loaded before this module in
// index.html); window.ArenaMind.revealDurationMs is the one clock both the
// mind reveal and the button-press gate read.
function mindRevealMs(data) {
  return window.ArenaMind.revealDurationMs(data);
}

// Only real model analysis renders as a mind: the ten questions answered in
// English. Built-in bots have no thought process — never fabricate one from
// their internal scores (those stay in the artifact as telemetry only).
function publicAnalysisForCall(call = {}) {
  if (call.analysis && Object.values(call.analysis).some(items => Array.isArray(items) && items.length)) {
    return call.analysis;
  }
  return null;
}

function modelMindData(call = {}, action = null, observation = null, turn = null) {
  return {
    analysis: publicAnalysisForCall(call),
    choice: call.choice,
    choiceLabel: choiceLabel(call.choice, observation) || action?.label || '',
    actionNames: actionNamesFromObservation(observation),
    reason: call.reason,
    valid: call.valid,
    fallback: call.fallback,
    usage: call.usage,
    prompt: call.prompt,
    rawText: call.rawText,
    error: call.error,
    turn: action?.turn ?? turn ?? null,
  };
}

// Per-slot names so the mind can translate protocol tokens wherever they
// appear — including inside the model's own candidate lines ("move 3 2" →
// "Tailwind on Venusaur"). Built from the exact request observation. foes and
// allies map active slots to the Pokémon standing in them, so targets render
// as names, never numbers.
function actionNamesFromObservation(observation) {
  const names = {moves: {}, switches: {}, foes: {}, allies: {}};
  for (const [index, mon] of (observation?.self?.activePokemon || []).entries()) {
    const slot = Number(mon.activeSlot) || index + 1;
    names.allies[slot] = mon.name || mon.species || '';
  }
  for (const [index, mon] of (observation?.opponent?.activePokemon || []).entries()) {
    const slot = Number(mon.activeSlot) || index + 1;
    names.foes[slot] = mon.name || mon.species || '';
  }
  for (const action of observation?.legalActions || []) {
    for (const part of action.choices || [action]) {
      const tokens = String(part.choice || '').trim().split(/\s+/);
      if (tokens[0] === 'move' && part.move) {
        const active = Number(part.activeSlot) || 1;
        const slot = Number(tokens[1]);
        if (slot) names.moves[`${active}:${slot}`] = part.move;
      }
      if (tokens[0] === 'switch') {
        const slot = Number(tokens[1]);
        const name = part.pokemon || String(part.label || '').replace(/^.*switch to /i, '');
        if (slot && name) names.switches[slot] = name;
      }
    }
  }
  return names;
}

// "move 3 2, move 4 1" is protocol, not television: translate a choice into
// the sentence a caster would say — "Charizard: Flamethrower on Venusaur".
// Parts are positional in doubles (first part = active 1). All-or-nothing: if
// ANY move or switch part fails to resolve to a real name, return '' so
// callers fall back to the server's fully-English label — a chip must never
// mix "move 2" protocol with human words. The raw string stays in tooltips
// and artifacts.
function choiceLabel(choice, observation) {
  if (!observation) return '';
  const names = actionNamesFromObservation(observation);
  const team = observation.self?.team || [];
  const parts = String(choice || '').split(',').map(part => part.trim()).filter(Boolean);
  if (!parts.length) return '';
  let failed = false;
  const labels = parts.map((part, index) => {
    const tokens = part.split(/\s+/);
    if (tokens[0] === 'move') {
      const active = Math.min(index + 1, 2);
      const slot = tokens[1];
      const name = names.moves[`${active}:${slot}`] || names.moves[`1:${slot}`] || names.moves[`2:${slot}`];
      if (name) {
        const actor = names.allies[active] ? `${names.allies[active]}: ` : '';
        const target = tokens.slice(2).find(token => /^-?\d$/.test(token));
        let suffix = '';
        if (target) {
          const targetSlot = Math.abs(Number(target));
          suffix = Number(target) > 0
            ? (names.foes[targetSlot] ? ` on ${names.foes[targetSlot]}` : ' on the foe')
            : (names.allies[targetSlot] ? ` on ally ${names.allies[targetSlot]}` : ' on an ally');
        }
        return actor + name + (part.includes('terastallize') ? ' ⭐Tera' : '') + suffix;
      }
      failed = true;
      return part;
    }
    if (tokens[0] === 'switch') {
      const name = names.switches[Number(tokens[1])] ||
        (team.find(m => Number(m.slot) === Number(tokens[1]))?.name);
      if (name) return `switch → ${name}`;
      failed = true;
      return part;
    }
    if (tokens[0] === 'team') return `lead ${tokens.slice(1).join(' ')}`;
    if (tokens[0] === 'pass') return 'pass';
    failed = true;
    return part;
  });
  return failed ? '' : labels.join(' · ');
}

// HP text like "184/232 par" or "0 fnt" → a percentage plus badges.
function hpParts(condition = '') {
  const text = String(condition).trim();
  if (!text || /^0\b/.test(text) || /\bfnt\b/.test(text)) return {pct: 0, fainted: true, status: ''};
  const match = text.match(/^(\d+)\/(\d+)(?:\s+([a-z]+))?/i);
  if (!match) return {pct: 100, fainted: false, status: ''};
  return {
    pct: Math.max(0, Math.min(100, Math.round((Number(match[1]) / Math.max(1, Number(match[2]))) * 100))),
    fainted: false,
    status: match[3] || '',
  };
}


/* ---------------- human play (you vs the AI) ---------------- */

// Player 1 can be YOU: pick "You" in P1's picker and the decision deck stops
// re-enacting and becomes the actual controls. Clicks compose a choice part
// by part (move -> target -> second slot...), validated at every step against
// the exact legal choice space, then submit over this page's own p1 socket.
const humanPlay = {
  armed: false,
  rqid: null,
  observation: null,
  candidates: [],
  picked: [],
  teraArmed: {},
};
window.__arenaHuman = humanPlay;

function activeHumanRole() {
  const run = live.run;
  return run && isActiveRun(run) ? (run.humanRoles || [])[0] || null : null;
}

// Whether the player wants to SEE the AI's thinking while playing against
// it. Persisted; the server only ships the opponent's mind when its own
// reveal flag is set, so flipping this round-trips through /api/run.
const MIND_PEEK_KEY = 'arena-peek-mind';
let mindPeek = localStorage.getItem(MIND_PEEK_KEY) === '1';
let mindPeekSyncedRunId = '';

function toggleMindPeek() {
  mindPeek = !mindPeek;
  localStorage.setItem(MIND_PEEK_KEY, mindPeek ? '1' : '0');
  // Force both mind cards to repaint in their new mode on the next render.
  live.lastCallKey = {p1: '', p2: ''};
  if (activeHumanRole()) {
    void liveCommand({command: 'reveal-mind', reveal: mindPeek});
  } else {
    renderLiveRun();
  }
}

// A human run started elsewhere (another tab, a reload) may disagree with
// the local preference; converge once per run.
function syncMindPeek(run) {
  if (!run || !activeHumanRole() || mindPeekSyncedRunId === run.id) return;
  mindPeekSyncedRunId = run.id;
  if (Boolean(run.revealOpponentMind) !== mindPeek) {
    void liveCommand({command: 'reveal-mind', reveal: mindPeek});
  }
}

function humanCandidatesFrom(observation) {
  return (observation?.legalActions || []).map(action => ({
    choice: action.choice,
    parts: (action.choices || [action]).map(part => part.choice),
  }));
}

function humanOptionsAt(index) {
  return [...new Set(humanPlay.candidates.map(candidate => candidate.parts[index]).filter(Boolean))];
}

async function renderHumanDeck(observation) {
  humanPlay.armed = true;
  humanPlay.rqid = observation?.requestId ?? null;
  humanPlay.observation = observation;
  humanPlay.candidates = humanCandidatesFrom(observation);
  humanPlay.picked = [];
  humanPlay.teraArmed = {};
  const host = $('live-deck');
  host.classList.add('human-live');
  const done = await renderDeck(host, observation, 'p1', {
    state: 'your-turn',
    stateLabel: humanStateLabel(),
  });
  if (done !== false) decorateHumanDeck();
  autoAdvanceHumanPasses();
}

function humanStateLabel() {
  const total = humanPlay.candidates[0]?.parts.length || 1;
  const slot = humanPlay.picked.length + 1;
  return total > 1 ? `YOUR MOVE — choose for slot ${Math.min(slot, total)} of ${total}` : 'YOUR MOVE — pick an action';
}

// Fainted slots and exhausted benches leave 'pass' as the only legal part:
// pick those automatically so the player only ever presses real decisions.
function autoAdvanceHumanPasses() {
  if (!humanPlay.armed) return;
  let advanced = false;
  for (;;) {
    const total = humanPlay.candidates[0]?.parts.length || 0;
    if (humanPlay.picked.length >= total) break;
    const options = humanOptionsAt(humanPlay.picked.length);
    if (options.length === 1 && options[0] === 'pass') {
      pickHumanPart('pass', {silent: true});
      advanced = true;
      continue;
    }
    break;
  }
  if (advanced && humanPlay.armed) refreshHumanDeckState();
}

function pickHumanPart(part, options = {}) {
  const index = humanPlay.picked.length;
  const matching = humanPlay.candidates.filter(candidate => candidate.parts[index] === part);
  if (!matching.length) return false;
  humanPlay.picked.push(part);
  humanPlay.candidates = matching;
  const total = humanPlay.candidates[0].parts.length;
  if (humanPlay.picked.length >= total) {
    submitHumanChoice(humanPlay.candidates[0].choice);
    return true;
  }
  if (!options.silent) refreshHumanDeckState();
  autoAdvanceHumanPasses();
  return true;
}

function refreshHumanDeckState() {
  const stateEl = $('live-deck').querySelector('.deck-state');
  if (stateEl) stateEl.textContent = humanStateLabel();
  decorateHumanDeck();
}

function submitHumanChoice(choice) {
  const socket = live.deckSockets.p1;
  if (!socket || socket.readyState !== WebSocket.OPEN) {
    const note = $('live-note');
    note.textContent = 'Connection to the battle dropped — reconnecting, try again in a second';
    note.classList.add('error');
    void renderHumanDeck(humanPlay.observation);
    return;
  }
  socket.send(JSON.stringify({type: 'choose', choice, rqid: humanPlay.rqid}));
  humanPlay.armed = false;
  sendMindMeta('live', 'p1', {chip: 'locked in', fresh: true});
  const stateEl = $('live-deck').querySelector('.deck-state');
  if (stateEl) {
    stateEl.textContent = 'Locked in — battle resolving';
    stateEl.className = 'deck-state committed';
  }
  const deck = $('live-deck').querySelector('.deck');
  if (deck) deck.dataset.state = 'committed';
}

// One delegated listener: reuses the deck's existing press anatomy
// (data-press-move / -target / -switch / -tera) plus human-only pass/undo.
function handleHumanDeckClick(event) {
  if (!humanPlay.armed || !activeHumanRole()) return;
  const el = event.target.closest(
    '[data-press-tera], [data-press-target], [data-press-move], [data-press-switch], [data-human-pass], [data-human-undo]'
  );
  if (!el) return;
  event.preventDefault();
  event.stopPropagation();
  if (el.dataset.humanUndo != null) {
    void renderHumanDeck(humanPlay.observation);
    return;
  }
  if (el.dataset.humanPass != null) {
    pickHumanPart('pass');
    return;
  }
  if (el.dataset.pressTera) {
    const slot = Number(el.dataset.pressTera);
    humanPlay.teraArmed[slot] = !humanPlay.teraArmed[slot];
    el.classList.toggle('deck-chosen', Boolean(humanPlay.teraArmed[slot]));
    return;
  }
  if (el.dataset.pressSwitch) {
    if (pickHumanPart(`switch ${Number(el.dataset.pressSwitch)}`)) el.classList.add('deck-chosen');
    return;
  }
  if (el.dataset.pressTarget) {
    const [active, move, target] = el.dataset.pressTarget.split(':').map(Number);
    const tera = humanPlay.teraArmed[active] ? ' terastallize' : '';
    if (!pickHumanPart(`move ${move} ${target}${tera}`) && tera) pickHumanPart(`move ${move} ${target}`);
    closeHumanFlyouts();
    return;
  }
  if (el.dataset.pressMove) {
    const [active, move] = el.dataset.pressMove.split(':').map(Number);
    const tera = humanPlay.teraArmed[active] ? ' terastallize' : '';
    // Target-less part first (respecting an armed Tera, falling back to the
    // plain move if that variant doesn't exist for this request).
    if (pickHumanPart(`move ${move}${tera}`)) {
      el.classList.add('deck-chosen');
      return;
    }
    if (tera && pickHumanPart(`move ${move}`)) {
      humanPlay.teraArmed[active] = false;
      el.classList.add('deck-chosen');
      return;
    }
    // Otherwise the move needs a target: open this card's flyout and wait.
    const flyout = el.querySelector('.deck-move-targets');
    if (flyout) {
      closeHumanFlyouts();
      flyout.classList.add('open');
    }
  }
}

function closeHumanFlyouts() {
  for (const flyout of $('live-deck').querySelectorAll('.deck-move-targets.open')) {
    flyout.classList.remove('open');
  }
}

// Human-only chrome on top of the shared deck: a pass button when passing is
// genuinely legal to press, and an undo chip once something is picked.
function decorateHumanDeck() {
  const host = $('live-deck');
  const deck = host.querySelector('.deck');
  if (!deck) return;
  deck.querySelector('.deck-human-bar')?.remove();
  const bar = el('div', 'deck-human-bar');
  const options = humanOptionsAt(humanPlay.picked.length);
  if (options.includes('pass') && options.length > 1) {
    const pass = el('button', 'deck-pass', 'Pass this slot');
    pass.type = 'button';
    pass.dataset.humanPass = '1';
    bar.appendChild(pass);
  }
  if (humanPlay.picked.length) {
    const undo = el('button', 'deck-undo', '↺ start over');
    undo.type = 'button';
    undo.dataset.humanUndo = '1';
    bar.appendChild(undo);
  }
  if (bar.children.length) deck.appendChild(bar);
}

$('live-deck').addEventListener('click', handleHumanDeckClick, true);

// The stage never scrolls internally: focus jumps and scrollIntoView (e.g.
// keyboard-navigating live deck buttons) would otherwise crop the battle
// field and desync every measured coordinate.
for (const pinned of [$('live-viewport-battle'), $('live-deck')]) {
  pinned.addEventListener('scroll', () => {
    pinned.scrollLeft = 0;
    pinned.scrollTop = 0;
  });
}

/* ---------------- decision deck ---------------- */

// The stage is Player 1's full native client with its own controls hidden;
// our decision deck sits exactly over the controls region and renders the
// acting player's real choice space — sprites, type-colored moves with
// PP/power/accuracy, switch cards, Tera — from the same structured request
// the models receive. Presses re-enact on these buttons.
function setControlsOwner(deckEl, ownerEl, side) {
  deckEl.dataset.side = side;
  ownerEl.dataset.side = side;
  ownerEl.textContent = side === 'p2' ? 'P2 deciding' : 'P1 deciding';
}

const SPRITE_BASE = 'https://play.pokemonshowdown.com/sprites';
const dexCards = {moves: new Map(), species: new Map()};
const deckRenderVersions = new WeakMap();

function toDexId(name) {
  return String(name || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
}

function spriteUrl(species) {
  return `${SPRITE_BASE}/gen5/${toDexId(species)}.png`;
}

function typeIconUrl(type) {
  return `${SPRITE_BASE}/types/${encodeURIComponent(type)}.png`;
}

async function ensureDexCards(moveNames, speciesNames) {
  const missingMoves = [...new Set(moveNames)].filter(name => name && !dexCards.moves.has(name));
  const missingSpecies = [...new Set(speciesNames)].filter(name => name && !dexCards.species.has(name));
  if (!missingMoves.length && !missingSpecies.length) return;
  try {
    const query = new URLSearchParams({moves: missingMoves.join(','), species: missingSpecies.join(',')});
    const response = await fetch(`/api/dex?${query}`);
    const payload = await response.json();
    for (const [name, card] of Object.entries(payload.moves || {})) dexCards.moves.set(name, card);
    for (const [name, card] of Object.entries(payload.species || {})) dexCards.species.set(name, card);
    for (const name of missingMoves) if (!dexCards.moves.has(name)) dexCards.moves.set(name, null);
    for (const name of missingSpecies) if (!dexCards.species.has(name)) dexCards.species.set(name, null);
  } catch {
    // cards are decoration; the deck renders without them
  }
}

// Distill a PlayerObservation's exact legal actions into per-slot controls:
// unique moves (with their press slot numbers, targets, and Tera variants)
// plus the switch options.
function deckPlanFromObservation(observation) {
  if (!observation) return null;
  const slots = new Map();
  const switches = new Map();
  let hasTera = false;
  const addPart = part => {
    if (!part || !part.choice) return;
    const tokens = String(part.choice).trim().split(/\s+/);
    if (tokens[0] === 'move') {
      const activeSlot = Number(part.activeSlot) || 1;
      const moveSlot = Number(tokens[1]) || null;
      if (!moveSlot) return;
      if (!slots.has(activeSlot)) slots.set(activeSlot, new Map());
      const moves = slots.get(activeSlot);
      const key = `${moveSlot}`;
      if (!moves.has(key)) {
        moves.set(key, {
          moveSlot,
          name: part.move || `Move ${moveSlot}`,
          pp: part.pp ?? null,
          maxpp: part.maxpp ?? null,
          targets: new Set(),
          canTera: false,
        });
      }
      const entry = moves.get(key);
      if (part.targetSlot != null) entry.targets.add(Number(part.targetSlot));
      // Ally/self targets are NEGATIVE in the choice protocol ("move 1 -2");
      // keep the sign so the chip renders as ally, the human click composes
      // the legal string, and the press animation finds its button.
      if (part.allyTargetSlot != null) entry.targets.add(-Number(part.allyTargetSlot));
      if (String(part.choice).includes('terastallize')) {
        entry.canTera = true;
        hasTera = true;
      }
    } else if (tokens[0] === 'switch') {
      const slot = Number(tokens[1]);
      if (Number.isFinite(slot) && !switches.has(slot)) {
        switches.set(slot, {slot, pokemon: part.pokemon || '', condition: part.condition || ''});
      }
    }
  };
  for (const action of observation.legalActions || []) {
    if (Array.isArray(action.choices)) for (const part of action.choices) addPart(part);
    else addPart(action);
  }
  const team = observation.self?.team || [];
  const active = observation.self?.activePokemon || [];
  return {
    turn: observation.turn ?? null,
    rqid: observation.requestId ?? null,
    forceSwitch: (observation.legalActions || []).some(action =>
      action.type === 'force-switch' || (action.choices || []).some(part => part.type === 'force-switch')),
    hasTera,
    slots: [...slots.entries()].sort(([a], [b]) => a - b).map(([activeSlot, moves]) => ({
      activeSlot,
      mon: active.find(mon => Number(mon.activeSlot ?? mon.slot) === activeSlot) || active[activeSlot - 1] || null,
      moves: [...moves.values()].sort((a, b) => a.moveSlot - b.moveSlot),
    })),
    switches: [...switches.values()].sort((a, b) => a.slot - b.slot).map(entry => ({
      ...entry,
      mon: team.find(mon => Number(mon.slot) === entry.slot) || null,
    })),
  };
}

function deckHpParts(condition) {
  return hpParts(condition);
}

function buildDeckMonHeader(mon, fallbackName) {
  const head = el('div', 'deck-mon');
  const img = document.createElement('img');
  img.className = 'deck-sprite';
  img.alt = '';
  img.src = spriteUrl(mon?.species || mon?.name || fallbackName);
  img.addEventListener('error', () => img.classList.add('hidden'));
  head.appendChild(img);
  const info = el('div', 'deck-mon-info');
  info.appendChild(el('b', '', mon?.name || mon?.species || fallbackName || '?'));
  const hp = deckHpParts(mon?.condition || '');
  const bar = el('div', `mon-hp${hp.fainted ? '' : hp.pct <= 25 ? ' low' : hp.pct <= 55 ? ' mid' : ''}`);
  const fill = el('i');
  fill.style.width = `${hp.fainted ? 0 : hp.pct}%`;
  bar.appendChild(fill);
  info.appendChild(bar);
  head.appendChild(info);
  return head;
}

function buildDeckMoveButton(slot, move, opponentActive) {
  const card = dexCards.moves.get(move.name);
  const type = card?.type || 'Normal';
  const button = el('button', `deck-move type-${toDexId(type)}`);
  button.type = 'button';
  button.dataset.pressMove = `${slot.activeSlot}:${move.moveSlot}`;
  const icon = document.createElement('img');
  icon.className = 'deck-type-icon';
  icon.alt = type;
  icon.src = typeIconUrl(type);
  icon.addEventListener('error', () => icon.classList.add('hidden'));
  button.appendChild(icon);
  const label = el('span', 'deck-move-name', move.name);
  button.appendChild(label);
  const meta = el('span', 'deck-move-meta');
  const bits = [];
  if (card?.basePower) bits.push(`${card.basePower} BP`);
  if (card?.accuracy && card.accuracy !== 'never misses') bits.push(`${card.accuracy}%`);
  if (move.pp != null && move.maxpp != null) bits.push(`${move.pp}/${move.maxpp} PP`);
  meta.textContent = bits.join(' · ');
  button.appendChild(meta);

  // Targeted moves carry their own flyout, confined to this card: it opens
  // over the button when the press needs to aim.
  const targets = [...move.targets].sort((a, b) => a - b);
  if (targets.length) {
    const flyout = el('span', 'deck-move-targets');
    flyout.appendChild(el('span', 'deck-aim-label', 'at who?'));
    for (const [index, value] of targets.entries()) {
      const chip = el('span', `deck-target ${value > 0 ? 'foe' : 'ally'}`);
      chip.dataset.pressTarget = `${slot.activeSlot}:${move.moveSlot}:${value}`;
      chip.style.transitionDelay = `${index * 60}ms`;
      const mon = value > 0 ? opponentActive[value - 1] : null;
      if (mon) {
        const img = document.createElement('img');
        img.className = 'deck-sprite tiny';
        img.alt = '';
        img.src = spriteUrl(mon.species || mon.name || '');
        img.addEventListener('error', () => img.classList.add('hidden'));
        chip.appendChild(img);
      }
      chip.appendChild(el('b', '', value > 0 ? (mon?.name || mon?.species || `Foe ${value}`) : 'Ally'));
      flyout.appendChild(chip);
    }
    button.appendChild(flyout);
  }
  return button;
}

async function renderDeck(host, observation, side, options = {}) {
  const renderVersion = (deckRenderVersions.get(host) || 0) + 1;
  deckRenderVersions.set(host, renderVersion);
  const plan = deckPlanFromObservation(observation);
  host.dataset.side = side;
  const deck = el('div', 'deck');
  deck.dataset.state = options.state || 'available';
  if (!plan || (!plan.slots.length && !plan.switches.length)) {
    deck.appendChild(el('div', 'deck-waiting', options.idleText || 'Waiting for the next decision…'));
    host.replaceChildren(deck);
    return;
  }
  deck.appendChild(el(
    'div',
    `deck-state ${options.state || 'available'}`,
    options.stateLabel || `${side.toUpperCase()} available actions · model thinking`
  ));
  const moveNames = plan.slots.flatMap(slot => slot.moves.map(move => move.name));
  const speciesNames = [
    ...plan.slots.map(slot => slot.mon?.species || slot.mon?.name),
    ...plan.switches.map(entry => entry.mon?.species || entry.pokemon),
    ...(observation.opponent?.activePokemon || []).map(mon => mon?.species || mon?.name),
  ];
  await ensureDexCards(moveNames, speciesNames);
  if (deckRenderVersions.get(host) !== renderVersion) return false;

  const opponentActive = observation.opponent?.activePokemon || [];
  if (plan.forceSwitch || !plan.slots.length) {
    deck.appendChild(el('div', 'deck-banner', 'Choose a replacement'));
  }
  const slotsRow = el('div', 'deck-slots');
  for (const slot of plan.slots) {
    const column = el('div', 'deck-slot');
    const head = buildDeckMonHeader(slot.mon, `Slot ${slot.activeSlot}`);
    if (plan.hasTera && slot.moves.some(move => move.canTera)) {
      const tera = el('button', 'deck-tera');
      tera.type = 'button';
      tera.dataset.pressTera = String(slot.activeSlot);
      tera.textContent = `⭐ Tera ${slot.mon?.teraType || ''}`.trim();
      head.appendChild(tera);
    }
    column.appendChild(head);
    const grid = el('div', 'deck-moves');
    for (const move of slot.moves) grid.appendChild(buildDeckMoveButton(slot, move, opponentActive));
    column.appendChild(grid);
    slotsRow.appendChild(column);
  }
  if (plan.slots.length) deck.appendChild(slotsRow);
  if (plan.switches.length) {
    const bench = el('div', 'deck-bench');
    for (const entry of plan.switches) {
      const button = el('button', 'deck-switch');
      button.type = 'button';
      button.dataset.pressSwitch = String(entry.slot);
      const img = document.createElement('img');
      img.className = 'deck-sprite small';
      img.alt = '';
      img.src = spriteUrl(entry.mon?.species || entry.pokemon);
      img.addEventListener('error', () => img.classList.add('hidden'));
      button.appendChild(img);
      const info = el('span', 'deck-switch-info');
      info.appendChild(el('b', '', entry.mon?.name || entry.pokemon || `#${entry.slot}`));
      const hp = deckHpParts(entry.mon?.condition || entry.condition || '');
      const bar = el('span', `mon-hp${hp.fainted ? '' : hp.pct <= 25 ? ' low' : hp.pct <= 55 ? ' mid' : ''}`);
      const fill = el('i');
      fill.style.width = `${hp.fainted ? 0 : hp.pct}%`;
      bar.appendChild(fill);
      info.appendChild(bar);
      button.appendChild(info);
      bench.appendChild(button);
    }
    deck.appendChild(bench);
  }
  if (deckRenderVersions.get(host) !== renderVersion) return false;
  host.replaceChildren(deck);
  return true;
}

/* ---- deck press animation: the model's cursor presses our buttons ---- */

function deckCursor(host) {
  const deck = host.querySelector('.deck');
  if (!deck) return null;
  let cursor = deck.querySelector('.deck-cursor');
  if (!cursor) {
    cursor = el('div', 'deck-cursor');
    cursor.innerHTML =
      '<svg width="22" height="30" viewBox="0 0 22 30" xmlns="http://www.w3.org/2000/svg">' +
      '<path d="M2 1 L2 24 L8 18.5 L12 28 L16 26.2 L12.2 17 L20 16.5 Z" fill="#fff" stroke="#1c2b4a" stroke-width="1.6"/></svg>';
    deck.appendChild(cursor);
  }
  return cursor;
}

async function deckPress(host, button) {
  if (!button) return false;
  const cursor = deckCursor(host);
  if (!cursor) return false;
  const deckRect = host.querySelector('.deck')?.getBoundingClientRect();
  const rect = button.getBoundingClientRect();
  if (!deckRect || !rect.width) return false;
  const scale = deckRect.width / 640;
  const x = (rect.left - deckRect.left + rect.width * 0.55) / scale;
  const y = (rect.top - deckRect.top + rect.height * 0.6) / scale;
  cursor.style.opacity = '1';
  cursor.style.transform = `translate(${x}px, ${y}px)`;
  await sleep(340);
  button.classList.add('deck-pressing');
  const ripple = el('span', 'deck-ripple');
  ripple.style.left = `${x}px`;
  ripple.style.top = `${y}px`;
  host.querySelector('.deck')?.appendChild(ripple);
  setTimeout(() => ripple.remove(), 600);
  await sleep(180);
  button.classList.remove('deck-pressing');
  button.classList.add('deck-chosen');
  await sleep(110);
  return true;
}

async function animateDeckChoice(host, choice) {
  const steps = String(choice || '').split(',').map(part => part.trim()).filter(Boolean);
  for (const [index, step] of steps.entries()) {
    const tokens = step.split(/\s+/);
    const activeSlot = index + 1;
    if (tokens[0] === 'move') {
      const numbers = tokens.slice(1).filter(token => /^-?\d+$/.test(token)).map(Number);
      const moveSlot = numbers[0];
      const target = numbers.length > 1 ? numbers[1] : null;
      if (step.includes('terastallize')) {
        await deckPress(host, host.querySelector(`[data-press-tera="${activeSlot}"]`));
      }
      const moveButton = host.querySelector(`[data-press-move="${activeSlot}:${moveSlot}"]`);
      await deckPress(host, moveButton);
      if (target !== null && moveButton) {
        // Aim: the target flyout opens inside this move's card.
        const flyout = moveButton.querySelector('.deck-move-targets');
        flyout?.classList.add('open');
        await sleep(320);
        await deckPress(host, moveButton.querySelector(`[data-press-target="${activeSlot}:${moveSlot}:${target}"]`));
        await sleep(240);
        flyout?.classList.remove('open');
      }
    } else if (tokens[0] === 'switch') {
      await deckPress(host, host.querySelector(`[data-press-switch="${tokens[1]}"]`));
    }
    await sleep(120);
  }
  const cursor = host.querySelector('.deck-cursor');
  if (cursor) cursor.style.opacity = '0';
}

/* ---------------- viewport scaling (battle field only) ---------------- */

const scaledViewports = new Set();

function registerViewport(viewport) {
  scaledViewports.add(viewport);
  scaleViewport(viewport);
}

function scaleViewport(viewport) {
  if (!viewport.isConnected || !viewport.offsetParent) return;
  const mobileStage = window.innerWidth <= MOBILE_STAGE_BREAKPOINT;
  document.body.classList.toggle('mobile-stage', mobileStage);
  document.body.dataset.mobileFocus = mobileStage ? mobileFocus : 'all';
  if (mobileStage) {
    // Narrow screens zoom one panel of the client at a time (P1 mind,
    // battle, P2 mind) — the focus switch slides between them.
    const focusWidth = mobileFocus === 'battle' ? CLIENT_BATTLE_WIDTH : CLIENT_MIND_WIDTH;
    const focusOffset = mobileFocus === 'p1' ? 0 : mobileFocus === 'p2' ? 950 : CLIENT_MIND_WIDTH;
    const availableWidth = Math.max(280, Math.min(viewport.clientWidth || window.innerWidth, window.innerWidth) - 8);
    const availableHeight = Math.max(360, window.innerHeight - 80);
    const scale = Math.min(availableWidth / focusWidth, availableHeight / CLIENT_BASE_HEIGHT);
    viewport.style.setProperty('--client-scale', String(scale));
    viewport.style.setProperty('--client-shift', `${-focusOffset}px`);
    viewport.style.height = `${Math.ceil(CLIENT_BASE_HEIGHT * scale)}px`;
    return;
  }
  viewport.style.width = '';
  viewport.style.setProperty('--client-shift', '0px');
  const width = viewport.clientWidth || CLIENT_BASE_WIDTH;
  const scale = Math.max(0.28, Math.min(1, width / CLIENT_BASE_WIDTH));
  viewport.style.setProperty('--client-scale', String(scale));
  viewport.style.height = `${Math.ceil(CLIENT_BASE_HEIGHT * scale)}px`;
}

function setMobileFocus(focus) {
  mobileFocus = ['p1', 'battle', 'p2'].includes(focus) ? focus : 'battle';
  localStorage.setItem(MOBILE_FOCUS_KEY, mobileFocus);
  for (const button of document.querySelectorAll('[data-mobile-focus]')) {
    button.setAttribute('aria-pressed', String(button.dataset.mobileFocus === mobileFocus));
  }
  scaleAllViewports();
}

for (const button of document.querySelectorAll('[data-mobile-focus]')) {
  button.addEventListener('click', () => setMobileFocus(button.dataset.mobileFocus));
}
setMobileFocus(mobileFocus);

function scaleAllViewports() {
  for (const viewport of scaledViewports) scaleViewport(viewport);
}

const viewportObserver = new ResizeObserver(scaleAllViewports);
window.addEventListener('resize', scaleAllViewports);

{
  const viewport = $('live-viewport-battle');
  registerViewport(viewport);
  viewportObserver.observe(viewport);
}

/* ---------------- global frame message bus ---------------- */

window.addEventListener('message', event => {
  const message = event.data;
  if (!message || message.scope !== 'showdown-arena') return;
  const liveKind = liveFrameKind(event.source);
  if (liveKind) {
    if (message.type === 'sd-ready') {
      live.frameReady[liveKind] = true;
      applySound();
      // The freshly booted client shows placeholder minds; hand it the
      // latest thoughts and nameplates.
      flushMinds('live');
      void pumpPressQueue();
    }
    if (message.type === 'sd-request') {
      live.pending[liveKind] = Boolean(message.actionable);
      liveIdleView();
      // A P1 wait-request unblocks any queued P2 press.
      void pumpPressQueue();
    }
    if (message.type === 'sd-controls-top') {
      // Measured seam between the battle field and the controls region.
      $('live-deck').style.setProperty('--deck-top', `${message.top}px`);
    }
    if (message.type === 'sd-mind-peek') toggleMindPeek();
    if (message.type === 'sd-choice-done') {
      // Only the press we are actually waiting on may advance the queue;
      // stale done-signals from timed-out presses must not desync it.
      const waiter = live.choiceWaiters[liveKind];
      if (waiter && waiter.choice === message.choice) waiter.resolve();
    }
  }
});

/* ---------------- guided pipeline ---------------- */

// The setup card is a walk-through: (1) key, (2) models, (3) battle. Steps 2
// and 3 stay dormant until the key validates, then light up.
let keyValid = false;
const HAS_BATTLED_KEY = 'arena-has-battled';

function updatePipeline(options = {}) {
  for (const id of ['step-models', 'step-start']) {
    const step = $(id);
    const wasLocked = step.classList.contains('locked');
    step.classList.toggle('locked', !keyValid);
    if (options.animate && wasLocked && keyValid) {
      step.classList.remove('just-unlocked');
      void step.offsetWidth; // restart the energize animation
      step.classList.add('just-unlocked');
    }
  }
}

// A fresh key deserves real opponents: upgrade untouched stand-in defaults to
// two proven presets so step 3 is one click away.
function suggestRealModels() {
  if ($('setup-p1').value.trim() === 'standin') $('setup-p1').value = AGENT_PRESETS[1];
  if ($('setup-p2').value.trim() === 'standin') $('setup-p2').value = AGENT_PRESETS[2];
  persistSpecs();
  for (const prefix of PICKER_PREFIXES) {
    for (const player of ROLES) syncPickerFromSpec(prefix, player);
  }
}

/* ---------------- bring-your-own-key ---------------- */

// The visitor's OpenRouter key lives in this browser's localStorage only.
// Validation goes through the server's proxy to OpenRouter's free auth
// endpoint (no inference is billed); matches carry the key per-request and
// the server holds it in memory only.
const KEY_STORAGE = 'arena-openrouter-key';
let keyValidationVersion = 0;
let keyValidationPending = false;
let creditRetryAfterKey = false;

function storedKey() {
  return localStorage.getItem(KEY_STORAGE) || '';
}

function renderKeyPanel(state, facts = {}) {
  const entry = $('key-entry');
  const status = $('key-status');
  if (state === 'valid') {
    entry.classList.add('hidden');
    status.classList.remove('hidden', 'key-error');
    status.replaceChildren();
    status.appendChild(el('span', 'key-ball', '🔑'));
    const factsEl = el('span', 'key-facts');
    const label = el('b', '', 'OpenRouter key valid');
    factsEl.appendChild(label);
    if (facts.balance != null) {
      factsEl.appendChild(el('span', 'key-balance', ` · $${facts.balance.toFixed(2)} credits`));
      creditTicker.balance = facts.balance;
    }
    status.appendChild(factsEl);
    const change = el('button', 'key-change', 'change / log out');
    change.type = 'button';
    change.addEventListener('click', () => {
      keyValidationVersion += 1;
      localStorage.removeItem(KEY_STORAGE);
      $('key-input').value = '';
      renderKeyPanel('entry');
    });
    status.appendChild(change);
    if (!keyValid) {
      keyValid = true;
      suggestRealModels();
      updatePipeline({animate: true});
      renderLiveRun();
    }
    renderCreditTicker();
    if (creditRetryAfterKey && live?.run?.creditPause) {
      creditRetryAfterKey = false;
      closeKeyModal();
      void retryCreditPause();
    }
    return;
  }
  keyValid = false;
  updatePipeline();
  renderCreditTicker();
  if (state === 'invalid') {
    entry.classList.remove('hidden');
    status.classList.remove('hidden');
    status.classList.add('key-error');
    status.replaceChildren();
    status.appendChild(el('span', 'key-ball', '✗'));
    const factsEl = el('span', 'key-facts');
    factsEl.appendChild(el('b', '', facts.error || 'That key didn’t validate'));
    status.appendChild(factsEl);
    if (storedKey()) {
      const logout = el('button', 'key-change', 'log out saved key');
      logout.type = 'button';
      logout.addEventListener('click', () => {
        keyValidationVersion += 1;
        localStorage.removeItem(KEY_STORAGE);
        $('key-input').value = '';
        renderKeyPanel('entry');
      });
      status.appendChild(logout);
    }
    entry.classList.remove('shake');
    void entry.offsetWidth; // restart the animation
    entry.classList.add('shake');
    return;
  }
  // entry state
  entry.classList.remove('hidden');
  status.classList.add('hidden');
}

const TESTING_VERBS = ['testing key…', 'contacting OpenRouter…', 'checking credits…'];

async function testAndStoreKey() {
  if (keyValidationPending) return;
  const input = $('key-input');
  const button = $('key-enter');
  const key = input.value.trim();
  if (!key) {
    renderKeyPanel('invalid', {error: 'Paste a key first'});
    return;
  }
  const validationVersion = ++keyValidationVersion;
  keyValidationPending = true;
  button.classList.add('testing');
  button.disabled = true;
  input.disabled = true;
  let verbIndex = 0;
  button.textContent = TESTING_VERBS[0];
  const verbs = setInterval(() => {
    verbIndex = (verbIndex + 1) % TESTING_VERBS.length;
    button.textContent = TESTING_VERBS[verbIndex];
  }, 700);
  const startedAt = Date.now();
  let result;
  try {
    const response = await fetch('/api/key/validate', {
      method: 'POST',
      headers: {'content-type': 'application/json'},
      body: JSON.stringify({openrouterKey: key}),
    });
    result = await response.json();
  } catch {
    result = {ok: false, error: 'Could not reach the server'};
  }
  // let the little ritual land even when the API is instant
  await sleep(Math.max(0, 1400 - (Date.now() - startedAt)));
  keyValidationPending = false;
  clearInterval(verbs);
  button.classList.remove('testing');
  button.disabled = false;
  input.disabled = false;
  button.textContent = 'Enter';
  if (validationVersion !== keyValidationVersion) return;
  if (result.ok) {
    localStorage.setItem(KEY_STORAGE, key);
    renderKeyPanel('valid', result);
  } else {
    renderKeyPanel('invalid', result);
  }
}

$('key-enter').addEventListener('click', () => void testAndStoreKey());
$('key-input').addEventListener('keydown', event => {
  if (event.key === 'Enter') {
    event.preventDefault();
    void testAndStoreKey();
  }
});

async function restoreKeyPanel() {
  const key = storedKey();
  if (!key) {
    renderKeyPanel('entry');
    return;
  }
  const validationVersion = ++keyValidationVersion;
  // Re-validate silently so the chip shows a current balance.
  try {
    const response = await fetch('/api/key/validate', {
      method: 'POST',
      headers: {'content-type': 'application/json'},
      body: JSON.stringify({openrouterKey: key}),
    });
    const result = await response.json();
    if (validationVersion !== keyValidationVersion) return;
    if (result.ok) {
      renderKeyPanel('valid', result);
      return;
    }
    renderKeyPanel('invalid', {error: 'Saved OpenRouter key did not validate — change it or log out'});
  } catch {
    if (validationVersion !== keyValidationVersion) return;
    renderKeyPanel('valid', {}); // offline: trust the stored key for now
  }
}

/* ---------------- credits ticker ---------------- */

// Permanent footer readout of the visitor's remaining OpenRouter balance.
// Refreshed from the key panel's validation facts and re-polled as turns
// burn credits; hard-throttled so fast games never spam the provider.
const creditTicker = {balance: null, lastFetch: 0, marker: '', inFlight: false};

function renderCreditTicker() {
  const el = $('credit-ticker');
  if (!el) return;
  if (creditTicker.balance == null || !storedKey() || !keyValid) {
    el.classList.add('hidden');
    return;
  }
  el.classList.remove('hidden');
  el.classList.toggle('credit-low', creditTicker.balance < 1);
  el.textContent = `openrouter $${creditTicker.balance.toFixed(2)}`;
  el.title = `Your remaining OpenRouter credits: $${creditTicker.balance.toFixed(4)}`;
}

async function refreshCredits() {
  if (!storedKey() || !keyValid) {
    renderCreditTicker();
    return;
  }
  const now = Date.now();
  if (creditTicker.inFlight || now - creditTicker.lastFetch < 8000) return;
  creditTicker.inFlight = true;
  creditTicker.lastFetch = now;
  try {
    const response = await fetch('/api/credits', {
      method: 'POST',
      headers: {'content-type': 'application/json'},
      body: JSON.stringify({openrouterKey: storedKey()}),
    });
    const payload = await response.json();
    if (payload.ok && payload.balance != null) creditTicker.balance = payload.balance;
  } catch {
    // keep the last known balance; the next turn retries
  }
  creditTicker.inFlight = false;
  renderCreditTicker();
}

function renderCreditPause(run) {
  const modal = $('credit-modal');
  const pause = run?.creditPause;
  modal.classList.toggle('hidden', !pause || keyModalOpen());
  if (!pause) return;
  const roles = (pause.roles || []).map(role => role === 'p2' ? 'Player 2' : 'Player 1');
  const who = roles.length ? roles.join(' and ') : 'A model';
  $('credit-modal-message').textContent = `${who} ran out of credits${pause.turn ? ` on turn ${pause.turn}` : ''}. Add credits or choose how this match should continue.`;
}

function setCreditActionsDisabled(disabled) {
  for (const id of ['credit-retry', 'credit-change-key', 'credit-fallback', 'credit-end']) {
    $(id).disabled = disabled;
  }
}

async function retryCreditPause() {
  if (!storedKey() || !keyValid) {
    creditRetryAfterKey = true;
    $('credit-modal').classList.add('hidden');
    openKeyModal();
    return;
  }
  setCreditActionsDisabled(true);
  const ok = await liveCommand({command: 'credits-retry', openrouterKey: storedKey()});
  setCreditActionsDisabled(false);
  if (ok) void refreshCredits();
}

$('credit-retry').addEventListener('click', () => void retryCreditPause());
$('credit-change-key').addEventListener('click', () => {
  creditRetryAfterKey = true;
  keyValidationVersion += 1;
  localStorage.removeItem(KEY_STORAGE);
  keyValid = false;
  renderKeyPanel('entry');
  $('credit-modal').classList.add('hidden');
  openKeyModal();
});
$('credit-fallback').addEventListener('click', async () => {
  setCreditActionsDisabled(true);
  await liveCommand({command: 'credits-fallback'});
  setCreditActionsDisabled(false);
});
$('credit-end').addEventListener('click', async () => {
  setCreditActionsDisabled(true);
  await liveCommand({command: 'stop'});
  setCreditActionsDisabled(false);
});

/* ---------------- battle sound ---------------- */

// Sound comes from the base battle frame's native Showdown client. Default
// muted; the preference persists and survives frame reloads.
const SOUND_PREF_KEY = 'arena-sound-on';
let soundOn = localStorage.getItem(SOUND_PREF_KEY) === '1';

function soundTargetFrames() {
  return [$('live-frame-battle')].filter(Boolean);
}

function applySound() {
  for (const frame of soundTargetFrames()) {
    frame.contentWindow?.postMessage({scope: 'showdown-arena', type: 'sd-sound', muted: !soundOn}, '*');
  }
  for (const button of document.querySelectorAll('[data-sound-toggle]')) {
    button.textContent = soundOn ? '\u{1F50A}' : '\u{1F507}';
    button.classList.toggle('on', soundOn);
    button.setAttribute('aria-pressed', String(soundOn));
  }
}

function toggleSound() {
  soundOn = !soundOn;
  localStorage.setItem(SOUND_PREF_KEY, soundOn ? '1' : '0');
  applySound();
}

for (const button of document.querySelectorAll('[data-sound-toggle]')) {
  button.addEventListener('click', toggleSound);
}

/* ---------------- hard pause: freeze the whole show instantly ---------------- */

// Pause is a promise to the reader: hit it and NOTHING moves — the field
// stops animating, the minds stop repainting, queued presses stay queued.
// The server pause (stop asking models) follows over HTTP; this local freeze
// is immediate and doesn't wait for the round-trip.
function setShowPaused(on) {
  on = Boolean(on);
  if (live.showPaused === on) return;
  live.showPaused = on;
  $('live-frame-battle')?.contentWindow?.postMessage(
    {scope: 'showdown-arena', type: 'sd-pause', paused: on}, '*'
  );
  if (!on) {
    // Anything that changed while frozen replays now, reveals included —
    // re-stamp the reveal clocks so presses wait for the replayed show.
    for (const role of ROLES) {
      if (live.mindReveal[role]) live.mindReveal[role].at = Date.now();
    }
    flushMinds('live');
    void pumpPressQueue();
  }
}

function togglePause() {
  if (!isActiveRun(live.run)) return;
  const pausing = !live.showPaused;
  setShowPaused(pausing);
  live.pauseCommandAt = Date.now();
  void liveCommand({command: pausing ? 'pause' : 'resume'});
}

/* ---------------- key modal: manage the API key after onboarding ---------------- */

// The one key panel has two homes: step 1 of the one-time setup card, and
// this small modal (🔑 in the client header) for the rest of the session.
// The DOM node moves between them so all its listeners and state ride along.
let keyPanelHome = null;

function keyModalOpen() {
  return !$('key-modal').classList.contains('hidden');
}

function openKeyModal() {
  if (!keyPanelHome) keyPanelHome = $('key-panel').parentElement;
  $('key-modal-body').appendChild($('key-panel'));
  $('key-modal').classList.remove('hidden');
  $('key-button').classList.add('on');
}

function closeKeyModal() {
  if (!keyModalOpen()) return;
  keyPanelHome?.appendChild($('key-panel'));
  $('key-modal').classList.add('hidden');
  $('key-button').classList.remove('on');
  renderCreditPause(live.run);
}

$('key-button').addEventListener('click', () => (keyModalOpen() ? closeKeyModal() : openKeyModal()));
$('key-modal-close').addEventListener('click', closeKeyModal);
$('key-modal').addEventListener('click', event => {
  if (event.target === $('key-modal')) closeKeyModal();
});

/* ---------------- plate pickers: the permanent model controls ---------------- */

// Clicking a model plate opens its in-card picker. Mid-game picks queue: the
// plate shows "next: …" and the new model plays when this game ends (🔀 or
// stop → next start applies it immediately).
function togglePlatePicker(player, force) {
  const plate = $(`live-plate-${player}`);
  const open = force !== undefined ? force : !plate.classList.contains('open');
  plate.classList.toggle('open', open);
  plate.querySelector('.plate-picker').hidden = !open;
}

for (const player of ROLES) {
  const plate = $(`live-plate-${player}`);
  plate.addEventListener('click', event => {
    // Clicks inside the picker's selects operate the selects, not the toggle.
    if (event.target.closest('.plate-picker')) return;
    togglePlatePicker(player);
  });
  plate.addEventListener('keydown', event => {
    if ((event.key === 'Enter' || event.key === ' ') && event.target === plate) {
      event.preventDefault();
      togglePlatePicker(player);
    }
  });
}

window.addEventListener('keydown', event => {
  if (event.key === 'Escape') {
    if (keyModalOpen()) {
      closeKeyModal();
      return;
    }
    for (const player of ROLES) togglePlatePicker(player, false);
    return;
  }
  if (/INPUT|TEXTAREA|SELECT/.test(event.target?.tagName || '')) return;
  if (event.key === 'm' || event.key === 'M') toggleSound();
  if (event.key === 'r' || event.key === 'R') void remixBattle();
  if (event.key === 'p' || event.key === 'P') togglePause();
});

/* ================================================================
   LIVE
   ================================================================ */

const live = {
  run: null,
  deckSockets: {p1: null, p2: null},
  lastCallKey: {p1: '', p2: ''},
  pending: {p1: false, p2: false},
  animating: null,
  pressQueue: [],
  dispatching: false,
  choiceWaiters: {p1: null, p2: null},
  p1AnsweredTurn: 0,
  // p2 has no frame anymore: its presses land on the decision deck.
  frameReady: {p1: false, p2: true},
  // Per-role request observations from the role sockets, so the deck can
  // render exactly the request each queued press answered (keyed by rqid).
  requests: {p1: new Map(), p2: new Map()},
  latestRequest: {p1: null, p2: null},
  deckShown: '',
  remixSquelch: null,
  starting: false,
  // Per-role record of the mind reveal in progress: the press animation
  // waits until the analysis has been presented and the choice revealed.
  mindReveal: {p1: null, p2: null},
  // The hard freeze: while true, nothing on the stage moves or repaints.
  showPaused: false,
  pauseCommandAt: 0,
  // Interstitial banner bookkeeping for multi-game runs.
  gameBannerId: '',
  gameBannerTimer: 0,
  log: [],
};
window.__arenaLive = live;
let liveStateEpoch = 0;
let livePollInFlight = false;
let liveCommandPending = 0;

function liveFrameKind(source) {
  if (source && source === $('live-frame-battle')?.contentWindow) return 'p1';
  return null;
}

function setLiveControlsOwner(side) {
  setControlsOwner($('live-deck'), $('live-controls-owner'), side);
}

function rememberLiveRequest(role, observation) {
  if (!observation) return;
  live.latestRequest[role] = observation;
  const rqid = observation.requestId;
  const actionable = !observation.waiting && !observation.ended && (observation.legalActions || []).length > 0;
  // Keyed snapshots exist so the deck and mind chip can name the actions a
  // choice answered — only the ACTIONABLE broadcast carries those names. A
  // post-choice rebroadcast of the same rqid arrives consumed (empty
  // legalActions) and must not wipe the stored one.
  if (rqid != null && actionable) {
    live.requests[role].set(Number(rqid), observation);
    if (live.requests[role].size > 10) {
      live.requests[role].delete(live.requests[role].keys().next().value);
    }
  }
  if (actionable && !live.pending[role]) {
    // A fresh actionable request: this player's model is now thinking.
    sendMindMeta('live', role, {chip: 'thinking…', fresh: false});
  }
  live.pending[role] = actionable;
  liveIdleView();
  void pumpPressQueue();
}

// With no press animation in flight, show whichever player still owes a
// decision on the deck. In human mode the deck belongs to the player alone:
// it renders only YOUR requests as live controls, never the AI's private
// choice space.
function liveIdleView() {
  if (live.animating || live.showPaused) return;
  const humanRole = activeHumanRole();
  if (humanRole) {
    setLiveControlsOwner(humanRole);
    const observation = live.latestRequest[humanRole];
    const actionable = live.pending[humanRole];
    const key = `human|${observation?.requestId ?? 'none'}|${actionable}`;
    if (key !== live.deckShown) {
      live.deckShown = key;
      if (actionable && observation) {
        void renderHumanDeck(observation);
      } else {
        humanPlay.armed = false;
        void renderDeck($('live-deck'), null, humanRole, {idleText: 'Waiting — the opponent is choosing…'});
      }
    }
    return;
  }
  $('live-deck').classList.remove('human-live');
  const side = live.pending.p2 && !live.pending.p1 ? 'p2' : 'p1';
  setLiveControlsOwner(side);
  const observation = live.latestRequest[side];
  const key = `${side}|${observation?.requestId ?? 'none'}`;
  if (key !== live.deckShown) {
    live.deckShown = key;
    const phase = live.run?.roleStates?.[side]?.phase || 'thinking';
    void renderDeck($('live-deck'), observation, side, {
      state: 'available',
      stateLabel: `${side.toUpperCase()} available actions · ${phase === 'thinking' ? 'model thinking' : phase}`,
    });
  }
}

// Each role socket delivers that player's private request observations —
// the same structured choice space the model sees — to drive the deck.
function connectDeckSocket(role) {
  const socket = new WebSocket(`${wsProtocol}//${location.host}/ws?role=${role}&battleId=${encodeURIComponent(BATTLE_ID)}&wait=1`);
  live.deckSockets[role] = socket;
  socket.addEventListener('message', event => {
    let message;
    try {
      message = JSON.parse(event.data);
    } catch {
      return;
    }
    if (message.type === 'state' && message.state?.extracted) {
      rememberLiveRequest(role, message.state.extracted);
    }
  });
  socket.addEventListener('close', () => setTimeout(() => connectDeckSocket(role), 1200));
}

// Press dispatcher: presses visualize in turn order, Player 1 before Player 2
// within a turn. P1's press dispatches as soon as it answers; a P2 answer that
// arrives first waits only for P1's answer to that same turn. Frames stay
// frozen on their chosen buttons while queued, so if the models play faster
// than the presses animate, the whole stage lags gracefully but stays exact.
function nextPressIndex() {
  if (!live.pressQueue.length) return -1;
  let best = -1;
  for (let i = 0; i < live.pressQueue.length; i++) {
    const press = live.pressQueue[i];
    if (best < 0) {
      best = i;
      continue;
    }
    const current = live.pressQueue[best];
    if (press.turn < current.turn || (press.turn === current.turn && press.role === 'p1' && current.role === 'p2')) {
      best = i;
    }
  }
  const press = live.pressQueue[best];
  if (!live.frameReady[press.role]) return -1;
  if (press.role === 'p2' && live.pending.p1 && live.p1AnsweredTurn < (press.turn || 0)) return -1;
  return best;
}

async function pumpPressQueue() {
  if (live.dispatching) return;
  live.dispatching = true;
  try {
    for (;;) {
      // A paused run pauses the SHOW: presses stay queued, the frozen frame
      // stops feeding protocol, the field halts. Resume pumps again.
      if (live.showPaused || (isActiveRun(live.run) && live.run.paused)) break;
      if (activeHumanRole()) {
        // Human mode never animates presses; anything queued in a race is stale.
        live.pressQueue.length = 0;
        break;
      }
      const index = nextPressIndex();
      if (index < 0) break;
      const [press] = live.pressQueue.splice(index, 1);
      // If the models are deciding faster than presses can animate (stand-in
      // speeds), fast-forward the backlog instead of falling minutes behind:
      // deep-queued presses apply instantly, recent ones animate fully.
      const instant = live.pressQueue.length > 3;
      pressLog(`dispatch${instant ? ' (instant)' : ''} ${press.role} T${press.turn} ${press.choice}`);
      live.animating = press.role;
      if (!instant) {
        // Show the request this choice answered as AVAILABLE actions while
        // the Model Mind presents its analysis; only after the reveal does
        // the choice land in the chip and the deck flip to committed.
        setLiveControlsOwner(press.role);
        const observation = (press.rqid != null && live.requests[press.role].get(Number(press.rqid))) ||
          live.latestRequest[press.role];
        live.deckShown = `${press.role}|${observation?.requestId ?? 'none'}`;
        await renderDeck($('live-deck'), observation, press.role, {
          state: 'available',
          stateLabel: `${press.role.toUpperCase()} available actions · presenting analysis`,
        });
        await waitForMindReveal(press);
        // Status, not protocol: the press itself shows WHAT was chosen.
        sendMindMeta('live', press.role, {chip: 'locked in', fresh: true});
        await renderDeck($('live-deck'), observation, press.role, {
          state: 'committed',
          stateLabel: `${press.role.toUpperCase()} decision locked`,
        });
        await animateDeckChoice($('live-deck'), press.choice);
      }
      if (press.role === 'p1') {
        // The base client froze awaiting this press; apply it instantly so
        // its internal request state stays exact and the field plays on.
        $('live-frame-battle')?.contentWindow?.postMessage(
          {scope: 'showdown-arena', type: 'sd-choice', choice: press.choice, rqid: press.rqid, instant: true},
          '*'
        );
        await waitForLiveChoiceDone(press.role, press.choice);
      }
      // Punctuation: a beat of rest after each press so turns read as
      // phrases, not a queue draining.
      if (!instant) await sleep(650);
      live.animating = null;
    }
  } finally {
    live.dispatching = false;
  }
  liveIdleView();
}

function pressLog(text) {
  live.log.push(`${new Date().toISOString().slice(14, 23)} ${text} | q=[${live.pressQueue.map(p => `${p.role}T${p.turn}`).join(',')}] pendP1=${live.pending.p1} ansT=${live.p1AnsweredTurn}`);
  if (live.log.length > 60) live.log.shift();
}

// Hold the press until the Model Mind has presented this exact decision:
// the poll delivers the analysis up to a second after the choice event, and
// the reveal itself takes a beat per question card. Never stalls the show —
// if the analysis hasn't arrived within the cap, the press proceeds.
async function waitForMindReveal(press) {
  const deadline = Date.now() + 6000;
  for (;;) {
    const reveal = live.mindReveal[press.role];
    const matches = reveal && reveal.choice === press.choice &&
      (reveal.turn == null || !press.turn || reveal.turn === press.turn);
    if (matches) {
      const remaining = reveal.at + reveal.ms - Date.now();
      if (remaining > 0) await sleep(Math.min(remaining, 3000));
      return;
    }
    if (Date.now() >= deadline) return;
    await sleep(140);
  }
}

function waitForLiveChoiceDone(role, choice) {
  return Promise.race([
    new Promise(resolve => {
      live.choiceWaiters[role] = {choice, resolve};
    }),
    sleep(20000),
  ]).finally(() => {
    live.choiceWaiters[role] = null;
  });
}

// The base client and the P2 controls overlay self-connect over their own
// websockets and animate their own presses on choice events; here we watch
// the spectator channel for the turn counter, chip flashes, control-owner
// switches, and battle resets.
function connectSpectatorSocket() {
  const socket = new WebSocket(`${wsProtocol}//${location.host}/ws?role=spectator&battleId=${encodeURIComponent(BATTLE_ID)}&wait=1`);
  socket.addEventListener('message', event => {
    let message;
    try {
      message = JSON.parse(event.data);
    } catch {
      return;
    }
    if (message.type === 'state' && message.state && !live.showPaused) {
      setTurnCounter($('live-turn'), message.state.turn || '–');
    }
    if (message.type === 'choice' && ROLES.includes(message.role)) {
      live.pending[message.role] = false;
      if (message.role === 'p1') {
        live.p1AnsweredTurn = Math.max(live.p1AnsweredTurn, Number(message.turn) || 0);
      }
      if (activeHumanRole()) {
        // Human mode has no press theater: your click already WAS the press,
        // and the AI's presses would reveal its private choice space. Apply
        // P1 choices to the base client instantly so its request state stays
        // exact; the field animation itself shows what happened.
        if (message.role === 'p1') {
          $('live-frame-battle')?.contentWindow?.postMessage(
            {scope: 'showdown-arena', type: 'sd-choice', choice: message.choice, rqid: message.rqid ?? null, instant: true},
            '*'
          );
        } else {
          sendMindMeta('live', message.role, {chip: 'moved', fresh: false});
        }
        liveIdleView();
        return;
      }
      // The decision exists but is NOT revealed yet: the mind presents its
      // analysis first; the press gate flips the chip to the choice.
      sendMindMeta('live', message.role, {chip: 'presenting analysis…', fresh: false});
      live.pressQueue.push({
        role: message.role,
        choice: message.choice,
        rqid: message.rqid ?? null,
        turn: Number(message.turn) || 0,
      });
      pressLog(`queued ${message.role} T${message.turn} ${message.choice}`);
      void pumpPressQueue();
    }
    if (message.type === 'reset') resetLiveBattleState();
  });
  socket.addEventListener('close', () => setTimeout(connectSpectatorSocket, 1000));
}

// Wipe every trace of the previous battle from the deck, minds, and pending
// state. Runs synchronously before a new run starts AND when the server's
// reset broadcast arrives: deck requests and the spectator reset travel on
// different sockets with no ordering guarantee, so the new battle's first
// request must never land on a stage still holding the old battle's deck.
function resetLiveBattleState() {
  humanPlay.armed = false;
  live.pending = {p1: false, p2: false};
  live.animating = null;
  live.pressQueue.length = 0;
  live.p1AnsweredTurn = 0;
  live.frameReady = {p1: false, p2: true};
  live.requests.p1.clear();
  live.requests.p2.clear();
  live.latestRequest = {p1: null, p2: null};
  live.mindReveal = {p1: null, p2: null};
  setShowPaused(false);
  live.deckShown = '';
  live.choiceWaiters.p1?.resolve();
  live.choiceWaiters.p2?.resolve();
  setLiveControlsOwner('p1');
  void renderDeck($('live-deck'), null, 'p1', {idleText: 'New battle — waiting for the first decision…'});
  $('live-banner').classList.add('hidden');
  $('live-turn').textContent = '–';
  live.lastCallKey = {p1: '', p2: ''};
  for (const role of ROLES) {
    sendMind('live', role, null, {
      title: 'Model mind',
      placeholder: 'New battle — waiting for the first decision…',
    });
    sendMindMeta('live', role, {chip: 'waiting', fresh: false});
  }
}

function isActiveRun(run) {
  return Boolean(run && ['running', 'paused', 'stopping'].includes(run.status));
}

/* ---------------- series score (server-owned record) ---------------- */

// The server keeps one running record per exact matchup (P1 spec vs P2 spec)
// for this session. Every finished game rolls in — one-off starts and
// multi-game runs alike — so playing 1, then 5, then 1 more all lands in the
// same series until either model changes.
const seriesState = {key: '', data: null, fetchedAt: 0, fetching: ''};

function seriesPairKey(agentP1, agentP2) {
  return `${agentP1}|${agentP2}`;
}

function currentSeriesFor(agentP1, agentP2) {
  const key = seriesPairKey(agentP1, agentP2);
  const run = live.run;
  if (run?.series && seriesPairKey(run.agentP1, run.agentP2) === key) {
    seriesState.key = key;
    seriesState.data = run.series;
    seriesState.fetchedAt = Date.now();
    return run.series;
  }
  if (seriesState.key === key && Date.now() - seriesState.fetchedAt < 15000) return seriesState.data;
  void fetchSeries(agentP1, agentP2);
  return seriesState.key === key ? seriesState.data : null;
}

async function fetchSeries(agentP1, agentP2) {
  const key = seriesPairKey(agentP1, agentP2);
  if (seriesState.fetching === key) return;
  seriesState.fetching = key;
  try {
    const query = new URLSearchParams({session: SESSION_ID, agentP1, agentP2});
    const response = await fetch(`/api/series?${query}`);
    const payload = await response.json();
    seriesState.key = key;
    seriesState.data = payload.series || null;
    seriesState.fetchedAt = Date.now();
  } catch {
    // keep whatever we had; the next poll retries
  } finally {
    seriesState.fetching = '';
  }
}

function renderSeries(agentP1, agentP2) {
  const el = $('live-series');
  if (!agentP1 || !agentP2) {
    el.classList.add('hidden');
    return;
  }
  const series = currentSeriesFor(agentP1, agentP2);
  const totals = series?.totals;
  const show = Boolean(totals?.games);
  el.classList.toggle('hidden', !show);
  if (show) {
    el.textContent = `series ${totals.p1Wins}–${totals.p2Wins}${totals.draws ? ` · ${totals.draws} draw${totals.draws === 1 ? '' : 's'}` : ''}`;
    el.title = `${shortName(agentP1)} ${totals.p1Wins} — ${totals.p2Wins} ${shortName(agentP2)} over ${totals.games} game${totals.games === 1 ? '' : 's'}. Click to reset this record.`;
  }
}

// Clicking the score wipes the record for this exact matchup.
$('live-series').addEventListener('click', async () => {
  const agentP1 = $('setup-p1').value.trim() || 'standin';
  const agentP2 = $('setup-p2').value.trim() || 'standin';
  if (!confirm(`Reset the ${shortName(agentP1)} vs ${shortName(agentP2)} series record?`)) return;
  try {
    await fetch('/api/series', {
      method: 'POST',
      headers: {'content-type': 'application/json'},
      body: JSON.stringify({command: 'reset', sessionId: SESSION_ID, agentP1, agentP2}),
    });
  } catch {
    // the next poll re-fetches whatever the server holds
  }
  seriesState.key = '';
  seriesState.data = null;
  renderSeries(agentP1, agentP2);
});

/* ---------------- games-per-run picker ---------------- */

// How many games the next start plays back-to-back. Two homes share one
// persisted value: the one-time setup card gets a segmented row of one-click
// counts, the versus column keeps a compact select. The Start/Next buttons
// announce the batch ("Start 10-game run") so the choice is never invisible.
const GAME_COUNT_KEY = 'arena-game-count';
const GAME_COUNT_OPTIONS = [1, 3, 5, 10, 20, 50, 100];

function gameCountValue() {
  const stored = Number(localStorage.getItem(GAME_COUNT_KEY));
  return Number.isFinite(stored) && stored >= 1 ? Math.min(100, Math.floor(stored)) : 1;
}

function setGameCount(value) {
  localStorage.setItem(GAME_COUNT_KEY, String(Math.min(100, Math.max(1, Number(value) || 1))));
  syncGameCountControls();
}

function startMatchLabel() {
  const count = gameCountValue();
  return count > 1 ? `Start ${count}-game run` : 'Start match';
}

function nextGameLabel() {
  const count = gameCountValue();
  return count > 1 ? `▶ Next ${count} games` : '▶ Next game';
}

function syncGameCountControls() {
  const value = gameCountValue();
  for (const button of $('setup-games-seg').children) {
    button.setAttribute('aria-pressed', String(Number(button.dataset.games) === value));
  }
  const select = $('live-games');
  if (select.value !== String(value)) select.value = String(value);
  $('live-start').textContent = startMatchLabel();
  if (!live.starting) $('live-next').textContent = nextGameLabel();
}

for (const count of GAME_COUNT_OPTIONS) {
  const button = el('button', 'games-seg-btn', String(count));
  button.type = 'button';
  button.dataset.games = String(count);
  button.title = count > 1 ? `Play ${count} games back-to-back` : 'Play a single game';
  button.addEventListener('click', () => setGameCount(count));
  $('setup-games-seg').appendChild(button);
}
$('live-games').addEventListener('change', event => setGameCount(event.target.value));
syncGameCountControls();

/* ---------------- transcript copy ---------------- */

// Each finished game writes a plain-text transcript artifact; this copies the
// latest one for pasting into an AI for post-game analysis.
function latestTranscriptHref() {
  const run = live.run;
  return (run?.games || []).findLast?.(game => game.transcriptHref)?.transcriptHref || run?.transcriptHref || '';
}

$('live-transcript').addEventListener('click', async () => {
  const button = $('live-transcript');
  const href = latestTranscriptHref();
  if (!href) return;
  try {
    const response = await fetch(href);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    await copyText(await response.text());
    button.textContent = '✓ copied';
  } catch {
    // No clipboard access (permissions, unfocused tab): show the raw text
    // instead so it can still be copied by hand.
    window.open(href, '_blank', 'noopener');
    button.textContent = 'opened ↗';
  }
  setTimeout(() => { button.textContent = '⧉ transcript'; }, 1600);
});

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return;
  } catch {
    // Clipboard API needs focus + permission; fall back to the selection API.
  }
  const scratch = document.createElement('textarea');
  scratch.value = text;
  scratch.setAttribute('readonly', '');
  scratch.style.position = 'fixed';
  scratch.style.opacity = '0';
  document.body.appendChild(scratch);
  scratch.select();
  const copied = document.execCommand('copy');
  scratch.remove();
  if (!copied) throw new Error('copy rejected');
}

async function pollLiveRun() {
  if (livePollInFlight || liveCommandPending) return;
  livePollInFlight = true;
  const epoch = liveStateEpoch;
  try {
    const response = await fetch(`/api/run?session=${encodeURIComponent(SESSION_ID)}`);
    const payload = await response.json();
    if (epoch !== liveStateEpoch) return;
    live.run = payload.run || null;
    renderLiveRun();
    // Balance ticks along with the game: re-poll credits whenever a paid
    // run advances a turn, changes game, or ends (refreshCredits throttles).
    const run = live.run;
    if (run && `${run.agentP1} ${run.agentP2}`.includes('openrouter:')) {
      const marker = `${run.id}|${run.currentGame}|${run.currentTurn}|${run.status}`;
      if (creditTicker.marker !== marker) {
        creditTicker.marker = marker;
        void refreshCredits();
      }
    }
  } catch {
    // keep last known state
  } finally {
    livePollInFlight = false;
  }
}

function renderLiveRun() {
  const run = live.run;
  renderCreditPause(run);
  const active = isActiveRun(run);
  const status = run ? run.status : 'idle';
  const mode = run ? (run.allowFallback ? 'exhibition' : 'rated') : '';
  const gameTag = active && run.gameCount > 1 ? ` · game ${run.currentGame || 1}/${run.gameCount}` : '';
  setStatusPill(
    $('live-status'),
    run ? status : 'idle',
    run ? `${mode} · ${run.phase || status}${gameTag}` : 'idle'
  );
  document.title = run
    ? `${shortName(run.agentP1)} vs ${shortName(run.agentP2)} — Showdown LLM Arena`
    : 'Showdown LLM Arena';

  updatePipeline();
  $('live-start').disabled = active;
  $('live-demo').disabled = active;

  // Pause state: the local hard freeze is authoritative the moment the
  // button is pressed; the server's paused flag converges via commands. If
  // the server state changed elsewhere (another tab), follow it once our
  // own command has had time to settle.
  const serverPaused = Boolean(active && run.paused);
  if (serverPaused !== live.showPaused && Date.now() - live.pauseCommandAt > 4000) {
    setShowPaused(serverPaused);
  }
  const paused = live.showPaused;
  const theaterPause = $('theater-pause');
  theaterPause.disabled = !active;
  theaterPause.innerHTML = active && paused ? '&#9654;' : '&#10074;&#10074;';
  theaterPause.classList.toggle('on', Boolean(active && paused));
  $('theater-stop').disabled = !active;
  if (!paused && !run?.paused) void pumpPressQueue();

  $('live-pause').disabled = !active || paused;
  $('live-resume').disabled = !active || !paused;
  $('live-stop').disabled = !active;
  // The setup card is onboarding, shown exactly once: before the first
  // battle ever. After that the model plates are the permanent pickers and
  // the 🔑 header button manages the key.
  const battledBefore = Boolean(localStorage.getItem(HAS_BATTLED_KEY));
  // The battle console stays offstage for brand-new visitors: it enters only
  // once the arena is unlocked — a validated key, a battle in progress (the
  // demo), or a visitor who has battled before.
  const stageVisible = Boolean(run) || battledBefore || keyValid;
  const stage = $('live-stage');
  if (stage.classList.contains('hidden') === stageVisible) {
    stage.classList.toggle('hidden', !stageVisible);
    if (stageVisible) scaleAllViewports();
  }
  const nextButton = $('live-next');
  nextButton.classList.toggle('hidden', active || !battledBefore);
  nextButton.disabled = live.starting;
  nextButton.textContent = live.starting ? 'Starting…' : nextGameLabel();
  $('live-setup-card').classList.toggle('hidden', active || battledBefore);
  $('live-run-controls').classList.toggle('hidden', !active);
  $('live-transcript').classList.toggle('hidden', !latestTranscriptHref());
  $('mobile-focus-switch').classList.toggle('hidden', !run);
  // The matchup plates are permanent once the arena has seen a battle.
  $('live-matchup').classList.toggle('hidden', !run && !battledBefore);
  // Between games the versus column offers the next game directly.
  $('live-next').classList.toggle('hidden', active || !battledBefore);

  // Plates show the RUNNING models during a match; between matches they show
  // the queued picks (which is what 🔀 or the next start will play).
  const queuedP1 = $('setup-p1').value.trim() || 'standin';
  const queuedP2 = $('setup-p2').value.trim() || 'standin';
  const specP1 = active ? run.agentP1 : queuedP1;
  const specP2 = active ? run.agentP2 : queuedP2;
  renderPlate($('live-plate-p1'), specP1);
  renderPlate($('live-plate-p2'), specP2);
  // Mid-game queued change: the plate flags what plays next.
  for (const [player, queued, spec] of [['p1', queuedP1, specP1], ['p2', queuedP2, specP2]]) {
    const next = $(`live-plate-${player}`).querySelector('.plate-next');
    const queuedDiffers = active && queued !== String(spec || '');
    next.classList.toggle('hidden', !queuedDiffers);
    if (queuedDiffers) {
      const label = queuedName(queued);
      next.textContent = `next: ${label}`;
      next.title = `Queued for the next game: ${label}`;
    } else {
      next.removeAttribute('title');
    }
  }
  renderSeries(specP1, specP2);
  const humanRole = activeHumanRole();
  syncMindPeek(run);
  for (const [role, spec] of [['p1', specP1], ['p2', specP2]]) {
    const rolePhase = run?.roleStates?.[role]?.phase || (active ? 'preparing' : 'waiting');
    const meta = {who: shortName(spec)};
    if (['thinking', 'decision-ready', 'credits-exhausted', 'error'].includes(rolePhase)) {
      meta.chip = rolePhase === 'decision-ready' ? 'decision ready' :
        rolePhase === 'credits-exhausted' ? 'credits exhausted' : rolePhase;
      meta.fresh = rolePhase === 'decision-ready';
    } else if (run && !active) {
      // The game is over: give the chip a terminal state. Otherwise it keeps
      // whatever mid-turn value it last held ("presenting analysis…",
      // "thinking…"), which reads like the mind is still waiting for a turn
      // that will never come.
      meta.fresh = false;
      if (run.status === 'stopped') meta.chip = 'stopped';
      else if (run.status === 'error') meta.chip = 'error';
      else {
        const winnerSide = winningSideOf(run);
        meta.chip = winnerSide === role ? '🏆 winner' : winnerSide ? 'defeated' : 'game over';
      }
    } else if (!run) {
      meta.chip = 'waiting';
      meta.fresh = false;
    }
    if (humanRole === role && ['thinking', 'decision-ready'].includes(rolePhase)) {
      meta.chip = 'your move!';
      meta.fresh = true;
    }
    sendMindMeta('live', role, meta);
  }

  if (run?.currentTurn && !live.showPaused) setTurnCounter($('live-turn'), run.currentTurn);

  const note = $('live-note');
  if (run?.error) {
    note.textContent = run.error;
    note.classList.add('error');
  } else if (run && !run.validBenchmark && run.status === 'finished') {
    note.textContent = `⚠ finished, but not a valid benchmark${run.result?.reason ? ` (${run.result.reason})` : ' (fallback, invalid choice, or API error occurred)'}`;
    note.classList.remove('error');
  } else {
    note.innerHTML = DEFAULT_NOTE_HTML;
    note.classList.remove('error');
  }

  const remixSquelched = Boolean(run?.id && run.id === live.remixSquelch);
  for (const role of ROLES) {
    if (remixSquelched) {
      if (live.lastCallKey[role] !== 'remix-squelched') {
        live.lastCallKey[role] = 'remix-squelched';
        sendMind('live', role, null, {
          title: 'Model mind',
          placeholder: 'Remixed — start a match to watch this model think.',
        });
      }
      continue;
    }
    if (humanRole && role === humanRole) {
      // Your panel is a coach's corner while you play.
      const key = `human|${run.id}|${role}`;
      if (live.lastCallKey[role] !== key) {
        live.lastCallKey[role] = key;
        sendMind('live', role, null, {title: 'Your side', placeholder: 'You have the controls — pick your moves on the deck under the battle.'});
      }
      continue;
    }
    if (humanRole && !mindPeek) {
      // The opponent's mind stays dark by default (the server withholds it
      // too) — but it's YOUR game: the card's 👁 button peeks live.
      const key = `human|${run.id}|${role}|dark`;
      if (live.lastCallKey[role] !== key) {
        live.lastCallKey[role] = key;
        sendMind('live', role, null, {
          title: 'Model mind',
          placeholder: 'The opponent’s thinking is hidden while you play — revealed when the game ends, or peek now.',
          shimmer: true,
          peek: {on: false, role},
        });
      }
      continue;
    }
    const calls = (run?.lastModelCalls || []).filter(call => call.role === role);
    const latest = calls.at(-1) || (run?.lastModelCall?.role === role ? run.lastModelCall : null);
    const key = latest ? String(latest.callIndex ?? `${latest.at}|${latest.choice}|${latest.error || ''}`) : '';
    if (key && key !== live.lastCallKey[role]) {
      live.lastCallKey[role] = key;
      // The mind reveals BEFORE the press dispatches, so the action record
      // for THIS call usually doesn't exist yet — only use an action that
      // provably belongs to this call, or its label/request would be the
      // previous turn's and the mind would fall back to raw protocol tokens.
      const lastAction = (run?.lastActions || []).filter(a => a.role === role).at(-1);
      const action = lastAction && lastAction.callIndex === latest.callIndex ? lastAction : null;
      // The request being decided is still the latest one; prefer the keyed
      // ACTIONABLE snapshot (a post-choice rebroadcast arrives consumed with
      // empty legalActions and would leave the name maps empty).
      const requestObservation = (action?.requestId != null ? live.requests[role].get(Number(action.requestId)) : null)
        || (live.latestRequest[role]?.requestId != null ? live.requests[role].get(Number(live.latestRequest[role].requestId)) : null)
        || live.latestRequest[role]
        || null;
      const mindData = modelMindData(latest, action, requestObservation, run?.currentTurn);
      const mindOptions = {title: 'Model mind', animate: true};
      if (humanRole && role !== humanRole) mindOptions.peek = {on: true, role};
      sendMind('live', role, mindData, mindOptions);
      // The press gate waits for this reveal to play out.
      live.mindReveal[role] = {
        choice: latest.choice,
        turn: action?.turn ?? null,
        at: Date.now(),
        ms: mindRevealMs(mindData),
      };
    } else if (!key && !live.lastCallKey[role]) {
      const idleOptions = {
        title: 'Model mind',
        placeholder: active ? 'Model thinking…' : 'Start a match to watch this model think.',
        shimmer: active,
      };
      if (humanRole && role !== humanRole) idleOptions.peek = {on: true, role};
      sendMind('live', role, null, idleOptions);
    }
  }

  const banner = $('live-banner');
  const runWins = countRunWins(run);
  if (remixSquelched) {
    banner.classList.add('hidden');
    $('live-plate-p1').classList.remove('winner');
    $('live-plate-p2').classList.remove('winner');
  } else if (run?.result?.done && run.status === 'finished') {
    const winner = run.result.winner;
    const lastSide = run.result.winnerRole
      || (winner === 'Benchmark P1' ? 'p1' : winner === 'Benchmark P2' ? 'p2' : null);
    // A multi-game run crowns the run's record, not just the last game.
    const multi = (run.games?.length || 0) > 1;
    const side = multi
      ? (runWins.p1 > runWins.p2 ? 'p1' : runWins.p2 > runWins.p1 ? 'p2' : null)
      : lastSide;
    $('live-plate-p1').classList.toggle('winner', side === 'p1');
    $('live-plate-p2').classList.toggle('winner', side === 'p2');
    if (multi) {
      const name = side ? shortName(side === 'p1' ? run.agentP1 : run.agentP2) : '';
      banner.textContent = side
        ? `🏆 ${name} ${name === 'You' ? 'take' : 'takes'} the run ${Math.max(runWins.p1, runWins.p2)}–${Math.min(runWins.p1, runWins.p2)} over ${run.games.length} games`
        : `Run over: ${runWins.p1}–${runWins.p2} after ${run.games.length} games`;
    } else {
      const name = lastSide ? shortName(lastSide === 'p1' ? run.agentP1 : run.agentP2) : '';
      banner.textContent = lastSide
        ? `🏆 ${name} ${name === 'You' ? 'win' : 'wins'} in ${run.result.turn} turns`
        : `Match over after ${run.result.turn} turns${run.result.reason ? ` (${run.result.reason})` : ''}`;
    }
    banner.classList.remove('hidden');
  } else if (active) {
    // Between games of a multi-game run, flash the game that just ended.
    const lastGame = (run.games || []).at(-1);
    if (lastGame && lastGame.gameId !== live.gameBannerId && run.gameCount > 1) {
      live.gameBannerId = lastGame.gameId;
      const gameWinner = lastGame.winnerRole
        ? shortName(lastGame.winnerRole === 'p1' ? run.agentP1 : run.agentP2)
        : null;
      banner.textContent = `${gameWinner ? `🏆 ${gameWinner} ${gameWinner === 'You' ? 'win' : 'wins'}` : 'Draw'} game ${lastGame.game} in ${lastGame.turns ?? '?'} turns · run ${runWins.p1}–${runWins.p2}`;
      banner.classList.remove('hidden');
      clearTimeout(live.gameBannerTimer);
      live.gameBannerTimer = setTimeout(() => {
        if (live.gameBannerId === lastGame.gameId && isActiveRun(live.run)) banner.classList.add('hidden');
      }, 5200);
    } else if (!lastGame || lastGame.gameId !== live.gameBannerId) {
      banner.classList.add('hidden');
    }
    $('live-plate-p1').classList.remove('winner');
    $('live-plate-p2').classList.remove('winner');
  }
}

// This run's own record (the series may hold games from earlier runs too).
function countRunWins(run) {
  const wins = {p1: 0, p2: 0};
  for (const game of run?.games || []) {
    if (game.winnerRole === 'p1') wins.p1 += 1;
    else if (game.winnerRole === 'p2') wins.p2 += 1;
  }
  return wins;
}

// The winning side of a finished run: the series record for a multi-game run,
// the last game's winner for a single game. null for a draw / no result.
function winningSideOf(run) {
  if (!run) return null;
  if ((run.games?.length || 0) > 1) {
    const wins = countRunWins(run);
    return wins.p1 > wins.p2 ? 'p1' : wins.p2 > wins.p1 ? 'p2' : null;
  }
  return run.result?.winnerRole
    || (run.result?.winner === 'Benchmark P1' ? 'p1' : run.result?.winner === 'Benchmark P2' ? 'p2' : null);
}

async function liveCommand(body) {
  const note = $('live-note');
  const epoch = ++liveStateEpoch;
  liveCommandPending += 1;
  try {
    const response = await fetch('/api/run', {
      method: 'POST',
      headers: {'content-type': 'application/json'},
      body: JSON.stringify({...body, sessionId: SESSION_ID}),
    });
    const payload = await response.json();
    if (!payload.ok) throw new Error(payload.error || 'Request failed');
    if (epoch === liveStateEpoch) {
      live.run = payload.run || live.run;
      note.classList.remove('error');
      renderLiveRun();
    }
    return true;
  } catch (error) {
    if (epoch === liveStateEpoch) {
      note.textContent = String(error.message || error);
      note.classList.add('error');
    }
    return false;
  } finally {
    liveCommandPending = Math.max(0, liveCommandPending - 1);
  }
}

// Start a match with whatever the pickers currently hold. Used by the
// one-time setup card AND by 🔀 between battles (queued models play next).
async function startMatchFromPicks() {
  if (live.starting || isActiveRun(live.run)) return false;
  const selectedSpecs = [$('setup-p1').value.trim() || 'standin', $('setup-p2').value.trim() || 'standin'];
  if (selectedSpecs[1] === 'human') {
    const note = $('live-note');
    note.textContent = 'You play Player 1 — set Player 2 to a model or built-in bot';
    note.classList.add('error');
    return false;
  }
  const unsupported = selectedSpecs.find(spec => !['standin', 'heuristic', 'human'].includes(spec) && !spec.startsWith('openrouter:'));
  if (unsupported) {
    const note = $('live-note');
    note.textContent = `The public arena currently supports built-in players and OpenRouter only: ${unsupported}`;
    note.classList.add('error');
    return false;
  }
  const needsKey = selectedSpecs.some(spec => spec.startsWith('openrouter:'));
  if (needsKey && (!storedKey() || !keyValid)) {
    if (localStorage.getItem(HAS_BATTLED_KEY)) {
      openKeyModal();
    } else {
      renderKeyPanel('invalid', {error: 'Real models need your OpenRouter key — paste it below'});
      $('key-input').focus();
    }
    return false;
  }
  // Clear the previous battle's deck and pending state BEFORE the start
  // command: the new battle's requests can otherwise arrive on the deck
  // sockets ahead of the spectator reset and inherit a stale deck.
  resetLiveBattleState();
  // Doubles games resolve well before this; not a viewer-facing knob.
  const maxTurns = 50;
  const moveDelayMs = Number($('setup-delay').value) || 1400;
  live.starting = true;
  renderLiveRun();
  try {
    const started = await liveCommand({
      command: 'start',
      agentP1: selectedSpecs[0],
      agentP2: selectedSpecs[1],
      gameCount: gameCountValue(),
      revealOpponentMind: selectedSpecs[0] === 'human' ? mindPeek : undefined,
      maxTurns,
      moveDelayMs,
      // Spectating pace: leave generous headroom so slow models and watchable
      // move delays never hit the runner timeout mid-match. Humans think on
      // human time, so their games get the full ceiling.
      timeoutMs: selectedSpecs[0] === 'human'
        ? 7200000
        : Math.min(7200000, Math.max(300000, maxTurns * (moveDelayMs + 8000) * 4)),
      // Exhibition mode: arena matches are for watching, so a provider failing
      // repeatedly on one decision yields a labeled safe fallback move instead
      // of a dead match. The artifact is honestly marked validBenchmark: false;
      // CLI/ladder benchmark runs stay strict.
      allowFallback: true,
      openrouterKey: storedKey() || undefined,
    });
    if (started) {
      localStorage.setItem(HAS_BATTLED_KEY, '1');
      live.remixSquelch = null;
    }
    return started;
  } finally {
    live.starting = false;
    renderLiveRun();
  }
}

$('live-start').addEventListener('click', () => void startMatchFromPicks());
// The demo: two built-in players, no key, instant start — so a first-time
// visitor can see exactly what a battle looks like before pasting anything.
async function startDemoMatch() {
  if (live.starting || isActiveRun(live.run)) return;
  resetLiveBattleState();
  live.starting = true;
  renderLiveRun();
  const started = await liveCommand({
    command: 'start',
    agentP1: 'standin',
    agentP2: 'standin',
    maxTurns: 50,
    moveDelayMs: 900,
    timeoutMs: 900000,
    allowFallback: true,
  });
  if (started) localStorage.setItem(HAS_BATTLED_KEY, '1');
  live.starting = false;
  renderLiveRun();
}

$('live-demo').addEventListener('click', () => void startDemoMatch());

// Remix: reroll the random teams instantly. Idle → reset the session battle
// (new seed, new teams on screen right away); mid-run → stop and relaunch the
// same matchup on fresh teams. Minds and banner reset either way.
let remixing = false;
async function remixBattle() {
  if (remixing) return;
  remixing = true;
  $('theater-remix').classList.add('spinning');
  try {
    const run = live.run;
    const active = isActiveRun(run);
    $('live-banner').classList.add('hidden');
    live.lastCallKey = {p1: '', p2: ''};
    // A finished run stays in telemetry; without this the next poll would
    // repaint its minds and winner banner right over the remixed board.
    live.remixSquelch = !active && run?.id ? run.id : null;
    for (const role of ROLES) {
      sendMind('live', role, null, {
        title: 'Model mind',
        placeholder: 'Remixed — waiting for the first decision…',
      });
    }
    if (active) {
      if (!await liveCommand({command: 'stop'})) return;
      // The abort settles asynchronously; the relaunch is rejected while the
      // old run is still winding down.
      const deadline = Date.now() + 12000;
      while (Date.now() < deadline && isActiveRun(live.run)) {
        await sleep(400);
        await pollLiveRun();
      }
      // ↻ honors the picker: whatever models are currently chosen play the
      // fresh battle (that's how mid-run model changes take effect).
      await startMatchFromPicks();
    } else if (run || localStorage.getItem(HAS_BATTLED_KEY)) {
      // Between battles, 🔀 IS the next-game button: it launches a fresh
      // match with whatever the plates hold (including queued changes). The
      // squelch keeps the finished run's minds quiet until the new run's
      // telemetry takes over.
      await startMatchFromPicks();
    } else {
      // Never battled: just reroll the idle board's random teams.
      await fetch('/api/reset', {
        method: 'POST',
        headers: {'content-type': 'application/json'},
        body: JSON.stringify({battleId: BATTLE_ID}),
      });
    }
  } catch {
    // the pollers repaint whatever state we landed in
  } finally {
    setTimeout(() => $('theater-remix').classList.remove('spinning'), 600);
    remixing = false;
  }
}

$('theater-remix').addEventListener('click', () => void remixBattle());
$('live-next').addEventListener('click', () => {
  const button = $('live-next');
  button.disabled = true;
  startMatchFromPicks();
  setTimeout(() => { button.disabled = false; }, 1500);
});
$('theater-stop').addEventListener('click', () => {
  if (isActiveRun(live.run)) void liveCommand({command: 'stop'});
});
$('theater-pause').addEventListener('click', togglePause);

$('live-pause').addEventListener('click', () => { if (!live.showPaused) togglePause(); });
$('live-resume').addEventListener('click', () => { if (live.showPaused) togglePause(); });
$('live-stop').addEventListener('click', () => {
  setShowPaused(false);
  void liveCommand({command: 'stop'});
});

/* ---------------- canonical model picker: provider → model → effort ---------------- */

const PROVIDER_LABELS = {
  openai: 'OpenAI',
  anthropic: 'Anthropic',
  google: 'Google',
  deepseek: 'DeepSeek',
  'z-ai': 'Z.AI',
  minimax: 'MiniMax',
  moonshotai: 'Moonshot AI',
  qwen: 'Qwen',
  'x-ai': 'xAI',
  mistralai: 'Mistral',
  'meta-llama': 'Meta',
  amazon: 'Amazon',
  microsoft: 'Microsoft',
  nvidia: 'NVIDIA',
  cohere: 'Cohere',
  perplexity: 'Perplexity',
};
const FEATURED_PROVIDERS = ['openai', 'anthropic', 'google', 'deepseek', 'z-ai', 'minimax', 'moonshotai', 'qwen', 'x-ai', 'mistralai', 'meta-llama'];
// The full reasoning dial the harness accepts; models that don't advertise a
// reasoning parameter get a locked "none". Providers that cap lower than
// xhigh degrade gracefully (the adapter retries without reasoning).
const EFFORTS = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh'];

// OpenRouter indexes the reasoning dial differently per model family — the
// picker offers only the rungs the family actually takes, instead of
// pretending every model runs minimal→xhigh.
function effortLadder(modelId) {
  const id = String(modelId || '');
  if (/^openai\//.test(id)) return ['minimal', 'low', 'medium', 'high', 'xhigh'];
  if (/^x-ai\/grok-3-mini/.test(id)) return ['low', 'high'];
  if (/^x-ai\//.test(id)) return ['low', 'medium', 'high'];
  if (/^anthropic\//.test(id)) return ['low', 'medium', 'high', 'xhigh'];
  if (/^google\//.test(id)) return ['low', 'medium', 'high'];
  return ['low', 'medium', 'high'];
}
const pickerCatalog = new Map(); // provider slug → [{id, label, reasoning}]
let modelCatalogReady = false;

function providerLabel(slug) {
  return PROVIDER_LABELS[slug] || slug.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}

function catalogModelLabel(model) {
  const name = model.name || model.id;
  return name.includes(': ') ? name.split(': ').slice(1).join(': ') : name;
}

async function loadModelCatalog() {
  try {
    const response = await fetch('/api/models');
    if (!response.ok) throw new Error(`Model catalog HTTP ${response.status}`);
    const payload = await response.json();
    if (!Array.isArray(payload.models) || !payload.models.length) throw new Error('Model catalog is empty');
    pickerCatalog.clear();
    for (const model of payload.models || []) {
      const slug = String(model.id).split('/')[0];
      if (!pickerCatalog.has(slug)) pickerCatalog.set(slug, []);
      pickerCatalog.get(slug).push({
        id: model.id,
        label: catalogModelLabel(model),
        reasoning: model.reasoning !== false,
      });
    }
    for (const models of pickerCatalog.values()) {
      models.sort((a, b) => a.label.localeCompare(b.label));
    }
    modelCatalogReady = true;
  } catch {
    modelCatalogReady = false;
    // Saved specs stay visible and authoritative even without the catalog.
  }
  for (const prefix of PICKER_PREFIXES) {
    for (const player of ROLES) buildPicker(prefix, player);
  }
}

function orderedProviderSlugs() {
  const rest = [...pickerCatalog.keys()].filter(slug => !FEATURED_PROVIDERS.includes(slug)).sort();
  return [...FEATURED_PROVIDERS.filter(slug => pickerCatalog.has(slug)), ...rest];
}

// The same picker lives in two homes: the one-time setup card ('pick') and
// the permanent model plates above the client ('plate'). Both read and write
// the shared setup-{player} spec, so they always agree.
const PICKER_PREFIXES = ['pick', 'plate'];
const SPEC_STORE_KEY = 'arena-specs';

function pickerSel(prefix, kind, player) {
  return $(`${prefix}-${kind}-${player}`);
}

function persistSpecs() {
  localStorage.setItem(SPEC_STORE_KEY, JSON.stringify({
    p1: $('setup-p1').value.trim(),
    p2: $('setup-p2').value.trim(),
  }));
}

function restoreSpecs() {
  try {
    const saved = JSON.parse(localStorage.getItem(SPEC_STORE_KEY) || '{}');
    for (const player of ROLES) {
      if (typeof saved[player] === 'string' && saved[player]) $(`setup-${player}`).value = saved[player];
    }
  } catch {
    // defaults stand
  }
}

function buildPicker(prefix, player) {
  const providerSelect = pickerSel(prefix, 'provider', player);
  if (!providerSelect) return;
  providerSelect.replaceChildren();
  // Player 1 can be a person: the stage is P1's native client, so the human
  // seat is always the left pad.
  if (player === 'p1') providerSelect.appendChild(new Option('🎮 You', 'human'));
  providerSelect.appendChild(new Option('Built-in', 'built-in'));
  for (const slug of orderedProviderSlugs()) {
    providerSelect.appendChild(new Option(providerLabel(slug), slug));
  }
  const saved = parseOpenRouterSpec($(`setup-${player}`).value.trim());
  if (saved && ![...providerSelect.options].some(option => option.value === saved.slug)) {
    providerSelect.appendChild(new Option(`${providerLabel(saved.slug)} · saved`, saved.slug));
  }
  syncPickerFromSpec(prefix, player);
}

function populatePickerModels(prefix, player, providerSlug, selectedId) {
  const modelSelect = pickerSel(prefix, 'model', player);
  modelSelect.replaceChildren();
  modelSelect.disabled = false;
  modelSelect.title = '';
  if (providerSlug === 'human') {
    modelSelect.appendChild(new Option('You play this side on the deck', 'human'));
    modelSelect.disabled = true;
    return;
  }
  if (providerSlug === 'built-in') {
    modelSelect.appendChild(new Option('Demo Bot — free, plays instantly', 'standin'));
    modelSelect.appendChild(new Option('Greedy Bot — always takes the best-rated action', 'heuristic'));
  } else {
    for (const model of pickerCatalog.get(providerSlug) || []) {
      modelSelect.appendChild(new Option(model.label, model.id));
    }
  }
  if (selectedId) {
    if (![...modelSelect.options].some(option => option.value === selectedId)) {
      modelSelect.appendChild(new Option(`${selectedId} · saved`, selectedId));
      modelSelect.title = modelCatalogReady
        ? 'This saved model is not in the current OpenRouter catalog'
        : 'The OpenRouter catalog is unavailable; showing the saved model exactly';
    }
    modelSelect.value = selectedId;
    if (!modelSelect.value && modelSelect.options.length) modelSelect.selectedIndex = 0;
  } else if (providerSlug !== 'built-in') {
    // No explicit pick: default to the provider's first reasoning-capable
    // model, not whatever sorts first alphabetically (a fresh select
    // auto-picks its first option — gpt-audio is nobody's first choice).
    const firstReasoning = (pickerCatalog.get(providerSlug) || []).find(model => model.reasoning);
    if (firstReasoning) modelSelect.value = firstReasoning.id;
  }
}

function populatePickerEfforts(prefix, player, selected) {
  const effortSelect = pickerSel(prefix, 'effort', player);
  const providerSlug = pickerSel(prefix, 'provider', player).value;
  const modelId = pickerSel(prefix, 'model', player).value;
  const entry = (pickerCatalog.get(providerSlug) || []).find(model => model.id === modelId);
  effortSelect.replaceChildren();
  if (providerSlug === 'built-in' || providerSlug === 'human') {
    effortSelect.appendChild(new Option('n/a', 'none'));
    effortSelect.disabled = true;
    effortSelect.title = '';
    return;
  }
  if (entry && !entry.reasoning) {
    // No reasoning dial on this model — say so instead of pretending.
    effortSelect.appendChild(new Option('no dial', 'none'));
    effortSelect.disabled = true;
    effortSelect.title = 'This model does not expose a reasoning-effort setting';
    return;
  }
  const ladder = effortLadder(modelId);
  effortSelect.appendChild(new Option('no reasoning', 'none'));
  for (const effort of ladder) effortSelect.appendChild(new Option(effort, effort));
  // A locked "none" carried over from Built-in is an artifact, not a choice;
  // an effort the new model's ladder lacks snaps to the nearest rung.
  effortSelect.value = selected && selected !== 'none' && ladder.includes(selected)
    ? selected
    : ladder.includes('low') ? 'low' : ladder[0];
  effortSelect.disabled = false;
  effortSelect.title = entry
    ? `Reasoning levels this family accepts on OpenRouter: ${ladder.join(', ')}`
    : `Saved model: reasoning levels inferred from its model family (${ladder.join(', ')})`;
}

function applyPickerToSpec(prefix, player) {
  const provider = pickerSel(prefix, 'provider', player).value;
  const model = pickerSel(prefix, 'model', player).value;
  const effort = pickerSel(prefix, 'effort', player).value || 'low';
  $(`setup-${player}`).value = provider === 'human'
    ? 'human'
    : provider === 'built-in' ? (model || 'standin') : `openrouter:${model}:${effort}`;
  persistSpecs();
  syncAllPickersFromSpec(player);
  renderLiveRun();
}

function syncAllPickersFromSpec(player) {
  for (const pickerPrefix of PICKER_PREFIXES) syncPickerFromSpec(pickerPrefix, player);
}

function parseOpenRouterSpec(spec) {
  if (!String(spec || '').startsWith('openrouter:')) return null;
  const parts = String(spec).split(':');
  const effort = parts.length > 2 && EFFORTS.includes(parts.at(-1)) ? parts.pop() : 'low';
  const modelId = parts.slice(1).join(':');
  return {modelId, effort, slug: modelId.split('/')[0] || 'openrouter'};
}

// The raw spec input stays authoritative (Advanced can edit it directly);
// the pickers mirror it.
function syncPickerFromSpec(prefix, player) {
  const spec = $(`setup-${player}`).value.trim();
  const providerSelect = pickerSel(prefix, 'provider', player);
  if (!providerSelect) return;
  if (spec === 'human' && player === 'p1') {
    providerSelect.value = 'human';
    populatePickerModels(prefix, player, 'human', 'human');
    populatePickerEfforts(prefix, player, 'none');
    return;
  }
  if (!spec || spec === 'standin' || spec === 'heuristic') {
    providerSelect.value = 'built-in';
    populatePickerModels(prefix, player, 'built-in', spec === 'heuristic' ? 'heuristic' : 'standin');
    populatePickerEfforts(prefix, player, 'low');
    return;
  }
  const parsed = parseOpenRouterSpec(spec);
  if (!parsed) {
    if (![...providerSelect.options].some(option => option.value === 'unsupported')) {
      providerSelect.appendChild(new Option('Unsupported saved spec', 'unsupported'));
    }
    providerSelect.value = 'unsupported';
    const modelSelect = pickerSel(prefix, 'model', player);
    modelSelect.replaceChildren(new Option(spec, spec));
    modelSelect.disabled = true;
    modelSelect.title = 'The public arena currently supports OpenRouter model specs only';
    const effortSelect = pickerSel(prefix, 'effort', player);
    effortSelect.replaceChildren(new Option('n/a', 'none'));
    effortSelect.disabled = true;
    effortSelect.title = '';
    return;
  }
  if (![...providerSelect.options].some(option => option.value === parsed.slug)) {
    providerSelect.appendChild(new Option(`${providerLabel(parsed.slug)} · saved`, parsed.slug));
  }
  providerSelect.value = parsed.slug;
  populatePickerModels(prefix, player, parsed.slug, parsed.modelId);
  populatePickerEfforts(prefix, player, parsed.effort);
}

for (const prefix of PICKER_PREFIXES) {
  for (const player of ROLES) {
    pickerSel(prefix, 'provider', player).addEventListener('change', () => {
      const selectedEffort = pickerSel(prefix, 'effort', player).value;
      populatePickerModels(prefix, player, pickerSel(prefix, 'provider', player).value);
      populatePickerEfforts(prefix, player, selectedEffort);
      applyPickerToSpec(prefix, player);
    });
    pickerSel(prefix, 'model', player).addEventListener('change', () => {
      populatePickerEfforts(prefix, player, pickerSel(prefix, 'effort', player).value);
      applyPickerToSpec(prefix, player);
    });
    pickerSel(prefix, 'effort', player).addEventListener('change', () => applyPickerToSpec(prefix, player));
  }
}
for (const player of ROLES) {
  $(`setup-${player}`).addEventListener('change', () => {
    persistSpecs();
    syncAllPickersFromSpec(player);
    renderLiveRun();
  });
}

restoreSpecs();
void loadModelCatalog();

/* ---------------- boot ---------------- */

for (const role of ROLES) {
  sendMind('live', role, null, {
    title: 'Model mind',
    placeholder: 'Start a match to watch this model think.',
  });
}

updatePipeline();
void restoreKeyPanel();
applySound();
connectSpectatorSocket();
connectDeckSocket('p1');
connectDeckSocket('p2');
void renderDeck($('live-deck'), null, 'p1', {idleText: 'The decision deck lights up when a battle starts.'});
void pollLiveRun();
setInterval(pollLiveRun, 1000);
