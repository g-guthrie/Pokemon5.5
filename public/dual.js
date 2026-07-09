const statusEl = document.querySelector('#status');
const stateEl = document.querySelector('#state');
const seedEl = document.querySelector('#seed');
const p1Panel = document.querySelector('#panel-p1 .panel-body');
const p2Panel = document.querySelector('#panel-p2 .panel-body');
const artifactsEl = document.querySelector('#artifacts');
const artifactSelect = document.querySelector('#artifact-select');
const artifactReload = document.querySelector('#artifact-reload');
const artifactSummaryEl = document.querySelector('#artifact-summary');
const artifactTimelineEl = document.querySelector('#artifact-timeline');
const artifactTraceEl = document.querySelector('#artifact-trace');
const agentP1El = document.querySelector('#agent-p1');
const agentP2El = document.querySelector('#agent-p2');
const arenaWorkflowEl = document.querySelector('#arena-workflow');
const arenaAgentsEl = document.querySelector('#arena-agents');
const arenaLastChoicesEl = document.querySelector('#arena-last-choices');
const arenaUsageEl = document.querySelector('#arena-usage');
const arenaPauseEl = document.querySelector('#arena-pause');
const arenaResumeEl = document.querySelector('#arena-resume');
const broadcastLiveLabelEl = document.querySelector('#broadcast-live-label');
const broadcastHeadlineEl = document.querySelector('#broadcast-headline');
const broadcastSubtitleEl = document.querySelector('#broadcast-subtitle');
const broadcastTickerEl = document.querySelector('#broadcast-ticker');
const broadcastFeedMetaEl = document.querySelector('#broadcast-feed-meta');
const broadcastFeedEl = document.querySelector('#broadcast-feed');
const broadcastCardP1El = document.querySelector('#broadcast-card-p1');
const broadcastCardP2El = document.querySelector('#broadcast-card-p2');
const broadcastViewButtons = [...document.querySelectorAll('[data-broadcast-view]')];
const runMaxTurnsEl = document.querySelector('#run-max-turns');
const runDelayEl = document.querySelector('#run-delay');
const modelRunStatusEl = document.querySelector('#model-run-status');
const ladderCountEl = document.querySelector('#ladder-count');
const ladderWatchEl = document.querySelector('#ladder-watch');
const ladderStatusEl = document.querySelector('#ladder-status');
const tournamentAgentsEl = document.querySelector('#tournament-agents');
const tournamentBattlesEl = document.querySelector('#tournament-battles');
const tournamentWatchEl = document.querySelector('#tournament-watch');
const tournamentStatusEl = document.querySelector('#tournament-status');
const benchmarkOpenRouterLimitEl = document.querySelector('#benchmark-openrouter-limit');
const benchmarkBattlesEl = document.querySelector('#benchmark-battles');
const benchmarkOpenAIBaselinesEl = document.querySelector('#benchmark-openai-baselines');
const benchmarkWatchEl = document.querySelector('#benchmark-watch');
const benchmarkPaidEl = document.querySelector('#benchmark-paid');
const benchmarkStatusEl = document.querySelector('#benchmark-status');
const autoLoopP1 = document.querySelector('#auto-loop-p1');
const autoLoopP2 = document.querySelector('#auto-loop-p2');
const displayModeButtons = [...document.querySelectorAll('[data-display-mode]')];
const clientViewports = [...document.querySelectorAll('.client-viewport')];
const clientBaseWidth = 956;
const clientBaseHeight = 760;
const ACTION_QUICK_PICK_LIMIT = 6;
const ACTION_DEFAULT_GROUP_LIMIT = 8;
const ACTION_FILTER_GROUP_LIMIT = 80;
let displayMode = localStorage.getItem('showdown-display-mode') || 'fit';
let lastRenderSignature = '';
let artifactFiles = [];
let selectedArtifactHref = localStorage.getItem('showdown-selected-artifact') || '';
let selectedBroadcastView = localStorage.getItem('showdown-broadcast-view') || 'p1';
let latestRun = null;
let latestLadder = null;
let latestTournament = null;
let latestBenchmark = null;
let latestArtifact = null;
const actionFilters = {p1: '', p2: ''};

const p1 = connectRole('p1');
const p2 = connectRole('p2');

for (const button of displayModeButtons) {
  button.addEventListener('click', () => setDisplayMode(button.dataset.displayMode));
}
for (const button of broadcastViewButtons) {
  button.addEventListener('click', () => setBroadcastView(button.dataset.broadcastView));
}
document.querySelector('#auto-p1').addEventListener('click', () => send(p1, {type: 'auto'}));
document.querySelector('#auto-p2').addEventListener('click', () => send(p2, {type: 'auto'}));
document.querySelector('#auto-both').addEventListener('click', () => {
  send(p1, {type: 'auto'});
  send(p2, {type: 'auto'});
});
document.querySelector('#reset').addEventListener('click', resetBattle);
document.querySelector('#run-start').addEventListener('click', startModelRun);
document.querySelector('#run-pause').addEventListener('click', () => postRunCommand('pause'));
document.querySelector('#run-resume').addEventListener('click', () => postRunCommand('resume'));
document.querySelector('#run-stop').addEventListener('click', () => postRunCommand('stop'));
arenaPauseEl.addEventListener('click', pauseArenaWorkflow);
arenaResumeEl.addEventListener('click', resumeArenaWorkflow);
document.querySelector('#ladder-start').addEventListener('click', startLadder);
document.querySelector('#ladder-pause').addEventListener('click', () => postLadderCommand('pause'));
document.querySelector('#ladder-resume').addEventListener('click', () => postLadderCommand('resume'));
document.querySelector('#ladder-stop').addEventListener('click', () => postLadderCommand('stop'));
document.querySelector('#tournament-start').addEventListener('click', startTournament);
document.querySelector('#tournament-pause').addEventListener('click', () => postTournamentCommand('pause'));
document.querySelector('#tournament-resume').addEventListener('click', () => postTournamentCommand('resume'));
document.querySelector('#tournament-stop').addEventListener('click', () => postTournamentCommand('stop'));
document.querySelector('#benchmark-plan').addEventListener('click', planBenchmark);
document.querySelector('#benchmark-start').addEventListener('click', startBenchmark);
document.querySelector('#benchmark-pause').addEventListener('click', () => postBenchmarkCommand('pause'));
document.querySelector('#benchmark-resume').addEventListener('click', () => postBenchmarkCommand('resume'));
document.querySelector('#benchmark-stop').addEventListener('click', () => postBenchmarkCommand('stop'));
artifactSelect.addEventListener('change', () => {
  selectedArtifactHref = artifactSelect.value;
  localStorage.setItem('showdown-selected-artifact', selectedArtifactHref);
  void loadSelectedArtifact();
});
artifactReload.addEventListener('click', () => {
  loadArtifacts({force: true});
});

setInterval(runAutoLoops, 300);
setInterval(renderState, 250);
setInterval(loadArtifacts, 5000);
setInterval(loadRunStatus, 1000);
setInterval(loadLadderStatus, 1200);
setInterval(loadTournamentStatus, 1400);
setInterval(loadBenchmarkStatus, 1600);
loadArtifacts();
loadRunStatus();
loadLadderStatus();
loadTournamentStatus();
loadBenchmarkStatus();
setDisplayMode(displayMode);
setBroadcastView(selectedBroadcastView);
const resizeObserver = new ResizeObserver(updateClientScales);
for (const viewport of clientViewports) resizeObserver.observe(viewport);
window.addEventListener('resize', updateClientScales);
window.addEventListener('scroll', updateArenaMetric, {passive: true});

function connectRole(role) {
  const client = {role, ws: null, state: null, connected: false, autoKeys: new Set()};
  const open = () => {
    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    client.ws = new WebSocket(`${protocol}//${location.host}/ws?role=${role}`);
    client.ws.addEventListener('open', () => {
      client.connected = true;
      renderState();
    });
    client.ws.addEventListener('close', () => {
      client.connected = false;
      renderState();
      setTimeout(open, 800);
    });
    client.ws.addEventListener('message', event => {
      const message = JSON.parse(event.data);
      if (message.type === 'state') client.state = message.state;
      if (message.type === 'reset') {
        client.autoKeys.clear();
        client.state = null;
      }
      renderState();
    });
  };
  open();
  return client;
}

function resetBattle() {
  const seed = parseSeed(seedEl.value);
  p1.autoKeys.clear();
  p2.autoKeys.clear();
  send(p1, seed ? {type: 'reset', seed} : {type: 'reset'});
}

async function startModelRun() {
  const seed = parseSeed(seedEl.value);
  await postRunCommand('start', {
    battleId: 'local',
    agentP1: agentP1El.value || 'standin',
    agentP2: agentP2El.value || 'standin',
    maxTurns: numberInput(runMaxTurnsEl.value, 40),
    moveDelayMs: numberInput(runDelayEl.value, 200),
    seed,
  });
}

async function postRunCommand(command, payload = {}) {
  try {
    modelRunStatusEl.textContent = `${command}...`;
    const response = await fetch('/api/run', {
      method: 'POST',
      headers: {'content-type': 'application/json'},
      body: JSON.stringify({command, ...payload}),
    });
    const body = await response.json();
    if (!response.ok || !body.ok) throw new Error(body.error || `HTTP ${response.status}`);
    renderRunControl(body.run);
    if (!isRunActive(body.run)) await loadArtifacts({force: true});
  } catch (error) {
    modelRunStatusEl.innerHTML = `<strong>Run command failed</strong><small>${escapeHTML(error.message)}</small>`;
  }
}

async function loadRunStatus() {
  try {
    const response = await fetch('/api/run');
    if (!response.ok) return;
    const body = await response.json();
    renderRunControl(body.run);
    if (body.run?.outputHref && !isRunActive(body.run)) {
      await loadArtifacts();
    }
  } catch {}
}

function renderRunControl(run) {
  latestRun = run || null;
  if (!run) {
    modelRunStatusEl.textContent = 'No active model run.';
    renderArenaTelemetry();
    renderBroadcast();
    return;
  }
  const resultText = run.result?.winner || run.result?.reason || run.error || '';
  const outputLink = run.outputHref ? `<a href="${escapeHTML(run.outputHref)}" target="_blank" rel="noreferrer">artifact</a>` : '';
  const eventsLink = run.eventsHref ? `<a href="${escapeHTML(run.eventsHref)}" target="_blank" rel="noreferrer">events</a>` : '';
  const lastAction = run.lastActions?.at(-1);
  const lastModelCall = run.lastModelCall || {};
  modelRunStatusEl.innerHTML = `
    <strong>${escapeHTML(run.status)} ${escapeHTML(run.id || '')}</strong>
    <small>${escapeHTML(run.agentP1 || '-')} vs ${escapeHTML(run.agentP2 || '-')}</small>
    <small>battle ${escapeHTML(run.battleId || '-')} | turn cap ${escapeHTML(run.maxTurns ?? '-')} | ${escapeHTML(formatSeed(run.seed))}</small>
    <small>turn ${escapeHTML(run.currentTurn ?? 0)} | actions ${escapeHTML(run.actionCount ?? 0)} | calls ${escapeHTML(run.modelCallCount ?? 0)} | ${escapeHTML(formatUsage(run.usage || {}))}</small>
    <small>valid ${run.validBenchmark === false ? 'no' : 'yes'} | invalid ${escapeHTML(run.invalidChoiceCount ?? 0)} | fallback ${escapeHTML(run.fallbackCount ?? 0)} | api errors ${escapeHTML(run.apiErrorCount ?? 0)}</small>
    ${run.lastObservation ? `<small>request ${escapeHTML(run.lastObservation.role || '-')} T${escapeHTML(run.lastObservation.turn ?? '-')} | legal ${escapeHTML(run.lastObservation.legalActionCount ?? '-')} | ${escapeHTML(run.lastObservation.active || '-')} vs ${escapeHTML(run.lastObservation.opponent || '-')}</small>` : ''}
    ${lastModelCall.choice || lastModelCall.requestedChoice ? `<small>last model ${escapeHTML(lastModelCall.role || '-')} ${escapeHTML(lastModelCall.provider || '')}:${escapeHTML(lastModelCall.model || '')} | ${lastModelCall.valid ? 'valid' : 'invalid'} | ${lastModelCall.fallback ? 'fallback' : 'direct'} | ${analysisStatus(lastModelCall)}</small>` : ''}
    ${lastAction ? `<small>last choice T${escapeHTML(lastAction.turn ?? '-')} ${escapeHTML(lastAction.role || '-')}: ${escapeHTML(lastAction.choice || '-')}</small>` : ''}
    ${resultText ? `<small>${escapeHTML(resultText)}</small>` : ''}
    ${outputLink || eventsLink ? `<small>${outputLink} ${eventsLink}</small>` : ''}
  `;
  renderArenaTelemetry();
  renderBroadcast();
}

function isRunActive(run) {
  return run && ['running', 'paused', 'stopping'].includes(run.status);
}

async function startLadder() {
  await postLadderCommand('start', {
    agentA: agentP1El.value || 'standin',
    agentB: agentP2El.value || 'standin',
    battleCount: numberInput(ladderCountEl.value, 2),
    maxTurns: numberInput(runMaxTurnsEl.value, 40),
    moveDelayMs: numberInput(runDelayEl.value, 200),
    watchLocal: ladderWatchEl.checked,
  });
}

async function postLadderCommand(command, payload = {}) {
  try {
    ladderStatusEl.textContent = `${command}...`;
    const response = await fetch('/api/ladder', {
      method: 'POST',
      headers: {'content-type': 'application/json'},
      body: JSON.stringify({command, ...payload}),
    });
    const body = await response.json();
    if (!response.ok || !body.ok) throw new Error(body.error || `HTTP ${response.status}`);
    renderLadderControl(body.ladder);
    if (!isLadderActive(body.ladder)) await loadArtifacts({force: true});
  } catch (error) {
    ladderStatusEl.innerHTML = `<strong>Ladder command failed</strong><small>${escapeHTML(error.message)}</small>`;
  }
}

async function loadLadderStatus() {
  try {
    const response = await fetch('/api/ladder');
    if (!response.ok) return;
    const body = await response.json();
    renderLadderControl(body.ladder);
    if (body.ladder?.summaryHref && !isLadderActive(body.ladder)) {
      await loadArtifacts();
    }
  } catch {}
}

function renderLadderControl(ladder) {
  latestLadder = ladder || null;
  if (!ladder) {
    ladderStatusEl.textContent = 'No active ladder.';
    renderArenaTelemetry();
    return;
  }
  const summaryLink = ladder.summaryHref ? `<a href="${escapeHTML(ladder.summaryHref)}" target="_blank" rel="noreferrer">summary</a>` : '';
  const ratingLink = ladder.ratingStoreHref ? `<a href="${escapeHTML(ladder.ratingStoreHref)}" target="_blank" rel="noreferrer">ratings</a>` : '';
  const totals = ladder.totals ?
    `A ${ladder.totals.agentAWins || 0} / B ${ladder.totals.agentBWins || 0} / draw ${ladder.totals.drawsOrCaps || 0}` :
    'no results yet';
  const last = ladder.lastBattle ? `last #${ladder.lastBattle.index}: ${ladder.lastBattle.winnerAgent || 'draw'} turn ${ladder.lastBattle.turn ?? '-'}` : '';
  ladderStatusEl.innerHTML = `
    <strong>${escapeHTML(ladder.status)} ${escapeHTML(ladder.id || '')}</strong>
    <small>${escapeHTML(ladder.agentA || '-')} vs ${escapeHTML(ladder.agentB || '-')}</small>
    <small>${escapeHTML(ladder.currentBattle ?? 0)}/${escapeHTML(ladder.battleCount ?? 0)} | ${ladder.watchLocal ? 'watching local' : 'isolated battles'} | ${escapeHTML(totals)}</small>
    ${last ? `<small>${escapeHTML(last)}</small>` : ''}
    ${ladder.error ? `<small>${escapeHTML(ladder.error)}</small>` : ''}
    ${summaryLink || ratingLink ? `<small>${summaryLink} ${ratingLink}</small>` : ''}
  `;
  renderArenaTelemetry();
}

function isLadderActive(ladder) {
  return ladder && ['running', 'paused', 'stopping'].includes(ladder.status);
}

async function startTournament() {
  await postTournamentCommand('start', {
    agents: tournamentAgentsEl.value || 'standin, heuristic, standin:alt',
    battlesPerPair: numberInput(tournamentBattlesEl.value, 1),
    maxTurns: numberInput(runMaxTurnsEl.value, 40),
    moveDelayMs: numberInput(runDelayEl.value, 200),
    watchLocal: tournamentWatchEl.checked,
  });
}

async function postTournamentCommand(command, payload = {}) {
  try {
    tournamentStatusEl.textContent = `${command}...`;
    const response = await fetch('/api/tournament', {
      method: 'POST',
      headers: {'content-type': 'application/json'},
      body: JSON.stringify({command, ...payload}),
    });
    const body = await response.json();
    if (!response.ok || !body.ok) throw new Error(body.error || `HTTP ${response.status}`);
    renderTournamentControl(body.tournament);
    if (!isTournamentActive(body.tournament)) await loadArtifacts({force: true});
  } catch (error) {
    tournamentStatusEl.innerHTML = `<strong>Tournament command failed</strong><small>${escapeHTML(error.message)}</small>`;
  }
}

async function loadTournamentStatus() {
  try {
    const response = await fetch('/api/tournament');
    if (!response.ok) return;
    const body = await response.json();
    renderTournamentControl(body.tournament);
    if (body.tournament?.summaryHref && !isTournamentActive(body.tournament)) {
      await loadArtifacts();
    }
  } catch {}
}

function renderTournamentControl(tournament) {
  latestTournament = tournament || null;
  if (!tournament) {
    tournamentStatusEl.textContent = 'No active tournament.';
    renderArenaTelemetry();
    return;
  }
  const summaryLink = tournament.summaryHref ? `<a href="${escapeHTML(tournament.summaryHref)}" target="_blank" rel="noreferrer">summary</a>` : '';
  const ratingLink = tournament.ratingStoreHref ? `<a href="${escapeHTML(tournament.ratingStoreHref)}" target="_blank" rel="noreferrer">ratings</a>` : '';
  const totals = tournament.totals ?
    `${tournament.completedBattles || 0}/${tournament.scheduledBattles || 0} battles | invalid ${tournament.totals.invalidBenchmarks || 0}` :
    `${tournament.completedBattles || 0}/${tournament.scheduledBattles || 0} battles`;
  const last = tournament.lastPair ?
    `last pair #${tournament.lastPair.index}: ${tournament.lastPair.agents?.a?.name || 'A'} vs ${tournament.lastPair.agents?.b?.name || 'B'}` :
    '';
  tournamentStatusEl.innerHTML = `
    <strong>${escapeHTML(tournament.status)} ${escapeHTML(tournament.id || '')}</strong>
    <small>${escapeHTML((tournament.agentSpecs || []).join(', ') || '-')}</small>
    <small>pairs ${escapeHTML(tournament.currentPair ?? 0)}/${escapeHTML(tournament.pairCount ?? 0)} | ${tournament.watchLocal ? 'watching local' : 'isolated battles'} | ${escapeHTML(totals)}</small>
    ${last ? `<small>${escapeHTML(last)}</small>` : ''}
    ${tournament.error ? `<small>${escapeHTML(tournament.error)}</small>` : ''}
    ${summaryLink || ratingLink ? `<small>${summaryLink} ${ratingLink}</small>` : ''}
  `;
  renderArenaTelemetry();
}

function isTournamentActive(tournament) {
  return tournament && ['running', 'paused', 'stopping'].includes(tournament.status);
}

async function planBenchmark() {
  await postBenchmarkCommand('plan', benchmarkPayload());
}

async function startBenchmark() {
  await postBenchmarkCommand('start', {
    ...benchmarkPayload(),
    runPaidBenchmark: benchmarkPaidEl.checked,
  });
}

function benchmarkPayload() {
  return {
    openRouterLimit: numberInput(benchmarkOpenRouterLimitEl.value, 10),
    openaiBaselines: benchmarkOpenAIBaselinesEl.value || 'openai:gpt-5.5:low, openai:gpt-5.5:medium',
    battlesPerPair: numberInput(benchmarkBattlesEl.value, 2),
    maxTurns: numberInput(runMaxTurnsEl.value, 40),
    moveDelayMs: numberInput(runDelayEl.value, 20),
    watchLocal: benchmarkWatchEl.checked,
  };
}

async function postBenchmarkCommand(command, payload = {}) {
  try {
    benchmarkStatusEl.textContent = `${command}...`;
    const response = await fetch('/api/benchmark', {
      method: 'POST',
      headers: {'content-type': 'application/json'},
      body: JSON.stringify({command, ...payload}),
    });
    const body = await response.json();
    if (!response.ok || !body.ok) throw new Error(body.error || `HTTP ${response.status}`);
    renderBenchmarkControl(body.benchmark);
    if (!isBenchmarkActive(body.benchmark)) await loadArtifacts({force: true});
  } catch (error) {
    benchmarkStatusEl.innerHTML = `<strong>Benchmark command failed</strong><small>${escapeHTML(error.message)}</small>`;
  }
}

async function loadBenchmarkStatus() {
  try {
    const response = await fetch('/api/benchmark');
    if (!response.ok) return;
    const body = await response.json();
    renderBenchmarkControl(body.benchmark);
    if (body.benchmark?.summaryHref && !isBenchmarkActive(body.benchmark)) {
      await loadArtifacts();
    }
  } catch {}
}

function renderBenchmarkControl(benchmark) {
  latestBenchmark = benchmark || null;
  if (!benchmark) {
    benchmarkStatusEl.textContent = 'No active benchmark.';
    renderArenaTelemetry();
    return;
  }
  const planLink = benchmark.planHref ? `<a href="${escapeHTML(benchmark.planHref)}" target="_blank" rel="noreferrer">plan</a>` : '';
  const summaryLink = benchmark.summaryHref ? `<a href="${escapeHTML(benchmark.summaryHref)}" target="_blank" rel="noreferrer">summary</a>` : '';
  const ratingLink = benchmark.ratingStoreHref ? `<a href="${escapeHTML(benchmark.ratingStoreHref)}" target="_blank" rel="noreferrer">ratings</a>` : '';
  const openrouter = benchmark.openrouterModels || [];
  const baselines = benchmark.openaiBaselines || [];
  const excluded = benchmark.excludedOpenRouterCandidates || [];
  const roster = openrouter.slice(0, 4).map(model => model.id || model.name).join(', ');
  const totals = benchmark.totals ?
    `${benchmark.totals.completedBattles || 0}/${benchmark.totals.scheduledBattles || benchmark.scheduledBattles || 0} battles | invalid ${benchmark.totals.invalidBenchmarks || 0}` :
    `${benchmark.completedBattles || 0}/${benchmark.scheduledBattles || 0} battles`;
  const last = benchmark.lastPair ?
    `last pair #${benchmark.lastPair.index}: ${benchmark.lastPair.openai?.name || 'OpenAI'} vs ${benchmark.lastPair.openrouter?.name || 'OpenRouter'}` :
    '';
  benchmarkStatusEl.innerHTML = `
    <strong>${escapeHTML(benchmark.status)} ${escapeHTML(benchmark.id || '')}</strong>
    <small>${escapeHTML(openrouter.length)} OpenRouter x ${escapeHTML(baselines.length)} OpenAI | pairs ${escapeHTML(benchmark.currentPair ?? 0)}/${escapeHTML(benchmark.pairCount ?? 0)} | ${benchmark.watchLocal ? 'watching local' : 'isolated battles'}</small>
    <small>${benchmark.runPaidBenchmark ? 'paid enabled' : 'plan/no paid'} | ${escapeHTML(totals)} | fallback ${escapeHTML(benchmark.totals?.fallbackCount ?? 0)} | api ${escapeHTML(benchmark.totals?.apiErrorCount ?? 0)}</small>
    ${roster ? `<small>${escapeHTML(roster)}${openrouter.length > 4 ? '...' : ''}</small>` : ''}
    ${excluded.length ? `<small>excluded ${escapeHTML(excluded.length)} | ${escapeHTML(excluded[0].id || excluded[0].label || '')}: ${escapeHTML(excluded[0].reason || '')}</small>` : ''}
    ${last ? `<small>${escapeHTML(last)}</small>` : ''}
    ${benchmark.usage ? `<small>${escapeHTML(formatUsage(benchmark.usage))}</small>` : ''}
    ${benchmark.error ? `<small>${escapeHTML(benchmark.error)}</small>` : ''}
    ${planLink || summaryLink || ratingLink ? `<small>${planLink} ${summaryLink} ${ratingLink}</small>` : ''}
  `;
  renderArenaTelemetry();
}

function isBenchmarkActive(benchmark) {
  return benchmark && ['running', 'paused', 'stopping'].includes(benchmark.status);
}

async function pauseArenaWorkflow() {
  const workflow = currentArenaWorkflow();
  if (!workflow?.active || workflow.status !== 'running') return;
  if (workflow.kind === 'run') await postRunCommand('pause');
  if (workflow.kind === 'ladder') await postLadderCommand('pause');
  if (workflow.kind === 'tournament') await postTournamentCommand('pause');
  if (workflow.kind === 'benchmark') await postBenchmarkCommand('pause');
}

async function resumeArenaWorkflow() {
  const workflow = currentArenaWorkflow();
  if (!workflow?.active || workflow.status !== 'paused') return;
  if (workflow.kind === 'run') await postRunCommand('resume');
  if (workflow.kind === 'ladder') await postLadderCommand('resume');
  if (workflow.kind === 'tournament') await postTournamentCommand('resume');
  if (workflow.kind === 'benchmark') await postBenchmarkCommand('resume');
}

function renderArenaTelemetry() {
  const workflow = currentArenaWorkflow();
  if (!workflow) {
    arenaWorkflowEl.textContent = 'manual controls';
    arenaAgentsEl.textContent = `${agentP1El.value || 'standin'} vs ${agentP2El.value || 'standin'}`;
    arenaLastChoicesEl.textContent = '-';
    arenaUsageEl.textContent = '-';
    arenaPauseEl.disabled = true;
    arenaResumeEl.disabled = true;
    document.body.dataset.arenaWorkflow = 'manual';
    return;
  }
  arenaWorkflowEl.textContent = workflow.label;
  arenaAgentsEl.textContent = workflow.agents;
  arenaLastChoicesEl.textContent = workflow.lastChoices || '-';
  arenaUsageEl.textContent = workflow.usage || '-';
  arenaPauseEl.disabled = !workflow.active || workflow.status !== 'running';
  arenaResumeEl.disabled = !workflow.active || workflow.status !== 'paused';
  document.body.dataset.arenaWorkflow = workflow.kind;
  document.body.dataset.arenaWorkflowStatus = workflow.status || '';
}

function renderBroadcast(p1Observation = getObservation(p1.state), p2Observation = getObservation(p2.state)) {
  const matchArtifact = latestArtifact?.schemaVersion === 'showdown-match-artifact.v1' ? latestArtifact : null;
  const sourceRun = latestRun || null;
  const calls = broadcastCalls(sourceRun, matchArtifact);
  const latestCall = calls.at(-1) || sourceRun?.lastModelCall || null;
  const p1Call = latestCallForRole(calls, 'p1');
  const p2Call = latestCallForRole(calls, 'p2');
  const result = sourceRun?.result || matchArtifact?.result || null;
  const activeObservation = selectedBroadcastView === 'p2' ? p2Observation : p1Observation;
  const fallbackObservation = p1Observation || p2Observation;
  const artifactOnly = !sourceRun && Boolean(matchArtifact);
  const turn = sourceRun?.currentTurn || (!artifactOnly ? matchArtifact?.result?.turn : null) || activeObservation?.turn || fallbackObservation?.turn || 0;
  const status = sourceRun?.status || (matchArtifact ? 'artifact' : 'manual');
  const winner = !artifactOnly ? result?.winner || '' : '';
  const activeNamesText = activeObservation ?
    `${activeNames(activeObservation.self) || '-'} vs ${activeNames(activeObservation.opponent) || '-'}` :
    sourceRun?.lastObservation ? `${sourceRun.lastObservation.active || '-'} vs ${sourceRun.lastObservation.opponent || '-'}` : '-';

  broadcastLiveLabelEl.textContent = status === 'running' ? 'Live Model Battle' : status === 'artifact' ? 'Saved Decision Feed' : 'Model Battle';
  broadcastHeadlineEl.textContent = winner ? `${winner} wins on turn ${turn || '-'}` : `Turn ${turn || '-'}: ${activeNamesText}`;
  broadcastSubtitleEl.textContent = broadcastSubtitle(sourceRun, matchArtifact, latestCall, activeObservation);
  broadcastTickerEl.textContent = broadcastTickerText(latestCall);
  broadcastFeedMetaEl.textContent = calls.length ? `${calls.length} model calls` : 'waiting';
  broadcastCardP1El.innerHTML = renderBroadcastModelCard('P1', sourceRun?.agentP1 || matchArtifact?.agents?.p1 || agentP1El.value || 'standin', p1Call, p1Observation, matchArtifact);
  broadcastCardP2El.innerHTML = renderBroadcastModelCard('P2', sourceRun?.agentP2 || matchArtifact?.agents?.p2 || agentP2El.value || 'standin', p2Call, p2Observation, matchArtifact);
  broadcastFeedEl.innerHTML = renderBroadcastFeed(calls, sourceRun, matchArtifact);
  updateClientScales();
}

function broadcastSubtitle(run, artifact, latestCall, observation) {
  const chunks = [];
  if (run?.agentP1 || run?.agentP2) chunks.push(`${agentDisplayName(run.agentP1)} vs ${agentDisplayName(run.agentP2)}`);
  else if (artifact?.agents) chunks.push(`feed ${agentDisplayName(artifact.agents.p1)} vs ${agentDisplayName(artifact.agents.p2)}`);
  if (observation?.formatid) chunks.push(observation.formatid);
  else if (run?.formatid || artifact?.formatid) chunks.push(run?.formatid || artifact?.formatid);
  if (!run && artifact?.result?.winner) chunks.push(`${artifact.result.winner} won T${artifact.result.turn ?? '-'}`);
  if (latestCall?.choice || latestCall?.requestedChoice) chunks.push(`${latestCall.role || '-'} chose ${latestCall.choice || latestCall.requestedChoice}`);
  if (run?.usage || artifact?.usage) chunks.push(formatUsage(run?.usage || artifact?.usage || {}));
  return chunks.join(' | ') || '-';
}

function broadcastTickerText(call = null) {
  if (!call) return 'No model decision yet.';
  const thought = firstAnalysisLine(call.analysis, ['gameStateSummary', 'opponentLikelyPlan', 'riskAssessment']) || call.reason || '';
  const choice = call.choice || call.requestedChoice || '';
  if (thought && choice) return `${(call.role || '').toUpperCase()} ${choice}: ${thought}`;
  return thought || choice || 'No model decision yet.';
}

function broadcastCalls(run, artifact) {
  if (run?.lastModelCalls?.length) return run.lastModelCalls;
  if (run?.lastModelCall) return [run.lastModelCall];
  if (artifact?.modelCalls?.length) return artifact.modelCalls.slice(-14);
  return [];
}

function latestCallForRole(calls, role) {
  return calls.filter(call => call.role === role).at(-1) || null;
}

function renderBroadcastModelCard(label, agent, call, observation, artifact = null) {
  const artifactBoard = call ? broadcastCallBoard(call, artifact) : '';
  const active = artifactBoard || (observation ? activeNames(observation.self) : '');
  const thought = firstAnalysisLine(call?.analysis, ['gameStateSummary', 'winConditions', 'biggestThreats']) || call?.reason || 'Waiting for a model decision.';
  const choice = call?.choice || call?.requestedChoice || '-';
  const status = call ? `${call.valid ? 'valid' : 'invalid'} | ${call.fallback ? 'fallback' : 'direct'}` : playerStatus({connected: true}, observation);
  return `
    <div class="broadcast-card-head">
      <span>${escapeHTML(label)}</span>
      <strong>${escapeHTML(shortAgentName(agentDisplayName(agent)))}</strong>
    </div>
    <div class="broadcast-card-board">${escapeHTML(active || '-')}</div>
    <p>${escapeHTML(thought)}</p>
    <code>${escapeHTML(choice)}</code>
    <small>${escapeHTML(status)}</small>
  `;
}

function renderBroadcastFeed(calls, run, artifact) {
  const visible = calls.slice(-10).reverse();
  if (!visible.length) {
    const hint = run?.status ? `${run.status} ${run.id || ''}` : artifact ? 'No model calls recorded in this artifact.' : 'No model run selected.';
    return `<div class="broadcast-empty">${escapeHTML(hint)}</div>`;
  }
  return visible.map((call, index) => {
    const turn = broadcastCallTurn(call, artifact);
    const analysis = call.analysis || {};
    const state = firstAnalysisLine(analysis, ['gameStateSummary']) || '';
    const opponent = firstAnalysisLine(analysis, ['opponentLikelyPlan', 'biggestThreats']) || '';
    const risk = firstAnalysisLine(analysis, ['riskAssessment']) || '';
    const candidates = Array.isArray(analysis.candidateChoices) ? analysis.candidateChoices.slice(0, 2) : [];
    return `
      <article class="broadcast-feed-card${index === 0 ? ' latest' : ''}">
        <div class="broadcast-feed-head">
          <span>T${escapeHTML(turn ?? '-')} ${escapeHTML((call.role || '').toUpperCase())}</span>
          <strong>${escapeHTML(call.choice || call.requestedChoice || '-')}</strong>
        </div>
        ${state ? `<p>${escapeHTML(state)}</p>` : ''}
        ${opponent ? `<small>${escapeHTML(opponent)}</small>` : ''}
        ${risk ? `<small>${escapeHTML(risk)}</small>` : ''}
        ${candidates.length ? `<ul>${candidates.map(candidate => `<li>${escapeHTML(candidate)}</li>`).join('')}</ul>` : ''}
        ${call.reason ? `<div class="broadcast-final">${escapeHTML(call.reason)}</div>` : ''}
      </article>
    `;
  }).join('');
}

function broadcastCallTurn(call, artifact) {
  const action = artifact?.actions?.find(item => item.callIndex === call.callIndex || item.observationIndex === call.observationIndex);
  if (action?.turn != null) return action.turn;
  const observation = artifact?.observations?.[call.observationIndex];
  return observation?.turn ?? null;
}

function broadcastCallBoard(call, artifact) {
  const observation = artifact?.observations?.[call.observationIndex]?.observation;
  if (!observation) return '';
  return activeNames(observation.self) || '';
}

function firstAnalysisLine(analysis = {}, keys = []) {
  for (const key of keys) {
    const rows = analysis?.[key];
    if (Array.isArray(rows) && rows.length) return rows[0];
  }
  return '';
}

function shortAgentName(agent = '') {
  return String(agent || '')
    .replace(/^openai:/u, '')
    .replace(/^openrouter:/u, '')
    .replace(/:low$/u, ' low')
    .replace(/:medium$/u, ' medium')
    .replace(/:high$/u, ' high');
}

function agentDisplayName(agent = '') {
  if (!agent) return '-';
  if (typeof agent === 'string') return agent;
  if (typeof agent !== 'object') return String(agent);
  return agent.name || agent.agentSpec || agent.ratingKey || [agent.provider, agent.model, agent.reasoningEffort].filter(Boolean).join(':') || '-';
}

function currentArenaWorkflow() {
  if (isRunActive(latestRun)) return modelWorkflow(latestRun);
  if (isLadderActive(latestLadder)) return ladderWorkflow(latestLadder);
  if (isTournamentActive(latestTournament)) return tournamentWorkflow(latestTournament);
  if (isBenchmarkActive(latestBenchmark)) return benchmarkWorkflow(latestBenchmark);
  if (latestRun) return modelWorkflow(latestRun);
  if (latestLadder) return ladderWorkflow(latestLadder);
  if (latestTournament) return tournamentWorkflow(latestTournament);
  if (latestBenchmark) return benchmarkWorkflow(latestBenchmark);
  return null;
}

function modelWorkflow(run) {
  const lastActions = run.lastActions || [];
  const last = summarizeLastChoices(lastActions) || summarizeModelCall(run.lastModelCall);
  return {
    kind: 'run',
    status: run.status || '',
    active: isRunActive(run),
    label: `${run.status || 'idle'} model run | T${run.currentTurn ?? 0}`,
    agents: `${run.agentP1 || '-'} vs ${run.agentP2 || '-'}`,
    lastChoices: last,
    usage: formatUsage(run.usage || {}),
  };
}

function ladderWorkflow(ladder) {
  const last = ladder.lastBattle ?
    `#${ladder.lastBattle.index} ${ladder.lastBattle.winnerAgent || 'draw'} T${ladder.lastBattle.turn ?? '-'}` :
    '-';
  return {
    kind: 'ladder',
    status: ladder.status || '',
    active: isLadderActive(ladder),
    label: `${ladder.status || 'idle'} ladder | ${ladder.currentBattle ?? 0}/${ladder.battleCount ?? 0}`,
    agents: `${ladder.agentA || '-'} vs ${ladder.agentB || '-'}`,
    lastChoices: last,
    usage: ladder.usage ? formatUsage(ladder.usage) : totalsText(ladder.totals),
  };
}

function tournamentWorkflow(tournament) {
  const last = tournament.lastPair ?
    `pair #${tournament.lastPair.index}: ${tournament.lastPair.agents?.a?.name || 'A'} vs ${tournament.lastPair.agents?.b?.name || 'B'}` :
    '-';
  return {
    kind: 'tournament',
    status: tournament.status || '',
    active: isTournamentActive(tournament),
    label: `${tournament.status || 'idle'} tournament | ${tournament.completedBattles ?? 0}/${tournament.scheduledBattles ?? 0}`,
    agents: `${tournament.agentCount ?? 0} agents`,
    lastChoices: last,
    usage: tournament.usage ? formatUsage(tournament.usage) : totalsText(tournament.totals),
  };
}

function benchmarkWorkflow(benchmark) {
  const last = benchmark.lastPair ?
    `pair #${benchmark.lastPair.index}: ${benchmark.lastPair.openai?.name || 'OpenAI'} vs ${benchmark.lastPair.openrouter?.name || 'OpenRouter'}` :
    '-';
  return {
    kind: 'benchmark',
    status: benchmark.status || '',
    active: isBenchmarkActive(benchmark),
    label: `${benchmark.status || 'idle'} benchmark | ${benchmark.completedBattles ?? 0}/${benchmark.scheduledBattles ?? 0}`,
    agents: `${benchmark.openrouterModels?.length || 0} OpenRouter x ${benchmark.openaiBaselines?.length || 0} OpenAI`,
    lastChoices: last,
    usage: benchmark.usage ? formatUsage(benchmark.usage) : totalsText(benchmark.totals),
  };
}

function summarizeLastChoices(actions = []) {
  return actions.slice(-2).map(action => `${action.role || '-'} T${action.turn ?? '-'} ${action.choice || '-'}`).join(' | ');
}

function summarizeModelCall(call = {}) {
  if (!call || (!call.choice && !call.requestedChoice)) return '';
  return `${call.role || '-'} ${call.choice || call.requestedChoice}`;
}

function totalsText(totals = null) {
  if (!totals) return '-';
  const invalid = Number(totals.invalidBenchmarks || 0);
  const api = Number(totals.apiErrorCount || 0);
  const fallback = Number(totals.fallbackCount || 0);
  return `invalid ${invalid} | api ${api} | fallback ${fallback}`;
}

function runAutoLoops() {
  maybeAuto(p1, autoLoopP1.checked);
  maybeAuto(p2, autoLoopP2.checked);
}

function maybeAuto(client, enabled) {
  if (!enabled) return;
  const observation = getObservation(client.state);
  const actions = observation?.legalActions || [];
  if (!observation || observation.waiting || !actions.length) return;
  const key = `${observation.turn}:${observation.requestId ?? 'request'}:${actions.map(action => action.choice).join('/')}`;
  if (client.autoKeys.has(key)) return;
  client.autoKeys.add(key);
  send(client, {type: 'auto'});
}

function send(client, payload) {
  if (client.ws?.readyState === WebSocket.OPEN) client.ws.send(JSON.stringify(payload));
}

function renderState() {
  const ok = p1.connected && p2.connected;
  const p1Observation = getObservation(p1.state);
  const p2Observation = getObservation(p2.state);
  const signature = renderSignature(p1Observation, p2Observation);
  if (signature === lastRenderSignature) return;
  lastRenderSignature = signature;

  statusEl.textContent = ok ?
    'Connected' :
    'Connecting clients...';

  renderRunStrip(p1Observation, p2Observation);
  renderPanel(p1Panel, p1, p1Observation);
  renderPanel(p2Panel, p2, p2Observation);
  stateEl.textContent = JSON.stringify({
    p1: p1Observation,
    p2: p2Observation,
  }, null, 2);
  renderBroadcast(p1Observation, p2Observation);
}

function renderSignature(p1Observation, p2Observation) {
  return JSON.stringify({
    p1Connected: p1.connected,
    p2Connected: p2.connected,
    p1: observationSignature(p1Observation),
    p2: observationSignature(p2Observation),
  });
}

function observationSignature(observation) {
  if (!observation) return null;
  return {
    turn: observation.turn,
    requestId: observation.requestId,
    requestFresh: observation.requestFresh,
    waiting: observation.waiting,
    ended: observation.ended,
    winner: observation.winner,
    active: activeNames(observation.self),
    opponent: activeNames(observation.opponent),
    legal: (observation.legalActions || []).map(action => action.choice).join('/'),
    historyTail: observation.history?.text?.slice(-3).join('/'),
  };
}

function setDisplayMode(mode) {
  displayMode = mode === 'exact' ? 'exact' : 'fit';
  localStorage.setItem('showdown-display-mode', displayMode);
  document.body.dataset.displayMode = displayMode;
  for (const button of displayModeButtons) {
    button.setAttribute('aria-pressed', String(button.dataset.displayMode === displayMode));
  }
  updateClientScales();
}

function setBroadcastView(view) {
  selectedBroadcastView = view === 'p2' ? 'p2' : 'p1';
  localStorage.setItem('showdown-broadcast-view', selectedBroadcastView);
  document.body.dataset.broadcastView = selectedBroadcastView;
  for (const button of broadcastViewButtons) {
    button.setAttribute('aria-pressed', String(button.dataset.broadcastView === selectedBroadcastView));
  }
  updateClientScales();
}

function updateClientScales() {
  for (const viewport of clientViewports) {
    const availableWidth = Math.max(260, viewport.clientWidth || viewport.parentElement?.clientWidth || clientBaseWidth);
    const top = Math.max(0, viewport.getBoundingClientRect?.().top || 0);
    const availableHeight = Math.max(260, window.innerHeight - top - 10);
    const widthScale = availableWidth / clientBaseWidth;
    const heightScale = availableHeight / clientBaseHeight;
    const scale = displayMode === 'exact' ? 1 : Math.max(0.28, Math.min(widthScale, heightScale));
    viewport.style.setProperty('--client-scale', String(scale));
    viewport.style.height = displayMode === 'exact' ? `${clientBaseHeight}px` : `${Math.ceil(clientBaseHeight * scale)}px`;
  }
  updateArenaMetric();
}

function updateArenaMetric() {
  const windows = [...document.querySelectorAll('.client-window')].filter(windowEl => windowEl.offsetParent !== null);
  if (!windows.length) return;
  const gridRect = document.querySelector('.client-grid')?.getBoundingClientRect();
  const lastRect = windows.at(-1).getBoundingClientRect();
  const columns = windows.length > 1 && new Set(windows.map(windowEl => Math.round(windowEl.getBoundingClientRect().top))).size === 1 ? windows.length : 1;
  document.body.dataset.battleArenaColumns = String(columns);
  document.body.dataset.battleArenaTop = String(Math.round(gridRect?.top ?? 0));
  document.body.dataset.battleArenaBottom = String(Math.round(lastRect.bottom));
  document.body.dataset.battleArenaAboveFold = String((gridRect?.top ?? 0) >= 0 && lastRect.bottom <= window.innerHeight);
}

function renderRunStrip(p1Observation, p2Observation) {
  const seed = p1Observation?.seed || p2Observation?.seed || [];
  document.querySelector('#turn').textContent = String(p1Observation?.turn ?? p2Observation?.turn ?? '-');
  document.querySelector('#format').textContent = p1Observation?.formatid || p2Observation?.formatid || '-';
  document.querySelector('#run-seed').textContent = Array.isArray(seed) && seed.length ? seed.join(',') : '-';
  document.querySelector('#p1-status').textContent = playerStatus(p1, p1Observation);
  document.querySelector('#p2-status').textContent = playerStatus(p2, p2Observation);
  document.querySelector('#winner').textContent = p1Observation?.winner || p2Observation?.winner || '-';
}

function playerStatus(client, observation) {
  if (!client.connected) return 'disconnected';
  if (!observation) return 'loading';
  if (observation.ended) return 'ended';
  if (observation.waiting) return 'waiting';
  return `${observation.legalActions?.length || 0} legal`;
}

function renderPanel(root, client, observation) {
  if (!observation) {
    root.textContent = 'Waiting for observation...';
    return;
  }

  root.innerHTML = [
    renderSummary(observation),
    renderFieldState(observation),
    renderKnowledgeState(observation),
    renderActions(client, observation),
    renderTeam('Own Team', observation.self?.team || []),
    renderOpponent(observation),
    renderHistory(observation),
  ].join('');

  for (const button of root.querySelectorAll('[data-choice]')) {
    button.addEventListener('click', () => send(client, {type: 'choose', choice: button.dataset.choice}));
  }
  const filterInput = root.querySelector('[data-action-filter]');
  if (filterInput) {
    filterInput.addEventListener('input', () => {
      actionFilters[client.role] = filterInput.value;
      lastRenderSignature = '';
      renderState();
    });
  }
}

function renderSummary(observation) {
  return `
    <div class="summary-grid">
      <div><span>Active</span><strong>${escapeHTML(activeNames(observation.self) || '-')}</strong></div>
      <div><span>Opponent</span><strong>${escapeHTML(activeNames(observation.opponent) || '-')}</strong></div>
      <div><span>Request</span><strong>${observation.requestFresh ? escapeHTML(String(observation.requestId ?? '-')) : 'stale'}</strong></div>
    </div>
  `;
}

function renderFieldState(observation) {
  const field = observation.field || {};
  const terrain = conditionName(field.terrain) || '-';
  const weather = conditionName(field.weather) || '-';
  const fieldConditions = conditionNames(field.conditions);
  const selfConditions = conditionNames(observation.self?.sideConditions);
  const opponentConditions = conditionNames(observation.opponent?.sideConditions);
  return `
    <section class="mini-section compact-section">
      <h3>Field</h3>
      <div class="fact-grid">
        <div><span>Weather</span><strong>${escapeHTML(weather)}</strong></div>
        <div><span>Terrain</span><strong>${escapeHTML(terrain)}</strong></div>
        <div><span>Field</span><strong>${escapeHTML(fieldConditions || '-')}</strong></div>
        <div><span>Own Side</span><strong>${escapeHTML(selfConditions || '-')}</strong></div>
        <div><span>Opponent Side</span><strong>${escapeHTML(opponentConditions || '-')}</strong></div>
      </div>
    </section>
  `;
}

function renderKnowledgeState(observation) {
  const source = observation.source || {};
  const ownKnowledge = summarizeKnowledge(observation.self?.team, 'full-own-team');
  const opponentKnowledge = summarizeKnowledge(observation.opponent?.revealedTeam, 'observed-public-protocol');
  return `
    <section class="mini-section compact-section">
      <h3>Known Info</h3>
      <div class="fact-grid">
        <div><span>Own</span><strong>${escapeHTML(ownKnowledge)}</strong></div>
        <div><span>Opponent</span><strong>${escapeHTML(opponentKnowledge)}</strong></div>
        <div><span>Hidden Bench</span><strong>${source.opponentHiddenTeamIncluded ? 'included' : 'excluded'}</strong></div>
      </div>
    </section>
  `;
}

function renderActions(client, observation) {
  const actions = observation.legalActions || [];
  if (!actions.length) {
    return '<section class="mini-section"><h3>Legal Choices</h3><div class="mon-pill">No legal choices right now.</div></section>';
  }
  const filter = actionFilters[client.role] || '';
  const filterActive = Boolean(filter.trim());
  const visibleActions = filterActions(actions, filter);
  const groups = groupActions(visibleActions);
  const groupHtml = groups.map(group => renderActionGroup(group, filterActive)).join('');
  const quickPicks = filterActive ? [] : selectQuickPicks(actions).slice(0, ACTION_QUICK_PICK_LIMIT);
  return `
    <section class="mini-section action-section">
      <h3>Legal Choices <span>${visibleActions.length}/${actions.length}</span></h3>
      <input class="action-filter" data-action-filter="${client.role}" type="text" value="${escapeHTML(filter)}" placeholder="filter moves, switches, targets" aria-label="${client.role} legal choice filter">
      <div class="choice-preview">${escapeHTML(visibleActions[0]?.choice || actions[0]?.choice || '-')}</div>
      ${quickPicks.length ? renderQuickPicks(quickPicks, actions.length) : ''}
      <div class="action-groups" data-role="${client.role}">${groupHtml}</div>
    </section>
  `;
}

function filterActions(actions, filter) {
  const needle = String(filter || '').trim().toLowerCase();
  if (!needle) return actions;
  return actions.filter(action => actionText(action).includes(needle));
}

function actionText(action = {}) {
  return [
    action.choice,
    action.command,
    action.label,
    action.move,
    action.pokemon,
    action.type,
    ...(action.choices || []).flatMap(part => [part.choice, part.command, part.label, part.move, part.pokemon, part.type]),
  ].filter(Boolean).join(' ').toLowerCase();
}

function groupActions(actions) {
  const groups = [
    {name: 'Attacks', actions: []},
    {name: 'Switches', actions: []},
    {name: 'Terastallize', actions: []},
    {name: 'Other', actions: []},
  ];
  for (const action of actions) {
    if (action.hasTerastallize || action.choice.includes('terastallize')) groups[2].actions.push(action);
    else if (action.hasSwitch || action.type === 'switch' || action.type === 'force-switch') groups[1].actions.push(action);
    else if (action.type === 'move' || action.type === 'double-choice') groups[0].actions.push(action);
    else groups[3].actions.push(action);
  }
  return groups.filter(group => group.actions.length);
}

function renderQuickPicks(actions, totalCount) {
  return `
    <div class="quick-choice-list" aria-label="quick legal choices">
      <div class="action-note">Quick picks show ${actions.length} of ${totalCount}. Filter or open a group for exact choices.</div>
      ${actions.map(renderActionButton).join('')}
    </div>
  `;
}

function selectQuickPicks(actions) {
  const buckets = [
    actions.filter(action => !action.hasTerastallize && !action.hasSwitch && !String(action.choice || '').includes('terastallize')),
    actions.filter(action => action.hasSwitch || action.type === 'switch' || action.type === 'force-switch'),
    actions.filter(action => action.hasTerastallize || String(action.choice || '').includes('terastallize')),
    actions,
  ];
  const picks = [];
  const seen = new Set();
  for (const bucket of buckets) {
    for (const action of bucket) {
      if (!action.choice || seen.has(action.choice)) continue;
      seen.add(action.choice);
      picks.push(action);
      if (picks.length >= ACTION_QUICK_PICK_LIMIT) return picks;
    }
  }
  return picks;
}

function renderActionGroup(group, filterActive) {
  const limit = filterActive ? ACTION_FILTER_GROUP_LIMIT : ACTION_DEFAULT_GROUP_LIMIT;
  const visible = group.actions.slice(0, limit);
  const hidden = group.actions.length - visible.length;
  const rows = visible.map(renderActionButton).join('');
  return `
    <details class="action-group" ${filterActive ? 'open' : ''}>
      <summary>${escapeHTML(group.name)} <span>${group.actions.length}</span></summary>
      <div class="action-list">
        ${rows}
        ${hidden > 0 ? `<div class="action-note">Showing ${visible.length} of ${group.actions.length}. Filter to narrow exact choices.</div>` : ''}
      </div>
    </details>
  `;
}

function renderActionButton(action) {
  const label = action.label || action.move || action.pokemon || action.choice;
  const meta = action.choice === label ? '' : `<small>${escapeHTML(action.choice)}</small>`;
  return `<button data-choice="${escapeHTML(action.choice)}" title="${escapeHTML(action.choice)}">${escapeHTML(label)}${meta}</button>`;
}

function renderTeam(title, team) {
  const mons = team.map(mon => `
    <div class="mon-pill${mon.active ? ' active' : ''}">
      ${escapeHTML(mon.name || mon.species || 'Unknown')}
      <small>${escapeHTML(describeOwnMon(mon))}</small>
      ${mon.moves?.length ? `<small>${escapeHTML(`moves: ${mon.moves.join(', ')}`)}</small>` : ''}
      ${mon.knowledge ? `<small>${escapeHTML(mon.knowledge)}</small>` : ''}
    </div>
  `).join('');
  return `<section class="mini-section"><h3>${escapeHTML(title)}</h3><div class="team-list">${mons}</div></section>`;
}

function renderOpponent(observation) {
  const revealed = observation.opponent?.revealedTeam || [];
  const mons = revealed.length ? revealed.map(mon => `
    <div class="mon-pill${mon.active ? ' active' : ''}">
      ${escapeHTML(mon.name || mon.species || 'Unknown')}
      <small>${escapeHTML(describeOpponent(mon))}</small>
    </div>
  `).join('') : '<div class="mon-pill">No revealed opponent yet.</div>';
  return `<section class="mini-section"><h3>Revealed Opponent</h3><div class="team-list">${mons}</div></section>`;
}

function renderHistory(observation) {
  const rows = (observation.history?.text || []).slice(-8).map(line => `<div>${escapeHTML(line)}</div>`).join('');
  return `<section class="mini-section"><h3>Visible History</h3><div class="history-list">${rows || '<div>No history yet.</div>'}</div></section>`;
}

function describeOpponent(mon) {
  const parts = [mon.condition, mon.status, mon.ability && `ability: ${mon.ability}`, mon.item && `item: ${mon.item}`];
  if (mon.itemLastKnown) parts.push(`used: ${mon.itemLastKnown}`);
  if (mon.itemConsumed) parts.push('item consumed');
  if (mon.teraType) parts.push(`tera: ${mon.teraType}`);
  if (mon.movesRevealed?.length) parts.push(`moves: ${mon.movesRevealed.join(', ')}`);
  const unknowns = opponentUnknowns(mon);
  if (unknowns.length) parts.push(`unknown: ${unknowns.join(', ')}`);
  if (mon.knowledge) parts.push(mon.knowledge);
  return parts.filter(Boolean).join(' | ') || 'visible only';
}

function describeOwnMon(mon = {}) {
  return [
    mon.condition,
    mon.item && `item: ${mon.item}`,
    mon.ability && `ability: ${mon.ability}`,
    mon.nature && `nature: ${mon.nature}`,
    mon.teraType && `tera: ${mon.teraType}`,
    mon.terastallized && `terastallized: ${mon.terastallized}`,
  ].filter(Boolean).join(' | ') || 'healthy';
}

function opponentUnknowns(mon = {}) {
  const unknowns = [];
  if (!mon.item && !mon.itemLastKnown && !mon.itemConsumed) unknowns.push('item');
  if (!mon.ability) unknowns.push('ability');
  if (!mon.teraType) unknowns.push('tera');
  if (!mon.movesRevealed?.length) unknowns.push('moves');
  return unknowns;
}

function summarizeKnowledge(team = [], expected) {
  const count = Array.isArray(team) ? team.length : 0;
  if (!count) return 'none';
  const matching = team.filter(mon => mon.knowledge === expected).length;
  return matching === count ? `${count} ${expected}` : `${matching}/${count} ${expected}`;
}

function conditionNames(conditions = {}) {
  return Object.values(conditions || {})
    .map(conditionName)
    .filter(Boolean)
    .join(', ');
}

function conditionName(condition) {
  if (!condition) return '';
  if (typeof condition === 'string') return condition;
  const name = condition.name || '';
  const layers = Number(condition.layers || 0);
  return layers > 1 ? `${name} x${layers}` : name;
}

async function loadArtifacts(options = {}) {
  try {
    const response = await fetch('/api/artifacts');
    if (!response.ok) return;
    const body = await response.json();
    artifactFiles = body.artifacts || [];
    const links = artifactFiles.slice(0, 10).map(file => (
      `<a href="${escapeHTML(file.href)}" target="_blank" rel="noreferrer" data-artifact-href="${escapeHTML(file.href)}">${escapeHTML(file.name)}<small>${formatBytes(file.bytes)} | ${escapeHTML(file.updatedAt)}</small></a>`
    )).join('');
    artifactsEl.innerHTML = links || '<div class="mon-pill">No JSON artifacts yet.</div>';
    renderArtifactSelect();
    if (!selectedArtifactHref || !artifactFiles.some(file => file.href === selectedArtifactHref)) {
      selectedArtifactHref = artifactFiles[0]?.href || '';
      if (selectedArtifactHref) localStorage.setItem('showdown-selected-artifact', selectedArtifactHref);
      artifactSelect.value = selectedArtifactHref;
    }
    if (selectedArtifactHref && (options.force || !artifactSummaryEl.dataset.loadedHref)) {
      await loadSelectedArtifact();
    }
  } catch {}
}

function renderArtifactSelect() {
  artifactSelect.innerHTML = artifactFiles.slice(0, 80).map(file => (
    `<option value="${escapeHTML(file.href)}">${escapeHTML(file.name)}</option>`
  )).join('');
  artifactSelect.value = selectedArtifactHref || artifactFiles[0]?.href || '';
}

async function loadSelectedArtifact() {
  if (!selectedArtifactHref) {
    latestArtifact = null;
    artifactSummaryEl.innerHTML = '<div class="mon-pill">No artifact selected.</div>';
    artifactTimelineEl.innerHTML = '';
    artifactTraceEl.innerHTML = '';
    renderBroadcast();
    return;
  }
  try {
    artifactSummaryEl.dataset.loadedHref = selectedArtifactHref;
    artifactSummaryEl.innerHTML = '<div class="mon-pill">Loading...</div>';
    const response = await fetch(selectedArtifactHref);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const artifact = await response.json();
    latestArtifact = artifact;
    renderArtifactLab(artifact, selectedArtifactHref);
    renderBroadcast();
  } catch (error) {
    latestArtifact = null;
    artifactSummaryEl.innerHTML = `<div class="mon-pill">Could not load artifact.<small>${escapeHTML(error.message)}</small></div>`;
    artifactTimelineEl.innerHTML = '';
    artifactTraceEl.innerHTML = '';
    renderBroadcast();
  }
}

function renderArtifactLab(artifact, href) {
  if (artifact.schemaVersion === 'showdown-ladder-summary.v1') {
    renderLadderArtifact(artifact, href);
  } else if (artifact.schemaVersion === 'showdown-tournament-summary.v1') {
    renderTournamentArtifact(artifact, href);
  } else if (artifact.schemaVersion === 'showdown-openrouter-benchmark-suite.v1') {
    renderBenchmarkPlanArtifact(artifact, href);
  } else if (artifact.schemaVersion === 'showdown-openrouter-benchmark-run.v1') {
    renderBenchmarkRunArtifact(artifact, href);
  } else if (artifact.schemaVersion === 'showdown-match-artifact.v1') {
    renderMatchArtifact(artifact, href);
  } else {
    artifactSummaryEl.innerHTML = `<div class="mon-pill">Unknown artifact schema.<small>${escapeHTML(artifact.schemaVersion || href)}</small></div>`;
    artifactTimelineEl.innerHTML = `<pre>${escapeHTML(JSON.stringify(artifact, null, 2).slice(0, 12000))}</pre>`;
    artifactTraceEl.innerHTML = '';
  }
}

function renderMatchArtifact(artifact, href) {
  const usage = artifact.usage || {};
  const eventHref = eventHrefForArtifact(artifact, href);
  artifactSummaryEl.innerHTML = `
    <div class="summary-grid lab-cards">
      <div><span>Artifact</span><strong>${escapeHTML(fileNameFromHref(href))}</strong></div>
      <div><span>Battle</span><strong>${escapeHTML(artifact.battleId || '-')}</strong></div>
      <div><span>Format</span><strong>${escapeHTML(artifact.formatid || '-')}</strong></div>
      <div><span>Result</span><strong>${escapeHTML(artifact.result?.winner || artifact.result?.reason || '-')}</strong></div>
      <div><span>Validity</span><strong>${artifact.validBenchmark ? 'valid' : 'invalid'}</strong></div>
      <div><span>Usage</span><strong>${formatUsage(usage)}</strong></div>
      <div><span>Events</span><strong>${eventHref ? `<a href="${escapeHTML(eventHref)}" target="_blank" rel="noreferrer">JSONL</a>` : '-'}</strong></div>
    </div>
  `;
  artifactTimelineEl.innerHTML = renderTimeline(artifact);
  artifactTraceEl.innerHTML = renderTrace(artifact);
}

function renderLadderArtifact(artifact, href) {
  const rows = (artifact.battles || []).map(battle => {
    const eventsHref = eventHrefForBattle(battle);
    return `
      <div class="timeline-row">
        <strong>#${battle.index} ${escapeHTML(battle.winnerAgent || 'draw')}</strong>
        <small>${escapeHTML(battle.battleId || '')} | turn ${escapeHTML(battle.turn ?? '-')} | ${battle.validBenchmark ? 'valid' : 'invalid'}${eventsHref ? ` | <a href="${escapeHTML(eventsHref)}" target="_blank" rel="noreferrer">events</a>` : ''}</small>
        <code>${escapeHTML((battle.seed || []).join(','))}</code>
      </div>
    `;
  }).join('');
  artifactSummaryEl.innerHTML = `
    <div class="summary-grid lab-cards">
      <div><span>Artifact</span><strong>${escapeHTML(fileNameFromHref(href))}</strong></div>
      <div><span>Battles</span><strong>${artifact.battleCount || artifact.battles?.length || 0}</strong></div>
      <div><span>Format</span><strong>${escapeHTML(artifact.formatid || '-')}</strong></div>
      <div><span>A Wins</span><strong>${artifact.totals?.agentAWins ?? 0}</strong></div>
      <div><span>B Wins</span><strong>${artifact.totals?.agentBWins ?? 0}</strong></div>
      <div><span>Usage</span><strong>${formatUsage(artifact.usage || {})}</strong></div>
    </div>
  `;
  artifactTimelineEl.innerHTML = rows || '<div class="mon-pill">No battles recorded.</div>';
  artifactTraceEl.innerHTML = renderRatings(artifact);
}

function renderTournamentArtifact(artifact, href) {
  const rows = (artifact.pairs || []).map(pair => `
    <div class="timeline-row">
      <strong>#${pair.index} ${escapeHTML(pair.agents?.a?.name || 'A')} vs ${escapeHTML(pair.agents?.b?.name || 'B')}</strong>
      <small>${escapeHTML(pair.battles || 0)} battles | invalid ${escapeHTML(pair.totals?.invalidBenchmarks ?? 0)}${pair.summaryHref ? ` | <a href="${escapeHTML(pair.summaryHref)}" target="_blank" rel="noreferrer">pair summary</a>` : ''}</small>
      <code>${escapeHTML(pair.pairId || '')}</code>
    </div>
  `).join('');
  artifactSummaryEl.innerHTML = `
    <div class="summary-grid lab-cards">
      <div><span>Artifact</span><strong>${escapeHTML(fileNameFromHref(href))}</strong></div>
      <div><span>Agents</span><strong>${artifact.agentCount || artifact.agents?.length || 0}</strong></div>
      <div><span>Pairs</span><strong>${artifact.completedPairs ?? artifact.pairs?.length ?? 0}/${artifact.pairCount || 0}</strong></div>
      <div><span>Battles</span><strong>${artifact.completedBattles ?? artifact.totals?.completedBattles ?? 0}/${artifact.scheduledBattles || 0}</strong></div>
      <div><span>Invalid</span><strong>${artifact.totals?.invalidBenchmarks ?? 0}</strong></div>
      <div><span>Usage</span><strong>${formatUsage(artifact.usage || {})}</strong></div>
    </div>
  `;
  artifactTimelineEl.innerHTML = rows || '<div class="mon-pill">No pairs recorded.</div>';
  artifactTraceEl.innerHTML = renderStandings(artifact);
}

function renderBenchmarkPlanArtifact(artifact, href) {
  const rows = (artifact.openrouterModels || []).map(model => `
    <div class="timeline-row">
      <strong>${escapeHTML(model.rank ? `#${model.rank} ` : '')}${escapeHTML(model.name || model.id)}</strong>
      <small>${escapeHTML(model.id || '')} | ${escapeHTML(model.reasoningEffort || '-')} | ${escapeHTML(model.selectionSource || '')}</small>
      <code>${escapeHTML(model.agentSpec || '')}</code>
    </div>
  `).join('');
  const excluded = (artifact.excludedOpenRouterCandidates || []).map(item => `
    <div class="timeline-row">
      <strong>${escapeHTML(item.id || item.label || '-')}</strong>
      <small>${escapeHTML(item.reason || '')}</small>
    </div>
  `).join('');
  artifactSummaryEl.innerHTML = `
    <div class="summary-grid lab-cards">
      <div><span>Artifact</span><strong>${escapeHTML(fileNameFromHref(href))}</strong></div>
      <div><span>Format</span><strong>${escapeHTML(artifact.formatid || '-')}</strong></div>
      <div><span>OpenRouter</span><strong>${artifact.openrouterModels?.length || 0}</strong></div>
      <div><span>OpenAI</span><strong>${artifact.openaiBaselines?.length || 0}</strong></div>
      <div><span>Pairs</span><strong>${artifact.pairs?.length || 0}</strong></div>
      <div><span>Excluded</span><strong>${artifact.excludedOpenRouterCandidates?.length || 0}</strong></div>
    </div>
  `;
  artifactTimelineEl.innerHTML = rows || '<div class="mon-pill">No OpenRouter models selected.</div>';
  artifactTraceEl.innerHTML = excluded || '<div class="mon-pill">No excluded candidates.</div>';
}

function renderBenchmarkRunArtifact(artifact, href) {
  const rows = (artifact.pairs || []).map(pair => `
    <div class="timeline-row">
      <strong>#${pair.index} ${escapeHTML(pair.openai?.name || 'OpenAI')} vs ${escapeHTML(pair.openrouter?.name || 'OpenRouter')}</strong>
      <small>${escapeHTML(pair.battles || 0)} battles | invalid ${escapeHTML(pair.totals?.invalidBenchmarks ?? 0)}${pair.summaryHref ? ` | <a href="${escapeHTML(pair.summaryHref)}" target="_blank" rel="noreferrer">pair summary</a>` : ''}</small>
      <code>${escapeHTML(pair.pairId || '')}</code>
    </div>
  `).join('');
  artifactSummaryEl.innerHTML = `
    <div class="summary-grid lab-cards">
      <div><span>Artifact</span><strong>${escapeHTML(fileNameFromHref(href))}</strong></div>
      <div><span>Pairs</span><strong>${artifact.totals?.completedPairs ?? artifact.pairs?.length ?? 0}/${artifact.totals?.pairs ?? 0}</strong></div>
      <div><span>Battles</span><strong>${artifact.totals?.completedBattles ?? 0}/${artifact.totals?.scheduledBattles ?? 0}</strong></div>
      <div><span>Invalid</span><strong>${artifact.totals?.invalidBenchmarks ?? 0}</strong></div>
      <div><span>Aborted</span><strong>${artifact.aborted ? 'yes' : 'no'}</strong></div>
      <div><span>Usage</span><strong>${formatUsage(artifact.usage || {})}</strong></div>
    </div>
  `;
  artifactTimelineEl.innerHTML = rows || '<div class="mon-pill">No pairs recorded.</div>';
  artifactTraceEl.innerHTML = renderRatings(artifact);
}

function renderTimeline(artifact) {
  const actions = artifact.actions || [];
  return actions.map(action => {
    const call = artifact.modelCalls?.[action.callIndex] || {};
    const observation = artifact.observations?.[action.observationIndex] || {};
    return `
      <div class="timeline-row">
        <strong>T${action.turn} ${escapeHTML(action.role)}: ${escapeHTML(action.choice)}</strong>
        <small>${escapeHTML(call.provider || '')}:${escapeHTML(call.model || '')} | obs ${action.observationIndex} | legal ${observation.legalActions?.length ?? '-'}</small>
        <span>${escapeHTML(call.reason || '')}</span>
      </div>
    `;
  }).join('') || '<div class="mon-pill">No actions recorded.</div>';
}

function renderTrace(artifact) {
  const calls = artifact.modelCalls || [];
  return calls.slice(0, 40).map((call, index) => `
    <details class="trace-row">
      <summary>${index} ${escapeHTML(call.role || '-')} ${escapeHTML(call.choice || call.requestedChoice || '-')}</summary>
      <div class="trace-meta">${escapeHTML(call.provider || '')}:${escapeHTML(call.model || '')} | ${call.valid ? 'valid' : 'invalid'} | ${call.fallback ? 'fallback' : 'direct'} | ${analysisStatus(call)} | ${formatUsage({calls: 1, promptTokens: tokenValue(call.usage, 'prompt'), completionTokens: tokenValue(call.usage, 'completion'), totalTokens: tokenValue(call.usage, 'total'), costKnown: hasCost(call), costUsd: costValue(call)})}</div>
      ${call.reason ? `<p>${escapeHTML(call.reason)}</p>` : ''}
      ${renderAnalysis(call.analysis)}
      ${call.prompt ? `<h4>Prompt</h4><pre>${escapeHTML(call.prompt.slice(0, 8000))}</pre>` : ''}
      ${call.rawText ? `<h4>Response</h4><pre>${escapeHTML(call.rawText.slice(0, 4000))}</pre>` : ''}
      ${call.scores ? `<h4>Scores</h4><pre>${escapeHTML(JSON.stringify(call.scores, null, 2))}</pre>` : ''}
    </details>
  `).join('') || '<div class="mon-pill">No model calls recorded.</div>';
}

function renderAnalysis(analysis = {}) {
  analysis = analysis || {};
  const groups = [
    ['Game State', analysis.gameStateSummary],
    ['Win Paths', analysis.winConditions],
    ['Loss Risks', analysis.loseConditions],
    ['Setup', analysis.setupLines],
    ['Sweep', analysis.sweepPlans],
    ['Switches', analysis.safeSwitches],
    ['Opponent', analysis.opponentLikelyPlan],
    ['Threats', analysis.biggestThreats],
    ['Risk', analysis.riskAssessment],
    ['Candidates', analysis.candidateChoices],
  ].filter(([, rows]) => Array.isArray(rows) && rows.length);
  if (!groups.length) return '';
  return `
    <div class="analysis-grid">
      ${groups.map(([title, rows]) => `
        <section>
          <h4>${escapeHTML(title)}</h4>
          <ul>${rows.map(row => `<li>${escapeHTML(row)}</li>`).join('')}</ul>
        </section>
      `).join('')}
    </div>
  `;
}

function analysisStatus(call = {}) {
  if (call.analysisComplete === true) return 'analysis complete';
  if (Array.isArray(call.analysisMissing) && call.analysisMissing.length) return `analysis missing ${call.analysisMissing.join(', ')}`;
  return 'analysis not required';
}

function renderRatings(artifact) {
  const ratings = artifact.ratings || {};
  const rows = Object.entries(ratings).map(([key, value]) => `
    <div class="timeline-row">
      <strong>${escapeHTML(key)}</strong>
      <small>rating ${escapeHTML(value?.rating ?? '-')} | games ${escapeHTML(value?.games ?? 0)} | invalid ${escapeHTML(value?.invalidGames ?? 0)}</small>
    </div>
  `).join('');
  return rows || '<div class="mon-pill">No ratings recorded.</div>';
}

function renderStandings(artifact) {
  const standings = artifact.standings || {};
  const ratings = artifact.ratings || {};
  const rows = Object.entries(standings)
    .sort(([, a], [, b]) => (b.wins || 0) - (a.wins || 0) || (a.losses || 0) - (b.losses || 0))
    .map(([key, value]) => `
      <div class="timeline-row">
        <strong>${escapeHTML(value.agent?.name || key)}</strong>
        <small>w ${escapeHTML(value.wins || 0)} | l ${escapeHTML(value.losses || 0)} | draw ${escapeHTML(value.drawsOrCaps || 0)} | games ${escapeHTML(value.games || 0)} | rating ${escapeHTML(ratings[key]?.rating ?? '-')}</small>
      </div>
    `).join('');
  return rows || renderRatings(artifact);
}

function formatUsage(usage = {}) {
  const tokens = Number(usage.totalTokens || 0);
  const cost = usage.costKnown ? `$${Number(usage.costUsd || 0).toFixed(6)}` : 'cost n/a';
  return `${tokens} tok | ${cost}`;
}

function tokenValue(usage = {}, kind) {
  if (kind === 'prompt') return Number(usage?.prompt_tokens ?? usage?.input_tokens ?? 0);
  if (kind === 'completion') return Number(usage?.completion_tokens ?? usage?.output_tokens ?? 0);
  return Number(usage?.total_tokens ?? tokenValue(usage, 'prompt') + tokenValue(usage, 'completion'));
}

function hasCost(call = {}) {
  return costValue(call) !== null;
}

function costValue(call = {}) {
  const usage = call.usage || {};
  const metadata = call.openrouterMetadata || {};
  for (const value of [usage.cost, usage.cost_usd, usage.costUsd, metadata.cost, metadata.cost_usd]) {
    const number = Number(value);
    if (Number.isFinite(number)) return number;
  }
  return null;
}

function fileNameFromHref(href = '') {
  return decodeURIComponent(href.split('/artifacts/').pop() || href);
}

function eventHrefForArtifact(artifact, href) {
  if (artifact.eventsHref) return artifact.eventsHref;
  const fromPath = artifactPathToHref(artifact.eventsPath);
  if (fromPath) return fromPath;
  return href.endsWith('.json') ? href.replace(/\.json$/u, '.events.jsonl') : '';
}

function eventHrefForBattle(battle) {
  return battle.eventsHref || artifactPathToHref(battle.eventsPath);
}

function artifactPathToHref(filePath = '') {
  const marker = '/artifacts/';
  const normalized = String(filePath || '').replaceAll('\\', '/');
  const index = normalized.lastIndexOf(marker);
  return index >= 0 ? `/artifacts/${normalized.slice(index + marker.length).split('/').map(encodeURIComponent).join('/')}` : '';
}

function getObservation(state) {
  return state?.extracted || state?.observation || null;
}

function activeNames(side = {}) {
  const names = (side.activePokemon || []).map(mon => mon.name).filter(Boolean);
  return names.length ? names.join(' + ') : side.active?.name || null;
}

function parseSeed(value) {
  const parts = String(value || '').split(',').map(part => Number(part.trim())).filter(Number.isFinite);
  return parts.length === 4 ? parts : null;
}

function numberInput(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function formatSeed(seed) {
  return Array.isArray(seed) && seed.length ? seed.join(',') : 'random seed';
}

function escapeHTML(value) {
  return String(value ?? '').replace(/[&<>"']/g, char => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  })[char]);
}

function formatBytes(bytes = 0) {
  if (bytes > 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  if (bytes > 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} B`;
}
