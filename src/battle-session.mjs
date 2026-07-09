import {createRequire} from 'node:module';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {
  createPlayerObservation,
  createSpectatorObservation,
} from './observation.mjs';
import {getLegalActions, pickAutoChoice} from './legal-choices.mjs';
import {
  activeSlotFromIdent,
  cleanPokemonName,
  createView,
  firstPublicActive,
  sideFromIdent,
  updateViewFromChunk,
} from './protocol-view.mjs';

export {getLegalActions} from './legal-choices.mjs';

const require = createRequire(import.meta.url);
const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const showdownRoot = path.join(rootDir, 'vendor', 'pokemon-showdown');
const {BattleStream, getPlayerStreams, Teams} = require(showdownRoot);

const PLAYER_IDS = ['p1', 'p2'];

export class BattleSession {
  constructor(options = {}) {
    this.formatid = options.formatid || process.env.FORMATID || 'gen9randomdoublesbattle';
    this.seed = options.seed || makeSeed();
    this.teamSeeds = options.teamSeeds || {
      p1: deriveSeed(this.seed, 101),
      p2: deriveSeed(this.seed, 202),
    };
    this.listeners = new Set();
    this.protocol = {omniscient: [], spectator: [], p1: [], p2: []};
    // The raw simulator does not number its requests (rqid is a server-layer
    // concept), but everything downstream — choice events, press animation
    // targeting, replay anchoring — needs an exact request identity. Inject
    // monotonic rqids into every request chunk before it is stored/broadcast.
    this.rqidCounters = {p1: 0, p2: 0};
    this.latestRequest = {p1: null, p2: null};
    this.latestRequestTurn = {p1: 0, p2: 0};
    this.consumedRequestKeys = {p1: new Set(), p2: new Set()};
    this.views = {
      p1: createView('p1'),
      p2: createView('p2'),
      spectator: createView('spectator'),
    };
    this.public = {
      formatid: this.formatid,
      seed: this.seed,
      turn: 0,
      winner: null,
      ended: false,
      active: {p1: null, p2: null},
      activeSlots: {p1: {}, p2: {}},
      teamsize: {p1: null, p2: null},
      lastActions: [],
    };
    this.teams = {
      p1: Teams.generate(this.formatid, {seed: this.teamSeeds.p1}),
      p2: Teams.generate(this.formatid, {seed: this.teamSeeds.p2}),
    };
    this.packedTeams = {
      p1: Teams.pack(this.teams.p1),
      p2: Teams.pack(this.teams.p2),
    };
    this.streams = getPlayerStreams(new BattleStream());
    this.closed = false;

    this.consume('omniscient', this.streams.omniscient);
    this.consume('spectator', this.streams.spectator);
    this.consume('p1', this.streams.p1);
    this.consume('p2', this.streams.p2);
    this.start();
  }

  onEvent(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  emit(event) {
    for (const listener of this.listeners) listener(event);
  }

  start() {
    const start = {
      formatid: this.formatid,
      seed: this.seed,
    };
    const p1 = {name: 'Benchmark P1', team: this.packedTeams.p1};
    const p2 = {name: 'Benchmark P2', team: this.packedTeams.p2};
    void this.streams.omniscient.write(
      `>start ${JSON.stringify(start)}\n` +
      `>player p1 ${JSON.stringify(p1)}\n` +
      `>player p2 ${JSON.stringify(p2)}`
    );
  }

  async consume(role, stream) {
    try {
      for await (const chunk of stream) {
        this.handleChunk(role, chunk);
      }
    } catch (error) {
      this.emit({type: 'error', role, error: String(error?.stack || error)});
    }
  }

  handleChunk(role, chunk) {
    if (!chunk) return;
    if (role === 'p1' || role === 'p2') {
      chunk = this.numberRequests(role, chunk);
    }
    this.protocol[role]?.push(chunk);
    if (this.protocol[role]?.length > 300) this.protocol[role].shift();

    if (role === 'p1' || role === 'p2') {
      const request = extractRequest(chunk);
      if (request) {
        this.latestRequest[role] = request;
        this.latestRequestTurn[role] = this.public.turn;
      }
    }
    if (role === 'omniscient' || role === 'spectator') {
      this.updatePublicState(chunk);
    }
    if (this.views[role]) {
      updateViewFromChunk(this.views[role], chunk);
    }

    this.emit({type: 'protocol', role, chunk});
    for (const player of PLAYER_IDS) {
      if (role === player || role === 'omniscient' || role === 'spectator') {
        this.emit({type: 'state', role: player, state: this.extractState(player)});
      }
    }
    this.emit({type: 'state', role: 'spectator', state: this.extractState('spectator')});
  }

  updatePublicState(chunk) {
    for (const rawLine of chunk.split('\n')) {
      const line = rawLine.trim();
      if (!line.startsWith('|')) continue;
      const parts = line.slice(1).split('|');
      const tag = parts[0];
      if (tag === 'turn') {
        this.public.turn = Number(parts[1]) || this.public.turn;
      } else if (tag === 'teamsize') {
        this.public.teamsize[parts[1]] = Number(parts[2]) || null;
      } else if (tag === 'switch' || tag === 'drag') {
        const side = sideFromIdent(parts[1]);
        if (side) this.setPublicActive(side, parts[1], parsePublicPokemon(parts[1], parts[2], parts[3]));
      } else if (tag === '-damage' || tag === '-heal') {
        const side = sideFromIdent(parts[1]);
        if (side) this.updatePublicActiveCondition(side, parts[1], parts[2] || '');
      } else if (tag === 'faint') {
        const side = sideFromIdent(parts[1]);
        if (side) this.updatePublicActiveCondition(side, parts[1], '0 fnt');
      } else if (tag === 'move') {
        this.addAction({turn: this.public.turn, type: 'move', actor: parts[1], move: parts[2], target: parts[3] || null});
      } else if (tag === 'win') {
        this.public.winner = parts[1] || null;
        this.public.ended = true;
        this.emit({type: 'end', data: {winner: this.public.winner, turn: this.public.turn}});
      }
    }
  }

  setPublicActive(side, ident, mon) {
    const slot = activeSlotFromIdent(ident);
    const activeSlots = this.public.activeSlots[side] || {};
    if (slot) activeSlots[slot] = mon;
    else activeSlots[1] = mon;
    this.public.activeSlots[side] = activeSlots;
    this.public.active[side] = firstPublicActive(activeSlots);
  }

  updatePublicActiveCondition(side, ident, condition) {
    const slot = activeSlotFromIdent(ident);
    const activeSlots = this.public.activeSlots[side] || {};
    const mon = slot ? activeSlots[slot] : Object.values(activeSlots).find(active => active?.ident === ident);
    if (mon) mon.condition = condition;
    if (this.public.active[side]?.ident === ident) this.public.active[side].condition = condition;
  }

  addAction(action) {
    this.public.lastActions.push(action);
    if (this.public.lastActions.length > 20) this.public.lastActions.shift();
  }

  numberRequests(role, chunk) {
    if (!chunk.includes('|request|')) return chunk;
    return chunk
      .split('\n')
      .map(line => {
        if (!line.startsWith('|request|')) return line;
        try {
          const request = JSON.parse(line.slice('|request|'.length));
          if (request && typeof request === 'object' && request.rqid === undefined) {
            request.rqid = ++this.rqidCounters[role];
          }
          return `|request|${JSON.stringify(request)}`;
        } catch {
          return line;
        }
      })
      .join('\n');
  }

  choose(role, choice, rqid = null) {
    if (!PLAYER_IDS.includes(role)) throw new Error(`Invalid player role: ${role}`);
    if (typeof choice !== 'string' || !choice.trim()) throw new Error('Choice must be a non-empty string');
    const request = this.latestRequest[role];
    // Only mark the pending request answered when this choice is actually for
    // it. A delayed submission (paced sends, slow sockets) landing after a
    // newer request arrived must not consume that newer request — doing so
    // deadlocks the match: the sim keeps waiting while every client believes
    // the request was already answered.
    const answersLatest = rqid == null || request?.rqid == null || rqid === request.rqid;
    if (request && answersLatest) this.consumedRequestKeys[role].add(requestKey(role, request, this.latestRequestTurn[role] || 0));
    this.emit({
      type: 'choice',
      role,
      choice: choice.trim(),
      turn: this.public.turn,
      rqid: request?.rqid ?? null,
    });
    void this.streams[role].write(choice.trim());
  }

  autoChoose(role) {
    const state = this.extractState(role);
    const choice = pickAutoChoice(state.legalActions);
    if (!choice) return null;
    this.choose(role, choice.choice);
    return choice;
  }

  extractState(role) {
    const publicState = structuredCloneSafe(this.public);
    if (role === 'spectator') {
      const extracted = this.extractPlayerView(role);
      return {
        role,
        formatid: this.formatid,
        seed: this.seed,
        turn: this.public.turn,
        ended: this.public.ended,
        winner: this.public.winner,
        public: publicState,
        players: {
          p1: publicState.active.p1,
          p2: publicState.active.p2,
        },
        legalActions: [],
        waiting: true,
        extracted,
        observation: extracted,
      };
    }

    const request = this.latestRequest[role];
    const opponent = role === 'p1' ? 'p2' : 'p1';
    const requestTurn = this.latestRequestTurn[role] || 0;
    const publicTurnReady = Boolean(this.public.turn > 0 || request?.teamPreview);
    const requestIsFresh = Boolean(
      request &&
      publicTurnReady &&
      !request.wait &&
      !this.consumedRequestKeys[role].has(requestKey(role, request, requestTurn))
    );
    const freshRequest = requestIsFresh ? request : null;
    const observationRequest = request && publicTurnReady ? request : null;
    const legalActions = freshRequest ? getLegalActions(freshRequest) : [];
    const extracted = this.extractPlayerView(role, observationRequest, legalActions, {
      requestTurn,
      requestIsFresh,
      publicState,
    });
    return {
      role,
      opponent,
      formatid: this.formatid,
      seed: this.seed,
      turn: this.public.turn,
      ended: this.public.ended,
      winner: this.public.winner,
      waiting: Boolean(!freshRequest || freshRequest.wait),
      public: publicState,
      request: freshRequest,
      self: observationRequest?.side ? summarizeSide(observationRequest.side) : null,
      opponentPublic: publicState.active[opponent],
      extracted,
      observation: extracted,
      legalActions,
    };
  }

  extractPlayerView(role, request, legalActions = [], options = {}) {
    const publicState = options.publicState || structuredCloneSafe(this.public);
    if (role !== 'p1' && role !== 'p2') {
      return createSpectatorObservation({
        formatid: this.formatid,
        seed: this.seed,
        publicState,
        view: structuredCloneSafe(this.views.spectator),
      });
    }

    const view = structuredCloneSafe(this.views[role]);
    const selfTeam = this.getFullTeamForRole(role, request);
    return createPlayerObservation({
      role,
      opponent: role === 'p1' ? 'p2' : 'p1',
      formatid: this.formatid,
      seed: this.seed,
      publicState,
      request,
      requestTurn: options.requestTurn || 0,
      requestIsFresh: options.requestIsFresh ?? Boolean(request),
      legalActions,
      selfTeam,
      view,
    });
  }

  getFullTeamForRole(role, request) {
    const requestPokemon = new Map();
    for (const [index, mon] of (request?.side?.pokemon || []).entries()) {
      requestPokemon.set(cleanPokemonName(mon.ident || mon.details), {mon, index});
    }
    return (this.teams[role] || []).map((set, index) => {
      const name = set.name || set.species || `Slot ${index + 1}`;
      const liveEntry = requestPokemon.get(cleanPokemonName(name)) || requestPokemon.get(cleanPokemonName(set.species));
      const live = liveEntry?.mon;
      const activeSlot = live?.active && Number(liveEntry?.index) < Number(request?.active?.length || 1) ? liveEntry.index + 1 : null;
      return {
        slot: index + 1,
        activeSlot,
        name,
        species: set.species,
        level: set.level || null,
        gender: set.gender || '',
        shiny: Boolean(set.shiny),
        item: set.item || '',
        ability: set.ability || '',
        nature: set.nature || 'Serious',
        evs: set.evs || null,
        ivs: set.ivs || null,
        moves: set.moves || [],
        teraType: set.teraType || '',
        active: Boolean(live?.active),
        condition: live?.condition || '',
        stats: live?.stats || null,
        heldItem: live?.item ?? set.item ?? '',
        requestAbility: live?.ability || live?.baseAbility || '',
        terastallized: live?.terastallized || '',
      };
    });
  }
}

function extractRequest(chunk) {
  for (const line of chunk.split('\n')) {
    if (!line.startsWith('|request|')) continue;
    try {
      return JSON.parse(line.slice('|request|'.length));
    } catch {
      return null;
    }
  }
  return null;
}

function requestKey(role, request, requestTurn) {
  const type = request?.teamPreview ? 'team-preview' : request?.forceSwitch ? 'force-switch' : request?.active ? 'active' : 'other';
  const rqid = request?.rqid ?? 'no-rqid';
  return `${role}:${requestTurn}:${rqid}:${type}:${requestFingerprint(request)}`;
}

function requestFingerprint(request) {
  return JSON.stringify({
    wait: Boolean(request?.wait),
    teamPreview: Boolean(request?.teamPreview),
    forceSwitch: request?.forceSwitch || null,
    active: (request?.active || []).map(active => ({
      trapped: Boolean(active?.trapped),
      canTerastallize: Boolean(active?.canTerastallize),
      moves: (active?.moves || []).map(move => [move.id, move.pp, move.disabled ? 1 : 0]),
    })),
    side: (request?.side?.pokemon || []).map(mon => [mon.ident, mon.condition, Boolean(mon.active)]),
  });
}

function summarizeSide(side) {
  return {
    name: side.name,
    id: side.id,
    pokemon: (side.pokemon || []).map((mon, index) => ({
      ident: mon.ident,
      name: cleanPokemonName(mon.ident || mon.details),
      details: mon.details,
      condition: mon.condition,
      active: Boolean(mon.active),
      activeSlot: mon.active ? index + 1 : null,
      stats: mon.stats || null,
      moves: mon.moves || [],
      ability: mon.ability || mon.baseAbility || null,
      item: mon.item || null,
      teraType: mon.teraType || null,
      terastallized: mon.terastallized || '',
    })),
  };
}

function parsePublicPokemon(ident, details, condition) {
  return {
    ident,
    name: cleanPokemonName(ident),
    details,
    condition,
  };
}

function makeSeed() {
  return [0, 1, 2, 3].map(() => Math.floor(Math.random() * 0x100000000));
}

function deriveSeed(seed, salt) {
  return seed.map((value, index) => (Number(value) + salt + index * 7919) >>> 0);
}

function structuredCloneSafe(value) {
  return JSON.parse(JSON.stringify(value));
}
