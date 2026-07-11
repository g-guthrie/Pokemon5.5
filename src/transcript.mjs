import {sanitizeText} from './agent-runtime.mjs';
import {describeProtocolLine} from './protocol-view.mjs';

// A match artifact rendered as plain text a human can skim and an AI can
// analyze: full teams (post-game, hidden info included), then every decision
// with the model's own stated reason, interleaved with the public
// play-by-play. This is the shareable record of a game — copy, paste, ask
// another model what P2 should have done on turn 6.

export function transcriptPathForArtifact(outputPath = '') {
  const target = String(outputPath || '').trim();
  if (!target) return '';
  return target.endsWith('.json') ? target.replace(/\.json$/u, '.transcript.txt') : `${target}.transcript.txt`;
}

export function transcriptFromMatchArtifact(match = {}) {
  const names = {
    p1: playerLabel(match, 'p1'),
    p2: playerLabel(match, 'p2'),
  };
  const lines = [];
  lines.push('=== Pokémon Showdown LLM Arena — match transcript ===');
  lines.push(`Players: ${names.p1} (P1) vs ${names.p2} (P2)`);
  lines.push(`Format: ${match.formatid || 'unknown'} · started ${match.startedAt || 'unknown'}`);
  lines.push(resultLine(match, names));
  lines.push('');

  for (const role of ['p1', 'p2']) {
    const snapshot = match.teamSnapshots?.[role];
    if (!snapshot?.team?.length) continue;
    lines.push(`--- ${role.toUpperCase()} team (${names[role]}) — full sets, hidden info included post-game ---`);
    for (const mon of snapshot.team) {
      const bits = [mon.species || mon.name || '?'];
      if (mon.item) bits.push(`@ ${mon.item}`);
      const traits = [];
      if (mon.ability) traits.push(`ability ${mon.ability}`);
      if (mon.teraType) traits.push(`Tera ${mon.teraType}`);
      if (mon.level) traits.push(`L${mon.level}`);
      lines.push(`  ${mon.slot ?? '?'}. ${bits.join(' ')}${traits.length ? ` · ${traits.join(' · ')}` : ''}`);
      if (mon.moves?.length) lines.push(`     moves: ${mon.moves.join(', ')}`);
    }
    lines.push('');
  }

  lines.push('--- Play-by-play ---');
  for (const event of timelineEvents(match, names)) lines.push(event);
  lines.push('');

  lines.push('--- Outcome ---');
  lines.push(resultLine(match, names));
  const decisions = match.actions?.length || 0;
  const byRole = role => (match.actions || []).filter(action => action.role === role).length;
  lines.push(`Decisions: ${decisions} (P1 ${byRole('p1')}, P2 ${byRole('p2')}) · fallbacks ${match.fallbackCount || 0} · invalid choices ${match.invalidChoiceCount || 0} · API errors ${match.apiErrorCount || 0}`);
  const usage = match.usage || {};
  if (usage.totalTokens) {
    const cost = Number(usage.costUsd);
    lines.push(`Model usage: ${usage.totalTokens} tokens${Number.isFinite(cost) && cost > 0 ? ` · $${cost.toFixed(4)}` : ''}`);
  }
  if (match.humanRoles?.length) {
    lines.push(`Validity: casual human-vs-AI game (${match.humanRoles.map(role => role.toUpperCase()).join(', ')} human-controlled) — not a model benchmark.`);
  } else {
    lines.push(match.validBenchmark
      ? 'Validity: clean game — every decision was the model\'s own legal choice.'
      : 'Validity: NOT a clean benchmark game (a fallback, invalid choice, API error, or early stop occurred).');
  }
  return `${sanitizeText(lines.join('\n'))}\n`;
}

function playerLabel(match, role) {
  const agent = match.agents?.[role] || {};
  if (agent.provider === 'human' || agent.model === 'human') return 'Human';
  const model = agent.model || agent.name || match.playerNames?.[role] || role;
  const effort = agent.reasoningEffort ? ` (${agent.reasoningEffort})` : '';
  return `${model}${effort}`;
}

function resultLine(match, names) {
  const result = match.result || {};
  const side = result.winnerRole
    || (result.winner === match.playerNames?.p1 ? 'p1' : result.winner === match.playerNames?.p2 ? 'p2' : null);
  if (side) return `Result: ${names[side]} (${side.toUpperCase()}) wins on turn ${result.turn ?? '?'}${result.reason ? ` · ${result.reason}` : ''}`;
  if (result.done) return `Result: no winner after turn ${result.turn ?? '?'}${result.reason ? ` · ${result.reason}` : ''}`;
  return 'Result: unresolved';
}

// Merge the public spectator protocol with both players' decisions into one
// chronological story. Decisions sort ahead of protocol at the same instant:
// the choice was made before its consequences resolved.
function timelineEvents(match, names) {
  const events = [];
  for (const [index, entry] of (match.protocol || []).entries()) {
    if (entry.role !== 'spectator') continue;
    for (const rawLine of String(entry.chunk || '').split('\n')) {
      const line = rawLine.trim();
      if (!line.startsWith('|') || line.startsWith('|request|')) continue;
      const parts = line.slice(1).split('|');
      if (parts[0] === 'turn') {
        events.push({at: entry.at || '', kind: 1, seq: index, text: `\n[Turn ${parts[1]}]`});
        continue;
      }
      const text = describeProtocolLine(parts);
      if (text) events.push({at: entry.at || '', kind: 1, seq: index, text: `  ${text}`});
    }
  }
  for (const [index, action] of (match.actions || []).entries()) {
    const call = match.modelCalls?.[action.callIndex] || {};
    const label = action.action?.label || action.choice || '';
    const reason = sanitizeText(String(call.reason || '')).replace(/\s+/g, ' ').trim().slice(0, 400);
    const flags = [call.fallback ? 'FALLBACK' : '', call.valid === false ? 'INVALID' : ''].filter(Boolean);
    events.push({
      at: action.at || '',
      kind: 0,
      seq: index,
      text: `» ${action.role.toUpperCase()} (${names[action.role]}) chose: ${label}${flags.length ? ` [${flags.join(', ')}]` : ''}${reason ? `\n    reason: ${reason}` : ''}`,
    });
  }
  events.sort((a, b) => timestamp(a.at) - timestamp(b.at) || a.kind - b.kind || a.seq - b.seq);
  return events.map(event => event.text);
}

function timestamp(value = '') {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}
