import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {
  artifactHrefForPath,
  eventPathForArtifact,
  eventsFromMatchArtifact,
  writeJsonl,
} from '../src/event-log.mjs';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outputPath = path.join(rootDir, 'artifacts', 'event-log-smoke.json');
const eventsPath = eventPathForArtifact(outputPath);

const match = {
  schemaVersion: 'showdown-match-artifact.v1',
  startedAt: '2026-05-27T00:00:00.000Z',
  finishedAt: '2026-05-27T00:00:02.000Z',
  battleId: 'event-log-smoke',
  formatid: 'gen9randomdoublesbattle',
  seed: [550000, 1, 550017, 550101],
  serverOrigin: 'http://localhost:3107',
  serverUrl: 'ws://localhost:3107/ws',
  maxTurns: 40,
  moveDelayMs: 5,
  allowFallback: false,
  agents: {
    p1: {provider: 'standin', model: 'standin-dex-heuristic-v1'},
    p2: {provider: 'standin', model: 'standin-dex-heuristic-v1'},
  },
  eventsPath,
  eventsHref: artifactHrefForPath(eventsPath),
  hello: {
    p1: {type: 'hello', role: 'p1', battleId: 'event-log-smoke'},
  },
  protocol: [
    {at: '2026-05-27T00:00:00.100Z', role: 'spectator', chunk: '|turn|1\n'},
  ],
  observations: [
    {
      at: '2026-05-27T00:00:00.200Z',
      index: 0,
      role: 'p1',
      turn: 1,
      requestId: 1,
      legalActions: [
        {
          schemaType: 'LegalChoice',
          choice: 'move 1 1, move 2 2',
          command: 'move 1 1, move 2 2',
          type: 'double-choice',
          label: 'Tackle + Protect',
          choices: [
            {choice: 'move 1 1', command: 'move 1 1', type: 'move', move: 'Tackle', activeSlot: 1, targetSlot: 1},
            {choice: 'move 2 2', command: 'move 2 2', type: 'move', move: 'Protect', activeSlot: 2, targetSlot: 2},
          ],
        },
      ],
      observation: {
        schemaVersion: 'showdown-observation.v1',
        perspective: 'p1',
        formatid: 'gen9randomdoublesbattle',
        turn: 1,
        requestId: 1,
        requestFresh: true,
        waiting: false,
        source: {
          opponentHiddenTeamIncluded: false,
          protocolRole: 'p1',
          requestFresh: true,
        },
        self: {
          activePokemon: [{name: 'Miraidon', species: 'Miraidon'}],
          team: [
            {
              slot: 1,
              activeSlot: 1,
              name: 'Miraidon',
              species: 'Miraidon',
              condition: '341/341',
              active: true,
              item: 'Choice Specs',
              ability: 'Hadron Engine',
              nature: 'Timid',
              moves: ['Electro Drift', 'Draco Meteor', 'Volt Switch', 'Protect'],
              teraType: 'Electric',
              evs: {spa: 252, spe: 252},
              ivs: {hp: 31, atk: 0, def: 31, spa: 31, spd: 31, spe: 31},
            },
          ],
        },
        opponent: {
          activePokemon: [{name: 'Arcanine', species: 'Arcanine'}],
          revealedTeam: [{name: 'Arcanine', species: 'Arcanine', revealed: true, active: true, movesRevealed: ['Flare Blitz']}],
        },
        legalActions: [],
      },
    },
  ],
  modelCalls: [
    {
      at: '2026-05-27T00:00:00.300Z',
      observationIndex: 0,
      role: 'p1',
      provider: 'standin',
      agent: 'runner-standin-p1',
      model: 'standin-dex-heuristic-v1',
      requestedChoice: 'move 1 1, move 2 2',
      choice: 'move 1 1, move 2 2',
      valid: true,
      fallback: false,
      reason: 'synthetic event log smoke',
      prompt: 'prompt should stay in the JSON artifact, not the JSONL stream',
      rawText: '{"choice":"move 1 1, move 2 2","reason":"ok"}',
      usage: {total_tokens: 0},
    },
  ],
  actions: [
    {
      at: '2026-05-27T00:00:00.400Z',
      role: 'p1',
      turn: 1,
      requestId: 1,
      choice: 'move 1 1, move 2 2',
      observationIndex: 0,
      callIndex: 0,
      action: {
        choice: 'move 1 1, move 2 2',
        command: 'move 1 1, move 2 2',
        type: 'double-choice',
      },
    },
  ],
  result: {done: true, winner: 'Benchmark P1', turn: 1, reason: ''},
  validBenchmark: true,
  apiErrorCount: 0,
  fallbackCount: 0,
  invalidChoiceCount: 0,
  usage: {calls: 1, totalTokens: 0},
};

const events = eventsFromMatchArtifact(match);
assert(events[0]?.type === 'match_start', 'first event should be match_start');
assert(events.at(-1)?.type === 'match_end', 'last event should be match_end');
assert(events.every((event, index) => event.eventIndex === index), 'event indexes should be contiguous');
assert(events.some(event => event.type === 'observation' && event.legalChoices?.[0]?.choice === 'move 1 1, move 2 2'), 'missing legal choice summary');
assert(events.some(event => event.type === 'observation' && event.ownTeam?.[0]?.item === 'Choice Specs'), 'missing own-team known info');
assert(events.some(event => event.type === 'observation' && event.source?.opponentHiddenTeamIncluded === false), 'hidden-info source marker missing');
assert(events.some(event => event.type === 'model_call' && event.rawTextRef?.sha256 && event.rawText), 'missing model call digest/response');
assert(!JSON.stringify(events).includes('prompt should stay'), 'event JSONL should not duplicate full prompts');

await writeJsonl(eventsPath, events);
const parsed = (await fs.readFile(eventsPath, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
assert(parsed.length === events.length, 'persisted event count mismatch');
assert(parsed[0].schemaVersion === 'showdown-event-log.v1', 'wrong event schema version');

console.log(JSON.stringify({
  ok: true,
  events: parsed.length,
  outputPath,
  eventsPath,
}, null, 2));

function assert(condition, message) {
  if (!condition) {
    console.error(`Event log smoke failed: ${message}`);
    process.exit(1);
  }
}
