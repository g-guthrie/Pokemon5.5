import {createAgent, chooseWithAgent} from '../src/agent-runtime.mjs';

const spec = process.env.AGENT || process.env.AGENT_P1 || 'openai';
const agent = await createAgent(spec);
const observation = {
  schemaVersion: 'showdown-observation.v1',
  perspective: 'p1',
  formatid: 'gen9randomdoublesbattle',
  seed: [1, 2, 3, 4],
  turn: 1,
  waiting: false,
  requestId: 1,
  source: {
    engine: 'pokemon-showdown BattleStream',
    hiddenInfoPolicy: 'official private request + role protocol + own generated team only',
    opponentHiddenTeamIncluded: false,
  },
  self: {
    activePokemon: [{name: 'Testmon A', species: 'Pikachu', condition: '100/100', moves: ['Thunderbolt']}],
    team: [{name: 'Testmon A', species: 'Pikachu', condition: '100/100', moves: ['Thunderbolt']}],
    sideConditions: {},
  },
  opponent: {
    activePokemon: [{name: 'Testmon B', species: 'Charizard', condition: '100/100', movesRevealed: []}],
    revealedTeam: [{name: 'Testmon B', species: 'Charizard', condition: '100/100', movesRevealed: []}],
    sideConditions: {},
  },
  field: {},
  history: {text: ['Turn 1.'], protocol: ['|turn|1']},
};
const legalActions = [
  {type: 'double-choice', choice: 'move 1 1, move 1 1', label: 'Test legal doubles choice', choices: []},
];

try {
  const decision = await chooseWithAgent(agent, 'p1', observation, legalActions, {allowFallback: false});
  console.log(JSON.stringify({
    ok: Boolean(decision.action),
    agent: decision.call.agent,
    provider: decision.call.provider,
    model: decision.call.model,
    choice: decision.action?.choice || '',
    valid: decision.call.valid,
    usage: decision.call.usage,
    responseId: decision.call.responseId,
  }, null, 2));
} catch (error) {
  console.error(error.message);
  process.exit(1);
}
