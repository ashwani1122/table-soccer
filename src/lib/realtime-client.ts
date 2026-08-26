type Listener = (payload: never) => void;

type Envelope = {
  event: string;
  payload?: unknown;
};

const CLIENT_ID_KEY = "flickxi:client-id";
const MAX_PENDING_EVENTS = 24;
const MAX_RECONNECT_DELAY = 3_000;

function realtimeSocketUrl() {
  const configured = process.env.NEXT_PUBLIC_REALTIME_URL?.trim();
  if (!configured) {
    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    return `${protocol}//${window.location.host}/api/ws`;
  }

  const url = new URL(configured);
  if (url.protocol === "https:") url.protocol = "wss:";
  if (url.protocol === "http:") url.protocol = "ws:";
  if (url.pathname === "/" || url.pathname === "") url.pathname = "/ws";
  return url.toString();
}

function getClientId() {
  const existing = window.sessionStorage.getItem(CLIENT_ID_KEY);
  if (existing) return existing;
  const clientId = window.crypto.randomUUID();
  window.sessionStorage.setItem(CLIENT_ID_KEY, clientId);
  return clientId;
}

export class RealtimeClient {
  readonly clientId = getClientId();
  private socket: WebSocket | null = null;
  private listeners = new Map<string, Set<Listener>>();
  private pending: Envelope[] = [];
  private reconnectTimer: number | null = null;
  private reconnectAttempt = 0;
  private manuallyClosed = false;
  private connected = false;
  private hasConnected = false;

  on<T>(event: string, listener: (payload: T) => void) {
    const listeners = this.listeners.get(event) ?? new Set<Listener>();
    listeners.add(listener as Listener);
    this.listeners.set(event, listeners);
    return this;
  }

  off<T>(event: string, listener: (payload: T) => void) {
    const listeners = this.listeners.get(event);
    listeners?.delete(listener as Listener);
    if (listeners?.size === 0) this.listeners.delete(event);
    return this;
  }

  emit(event: string, payload?: unknown) {
    const envelope = { event, payload };
    if (this.socket?.readyState === WebSocket.OPEN) {
      this.send(envelope);
    } else if (this.hasConnected && !this.manuallyClosed) {
      this.pending.push(envelope);
      if (this.pending.length > MAX_PENDING_EVENTS) this.pending.shift();
    }
    return this;
  }

  connect(resumePrevious = false) {
    if (this.socket && this.socket.readyState < WebSocket.CLOSING) return this;

    this.manuallyClosed = false;
    const socket = new WebSocket(realtimeSocketUrl());
    this.socket = socket;

    socket.addEventListener("open", () => {
      if (this.socket !== socket) return;
      const reconnecting = resumePrevious || this.hasConnected;
      this.connected = true;
      this.hasConnected = true;
      this.reconnectAttempt = 0;
      this.send({
        event: "session:resume",
        payload: { clientId: this.clientId, reconnecting },
      });
      const pending = this.pending.splice(0);
      for (const envelope of pending) this.send(envelope);
      this.dispatch(reconnecting ? "reconnect" : "connect");
    });

    socket.addEventListener("message", (message) => {
      if (this.socket !== socket || typeof message.data !== "string") return;
      try {
        const envelope = JSON.parse(message.data) as Partial<Envelope>;
        if (typeof envelope.event !== "string") return;
        this.dispatch(envelope.event, envelope.payload);
      } catch {
        // Ignore malformed server frames without taking down the match.
      }
    });

    socket.addEventListener("error", () => {
      if (this.socket !== socket || this.connected || this.manuallyClosed || this.hasConnected) return;
      this.dispatch("connect_error", new Error("Could not reach the game server."));
    });

    socket.addEventListener("close", () => {
      if (this.socket !== socket) return;
      const shouldReconnect = this.hasConnected && !this.manuallyClosed;
      this.connected = false;
      this.socket = null;
      if (!shouldReconnect) return;
      this.dispatch("disconnect", {
        attempt: this.reconnectAttempt + 1,
      });
      this.scheduleReconnect();
    });

    return this;
  }

  disconnect() {
    this.manuallyClosed = true;
    this.connected = false;
    this.pending = [];
    if (this.reconnectTimer !== null) window.clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.socket?.close(1000, "Client left");
    this.socket = null;
    return this;
  }

  removeAllListeners() {
    this.listeners.clear();
    return this;
  }

  private send(envelope: Envelope) {
    if (this.socket?.readyState !== WebSocket.OPEN) return;
    this.socket.send(JSON.stringify(envelope));
  }

  private scheduleReconnect() {
    if (this.manuallyClosed || this.reconnectTimer !== null) return;
    const delay = Math.min(500 * (2 ** this.reconnectAttempt), MAX_RECONNECT_DELAY);
    this.reconnectAttempt += 1;
    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }

  private dispatch(event: string, payload?: unknown) {
    for (const listener of this.listeners.get(event) ?? []) {
      listener(payload as never);
    }
  }
}
