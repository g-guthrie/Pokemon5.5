import {runTournamentBatch} from '../src/tournament-runner.mjs';

const summary = await runTournamentBatch({
  watchLocal: process.env.TOURNAMENT_WATCH_LOCAL === '1',
});

for (const pair of summary.pairs) {
  const totals = pair.totals || {};
  console.log(
    `tournament pair ${pair.index}/${summary.pairCount}: ` +
    `${pair.agents.a.name} vs ${pair.agents.b.name} ` +
    `A ${totals.agentAWins || 0} / B ${totals.agentBWins || 0} / draw ${totals.drawsOrCaps || 0}`
  );
}
console.log(`wrote ${summary.summaryPath}`);
console.log(`wrote ${summary.ratingStorePath}`);
