export function getLegalActions(request) {
  if (!request || request.wait) return [];
  if (request.teamPreview) {
    return [{type: 'team', label: 'Default lead order', choice: 'default'}];
  }
  if (request.forceSwitch) {
    return getForceSwitchActions(request);
  }
  if (!request.active) return [];
  if (request.active.length > 1) return getCombinedActiveActions(request);

  const actions = [];
  for (const [activeIndex, active] of request.active.entries()) {
    if (!active) continue;
    actions.push(...getMoveOptionsForActive(request, active, activeIndex, false));
    if (!active.trapped) actions.push(...getSwitchActions(request, false, activeIndex));
  }
  return actions;
}

export function pickAutoChoice(actions) {
  if (!actions?.length) return null;
  return (
    actions.find(action => action.type === 'double-choice' && action.choices?.some(part => part.type === 'move')) ||
    actions.find(action => action.type === 'move') ||
    actions[0]
  );
}

function getCombinedActiveActions(request) {
  const optionLists = request.active.map((active, activeIndex) => {
    const activeMon = request.side?.pokemon?.[activeIndex];
    if (!active || activeMon?.condition?.endsWith(' fnt') || activeMon?.commanding) return [getPassAction(activeIndex)];
    const options = [
      ...getMoveOptionsForActive(request, active, activeIndex, true),
      ...(!active.trapped ? getSwitchActions(request, false, activeIndex) : []),
    ];
    return options.length ? options : [getPassAction(activeIndex)];
  });
  return combineActiveOptions(optionLists);
}

function getForceSwitchActions(request) {
  if (!Array.isArray(request.forceSwitch) || request.forceSwitch.length <= 1) {
    return getSwitchActions(request, true, 0);
  }
  // With fewer healthy bench mons than slots to fill (double faint, one mon
  // left), the same mon must not be offered to both slots — earlier slots
  // claim the bench, later slots pass ("switch 6, pass"), matching what the
  // native client submits. Without this the combiner dedupes every combo
  // away and the request has zero legal actions, hanging the match.
  const benchCount = countSwitchableBench(request);
  let slotsAlreadyFilling = 0;
  const optionLists = request.forceSwitch.map((mustSwitch, activeIndex) => {
    if (!mustSwitch) return [getPassAction(activeIndex)];
    if (benchCount <= slotsAlreadyFilling) return [getPassAction(activeIndex)];
    slotsAlreadyFilling += 1;
    const switches = getSwitchActions(request, true, activeIndex);
    return switches.length ? switches : [getPassAction(activeIndex)];
  });
  return combineActiveOptions(optionLists);
}

function countSwitchableBench(request) {
  return (request.side?.pokemon || [])
    .filter(mon => mon && !mon.active && !String(mon.condition || '').endsWith(' fnt'))
    .length;
}

function getMoveOptionsForActive(request, active, activeIndex, includeTargets) {
  const actions = [];
  for (const [index, move] of (active.moves || []).entries()) {
    if (move.disabled) continue;
    for (const targetLoc of targetLocsForMove(move.target, activeIndex, request)) {
      actions.push(createMoveAction(activeIndex, index, move, targetLoc, false, includeTargets));
      if (active.canTerastallize) {
        actions.push(createMoveAction(activeIndex, index, move, targetLoc, true, includeTargets));
      }
    }
  }
  return actions;
}

function createMoveAction(activeIndex, moveIndex, move, targetLoc, terastallize, includeTargets) {
  const targetText = targetLoc ? ` ${targetLoc}` : '';
  const teraText = terastallize ? ' terastallize' : '';
  const targetSlot = targetLoc && targetLoc > 0 ? targetLoc : null;
  const allyTargetSlot = targetLoc && targetLoc < 0 ? Math.abs(targetLoc) : null;
  const targetLabel = targetSlot ? ` -> foe ${targetSlot}` : allyTargetSlot ? ` -> ally ${allyTargetSlot}` : '';
  return {
    type: 'move',
    activeSlot: activeIndex + 1,
    slot: moveIndex + 1,
    move: terastallize ? `${move.move} + Terastallize` : move.move,
    id: move.id,
    pp: move.pp,
    maxpp: move.maxpp,
    target: move.target,
    targetLoc: targetLoc || null,
    targetSlot,
    allyTargetSlot,
    label: `Active ${activeIndex + 1}: ${move.move}${targetLabel}${terastallize ? ' + Tera' : ''}`,
    choice: `move ${moveIndex + 1}${includeTargets ? targetText : ''}${teraText}`,
  };
}

function targetLocsForMove(target, activeIndex, request) {
  const activeCount = request.active?.length || 1;
  if (activeCount <= 1 || !targetTypeNeedsChoice(target)) return [null];
  const foeSlots = Array.from({length: activeCount}, (_, index) => index + 1);
  const selfSlot = activeIndex + 1;
  const allySlot = activeCount > 1 ? (activeIndex ^ 1) + 1 : null;
  const allyAlive = allySlot ? !String(request.side?.pokemon?.[allySlot - 1]?.condition || '').endsWith(' fnt') : false;
  if (target === 'adjacentAlly') return allyAlive ? [-allySlot] : [];
  if (target === 'adjacentAllyOrSelf') return allyAlive ? [-allySlot, -selfSlot] : [-selfSlot];
  if (target === 'any') return allyAlive ? [...foeSlots, -allySlot] : foeSlots;
  return foeSlots;
}

function targetTypeNeedsChoice(target) {
  return ['normal', 'randomNormal', 'any', 'adjacentFoe', 'adjacentAlly', 'adjacentAllyOrSelf'].includes(target);
}

function getSwitchActions(request, forced, activeIndex = 0) {
  const pokemon = request.side?.pokemon || [];
  return pokemon
    .map((mon, index) => ({mon, slot: index + 1}))
    .filter(({mon}) => mon && !mon.active && !String(mon.condition || '').endsWith(' fnt'))
    .map(({mon, slot}) => ({
      type: forced ? 'force-switch' : 'switch',
      activeSlot: activeIndex + 1,
      slot,
      pokemon: cleanPokemonName(mon.ident || mon.details || `Slot ${slot}`),
      condition: mon.condition,
      label: `Active ${activeIndex + 1}: switch to ${cleanPokemonName(mon.ident || mon.details || `Slot ${slot}`)}`,
      choice: `switch ${slot}`,
    }));
}

function getPassAction(activeIndex) {
  return {
    type: 'pass',
    activeSlot: activeIndex + 1,
    label: `Active ${activeIndex + 1}: pass`,
    choice: 'pass',
  };
}

function combineActiveOptions(optionLists) {
  let combos = [[]];
  for (const options of optionLists) {
    const next = [];
    for (const combo of combos) {
      for (const option of options) {
        if (option.choice.includes('terastallize') && combo.some(part => part.choice.includes('terastallize'))) {
          continue;
        }
        if (option.type === 'switch' || option.type === 'force-switch') {
          if (combo.some(part => (part.type === 'switch' || part.type === 'force-switch') && part.slot === option.slot)) {
            continue;
          }
        }
        next.push([...combo, option]);
      }
    }
    combos = next;
  }
  return combos.map(parts => {
    const nonPassParts = parts.filter(part => part.type !== 'pass');
    const choiceParts = parts.map(part => part.choice);
    return {
      type: 'double-choice',
      label: parts.map(part => part.label || part.move || part.pokemon || part.choice).join(' / '),
      choice: choiceParts.join(', '),
      choices: parts,
      activeSlots: parts.map(part => part.activeSlot),
      hasSwitch: parts.some(part => part.type === 'switch' || part.type === 'force-switch'),
      hasTerastallize: parts.some(part => part.choice.includes('terastallize')),
      primaryType: nonPassParts[0]?.type || 'pass',
    };
  });
}

function cleanPokemonName(value = '') {
  return String(value).replace(/^p[1-4][a-z]?:\s*/, '').split(',')[0].trim();
}
