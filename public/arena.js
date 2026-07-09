// Showdown LLM Arena: the stage is literally the native Showdown client.
//
// The models play headlessly: each receives a structured observation and
// returns one exact legal choice string. The stage is Player 1's complete
// native client (field + log + controls, dark theme). When Player 2 acts,
// its native controls-only frame overlays just the controls column, so the
// battle screen never changes while the control section alternates. A cursor
// animates pressing the real native buttons for every structured choice,
// live and in replay.

const ROLES = ['p1', 'p2'];
const CLIENT_BASE_WIDTH = 956;
const CLIENT_BASE_HEIGHT = 760;
// Proven in real matches/preflights through the OpenRouter adapter.
const AGENT_PRESETS = [
  'standin',
  'openrouter:anthropic/claude-sonnet-4.6:low',
  'openrouter:openai/gpt-4o-mini:low',
  'openrouter:z-ai/glm-5.2:low',
  'openrouter:minimax/minimax-m3:low',
  'openrouter:deepseek/deepseek-v4-flash:low',
];
const ANALYSIS_SECTIONS = [
  ['gameStateSummary', 'Board read'],
  ['winConditions', 'Win path'],
  ['loseConditions', 'Loss risk'],
  ['setupLines', 'Setup lines'],
  ['sweepPlans', 'Sweep plans'],
  ['safeSwitches', 'Pivots'],
  ['opponentLikelyPlan', 'Opponent plan'],
  ['biggestThreats', 'Threats'],
  ['riskAssessment', 'Risk'],
  ['candidateChoices', 'Candidates'],
];

const $ = id => document.getElementById(id);
const wsProtocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
const DEFAULT_NOTE_HTML = document.getElementById('live-note').innerHTML;

// Every browser gets its own session: its own battle on the server, its own
// run slot, its own replays. Concurrent visitors never collide.
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
  plate.querySelector('.provider').textContent = info.provider || 'local';
  plate.querySelector('.model-name').textContent = info.model || 'unknown';
  plate.querySelector('.effort').textContent = info.effort ? `${info.effort} effort` : '';
}

function shortName(agent) {
  if (!agent) return 'unknown';
  if (typeof agent === 'string') return parseAgentSpec(agent).model;
  return agent.model || agent.name || 'unknown';
}

function setStatusPill(pill, status, label) {
  pill.dataset.status = status;
  pill.textContent = label || status;
}

function compactCount(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return '?';
  if (n >= 1000000) return `${(n / 1000000).toFixed(1)}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

function compactCost(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return '';
  return n >= 0.01 ? `$${n.toFixed(2)}` : `$${n.toFixed(4)}`;
}

function usageLine(usage) {
  if (!usage) return '';
  const input = usage.inputTokens ?? usage.input_tokens ?? usage.promptTokens ?? null;
  const output = usage.outputTokens ?? usage.output_tokens ?? usage.completionTokens ?? null;
  const total = usage.totalTokens ?? usage.total_tokens ?? null;
  const cost = usage.totalCostUsd ?? usage.costUsd ?? usage.cost ?? null;
  const parts = [];
  if (input != null || output != null) parts.push(`${compactCount(input)}→${compactCount(output)} tok`);
  else if (total != null) parts.push(`${compactCount(total)} tok`);
  const costText = compactCost(cost);
  if (costText) parts.push(costText);
  return parts.join(' · ');
}

/* ---------------- mind card ---------------- */

function renderMind(container, data, options = {}) {
  container.replaceChildren();
  const head = el('div', 'mind-head');
  head.appendChild(el('h3', '', options.title || 'Model mind'));
  const meta = el('span', 'mind-meta');
  const metaBits = [];
  if (data?.turn != null) metaBits.push(`turn ${data.turn}`);
  const usage = usageLine(data?.usage);
  if (usage) metaBits.push(usage);
  meta.textContent = metaBits.join(' · ');
  head.appendChild(meta);
  container.appendChild(head);

  if (!data) {
    const idle = el('div', 'thinking');
    idle.appendChild(el('span', options.shimmer ? 'shimmer' : '', options.placeholder || 'Waiting for the first decision…'));
    container.appendChild(idle);
    return;
  }

  const sections = el('div', 'mind-sections');
  const analysis = data.analysis || {};
  for (const [key, label] of ANALYSIS_SECTIONS) {
    const items = Array.isArray(analysis[key]) ? analysis[key].filter(Boolean) : [];
    if (!items.length) continue;
    const section = el('div', 'mind-section');
    section.appendChild(el('h4', '', label));
    const list = el('ul');
    const cap = key === 'candidateChoices' ? 6 : 4;
    for (const item of items.slice(0, cap)) {
      const li = el('li', '', String(item));
      if (key === 'candidateChoices' && data.choice && String(item).startsWith(data.choice)) {
        li.classList.add('chosen-candidate');
        li.textContent = `▸ ${item}`;
      }
      list.appendChild(li);
    }
    section.appendChild(list);
    sections.appendChild(section);
  }
  if (sections.children.length) container.appendChild(sections);

  const raws = [
    ['What the model saw', data.prompt, 'prompt'],
    ['Raw model answer', data.rawText, 'answer'],
  ];
  for (const [label, text, kind] of raws) {
    if (!text) continue;
    const details = document.createElement('details');
    details.className = `mind-raw mind-raw-${kind}`;
    const summary = document.createElement('summary');
    summary.textContent = label;
    details.appendChild(summary);
    const pre = document.createElement('pre');
    pre.textContent = String(text);
    details.appendChild(pre);
    container.appendChild(details);
  }

  const footer = el('div', 'mind-choice');
  if (data.choice) footer.appendChild(el('span', 'choice-chip', data.choice));
  if (data.reason) footer.appendChild(el('span', 'choice-label', data.reason));
  if (data.valid === false) footer.appendChild(el('span', 'invalid', 'invalid choice'));
  if (data.fallback) footer.appendChild(el('span', 'invalid', 'fallback'));
  if (footer.children.length) container.appendChild(footer);
}

/* ---------------- alternating native controls overlay ---------------- */

// The stage is Player 1's full native client. When Player 2 acts, its native
// controls-only frame is overlaid exactly on the client's controls column
// (0,370 to the client bottom, in unscaled client coordinates), so the battle
// screen never changes while the control section alternates between players.
function setControlsOwner(overlayEl, ownerEl, side) {
  overlayEl.classList.toggle('hidden', side !== 'p2');
  ownerEl.dataset.side = side;
  ownerEl.textContent = side === 'p2' ? 'P2 controls' : 'P1 controls';
}

/* ---------------- viewport scaling (battle field only) ---------------- */

const scaledViewports = new Set();

function registerViewport(viewport) {
  scaledViewports.add(viewport);
  scaleViewport(viewport);
}

function scaleViewport(viewport) {
  if (!viewport.isConnected || !viewport.offsetParent) return;
  if (document.body.classList.contains('theater')) {
    // Fill the screen with the native client, preserving its aspect ratio.
    const scale = Math.min(window.innerWidth / CLIENT_BASE_WIDTH, window.innerHeight / CLIENT_BASE_HEIGHT);
    viewport.style.setProperty('--client-scale', String(scale));
    viewport.style.width = `${Math.ceil(CLIENT_BASE_WIDTH * scale)}px`;
    viewport.style.height = `${Math.ceil(CLIENT_BASE_HEIGHT * scale)}px`;
    return;
  }
  viewport.style.width = '';
  const width = viewport.clientWidth || CLIENT_BASE_WIDTH;
  const scale = Math.max(0.28, Math.min(1, width / CLIENT_BASE_WIDTH));
  viewport.style.setProperty('--client-scale', String(scale));
  viewport.style.height = `${Math.ceil(CLIENT_BASE_HEIGHT * scale)}px`;
}

function scaleAllViewports() {
  for (const viewport of scaledViewports) scaleViewport(viewport);
}

const viewportObserver = new ResizeObserver(scaleAllViewports);
window.addEventListener('resize', scaleAllViewports);

for (const id of ['live-viewport-battle', 'replay-viewport-battle']) {
  const viewport = $(id);
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
      void pumpPressQueue();
    }
    if (message.type === 'sd-request') {
      live.pending[liveKind] = Boolean(message.actionable);
      liveIdleView();
      // A P1 wait-request unblocks any queued P2 press.
      void pumpPressQueue();
    }
    if (message.type === 'sd-choice-done') {
      // Only the press we are actually waiting on may advance the queue;
      // stale done-signals from timed-out presses must not desync it.
      const waiter = live.choiceWaiters[liveKind];
      if (waiter && waiter.choice === message.choice) waiter.resolve();
    }
    return;
  }
  if (message.type === 'sd-ready') {
    replayUI.onFrameReady(event.source);
    applySound();
  }
  if (message.type === 'sd-choice-done') replayUI.onChoiceDone(event.source);
});

/* ---------------- tabs ---------------- */

const tabButtons = [...document.querySelectorAll('.tabs button')];

function setTab(tab) {
  for (const button of tabButtons) button.setAttribute('aria-pressed', String(button.dataset.tab === tab));
  $('live-view').classList.toggle('hidden', tab !== 'live');
  $('replay-view').classList.toggle('hidden', tab !== 'replay');
  if (tab === 'replay') replayUI.onShow();
  scaleAllViewports();
}

for (const button of tabButtons) {
  button.addEventListener('click', () => setTab(button.dataset.tab));
}

/* ---------------- guided pipeline ---------------- */

// The setup card is a walk-through: (1) key, (2) models, (3) battle. Steps 2
// and 3 stay dormant until the key validates, then light up. The Replays tab
// stays hidden for brand-new visitors until they have a key or a battle.
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
  const seasoned = keyValid || Boolean(localStorage.getItem(HAS_BATTLED_KEY)) || Boolean(live.run);
  $('arena-tabs').classList.toggle('hidden', !seasoned);
}

// A fresh key deserves real opponents: upgrade untouched stand-in defaults to
// two proven presets so step 3 is one click away.
function suggestRealModels() {
  if ($('setup-p1').value.trim() === 'standin') $('setup-p1').value = AGENT_PRESETS[1];
  if ($('setup-p2').value.trim() === 'standin') $('setup-p2').value = AGENT_PRESETS[2];
}

/* ---------------- bring-your-own-key ---------------- */

// The visitor's OpenRouter key lives in this browser's localStorage only.
// Validation goes through the server's proxy to OpenRouter's free auth
// endpoint (no inference is billed); matches carry the key per-request and
// the server holds it in memory only.
const KEY_STORAGE = 'arena-openrouter-key';

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
    const label = el('b', '', 'Key valid');
    factsEl.appendChild(label);
    if (facts.balance != null) {
      factsEl.appendChild(el('span', 'key-balance', ` · $${facts.balance.toFixed(2)} credits`));
    }
    status.appendChild(factsEl);
    const change = el('button', 'key-change', 'change');
    change.type = 'button';
    change.addEventListener('click', () => {
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
    return;
  }
  keyValid = false;
  updatePipeline();
  if (state === 'invalid') {
    entry.classList.remove('hidden');
    status.classList.remove('hidden');
    status.classList.add('key-error');
    status.replaceChildren();
    status.appendChild(el('span', 'key-ball', '✗'));
    const factsEl = el('span', 'key-facts');
    factsEl.appendChild(el('b', '', facts.error || 'That key didn’t validate'));
    status.appendChild(factsEl);
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
  const input = $('key-input');
  const button = $('key-enter');
  const key = input.value.trim();
  if (!key) {
    renderKeyPanel('invalid', {error: 'Paste a key first'});
    return;
  }
  button.classList.add('testing');
  button.disabled = true;
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
  clearInterval(verbs);
  button.classList.remove('testing');
  button.disabled = false;
  button.textContent = 'Enter';
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
  // Re-validate silently so the chip shows a current balance.
  try {
    const response = await fetch('/api/key/validate', {
      method: 'POST',
      headers: {'content-type': 'application/json'},
      body: JSON.stringify({openrouterKey: key}),
    });
    const result = await response.json();
    if (result.ok) {
      renderKeyPanel('valid', result);
      return;
    }
    localStorage.removeItem(KEY_STORAGE);
    renderKeyPanel('invalid', {error: 'Saved key no longer validates — paste a fresh one'});
  } catch {
    renderKeyPanel('valid', {}); // offline: trust the stored key for now
  }
}

/* ---------------- battle sound ---------------- */

// Sound comes from the base battle frame's native Showdown client. Default
// muted; the preference persists and survives frame reloads.
const SOUND_PREF_KEY = 'arena-sound-on';
let soundOn = localStorage.getItem(SOUND_PREF_KEY) === '1';

function soundTargetFrames() {
  return [
    $('live-frame-battle'),
    replayUI.engine?.frames?.base || null,
  ].filter(Boolean);
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

/* ---------------- theater mode ---------------- */

function theaterOn() {
  return document.body.classList.contains('theater');
}

function setTheater(on) {
  document.body.classList.toggle('theater', on);
  $('theater-exit').classList.toggle('hidden', !on);
  $('theater-sound').classList.toggle('hidden', !on);
  if (on && !localStorage.getItem('arena-theater-hinted')) {
    localStorage.setItem('arena-theater-hinted', '1');
    const hint = el('div', '', 'The Dashboard button (or Esc) brings everything back · m for sound');
    hint.id = 'theater-hint';
    document.body.appendChild(hint);
    setTimeout(() => hint.remove(), 6200);
  }
  scaleAllViewports();
}

for (const button of document.querySelectorAll('[data-theater-toggle]')) {
  button.addEventListener('click', () => setTheater(!theaterOn()));
}
$('theater-exit').addEventListener('click', () => setTheater(false));
window.addEventListener('keydown', event => {
  if (/INPUT|TEXTAREA|SELECT/.test(event.target?.tagName || '')) return;
  if (event.key === 'Escape' && theaterOn()) setTheater(false);
  if (event.key === 't' || event.key === 'T') setTheater(!theaterOn());
  if (event.key === 'm' || event.key === 'M') toggleSound();
});

/* ================================================================
   LIVE
   ================================================================ */

const live = {
  run: null,
  lastCallKey: {p1: '', p2: ''},
  lastTickerKey: '',
  pending: {p1: false, p2: false},
  animating: null,
  pressQueue: [],
  dispatching: false,
  choiceWaiters: {p1: null, p2: null},
  p1AnsweredTurn: 0,
  frameReady: {p1: false, p2: false},
  log: [],
};
window.__arenaLive = live;

function liveFrameKind(source) {
  if (source && source === $('live-frame-battle')?.contentWindow) return 'p1';
  if (source && source === $('live-overlay-frame')?.contentWindow) return 'p2';
  return null;
}

function setLiveControlsOwner(side) {
  setControlsOwner($('live-overlay'), $('live-controls-owner'), side);
}

// With no press animation in flight, show whichever player still owes a
// decision (P1's controls are part of the base client; P2's are the overlay).
function liveIdleView() {
  if (live.animating) return;
  setLiveControlsOwner(live.pending.p2 && !live.pending.p1 ? 'p2' : 'p1');
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
      const index = nextPressIndex();
      if (index < 0) break;
      const [press] = live.pressQueue.splice(index, 1);
      // If the models are deciding faster than presses can animate (stand-in
      // speeds), fast-forward the backlog instead of falling minutes behind:
      // deep-queued presses apply instantly, recent ones animate fully.
      const instant = live.pressQueue.length > 3;
      pressLog(`dispatch${instant ? ' (instant)' : ''} ${press.role} T${press.turn} ${press.choice}`);
      live.animating = press.role;
      if (!instant) setLiveControlsOwner(press.role);
      const frame = press.role === 'p2' ? $('live-overlay-frame') : $('live-frame-battle');
      frame?.contentWindow?.postMessage(
        {scope: 'showdown-arena', type: 'sd-choice', choice: press.choice, rqid: press.rqid, instant},
        '*'
      );
      await waitForLiveChoiceDone(press.role, press.choice);
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

function flashChip(chip, text) {
  chip.textContent = text;
  chip.classList.add('fresh');
  setTimeout(() => chip.classList.remove('fresh'), 4000);
}

// The base client and the P2 controls overlay self-connect over their own
// websockets and animate their own presses on choice events; here we watch
// the spectator channel for the turn counter, chip flashes, control-owner
// switches, and battle resets.
function connectSpectatorSocket() {
  const socket = new WebSocket(`${wsProtocol}//${location.host}/ws?role=spectator&battleId=${encodeURIComponent(BATTLE_ID)}`);
  socket.addEventListener('message', event => {
    let message;
    try {
      message = JSON.parse(event.data);
    } catch {
      return;
    }
    if (message.type === 'state' && message.state) {
      $('live-turn').textContent = message.state.turn || '–';
    }
    if (message.type === 'choice' && ROLES.includes(message.role)) {
      flashChip($(`live-chip-${message.role}`), message.choice || 'choosing…');
      live.pending[message.role] = false;
      if (message.role === 'p1') {
        live.p1AnsweredTurn = Math.max(live.p1AnsweredTurn, Number(message.turn) || 0);
      }
      live.pressQueue.push({
        role: message.role,
        choice: message.choice,
        rqid: message.rqid ?? null,
        turn: Number(message.turn) || 0,
      });
      pressLog(`queued ${message.role} T${message.turn} ${message.choice}`);
      void pumpPressQueue();
    }
    if (message.type === 'reset') {
      live.pending = {p1: false, p2: false};
      live.animating = null;
      live.pressQueue.length = 0;
      live.p1AnsweredTurn = 0;
      live.frameReady = {p1: false, p2: false};
      live.choiceWaiters.p1?.resolve();
      live.choiceWaiters.p2?.resolve();
      setLiveControlsOwner('p1');
      $('live-banner').classList.add('hidden');
      $('live-turn').textContent = '–';
      live.lastCallKey = {p1: '', p2: ''};
      for (const role of ROLES) {
        renderMind($(`live-mind-${role}`), null, {
          title: 'Model mind',
          placeholder: 'New battle — waiting for the first decision…',
        });
        const chip = $(`live-chip-${role}`);
        chip.textContent = 'waiting';
        chip.classList.remove('fresh');
      }
    }
  });
  socket.addEventListener('close', () => setTimeout(connectSpectatorSocket, 1000));
}

function isActiveRun(run) {
  return Boolean(run && ['running', 'paused', 'stopping'].includes(run.status));
}

async function pollLiveRun() {
  try {
    const response = await fetch(`/api/run?session=${encodeURIComponent(SESSION_ID)}`);
    const payload = await response.json();
    live.run = payload.run || null;
  } catch {
    // keep last known state
  }
  renderLiveRun();
}

function renderLiveRun() {
  const run = live.run;
  const active = isActiveRun(run);
  const status = run ? run.status : 'idle';
  setStatusPill($('live-status'), run ? status : 'idle');
  // Idle means the New match card is the page; the matchup bar exists only
  // once there is a match to describe.
  $('live-matchup').classList.toggle('hidden', !run);
  if (!$('live-view').classList.contains('hidden')) {
    document.title = run
      ? `${shortName(run.agentP1)} vs ${shortName(run.agentP2)} — Showdown LLM Arena`
      : 'Showdown LLM Arena';
  }

  // A brand-new visitor sees only the walk-through card; the console stage
  // appears with their first battle (and stays from then on).
  const stageVisible = Boolean(run) || Boolean(localStorage.getItem(HAS_BATTLED_KEY));
  const stage = $('live-stage');
  if (stage.classList.contains('hidden') === stageVisible) {
    stage.classList.toggle('hidden', !stageVisible);
    $('live-ticker').classList.toggle('hidden', !stageVisible);
    scaleAllViewports();
  }

  updatePipeline();
  $('live-start').disabled = active;
  $('live-demo').disabled = active;
  $('live-pause').disabled = !active || run.paused;
  $('live-resume').disabled = !active || !run.paused;
  $('live-stop').disabled = !active;
  // The setup card is the idle state; during a match the stage is the page.
  $('live-setup-card').classList.toggle('hidden', active);
  $('live-run-controls').classList.toggle('hidden', !active);

  const specP1 = run ? run.agentP1 : $('setup-p1').value;
  const specP2 = run ? run.agentP2 : $('setup-p2').value;
  renderPlate($('live-plate-p1'), specP1);
  renderPlate($('live-plate-p2'), specP2);
  $('live-who-p1').textContent = shortName(specP1);
  $('live-who-p2').textContent = shortName(specP2);

  if (run?.currentTurn) $('live-turn').textContent = run.currentTurn;

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

  for (const role of ROLES) {
    const calls = (run?.lastModelCalls || []).filter(call => call.role === role);
    const latest = calls.at(-1) || (run?.lastModelCall?.role === role ? run.lastModelCall : null);
    const key = latest ? `${latest.at}|${latest.choice}` : '';
    if (key && key !== live.lastCallKey[role]) {
      live.lastCallKey[role] = key;
      const action = (run?.lastActions || []).filter(a => a.role === role).at(-1);
      renderMind($(`live-mind-${role}`), {
        analysis: latest.analysis,
        choice: latest.choice,
        reason: latest.reason,
        valid: latest.valid,
        fallback: latest.fallback,
        usage: latest.usage,
        prompt: latest.prompt,
        rawText: latest.rawText,
        turn: action?.turn ?? run?.currentTurn ?? null,
      }, {title: 'Model mind'});
    } else if (!key && !live.lastCallKey[role]) {
      renderMind($(`live-mind-${role}`), null, {
        title: 'Model mind',
        placeholder: active ? 'Model thinking…' : 'Start a match to watch this model think.',
        shimmer: active,
      });
    }
  }

  const ticker = $('live-ticker');
  const actions = run?.lastActions || [];
  const tickerKey = actions.map(action => `${action.at}|${action.choice}`).join(';');
  if (tickerKey !== live.lastTickerKey) {
    live.lastTickerKey = tickerKey;
    ticker.replaceChildren();
    for (const action of [...actions].reverse()) {
      const tick = el('span', `tick ${action.role}`);
      tick.appendChild(el('span', '', `T${action.turn ?? '?'} `));
      tick.appendChild(el('b', '', action.role.toUpperCase()));
      tick.appendChild(el('span', '', ` ${action.choice}${action.reason ? ` — ${action.reason}` : ''}`));
      ticker.appendChild(tick);
    }
  }

  const banner = $('live-banner');
  if (run?.result?.done && run.status === 'finished') {
    // Surface the winner banner and the replay path when the match ends.
    if (theaterOn() && !$('live-view').classList.contains('hidden') && live.wasActive) setTheater(false);
    live.wasActive = false;
    const winner = run.result.winner;
    const side = winner === 'Benchmark P1' ? 'p1' : winner === 'Benchmark P2' ? 'p2' : null;
    $('live-plate-p1').classList.toggle('winner', side === 'p1');
    $('live-plate-p2').classList.toggle('winner', side === 'p2');
    banner.textContent = side
      ? `🏆 ${shortName(side === 'p1' ? run.agentP1 : run.agentP2)} wins in ${run.result.turn} turns`
      : `Match over after ${run.result.turn} turns${run.result.reason ? ` (${run.result.reason})` : ''}`;
    banner.classList.remove('hidden');
  } else if (active) {
    live.wasActive = true;
    banner.classList.add('hidden');
    $('live-plate-p1').classList.remove('winner');
    $('live-plate-p2').classList.remove('winner');
  }
}

async function liveCommand(body) {
  const note = $('live-note');
  try {
    const response = await fetch('/api/run', {
      method: 'POST',
      headers: {'content-type': 'application/json'},
      body: JSON.stringify({...body, sessionId: SESSION_ID}),
    });
    const payload = await response.json();
    if (!payload.ok) throw new Error(payload.error || 'Request failed');
    live.run = payload.run || live.run;
    note.classList.remove('error');
    if (live.autoTheater && isActiveRun(live.run)) {
      live.autoTheater = false;
      setTheater(true);
    }
    renderLiveRun();
  } catch (error) {
    note.textContent = String(error.message || error);
    note.classList.add('error');
  }
}

$('live-start').addEventListener('click', () => {
  const specs = [$('setup-p1').value, $('setup-p2').value].join(' ');
  if (specs.includes('openrouter:') && !storedKey()) {
    renderKeyPanel('invalid', {error: 'Real models need your OpenRouter key — paste it below'});
    $('key-input').focus();
    return;
  }
  $('live-banner').classList.add('hidden');
  live.lastCallKey = {p1: '', p2: ''};
  localStorage.setItem(HAS_BATTLED_KEY, '1');
  // Doubles games resolve well before this; not a viewer-facing knob.
  const maxTurns = 50;
  const moveDelayMs = Number($('setup-delay').value) || 1400;
  // The clean flow: pick two models, press start, and all you see is the
  // native client. Esc brings the full arena back at any time.
  live.autoTheater = true;
  void liveCommand({
    command: 'start',
    agentP1: $('setup-p1').value.trim() || 'standin',
    agentP2: $('setup-p2').value.trim() || 'standin',
    maxTurns,
    moveDelayMs,
    // Spectating pace: leave generous headroom so slow models and watchable
    // move delays never hit the runner timeout mid-match.
    timeoutMs: Math.min(7200000, Math.max(300000, maxTurns * (moveDelayMs + 8000) * 4)),
    // Exhibition mode: arena matches are for watching, so a provider failing
    // repeatedly on one decision yields a labeled safe fallback move instead
    // of a dead match. The artifact is honestly marked validBenchmark: false;
    // CLI/ladder benchmark runs stay strict.
    allowFallback: true,
    openrouterKey: storedKey() || undefined,
  });
});
// The demo: two built-in players, no key, instant start — so a first-time
// visitor can see exactly what a battle looks like before pasting anything.
$('live-demo').addEventListener('click', () => {
  $('live-banner').classList.add('hidden');
  live.lastCallKey = {p1: '', p2: ''};
  localStorage.setItem(HAS_BATTLED_KEY, '1');
  live.autoTheater = true;
  void liveCommand({
    command: 'start',
    agentP1: 'standin',
    agentP2: 'standin',
    maxTurns: 50,
    moveDelayMs: 900,
    timeoutMs: 900000,
    allowFallback: true,
  });
});

$('live-pause').addEventListener('click', () => void liveCommand({command: 'pause'}));
$('live-resume').addEventListener('click', () => void liveCommand({command: 'resume'}));
$('live-stop').addEventListener('click', () => void liveCommand({command: 'stop'}));

// Model picker: every structured-output-capable OpenRouter model, straight
// from the live catalog, typeable/searchable via the shared datalist.
async function loadModelOptions() {
  try {
    const response = await fetch('/api/models');
    const payload = await response.json();
    const datalist = $('model-options');
    datalist.replaceChildren();
    for (const spec of ['standin', 'heuristic']) {
      datalist.appendChild(new Option('', spec));
    }
    for (const model of payload.models || []) {
      const option = document.createElement('option');
      option.value = `openrouter:${model.id}:low`;
      option.label = `${model.name} · $${model.promptPricePerM}/M in · $${model.completionPricePerM}/M out`;
      datalist.appendChild(option);
    }
  } catch {
    // presets still work without the catalog
  }
}
void loadModelOptions();

// Enter in either picker starts the match — the card behaves like a form.
for (const id of ['setup-p1', 'setup-p2']) {
  $(id).addEventListener('keydown', event => {
    if (event.key === 'Enter' && !$('live-start').disabled) $('live-start').click();
  });
}

for (const row of document.querySelectorAll('.preset-row')) {
  const target = row.dataset.target;
  for (const preset of AGENT_PRESETS) {
    const button = el('button', '', preset);
    button.type = 'button';
    button.addEventListener('click', () => {
      $(target).value = preset;
      renderLiveRun();
    });
    row.appendChild(button);
  }
}

/* ================================================================
   REPLAY
   ================================================================ */

class ReplayEngine {
  constructor(artifact, ui) {
    this.artifact = artifact;
    this.ui = ui;
    this.generation = 0;
    this.playing = false;
    this.busy = false;
    this.speed = ui.speed;
    this.pointer = 0;
    this.decisionsDone = 0;
    this.turn = 0;
    // frames: 'base' = Player 1's full native client (field + log + controls);
    // 'overlay' = Player 2's native controls, shown over the controls region.
    this.frames = {base: null, overlay: null};
    this.readyResolvers = {base: null, overlay: null};
    this.choiceResolvers = {p1: null, p2: null};
    this.buildTimeline();
  }

  buildTimeline() {
    // Player chunks in chronological capture order: Player 1's stream drives
    // the base client (it carries the full battle view plus P1's requests),
    // Player 2's stream drives the controls overlay. Dedupe per (role, chunk)
    // so artifacts recorded before the server double-feed fix stay clean.
    const seen = new Set();
    this.timeline = [];
    for (const entry of this.artifact.protocol || []) {
      const role = entry.role;
      if (role !== 'p1' && role !== 'p2') continue;
      const key = `${role} ${entry.chunk}`;
      if (seen.has(key)) continue;
      seen.add(key);
      this.timeline.push({
        role,
        chunk: entry.chunk,
        isRequest: entry.chunk.includes('|request|'),
      });
    }

    // Anchor each recorded decision to the exact request that produced it:
    // direct rqid lookup when the artifact recorded a requestId, monotonic
    // next-unused fallback only for legacy artifacts without one. Wait
    // requests never produce decisions, so they are excluded from the pool.
    const requestPool = {p1: [], p2: []};
    const requestByRqid = {p1: new Map(), p2: new Map()};
    for (const [index, entry] of this.timeline.entries()) {
      if (!entry.isRequest || entry.chunk.includes('"wait":true')) continue;
      const match = entry.chunk.match(/"rqid":(\d+)/);
      const item = {index, rqid: match ? Number(match[1]) : null, used: false};
      requestPool[entry.role].push(item);
      if (item.rqid != null && !requestByRqid[entry.role].has(item.rqid)) {
        requestByRqid[entry.role].set(item.rqid, item);
      }
    }

    this.decisions = [];
    this.decisionsByAnchor = new Map();
    for (const [ordinal, action] of (this.artifact.actions || []).entries()) {
      const role = action.role;
      if (!ROLES.includes(role)) continue;
      let anchor = action.requestId != null ? requestByRqid[role].get(Number(action.requestId)) : null;
      if (anchor?.used) anchor = null;
      if (!anchor) anchor = requestPool[role].find(item => !item.used);
      if (!anchor) continue;
      anchor.used = true;
      this.decisions.push({
        ordinal,
        role,
        turn: action.turn,
        choice: action.choice,
        label: action.action?.label || '',
        call: this.artifact.modelCalls?.[action.callIndex] || null,
        anchorIndex: anchor.index,
      });
      this.decisionsByAnchor.set(anchor.index, this.decisions.at(-1));
    }
  }

  destroy() {
    this.generation += 1;
    this.playing = false;
    for (const name of ['base', 'overlay']) {
      this.frames[name]?.remove();
      this.frames[name] = null;
    }
    this.setControlsSide('p1');
  }

  frameName(source) {
    for (const name of ['base', 'overlay']) {
      if (this.frames[name]?.contentWindow === source) return name;
    }
    return null;
  }

  frameForRole(role) {
    return role === 'p2' ? 'overlay' : 'base';
  }

  setControlsSide(side) {
    setControlsOwner($('replay-overlay'), $('replay-controls-owner'), side);
  }

  post(name, payload) {
    this.frames[name]?.contentWindow?.postMessage({scope: 'showdown-arena', ...payload}, '*');
  }

  onFrameReady(source) {
    const name = this.frameName(source);
    if (name && this.readyResolvers[name]) {
      this.readyResolvers[name]();
      this.readyResolvers[name] = null;
    }
  }

  onChoiceDone(source) {
    const role = this.frameName(source) === 'overlay' ? 'p2' : 'p1';
    if (this.choiceResolvers[role]) {
      this.choiceResolvers[role]();
      this.choiceResolvers[role] = null;
    }
  }

  frameReady(name) {
    return new Promise(resolve => {
      this.readyResolvers[name] = resolve;
    });
  }

  async createFrames() {
    const viewport = $('replay-viewport-battle');
    const overlayHost = $('replay-overlay');
    for (const iframe of viewport.querySelectorAll(':scope > iframe')) iframe.remove();
    overlayHost.replaceChildren();
    this.setControlsSide('p1');

    const readiness = [this.frameReady('base'), this.frameReady('overlay')];
    const base = document.createElement('iframe');
    base.title = 'Replay battle view (Player 1 native client)';
    base.src = '/showdown-frame.html?role=p1&mode=replay&theme=dark';
    this.frames.base = base;
    viewport.appendChild(base);

    const overlay = document.createElement('iframe');
    overlay.title = 'Player 2 native controls (replay)';
    overlay.src = '/showdown-frame.html?role=p2&mode=replay&controls=1&theme=dark';
    this.frames.overlay = overlay;
    overlayHost.appendChild(overlay);

    scaleAllViewports();
    await Promise.race([Promise.all(readiness), sleep(8000)]);
  }

  async resetFrames() {
    const readiness = ['base', 'overlay'].map(name => this.frameReady(name));
    for (const name of ['base', 'overlay']) this.post(name, {type: 'sd-reset'});
    this.setControlsSide('p1');
    await Promise.race([Promise.all(readiness), sleep(8000)]);
  }

  applyEntry(entry, instant) {
    this.post(this.frameForRole(entry.role), {type: 'sd-protocol', chunk: entry.chunk, instant});
    if (entry.role === 'p1') this.trackTurn(entry.chunk);
  }

  chunkDelay(entry) {
    if (entry.role !== 'p1') return 60;
    const lines = entry.chunk.match(/\|(move|switch|drag|faint|-terastallize)\|/g);
    if (lines?.length) return Math.min(6000, 500 + lines.length * 850);
    if (entry.chunk.includes('|teamsize|') || entry.chunk.includes('|player|')) return 400;
    return entry.isRequest ? 120 : 200;
  }

  trackTurn(chunk) {
    for (const match of chunk.matchAll(/\|turn\|(\d+)/g)) {
      this.turn = Math.max(this.turn, Number(match[1]));
    }
    if (chunk.includes('|win|')) {
      const winner = chunk.match(/\|win\|([^\n|]+)/)?.[1] || '';
      this.ui.onMatchEnd(winner, this.turn);
    }
  }

  async waitForChoiceDone(role) {
    await Promise.race([
      new Promise(resolve => {
        this.choiceResolvers[role] = resolve;
      }),
      sleep(10000),
    ]);
    this.choiceResolvers[role] = null;
  }

  async stepOnce(generation) {
    const entry = this.timeline[this.pointer];
    if (!entry) return false;
    const anchorIndex = this.pointer;
    this.applyEntry(entry, false);
    this.pointer += 1;
    const decision = this.decisionsByAnchor.get(anchorIndex);
    if (decision) {
      // Alternate the visible control section to the player about to act.
      this.setControlsSide(decision.role);
      this.ui.onDecision(decision);
      await sleep(2400 / this.speed);
      if (generation !== this.generation) return false;
      // Press the real native buttons in that player's client.
      this.post(this.frameForRole(decision.role), {type: 'sd-choice', choice: decision.choice});
      await this.waitForChoiceDone(decision.role);
      if (generation !== this.generation) return false;
      this.decisionsDone = decision.ordinal + 1;
      if (decision.role === 'p2') {
        // Give the submitted state a beat, then return to the base client so
        // the field plays the turn unobstructed.
        await sleep(700 / this.speed);
        this.setControlsSide('p1');
      }
      await sleep(250 / this.speed);
    } else {
      await sleep(this.chunkDelay(entry) / this.speed);
    }
    this.ui.onProgress(this);
    return Boolean(decision);
  }

  async play() {
    if (this.busy) {
      this.playing = true;
      return;
    }
    this.playing = true;
    this.busy = true;
    const generation = this.generation;
    while (this.playing && generation === this.generation && this.pointer < this.timeline.length) {
      await this.stepOnce(generation);
    }
    this.busy = false;
    if (generation === this.generation && this.pointer >= this.timeline.length) {
      this.playing = false;
      this.ui.onPlaybackFinished(this);
    }
  }

  pause() {
    this.playing = false;
  }

  async stepForward() {
    if (this.busy) return;
    this.playing = false;
    this.busy = true;
    const generation = this.generation;
    while (generation === this.generation && this.pointer < this.timeline.length) {
      const hadDecision = await this.stepOnce(generation);
      if (hadDecision) break;
    }
    this.busy = false;
  }

  async seekToDecision(target) {
    this.generation += 1;
    const generation = this.generation;
    this.playing = false;
    while (this.busy) await sleep(60);
    if (generation !== this.generation) return;
    this.busy = true;
    this.ui.onSeekStart();
    await this.resetFrames();
    this.pointer = 0;
    this.decisionsDone = 0;
    this.turn = 0;
    const clamped = Math.max(0, Math.min(target, this.decisions.length));
    const stopIndex = !this.decisions.length
      ? (clamped > 0 ? this.timeline.length : 0)
      : clamped >= this.decisions.length
        ? this.timeline.length
        : this.decisions[clamped].anchorIndex;
    let lastDecision = null;
    while (this.pointer < stopIndex) {
      const entry = this.timeline[this.pointer];
      this.applyEntry(entry, true);
      const decision = this.decisionsByAnchor.get(this.pointer);
      if (decision) {
        lastDecision = decision;
        this.decisionsDone = decision.ordinal + 1;
      }
      this.pointer += 1;
      if (this.pointer % 24 === 0) await sleep(25);
    }
    if (lastDecision) this.ui.onDecision(lastDecision, {instant: true});
    this.busy = false;
    this.ui.onProgress(this);
  }
}

function isPracticeReplay(replay) {
  const providers = [replay.agents?.p1?.provider, replay.agents?.p2?.provider];
  return providers.every(provider => provider === 'standin' || provider === 'heuristic' || !provider);
}

const replayUI = {
  engine: null,
  replays: [],
  speed: 1,
  loadedOnce: false,
  showPractice: false,

  onShow() {
    if (!this.loadedOnce) {
      this.loadedOnce = true;
      void this.refreshList();
    }
    scaleAllViewports();
  },

  async refreshList() {
    const grid = $('replay-grid');
    grid.replaceChildren(el('div', 'replay-empty-note', 'Loading replays…'));
    try {
      const response = await fetch(`/api/replays?session=${encodeURIComponent(SESSION_ID)}`);
      const payload = await response.json();
      this.replays = payload.replays || [];
    } catch {
      this.replays = [];
    }
    this.renderGrid();
  },

  renderGrid() {
    const grid = $('replay-grid');
    grid.replaceChildren();
    const real = this.replays.filter(replay => !isPracticeReplay(replay));
    const practice = this.replays.filter(isPracticeReplay);
    // Real model matches lead; practice (stand-in) matches sit behind a toggle
    // unless they are all there is.
    const showPractice = this.showPractice || !real.length;
    for (const replay of real) grid.appendChild(this.buildReplayCard(replay));
    if (showPractice) {
      for (const replay of practice) grid.appendChild(this.buildReplayCard(replay));
    }
    if (!real.length && !practice.length) {
      grid.appendChild(el('div', 'replay-empty-note', 'No recorded matches yet — run a live match first.'));
    }
    if (real.length && practice.length) {
      const toggle = el('button', 'replay-practice-toggle',
        this.showPractice ? 'Hide practice matches' : `Show ${practice.length} practice matches`);
      toggle.type = 'button';
      toggle.addEventListener('click', () => {
        this.showPractice = !this.showPractice;
        this.renderGrid();
      });
      grid.appendChild(toggle);
    }
  },

  buildReplayCard(replay) {
    const card = el('button', 'replay-card');
    card.type = 'button';
    card.dataset.href = replay.href;

    const match = el('div', 'rc-match');
    const p1Won = replay.result?.winner === 'Benchmark P1';
    const p2Won = replay.result?.winner === 'Benchmark P2';
    const name1 = el('span', `rc-name p1${p1Won ? ' won' : ''}`, shortName(replay.agents?.p1));
    const name2 = el('span', `rc-name p2${p2Won ? ' won' : ''}`, shortName(replay.agents?.p2));
    match.appendChild(name1);
    match.appendChild(el('span', 'rc-vs', 'vs'));
    match.appendChild(name2);
    card.appendChild(match);

    const bits = [];
    bits.push(`${replay.result?.turn ?? '?'} turns`);
    bits.push(`${replay.decisions} decisions`);
    const cost = compactCost(replay.usage?.costUsd);
    if (cost) bits.push(cost);
    const when = new Date(replay.startedAt);
    if (!Number.isNaN(when.getTime())) {
      bits.push(when.toLocaleDateString(undefined, {month: 'short', day: 'numeric'}) + ' · ' +
        when.toLocaleTimeString(undefined, {hour: '2-digit', minute: '2-digit'}));
    }
    card.appendChild(el('div', 'rc-meta', bits.join('  ·  ')));

    card.addEventListener('click', () => {
      for (const other of $('replay-grid').children) other.classList.remove('selected');
      card.classList.add('selected');
      void this.loadReplay(replay.href);
    });
    return card;
  },

  setTransportEnabled(enabled) {
    for (const id of ['rp-prev', 'rp-play', 'rp-next']) $(id).disabled = !enabled;
    $('replay-placeholder').classList.toggle('hidden', enabled);
  },

  async loadReplay(href) {
    this.engine?.destroy();
    this.engine = null;
    this.setTransportEnabled(false);
    $('replay-banner').classList.add('hidden');
    $('replay-plate-p1').classList.remove('winner');
    $('replay-plate-p2').classList.remove('winner');
    for (const role of ROLES) {
      renderMind($(`replay-mind-${role}`), null, {title: 'Recorded mind', placeholder: 'Loading replay…'});
      $(`replay-chip-${role}`).textContent = '';
    }
    if (!href) {
      setStatusPill($('replay-status'), 'idle', 'no replay');
      $('rp-pos').textContent = 'no replay loaded';
      return;
    }
    setStatusPill($('replay-status'), 'paused', 'loading');
    let artifact;
    try {
      const response = await fetch(href);
      artifact = await response.json();
    } catch {
      setStatusPill($('replay-status'), 'error', 'load failed');
      return;
    }
    renderPlate($('replay-plate-p1'), artifact.agents?.p1 || 'unknown');
    renderPlate($('replay-plate-p2'), artifact.agents?.p2 || 'unknown');
    document.title = `${shortName(artifact.agents?.p1)} vs ${shortName(artifact.agents?.p2)} (replay) — Showdown LLM Arena`;
    $('replay-who-p1').textContent = shortName(artifact.agents?.p1);
    $('replay-who-p2').textContent = shortName(artifact.agents?.p2);
    $('replay-turn').textContent = '–';

    this.engine = new ReplayEngine(artifact, this);
    this.setTransportEnabled(true);
    this.renderScrubDots();
    await this.engine.createFrames();
    for (const role of ROLES) {
      renderMind($(`replay-mind-${role}`), null, {title: 'Recorded mind', placeholder: 'Playback starting…'});
    }
    setStatusPill($('replay-status'), 'running', 'playing');
    $('rp-play').innerHTML = '&#9646;&#9646;';
    void this.engine.play();
  },

  renderScrubDots() {
    const dots = $('rp-scrub-dots');
    dots.replaceChildren();
    if (!this.engine) return;
    const total = this.engine.decisions.length;
    for (const [index, decision] of this.engine.decisions.entries()) {
      const dot = el('span', `scrub-dot ${decision.role}`);
      dot.style.left = `${((index + 0.5) / Math.max(1, total)) * 100}%`;
      dot.title = `T${decision.turn} ${decision.role.toUpperCase()} — ${decision.choice}`;
      dot.addEventListener('click', event => {
        event.stopPropagation();
        void this.seek(index);
      });
      dots.appendChild(dot);
    }
  },

  async seek(index) {
    if (!this.engine) return;
    const wasPlaying = this.engine.playing || this.engine.busy;
    await this.engine.seekToDecision(index);
    if (wasPlaying) {
      setStatusPill($('replay-status'), 'running', 'playing');
      $('rp-play').innerHTML = '&#9646;&#9646;';
      void this.engine.play();
    } else {
      setStatusPill($('replay-status'), 'paused', 'paused');
      $('rp-play').innerHTML = '&#9654;';
    }
  },

  onDecision(decision, options = {}) {
    const call = decision.call || {};
    renderMind($(`replay-mind-${decision.role}`), {
      analysis: call.analysis,
      choice: decision.choice,
      reason: call.reason,
      valid: call.valid,
      fallback: call.fallback,
      usage: call.usage,
      prompt: call.prompt,
      rawText: call.rawText,
      turn: decision.turn,
    }, {title: 'Recorded mind'});
    const chip = $(`replay-chip-${decision.role}`);
    chip.textContent = decision.label || decision.choice;
    if (!options.instant) {
      chip.classList.add('fresh');
      setTimeout(() => chip.classList.remove('fresh'), 3000);
    }
  },

  onProgress(engine) {
    $('replay-turn').textContent = engine.turn || '–';
    const total = engine.decisions.length;
    $('rp-pos').textContent = `decision ${engine.decisionsDone}/${total} · turn ${engine.turn || 0}`;
    $('rp-scrub').setAttribute('aria-valuemax', String(total));
    $('rp-scrub').setAttribute('aria-valuenow', String(engine.decisionsDone));
    $('rp-scrub-fill').style.width = `${total ? (engine.decisionsDone / total) * 100 : 0}%`;
    const dots = [...$('rp-scrub-dots').children];
    for (const [index, dot] of dots.entries()) {
      dot.classList.toggle('done', index < engine.decisionsDone);
    }
  },

  onSeekStart() {
    setStatusPill($('replay-status'), 'paused', 'seeking…');
    $('replay-banner').classList.add('hidden');
  },

  onMatchEnd(winner, turn) {
    const artifact = this.engine?.artifact;
    const side = winner === 'Benchmark P1' ? 'p1' : winner === 'Benchmark P2' ? 'p2' : null;
    $('replay-plate-p1').classList.toggle('winner', side === 'p1');
    $('replay-plate-p2').classList.toggle('winner', side === 'p2');
    const banner = $('replay-banner');
    banner.textContent = side
      ? `🏆 ${shortName(artifact?.agents?.[side])} wins in ${turn} turns`
      : `Match over after ${turn} turns`;
    banner.classList.remove('hidden');
  },

  onPlaybackFinished() {
    setStatusPill($('replay-status'), 'finished', 'finished');
    $('rp-play').innerHTML = '&#9654;';
  },

  onFrameReady(source) {
    this.engine?.onFrameReady(source);
  },

  onChoiceDone(source) {
    this.engine?.onChoiceDone(source);
  },
};

$('replay-refresh').addEventListener('click', () => void replayUI.refreshList());

$('rp-play').addEventListener('click', () => {
  const engine = replayUI.engine;
  if (!engine) return;
  if (engine.playing) {
    engine.pause();
    setStatusPill($('replay-status'), 'paused', 'paused');
    $('rp-play').innerHTML = '&#9654;';
  } else {
    setStatusPill($('replay-status'), 'running', 'playing');
    $('rp-play').innerHTML = '&#9646;&#9646;';
    void engine.play();
  }
});

$('rp-next').addEventListener('click', () => {
  const engine = replayUI.engine;
  if (!engine) return;
  setStatusPill($('replay-status'), 'running', 'stepping');
  void engine.stepForward().then(() => {
    if (!engine.playing) setStatusPill($('replay-status'), 'paused', 'paused');
    $('rp-play').innerHTML = '&#9654;';
  });
});

$('rp-prev').addEventListener('click', () => {
  const engine = replayUI.engine;
  if (!engine) return;
  void replayUI.seek(Math.max(0, engine.decisionsDone - 2));
});

$('rp-scrub').addEventListener('click', event => {
  const engine = replayUI.engine;
  if (!engine || !engine.decisions.length) return;
  const rect = event.currentTarget.getBoundingClientRect();
  const fraction = (event.clientX - rect.left) / rect.width;
  void replayUI.seek(Math.round(fraction * engine.decisions.length));
});

$('rp-scrub').addEventListener('keydown', event => {
  const engine = replayUI.engine;
  if (!engine || !engine.decisions.length) return;
  if (event.key === 'ArrowLeft') {
    event.preventDefault();
    void replayUI.seek(Math.max(0, engine.decisionsDone - 2));
  }
  if (event.key === 'ArrowRight') {
    event.preventDefault();
    void replayUI.seek(Math.min(engine.decisions.length - 1, engine.decisionsDone));
  }
});

for (const button of document.querySelectorAll('.speed-group button')) {
  button.addEventListener('click', () => {
    for (const other of document.querySelectorAll('.speed-group button')) other.setAttribute('aria-pressed', 'false');
    button.setAttribute('aria-pressed', 'true');
    replayUI.speed = Number(button.dataset.speed) || 1;
    if (replayUI.engine) replayUI.engine.speed = replayUI.speed;
  });
}

/* ---------------- boot ---------------- */

for (const role of ROLES) {
  renderMind($(`live-mind-${role}`), null, {
    title: 'Model mind',
    placeholder: 'Start a match to watch this model think.',
  });
  renderMind($(`replay-mind-${role}`), null, {
    title: 'Recorded mind',
    placeholder: 'Pick a recorded match above.',
  });
}

replayUI.setTransportEnabled(false);
updatePipeline();
if (!localStorage.getItem(HAS_BATTLED_KEY)) {
  $('live-stage').classList.add('hidden');
  $('live-ticker').classList.add('hidden');
}
void restoreKeyPanel();
applySound();
connectSpectatorSocket();
void pollLiveRun();
setInterval(pollLiveRun, 1000);
