import {BattleSession} from '../src/battle-session.mjs';

const battle = new BattleSession({seed: [11, 22, 33, 44]});

let finished = false;
const timeout = setTimeout(() => fail('hidden-info contract timed out'), 7000);

battle.onEvent(event => {
  if (event.type !== 'state' || finished) return;
  const p1 = battle.extractState('p1');
  const p2 = battle.extractState('p2');
  if (!p1.legalActions.length || !p2.legalActions.length) return;

  assertHiddenBoundary(p1.extracted, battle.teams.p2, 'p1');
  assertHiddenBoundary(p2.extracted, battle.teams.p1, 'p2');
  assertLegalChoiceSurface(p1.extracted, 'p1');
  assertLegalChoiceSurface(p2.extracted, 'p2');

  const p1Choice = firstNonSwitchChoice(p1.legalActions);
  const p2Choice = firstNonSwitchChoice(p2.legalActions);
  if (!p1Choice || !p2Choice) fail('could not find non-switch choices for both players');
  battle.choose('p1', p1Choice.choice);
  battle.choose('p2', p2Choice.choice);
  finished = true;
  clearTimeout(timeout);

  setTimeout(() => {
    const afterP1 = battle.extractState('p1').extracted;
    const afterP2 = battle.extractState('p2').extracted;
    assertHiddenBoundary(afterP1, battle.teams.p2, 'p1 after turn');
    assertHiddenBoundary(afterP2, battle.teams.p1, 'p2 after turn');
    assert(afterP1.history.protocol.every(line => !line.includes('|request|')), 'p1 public history leaked private request protocol');
    assert(afterP2.history.protocol.every(line => !line.includes('|request|')), 'p2 public history leaked private request protocol');
    console.log(JSON.stringify({
      ok: true,
      initial: {
        p1Revealed: p1.extracted.opponent.revealedTeam.map(mon => mon.name),
        p2Revealed: p2.extracted.opponent.revealedTeam.map(mon => mon.name),
      },
      afterTurn: {
        p1Revealed: afterP1.opponent.revealedTeam.map(mon => mon.name),
        p2Revealed: afterP2.opponent.revealedTeam.map(mon => mon.name),
      },
    }, null, 2));
    process.exit(0);
  }, 500);
});

function assertHiddenBoundary(extracted, opponentTeam, label) {
  assert(extracted.self.team.length === 6, `${label} missing full own team`);
  assert(extracted.opponent.revealedTeam.length >= 2, `${label} missing visible active opponents`);
  assert(extracted.opponent.revealedTeam.length < 6, `${label} should not know full opponent team this early`);

  const knownOpponentText = JSON.stringify(extracted.opponent);
  const revealedSpecies = new Set(extracted.opponent.revealedTeam.map(mon => mon.species || mon.name));
  const hiddenSpecies = opponentTeam
    .map(mon => mon.species || mon.name)
    .filter(species => species && !revealedSpecies.has(species));
  for (const species of hiddenSpecies) {
    assert(!knownOpponentText.includes(species), `${label} leaked hidden opponent species ${species}`);
  }

  for (const mon of extracted.opponent.revealedTeam) {
    assert(mon.knowledge === 'observed-public-protocol', `${label} opponent knowledge provenance missing for ${mon.name}`);
  }
  for (const mon of extracted.self.team) {
    assert(mon.knowledge === 'full-own-team', `${label} own-team knowledge provenance missing for ${mon.name}`);
    assert(mon.item && mon.ability && mon.nature && mon.teraType, `${label} own team missing private set detail for ${mon.name}`);
  }
}

function assertLegalChoiceSurface(extracted, label) {
  assert(extracted.legalActions.length > 0, `${label} has no legal actions`);
  assert(extracted.legalActions.every(action => action.schemaType === 'LegalChoice'), `${label} legal action schemaType missing`);
  assert(extracted.legalActions.every(action => action.choice === action.command), `${label} choice/command mismatch`);
}

function firstNonSwitchChoice(actions) {
  return actions.find(action => action.type === 'double-choice' && !action.hasSwitch && !action.hasTerastallize) ||
    actions.find(action => action.type === 'double-choice' && !action.hasSwitch) ||
    actions[0];
}

function assert(condition, message) {
  if (!condition) fail(message);
}

function fail(message) {
  clearTimeout(timeout);
  console.error(`Hidden-info contract failed: ${message}`);
  process.exit(1);
}
