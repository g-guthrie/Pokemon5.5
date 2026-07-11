import {getLegalActions} from '../src/legal-choices.mjs';

const activeRequest = createDoublesRequest();
const actions = getLegalActions(activeRequest);
const choices = actions.map(action => action.choice);

assert(actions.length > 0, 'expected active doubles legal actions');
assert(actions.every(action => action.type === 'double-choice'), 'doubles active request should produce combined choices');
assert(choices.includes('move 1 1, move 1'), 'normal move should target opposing slot 1');
assert(choices.includes('move 1 2, move 1'), 'normal move should target opposing slot 2');
assert(choices.includes('move 3 -2, move 1'), 'adjacent ally move should target ally slot');
assert(choices.includes('move 4 -2, move 1'), 'any-target move should include ally target');
assert(choices.includes('move 2, move 1'), 'self-target move should omit target loc');
assert(choices.includes('move 2, move 2'), 'all-adjacent-foes spread move should omit target loc');
assert(choices.includes('move 2, move 4 1'), 'second active normal move should target opposing slot 1');
assert(choices.includes('move 2, move 4 2'), 'second active normal move should target opposing slot 2');
assert(!choices.some(choice => /\bmove 5\b/.test(choice)), 'disabled moves should not appear in legal choices');
assert(choices.some(choice => choice.includes('terastallize')), 'tera choices should be present when allowed');
assert(choices.every(choice => count(choice, 'terastallize') <= 1), 'a combined doubles choice must not tera both active Pokemon');
assert(!choices.some(choice => /switch 3, switch 3/.test(choice)), 'combined switches must not switch both active slots to the same bench slot');

const secondActiveTargeted = actions.find(action => action.choice === 'move 2, move 4 2');
assert(secondActiveTargeted?.choices?.[1]?.activeSlot === 2, 'second active target metadata should preserve active slot');
assert(secondActiveTargeted?.choices?.[1]?.targetSlot === 2, 'second active target metadata should preserve foe target slot');
assert(secondActiveTargeted?.choices?.[1]?.targetLoc === 2, 'second active target metadata should preserve raw target loc');

const allyTargeted = actions.find(action => action.choice === 'move 3 -2, move 1');
assert(allyTargeted?.choices?.[0]?.allyTargetSlot === 2, 'ally target metadata should preserve ally slot');

const teraAction = actions.find(action => action.choice === 'move 1 1 terastallize, move 1');
assert(teraAction?.hasTerastallize, 'combined Tera metadata missing');
assert(teraAction.choices.filter(part => part.choice.includes('terastallize')).length === 1, 'Tera metadata should identify exactly one Tera part');

const trappedActions = getLegalActions(createDoublesRequest({trapFirstActive: true}));
assert(!trappedActions.some(action => action.choices?.[0]?.type === 'switch'), 'trapped active slot should not get switch options');
assert(trappedActions.some(action => action.choices?.[1]?.type === 'switch'), 'untrapped partner should still get switch options');

const forcedActions = getLegalActions(createForceSwitchRequest([true, false]));
assert(forcedActions.some(action => action.choice === 'switch 3, pass'), 'forced switch slot should pair with pass for non-forced slot');
assert(!forcedActions.some(action => action.choice.startsWith('pass, switch')), 'non-forced forceSwitch slot should not switch');

const doubleForcedActions = getLegalActions(createForceSwitchRequest([true, true]));
assert(doubleForcedActions.every(action => {
  const switches = action.choices.filter(part => part.type === 'force-switch').map(part => part.slot);
  return switches.length === new Set(switches).size;
}), 'double forced switches must not choose the same bench Pokemon twice');

// Double faint with a single healthy bench mon: the only legal answer is
// "switch N, pass" — never zero actions (which hangs the match runner).
const lastMonForcedActions = getLegalActions(createLastMonForceSwitchRequest());
assert(lastMonForcedActions.length > 0, 'double forced switch with one bench mon must still offer a choice');
assert(lastMonForcedActions.some(action => action.choice === 'switch 6, pass'), 'last-mon double forced switch should fill slot 1 and pass slot 2');
assert(!lastMonForcedActions.some(action => action.choice === 'pass, pass'), 'last-mon double forced switch must not offer a full pass');

const faintedActions = getLegalActions(createDoublesRequest({faintFirstActive: true}));
assert(faintedActions.some(action => action.choice.startsWith('pass, move')), 'fainted active slot should pass while partner acts');

const teamPreview = getLegalActions({teamPreview: true});
assert(teamPreview.length === 1 && teamPreview[0].choice === 'default', 'team preview should expose default lead order');

console.log(JSON.stringify({
  ok: true,
  activeChoices: actions.length,
  trappedChoices: trappedActions.length,
  forcedChoices: forcedActions.length,
  doubleForcedChoices: doubleForcedActions.length,
  faintedChoices: faintedActions.length,
}, null, 2));

function createDoublesRequest(options = {}) {
  return {
    rqid: 1,
    active: [
      {
        trapped: Boolean(options.trapFirstActive),
        canTerastallize: true,
        moves: [
          move('Thunderbolt', 'thunderbolt', 'normal'),
          move('Protect', 'protect', 'self'),
          move('Helping Hand', 'helpinghand', 'adjacentAlly'),
          move('Pollen Puff', 'pollenpuff', 'any'),
          {...move('Disabled', 'disabled', 'normal'), disabled: true},
        ],
      },
      {
        trapped: false,
        canTerastallize: true,
        moves: [
          move('Earthquake', 'earthquake', 'allAdjacent'),
          move('Icy Wind', 'icywind', 'allAdjacentFoes'),
          move('Recover', 'recover', 'self'),
          move('Tackle', 'tackle', 'normal'),
        ],
      },
    ],
    side: {
      pokemon: [
        pokemon('p1a: Alpha', true, options.faintFirstActive ? '0 fnt' : '100/100'),
        pokemon('p1b: Beta', true, '100/100'),
        pokemon('p1: Gamma', false, '100/100'),
        pokemon('p1: Delta', false, '100/100'),
        pokemon('p1: Epsilon', false, '0 fnt'),
        pokemon('p1: Zeta', false, '100/100'),
      ],
    },
  };
}

function createLastMonForceSwitchRequest() {
  return {
    rqid: 3,
    forceSwitch: [true, true],
    side: {
      pokemon: [
        pokemon('p1a: Alpha', true, '0 fnt'),
        pokemon('p1b: Beta', true, '0 fnt'),
        pokemon('p1: Gamma', false, '0 fnt'),
        pokemon('p1: Delta', false, '0 fnt'),
        pokemon('p1: Epsilon', false, '0 fnt'),
        pokemon('p1: Zeta', false, '100/100'),
      ],
    },
  };
}

function createForceSwitchRequest(forceSwitch) {
  return {
    rqid: 2,
    forceSwitch,
    side: {
      pokemon: [
        pokemon('p1a: Alpha', true, '0 fnt'),
        pokemon('p1b: Beta', true, '100/100'),
        pokemon('p1: Gamma', false, '100/100'),
        pokemon('p1: Delta', false, '100/100'),
        pokemon('p1: Epsilon', false, '100/100'),
        pokemon('p1: Zeta', false, '0 fnt'),
      ],
    },
  };
}

function move(moveName, id, target) {
  return {move: moveName, id, target, pp: 8, maxpp: 8, disabled: false};
}

function pokemon(ident, active, condition) {
  return {ident, details: ident.replace(/^p1[a-z]?:\s*/, ''), active, condition};
}

function count(value, needle) {
  return String(value).split(needle).length - 1;
}

function assert(condition, message) {
  if (!condition) {
    console.error(`Choice contract failed: ${message}`);
    process.exit(1);
  }
}
