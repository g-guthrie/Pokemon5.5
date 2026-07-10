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
// Each analysis field gets its own question-shaped card in the Model Mind,
// popping in one after another as the thought process fills.
const ANALYSIS_SECTIONS = [
  ['gameStateSummary', '\u{1F9ED}', 'What is the state of the game?'],
  ['winConditions', '\u{1F3C6}', 'How do we win?'],
  ['loseConditions', '⚠️', 'How could we lose?'],
  ['setupLines', '\u{1F4C8}', 'What setups are promising?'],
  ['sweepPlans', '\u{1F4A5}', 'What could sweep?'],
  ['safeSwitches', '\u{1F501}', 'Safe pivots?'],
  ['opponentLikelyPlan', '\u{1F52E}', 'What is their plan?'],
  ['biggestThreats', '\u{1F3AF}', 'Biggest threats right now?'],
  ['riskAssessment', '\u{1F3B2}', 'What is the risk?'],
  ['candidateChoices', '⚖️', 'Candidate moves compared'],
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

function buildMonChip(mon) {
  const hp = hpParts(mon.condition);
  const fainted = hp.fainted || mon.fainted;
  const chip = el('div', `mon-chip${fainted ? ' fainted' : ''}${mon.active ? ' on-field' : ''}`);
  const nameRow = el('div', 'mon-name');
  nameRow.appendChild(el('b', '', mon.name || mon.species || '?'));
  if (mon.active) nameRow.appendChild(el('span', 'mon-badge field', 'on field'));
  if (hp.status || mon.status) nameRow.appendChild(el('span', 'mon-badge status', (hp.status || mon.status).toUpperCase()));
  if (mon.terastallized) nameRow.appendChild(el('span', 'mon-badge tera', 'TERA'));
  chip.appendChild(nameRow);
  const bar = el('div', `mon-hp${fainted ? '' : hp.pct <= 25 ? ' low' : hp.pct <= 55 ? ' mid' : ''}`);
  const fill = el('i');
  fill.style.width = `${fainted ? 0 : hp.pct}%`;
  bar.appendChild(fill);
  chip.appendChild(bar);
  const detailBits = [];
  if (fainted) detailBits.push('fainted');
  if (mon.item) detailBits.push(mon.item + (mon.itemConsumed ? ' (used)' : ''));
  if (mon.ability) detailBits.push(mon.ability);
  const moves = mon.moves || mon.movesRevealed || [];
  if (moves.length) detailBits.push(mon.movesRevealed ? `seen: ${moves.join(', ')}` : moves.join(', '));
  const detail = el('div', 'mon-detail', detailBits.join(' · '));
  detail.title = detailBits.join('\n');
  chip.appendChild(detail);
  return chip;
}

// The "known context" strip: exactly what this player can see — its own full
// team, and only what the opponent has revealed so far.
function buildBoard(board) {
  const wrap = el('div', 'mind-board');
  const rows = [
    ['\u{1F9EC}', 'Your team', board.own || [], 'own'],
    ['\u{1F441}', 'Opponent revealed', board.opponentSeen || [], 'foe'],
  ];
  for (const [icon, label, mons, kind] of rows) {
    const row = el('div', `board-row ${kind}`);
    const head = el('div', 'board-label');
    head.appendChild(el('span', 'board-icon', icon));
    head.appendChild(el('span', '', label));
    if (kind === 'foe') head.appendChild(el('span', 'board-count', `${mons.length}/6 seen`));
    row.appendChild(head);
    const strip = el('div', 'board-strip');
    if (!mons.length) strip.appendChild(el('div', 'board-empty', 'nothing revealed yet'));
    for (const mon of mons) strip.appendChild(buildMonChip(mon));
    row.appendChild(strip);
    wrap.appendChild(row);
  }
  const fieldBits = [board.weather, board.terrain].filter(Boolean);
  if (fieldBits.length) {
    wrap.appendChild(el('div', 'board-field', `☁️ ${fieldBits.join(' · ')}`));
  }
  return wrap;
}

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

  const animate = Boolean(options.animate);
  let popIndex = 0;
  const pop = node => {
    if (!animate) return node;
    node.classList.add('pop-in');
    node.style.animationDelay = `${Math.min(popIndex * 90, 1100)}ms`;
    popIndex += 1;
    return node;
  };

  if (data.board && (data.board.own?.length || data.board.opponentSeen?.length)) {
    container.appendChild(pop(buildBoard(data.board)));
  }

  const sections = el('div', 'mind-sections');
  const analysis = data.analysis || {};
  for (const [key, icon, question] of ANALYSIS_SECTIONS) {
    const items = Array.isArray(analysis[key]) ? analysis[key].filter(Boolean) : [];
    if (!items.length) continue;
    const section = pop(el('div', 'mind-section'));
    const header = el('h4');
    header.appendChild(el('span', 'section-icon', icon));
    header.appendChild(el('span', '', question));
    section.appendChild(header);
    const list = el('ul');
    const cap = key === 'candidateChoices' ? 8 : 6;
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
const dexCards = {moves: new Map(), species: new Map(), pending: null};

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
      if (part.allyTargetSlot != null) entry.targets.add(Number(part.allyTargetSlot));
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
  const plan = deckPlanFromObservation(observation);
  host.dataset.side = side;
  const deck = el('div', 'deck');
  if (!plan || (!plan.slots.length && !plan.switches.length)) {
    deck.appendChild(el('div', 'deck-waiting', options.idleText || 'Waiting for the next decision…'));
    host.replaceChildren(deck);
    return;
  }
  const moveNames = plan.slots.flatMap(slot => slot.moves.map(move => move.name));
  const speciesNames = [
    ...plan.slots.map(slot => slot.mon?.species || slot.mon?.name),
    ...plan.switches.map(entry => entry.mon?.species || entry.pokemon),
    ...(observation.opponent?.activePokemon || []).map(mon => mon?.species || mon?.name),
  ];
  await ensureDexCards(moveNames, speciesNames);

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
  host.replaceChildren(deck);
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

// Theater reserves lateral margins for the two Model Mind columns when the
// screen is wide enough; the same numbers position the columns in CSS.
function theaterSideReserve() {
  if (window.innerWidth < 1160) return 0;
  return Math.min(window.innerWidth * 0.23, 380) + 28;
}

function scaleViewport(viewport) {
  if (!viewport.isConnected || !viewport.offsetParent) return;
  if (document.body.classList.contains('theater')) {
    // Center the native client between the flanking mind columns,
    // preserving its aspect ratio.
    const reserve = theaterSideReserve();
    const availableWidth = Math.max(420, window.innerWidth - reserve * 2);
    const scale = Math.min(availableWidth / CLIENT_BASE_WIDTH, (window.innerHeight - 16) / CLIENT_BASE_HEIGHT);
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
    if (message.type === 'sd-controls-top') {
      // Measured seam between the battle field and the controls region.
      $('live-deck').style.setProperty('--deck-top', `${message.top}px`);
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
  if (message.type === 'sd-controls-top') {
    $('replay-deck').style.setProperty('--deck-top', `${message.top}px`);
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
  for (const player of ROLES) syncPickerFromSpec(player);
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
  renderLiveRun();
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
  // p2 has no frame anymore: its presses land on the decision deck.
  frameReady: {p1: false, p2: true},
  // Per-role request observations from the role sockets, so the deck can
  // render exactly the request each queued press answered (keyed by rqid).
  requests: {p1: new Map(), p2: new Map()},
  latestRequest: {p1: null, p2: null},
  deckShown: '',
  log: [],
};
window.__arenaLive = live;

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
  if (rqid != null) {
    live.requests[role].set(Number(rqid), observation);
    if (live.requests[role].size > 10) {
      live.requests[role].delete(live.requests[role].keys().next().value);
    }
  }
  const actionable = !observation.waiting && !observation.ended && (observation.legalActions || []).length > 0;
  live.pending[role] = actionable;
  liveIdleView();
  void pumpPressQueue();
}

// With no press animation in flight, show whichever player still owes a
// decision on the deck.
function liveIdleView() {
  if (live.animating) return;
  const side = live.pending.p2 && !live.pending.p1 ? 'p2' : 'p1';
  setLiveControlsOwner(side);
  const observation = live.latestRequest[side];
  const key = `${side}|${observation?.requestId ?? 'none'}`;
  if (key !== live.deckShown) {
    live.deckShown = key;
    void renderDeck($('live-deck'), observation, side);
  }
}

// Each role socket delivers that player's private request observations —
// the same structured choice space the model sees — to drive the deck.
function connectDeckSocket(role) {
  const socket = new WebSocket(`${wsProtocol}//${location.host}/ws?role=${role}&battleId=${encodeURIComponent(BATTLE_ID)}`);
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
        // Re-enact the press on the decision deck, on exactly the request
        // this choice answered.
        setLiveControlsOwner(press.role);
        const observation = (press.rqid != null && live.requests[press.role].get(Number(press.rqid))) ||
          live.latestRequest[press.role];
        live.deckShown = `${press.role}|${observation?.requestId ?? 'none'}`;
        await renderDeck($('live-deck'), observation, press.role);
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
      live.frameReady = {p1: false, p2: true};
      live.requests.p1.clear();
      live.requests.p2.clear();
      live.latestRequest = {p1: null, p2: null};
      live.deckShown = '';
      live.choiceWaiters.p1?.resolve();
      live.choiceWaiters.p2?.resolve();
      setLiveControlsOwner('p1');
      void renderDeck($('live-deck'), null, 'p1', {idleText: 'New battle — waiting for the first decision…'});
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

  updatePipeline();
  $('live-start').disabled = active;
  $('live-demo').disabled = active;
  $('live-pause').disabled = !active || run.paused;
  $('live-resume').disabled = !active || !run.paused;
  $('live-stop').disabled = !active;
  // The setup card is the idle state; during a match the stage is the page.
  // In theater the intro greets only a fresh page — once a battle has taken
  // the stage it never barges back over the final board (the Dashboard
  // button has the full setup).
  $('live-setup-card').classList.toggle('hidden', active || (theaterOn() && Boolean(run)));
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
        board: run?.lastBoards?.[role] || null,
        turn: action?.turn ?? run?.currentTurn ?? null,
      }, {title: 'Model mind', animate: true});
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
    // Surface the winner banner where the viewer already is — the theater
    // stays up; the Dashboard button has the full post-match detail.
    live.wasActive = false;
    const winner = run.result.winner;
    const side = run.result.winnerRole
      || (winner === 'Benchmark P1' ? 'p1' : winner === 'Benchmark P2' ? 'p2' : null);
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
const EFFORTS = ['low', 'medium', 'high'];
const pickerCatalog = new Map(); // provider slug → [{id, label}]

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
    const payload = await response.json();
    pickerCatalog.clear();
    for (const model of payload.models || []) {
      const slug = String(model.id).split('/')[0];
      if (!pickerCatalog.has(slug)) pickerCatalog.set(slug, []);
      pickerCatalog.get(slug).push({id: model.id, label: catalogModelLabel(model)});
    }
    for (const models of pickerCatalog.values()) {
      models.sort((a, b) => a.label.localeCompare(b.label));
    }
  } catch {
    // built-in players still work without the catalog
  }
  for (const player of ROLES) buildPicker(player);
}

function orderedProviderSlugs() {
  const rest = [...pickerCatalog.keys()].filter(slug => !FEATURED_PROVIDERS.includes(slug)).sort();
  return [...FEATURED_PROVIDERS.filter(slug => pickerCatalog.has(slug)), ...rest];
}

function buildPicker(player) {
  const providerSelect = $(`pick-provider-${player}`);
  providerSelect.replaceChildren();
  providerSelect.appendChild(new Option('Built-in', 'built-in'));
  for (const slug of orderedProviderSlugs()) {
    providerSelect.appendChild(new Option(providerLabel(slug), slug));
  }
  syncPickerFromSpec(player);
}

function populatePickerModels(player, providerSlug, selectedId) {
  const modelSelect = $(`pick-model-${player}`);
  modelSelect.replaceChildren();
  if (providerSlug === 'built-in') {
    modelSelect.appendChild(new Option('standin · free demo player', 'standin'));
    modelSelect.appendChild(new Option('heuristic', 'heuristic'));
  } else {
    for (const model of pickerCatalog.get(providerSlug) || []) {
      modelSelect.appendChild(new Option(model.label, model.id));
    }
  }
  if (selectedId) modelSelect.value = selectedId;
  if (!modelSelect.value && modelSelect.options.length) modelSelect.selectedIndex = 0;
}

function populatePickerEfforts(player, selected) {
  const effortSelect = $(`pick-effort-${player}`);
  effortSelect.replaceChildren();
  for (const effort of EFFORTS) effortSelect.appendChild(new Option(effort, effort));
  effortSelect.value = EFFORTS.includes(selected) ? selected : 'low';
  effortSelect.disabled = $(`pick-provider-${player}`).value === 'built-in';
}

function applyPickerToSpec(player) {
  const provider = $(`pick-provider-${player}`).value;
  const model = $(`pick-model-${player}`).value;
  const effort = $(`pick-effort-${player}`).value || 'low';
  $(`setup-${player}`).value = provider === 'built-in' ? (model || 'standin') : `openrouter:${model}:${effort}`;
  renderLiveRun();
}

// The raw spec input stays authoritative (Advanced can edit it directly);
// the picker mirrors it.
function syncPickerFromSpec(player) {
  const spec = $(`setup-${player}`).value.trim();
  const providerSelect = $(`pick-provider-${player}`);
  if (!spec.startsWith('openrouter:')) {
    providerSelect.value = 'built-in';
    populatePickerModels(player, 'built-in', spec === 'heuristic' ? 'heuristic' : 'standin');
    populatePickerEfforts(player, 'low');
    return;
  }
  const parts = spec.split(':');
  const effort = parts.length > 2 && EFFORTS.includes(parts.at(-1)) ? parts.pop() : 'low';
  const modelId = parts.slice(1).join(':');
  const slug = modelId.split('/')[0];
  providerSelect.value = pickerCatalog.has(slug) ? slug : 'built-in';
  populatePickerModels(player, providerSelect.value, modelId);
  populatePickerEfforts(player, effort);
}

for (const player of ROLES) {
  $(`pick-provider-${player}`).addEventListener('change', () => {
    populatePickerModels(player, $(`pick-provider-${player}`).value);
    populatePickerEfforts(player, $(`pick-effort-${player}`).value);
    applyPickerToSpec(player);
  });
  $(`pick-model-${player}`).addEventListener('change', () => applyPickerToSpec(player));
  $(`pick-effort-${player}`).addEventListener('change', () => applyPickerToSpec(player));
  $(`setup-${player}`).addEventListener('change', () => {
    syncPickerFromSpec(player);
    renderLiveRun();
  });
}

void loadModelCatalog();

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
    // One frame: Player 1's full native client (field + log; controls hidden
    // — the decision deck overlays that region for both players).
    this.frames = {base: null};
    this.readyResolvers = {base: null};
    this.choiceResolvers = {p1: null};
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
        observationIndex: action.observationIndex ?? null,
        anchorIndex: anchor.index,
      });
      this.decisionsByAnchor.set(anchor.index, this.decisions.at(-1));
    }
  }

  destroy() {
    this.generation += 1;
    this.playing = false;
    this.frames.base?.remove();
    this.frames.base = null;
    this.setControlsSide('p1');
    $('replay-deck').classList.add('hidden');
  }

  frameName(source) {
    return this.frames.base?.contentWindow === source ? 'base' : null;
  }

  setControlsSide(side) {
    setControlsOwner($('replay-deck'), $('replay-controls-owner'), side);
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
    if (this.frameName(source) === 'base' && this.choiceResolvers.p1) {
      this.choiceResolvers.p1();
      this.choiceResolvers.p1 = null;
    }
  }

  frameReady(name) {
    return new Promise(resolve => {
      this.readyResolvers[name] = resolve;
    });
  }

  // The recorded PlayerObservation this decision was made from — the deck
  // renders the exact choice space the model saw.
  observationForDecision(decision) {
    return this.artifact.observations?.[decision?.observationIndex]?.observation || null;
  }

  async createFrames() {
    const viewport = $('replay-viewport-battle');
    for (const iframe of viewport.querySelectorAll(':scope > iframe')) iframe.remove();
    $('replay-deck').classList.remove('hidden');
    void renderDeck($('replay-deck'), null, 'p1', {idleText: 'Replay starting…'});
    this.setControlsSide('p1');

    const readiness = [this.frameReady('base')];
    const base = document.createElement('iframe');
    base.title = 'Replay battle view (Player 1 native client)';
    base.src = '/showdown-frame.html?role=p1&mode=replay&theme=dark&hidecontrols=1';
    this.frames.base = base;
    viewport.appendChild(base);

    scaleAllViewports();
    await Promise.race([Promise.all(readiness), sleep(8000)]);
  }

  async resetFrames() {
    const readiness = [this.frameReady('base')];
    this.post('base', {type: 'sd-reset'});
    this.setControlsSide('p1');
    void renderDeck($('replay-deck'), null, 'p1', {idleText: 'Rewinding…'});
    await Promise.race([Promise.all(readiness), sleep(8000)]);
  }

  applyEntry(entry, instant) {
    // Only Player 1's stream drives the client now; Player 2's recorded
    // protocol exists in the timeline purely as decision anchors.
    if (entry.role === 'p1') {
      this.post('base', {type: 'sd-protocol', chunk: entry.chunk, instant});
      this.trackTurn(entry.chunk);
    }
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
      // Show the acting player's recorded choice space on the deck and
      // re-enact the press on our buttons.
      this.setControlsSide(decision.role);
      await renderDeck($('replay-deck'), this.observationForDecision(decision), decision.role);
      this.ui.onDecision(decision);
      await sleep(1400 / this.speed);
      if (generation !== this.generation) return false;
      await animateDeckChoice($('replay-deck'), decision.choice);
      if (decision.role === 'p1') {
        // Keep the base client's request state exact (its own hidden
        // controls still receive the press instantly).
        this.post('base', {type: 'sd-choice', choice: decision.choice, instant: true});
        await this.waitForChoiceDone('p1');
      }
      if (generation !== this.generation) return false;
      this.decisionsDone = decision.ordinal + 1;
      if (decision.role === 'p2') {
        await sleep(500 / this.speed);
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
    if (lastDecision) {
      this.setControlsSide(lastDecision.role);
      void renderDeck($('replay-deck'), this.observationForDecision(lastDecision), lastDecision.role);
      this.ui.onDecision(lastDecision, {instant: true});
    }
    this.busy = false;
    this.ui.onProgress(this);
  }
}

// Replays carry full PlayerObservations in the artifact; distill the same
// known-context board the live server telemetry sends.
function boardFromObservation(observation) {
  if (!observation) return null;
  return {
    turn: observation.turn ?? null,
    weather: observation.field?.weather?.name || '',
    terrain: observation.field?.terrain?.name || '',
    own: (observation.self?.team || []).slice(0, 6).map(mon => ({
      name: mon.name || mon.species || '',
      species: mon.species || '',
      condition: mon.condition || '',
      active: Boolean(mon.active),
      item: mon.item || '',
      ability: mon.ability || '',
      teraType: mon.teraType || '',
      terastallized: Boolean(mon.terastallized),
      moves: (mon.moves || []).slice(0, 4),
    })),
    opponentSeen: (observation.opponent?.revealedTeam || [])
      .filter(mon => mon && mon.revealed)
      .slice(0, 6)
      .map(mon => ({
        name: mon.name || mon.species || '',
        species: mon.species || '',
        condition: mon.condition || '',
        active: Boolean(mon.active),
        fainted: Boolean(mon.fainted),
        status: mon.status || '',
        item: mon.item || mon.itemLastKnown || '',
        itemConsumed: Boolean(mon.itemConsumed),
        ability: mon.ability || '',
        teraType: mon.teraType || '',
        movesRevealed: (mon.movesRevealed || []).slice(0, 4),
      })),
  };
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
    const p1Won = replay.result?.winnerRole === 'p1' || replay.result?.winner === 'Benchmark P1';
    const p2Won = replay.result?.winnerRole === 'p2' || replay.result?.winner === 'Benchmark P2';
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
    const observationRecord = this.engine?.artifact?.observations?.[decision.observationIndex];
    renderMind($(`replay-mind-${decision.role}`), {
      analysis: call.analysis,
      choice: decision.choice,
      reason: call.reason,
      valid: call.valid,
      fallback: call.fallback,
      usage: call.usage,
      prompt: call.prompt,
      rawText: call.rawText,
      board: boardFromObservation(observationRecord?.observation),
      turn: decision.turn,
    }, {title: 'Recorded mind', animate: !options.instant});
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
    const names = artifact?.playerNames || {};
    const side = winner === names.p1 ? 'p1'
      : winner === names.p2 ? 'p2'
      : winner === 'Benchmark P1' ? 'p1' : winner === 'Benchmark P2' ? 'p2' : null;
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
// The navy theater is the site: client centered, minds flanking, the intro
// card floating above until a battle takes the stage.
setTheater(true);
void restoreKeyPanel();
applySound();
connectSpectatorSocket();
connectDeckSocket('p1');
connectDeckSocket('p2');
void renderDeck($('live-deck'), null, 'p1', {idleText: 'The decision deck lights up when a battle starts.'});
void pollLiveRun();
setInterval(pollLiveRun, 1000);
