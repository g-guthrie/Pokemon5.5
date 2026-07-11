import {
  PROMPT_SCHEMA_VERSION,
  REQUIRED_ANALYSIS_FIELDS,
  TURN_ANALYSIS_FIELDS,
  REPLACEMENT_ANALYSIS_FIELDS,
  RESPONSE_SCHEMA_VERSION,
  buildChoicePrompt,
  buildChoiceResponseJsonSchema,
  buildModelInput,
  buildOpenAIResponseFormat,
  normalizeDecisionAnalysis,
} from '../src/prompt-pipeline.mjs';

const observation = {
  schemaVersion: 'showdown-observation.v1',
  perspective: 'p1',
  opponentRole: 'p2',
  formatid: 'gen9randomdoublesbattle',
  seed: [550000, 1, 550017, 550101],
  turn: 4,
  requestId: 7,
  requestTurn: 4,
  requestFresh: true,
  waiting: false,
  source: {
    engine: 'pokemon-showdown BattleStream',
    hiddenInfoPolicy: 'official private request + role protocol + own generated team only',
    opponentHiddenTeamIncluded: false,
  },
  self: {
    activePokemon: [
      {slot: 1, activeSlot: 1, name: 'Miraidon', species: 'Miraidon', condition: '301/341', active: true, item: 'Choice Specs', ability: 'Hadron Engine', nature: 'Timid', moves: ['Electro Drift', 'Draco Meteor', 'Volt Switch', 'Protect'], teraType: 'Electric', evs: {spa: 252, spe: 252}, ivs: {atk: 0}},
      {slot: 2, activeSlot: 2, name: 'Incineroar', species: 'Incineroar', condition: '332/394', active: true, item: 'Sitrus Berry', ability: 'Intimidate', nature: 'Careful', moves: ['Fake Out', 'Parting Shot', 'Flare Blitz', 'Knock Off'], teraType: 'Grass'},
    ],
    team: [
      {slot: 1, activeSlot: 1, name: 'Miraidon', species: 'Miraidon', condition: '301/341', active: true, item: 'Choice Specs', ability: 'Hadron Engine', nature: 'Timid', moves: ['Electro Drift', 'Draco Meteor', 'Volt Switch', 'Protect'], teraType: 'Electric', evs: {spa: 252, spe: 252}, ivs: {atk: 0}},
      {slot: 2, activeSlot: 2, name: 'Incineroar', species: 'Incineroar', condition: '332/394', active: true, item: 'Sitrus Berry', ability: 'Intimidate', nature: 'Careful', moves: ['Fake Out', 'Parting Shot', 'Flare Blitz', 'Knock Off'], teraType: 'Grass'},
      {slot: 3, name: 'Flutter Mane', species: 'Flutter Mane', condition: '231/231', active: false, item: 'Booster Energy', ability: 'Protosynthesis', nature: 'Timid', moves: ['Moonblast', 'Shadow Ball', 'Icy Wind', 'Protect'], teraType: 'Fairy', stats: {hp: 231, atk: 76, def: 96, spa: 297, spd: 246, spe: 306}},
    ],
    sideConditions: {tailwind: {name: 'Tailwind', layers: 1, startedTurn: 2}},
  },
  opponent: {
    activePokemon: [
      {key: 'p2:arcanine', name: 'Arcanine', species: 'Arcanine', level: 79, condition: '70/100', active: true, revealed: true, itemLastKnown: 'Safety Goggles', ability: 'Intimidate', movesRevealed: ['Flare Blitz', 'Snarl']},
      {key: 'p2:amoonguss', name: 'Amoonguss', species: 'Amoonguss', level: 88, condition: '100/100 slp', active: true, revealed: true, status: 'slp', statusTurn: 3, movesRevealed: ['Spore', 'Rage Powder']},
    ],
    revealedTeam: [
      {key: 'p2:arcanine', name: 'Arcanine', species: 'Arcanine', level: 79, condition: '70/100', active: true, revealed: true, itemLastKnown: 'Safety Goggles', ability: 'Intimidate', movesRevealed: ['Flare Blitz', 'Snarl']},
      {key: 'p2:amoonguss', name: 'Amoonguss', species: 'Amoonguss', level: 88, condition: '100/100 slp', active: true, revealed: true, status: 'slp', statusTurn: 3, movesRevealed: ['Spore', 'Rage Powder']},
    ],
    sideConditions: {},
  },
  field: {terrain: {name: 'Electric Terrain', layers: 1}, weather: null, conditions: {}},
  history: {
    text: ['Miraidon used Electro Drift.', 'Arcanine used Snarl.', 'Turn 4.'],
    protocol: ['|move|p1a: Miraidon|Electro Drift|p2a: Arcanine', '|turn|4'],
  },
};

const legalActions = [
  {
    type: 'double-choice',
    choice: 'move 1 1, move 1 2',
    label: 'Electro Drift + Fake Out',
    hasTerastallize: false,
    choices: [
      {type: 'move', choice: 'move 1 1', move: 'Electro Drift', activeSlot: 1, targetSlot: 1, pp: 7, maxpp: 8},
      {type: 'move', choice: 'move 1 2', move: 'Fake Out', activeSlot: 2, targetSlot: 2, pp: 10, maxpp: 10},
    ],
  },
  {
    type: 'double-choice',
    choice: 'switch 3, move 2 1',
    label: 'Flutter Mane + Parting Shot',
    hasSwitch: true,
    choices: [
      {type: 'switch', choice: 'switch 3', pokemon: 'Flutter Mane', slot: 3},
      {type: 'move', choice: 'move 2 1', move: 'Parting Shot', activeSlot: 2, targetSlot: 1},
    ],
  },
];

const input = buildModelInput('p1', observation, legalActions);
const responseSchema = buildChoiceResponseJsonSchema(legalActions);
const responseFormat = buildOpenAIResponseFormat(legalActions);
assert(input.promptSchemaVersion === PROMPT_SCHEMA_VERSION, 'wrong prompt schema version');
assert(input.responseSchemaVersion === RESPONSE_SCHEMA_VERSION, 'wrong response schema version');
assert(responseFormat.type === 'json_schema' && responseFormat.strict === true, 'OpenAI response format should use strict JSON schema');
assert(responseSchema.additionalProperties === false, 'response schema should reject extra keys');
assert(JSON.stringify(responseSchema.required) === JSON.stringify([...TURN_ANALYSIS_FIELDS, 'choice', 'reason']), 'turn response schema should require the turn analysis fields and choice');
assert(responseSchema.properties.choice.enum.includes('switch 3, move 2 1'), 'response schema should constrain exact legal choices');
assert(input.screenObservation.opponentRole === 'p2', 'opponent role missing');
assert(input.screenObservation.self.team[0].item === 'Choice Specs', 'own item missing');
assert(input.screenObservation.self.team[0].nature === 'Timid', 'own nature missing');
assert(input.screenObservation.self.team[0].moves.includes('Electro Drift'), 'own moves missing');
assert(input.screenObservation.opponent.revealedTeam.length === 2, 'revealed opponent missing');
assert(input.screenObservation.source.opponentHiddenTeamIncluded === false, 'hidden-info marker missing');
assert(!Object.hasOwn(input.screenObservation, 'seed'), 'model-facing screen observation should not include battle seed');
assert(input.battleBriefing?.briefingSchemaVersion === 'battle-briefing.v2', 'battle briefing missing');
assert(input.battleBriefing.visibleBoard.activeMatchup.self.length === 2, 'briefing missing own active slots');
assert(input.battleBriefing.playerViewNow.activeBoard.self.length === 2, 'player view missing own active slots');
assert(input.battleBriefing.playerViewNow.boardMemory.recentEvents.length === 0, 'player view should expose recent events array');
assert(input.battleBriefing.ownSide.bench.some(mon => mon.species === 'Flutter Mane'), 'briefing missing own bench');
assert(input.battleBriefing.opponentSide.active[1].movesRevealed.includes('Spore'), 'briefing missing revealed opponent move');
assert(input.battleBriefing.opponentSide.unrevealedBenchKnown === false, 'briefing should mark opponent bench hidden');
assert(input.battleBriefing.knownUnknowns.opponentBench.includes('unknown'), 'briefing missing hidden opponent bench policy');
assert(JSON.stringify(input.responseOrder) === JSON.stringify([...TURN_ANALYSIS_FIELDS, 'choice', 'reason']), 'turn response order should force analysis before choice');
assert(input.legalActions.includes('switch 3, move 2 1'), 'switch legal action missing');
assert(input.legalActions.every(action => typeof action === 'string'), 'legal actions should be exact choice strings');
assert(input.legalActionPartCatalog.some(part => part.choice === 'switch 3' && part.pokemon === 'Flutter Mane'), 'part catalog missing switch details');

// v7 screen-equivalent context: everything a hover-tooltip shows a human.
assert(input.dexContext.moves['Electro Drift']?.type === 'Electric', 'dex context missing own move card');
assert(Number(input.dexContext.moves['Electro Drift']?.basePower) === 100, 'dex move card missing base power');
assert(input.dexContext.moves['Spore']?.category === 'Status', 'dex context missing revealed opponent move card');
assert(input.dexContext.species['Amoonguss']?.possibleAbilities?.includes('Regenerator'), 'dex species card missing possible abilities');
assert(Array.isArray(input.dexContext.species['Miraidon']?.types), 'dex species card missing typing');
const arcanineBriefing = input.battleBriefing.opponentSide.active.find(mon => mon.species === 'Arcanine');
assert(Number.isFinite(arcanineBriefing?.estimatedStats?.spe), 'opponent briefing missing random-battle stat estimate');
assert(arcanineBriefing?.baseStats?.atk === 110, 'opponent briefing missing base stats');
const amoongussBriefing = input.battleBriefing.opponentSide.active.find(mon => mon.species === 'Amoonguss');
assert(amoongussBriefing?.statusTurnsElapsed === 1, 'opponent briefing missing status turn counter');
const benchFlutterMane = input.battleBriefing.ownSide.bench.find(mon => mon.species === 'Flutter Mane');
assert(benchFlutterMane?.stats?.spe === 306, 'own bench stats should not be stripped');
assert(input.battleBriefing.visibleBoard.sideConditions.self.tailwind?.standardDuration?.includes('4 turns'), 'side condition missing standard duration');
assert(input.battleBriefing.visibleBoard.sideConditions.self.tailwind?.turnsElapsed === 2, 'side condition missing turns elapsed');
assert(input.battleBriefing.opponentSide.unrevealedCount === 4, 'briefing missing unrevealed opponent count');
const miraidonBriefing = input.battleBriefing.ownSide.active.find(mon => mon.species === 'Miraidon');
assert(miraidonBriefing?.types?.includes('Electric'), 'own briefing missing current typing');

const prompt = buildChoicePrompt('p1', observation, legalActions);
for (const needle of [
  PROMPT_SCHEMA_VERSION,
  RESPONSE_SCHEMA_VERSION,
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
  'battleBriefing',
  'playerViewNow',
  'visibleBoard',
  'recentBattleLog',
  'legalChoiceSemantics',
  'candidateChoiceRequirement',
  'Choice Specs',
  'Safety Goggles',
  'move 1 1, move 1 2',
  'opponentHiddenTeamIncluded',
  'dexContext',
  'possibleAbilities',
  'estimatedStats',
  'standardDuration',
  'unrevealedCount',
]) {
  assert(prompt.includes(needle), `prompt missing ${needle}`);
}
assert(!prompt.includes('unrevealed bench species'), 'prompt should not invent opponent bench');
assert(!prompt.includes('550000'), 'prompt should not expose benchmark seed');
assert(prompt.length < 45000, 'synthetic prompt should stay bounded');

const analysis = normalizeDecisionAnalysis({
  gameStateSummary: ['Electric Terrain favors Miraidon.'],
  winConditions: ['Use Miraidon pressure to open a Flutter Mane cleanup.'],
  setArchetypes: ['Amoonguss reads as bulky redirection support.'],
  unknownInformation: ['Arcanine item and fourth move are unrevealed.'],
  opponentLikelyPlan: ['Amoonguss likely uses Rage Powder or Spore.'],
  biggestThreats: ['Spore disruption.'],
  candidateOutcomes: ['Into Rage Powder, the double-up still removes Amoonguss.'],
  decisionCheck: ['Snarl can reduce damage output but the line stays robust.'],
  candidateChoices: [
    'move 1 1, move 1 2: pressures Arcanine and disrupts Amoonguss; risks redirection.',
    'switch 3, move 2 1: preserves Miraidon while Parting Shot lowers Arcanine; risks losing tempo.',
  ],
  choice: 'move 1 1, move 1 2',
  reason: 'Covers redirection and pressures both slots.',
});
assert(analysis.gameStateSummary.length === 1, 'analysis summary missing');
assert(analysis.winConditions[0].includes('Miraidon'), 'win condition missing');
assert(analysis.opponentLikelyPlan[0].includes('Amoonguss'), 'opponent plan missing');
assert(analysis.decisionCheck[0].includes('Snarl'), 'decision check missing');
assert(analysis.setArchetypes[0].includes('Amoonguss'), 'set archetypes missing');
assert(analysis.candidateChoices.length === 2, 'candidate choice review missing');

console.log(JSON.stringify({
  ok: true,
  promptSchemaVersion: PROMPT_SCHEMA_VERSION,
  responseSchemaVersion: RESPONSE_SCHEMA_VERSION,
  promptChars: prompt.length,
  legalActions: input.legalActions.length,
}, null, 2));

function assert(condition, message) {
  if (!condition) {
    console.error(`Prompt pipeline smoke failed: ${message}`);
    process.exit(1);
  }
}
