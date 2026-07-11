import {
  currentTypes,
  enrichConditionMap,
  enrichCondition,
  moveCard,
  randomBattleStatEstimate,
  speciesCard,
} from './dex-context.mjs';

export const PROMPT_SCHEMA_VERSION = 'showdown-choice-prompt.v9';
export const RESPONSE_SCHEMA_VERSION = 'showdown-choice-response.v9';
// v9 turn-field order is a deliberate reasoning arc — models answer
// top-to-bottom and each answer conditions the next: read the board, appraise
// every revealed set, fence off what is still unknown, predict the opponent,
// name the immediate threats, state the stakes, explicitly weigh Tera and
// switches, then shortlist candidates, project each line against the likely
// responses, and finish with a robustness check of the pick. Confirmed
// information stays separated from inference.
export const TURN_ANALYSIS_FIELDS = [
  'gameStateSummary',
  'setArchetypes',
  'unknownInformation',
  'opponentLikelyPlan',
  'biggestThreats',
  'winConditions',
  'loseConditions',
  'teraAndSwitchCheck',
  'candidateChoices',
  'candidateOutcomes',
  'decisionCheck',
];
// A forced replacement (every legal action just sends a Pokemon in) gets a
// focused three-question mind instead of the full turn questionnaire:
// matchups, risks, then the plan the send-in enables.
export const REPLACEMENT_ANALYSIS_FIELDS = [
  'replacementMatchups',
  'replacementRisks',
  'replacementPlan',
];
// Union, for consumers that sanitize or serialize whatever analysis a call
// carries (artifacts, mind summaries) regardless of decision type.
export const REQUIRED_ANALYSIS_FIELDS = [...TURN_ANALYSIS_FIELDS, ...REPLACEMENT_ANALYSIS_FIELDS];

// The schema a given request must answer, derived from its legal actions.
export function analysisFieldsFor(legalActions = []) {
  return classifyDecision(legalActions) === 'replacement' ? REPLACEMENT_ANALYSIS_FIELDS : TURN_ANALYSIS_FIELDS;
}
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
  const decisionType = classifyDecision(legalActions);
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
    objective: decisionType === 'replacement'
      ? (legalActions.some(action => (Array.isArray(action.choices) ? action.choices : [action]).some(part => part.reviving))
        ? 'Revival Blessing resolved: choose the exact legal switch command that revives the most valuable FAINTED Pokemon (it returns at half HP) in this Pokemon Showdown [Gen 9] Random Doubles Battle.'
        : 'A Pokemon fainted (or must leave the field): choose the exact legal switch command that sends in the best replacement for this Pokemon Showdown [Gen 9] Random Doubles Battle.')
      : 'Choose one exact legal action for this Pokemon Showdown [Gen 9] Random Doubles Battle turn.',
    decisionFrame: {
      perspective: role,
      format: screenObservation.formatid || '',
      // What kind of decision this request is: 'turn' (attack/switch/tera),
      // 'replacement' (every legal action sends in a bench Pokemon), or
      // 'team-preview'. The tacticalChecklist below is tailored to it.
      decisionType,
      sourceOfTruth: 'battleBriefing plus screenObservation plus legalActions in this payload',
      benchmarkGoal: 'Play to win under the same hidden information a human player on this side would have from the Showdown screen and battle log.',
      analysisStyle: 'Return short public tactical notes for auditability; do not expose hidden chain-of-thought.',
    },
    canonicalContracts: [
      'The battle engine is Pokemon Showdown. Do not invent mechanics outside Showdown.',
      'legalActions[] is generated from the current Showdown request and is the only legal action set.',
      'The final choice must be byte-for-byte equal to one legalActions[] string.',
      'For doubles, combined choices must command each active slot in order, e.g. "move 1 1, move 2 2" or "switch 3, pass".',
      'Attacking is never mandatory: switching a healthy Pokemon out, and Terastallizing (choices ending in "terastallize"), are first-class options whenever legalActions[] offers them — weigh them every turn, not only when forced.',
    ],
    hiddenInfoRules: [
      'Use only this prompt payload as the source of truth.',
      'You know your full own team because it is in screenObservation.self.team.',
      'You only know opponent Pokemon, moves, items, abilities, tera types, and conditions when present in screenObservation.opponent.',
      'Treat missing opponent item, ability, moves, tera type, nature, EVs, IVs, and bench slots as unknown, not false.',
      'Do not infer unrevealed opponent bench Pokemon, unrevealed items, unrevealed abilities, or unrevealed moves as facts.',
      'The final choice must exactly equal one legalActions[] string.',
    ],
    responseOrder: [...analysisFieldsFor(legalActions), 'choice', 'reason'],
    tacticalChecklist: tacticalChecklistFor(decisionType),
    outputBudget: {
      style: 'thorough and structured; every sentence should carry a concrete tactical fact',
      perString: '1-2 full sentences, no markdown',
      arrays: decisionType === 'replacement'
        ? 'replacementMatchups should have one string per serious send-in; 1-3 strings for the other fields'
        : '1-3 strings per tactical field; candidateChoices should have 2-4 strings',
      reason: '1-2 sentences',
      hardLimit: 'keep the entire JSON response under 4000 output tokens',
    },
    responseSchema: responseSchemaFor(decisionType),
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

// Per-field answer guidance, keyed to the decision type's field list.
function responseSchemaFor(decisionType) {
  if (decisionType === 'replacement') {
    return {
      replacementMatchups: ['One string per serious send-in. Each must start with an exact legalActions[] string, then state how that Pokemon matches up into the current board: typing, speed, bulk, and immediate pressure.'],
      replacementRisks: ['1-3 sentences naming what each serious send-in could cost: arrival punishes, double targeting, feeding a setup sweeper, or spending a Pokemon your endgame needs.'],
      replacementPlan: ['1-2 sentences: the chosen send-in, why it is most robust, and the plan it enables on the next turn.'],
      choice: 'Exact legalActions[] string.',
      reason: 'A concise final justification for the selected legal choice.',
    };
  }
  return {
    gameStateSummary: ['1-3 sentences: the complete current board — HP, status, boosts, field effects, speed order, positioning, revealed information, and remaining resources.'],
    setArchetypes: ['1-3 sentences appraising each revealed Pokemon’s set from known evidence: fast, bulky, offensive, supportive, setup, or mixed, plus the plausible variants that remain.'],
    unknownInformation: ['1-3 sentences naming what is still unknown and which reasonable sets, speed tiers, damage ranges, items, abilities, or unrevealed Pokemon must be respected without treating them as facts.'],
    opponentLikelyPlan: ['1-3 sentences: what the opponent most likely does this turn, plus the credible alternatives that must be covered.'],
    biggestThreats: ['1-3 sentences naming the most immediate tactical threats: KOs, disruption, setup, speed control, targeting combinations, action-order dangers.'],
    winConditions: ['1-3 sentences on realistic paths to winning and what must be created or preserved.'],
    loseConditions: ['1-3 sentences on the sequences that lose the game, now or over coming turns, and what must be prevented this turn.'],
    teraAndSwitchCheck: ['1-3 sentences: should anyone Terastallize this turn — whose Tera type changes a key matchup, and is now the right time to spend it — and should any active Pokemon switch out instead of acting?'],
    candidateChoices: ['2-4 strings. Each must start with an exact legalActions[] string, then state how it advances your plan or covers theirs.'],
    candidateOutcomes: ['1-3 sentences projecting the strongest candidates against the opponent’s likely action and most dangerous alternatives, and the next-turn position each creates.'],
    decisionCheck: ['1-2 sentences: why the chosen action is most robust across uncertainty, worst case, resources, and flexibility — plus the intended follow-up plan.'],
    choice: 'Exact legalActions[] string.',
    reason: 'A concise final justification for the selected legal choice.',
  };
}

// What kind of decision this request is. 'replacement' means every legal
// action only sends Pokemon in (a faint or forced pivot) — the reasoning
// scaffold shifts from "pick this turn's action" to "pick the best send-in".
function classifyDecision(legalActions = []) {
  if (!legalActions.length) return 'wait';
  if (legalActions.every(action => action.type === 'team')) return 'team-preview';
  const partsOf = action => (Array.isArray(action.choices) ? action.choices : [action]);
  const switchOnly = legalActions.every(action => partsOf(action).every(part =>
    part.type === 'force-switch' || part.type === 'switch' || (part.choice || part.command) === 'pass'));
  return switchOnly ? 'replacement' : 'turn';
}

// The same ten response questions answer both decision types; the checklist
// steers what each answer should weigh. Both walk the v8 reasoning arc.
function tacticalChecklistFor(decisionType) {
  if (decisionType === 'replacement') {
    return [
      'Read the board your replacement walks into — HP, status, boosts, field effects, speed order, and both sides’ remaining resources — separating revealed facts from inference.',
      'Weigh every legal switch by exact legalActions[] string: typing into the revealed sets, speed, bulk, immediate pressure, and synergy with your remaining active Pokemon.',
      'For each serious send-in, name what it risks: arrival punishes, double targeting next turn, feeding a setup sweeper, or spending a Pokemon your endgame needs.',
      'State the plan the chosen send-in enables on the next turn and how it advances your win conditions.',
      'Then commit to one exact legal action from legalActions[].',
    ];
  }
  return [
    'Summarize the complete current board state: HP, status, boosts, field effects, speed order, positioning, revealed information, and each side’s remaining resources.',
    'Appraise each revealed Pokemon’s set from known nature, stats, moves, item, ability, damage, and speed evidence: fast, bulky, offensive, supportive, setup, or mixed — and which plausible variants remain.',
    'Name what is still unknown, and which reasonable sets, speed tiers, damage ranges, items, abilities, or unrevealed Pokemon must be respected without treating them as facts.',
    'Account for held items: your own are known; opponent items only when revealed. Weigh Choice locks, berries, Focus Sash, Life Orb, Assault Vest, and similar effects in damage and speed reads.',
    'Predict what the opponent is most likely trying to accomplish this turn, and which alternative attacks, targets, switches, protects, support moves, or Terastallizations must also be covered.',
    'Name the most immediate tactical threats: possible knockouts, disruption, setup, speed control, targeting combinations, and dangerous action-order interactions.',
    'Describe your realistic paths to winning, and which Pokemon, matchup advantages, resources, field conditions, or favorable endgames must be created or preserved.',
    'Name the sequences that could lose you the game, immediately or over the next several turns, and which of those failure conditions must be prevented this turn.',
    'Decide explicitly whether anyone should Terastallize — whose Tera type flips a key matchup, and whether spending your once-per-battle Tera now beats saving it — and whether any active Pokemon should switch out instead of acting.',
    'List the legal actions that deserve serious consideration by exact legalActions[] string — attacks with each viable target, switches out of bad matchups, protects and support moves, and Terastallization variants — and how each advances your plan or covers theirs.',
    'Project how each strongest candidate performs against the opponent’s likely action and its most dangerous credible alternatives, and what position each outcome creates next turn.',
    'State why the chosen action is most robust across uncertainty, immediate value, worst-case risk, resource preservation, and future flexibility — and your intended follow-up plan.',
    'Then commit to one exact legal action from legalActions[].',
  ];
}

export function buildChoicePrompt(role, observation, legalActions) {
  return [
    'You are a competitive Pokemon doubles player controlling one side in a local Pokemon Showdown benchmark battle.',
    'The JSON payload is your screen-equivalent state: your private team, the visible opponent information, the visible battle log, field state, side conditions, and exact legal Showdown choices.',
    'First write concise public tactical notes answering every field in responseOrder, in that order — the payload tailors the fields to this decision (a full turn, or picking a replacement after a faint). Keep confirmed information clearly separate from inference.',
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
  // The field list matches the request's decision type (turn vs forced
  // replacement). Every question is always answerable, so every field demands
  // at least one entry.
  const analysisFields = analysisFieldsFor(legalActions);
  const properties = Object.fromEntries(analysisFields.map(field => [field, {...tacticalArray, minItems: 1}]));
  for (const field of ['candidateChoices', 'replacementMatchups']) {
    if (!properties[field]) continue;
    // These lines each start with an exact legal choice string, so they run longer.
    properties[field] = {
      type: 'array',
      items: {type: 'string', maxLength: 520},
      minItems: 1,
    };
  }
  properties.choice = choices.length ? {type: 'string', enum: choices} : {type: 'string'};
  properties.reason = {type: 'string', maxLength: 400};
  return {
    type: 'object',
    properties,
    required: [...analysisFields, 'choice', 'reason'],
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
    setArchetypes: stringList(parsed.setArchetypes || parsed.archetypes || parsed.setAppraisal || parsed.revealedSets),
    unknownInformation: stringList(parsed.unknownInformation || parsed.unknowns || parsed.hiddenInformation || parsed.openInformation),
    opponentLikelyPlan: stringList(parsed.opponentLikelyPlan || parsed.opponentPlan || parsed.opponentMostLikely),
    biggestThreats: stringList(parsed.biggestThreats || parsed.threats),
    winConditions: stringList(parsed.winConditions || parsed.winCons || parsed.pathToWin || parsed.pathsToWin),
    loseConditions: stringList(parsed.loseConditions || parsed.losingConditions || parsed.lossConditions || parsed.pathsToLoss),
    teraAndSwitchCheck: stringList(parsed.teraAndSwitchCheck || parsed.teraCheck || parsed.teraSwitchCheck || parsed.teraAndSwitches),
    candidateChoices: stringList(parsed.candidateChoices || parsed.candidateChoiceReview || parsed.choiceReview || parsed.consideredChoices || parsed.shortlist),
    candidateOutcomes: stringList(parsed.candidateOutcomes || parsed.lineProjections || parsed.outcomeProjections || parsed.candidateProjections),
    decisionCheck: stringList(parsed.decisionCheck || parsed.riskAssessment || parsed.robustnessCheck || parsed.finalCheck),
    replacementMatchups: stringList(parsed.replacementMatchups || parsed.switchMatchups || parsed.replacementOptions || parsed.sendInMatchups),
    replacementRisks: stringList(parsed.replacementRisks || parsed.switchRisks || parsed.sendInRisks),
    replacementPlan: stringList(parsed.replacementPlan || parsed.switchPlan || parsed.sendInPlan),
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
      switching: 'Parts beginning "switch N" replace that active Pokemon with bench slot N. Switching is a normal turn option for escaping bad matchups, not only a forced replacement after a faint. After Revival Blessing, "switch N" instead selects the fainted Pokemon in slot N to revive at half HP.',
      terastallize: 'A move part ending in "terastallize" changes that Pokemon to its teraType before it attacks — available once per battle for your side, so weigh the timing every turn it appears.',
      pass: 'A "pass" part means that slot takes no action this request (already fainted or not required to act).',
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
