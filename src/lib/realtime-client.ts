type Listener = (payload: never) => void;

type ServerEnvelope = {
  event: string;
  payload?: unknown;
};

export class RealtimeClient {
  private socket: WebSocket | null = null;
  private listeners = new Map<string, Set<Listener>>();
  private manuallyClosed = false;
  private connected = false;

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
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) return this;
    this.socket.send(JSON.stringify({ event, payload }));
    return this;
  }

  connect() {
    if (this.socket && this.socket.readyState < WebSocket.CLOSING) return this;

    this.manuallyClosed = false;
    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const socket = new WebSocket(`${protocol}//${window.location.host}/api/ws`);
    this.socket = socket;

    socket.addEventListener("open", () => {
      if (this.socket !== socket) return;
      this.connected = true;
      this.dispatch("connect");
    });

    socket.addEventListener("message", (message) => {
      if (this.socket !== socket || typeof message.data !== "string") return;
      try {
        const envelope = JSON.parse(message.data) as Partial<ServerEnvelope>;
        if (typeof envelope.event !== "string") return;
        this.dispatch(envelope.event, envelope.payload);
      } catch {
        // Ignore malformed server frames without taking down the match.
      }
    });

    socket.addEventListener("error", () => {
      if (this.socket !== socket || this.connected || this.manuallyClosed) return;
      this.dispatch("connect_error", new Error("Could not reach the game server."));
    });

    socket.addEventListener("close", () => {
      if (this.socket !== socket) return;
      const wasConnected = this.connected;
      this.connected = false;
      this.socket = null;
      if (wasConnected && !this.manuallyClosed) this.dispatch("disconnect");
    });

    return this;
  }

  disconnect() {
    this.manuallyClosed = true;
    this.connected = false;
    this.socket?.close(1000, "Client left");
    this.socket = null;
    return this;
  }

  removeAllListeners() {
    this.listeners.clear();
    return this;
  }

  private dispatch(event: string, payload?: unknown) {
    for (const listener of this.listeners.get(event) ?? []) {
      listener(payload as never);
    }
  }
}
