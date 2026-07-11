import {BattleSession} from '../src/battle-session.mjs';

await staleRequestContract();

console.log(JSON.stringify({ok: true, staleRequestRejected: true}, null, 2));

async function staleRequestContract() {
  const writes = [];
  const events = [];
  const battle = Object.create(BattleSession.prototype);
  battle.latestRequest = {p1: {rqid: 2, active: []}, p2: null};
  battle.latestRequestTurn = {p1: 2, p2: 0};
  battle.consumedRequestKeys = {p1: new Set(), p2: new Set()};
  battle.listeners = new Set([event => events.push(event)]);
  battle.public = {turn: 2};
  battle.streams = {p1: {write: async choice => writes.push(choice)}};

  assertThrows(() => battle.choose('p1', 'move 1 1, move 1 1', 1), /Stale request/);
  assert(writes.length === 0, 'stale choice reached the simulator');
  assert(events.length === 0, 'stale choice emitted a choice event');
  assert(battle.consumedRequestKeys.p1.size === 0, 'stale choice consumed the latest request');

  battle.choose('p1', 'move 1 1, move 1 1', 2);
  await new Promise(resolve => setImmediate(resolve));
  assert(writes.length === 1, 'current choice did not reach the simulator');
  assert(events[0]?.rqid === 2, 'current choice emitted the wrong request id');
  assert(battle.consumedRequestKeys.p1.size === 1, 'current choice did not consume its request');
}

function assertThrows(callback, pattern) {
  let error = null;
  try {
    callback();
  } catch (caught) {
    error = caught;
  }
  assert(error && pattern.test(String(error.message || error)), `expected error matching ${pattern}`);
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
