import {BattleSession} from '../src/battle-session.mjs';

const battle = new BattleSession({seed: [11, 22, 33, 44]});

let finished = false;
const timeout = setTimeout(() => fail('extractor smoke timed out'), 7000);

battle.onEvent(event => {
  if (event.type !== 'state' || finished) return;
  const p1 = battle.extractState('p1');
  const p2 = battle.extractState('p2');
  if (!p1.extracted?.self?.team?.length || !p2.extracted?.self?.team?.length) return;
  if (!p1.extracted?.opponent?.revealedTeam?.length || !p2.extracted?.opponent?.revealedTeam?.length) return;
  if (!p1.legalActions.length || !p2.legalActions.length) return;

  assertPrivateTeam(p1.extracted, 'p1');
  assertPrivateTeam(p2.extracted, 'p2');
  assertOpponentIsLimited(p1.extracted, 'p1');
  assertOpponentIsLimited(p2.extracted, 'p2');
  assertHistory(p1.extracted, 'p1');
  assertHistory(p2.extracted, 'p2');
  assertObservationContract(p1.extracted, 'p1');
  assertObservationContract(p2.extracted, 'p2');

  finished = true;
  clearTimeout(timeout);
  console.log(JSON.stringify({
    ok: true,
    p1: summarize(p1.extracted),
    p2: summarize(p2.extracted),
  }, null, 2));
  process.exit(0);
});

function assertPrivateTeam(extracted, role) {
  if (extracted.self.team.length !== 6) fail(`${role} did not receive full own team`);
  for (const mon of extracted.self.team) {
    if (!mon.species || !mon.item || !mon.ability || !mon.nature || !mon.teraType) {
      fail(`${role} own team is missing set details for ${mon.name}`);
    }
    if (!Array.isArray(mon.moves) || mon.moves.length !== 4) {
      fail(`${role} own team is missing moves for ${mon.name}`);
    }
  }
}

function assertOpponentIsLimited(extracted, role) {
  if (extracted.opponent.revealedTeam.length !== 2) {
    fail(`${role} should know exactly the two initial revealed opponents in doubles, got ${extracted.opponent.revealedTeam.length}`);
  }
  if (extracted.opponent.activePokemon.length !== 2) {
    fail(`${role} should see two active opponent Pokemon in doubles`);
  }
  for (const opponent of extracted.opponent.revealedTeam) {
    if (!opponent.species || !opponent.level || !opponent.condition) {
      fail(`${role} revealed opponent is missing visible details`);
    }
    if (opponent.item || opponent.itemLastKnown || opponent.ability || opponent.movesRevealed.length) {
      fail(`${role} opponent has hidden item/ability/moves before reveal`);
    }
  }
}

function assertHistory(extracted, role) {
  if (!extracted.history.text.some(line => line.includes('Battle started'))) fail(`${role} history missing start text`);
  if (!extracted.history.text.some(line => line.includes('switched in'))) fail(`${role} history missing switch text`);
}

function assertObservationContract(extracted, role) {
  if (extracted.schemaVersion !== 'showdown-observation.v1') fail(`${role} missing observation schema version`);
  if (extracted.type !== 'PlayerObservation') fail(`${role} missing PlayerObservation type`);
  if (extracted.source?.opponentHiddenTeamIncluded !== false) fail(`${role} hidden-info policy is not explicit`);
  if (!extracted.requestFresh || extracted.waiting) fail(`${role} should have a fresh actionable request`);
  if (!extracted.legalActions.every(action => action.schemaType === 'LegalChoice' && action.command === action.choice)) {
    fail(`${role} legal actions are not canonical LegalChoice primitives`);
  }
  if (extracted.opponent.revealedTeam.length >= extracted.self.team.length) {
    fail(`${role} observation appears to include too much opponent team data`);
  }
}

function summarize(extracted) {
  return {
    perspective: extracted.perspective,
    turn: extracted.turn,
    selfTeam: extracted.self.team.map(mon => ({
      name: mon.name,
      item: mon.item,
      ability: mon.ability,
      nature: mon.nature,
      teraType: mon.teraType,
    })),
    opponentRevealed: extracted.opponent.revealedTeam,
    historyLines: extracted.history.text.length,
  };
}

function fail(message) {
  clearTimeout(timeout);
  console.error(`Extractor smoke failed: ${message}`);
  process.exit(1);
}
