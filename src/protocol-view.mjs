import {
  createCondition,
  createPublicEvent,
  touchCondition,
} from './observation.mjs';

export function createView(role) {
  return {
    role,
    turn: 0,
    timestamp: null,
    field: {
      weather: null,
      terrain: null,
      conditions: {},
    },
    sides: {
      self: createSideKnowledge(),
      opponent: createSideKnowledge(),
      p1: createSideKnowledge(),
      p2: createSideKnowledge(),
    },
    history: [],
  };
}

export function updateViewFromChunk(view, chunk) {
  for (const rawLine of chunk.split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('|request|')) continue;
    if (line.startsWith('|t:|')) {
      view.timestamp = Number(line.slice('|t:|'.length)) || view.timestamp;
      continue;
    }
    if (!line.startsWith('|')) continue;

    const parts = line.slice(1).split('|');
    const tag = parts[0];
    if (tag === 'turn') view.turn = Number(parts[1]) || view.turn;

    const event = eventFromProtocolLine(view, parts, line);
    if (event) {
      view.history.push(event);
      if (view.history.length > 500) view.history.shift();
    }

    applyKnowledgeEvent(view, parts);
  }
}

export function sideFromIdent(ident = '') {
  if (ident.startsWith('p1')) return 'p1';
  if (ident.startsWith('p2')) return 'p2';
  return null;
}

export function activeSlotFromIdent(ident = '') {
  const match = String(ident).match(/^p[1-4]([a-z])?:/);
  if (!match?.[1]) return null;
  return match[1].charCodeAt(0) - 96;
}

export function firstPublicActive(activeSlots = {}) {
  return Object.entries(activeSlots)
    .sort(([a], [b]) => Number(a) - Number(b))
    .map(([, mon]) => mon)
    .find(Boolean) || null;
}

export function cleanPokemonName(value = '') {
  return String(value).replace(/^p[1-4][a-z]?:\s*/, '').split(',')[0].trim();
}

function createSideKnowledge() {
  return {
    active: null,
    activeSlots: {},
    pokemon: {},
    sideConditions: {},
  };
}

function eventFromProtocolLine(view, parts, raw) {
  const tag = parts[0];
  const text = describeProtocolLine(parts);
  if (!text && tag !== 'turn') return null;
  return createPublicEvent(view, parts, raw, text);
}

function describeProtocolLine(parts) {
  const tag = parts[0];
  if (tag === 'start') return 'Battle started.';
  if (tag === 'turn') return `Turn ${parts[1]}.`;
  if (tag === 'switch') return `${cleanPokemonName(parts[1])} switched in (${parts[2] || 'unknown details'}).`;
  if (tag === 'drag') return `${cleanPokemonName(parts[1])} was dragged in (${parts[2] || 'unknown details'}).`;
  if (tag === 'move') return `${cleanPokemonName(parts[1])} used ${parts[2]}${parts[3] ? ` into ${cleanPokemonName(parts[3])}` : ''}.`;
  if (tag === '-damage') return `${cleanPokemonName(parts[1])} took damage: ${parts[2]}.`;
  if (tag === '-heal') return `${cleanPokemonName(parts[1])} healed: ${parts[2]}.`;
  if (tag === 'faint') return `${cleanPokemonName(parts[1])} fainted.`;
  if (tag === '-status') return `${cleanPokemonName(parts[1])} is now ${parts[2]}.`;
  if (tag === '-curestatus') return `${cleanPokemonName(parts[1])} cured ${parts[2]}.`;
  if (tag === '-boost') return `${cleanPokemonName(parts[1])} boosted ${parts[2]} by ${parts[3]}.`;
  if (tag === '-unboost') return `${cleanPokemonName(parts[1])} dropped ${parts[2]} by ${parts[3]}.`;
  if (tag === '-ability') return `${cleanPokemonName(parts[1])} revealed ability ${parts[2]}.`;
  if (tag === '-item') return `${cleanPokemonName(parts[1])} revealed item ${parts[2]}.`;
  if (tag === '-enditem') return `${cleanPokemonName(parts[1])} lost/used item ${parts[2]}.`;
  if (tag === '-terastallize') return `${cleanPokemonName(parts[1])} Terastallized into ${parts[2]}.`;
  if (tag === '-start') return `${cleanPokemonName(parts[1])} started ${cleanConditionName(parts[2])}.`;
  if (tag === '-end') return `${cleanPokemonName(parts[1])} ended ${cleanConditionName(parts[2])}.`;
  if (tag === '-activate') return `${cleanPokemonName(parts[1])} activated ${cleanConditionName(parts[2])}.`;
  if (tag === '-formechange') return `${cleanPokemonName(parts[1])} changed form to ${parts[2]}.`;
  if (tag === '-transform') return `${cleanPokemonName(parts[1])} transformed into ${cleanPokemonName(parts[2])}.`;
  if (tag === '-clearboost') return `${cleanPokemonName(parts[1])}'s stat changes were cleared.`;
  if (tag === '-clearallboost') return 'All stat changes were cleared.';
  if (tag === '-setboost') return `${cleanPokemonName(parts[1])} set ${parts[2]} to ${parts[3]}.`;
  if (tag === '-crit') return `${cleanPokemonName(parts[1])} was hit by a critical hit.`;
  if (tag === '-supereffective') return `${cleanPokemonName(parts[1])} was hit super effectively.`;
  if (tag === '-resisted') return `${cleanPokemonName(parts[1])} resisted the hit.`;
  if (tag === '-immune') return `${cleanPokemonName(parts[1])} was immune.`;
  if (tag === '-miss') return `${cleanPokemonName(parts[1])} missed ${parts[2] ? cleanPokemonName(parts[2]) : ''}.`.trim();
  if (tag === '-fail') return `${cleanPokemonName(parts[1])} failed ${parts[2] ? cleanConditionName(parts[2]) : ''}.`.trim();
  if (tag === '-sidestart') return `${cleanSideName(parts[1])} side condition started: ${cleanConditionName(parts[2])}.`;
  if (tag === '-sideend') return `${cleanSideName(parts[1])} side condition ended: ${cleanConditionName(parts[2])}.`;
  if (tag === '-weather') return parts[1] ? `Weather: ${cleanConditionName(parts[1])}.` : 'Weather ended.';
  if (tag === '-fieldstart') return `Field condition started: ${cleanConditionName(parts[1])}.`;
  if (tag === '-fieldend') return `Field condition ended: ${cleanConditionName(parts[1])}.`;
  if (tag === 'win') return `${parts[1]} won.`;
  return '';
}

function applyKnowledgeEvent(view, parts) {
  const tag = parts[0];
  if (tag === 'switch' || tag === 'drag') {
    const mon = revealPokemon(view, parts[1], parts[2], parts[3]);
    if (mon) mon.active = true;
    return;
  }
  if (tag === 'move') {
    const mon = ensurePokemon(view, parts[1]);
    if (mon && parts[2] && !mon.movesRevealed.includes(parts[2])) mon.movesRevealed.push(parts[2]);
    return;
  }
  if (tag === '-damage' || tag === '-heal') {
    const mon = ensurePokemon(view, parts[1]);
    if (mon) mon.condition = parts[2] || mon.condition;
    return;
  }
  if (tag === 'faint') {
    const mon = ensurePokemon(view, parts[1]);
    if (mon) {
      mon.condition = '0 fnt';
      mon.fainted = true;
    }
    return;
  }
  if (tag === '-status' || tag === '-curestatus') {
    const mon = ensurePokemon(view, parts[1]);
    if (mon) mon.status = tag === '-status' ? parts[2] || '' : '';
    return;
  }
  if (tag === '-boost' || tag === '-unboost') {
    const mon = ensurePokemon(view, parts[1]);
    if (mon && parts[2]) {
      const delta = Number(parts[3]) || 0;
      mon.boosts[parts[2]] = (mon.boosts[parts[2]] || 0) + (tag === '-boost' ? delta : -delta);
    }
    return;
  }
  if (tag === '-setboost') {
    const mon = ensurePokemon(view, parts[1]);
    if (mon && parts[2]) mon.boosts[parts[2]] = Number(parts[3]) || 0;
    return;
  }
  if (tag === '-clearboost') {
    const mon = ensurePokemon(view, parts[1]);
    if (mon) mon.boosts = {};
    return;
  }
  if (tag === '-clearallboost') {
    for (const side of Object.values(view.sides)) {
      for (const mon of Object.values(side.pokemon || {})) mon.boosts = {};
    }
    return;
  }
  if (tag === '-ability') {
    const mon = ensurePokemon(view, parts[1]);
    if (mon) {
      mon.ability = parts[2] || mon.ability;
      mon.abilityKnownFrom = 'protocol:-ability';
    }
    return;
  }
  if (tag === '-item' || tag === '-enditem') {
    const mon = ensurePokemon(view, parts[1]);
    if (mon) {
      if (tag === '-item') {
        mon.item = parts[2] || mon.item;
        mon.itemKnownFrom = 'protocol:-item';
      } else {
        mon.itemLastKnown = parts[2] || mon.itemLastKnown || mon.item;
        mon.item = '';
        mon.itemConsumed = true;
        mon.itemKnownFrom = 'protocol:-enditem';
      }
    }
    return;
  }
  if (tag === '-terastallize') {
    const mon = ensurePokemon(view, parts[1]);
    if (mon) mon.teraType = parts[2] || mon.teraType;
    return;
  }
  if (tag === '-start' || tag === '-end') {
    const mon = ensurePokemon(view, parts[1]);
    const condition = cleanConditionName(parts[2]);
    if (mon && condition) {
      if (tag === '-start') mon.volatiles[condition] = createCondition(condition, view.turn, parts.slice(3));
      if (tag === '-end') delete mon.volatiles[condition];
    }
    return;
  }
  if (tag === '-activate') {
    const mon = ensurePokemon(view, parts[1]);
    if (mon) {
      mon.lastActivation = {
        condition: cleanConditionName(parts[2]),
        turn: view.turn,
        args: parts.slice(3),
      };
    }
    return;
  }
  if (tag === '-formechange') {
    const mon = ensurePokemon(view, parts[1]);
    if (mon && parts[2]) {
      mon.species = parts[2];
      mon.details = parts[2];
    }
    return;
  }
  if (tag === '-transform') {
    const mon = ensurePokemon(view, parts[1]);
    if (mon) mon.transformedInto = cleanPokemonName(parts[2]);
    return;
  }
  if (tag === '-sidestart' || tag === '-sideend') {
    const side = sideFromIdent(parts[1]);
    const sideKnowledge = getSideKnowledge(view, side);
    if (sideKnowledge && parts[2]) {
      const condition = cleanConditionName(parts[2]);
      if (tag === '-sidestart') {
        sideKnowledge.sideConditions[condition] = sideKnowledge.sideConditions[condition] ?
          touchCondition(sideKnowledge.sideConditions[condition], view.turn, parts.slice(3)) :
          createCondition(condition, view.turn, parts.slice(3));
      }
      if (tag === '-sideend') delete sideKnowledge.sideConditions[condition];
    }
    return;
  }
  if (tag === '-weather') {
    const weather = cleanConditionName(parts[1]);
    view.field.weather = weather && weather !== 'none' ? createCondition(weather, view.turn, parts.slice(2)) : null;
    return;
  }
  if (tag === '-fieldstart' || tag === '-fieldend') {
    const condition = cleanConditionName(parts[1]);
    if (!condition) return;
    if (condition.toLowerCase().includes('terrain')) {
      view.field.terrain = tag === '-fieldstart' ? createCondition(condition, view.turn, parts.slice(2)) : null;
    } else if (tag === '-fieldstart') {
      view.field.conditions[condition] = createCondition(condition, view.turn, parts.slice(2));
    } else {
      delete view.field.conditions[condition];
    }
  }
}

function revealPokemon(view, ident, details, condition) {
  const side = sideFromIdent(ident);
  const sideKnowledge = getSideKnowledge(view, side);
  if (!sideKnowledge) return null;
  const activeSlot = activeSlotFromIdent(ident);
  for (const mon of Object.values(sideKnowledge.pokemon)) {
    if (!activeSlot || mon.activeSlot === activeSlot) mon.active = false;
  }

  const mon = ensurePokemon(view, ident);
  if (!mon) return null;
  const parsed = parsePokemonDetails(details);
  mon.ident = ident;
  mon.name = cleanPokemonName(ident);
  mon.species = parsed.species || mon.species || mon.name;
  mon.level = parsed.level || mon.level || null;
  mon.gender = parsed.gender || mon.gender || '';
  mon.details = details || mon.details || '';
  mon.condition = condition || mon.condition || '';
  mon.revealed = true;
  mon.active = true;
  mon.activeSlot = activeSlot;
  if (activeSlot) sideKnowledge.activeSlots[activeSlot] = mon.key;
  sideKnowledge.active = mon.key;
  return mon;
}

function ensurePokemon(view, ident) {
  const side = sideFromIdent(ident);
  const sideKnowledge = getSideKnowledge(view, side);
  if (!sideKnowledge) return null;
  const name = cleanPokemonName(ident);
  const key = name || ident;
  if (!sideKnowledge.pokemon[key]) {
    sideKnowledge.pokemon[key] = {
      key,
      ident,
      name,
      species: name,
      level: null,
      gender: '',
      details: '',
      condition: '',
      active: false,
      activeSlot: null,
      revealed: true,
      fainted: false,
      status: '',
      item: '',
      itemLastKnown: '',
      itemConsumed: false,
      itemKnownFrom: '',
      ability: '',
      abilityKnownFrom: '',
      teraType: '',
      movesRevealed: [],
      boosts: {},
      volatiles: {},
      transformedInto: null,
      lastActivation: null,
    };
  }
  return sideKnowledge.pokemon[key];
}

function getSideKnowledge(view, side) {
  if (!side) return null;
  if (view.role === 'p1' || view.role === 'p2') {
    return view.sides[side === view.role ? 'self' : 'opponent'];
  }
  return view.sides[side];
}

function parsePokemonDetails(details = '') {
  const parts = String(details).split(',').map(part => part.trim()).filter(Boolean);
  const species = parts[0] || '';
  const levelPart = parts.find(part => /^L\d+$/i.test(part));
  const gender = parts.find(part => part === 'M' || part === 'F') || '';
  return {
    species,
    level: levelPart ? Number(levelPart.slice(1)) : null,
    gender,
  };
}

function cleanSideName(value = '') {
  return String(value).replace(/^p[1-4]:\s*/, '').trim();
}

function cleanConditionName(value = '') {
  return String(value).replace(/^(move|item|ability):\s*/, '').trim();
}
