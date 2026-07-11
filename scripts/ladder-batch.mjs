import {runLadderBatch} from '../src/ladder-runner.mjs';

const summary = await runLadderBatch({
  watchLocal: process.env.LADDER_WATCH_LOCAL === '1',
});

for (const battle of summary.battles) {
  console.log(`ladder battle ${battle.index}/${summary.battleCount}: ${battle.winnerAgent || 'draw/cap'} turn ${battle.turn ?? '-'}`);
}
console.log(`wrote ${summary.summaryPath}`);
console.log(`wrote ${summary.summaryPath}`);
