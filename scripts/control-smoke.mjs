import {BattleSession} from '../src/battle-session.mjs';

const battle = new BattleSession({seed: [101, 202, 303, 404]});

let phase = 0;
let finished = false;
const timeout = setTimeout(() => fail('control smoke timed out'), 9000);

battle.onEvent(event => {
  if (event.type !== 'state' || finished) return;
  const p1 = battle.extractState('p1');
  const p2 = battle.extractState('p2');

  if (phase === 2) {
    const p1Extracted = battle.extractState('p1').extracted;
    const p2Extracted = battle.extractState('p2').extracted;
    const sawSwitch = p1Extracted.history.text.some(line => line.includes('switched in'));
    const sawTera = p1Extracted.history.text.some(line => line.includes('Terastallized'));
    if (!sawSwitch || !sawTera) return;
    finished = true;
    clearTimeout(timeout);
    console.log(JSON.stringify({
      ok: true,
      turn: p1.turn,
      p1Active: activeNames(p1Extracted.self),
      p2Active: activeNames(p2Extracted.self),
      p1HistoryTail: p1Extracted.history.text.slice(-10),
    }, null, 2));
    process.exit(0);
  }

  if (!p1.legalActions.length || !p2.legalActions.length) return;

  if (phase === 0) {
    const p1Switch = findAction(p1.legalActions, part => part.type === 'switch');
    const p2Move = firstMove(p2.legalActions);
    if (!p1Switch || !p2Move) return;
    phase = 1;
    battle.choose('p1', p1Switch.choice);
    battle.choose('p2', p2Move.choice);
    return;
  }

  if (phase === 1 && p1.turn >= 2 && p2.turn >= 2) {
    const p1Tera = findAction(p1.legalActions, part => part.type === 'move' && part.choice.includes('terastallize'));
    const p2Move = firstMove(p2.legalActions);
    if (!p1Tera || !p2Move) return;
    phase = 2;
    battle.choose('p1', p1Tera.choice);
    battle.choose('p2', p2Move.choice);
    return;
  }
});

function firstMove(actions) {
  return findAction(actions, part => part.type === 'move' && !part.choice.includes('terastallize')) || actions[0];
}

function findAction(actions, predicate) {
  return actions.find(action => {
    if (predicate(action)) return true;
    return (action.choices || []).some(predicate);
  });
}

function activeNames(side = {}) {
  const names = (side.activePokemon || []).map(mon => mon.name).filter(Boolean);
  return names.length ? names.join(' + ') : side.active?.name || null;
}

function fail(message) {
  clearTimeout(timeout);
  console.error(`Control smoke failed: ${message}`);
  process.exit(1);
}
