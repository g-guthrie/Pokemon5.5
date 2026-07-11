import fs from 'node:fs/promises';
import {existsSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const reportDir = path.join(rootDir, 'artifacts', 'verification');
const outputPath = path.join(reportDir, 'production-audit-latest.json');
const startedAt = new Date().toISOString();

const report = {
  schemaVersion: 'showdown-production-audit.v1',
  startedAt,
  finishedAt: '',
  ok: false,
  productionReadyNoPaid: false,
  paidPreflightProven: false,
  warnings: 0,
  failures: 0,
  requirements: [],
  summary: {},
  outputPath,
};

const packageJson = await readJsonMaybe('package.json');
const readme = await readTextMaybe('README.md');
const verify = await readJsonMaybe('artifacts/verification/verify-latest.json');
const runner = await readJsonMaybe('artifacts/runner-contract-smoke.json');
const providerArtifact = await readJsonMaybe('artifacts/provider-artifact-smoke.json');
const ladder = await readJsonMaybe('artifacts/verification/ladder-batch/summary-latest.json');
const tournament = await readJsonMaybe('artifacts/tournament-smoke/summary-latest.json');
const benchmarkSuite = await readJsonMaybe('artifacts/benchmark-suite-smoke.json');

const sources = {
  battleSession: await readTextMaybe('src/battle-session.mjs'),
  promptPipeline: await readTextMaybe('src/prompt-pipeline.mjs'),
  agentRuntime: await readTextMaybe('src/agent-runtime.mjs'),
  benchmarkSuite: await readTextMaybe('src/benchmark-suite.mjs'),
  server: await readTextMaybe('src/server.mjs'),
  publicArena: await readTextMaybe('public/index.html'),
  publicArenaRuntime: await readTextMaybe('public/arena.js'),
};

audit();
report.finishedAt = new Date().toISOString();
report.failures = report.requirements.filter(item => item.status === 'fail').length;
report.warnings = report.requirements.filter(item => item.status === 'warn').length;
report.ok = report.failures === 0;
report.productionReadyNoPaid = report.ok;
report.paidPreflightProven = Boolean(
  verify?.optionalPaidPreflight?.ran?.includes('openai') &&
  verify?.optionalPaidPreflight?.ran?.includes('openrouter')
);
report.summary = {
  total: report.requirements.length,
  pass: report.requirements.filter(item => item.status === 'pass').length,
  warn: report.warnings,
  fail: report.failures,
  productionReadyNoPaid: report.productionReadyNoPaid,
  paidPreflightProven: report.paidPreflightProven,
};

await fs.mkdir(reportDir, {recursive: true});
await fs.writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify({
  ok: report.ok,
  productionReadyNoPaid: report.productionReadyNoPaid,
  paidPreflightProven: report.paidPreflightProven,
  pass: report.summary.pass,
  warn: report.warnings,
  fail: report.failures,
  outputPath,
}, null, 2));
if (!report.ok) process.exit(1);

function audit() {
  auditCanonicalShowdown();
  auditArchitecture();
  auditOperatorCommands();
  auditLegalChoices();
  auditHiddenInfo();
  auditPromptPipeline();
  auditProviders();
  auditArtifacts();
  auditReproducibility();
  auditLadder();
  auditTournament();
  auditBenchmarkSuite();
  auditFrontend();
  auditDocs();
  auditSecurity();
  auditPaidPreflight();
}

function auditCanonicalShowdown() {
  add({
    id: 'canonical-showdown-random-doubles',
    title: 'Canonical Showdown Gen 9 Random Doubles is the default engine path',
    status: all([
      sources.battleSession.includes('BattleStream'),
      sources.battleSession.includes('Teams.generate'),
      sources.battleSession.includes('gen9randomdoublesbattle'),
      runner?.formatid === 'gen9randomdoublesbattle',
      verifyCheck('smoke')?.ok,
    ]) ? 'pass' : 'fail',
    evidence: evidencePaths([
      'src/battle-session.mjs',
      'artifacts/runner-contract-smoke.json',
      'artifacts/verification/verify-latest.json',
    ]),
    details: {
      runnerFormat: runner?.formatid || '',
      smokeOk: Boolean(verifyCheck('smoke')?.ok),
    },
  });
}

function auditArchitecture() {
  const required = [
    'src/battle-session.mjs',
    'src/protocol-view.mjs',
    'src/observation.mjs',
    'src/legal-choices.mjs',
    'src/agent-runtime.mjs',
    'src/match-runner.mjs',
    'src/event-log.mjs',
    'src/ladder-runner.mjs',
    'src/tournament-runner.mjs',
    'src/benchmark-suite.mjs',
    'src/server.mjs',
    'public/index.html',
    'public/arena.js',
  ];
  const missing = required.filter(relative => !existsSyncish(relative));
  add({
    id: 'module-boundaries',
    title: 'Core architecture is split into explicit engine, extraction, runner, API, and UI modules',
    status: missing.length ? 'fail' : 'pass',
    evidence: evidencePaths(required.filter(relative => !missing.includes(relative))),
    details: {missing, required},
  });
}

function auditOperatorCommands() {
  const required = [
    'setup:showdown',
    'start',
    'model:agent',
    'provider:preflight',
    'benchmark:openrouter',
    'ladder:batch',
    'tournament:batch',
    'audit:production',
    'verify',
    'smoke',
    'smoke:extractor',
    'smoke:choices',
    'smoke:legal-canonical',
    'smoke:hidden',
    'smoke:runner',
    'smoke:prompt',
    'smoke:frontend',
    'smoke:localhost',
    'smoke:provider-config',
    'smoke:provider-artifact',
    'smoke:ladder-ui',
    'smoke:tournament-api',
    'smoke:benchmark-suite',
    'smoke:benchmark-api',
  ];
  const scripts = packageJson?.scripts || {};
  const missing = required.filter(name => !scripts[name]);
  add({
    id: 'operator-command-surface',
    title: 'Package scripts expose setup, local server, one-off duels, provider preflight, ladder, tournament, audit, and verification commands',
    status: missing.length ? 'fail' : 'pass',
    evidence: evidencePaths(['package.json']),
    details: {missing, required},
  });
}

function auditLegalChoices() {
  const selectedLegal = selectedActionsAreLegal(runner);
  add({
    id: 'legal-choice-contract',
    title: 'Agents choose exact legal choices from the current Showdown request',
    status: all([verifyCheck('choices')?.ok, verifyCheck('legal-canonical')?.ok, verifyCheck('runner')?.ok, selectedLegal.ok]) ? 'pass' : 'fail',
    evidence: evidencePaths([
      'src/legal-choices.mjs',
      'scripts/choice-contract-smoke.mjs',
      'scripts/legal-canonical-smoke.mjs',
      'artifacts/runner-contract-smoke.json',
    ]),
    details: {
      choicesSmokeOk: Boolean(verifyCheck('choices')?.ok),
      legalCanonicalSmokeOk: Boolean(verifyCheck('legal-canonical')?.ok),
      runnerSmokeOk: Boolean(verifyCheck('runner')?.ok),
      illegalActions: selectedLegal.illegalActions,
    },
  });
}

function auditHiddenInfo() {
  const initial = initialHiddenInfoByRole(runner);
  const hiddenOk = ['p1', 'p2'].every(role => {
    const item = initial[role];
    return item &&
      item.ownTeamSize === 6 &&
      item.opponentRevealed > 0 &&
      item.opponentRevealed < 6 &&
      item.opponentHiddenTeamIncluded === false;
  });
  add({
    id: 'hidden-info-contract',
    title: 'Player observations expose own full team and only revealed opponent information',
    status: all([verifyCheck('hidden-info')?.ok, hiddenOk]) ? 'pass' : 'fail',
    evidence: evidencePaths([
      'src/observation.mjs',
      'scripts/hidden-info-contract-smoke.mjs',
      'artifacts/runner-contract-smoke.json',
    ]),
    details: {
      hiddenInfoSmokeOk: Boolean(verifyCheck('hidden-info')?.ok),
      initial,
    },
  });
}

function auditPromptPipeline() {
  const calls = providerArtifact?.modelCalls || [];
  const promptOk = calls.length > 0 && calls.every(call =>
    call.promptSchemaVersion === 'showdown-choice-prompt.v7' &&
    call.responseSchemaVersion === 'showdown-choice-response.v6' &&
    call.prompt &&
    call.rawText &&
    call.analysisComplete === true &&
    Array.isArray(call.analysis?.candidateChoices) &&
    call.analysis.candidateChoices.length
  );
  add({
    id: 'prompt-pipeline-v4',
    title: 'Model prompts contain screen-equivalent context and require tactical notes plus candidate exact choices',
    status: all([
      verifyCheck('prompt')?.ok,
      sources.promptPipeline.includes('playerViewNow'),
      sources.promptPipeline.includes('candidateChoices'),
      promptOk,
    ]) ? 'pass' : 'fail',
    evidence: evidencePaths([
      'src/prompt-pipeline.mjs',
      'scripts/prompt-pipeline-smoke.mjs',
      'artifacts/provider-artifact-smoke.json',
    ]),
    details: {
      promptSmokeOk: Boolean(verifyCheck('prompt')?.ok),
      providerCalls: calls.length,
      promptSchemaVersions: unique(calls.map(call => call.promptSchemaVersion)),
      responseSchemaVersions: unique(calls.map(call => call.responseSchemaVersion)),
    },
  });
}

function auditProviders() {
  const providers = unique((providerArtifact?.modelCalls || []).map(call => call.provider));
  const scripts = packageJson?.scripts || {};
  add({
    id: 'provider-adapters',
    title: 'OpenAI and OpenRouter share the Agent interface and env-only key handling',
    status: all([
      verifyCheck('provider-config')?.ok,
      verifyCheck('provider-artifact')?.ok,
      verifyCheck('provider-abort')?.ok,
      scripts['provider:preflight'],
      sources.agentRuntime.includes('chooseWithOpenAI'),
      sources.agentRuntime.includes('chooseWithOpenRouter'),
      providers.includes('openai'),
      providers.includes('openrouter'),
    ]) ? 'pass' : 'fail',
    evidence: evidencePaths([
      'src/agent-runtime.mjs',
      'scripts/provider-config-smoke.mjs',
      'scripts/provider-artifact-smoke.mjs',
      'scripts/provider-abort-smoke.mjs',
      'artifacts/provider-artifact-smoke.json',
    ]),
    details: {
      providers,
      providerConfigOk: Boolean(verifyCheck('provider-config')?.ok),
      providerArtifactOk: Boolean(verifyCheck('provider-artifact')?.ok),
      providerAbortOk: Boolean(verifyCheck('provider-abort')?.ok),
    },
  });
}

function auditArtifacts() {
  const runnerEventsExists = Boolean(runner?.eventsPath && existsSyncish(pathRelativeToRoot(runner.eventsPath)));
  const providerEventsExists = Boolean(providerArtifact?.eventsPath && existsSyncish(pathRelativeToRoot(providerArtifact.eventsPath)));
  const providerCalls = providerArtifact?.modelCalls || [];
  const providerPromptNoSeed = providerCalls.every(call => !String(call.prompt || '').includes(String(providerArtifact?.seed?.[0] || '')));
  add({
    id: 'match-artifact-contract',
    title: 'Battle artifacts include seeds, teams, observations, legal choices, actions, model calls, usage, protocol, and JSONL events',
    status: all([
      runner?.schemaVersion === 'showdown-match-artifact.v1',
      providerArtifact?.schemaVersion === 'showdown-match-artifact.v1',
      Array.isArray(runner?.seed) && runner.seed.length === 4,
      runner?.teamSnapshots?.p1?.team?.length === 6,
      runner?.teamSnapshots?.p2?.team?.length === 6,
      runner?.observations?.length > 0,
      runner?.actions?.length > 0,
      runner?.modelCalls?.length > 0,
      runner?.protocol?.length > 0,
      runnerEventsExists,
      providerCalls.length > 0,
      providerCalls.every(call => call.prompt && call.rawText && call.usage),
      providerArtifact?.usage?.calls > 0,
      providerEventsExists,
      providerPromptNoSeed,
    ]) ? 'pass' : 'fail',
    evidence: evidencePaths([
      'artifacts/runner-contract-smoke.json',
      'artifacts/runner-contract-smoke.events.jsonl',
      'artifacts/provider-artifact-smoke.json',
      'artifacts/provider-artifact-smoke.events.jsonl',
    ]),
    details: {
      runnerEventsExists,
      providerEventsExists,
      runnerActions: runner?.actions?.length || 0,
      runnerObservations: runner?.observations?.length || 0,
      providerModelCalls: providerCalls.length,
      providerPromptNoSeed,
    },
  });
}

function auditReproducibility() {
  add({
    id: 'reproducible-seeded-battles',
    title: 'Seeded random doubles battles reproduce team snapshots and hashes',
    status: all([
      verifyCheck('reproducibility')?.ok,
      Array.isArray(runner?.seed) && runner.seed.length === 4,
      runner?.teamSnapshots?.p1?.teamHash,
      runner?.teamSnapshots?.p2?.teamHash,
    ]) ? 'pass' : 'fail',
    evidence: evidencePaths([
      'scripts/reproducibility-smoke.mjs',
      'artifacts/reproducibility-smoke/first.json',
      'artifacts/reproducibility-smoke/second.json',
      'artifacts/runner-contract-smoke.json',
    ]),
    details: {
      reproducibilitySmokeOk: Boolean(verifyCheck('reproducibility')?.ok),
      p1TeamHash: runner?.teamSnapshots?.p1?.teamHash || '',
      p2TeamHash: runner?.teamSnapshots?.p2?.teamHash || '',
    },
  });
}

function auditLadder() {
  add({
    id: 'ladder-batches',
    title: 'Ladder batches produce durable win/loss summaries across model configs',
    status: all([
      verifyCheck('standin-ladder-batch')?.ok,
      ladder?.schemaVersion === 'showdown-ladder-summary.v1',
      ladder?.battleCount >= 1,
    ]) ? 'pass' : 'fail',
    evidence: evidencePaths([
      'src/ladder-runner.mjs',
      'artifacts/verification/ladder-batch/summary-latest.json',
    ]),
    details: {
      battleCount: ladder?.battleCount || 0,
    },
  });
}

function auditTournament() {
  add({
    id: 'tournament-runner',
    title: 'Round-robin tournaments produce pair summaries, standings, and usage',
    status: all([
      verifyCheck('tournament')?.ok,
      verifyCheck('tournament-api')?.ok,
      tournament?.schemaVersion === 'showdown-tournament-summary.v1',
      tournament?.completedBattles >= 3,
    ]) ? 'pass' : 'fail',
    evidence: evidencePaths([
      'src/tournament-runner.mjs',
      'scripts/tournament-smoke.mjs',
      'scripts/tournament-api-smoke.mjs',
      'artifacts/tournament-smoke/summary-latest.json',
    ]),
    details: {
      completedBattles: tournament?.completedBattles || 0,
    },
  });
}

function auditBenchmarkSuite() {
  const pairs = benchmarkSuite?.pairs || [];
  const openrouterModels = benchmarkSuite?.openrouterModels || [];
  const openaiBaselines = benchmarkSuite?.openaiBaselines || [];
  add({
    id: 'openrouter-top-benchmark-suite',
    title: 'OpenRouter top-model benchmark suite plans OpenRouter-vs-OpenAI pairs with roster provenance',
    status: all([
      verifyCheck('benchmark-suite')?.ok,
      benchmarkSuite?.schemaVersion === 'showdown-openrouter-benchmark-suite.v1',
      benchmarkSuite?.formatid === 'gen9randomdoublesbattle',
      openrouterModels.length >= 3,
      openaiBaselines.length >= 2,
      pairs.length === openrouterModels.length * openaiBaselines.length,
      verifyCheck('benchmark-api')?.ok,
      sources.benchmarkSuite.includes('fetchOpenRouterModelCatalog'),
      sources.benchmarkSuite.includes('runOpenRouterBenchmarkSuite'),
      sources.benchmarkSuite.includes('OPENROUTER_WEEKLY_USAGE_TOP_CANDIDATES'),
      sources.server.includes('/api/benchmark'),
    ]) ? 'pass' : 'fail',
    evidence: evidencePaths([
      'src/benchmark-suite.mjs',
      'src/server.mjs',
      'scripts/openrouter-top-suite.mjs',
      'scripts/benchmark-suite-smoke.mjs',
      'scripts/benchmark-api-smoke.mjs',
      'artifacts/benchmark-suite-smoke.json',
    ]),
    details: {
      benchmarkSuiteSmokeOk: Boolean(verifyCheck('benchmark-suite')?.ok),
      benchmarkApiSmokeOk: Boolean(verifyCheck('benchmark-api')?.ok),
      openrouterModels: openrouterModels.map(model => model.id),
      openaiBaselines: openaiBaselines.map(agent => agent.agentSpec),
      pairs: pairs.length,
      excluded: benchmarkSuite?.excludedOpenRouterCandidates?.length || 0,
    },
  });
}

function auditFrontend() {
  const screenshotExists = existsSyncish('artifacts/showdown-observation-lab-production.png');
  const frontendSmokeScreenshotExists = existsSyncish('artifacts/frontend-screenshot-smoke.png');
  add({
    id: 'browser-control-room',
    title: 'Browser UI exposes the arena, live model runs, series records, ladder, tournament, and benchmark views',
    status: all([
      existsSyncish('public/index.html'),
      existsSyncish('public/arena.js'),
      existsSyncish('public/showdown-frame.html'),
      existsSyncish('public/showdown-adapter.js'),
      verifyCheck('live-run-api')?.ok,
      verifyCheck('frontend-ui')?.ok,
      verifyCheck('ladder-ui')?.ok,
      verifyCheck('tournament-api')?.ok,
      verifyCheck('benchmark-api')?.ok,
      frontendSmokeScreenshotExists,
      sources.publicArena.includes('LLM Arena'),
      sources.publicArenaRuntime.includes('gameCount'),
    ]) ? 'pass' : 'fail',
    evidence: evidencePaths([
      'public/index.html',
      'public/arena.js',
      'public/showdown-frame.html',
      'public/showdown-adapter.js',
      'artifacts/showdown-observation-lab-production.png',
      'artifacts/showdown-browser-ladder-qa.png',
      'artifacts/frontend-screenshot-smoke.png',
      'artifacts/localhost-3107-smoke.png',
    ]),
    details: {
      liveRunApiOk: Boolean(verifyCheck('live-run-api')?.ok),
      frontendUiOk: Boolean(verifyCheck('frontend-ui')?.ok),
      ladderUiOk: Boolean(verifyCheck('ladder-ui')?.ok),
      tournamentApiOk: Boolean(verifyCheck('tournament-api')?.ok),
      benchmarkApiOk: Boolean(verifyCheck('benchmark-api')?.ok),
      screenshotExists,
      frontendSmokeScreenshotExists,
    },
  });
}

function auditDocs() {
  const terms = [
    '## Setup',
    '## Secrets',
    '## Ladder Batches',
    '## Tournaments',
    '## Benchmark Contract',
    '## Artifact Shape',
    '## Verification',
    'OpenRouter',
    'OPENAI_API_KEY',
    'OPENROUTER_API_KEY',
    'gen9randomdoublesbattle',
  ];
  const missing = terms.filter(term => !readme.includes(term));
  add({
    id: 'documentation',
    title: 'README documents setup, secrets, benchmark contract, artifacts, ladder, tournaments, and verification',
    status: missing.length ? 'fail' : 'pass',
    evidence: evidencePaths(['README.md']),
    details: {missing},
  });
}

function auditSecurity() {
  add({
    id: 'secret-and-redaction-gates',
    title: 'Source, docs, artifacts, logs, metadata, and prompts are guarded against secret leakage',
    status: all([
      verify?.ok,
      verifyCheck('secret-scan')?.ok,
      verifyCheck('runner-redaction')?.ok,
      verifyCheck('provider-config')?.ok,
      verifyCheck('provider-artifact')?.ok,
      verify?.noPaidProviderCalls === true,
    ]) ? 'pass' : 'fail',
    evidence: evidencePaths([
      'scripts/verify.mjs',
      'scripts/runner-redaction-smoke.mjs',
      'artifacts/verification/verify-latest.json',
      'artifacts/runner-redaction-smoke.json',
    ]),
    details: {
      verifyOk: Boolean(verify?.ok),
      secretScanOk: Boolean(verifyCheck('secret-scan')?.ok),
      redactionOk: Boolean(verifyCheck('runner-redaction')?.ok),
      noPaidProviderCalls: Boolean(verify?.noPaidProviderCalls),
    },
  });
}

function auditPaidPreflight() {
  const paid = verify?.optionalPaidPreflight || {};
  const ran = paid.ran || [];
  add({
    id: 'paid-provider-preflight',
    title: 'Real paid OpenAI and OpenRouter preflight is proven when env keys are provided',
    status: ran.includes('openai') && ran.includes('openrouter') ? 'pass' : 'warn',
    external: true,
    evidence: evidencePaths([
      'scripts/openai-preflight.mjs',
      'scripts/provider-preflight.mjs',
      'artifacts/verification/verify-latest.json',
    ]),
    details: {
      requested: Boolean(paid.requested),
      openaiKeyPresent: Boolean(paid.openaiKeyPresent),
      openrouterKeyPresent: Boolean(paid.openrouterKeyPresent),
      ran,
      skipped: paid.skipped || [],
    },
  });
}

function add(item) {
  report.requirements.push({
    id: item.id,
    title: item.title,
    status: item.status,
    external: Boolean(item.external),
    evidence: item.evidence || [],
    details: item.details || {},
  });
}

function verifyCheck(name) {
  return (verify?.checks || []).find(check => check.name === name) || null;
}

function selectedActionsAreLegal(match = {}) {
  const illegalActions = [];
  for (const action of match.actions || []) {
    const observation = match.observations?.[action.observationIndex]?.observation ||
      match.observations?.[action.observationIndex];
    const legal = observation?.legalActions || [];
    if (!legal.some(candidate => candidate.choice === action.choice || candidate.command === action.choice)) {
      illegalActions.push({
        role: action.role,
        turn: action.turn,
        choice: action.choice,
        observationIndex: action.observationIndex,
      });
    }
  }
  return {ok: illegalActions.length === 0 && (match.actions || []).length > 0, illegalActions};
}

function initialHiddenInfoByRole(match = {}) {
  const result = {};
  for (const record of match.observations || []) {
    const observation = record.observation || record;
    const role = observation.perspective || record.role;
    if (!role || result[role]) continue;
    result[role] = {
      ownTeamSize: observation.self?.team?.length || 0,
      opponentRevealed: observation.opponent?.revealedTeam?.length || 0,
      opponentHiddenTeamIncluded: observation.source?.opponentHiddenTeamIncluded,
      opponentNames: (observation.opponent?.revealedTeam || []).map(mon => mon.name || mon.species).filter(Boolean),
    };
  }
  return result;
}

function all(values) {
  return values.every(Boolean);
}

function unique(values = []) {
  return [...new Set(values.filter(Boolean))];
}

function constantNumber(source = '', name = '') {
  const match = String(source).match(new RegExp(`const\\s+${name}\\s*=\\s*(\\d+)`));
  return match ? Number(match[1]) : 0;
}

async function readJsonMaybe(relative) {
  try {
    return JSON.parse(await fs.readFile(path.join(rootDir, relative), 'utf8'));
  } catch {
    return null;
  }
}

async function readTextMaybe(relative) {
  try {
    return await fs.readFile(path.join(rootDir, relative), 'utf8');
  } catch {
    return '';
  }
}

function existsSyncish(relativeOrAbsolute) {
  const filePath = path.isAbsolute(relativeOrAbsolute) ? relativeOrAbsolute : path.join(rootDir, relativeOrAbsolute);
  return existsSync(filePath);
}

function evidencePaths(relatives) {
  return relatives.map(relative => ({
    path: path.isAbsolute(relative) ? relative : path.join(rootDir, relative),
    exists: existsSyncish(relative),
  }));
}

function pathRelativeToRoot(filePath = '') {
  const normalized = path.resolve(String(filePath || ''));
  if (!normalized.startsWith(rootDir)) return normalized;
  return path.relative(rootDir, normalized);
}
