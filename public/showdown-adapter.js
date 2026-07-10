(function () {
  window.__benchmarkDebug = [];
  window.addEventListener('error', function (event) {
    debug('error:' + event.message);
  });
  function debug(message) {
    window.__benchmarkDebug.push(String(message));
    if (window.__benchmarkDebug.length > 40) window.__benchmarkDebug.shift();
    if (document.body) document.body.setAttribute('data-benchmark-debug', window.__benchmarkDebug.join(' || '));
    console.log('[benchmark-frame]', message);
  }

  var params = new URLSearchParams(location.search);
  var roleParam = params.get('role');
  var role = roleParam === 'p2' ? 'p2' : roleParam === 'spectator' ? 'spectator' : 'p1';
  var replayMode = params.get('mode') === 'replay';
  // A controls-only frame shows just this player's native control bar (the
  // real Showdown move/switch buttons). The battle field is hidden via CSS, so
  // there is no field animation to wait for: render controls immediately and
  // let the press animation press the real native buttons.
  var controlsOnly = params.get('controls') === '1';
  // The arena renders its own decision deck over the controls region; the
  // native controls stay in the DOM (presses still land on them to keep the
  // client's request state exact) but are visually hidden.
  var hideControls = params.get('hidecontrols') === '1';
  // The official client's dark mode: rules are scoped under html.dark.
  if (params.get('theme') === 'dark') document.documentElement.classList.add('dark');
  // Parent-driven presses: the arena sequences press animations globally
  // (Player 1 goes as soon as it answers; an earlier Player 2 answer queues
  // until Player 1 submits). In this mode the frame does not self-animate on
  // its own websocket choice events; it freezes (buffers protocol) until the
  // parent dispatches sd-choice, so the press always lands on the exact
  // buttons the model chose from.
  var parentDriven = params.get('drive') === 'parent';
  var battleId = params.get('battleId') || '';
  var protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  var room = null;
  var socket = null;
  var prefs = {
    mute: true,
    noanim: false,
    rightpanelbattles: false,
    autotimer: false,
    ignoreopp: false,
    ignorenicks: false
  };

  // --- model interaction state ---
  var animating = false;            // a model click animation is running
  var suppressSend = replayMode;    // drop choice sends (always in replay; during animations in live)
  var pendingChunks = [];           // protocol buffered while animating
  var heldRequestChunks = [];       // request chunks held until battle animations catch up
  var latestFedTurn = 0;
  var awaitingParent = 0;           // choices announced but not yet dispatched by the parent
  var pendingAnimations = 0;        // press animations enqueued on the chain but not finished
  var announcedPresses = [];        // press keys announced by our websocket, awaiting parent dispatch
  var earlyDispatches = [];         // press keys the parent dispatched before our websocket announced them

  function pressKey(choice, rqid) {
    return String(rqid === null || rqid === undefined ? 'x' : rqid) + '|' + String(choice || '');
  }

  function recountAwaitingParent() {
    awaitingParent = announcedPresses.length;
    if (awaitingParent === 0 && !animating) flushPending();
  }

  window.Storage = {
    prefs: function (prop, value) {
      if (value !== undefined) prefs[prop] = value;
      return prefs[prop];
    },
    whenPrefsLoaded: function (callback) { if (callback) callback(window.app); },
    whenTeamsLoaded: function (callback) { if (callback) callback(window.app); },
    whenAppLoaded: function (callback) { if (callback) callback(window.app); }
  };

  window.app = {
    focused: true,
    rooms: {},
    roomList: [],
    sideRoomList: [],
    curRoom: null,
    curSideRoom: null,
    user: new Backbone.Model({
      name: role === 'p1' ? 'Benchmark P1' : role === 'p2' ? 'Benchmark P2' : 'Arena Spectator',
      userid: role === 'p1' ? 'benchmarkp1' : role === 'p2' ? 'benchmarkp2' : 'arenaspectator',
      named: true
    }),
    topbar: { updateTabbar: function () {} },
    dismissPopups: function () { return null; },
    closePopup: function () {},
    roomTitleChanged: function () {},
    addPopup: function () {},
    addPopupMessage: function (message) { console.warn(message); },
    receive: function () {},
    send: function (data) {
      if (suppressSend) return;
      var choice = normalizeChoice(data);
      if (!choice) return;
      send({type: 'choose', choice: choice});
    }
  };

  function normalizeChoice(data) {
    if (!data) return '';
    var text = String(data);
    if (text.includes('|/')) text = text.slice(text.indexOf('|/') + 1);
    if (text.charAt(0) === '/') text = text.slice(1);
    var pipeIndex = text.lastIndexOf('|');
    if (pipeIndex >= 0) text = text.slice(0, pipeIndex);
    if (text.startsWith('choose ')) text = text.slice(7);
    if (text === 'undo' || text.startsWith('timer ') || text === 'joinbattle' || text === 'leavebattle') return '';
    return text.trim();
  }

  function send(payload) {
    if (socket && socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(payload));
  }

  function notifyParent(payload) {
    try {
      window.parent.postMessage(Object.assign({scope: 'showdown-arena', role: role}, payload), '*');
    } catch (error) {
      debug('postMessage failed ' + error.message);
    }
  }

  function connect() {
    debug('connecting ' + role);
    var query = '/ws?role=' + encodeURIComponent(role);
    if (battleId) query += '&battleId=' + encodeURIComponent(battleId);
    socket = new WebSocket(protocol + '//' + location.host + query);
    socket.addEventListener('open', function () { debug('socket open'); });
    socket.addEventListener('message', function (event) {
      var message = JSON.parse(event.data);
      if (message.type === 'protocol') applyProtocol(message.chunk, false);
      if (message.type === 'choice' && message.role === role) {
        if (parentDriven) {
          var key = pressKey(message.choice, message.rqid);
          var earlyIndex = earlyDispatches.indexOf(key);
          if (earlyIndex >= 0) {
            // The parent's socket beat ours: this press was already dispatched
            // and animated. Nothing to wait for.
            earlyDispatches.splice(earlyIndex, 1);
          } else {
            // Freeze until the parent dispatches this press, so the buttons
            // the model chose from stay on screen however long the queue takes.
            announcedPresses.push(key);
            recountAwaitingParent();
            // Recovery only: must exceed the model decision timeout (default
            // 240s) — a queued press legitimately waits for the other model
            // to finish thinking before it can be shown.
            setTimeout(function () {
              var staleIndex = announcedPresses.indexOf(key);
              if (staleIndex >= 0) {
                announcedPresses.splice(staleIndex, 1);
                debug('parent press dispatch timed out; unfreezing');
                recountAwaitingParent();
              }
            }, 300000);
          }
        } else {
          void animateChoice(message.choice, message.rqid);
        }
      }
      if (message.type === 'reset') location.reload();
    });
    socket.addEventListener('close', function () {
      setTimeout(connect, 800);
    });
  }

  // --- protocol application -------------------------------------------------
  // Request chunks render the choice buttons, but the official client only
  // shows them once the battle animation queue is at its end. Holding request
  // chunks until the queue catches up lets move animations actually play
  // instead of snapping to the latest state on every turn.

  function applyProtocol(chunk, instant) {
    if (!chunk) return;
    if ((animating || awaitingParent > 0) && !instant) {
      pendingChunks.push(chunk);
      return;
    }
    feedChunk(chunk, instant);
  }

  function feedChunk(chunk, instant) {
    if (!room) {
      debug('protocol skipped');
      return;
    }
    trackFedTurn(chunk);
    if (chunk.includes('|request|')) {
      // Tell the parent whether this player now has an actionable request, so
      // the arena can alternate which player's native controls are on screen.
      notifyParent({type: 'sd-request', actionable: !chunk.includes('"wait":true')});
    }
    if (controlsOnly) {
      // No visible field: skip the field animation queue entirely so the
      // native control bar always reflects the latest request right away.
      receiveChunk(chunk, true);
      return;
    }
    if (!instant && chunk.includes('|request|') && !battleAtQueueEnd()) {
      heldRequestChunks.push(chunk);
      return;
    }
    receiveChunk(chunk, instant);
  }

  function receiveChunk(chunk, instant) {
    try {
      room.receive(chunk);
    } catch (error) {
      // The official client can throw on lines like |callback| when the
      // battle display lags behind the live state; recover by seeking.
      debug('receive error ' + String(error.stack || error.message).split('\n').slice(0, 4).join(' <- '));
    }
    try {
      if (instant || chunk.includes('|request|') || shouldCatchUp()) {
        room.battle.seekTurn(Infinity);
      }
      room.updateLayout();
      room.updateControls();
    } catch (error) {
      debug('post-receive error ' + error.message);
    }
  }

  function trackFedTurn(chunk) {
    for (var i = 0; i < chunk.length;) {
      var next = chunk.indexOf('|turn|', i);
      if (next < 0) break;
      var end = chunk.indexOf('\n', next);
      var turn = Number(chunk.slice(next + 6, end < 0 ? undefined : end));
      if (Number.isFinite(turn)) latestFedTurn = Math.max(latestFedTurn, turn);
      i = next + 6;
    }
  }

  function shouldCatchUp() {
    return room && room.battle && room.battle.turn < latestFedTurn - 1;
  }

  function battleAtQueueEnd() {
    return Boolean(room && room.battle && room.battle.atQueueEnd);
  }

  function flushHeldRequests(force) {
    while (heldRequestChunks.length && (force || battleAtQueueEnd())) {
      receiveChunk(heldRequestChunks.shift(), false);
    }
  }

  function flushPending() {
    var queue = pendingChunks.splice(0);
    for (var i = 0; i < queue.length; i++) feedChunk(queue[i], false);
  }

  // Bring exactly the request this choice answered onto the controls, without
  // applying anything past it (later chunks may already carry this choice's
  // results and would clear or replace the buttons before the press). The
  // parent's socket can outrun ours, so if the request has not even arrived
  // yet, wait for it instead of pressing stale buttons.
  async function drainForChoice(rqid) {
    if (rqid === null || rqid === undefined) {
      flushPending();
      flushHeldRequests(true);
      return;
    }
    var marker = '"rqid":' + rqid;
    var deadline = Date.now() + 5000;
    for (;;) {
      var chunk;
      if (pendingChunks.some(function (item) { return item.includes(marker); })) {
        while (pendingChunks.length) {
          chunk = pendingChunks.shift();
          feedChunk(chunk, false);
          if (chunk.includes(marker)) break;
        }
      }
      if (heldRequestChunks.some(function (item) { return item.includes(marker); })) {
        while (heldRequestChunks.length) {
          chunk = heldRequestChunks.shift();
          receiveChunk(chunk, false);
          if (chunk.includes(marker)) break;
        }
        return;
      }
      var applied = Boolean(room && room.request && Number(room.request.rqid) === Number(rqid));
      if (applied || Date.now() >= deadline) {
        if (!applied) {
          debug('press rqid ' + rqid + ' not found; room shows rqid ' + (room && room.request ? room.request.rqid : 'none'));
        }
        try {
          // Reset any half-finished choice UI (e.g. a stale target sub-menu)
          // so the controls re-render fresh from the request.
          if (room.clearChoice) room.clearChoice();
          room.battle.seekTurn(Infinity);
          room.updateControls();
        } catch (error) {
          debug('controls refresh error ' + error.message);
        }
        return;
      }
      await wait(80);
    }
  }

  setInterval(function () {
    // Never auto-apply held requests while presses are queued or frozen: a
    // future request would replace the buttons a queued press must land on.
    if (!animating && awaitingParent === 0 && pendingAnimations === 0) flushHeldRequests(false);
  }, 250);

  // The official client removes a fainted Pokemon's nameplate via a fade-out
  // whose completion callback is its only removal path; interruptions can
  // strand a ghost nameplate over the replacement. Detect the orphan (more
  // statbars than living active Pokemon while the display is settled) and
  // rebuild the scene at the current turn.
  setInterval(function () {
    try {
      var battle = room && room.battle;
      if (!battle || !battle.atQueueEnd || animating) return;
      var alive = 0;
      for (var s = 0; s < (battle.sides || []).length; s++) {
        var active = battle.sides[s].active || [];
        for (var i = 0; i < active.length; i++) {
          if (active[i] && active[i].hp > 0) alive += 1;
        }
      }
      var bars = battle.scene && battle.scene.$stat ? battle.scene.$stat.find('.statbar').length : 0;
      if (bars > alive) {
        debug('sweeping ' + (bars - alive) + ' orphaned statbar(s)');
        battle.seekTurn(battle.turn, true);
      }
    } catch (error) {
      debug('statbar sweep error ' + error.message);
    }
  }, 3000);

  // Deck mode: report where the controls region actually begins (measured,
  // not assumed) so the parent's decision deck starts exactly at the seam
  // and never covers the battle field. Also hard-pin the frame's scroll:
  // any internal scroll shifts the client under the parent's deck.
  var lastReportedTop = 0;
  if (hideControls) {
    setInterval(function () {
      if (document.documentElement.scrollTop || document.body.scrollTop) {
        document.documentElement.scrollTop = 0;
        document.body.scrollTop = 0;
      }
      // The deck starts exactly where the battle field ends — measured, so
      // the seam is real, not assumed.
      var battle = document.querySelector('.battle');
      var controls = document.querySelector('.battle-controls');
      var edge = battle ? battle.getBoundingClientRect().bottom
        : controls ? controls.getBoundingClientRect().top : 0;
      var top = Math.round(edge);
      if (top > 100 && top < 700 && Math.abs(top - lastReportedTop) > 2) {
        lastReportedTop = top;
        notifyParent({type: 'sd-controls-top', top: top});
      }
    }, 250);
  }

  // Every frame reports its rendered native-control height so the parent can
  // size the alternating controls overlay to cover exactly the controls area.
  var lastReportedHeight = 0;
  setInterval(function () {
    var controls = document.querySelector('.battle-controls');
    if (!controls) return;
    // Measure the real content extent: Showdown's menus float and are partly
    // absolutely positioned, so the box itself can collapse. Take the lowest
    // bottom edge among the actual control elements instead.
    var top = controls.getBoundingClientRect().top;
    var maxBottom = top;
    var nodes = controls.querySelectorAll('button, .movemenu, .switchmenu, .movecontrols, .switchcontrols, p, label');
    for (var i = 0; i < nodes.length; i++) {
      var bottom = nodes[i].getBoundingClientRect().bottom;
      if (bottom > maxBottom) maxBottom = bottom;
    }
    var height = Math.ceil(maxBottom - top) + 14;
    if (height > 14 && Math.abs(height - lastReportedHeight) > 4) {
      lastReportedHeight = height;
      notifyParent({type: 'sd-controls-height', height: height});
    }
  }, 200);

  // --- model click animation ------------------------------------------------

  var cursorEl = null;

  function ensureAnimationStyles() {
    if (document.getElementById('model-cursor-style')) return;
    var style = document.createElement('style');
    style.id = 'model-cursor-style';
    style.textContent = [
      '#model-cursor{position:fixed;left:0;top:0;z-index:9999;pointer-events:none;opacity:0;',
      'transition:transform 340ms cubic-bezier(.25,.85,.3,1),opacity 220ms ease;will-change:transform;}',
      '#model-cursor svg{filter:drop-shadow(0 2px 4px rgba(0,0,0,.45));}',
      '.model-pressing{transform:scale(.94);filter:brightness(1.25);outline:2px solid ' + accentColor() + ' !important;outline-offset:1px;}',
      '.model-click-ripple{position:fixed;z-index:9998;pointer-events:none;width:14px;height:14px;border-radius:50%;',
      'border:2px solid ' + accentColor() + ';opacity:.95;transform:translate(-50%,-50%) scale(.6);',
      'animation:model-ripple 520ms ease-out forwards;}',
      '@keyframes model-ripple{to{transform:translate(-50%,-50%) scale(3.2);opacity:0;}}'
    ].join('');
    document.head.appendChild(style);
  }

  function accentColor() {
    // Player 1 is Red, Player 2 is Blue — brightened for the dark client.
    return role === 'p1' ? '#ff6b4a' : '#5fa8e8';
  }

  function ensureCursor() {
    ensureAnimationStyles();
    if (cursorEl) return cursorEl;
    cursorEl = document.createElement('div');
    cursorEl.id = 'model-cursor';
    cursorEl.innerHTML =
      '<svg width="22" height="30" viewBox="0 0 22 30" xmlns="http://www.w3.org/2000/svg">' +
      '<path d="M2 1 L2 24 L8 18.5 L12 28 L16 26.2 L12.2 17 L20 16.5 Z" fill="#fff" stroke="#1f2937" stroke-width="1.6"/></svg>';
    cursorEl.style.transform = 'translate(' + (window.innerWidth / 2) + 'px,' + (window.innerHeight - 60) + 'px)';
    document.body.appendChild(cursorEl);
    return cursorEl;
  }

  function moveCursorTo(x, y) {
    var cursor = ensureCursor();
    cursor.style.opacity = '1';
    cursor.style.transform = 'translate(' + x + 'px,' + y + 'px)';
    return wait(360);
  }

  function hideCursor() {
    if (cursorEl) cursorEl.style.opacity = '0';
  }

  function ripple(x, y) {
    var dot = document.createElement('div');
    dot.className = 'model-click-ripple';
    dot.style.left = x + 'px';
    dot.style.top = y + 'px';
    document.body.appendChild(dot);
    setTimeout(function () { dot.remove(); }, 600);
  }

  function wait(ms) {
    return new Promise(function (resolve) { setTimeout(resolve, ms); });
  }

  async function pointAndClick(el) {
    el.scrollIntoView({block: 'nearest'});
    var rect = el.getBoundingClientRect();
    var x = rect.left + Math.min(rect.width * 0.5, 120);
    var y = rect.top + rect.height * 0.55;
    await moveCursorTo(x, y);
    el.classList.add('model-pressing');
    ripple(x, y);
    await wait(170);
    el.classList.remove('model-pressing');
    el.dispatchEvent(new MouseEvent('click', {bubbles: true, cancelable: true, view: window}));
    await wait(120);
  }

  function controlsRoot() {
    return (room && room.$el && room.$el.find('.battle-controls')[0]) || document;
  }

  function findControl(selector) {
    return controlsRoot().querySelector(selector);
  }

  // The official client renders choice buttons only once the battle display
  // catches up to the live state. Seeks can stall behind heavy animation, so
  // if the button does not appear quickly, force-rebuild the display from the
  // step queue with animations off (the replay scrubber's fast path).
  async function waitForControl(selector, timeoutMs) {
    var deadline = Date.now() + (timeoutMs || 6000);
    var rescued = false;
    for (;;) {
      var control = findControl(selector);
      if (control) return control;
      if (Date.now() >= deadline) return null;
      if (!rescued && deadline - Date.now() < (timeoutMs || 6000) - 1400) {
        rescued = true;
        try {
          room.battle.seekTurn(Infinity, true);
          room.updateLayout();
          room.updateControls();
          debug('force-rebuilt display waiting for ' + selector);
        } catch (error) {
          debug('force rebuild error ' + error.message);
        }
      }
      await wait(90);
    }
  }

  function parseChoiceSteps(choice) {
    return String(choice || '').split(',').map(function (part) {
      var tokens = part.trim().split(/\s+/).filter(Boolean);
      var kind = tokens[0] || '';
      if (kind === 'move') {
        var step = {kind: 'move', slot: null, target: null, tera: false};
        for (var i = 1; i < tokens.length; i++) {
          var token = tokens[i];
          if (/^-?\d+$/.test(token)) {
            if (step.slot === null) step.slot = Number(token);
            else step.target = Number(token);
          } else if (token === 'terastallize') {
            step.tera = true;
          }
        }
        return step;
      }
      if (kind === 'switch') return {kind: 'switch', slot: Number(tokens[1])};
      if (kind === 'team') return {kind: 'team', order: tokens.slice(1).join('').replace(/\D/g, '')};
      if (kind === 'shift') return {kind: 'shift'};
      return {kind: 'pass'};
    });
  }

  async function animateStep(step) {
    if (step.kind === 'move') {
      if (step.slot === null) return false;
      var moveButton = await waitForControl('button[name=chooseMove][value="' + step.slot + '"]', 6000);
      if (!moveButton) return false;
      if (step.tera) {
        var tera = findControl('input[name=terastallize]');
        if (tera && !tera.checked) {
          await pointAndClick(tera);
          moveButton = findControl('button[name=chooseMove][value="' + step.slot + '"]') || moveButton;
        }
      }
      await pointAndClick(moveButton);
      if (step.target !== null) {
        var targetButton = await waitForControl('button[name=chooseMoveTarget][value="' + step.target + '"]', 1200);
        if (targetButton) await pointAndClick(targetButton);
      }
      await wait(220);
      return true;
    }
    if (step.kind === 'switch') {
      if (!Number.isFinite(step.slot)) return false;
      var switchButton = await waitForControl(
        'button[name=chooseSwitch][value="' + (step.slot - 1) + '"], button[name=chooseSwitchTarget][value="' + (step.slot - 1) + '"]',
        6000
      );
      if (!switchButton) return false;
      await pointAndClick(switchButton);
      await wait(220);
      return true;
    }
    if (step.kind === 'team') {
      for (var i = 0; i < step.order.length; i++) {
        var previewButton = findControl('button[name=chooseTeamPreview][value="' + (Number(step.order[i]) - 1) + '"]');
        if (!previewButton) return i > 0;
        await pointAndClick(previewButton);
        await wait(160);
      }
      return true;
    }
    if (step.kind === 'shift') {
      var shiftButton = findControl('button[name=chooseShift]');
      if (!shiftButton) return false;
      await pointAndClick(shiftButton);
      await wait(220);
      return true;
    }
    await wait(160);
    return true;
  }

  var animationChain = Promise.resolve();

  function animateChoice(choice, rqid, instant) {
    pendingAnimations += 1;
    animationChain = animationChain
      .then(function () {
        return runChoiceAnimation(choice, rqid, instant);
      })
      .then(
        function () { pendingAnimations -= 1; },
        function () { pendingAnimations -= 1; }
      );
    return animationChain;
  }

  async function runChoiceAnimation(choice, rqid, instant) {
    if (!room) {
      notifyParent({type: 'sd-choice-done', choice: choice, skipped: true});
      return;
    }
    animating = true;
    suppressSend = true;
    try {
      // Buttons must be visible: bring the request this choice answered onto
      // the controls (and nothing past it).
      await drainForChoice(rqid);
      if (room.battle && room.battle.ended) {
        // The display already reached the end of the battle: there are no
        // buttons left to press for this late choice.
        instant = true;
      }
      if (!instant) {
        var clearButton = findControl('button[name=clearChoice]');
        if (clearButton) {
          clearButton.dispatchEvent(new MouseEvent('click', {bubbles: true, cancelable: true, view: window}));
          await wait(120);
        }
        var steps = parseChoiceSteps(choice);
        for (var i = 0; i < steps.length; i++) {
          var ok = await animateStep(steps[i]);
          if (!ok) {
            debug('animation step missing button: ' + JSON.stringify(steps[i]) +
              ' rqid=' + rqid + ' roomRqid=' + (room.request ? room.request.rqid : 'none') +
              ' controls="' + String(controlsRoot().textContent || '').replace(/\s+/g, ' ').slice(0, 160) + '"');
            break;
          }
        }
        await wait(280);
      }
    } catch (error) {
      debug('animation error ' + error.message);
    }
    hideCursor();
    animating = false;
    suppressSend = replayMode;
    // Stay frozen if another press is still queued or announced; its buttons
    // must not be replaced by newer protocol in the meantime.
    if (awaitingParent === 0 && pendingAnimations <= 1) flushPending();
    notifyParent({type: 'sd-choice-done', choice: choice});
  }

  // --- replay message channel -------------------------------------------------

  window.addEventListener('message', function (event) {
    var message = event.data;
    if (!message || message.scope !== 'showdown-arena') return;
    if (message.type === 'sd-protocol') applyProtocol(message.chunk, Boolean(message.instant));
    if (message.type === 'sd-sound' && !controlsOnly) {
      // Only the battle frame may make noise; controls-only frames process
      // the same protocol internally and would double every cry.
      BattleSound.setMute(Boolean(message.muted));
    }
    if (message.type === 'sd-choice') {
      if (parentDriven) {
        var key = pressKey(message.choice, message.rqid);
        var announcedIndex = announcedPresses.indexOf(key);
        if (announcedIndex >= 0) {
          announcedPresses.splice(announcedIndex, 1);
        } else {
          // Parent dispatched before our own websocket announced this press.
          earlyDispatches.push(key);
          if (earlyDispatches.length > 8) earlyDispatches.shift();
        }
        awaitingParent = announcedPresses.length;
      }
      void animateChoice(message.choice, message.rqid, Boolean(message.instant));
    }
    if (message.type === 'sd-reset') location.reload();
  });

  function boot() {
    debug('boot ' + role + (replayMode ? ' (replay)' : '') + (controlsOnly ? ' (controls)' : ''));
    if (controlsOnly && document.body) document.body.dataset.viewMode = 'controls';
    if (hideControls && document.body) {
      document.body.dataset.hideControls = '1';
      document.documentElement.dataset.hideControlsRoot = '1';
    }
    BattleSound.setMute(true);
    room = new BattleRoom({
      id: 'battle-localbenchmark',
      el: $('#battle-root'),
      nojoin: true,
      title: role.toUpperCase()
    });
    app.rooms[room.id] = room;
    app.curRoom = room;
    room.show('full');
    room.battle.messageShownTime = 1;
    room.battle.play();
    debug('room ready');
    // Announce readiness in every mode: the parent must not dispatch press
    // animations at a frame that is still booting (the message would be lost).
    notifyParent({type: 'sd-ready'});
    if (!replayMode) connect();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
