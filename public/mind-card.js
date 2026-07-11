// Model Mind renderer — runs inside the native client frame, which hosts the
// mind columns directly (P1 left of the field, P2 where the battle log used
// to live). The mind is the ten prompt questions the benchmark poses, each
// answered card revealing in schema order, with the final choice landing
// last. Plain script: exposes window.ArenaMind.
(function () {
  // The ten analysis questions, in the response schema's required order.
  var ANALYSIS_SECTIONS = [
    ['gameStateSummary', '\u{1F9ED}', 'What is the state of the game?'],
    ['winConditions', '\u{1F3C6}', 'How do we win?'],
    ['loseConditions', '⚠️', 'How could we lose?'],
    ['setupLines', '\u{1F4C8}', 'What setups are promising?'],
    ['sweepPlans', '\u{1F4A5}', 'What could sweep?'],
    ['safeSwitches', '\u{1F501}', 'Safe pivots?'],
    ['opponentLikelyPlan', '\u{1F52E}', 'What is their plan?'],
    ['biggestThreats', '\u{1F3AF}', 'Biggest threats right now?'],
    ['riskAssessment', '\u{1F3B2}', 'What is the risk?'],
    ['candidateChoices', '⚖️', 'Candidate moves compared'],
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
  // "move 3 2" or "switch 4" in its own analysis, show the real move and
  // Pokémon names from the request it was answering. Positional heuristic
  // for doubles: the first move token in a line belongs to active 1, the
  // second to active 2.
  function translateChoiceTokens(text, names) {
    if (!names || (!names.moves && !names.switches)) return String(text);
    var moves = names.moves || {};
    var switches = names.switches || {};
    var moveIndex = 0;
    return String(text)
      .replace(/\bmove\s+(\d)(?:\s+(-?\d))?(\s+terastallize)?\b/gi, function (match, slot, target, tera) {
        moveIndex += 1;
        var active = Math.min(moveIndex, 2);
        var name = moves[active + ':' + slot] || moves['1:' + slot] || moves['2:' + slot];
        if (!name) return match;
        var suffix = '';
        if (target) suffix = Number(target) > 0 ? ' → foe ' + target : ' → ally';
        return name + (tera ? ' ⭐Tera' : '') + suffix;
      })
      .replace(/\bswitch\s+(\d)\b/gi, function (match, slot) {
        return switches[slot] ? 'switch → ' + switches[slot] : match;
      });
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
        var chosen = key === 'candidateChoices' && data.choice && item.indexOf(data.choice) === 0;
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

    if (data.rawText) {
      var details = document.createElement('details');
      details.className = 'mind-raw mind-raw-answer';
      var summary = document.createElement('summary');
      summary.textContent = 'Raw model answer';
      details.appendChild(summary);
      var pre = document.createElement('pre');
      pre.textContent = String(data.rawText);
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
    if (data.reason) footer.appendChild(el('span', 'choice-label', data.reason));
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
