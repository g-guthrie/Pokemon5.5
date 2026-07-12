import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {
  chooseWithAgent,
  createAgent,
  InsufficientCreditsError,
} from '../src/agent-runtime.mjs';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const previousFetch = globalThis.fetch;
const calls = [];

try {
  globalThis.fetch = async (_url, options = {}) => {
    calls.push(JSON.parse(String(options.body || '{}')));
    return {
      ok: false,
      status: 402,
      json: async () => ({
        error: {
          message: 'This request requires more credits, or fewer max_tokens. You can only afford 3000.',
        },
      }),
    };
  };

  const agent = await createAgent({
    provider: 'openrouter',
    model: 'test/credit-exhaustion',
    reasoningEffort: 'none',
    maxTokens: 8192,
    apiKey: 'test-openrouter-key',
  });

  let thrown = null;
  try {
    await chooseWithAgent(agent, 'p1', observation(), legalActions(), {allowFallback: true});
  } catch (error) {
    thrown = error;
  }

  assert(thrown instanceof InsufficientCreditsError, 'credit rejection should retain its typed error');
  assert(thrown.code === 'INSUFFICIENT_CREDITS', 'credit rejection should expose a stable error code');
  assert(calls.length === 2, 'credit handling should try the affordable token clamp once, then stop');
  assert(calls[0].max_tokens === 8192, 'first request should use the configured token ceiling');
  assert(calls[1].max_tokens === 4096, 'retry should respect the minimum viable token floor');

  const [server, runner, client, html] = await Promise.all([
    fs.readFile(path.join(rootDir, 'src/server.mjs'), 'utf8'),
    fs.readFile(path.join(rootDir, 'src/match-runner.mjs'), 'utf8'),
    fs.readFile(path.join(rootDir, 'public/arena.js'), 'utf8'),
    fs.readFile(path.join(rootDir, 'public/index.html'), 'utf8'),
  ]);
  assert(runner.includes('onInsufficientCredits'), 'match runner is missing the credit-pause handoff');
  assert(server.includes("command === 'credits-retry'"), 'server is missing credit retry');
  assert(server.includes("command === 'credits-fallback'"), 'server is missing explicit fallback recovery');
  for (const id of ['credit-retry', 'credit-change-key', 'credit-fallback', 'credit-end']) {
    assert(client.includes(`$('${id}')`), `client is missing the ${id} action`);
    assert(html.includes(`id="${id}"`), `credit modal is missing the ${id} button`);
  }

  console.log(JSON.stringify({
    ok: true,
    typedError: thrown.name,
    code: thrown.code,
    requestTokenCeilings: calls.map(call => call.max_tokens),
    recoveryActions: ['retry', 'change-key', 'fallback', 'end'],
    paidCalls: 0,
  }, null, 2));
} finally {
  globalThis.fetch = previousFetch;
}

function observation() {
  return {
    schemaVersion: 'showdown-observation.v1',
    perspective: 'p1',
    opponentRole: 'p2',
    formatid: 'gen9randomdoublesbattle',
    turn: 1,
    waiting: false,
    requestId: 1,
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
}

function legalActions() {
  return [{
    type: 'double-choice',
    choice: 'move 1 1, move 1 1',
    command: 'move 1 1, move 1 1',
    label: 'Test legal doubles choice',
    choices: [{type: 'move', choice: 'move 1 1', command: 'move 1 1', move: 'Thunderbolt'}],
  }];
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
