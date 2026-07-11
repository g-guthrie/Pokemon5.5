// 'ws' package shim for the browser bundle. match-runner connects to the
// battle hub with `new WebSocket(url)`; here that becomes an in-memory socket
// pair routed straight to the hub living in the same worker — same message
// strings, no network. Deliveries ride microtasks so handshakes (hello,
// backlog, state) always land after the caller has attached its listeners,
// matching real socket timing.
const CONNECTING = 0;
const OPEN = 1;
const CLOSED = 3;

let connectionRouter = null;

// engine-core registers the hub acceptor: (serverSocket, params) => void.
export function setConnectionRouter(fn) {
  connectionRouter = fn;
}

class LocalSocket {
  constructor() {
    this.readyState = CONNECTING;
    this.peer = null;
    this.handlers = new Map();
    this.CONNECTING = CONNECTING;
    this.OPEN = OPEN;
    this.CLOSED = CLOSED;
  }

  on(event, handler) {
    if (!this.handlers.has(event)) this.handlers.set(event, []);
    this.handlers.get(event).push({handler, wrapped: false});
    return this;
  }

  addEventListener(event, handler) {
    if (!this.handlers.has(event)) this.handlers.set(event, []);
    this.handlers.get(event).push({handler, wrapped: true});
    return this;
  }

  emit(event, rawData) {
    for (const {handler, wrapped} of this.handlers.get(event) || []) {
      try {
        // .on() consumers (node-ws style) get the raw string; addEventListener
        // consumers (browser style) get an event object with .data.
        handler(wrapped ? {data: rawData, type: event} : rawData);
      } catch (error) {
        console.warn(`local socket ${event} handler failed:`, error);
      }
    }
  }

  send(text) {
    if (this.readyState !== OPEN) return;
    const peer = this.peer;
    const payload = String(text);
    queueMicrotask(() => {
      if (peer && peer.readyState === OPEN) peer.emit('message', payload);
    });
  }

  close() {
    if (this.readyState === CLOSED) return;
    const peer = this.peer;
    this.readyState = CLOSED;
    queueMicrotask(() => {
      this.emit('close');
      if (peer && peer.readyState !== CLOSED) {
        peer.readyState = CLOSED;
        peer.emit('close');
      }
    });
  }
}

export function createLocalSocketPair() {
  const a = new LocalSocket();
  const b = new LocalSocket();
  a.peer = b;
  b.peer = a;
  return [a, b];
}

export class WebSocket extends LocalSocket {
  static CONNECTING = CONNECTING;
  static OPEN = OPEN;
  static CLOSED = CLOSED;

  constructor(url) {
    super();
    this.url = String(url);
    const parsed = new URL(this.url, 'ws://arena.local');
    const params = {
      role: parsed.searchParams.get('role'),
      battleId: parsed.searchParams.get('battleId') || parsed.searchParams.get('battle'),
      waitForStart: parsed.searchParams.get('wait') === '1',
    };
    const serverSide = new LocalSocket();
    this.peer = serverSide;
    serverSide.peer = this;
    queueMicrotask(() => {
      if (!connectionRouter) {
        this.close();
        throw new Error('No local socket router installed');
      }
      this.readyState = OPEN;
      serverSide.readyState = OPEN;
      this.emit('open');
      connectionRouter(serverSide, params);
    });
  }
}

export default {WebSocket};
