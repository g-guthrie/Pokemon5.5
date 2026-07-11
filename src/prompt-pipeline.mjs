import {
  currentTypes,
  enrichConditionMap,
  enrichCondition,
  moveCard,
  randomBattleStatEstimate,
  speciesCard,
} from './dex-context.mjs';

export const PROMPT_SCHEMA_VERSION = 'showdown-choice-prompt.v7';
export const RESPONSE_SCHEMA_VERSION = 'showdown-choice-response.v6';
export const REQUIRED_ANALYSIS_FIELDS = [
  'gameStateSummary',
  'winConditions',
  'loseConditions',
  'setupLines',
  'sweepPlans',
  'safeSwitches',
  'opponentLikelyPlan',
  'biggestThreats',
  'riskAssessment',
  'candidateChoices',
];
const RESPONSE_JSON_SCHEMA_NAME = 'showdown_choice_response';

// A human can scroll the entire battle log; keep the window wide enough that
// whole games stay visible to the model.
const HISTORY_TEXT_LIMIT = 200;
const HISTORY_EVENT_LIMIT = 80;

export function buildModelInput(role, observation, legalActions) {
  const screenObservation = compactExtractedState(observation);
  const choices = compactLegalActions(legalActions);
  const legalActionPartCatalog = buildLegalActionPartCatalog(legalActions);
  const situation = summarizeSituation(screenObservation, legalActions);
  const battleBriefing = buildBattleBriefing(screenObservation, legalActions, legalActionPartCatalog);
  // v5 single-copy history: the human-readable log now lives only in
  // battleBriefing.recentBattleLog; keep just the structured recent events on
  // the screen observation so the log is not serialized twice per decision.
  screenObservation.history = {
    recent: screenObservation.history.recent,
    truncated: screenObservation.history.truncated,
  };
  return {
    promptSchemaVersion: PROMPT_SCHEMA_VERSION,
    responseSchemaVersion: RESPONSE_SCHEMA_VERSION,
    role,
    objective: 'Choose one exact legal action for this Pokemon Showdown [Gen 9] Random Doubles Battle turn.',
    decisionFrame: {
      perspective: role,
      format: screenObservation.formatid || '',
      sourceOfTruth: 'battleBriefing plus screenObservation plus legalActions in this payload',
      benchmarkGoal: 'Play to win under the same hidden information a human player on this side would have from the Showdown screen and battle log.',
      analysisStyle: 'Return short public tactical notes for auditability; do not expose hidden chain-of-thought.',
    },
    canonicalContracts: [
      'The battle engine is Pokemon Showdown. Do not invent mechanics outside Showdown.',
      'legalActions[] is generated from the current Showdown request and is the only legal action set.',
      'The final choice must be byte-for-byte equal to one legalActions[] string.',
      'For doubles, combined choices must command each active slot in order, e.g. "move 1 1, move 2 2" or "switch 3, pass".',
    ],
    hiddenInfoRules: [
      'Use only this prompt payload as the source of truth.',
      'You know your full own team because it is in screenObservation.self.team.',
      'You only know opponent Pokemon, moves, items, abilities, tera types, and conditions when present in screenObservation.opponent.',
      'Treat missing opponent item, ability, moves, tera type, nature, EVs, IVs, and bench slots as unknown, not false.',
      'Do not infer unrevealed opponent bench Pokemon, unrevealed items, unrevealed abilities, or unrevealed moves as facts.',
      'The final choice must exactly equal one legalActions[] string.',
    ],
    responseOrder: [...REQUIRED_ANALYSIS_FIELDS, 'choice', 'reason'],
    tacticalChecklist: [
      'Summarize active board state, speed/pressure, field, side conditions, HP/status, boosts, volatiles, and recent visible battle log.',
      'Describe realistic win conditions from your known team and the revealed opposing Pokemon.',
      'Name the most imminent lose conditions: what sequence loses you this game soon, and whether this turn must prevent it.',
      'Identify setup or support lines and whether either side can safely enable them.',
      'Account for held items: your own are known; opponent items only when revealed. Weigh Choice locks, berries, Focus Sash, Life Orb, Assault Vest, and similar effects in damage and speed reads.',
      'Identify sweeper, damage, positioning, or cleaning approaches for your side.',
      'Identify safe switches, forced defensive pivots, or why staying in is better.',
      'Predict the opponent likely plan from only revealed information.',
      'Name the biggest immediate threats and what your selected choice covers.',
      'Assess the main risk of your choice without using private or unrevealed opponent information.',
      'Compare 2 to 4 concrete candidate choices by exact legalActions[] string, including their upside and main risk.',
      'Then commit to one exact legal action from legalActions[].',
    ],
    outputBudget: {
      style: 'thorough and structured; every sentence should carry a concrete tactical fact',
      perString: '1-2 full sentences, no markdown',
      arrays: '1-3 strings per tactical field; candidateChoices should have 2-4 strings',
      reason: '1-2 sentences',
      hardLimit: 'keep the entire JSON response under 4000 output tokens',
    },
    responseSchema: {
      gameStateSummary: ['1-3 sentences covering the active board, speed, HP, field, and pressure.'],
      winConditions: ['1-3 sentences about how this side can win from known information.'],
      loseConditions: ['1-3 sentences naming the most imminent ways this side loses and whether they are live this turn.'],
      setupLines: ['0-2 sentences about viable setup/support, or [] if none.'],
      sweepPlans: ['0-2 sentences about damage or cleaning lines, or [] if none.'],
      safeSwitches: ['0-2 sentences about useful switches or why none are needed.'],
      opponentLikelyPlan: ['1-3 sentences based only on revealed information.'],
      biggestThreats: ['1-3 sentences naming immediate threats and what covers them.'],
      riskAssessment: ['1-2 sentences naming what can go wrong with the selected plan.'],
      candidateChoices: ['2-4 strings. Each must start with an exact legalActions[] string, then state upside and risk.'],
      choice: 'Exact legalActions[] string.',
      reason: 'A concise final justification for the selected legal choice.',
    },
    battleBriefing,
    situation,
    dexContext: buildDexContext(screenObservation),
    legalActionPartCatalog,
    legalActions: choices,
    screenObservation,
  };
}

// Everything a hover-tooltip would tell a human: move cards for every own
// move and every revealed opponent move, species cards (typing, base stats,
// possible abilities) for every visible Pokemon. Single copy, referenced by
// name from the briefing.
function buildDexContext(state = {}) {
  const moves = {};
  const species = {};
  const addMove = name => {
    if (!name || moves[name]) return;
    const card = moveCard(name);
    if (card) moves[name] = card;
  };
  const addSpecies = name => {
    if (!name || species[name]) return;
    const card = speciesCard(name);
    if (card) species[name] = card;
  };
  for (const mon of state.self?.team || []) {
    addSpecies(mon.species);
    for (const move of mon.moves || []) addMove(move);
  }
  for (const mon of state.opponent?.revealedTeam || []) {
    addSpecies(mon.species);
    for (const move of mon.movesRevealed || []) addMove(move);
  }
  return {
    note: 'Official dex facts a player reads from screen tooltips: move type/category/power/accuracy/PP, species typing/base stats/possible abilities. possibleAbilities lists candidates only; the opponent’s real ability stays unknown until revealed.',
    moves,
    species,
  };
}

export function buildChoicePrompt(role, observation, legalActions) {
  return [
    'You are a competitive Pokemon doubles player controlling one side in a local Pokemon Showdown benchmark battle.',
    'The JSON payload is your screen-equivalent state: your private team, the visible opponent information, the visible battle log, field state, side conditions, and exact legal Showdown choices.',
    'First write concise public tactical notes in the requested JSON fields: game state, win conditions, setup, sweep/damage plans, switches, opponent plan, threats, risk, and candidate legal choices.',
    'Do not output markdown, hidden chain-of-thought, or facts about unrevealed opponent information.',
    'Return JSON only, matching responseSchema and responseOrder. The choice must exactly match one legalActions[] string.',
    '',
    JSON.stringify(buildModelInput(role, observation, legalActions)),
  ].join('\n');
}

export function buildChoiceResponseJsonSchema(legalActions = []) {
  const choices = compactLegalActions(legalActions);
  const tacticalString = {type: 'string', maxLength: 420};
  // No maxItems: Anthropic-family structured outputs (Anthropic API, Bedrock,
  // Azure via OpenRouter) reject 'maxItems' on array types. Item-count caps
  // are advisory anyway: prompts ask for concise notes and consumers truncate.
  const tacticalArray = {
    type: 'array',
    items: tacticalString,
  };
  const properties = Object.fromEntries(REQUIRED_ANALYSIS_FIELDS.map(field => [field, tacticalArray]));
  for (const field of ['gameStateSummary', 'winConditions', 'loseConditions', 'opponentLikelyPlan', 'biggestThreats', 'riskAssessment']) {
    properties[field] = {...tacticalArray, minItems: 1};
  }
  properties.candidateChoices = {
    type: 'array',
    items: {type: 'string', maxLength: 520},
    minItems: 1,
  };
  properties.choice = choices.length ? {type: 'string', enum: choices} : {type: 'string'};
  properties.reason = {type: 'string', maxLength: 400};
  return {
    type: 'object',
    properties,
    required: [...REQUIRED_ANALYSIS_FIELDS, 'choice', 'reason'],
    additionalProperties: false,
  };
}

export function buildOpenAIResponseFormat(legalActions = []) {
  return {
    type: 'json_schema',
    name: RESPONSE_JSON_SCHEMA_NAME,
    description: 'A concise Pokemon Showdown doubles decision with public tactical notes and one exact legal choice.',
    strict: true,
    schema: buildChoiceResponseJsonSchema(legalActions),
  };
}

export function buildChatCompletionResponseFormat(legalActions = []) {
  const {name, description, strict, schema} = buildOpenAIResponseFormat(legalActions);
  return {
    type: 'json_schema',
    json_schema: {name, description, strict, schema},
  };
}

export function normalizeDecisionAnalysis(parsed = {}) {
  return {
    gameStateSummary: stringList(parsed.gameStateSummary || parsed.stateSummary || parsed.summary),
    winConditions: stringList(parsed.winConditions || parsed.winCons || parsed.pathToWin || parsed.pathsToWin),
    loseConditions: stringList(parsed.loseConditions || parsed.losingConditions || parsed.lossConditions || parsed.pathsToLoss),
    setupLines: stringList(parsed.setupLines || parsed.possibleSetups || parsed.setupApproaches),
    sweepPlans: stringList(parsed.sweepPlans || parsed.sweeperApproaches || parsed.damagePlans),
    safeSwitches: stringList(parsed.safeSwitches || parsed.easySwitches || parsed.switches),
    opponentLikelyPlan: stringList(parsed.opponentLikelyPlan || parsed.opponentPlan || parsed.opponentMostLikely),
    biggestThreats: stringList(parsed.biggestThreats || parsed.threats),
    riskAssessment: stringList(parsed.riskAssessment || parsed.risks || parsed.failureModes),
    candidateChoices: stringList(parsed.candidateChoices || parsed.candidateChoiceReview || parsed.choiceReview || parsed.consideredChoices || parsed.shortlist),
  };
}

export function compactLegalActions(legalActions = []) {
  return legalActions.map(action => action.choice || action.command).filter(Boolean);
}

function buildLegalActionPartCatalog(legalActions = []) {
  const partsByChoice = new Map();
  for (const action of legalActions) {
    if (Array.isArray(action.choices)) {
      for (const part of action.choices) addPart(partsByChoice, part);
    } else {
      addPart(partsByChoice, action);
    }
  }
  return [...partsByChoice.values()].sort((a, b) => String(a.choice || '').localeCompare(String(b.choice || '')));
}

function addPart(partsByChoice, part = {}) {
  const choice = part.choice || part.command;
  if (!choice || partsByChoice.has(choice)) return;
  partsByChoice.set(choice, compactActionPart(part));
}

export function compactExtractedState(extracted = {}) {
  const historyText = extracted.history?.text || [];
  const historyRecent = extracted.history?.recent || [];
  return {
    schemaVersion: extracted.schemaVersion,
    perspective: extracted.perspective,
    opponentRole: extracted.opponentRole,
    formatid: extracted.formatid,
    turn: extracted.turn,
    ended: extracted.ended,
    winner: extracted.winner,
    waiting: extracted.waiting,
    requestId: extracted.requestId,
    requestTurn: extracted.requestTurn,
    requestFresh: extracted.requestFresh,
    source: extracted.source,
    self: {
      activePokemon: (extracted.self?.activePokemon || []).map(compactOwnPokemon),
      team: (extracted.self?.team || []).map(compactOwnPokemon),
      sideConditions: extracted.self?.sideConditions,
    },
    opponent: {
      activePokemon: (extracted.opponent?.activePokemon || []).map(compactKnownPokemon),
      revealedTeam: (extracted.opponent?.revealedTeam || []).map(compactKnownPokemon),
      sideConditions: extracted.opponent?.sideConditions,
    },
    field: extracted.field,
    history: {
      recent: historyRecent.slice(-HISTORY_EVENT_LIMIT).map(compactHistoryEvent).filter(Boolean),
      text: historyText.slice(-HISTORY_TEXT_LIMIT),
      truncated: {
        text: historyText.length > HISTORY_TEXT_LIMIT,
        recent: historyRecent.length > HISTORY_EVENT_LIMIT,
      },
    },
    actionSyntax: {
      doubles: 'Use one comma-separated command per active slot, e.g. "move 1 1, move 2 2" or "switch 3, pass".',
      targetSlots: 'Positive targets are opposing active slots; negative targets are ally slots.',
      exactness: 'The returned choice string must exactly match one legalActions[] value.',
    },
  };
}

function enrichFieldView(field = {}, turn) {
  return {
    weather: field?.weather ? enrichCondition(field.weather, turn) : field?.weather ?? null,
    terrain: field?.terrain ? enrichCondition(field.terrain, turn) : field?.terrain ?? null,
    conditions: enrichConditionMap(field?.conditions, turn),
  };
}

function buildBattleBriefing(state = {}, legalActions = [], legalActionPartCatalog = []) {
  const ownActive = state.self?.activePokemon || [];
  const ownTeam = state.self?.team || [];
  const opponentActive = state.opponent?.activePokemon || [];
  const opponentRevealed = state.opponent?.revealedTeam || [];
  const turn = state.turn ?? null;
  const summarizeOwn = mon => summarizeOwnPokemonForBriefing(mon);
  const summarizeOpponent = mon => summarizeOpponentPokemonForBriefing(mon, state);
  return {
    briefingSchemaVersion: 'battle-briefing.v2',
    turn,
    requestId: state.requestId ?? null,
    requestFresh: Boolean(state.requestFresh),
    waiting: Boolean(state.waiting),
    formatid: state.formatid || '',
    visibleBoard: {
      activeMatchup: {
        self: ownActive.map(summarizeOwn),
        opponent: opponentActive.map(summarizeOpponent),
      },
      field: enrichFieldView(state.field, turn),
      sideConditions: {
        self: enrichConditionMap(state.self?.sideConditions, turn),
        opponent: enrichConditionMap(state.opponent?.sideConditions, turn),
      },
    },
    playerViewNow: buildPlayerViewNow(state, legalActions),
    ownSide: {
      active: ownActive.map(summarizeOwn),
      bench: ownTeam.filter(mon => !mon.active).map(summarizeOwn),
      fullTeamKnown: true,
      note: 'This is your private team information and is legal for you to use.',
    },
    opponentSide: {
      active: opponentActive.map(summarizeOpponent),
      revealedTeam: opponentRevealed.map(summarizeOpponent),
      revealedCount: opponentRevealed.length,
      unrevealedCount: Math.max(0, 6 - opponentRevealed.length),
      teamSizeAssumed: 6,
      unrevealedBenchKnown: false,
      note: 'Only revealed opponent Pokemon and revealed public attributes are known.',
    },
    // v5: single-copy history policy. The human-readable battle log lives
    // here and only here; structured recent events live in
    // screenObservation.history.recent; raw protocol is omitted entirely
    // because it is not part of what a human sees on the Showdown screen.
    recentBattleLog: {
      text: state.history?.text || [],
      truncated: state.history?.truncated || {},
    },
    legalChoiceSemantics: {
      count: legalActions.length,
      exactChoices: compactLegalActions(legalActions),
      atomicParts: legalActionPartCatalog,
      doubles: 'Each legalActions[] entry is a complete two-slot command for the current request.',
      targetSlots: 'Positive targets are opposing active slots; negative targets are ally slots.',
      noPartialChoices: 'Do not return only one move, a label, an index, or a paraphrase.',
      candidateChoiceRequirement: 'candidateChoices must compare exact legalActions[] strings before the final choice.',
    },
    knownUnknowns: {
      ownTeam: 'known fully',
      ownBenchMovePP: 'exact current PP appears only in legalActions for the active request; bench moves are at dexContext maxPP unless the battle log shows earlier use',
      opponentActive: 'known only for revealed public fields in opponentSide.active',
      opponentBench: 'unknown until revealed by battle protocol; opponentSide.unrevealedCount says how many remain unseen',
      opponentMovesItemsAbilitiesTera: 'unknown unless explicitly present in opponentSide; dexContext.species possibleAbilities lists candidates only',
      opponentStats: 'estimatedStats derive from the public random-battle spread (85 EVs, 31 IVs, neutral nature) plus visible level — screen-tooltip equivalents, not revealed facts',
    },
  };
}

function summarizeSituation(state = {}, legalActions = []) {
  return {
    turn: state.turn ?? null,
    requestId: state.requestId ?? null,
    formatid: state.formatid || '',
    activeMatchup: {
      self: activeNames(state.self),
      opponent: activeNames(state.opponent),
    },
    ownTeamPreview: (state.self?.team || []).map(mon => [
      mon.active ? 'active' : `slot ${mon.slot ?? '?'}`,
      mon.name || mon.species || 'Unknown',
      mon.condition || '',
      mon.item ? `item ${mon.item}` : '',
      mon.ability ? `ability ${mon.ability}` : '',
      mon.teraType ? `tera ${mon.teraType}` : '',
      mon.moves?.length ? `moves ${mon.moves.join(', ')}` : '',
    ].filter(Boolean).join(' | ')),
    opponentKnownPreview: (state.opponent?.revealedTeam || []).map(mon => [
      mon.active ? 'active' : 'revealed',
      mon.name || mon.species || 'Unknown',
      mon.condition || '',
      mon.item ? `item ${mon.item}` : mon.itemLastKnown ? `last item ${mon.itemLastKnown}` : '',
      mon.ability ? `ability ${mon.ability}` : '',
      mon.teraType ? `tera ${mon.teraType}` : '',
      mon.movesRevealed?.length ? `revealed moves ${mon.movesRevealed.join(', ')}` : '',
    ].filter(Boolean).join(' | ')),
    field: state.field || {},
    sideConditions: {
      self: state.self?.sideConditions || {},
      opponent: state.opponent?.sideConditions || {},
    },
    recentHistory: state.history?.text?.slice(-12) || [],
    legalActionCount: legalActions.length,
    legalActionGroups: summarizeLegalActionGroups(legalActions),
  };
}

function buildPlayerViewNow(state = {}, legalActions = []) {
  const ownActive = state.self?.activePokemon || [];
  const ownTeam = state.self?.team || [];
  const opponentActive = state.opponent?.activePokemon || [];
  const opponentRevealed = state.opponent?.revealedTeam || [];
  const turn = state.turn ?? null;
  const summarizeOwn = mon => summarizeOwnPokemonForBriefing(mon);
  const summarizeOpponent = mon => summarizeOpponentPokemonForBriefing(mon, state);
  return {
    turn,
    request: {
      requestId: state.requestId ?? null,
      fresh: Boolean(state.requestFresh),
      waiting: Boolean(state.waiting),
    },
    activeBoard: {
      self: ownActive.map(summarizeOwn),
      opponent: opponentActive.map(summarizeOpponent),
    },
    resources: {
      ownBenchAvailable: ownTeam
        .filter(mon => !mon.active && !String(mon.condition || '').endsWith(' fnt'))
        .map(summarizeOwn),
      ownFainted: ownTeam
        .filter(mon => String(mon.condition || '').endsWith(' fnt'))
        .map(mon => mon.name || mon.species || `slot ${mon.slot ?? '?'}`),
      opponentRevealed: opponentRevealed.map(summarizeOpponent),
      opponentUnrevealedBench: 'unknown until revealed',
    },
    boardMemory: {
      field: enrichFieldView(state.field, turn),
      sideConditions: {
        self: enrichConditionMap(state.self?.sideConditions, turn),
        opponent: enrichConditionMap(state.opponent?.sideConditions, turn),
      },
      recentText: state.history?.text?.slice(-12) || [],
      recentEvents: state.history?.recent?.slice(-12) || [],
    },
    actionSpace: {
      legalActionCount: legalActions.length,
      groups: summarizeLegalActionGroups(legalActions),
      exactChoices: compactLegalActions(legalActions),
    },
  };
}

function summarizeLegalActionGroups(legalActions = []) {
  return {
    attacks: legalActions.filter(action => action.type === 'move' || action.type === 'double-choice').length,
    switches: legalActions.filter(action => action.type === 'switch' || action.type === 'force-switch' || action.hasSwitch).length,
    terastallize: legalActions.filter(action => action.hasTerastallize || String(action.choice || '').includes('terastallize')).length,
    other: legalActions.filter(action => !['move', 'double-choice', 'switch', 'force-switch'].includes(action.type || '')).length,
  };
}

function compactActionPart(action = {}) {
  return {
    choice: action.choice || action.command,
    type: action.type,
    label: action.label || action.move || action.pokemon || action.choice || action.command,
    activeSlot: action.activeSlot ?? null,
    slot: action.slot ?? null,
    move: action.move || '',
    id: action.id || '',
    pp: action.pp ?? null,
    maxpp: action.maxpp ?? null,
    target: action.target || '',
    targetLoc: action.targetLoc ?? null,
    targetSlot: action.targetSlot ?? null,
    allyTargetSlot: action.allyTargetSlot ?? null,
    pokemon: action.pokemon || '',
    condition: action.condition || '',
  };
}

function compactOwnPokemon(mon) {
  if (!mon) return null;
  return {
    slot: mon.slot,
    activeSlot: mon.activeSlot || null,
    name: mon.name,
    species: mon.species,
    level: mon.level,
    gender: mon.gender,
    condition: mon.condition,
    active: mon.active,
    item: mon.item,
    ability: mon.ability,
    nature: mon.nature,
    evs: mon.evs,
    ivs: mon.ivs,
    moves: mon.moves,
    teraType: mon.teraType,
    // The switch-menu tooltip shows full stats for bench Pokemon too.
    stats: mon.stats || undefined,
    boosts: mon.boosts,
    volatiles: mon.volatiles,
    terastallized: mon.terastallized || undefined,
  };
}

function compactKnownPokemon(mon) {
  if (!mon) return null;
  return {
    key: mon.key,
    ident: mon.ident,
    name: mon.name,
    species: mon.species,
    level: mon.level,
    gender: mon.gender,
    condition: mon.condition,
    active: mon.active,
    activeSlot: mon.activeSlot || null,
    revealed: mon.revealed,
    fainted: mon.fainted,
    status: mon.status || undefined,
    statusTurn: mon.statusTurn ?? undefined,
    nature: mon.nature || undefined,
    evs: mon.evs || undefined,
    ivs: mon.ivs || undefined,
    item: mon.item || undefined,
    itemLastKnown: mon.itemLastKnown || undefined,
    itemConsumed: mon.itemConsumed || undefined,
    itemKnownFrom: mon.itemKnownFrom || undefined,
    ability: mon.ability || undefined,
    abilityKnownFrom: mon.abilityKnownFrom || undefined,
    teraType: mon.teraType || undefined,
    movesRevealed: mon.movesRevealed?.length ? mon.movesRevealed : undefined,
    boosts: Object.keys(mon.boosts || {}).length ? mon.boosts : undefined,
    volatiles: Object.keys(mon.volatiles || {}).length ? mon.volatiles : undefined,
    transformedInto: mon.transformedInto || undefined,
    lastActivation: mon.lastActivation || undefined,
  };
}

function compactHistoryEvent(event = {}) {
  if (!event || typeof event !== 'object') return null;
  return {
    turn: event.turn ?? null,
    tag: event.tag || '',
    text: event.text || event.raw || '',
    raw: event.raw || '',
    args: Array.isArray(event.args) ? event.args.slice(0, 8) : undefined,
  };
}

function summarizeOwnPokemonForBriefing(mon = {}) {
  return stripEmpty({
    slot: mon.slot ?? null,
    activeSlot: mon.activeSlot ?? null,
    role: mon.active ? 'active' : 'bench',
    name: mon.name || '',
    species: mon.species || '',
    level: mon.level ?? null,
    gender: mon.gender || '',
    condition: mon.condition || '',
    hp: mon.condition || '',
    types: currentTypes(mon.species, mon.terastallized ? mon.teraType : ''),
    item: mon.item || '',
    ability: mon.ability || '',
    nature: mon.nature || '',
    teraType: mon.teraType || '',
    terastallized: mon.terastallized || undefined,
    moves: mon.moves || [],
    stats: mon.stats || undefined,
    boosts: hasKeys(mon.boosts) ? mon.boosts : undefined,
    volatiles: hasKeys(mon.volatiles) ? mon.volatiles : undefined,
    evs: mon.evs || undefined,
    ivs: mon.ivs || undefined,
  });
}

function summarizeOpponentPokemonForBriefing(mon = {}, state = {}) {
  const isRandomFormat = String(state.formatid || '').includes('random');
  const dexSpecies = speciesCard(mon.species);
  return stripEmpty({
    activeSlot: mon.activeSlot ?? null,
    role: mon.active ? 'active' : 'revealed',
    ident: mon.ident || '',
    name: mon.name || '',
    species: mon.species || '',
    level: mon.level ?? null,
    gender: mon.gender || '',
    condition: mon.condition || '',
    hp: mon.condition || '',
    types: currentTypes(mon.species, mon.terastallized ? mon.teraType : ''),
    // Tooltip equivalents: base stats and — in randoms, where every set runs
    // 85 EVs / 31 IVs / neutral nature — effectively exact computed stats.
    baseStats: dexSpecies?.baseStats || undefined,
    estimatedStats: isRandomFormat ? randomBattleStatEstimate(mon.species, mon.level) || undefined : undefined,
    revealed: Boolean(mon.revealed),
    fainted: Boolean(mon.fainted),
    status: mon.status || undefined,
    statusSinceTurn: mon.statusTurn ?? undefined,
    statusTurnsElapsed: mon.statusTurn != null && state.turn != null
      ? Math.max(0, Number(state.turn) - Number(mon.statusTurn))
      : undefined,
    nature: mon.nature || undefined,
    evs: mon.evs || undefined,
    ivs: mon.ivs || undefined,
    item: mon.item || undefined,
    itemLastKnown: mon.itemLastKnown || undefined,
    itemConsumed: mon.itemConsumed || undefined,
    itemKnownFrom: mon.itemKnownFrom || undefined,
    ability: mon.ability || undefined,
    abilityKnownFrom: mon.abilityKnownFrom || undefined,
    teraType: mon.teraType || undefined,
    movesRevealed: mon.movesRevealed?.length ? mon.movesRevealed : undefined,
    boosts: hasKeys(mon.boosts) ? mon.boosts : undefined,
    volatiles: hasKeys(mon.volatiles) ? mon.volatiles : undefined,
    transformedInto: mon.transformedInto || undefined,
    lastActivation: mon.lastActivation || undefined,
    unknowns: opponentUnknowns(mon),
  });
}

function opponentUnknowns(mon = {}) {
  const unknowns = [];
  if (!mon.item && !mon.itemLastKnown && !mon.itemConsumed) unknowns.push('item');
  if (!mon.ability) unknowns.push('ability (see dexContext.species possibleAbilities for the candidates)');
  if (!mon.teraType) unknowns.push('teraType');
  if (!mon.movesRevealed?.length) unknowns.push('moves');
  return unknowns;
}

function activeNames(side = {}) {
  const names = (side.activePokemon || []).map(mon => mon.name || mon.species).filter(Boolean);
  return names.length ? names.join(' + ') : side.active?.name || side.active?.species || '';
}

function stringList(value) {
  if (Array.isArray(value)) return value.map(item => String(item ?? '').trim()).filter(Boolean).slice(0, 5);
  if (typeof value === 'string') {
    return value
      .split(/\n|;|\u2022/u)
      .map(item => item.replace(/^[-*\d.)\s]+/u, '').trim())
      .filter(Boolean)
      .slice(0, 5);
  }
  return [];
}

function hasKeys(value) {
  return Boolean(value && typeof value === 'object' && Object.keys(value).length);
}

function stripEmpty(value = {}) {
  return Object.fromEntries(
    Object.entries(value).filter(([, entry]) => {
      if (entry === undefined || entry === null || entry === '') return false;
      if (Array.isArray(entry) && !entry.length) return false;
      return true;
    })
  );
}
