// Model Mind renderer — runs inside the native client frame, which hosts the
// mind columns directly (P1 left of the field, P2 where the battle log used
// to live). The mind is the ten prompt questions the benchmark poses, each
// answered card revealing in schema order, with the final choice landing
// last. Plain script: exposes window.ArenaMind.
(function () {
  // The analysis questions, in the response schema's required order — the v9
  // reasoning arc: read the board, appraise the revealed sets, fence off the
  // unknowns, predict the opponent, name the threats and the stakes, weigh
  // Tera and switches, shortlist candidates, project each line, then check
  // the pick's robustness right before the choice lands. The last three
  // sections are the focused replacement mind (a fainted Pokemon's send-in
  // decision); a call answers either the turn set or the replacement set, so
  // only the relevant cards render.
  var ANALYSIS_SECTIONS = [
    ['gameStateSummary', '\u{1F9ED}', 'What is the state of the board?'],
    ['setArchetypes', '\u{1F9EC}', 'What sets are they running?'],
    ['unknownInformation', '\u{1F311}', 'What is still unknown?'],
    ['opponentLikelyPlan', '\u{1F52E}', 'What is their plan?'],
    ['biggestThreats', '\u{1F3AF}', 'Biggest threats right now?'],
    ['winConditions', '\u{1F3C6}', 'How do we win?'],
    ['loseConditions', '⚠️', 'How could we lose?'],
    ['teraAndSwitchCheck', '⭐', 'Should anyone Tera or switch?'],
    ['candidateChoices', '⚖️', 'Candidate moves compared'],
    ['candidateOutcomes', '\u{1F3AC}', 'How does each line play out?'],
    ['decisionCheck', '✅', 'Why this action?'],
    ['replacementMatchups', '\u{1F501}', 'Who matches up best?'],
    ['replacementRisks', '\u{1F573}\u{FE0F}', 'What could each send-in cost?'],
    ['replacementPlan', '\u{1F9E9}', 'What is the plan after the swap?'],
  ];

  // Reveal pacing (ms). Kept in one place because the parent page mirrors
  // this timing to hold the button press until the reveal lands.
  var REVEAL_STEP = 260;
  var REVEAL_CAP = 2100;
  var REVEAL_TAIL = 420;

  function el(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function compactCount(value) {
    var n = Number(value);
    if (!Number.isFinite(n)) return '?';
    if (n >= 1000000) return (n / 1000000).toFixed(1) + 'M';
    if (n >= 1000) return (n / 1000).toFixed(1) + 'k';
    return String(n);
  }

  function compactCost(value) {
    var n = Number(value);
    if (!Number.isFinite(n) || n <= 0) return '';
    return n >= 0.01 ? '$' + n.toFixed(2) : '$' + n.toFixed(4);
  }

  function usageLine(usage) {
    if (!usage) return '';
    var input = usage.inputTokens ?? usage.input_tokens ?? usage.promptTokens ?? null;
    var output = usage.outputTokens ?? usage.output_tokens ?? usage.completionTokens ?? null;
    var total = usage.totalTokens ?? usage.total_tokens ?? null;
    var cost = usage.totalCostUsd ?? usage.costUsd ?? usage.cost ?? null;
    var parts = [];
    if (input != null || output != null) parts.push(compactCount(input) + '→' + compactCount(output) + ' tok');
    else if (total != null) parts.push(compactCount(total) + ' tok');
    var costText = compactCost(cost);
    if (costText) parts.push(costText);
    return parts.join(' · ');
  }

  function sectionItems(analysis, key) {
    var items = Array.isArray(analysis[key]) ? analysis[key].filter(Boolean) : [];
    return items;
  }

  // Protocol tokens are unintelligible to humans; wherever the model wrote
  // "move 3 2", "switch 4", "foe 1", or "Active 2" in its own analysis or
  // raw answer, show the real move and Pokémon names from the request it was
  // answering. The Model Mind is entirely for human consumption — no move or
  // target ever renders as a number (raw strings live on in tooltips and
  // artifacts). Positional heuristic for doubles: within one choice segment
  // the first move token belongs to active 1, the second to active 2;
  // segments reset at newlines and JSON string boundaries so long raw
  // answers do not drift onto the wrong active slot.
  function translateChoiceTokens(text, names) {
    if (!names || (!names.moves && !names.switches)) return String(text);
    var moves = names.moves || {};
    var switches = names.switches || {};
    var foes = names.foes || {};
    var allies = names.allies || {};

    function targetPhrase(target) {
      if (!target) return '';
      var slot = Math.abs(Number(target));
      if (Number(target) > 0) return foes[slot] ? ' on ' + foes[slot] : ' on the foe';
      return allies[slot] ? ' on ally ' + allies[slot] : ' on an ally';
    }

    function translateSegment(segment) {
      var moveIndex = 0;
      return segment
        .replace(/\bmove\s+(\d)(?:\s+(-?\d))?(\s+terastallize)?\b/gi, function (match, slot, target, tera) {
          moveIndex += 1;
          var active = Math.min(moveIndex, 2);
          var name = moves[active + ':' + slot] || moves['1:' + slot] || moves['2:' + slot];
          if (!name) return match;
          return name + (tera ? ' ⭐Tera' : '') + targetPhrase(target);
        })
        .replace(/\bswitch\s+(\d)\b/gi, function (match, slot) {
          return switches[slot] ? 'switch → ' + switches[slot] : match;
        })
        // Server-built labels and model prose both say "→ foe 1" / "Active 2:";
        // swap in the real names whenever the slot is known.
        .replace(/(→\s*)?\bfoe\s+([12])\b/gi, function (match, arrow, slot) {
          if (!foes[slot]) return match;
          return arrow ? 'on ' + foes[slot] : foes[slot];
        })
        .replace(/\bActive\s+([12])(:\s*)?/gi, function (match, slot, colon) {
          if (!allies[slot]) return match;
          return allies[slot] + (colon ? ': ' : '');
        });
    }

    return String(text).split(/(\n|",\s*")/).map(function (piece, index) {
      return index % 2 === 1 ? piece : translateSegment(piece);
    }).join('');
  }

  // Every answered question shows, in schema order — the column scrolls.
  function visibleSections(analysis) {
    return ANALYSIS_SECTIONS.filter(function (section) {
      return sectionItems(analysis, section[0]).length > 0;
    });
  }

  // How long the staged reveal takes for a decision with this analysis —
  // the parent holds the button press until this has played out.
  function revealDurationMs(data) {
    if (!data) return 0;
    var count = visibleSections(data.analysis || {}).length;
    return Math.min(count * REVEAL_STEP, REVEAL_CAP) + REVEAL_TAIL;
  }

  function renderMind(container, data, options) {
    options = options || {};
    container.replaceChildren();
    // A decision is a new document, not an append. Never preserve a prior
    // decision's scroll position and make the new output look blank.
    container.scrollTop = 0;
    var head = el('div', 'mind-head');
    head.appendChild(el('h3', '', options.title || 'Model mind'));
    var meta = el('span', 'mind-meta');
    var metaBits = [];
    if (data && data.turn != null) metaBits.push('turn ' + data.turn);
    var usage = usageLine(data && data.usage);
    if (usage) metaBits.push(usage);
    meta.textContent = metaBits.join(' · ');
    head.appendChild(meta);
    container.appendChild(head);

    // Human play: the opponent's mind card carries its own peek/hide toggle.
    // The click round-trips through the parent (which owns the server flag).
    if (options.peek) {
      var peekBtn = el('button', 'mind-peek-btn', options.peek.on ? '\u{1F648} Hide its thinking' : '\u{1F441} Peek at its thinking');
      peekBtn.type = 'button';
      peekBtn.addEventListener('click', function () {
        window.parent.postMessage({scope: 'showdown-arena', type: 'sd-mind-peek', role: options.peek.role || ''}, '*');
      });
      container.appendChild(peekBtn);
    }

    if (!data) {
      var idle = el('div', 'thinking');
      idle.appendChild(el('span', options.shimmer ? 'shimmer' : '', options.placeholder || 'Waiting for the first decision…'));
      container.appendChild(idle);
      return;
    }

    var animate = Boolean(options.animate);
    var analysis = data.analysis || {};
    var shown = visibleSections(analysis);
    var renderedOutput = shown.length > 0 || Boolean(data.rawText) || Boolean(data.choiceLabel || data.choice) || Boolean(data.reason);

    var popIndex = 0;
    var pop = function (node) {
      if (!animate) return node;
      node.classList.add('pop-in');
      node.style.animationDelay = Math.min(popIndex * REVEAL_STEP, REVEAL_CAP) + 'ms';
      popIndex += 1;
      return node;
    };

    var sections = el('div', 'mind-sections');
    for (var s = 0; s < shown.length; s++) {
      var key = shown[s][0], icon = shown[s][1], question = shown[s][2];
      var items = sectionItems(analysis, key);
      var section = pop(el('div', 'mind-section'));
      section.dataset.key = key;
      var header = el('h4');
      header.appendChild(el('span', 'section-icon', icon));
      header.appendChild(el('span', '', question));
      section.appendChild(header);
      var list = el('ul');
      for (var i = 0; i < items.length; i++) {
        var item = String(items[i]);
        // Chosen-candidate matching runs on the raw text; the display text
        // gets its protocol tokens translated to real names wherever the
        // model wrote them.
        var chosen = (key === 'candidateChoices' || key === 'replacementMatchups') && data.choice && item.indexOf(data.choice) === 0;
        var display = translateChoiceTokens(item, data.actionNames);
        var li = el('li', '', chosen ? '▸ ' + display : display);
        if (chosen) li.classList.add('chosen-candidate');
        li.title = item;
        list.appendChild(li);
      }
      section.appendChild(list);
      sections.appendChild(section);
    }
    if (sections.children.length) container.appendChild(sections);

    if (data.rawText && String(data.rawText).trim()) {
      var details = document.createElement('details');
      details.className = 'mind-raw mind-raw-answer';
      var summary = document.createElement('summary');
      summary.textContent = 'Raw model answer';
      details.appendChild(summary);
      var pre = document.createElement('pre');
      // Even the raw answer reads in human names — "Flamethrower on
      // Venusaur", never "move 3 1". The byte-exact output stays in the
      // artifact for auditing.
      pre.textContent = translateChoiceTokens(String(data.rawText), data.actionNames);
      details.appendChild(pre);
      container.appendChild(details);
    }

    // A failed call must SAY it failed — even when a fallback choice chip
    // renders below, the error is the real story of this decision.
    if (data.error) {
      container.appendChild(el('div', 'mind-error', 'Model call failed: ' + String(data.error)));
    } else if (!renderedOutput) {
      container.appendChild(el('div', 'thinking', 'This call returned no public analysis or answer.'));
    }

    // The decision lands LAST: the choice card pops only after every shown
    // question has had its beat. Human names (the move/Pokémon pressed), not
    // protocol strings — the raw choice stays in the tooltip and artifact.
    var footer = el('div', 'mind-choice');
    if (data.choiceLabel || data.choice) {
      var chipText = data.choiceLabel || translateChoiceTokens(data.choice, data.actionNames);
      var chip = el('span', 'choice-chip', chipText);
      if (data.choice) chip.title = data.choice;
      footer.appendChild(chip);
    }
    if (data.reason) footer.appendChild(el('span', 'choice-label', translateChoiceTokens(data.reason, data.actionNames)));
    if (data.valid === false) footer.appendChild(el('span', 'invalid', 'invalid choice'));
    if (data.fallback) footer.appendChild(el('span', 'invalid', 'fallback'));
    if (footer.children.length) {
      if (animate) {
        footer.classList.add('pop-in', 'choice-reveal');
        footer.style.animationDelay = (Math.min(shown.length * REVEAL_STEP, REVEAL_CAP) + REVEAL_TAIL / 2) + 'ms';
      }
      container.appendChild(footer);
    }
  }

  window.ArenaMind = {
    renderMind: renderMind,
    revealDurationMs: revealDurationMs,
    REVEAL_STEP: REVEAL_STEP,
    REVEAL_CAP: REVEAL_CAP,
    REVEAL_TAIL: REVEAL_TAIL,
  };
})();
