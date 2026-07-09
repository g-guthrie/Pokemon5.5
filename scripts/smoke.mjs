import {BattleSession} from '../src/battle-session.mjs';

const battle = new BattleSession({seed: [1, 2, 3, 4]});

let finished = false;
let sawBothRequests = false;
const timeout = setTimeout(() => {
  console.error('Smoke failed: battle did not produce both player requests in time');
  process.exit(1);
}, 6000);

const interval = setInterval(tick, 50);
battle.onEvent(event => {
  if (event.type === 'state') tick();
});

function tick() {
  if (finished) return;
  const p1 = battle.extractState('p1');
  const p2 = battle.extractState('p2');
  if (!sawBothRequests && p1.legalActions.length && p2.legalActions.length) {
    sawBothRequests = true;
    const p1Choice = battle.autoChoose('p1');
    const p2Choice = battle.autoChoose('p2');
    if (!p1Choice || !p2Choice) {
      console.error('Smoke failed: auto chooser could not pick actions');
      process.exit(1);
    }
  }
  const afterP1 = battle.extractState('p1');
  const afterP2 = battle.extractState('p2');
  if (
    sawBothRequests &&
    afterP1.turn >= 2 &&
    afterP2.turn >= 2 &&
    afterP1.legalActions.length &&
    afterP2.legalActions.length &&
    !finished
  ) {
    finished = true;
    clearInterval(interval);
    clearTimeout(timeout);
    console.log(JSON.stringify({
      ok: true,
      formatid: afterP1.formatid,
      seed: afterP1.seed,
      turn: afterP1.turn,
      p1Actions: afterP1.legalActions.length,
      p2Actions: afterP2.legalActions.length,
    }, null, 2));
    process.exit(0);
  }
}
