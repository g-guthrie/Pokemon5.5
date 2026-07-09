import {BattleSession} from '../src/battle-session.mjs';

const defaultCoverageSeeds = [
  [1, 2, 3, 4],
  [11, 22, 33, 44],
  [101, 202, 303, 404],
  [661000, 2, 661034, 661202],
];
const forceSwitchSeed = [101, 202, 303, 404];
const coverageSeeds = parseSeedList(process.env.LEGAL_CANONICAL_SEEDS) || defaultCoverageSeeds;
const submitted = [];
const skipped = [];
let failed = false;

const initialProbes = [
  {
    category: 'targeted-move',
    role: 'p1',
    select: actions => findWholeAction(actions, action =>
      !action.hasSwitch &&
      !action.hasTerastallize &&
      actionHasPart(action, part => part.type === 'move' && part.targetSlot)
    ),
  },
  {
    category: 'active-switch',
    role: 'p1',
    select: actions => findAction(actions, part => part.type === 'switch'),
  },
  {
    category: 'terastallize',
    role: 'p2',
    select: actions => findWholeAction(actions, action =>
      action.hasTerastallize &&
      !action.hasSwitch &&
      actionHasPart(action, part => part.type === 'move')
    ),
  },
];

try {
  for (const seed of coverageSeeds) {
    for (const probe of initialProbes) {
      await runInitialProbe(seed, probe);
    }
  }
  for (const category of initialProbes.map(probe => probe.category)) {
    assert(submitted.some(item => item.category === category), `no real Showdown request covered ${category}`);
  }
  await runForceSwitchScenario(forceSwitchSeed);

  console.log(JSON.stringify({
    ok: true,
    seedCount: coverageSeeds.length,
    probes: initialProbes.length,
    submitted: submitted.map(publicSubmission),
    skipped,
    categories: [...new Set(submitted.map(item => item.category))],
  }, null, 2));
  process.exit(0);
} catch (error) {
  fail(error?.message || error);
}

async function runInitialProbe(seed, probe) {
  const context = createContext(seed, `initial ${probe.category}`, 8000);
  try {
    const initial = await waitFor(context, 'initial actionable doubles requests', ({p1, p2}) =>
      p1.legalActions.length && p2.legalActions.length
    );
    const primaryState = initial[probe.role];
    const partnerRole = otherRole(probe.role);
    const partnerState = initial[partnerRole];
    const primaryAction = probe.select(primaryState.legalActions);
    if (!primaryAction) {
      skipped.push({seed, category: probe.category, role: probe.role, reason: 'category not present in initial request'});
      return;
    }
    const partnerAction = safeMoveAction(partnerState.legalActions);
    assert(partnerAction, `no partner action available for ${probe.category} on seed ${seed.join(',')}`);
    submit(context, probe.role, primaryState, primaryAction, probe.category);
    submit(context, partnerRole, partnerState, partnerAction, `${probe.category}:partner`);
    await waitFor(context, `${probe.category} accepted by Showdown`, ({p1, p2}) =>
      p1.ended ||
      p2.ended ||
      p1.turn > primaryState.turn ||
      p2.turn > primaryState.turn ||
      p1.legalActions.length ||
      p2.legalActions.length
    );
  } finally {
    closeContext(context);
  }
}

async function runForceSwitchScenario(seed) {
  const context = createContext(seed, 'force-switch scenario', 10000);
  try {
    const initial = await waitFor(context, 'initial actionable doubles requests', ({p1, p2}) =>
      p1.legalActions.length && p2.legalActions.length
    );
    const p1Switch = findAction(initial.p1.legalActions, part => part.type === 'switch');
    const p2Targeted = findWholeAction(initial.p2.legalActions, action =>
      !action.hasSwitch &&
      !action.hasTerastallize &&
      actionHasPart(action, part => part.type === 'move' && part.targetSlot)
    );
    assert(p1Switch, 'force-switch seed did not expose an active switch choice');
    assert(p2Targeted, 'force-switch seed did not expose a targeted move choice');
    submit(context, 'p1', initial.p1, p1Switch, 'force-setup-switch');
    submit(context, 'p2', initial.p2, p2Targeted, 'force-setup-targeted-move');

    const second = await waitFor(context, 'second turn actionable doubles requests', ({p1, p2}) =>
      p1.turn >= 2 && p2.turn >= 2 && p1.legalActions.length && p2.legalActions.length
    );
    const p1Tera = findWholeAction(second.p1.legalActions, action =>
      action.hasTerastallize &&
      !action.hasSwitch &&
      actionHasPart(action, part => part.type === 'move')
    );
    const p2Move = safeMoveAction(second.p2.legalActions);
    assert(p1Tera, 'force-switch seed did not expose a Terastallize move choice');
    assert(p2Move, 'force-switch seed did not expose a second turn move choice');
    submit(context, 'p1', second.p1, p1Tera, 'force-setup-terastallize');
    submit(context, 'p2', second.p2, p2Move, 'force-setup-follow-up-move');

    const force = await waitFor(context, 'actual Showdown force-switch request', ({p1, p2}) => {
      const p1Force = findAction(p1.legalActions, part => part.type === 'force-switch');
      if (p1Force) return {role: 'p1', state: p1, action: p1Force};
      const p2Force = findAction(p2.legalActions, part => part.type === 'force-switch');
      if (p2Force) return {role: 'p2', state: p2, action: p2Force};
      return null;
    });
    submit(context, force.role, force.state, force.action, 'force-switch');
    await waitFor(context, 'force switch accepted and battle resumed', ({p1, p2}) =>
      p1.turn >= 3 || p2.turn >= 3 || (p1.legalActions.length && p2.legalActions.length)
    );
  } finally {
    closeContext(context);
  }
}

function createContext(seed, label, timeoutMs) {
  const battle = new BattleSession({seed});
  const context = {
    battle,
    seed,
    label,
    closed: false,
    timeout: setTimeout(() => fail(`${label} timed out`), timeoutMs),
  };
  battle.onEvent(event => {
    if (context.closed || event.type !== 'protocol' || (event.role !== 'p1' && event.role !== 'p2')) return;
    if (String(event.chunk || '').includes('Invalid choice')) {
      fail(`Showdown rejected generated legal choice during ${label} for ${event.role}: ${event.chunk}`);
    }
  });
  return context;
}

function closeContext(context) {
  context.closed = true;
  clearTimeout(context.timeout);
}

function submit(context, role, state, action, category) {
  assert(state?.legalActions?.some(candidate => candidate.choice === action.choice), `${category} choice was not in ${role} legalActions`);
  submitted.push({
    seed: context.seed,
    label: context.label,
    role,
    turn: state.turn,
    requestId: state.request?.rqid ?? state.extracted?.requestId ?? null,
    category,
    choice: action.choice,
  });
  context.battle.choose(role, action.choice);
}

function waitFor(context, label, predicate, timeoutMs = 5000) {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const interval = setInterval(() => {
      if (failed) {
        clearInterval(interval);
        reject(new Error('failed'));
        return;
      }
      const snapshot = states(context);
      const result = predicate(snapshot);
      if (result) {
        clearInterval(interval);
        resolve(typeof result === 'object' ? result : snapshot);
        return;
      }
      if (Date.now() - started > timeoutMs) {
        clearInterval(interval);
        reject(new Error(`${context.label} timed out waiting for ${label}`));
      }
    }, 25);
  });
}

function states(context) {
  return {
    p1: context.battle.extractState('p1'),
    p2: context.battle.extractState('p2'),
  };
}

function safeMoveAction(actions) {
  return findWholeAction(actions, action =>
    !action.hasSwitch &&
    !action.hasTerastallize &&
    actionHasPart(action, part => part.type === 'move')
  ) || actions[0] || null;
}

function findAction(actions, predicate) {
  return actions.find(action => actionHasPart(action, predicate));
}

function findWholeAction(actions, predicate) {
  return actions.find(predicate);
}

function actionHasPart(action, predicate) {
  if (predicate(action)) return true;
  return (action.choices || []).some(predicate);
}

function publicSubmission(item) {
  return {
    seed: item.seed,
    role: item.role,
    turn: item.turn,
    requestId: item.requestId,
    category: item.category,
    choice: item.choice,
  };
}

function otherRole(role) {
  return role === 'p1' ? 'p2' : 'p1';
}

function parseSeedList(value = '') {
  const text = String(value || '').trim();
  if (!text) return null;
  const seeds = text.split(';').map(seedText => {
    const seed = seedText.split(',').map(part => Number(part.trim())).filter(Number.isFinite);
    if (seed.length !== 4) throw new Error(`Invalid LEGAL_CANONICAL_SEEDS entry: ${seedText}`);
    return seed.map(value => value >>> 0);
  });
  return seeds.length ? seeds : null;
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function fail(message) {
  if (failed) return;
  failed = true;
  console.error(`Legal canonical smoke failed: ${message}`);
  process.exit(1);
}
