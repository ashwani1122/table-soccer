import { strict as assert } from "node:assert";
import WebSocket from "ws";

type Frame = { event: string; payload?: Record<string, unknown> };
type Waiter = {
  event: string;
  predicate: (payload: Record<string, unknown>) => boolean;
  resolve: (frame: Frame) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
};

const socketUrl = process.env.REALTIME_TEST_URL ?? "ws://127.0.0.1:8787/ws";
const httpUrl = new URL(socketUrl);
httpUrl.protocol = httpUrl.protocol === "wss:" ? "https:" : "http:";
httpUrl.pathname = "/health";

class TestClient {
  readonly clientId: string;
  readonly frames: Frame[] = [];
  private readonly waiters = new Set<Waiter>();
  private socket: WebSocket | null = null;

  constructor(clientId: string) {
    this.clientId = clientId;
  }

  async connect() {
    this.socket = new WebSocket(socketUrl, {
      headers: { Origin: "http://localhost:3000" },
    });
    await new Promise<void>((resolve, reject) => {
      this.socket?.once("open", resolve);
      this.socket?.once("error", reject);
    });
    this.socket.on("message", (data) => {
      const frame = JSON.parse(data.toString()) as Frame;
      this.frames.push(frame);
      for (const waiter of this.waiters) {
        if (waiter.event !== frame.event || !waiter.predicate(frame.payload ?? {})) continue;
        clearTimeout(waiter.timer);
        this.waiters.delete(waiter);
        waiter.resolve(frame);
      }
    });
    return this;
  }

  send(event: string, payload?: unknown) {
    assert.equal(this.socket?.readyState, WebSocket.OPEN, `${this.clientId} socket is not open`);
    this.socket.send(JSON.stringify({ event, payload }));
  }

  waitFor(
    event: string,
    predicate: (payload: Record<string, unknown>) => boolean = () => true,
    timeoutMs = 8_000,
  ) {
    const existing = this.frames.find((frame) =>
      frame.event === event && predicate(frame.payload ?? {})
    );
    if (existing) return Promise.resolve(existing);
    return new Promise<Frame>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiters.delete(waiter);
        reject(new Error(`Timed out waiting for ${event} on ${this.clientId}`));
      }, timeoutMs);
      const waiter: Waiter = { event, predicate, resolve, reject, timer };
      this.waiters.add(waiter);
    });
  }

  async close() {
    if (!this.socket || this.socket.readyState >= WebSocket.CLOSING) return;
    const closed = new Promise<void>((resolve) => this.socket?.once("close", () => resolve()));
    this.socket.close(1000, "Smoke test complete");
    await closed;
  }
}

const health = await fetch(httpUrl);
assert.equal(health.status, 200);
assert.equal((await health.json() as { ok?: boolean }).ok, true);

function snapshot(activeTeam: "mint" | "coral", phase = "ready") {
  return {
    activeTeam,
    phase,
    score: { mint: 0, coral: phase === "finished" ? 3 : 0 },
    bodies: Array.from({ length: 13 }, (_, index) => ({
      id: index === 12 ? "ball" : `${index < 6 ? "mint" : "coral"}-${index % 6}`,
      x: 100,
      y: 100,
      vx: 0,
      vy: 0,
    })),
  };
}

const firstClientId = `cloudflare-first-${crypto.randomUUID()}`;
const secondClientId = `cloudflare-second-${crypto.randomUUID()}`;
const first = await new TestClient(firstClientId).connect();
const second = await new TestClient(secondClientId).connect();

first.send("session:resume", { clientId: firstClientId, reconnecting: false });
second.send("session:resume", { clientId: secondClientId, reconnecting: false });
await Promise.all([first.waitFor("session:ready"), second.waitFor("session:ready")]);

first.send("match:find", { clientId: firstClientId, name: "First" });
second.send("match:find", { clientId: secondClientId, name: "Second" });
const [firstMatch, secondMatch] = await Promise.all([
  first.waitFor("match:found"),
  second.waitFor("match:found"),
]);
assert.equal(firstMatch.payload?.myTeam, "mint");
assert.equal(secondMatch.payload?.myTeam, "coral");
assert.equal(firstMatch.payload?.matchId, secondMatch.payload?.matchId);

first.send("match:configure", {
  countryCode: "IN",
  attackingFormation: "attacking-1-3-2",
  defensiveFormation: "defensive-1-4-1",
});
second.send("match:configure", {
  countryCode: "BR",
  attackingFormation: "attacking-1-2-3",
  defensiveFormation: "defensive-1-3-2",
});
await Promise.all([
  first.waitFor("match:setup", (payload) => payload.ready === true),
  second.waitFor("match:setup", (payload) => payload.ready === true),
]);

first.send("game:aim", { bodyId: "mint-1", dirX: 0, dirY: -1, pull: 40 });
const remoteAim = await second.waitFor("game:aim");
assert.equal(remoteAim.payload?.bodyId, "mint-1");

first.send("game:shoot", { bodyId: "mint-1", dirX: 0, dirY: -1, pull: 55 });
const [firstShot, secondShot] = await Promise.all([
  first.waitFor("game:shot"),
  second.waitFor("game:shot"),
]);
assert.equal(firstShot.payload?.sequence, 1);
assert.equal(secondShot.payload?.sequence, 1);

first.send("chat:send", { text: "Cloudflare hello" });
const chat = await second.waitFor("chat:message");
assert.equal(chat.payload?.text, "Cloudflare hello");

second.send("reaction:send", { emoji: "🔥" });
const reaction = await first.waitFor("reaction:show");
assert.equal(reaction.payload?.emoji, "🔥");

first.send("game:settled", {
  matchId: firstMatch.payload?.matchId,
  snapshot: snapshot("coral"),
});
const settled = await second.waitFor("game:sync", (payload) => payload.sequence === 1);
assert.equal((settled.payload?.snapshot as Record<string, unknown>)?.activeTeam, "coral");

await first.close();
await second.waitFor("match:opponent-reconnecting");
const resumedFirst = await new TestClient(firstClientId).connect();
resumedFirst.send("session:resume", { clientId: firstClientId, reconnecting: true });
await Promise.all([
  resumedFirst.waitFor("session:resumed", (payload) => payload.scope === "match"),
  resumedFirst.waitFor("match:resumed"),
  second.waitFor("match:opponent-returned"),
]);
const history = await resumedFirst.waitFor("chat:history");
assert.equal(
  ((history.payload?.messages as Array<Record<string, unknown>>)?.[0])?.text,
  "Cloudflare hello",
);
await resumedFirst.waitFor("game:sync", (payload) => payload.sequence === 1);

second.send("game:shoot", { bodyId: "coral-1", dirX: 0, dirY: 1, pull: 45 });
await Promise.all([
  resumedFirst.waitFor("game:shot", (payload) => payload.sequence === 2),
  second.waitFor("game:shot", (payload) => payload.sequence === 2),
]);
second.send("game:settled", {
  matchId: firstMatch.payload?.matchId,
  snapshot: snapshot("mint", "finished"),
});
await resumedFirst.waitFor("game:sync", (payload) => payload.sequence === 2);
resumedFirst.send("match:rematch");
second.send("match:rematch");
await Promise.all([
  resumedFirst.waitFor("match:reset", (payload) => payload.sequence === 3),
  second.waitFor("match:reset", (payload) => payload.sequence === 3),
]);

await Promise.all([resumedFirst.close(), second.close()]);

const hostId = `cloudflare-host-${crypto.randomUUID()}`;
const guestId = `cloudflare-guest-${crypto.randomUUID()}`;
const host = await new TestClient(hostId).connect();
const guest = await new TestClient(guestId).connect();
host.send("session:resume", { clientId: hostId, reconnecting: false });
guest.send("session:resume", { clientId: guestId, reconnecting: false });
await Promise.all([host.waitFor("session:ready"), guest.waitFor("session:ready")]);
host.send("room:create", { clientId: hostId, name: "Host" });
const room = await host.waitFor("room:created");
assert.equal(typeof room.payload?.code, "string");
guest.send("room:join", { clientId: guestId, name: "Guest", code: room.payload?.code });
await Promise.all([host.waitFor("match:found"), guest.waitFor("match:found")]);
await Promise.all([host.close(), guest.close()]);

const soloId = `cloudflare-solo-${crypto.randomUUID()}`;
const solo = await new TestClient(soloId).connect();
solo.send("session:resume", { clientId: soloId, reconnecting: false });
await solo.waitFor("session:ready");
solo.send("match:find", { clientId: soloId, name: "Solo" });
const botMatch = await solo.waitFor(
  "match:found",
  (payload) => (payload.opponent as Record<string, unknown> | undefined)?.isBot === true,
  12_000,
);
assert.equal((botMatch.payload?.opponent as Record<string, unknown>)?.name, "FlickBot");
solo.send("match:configure", {
  countryCode: "JP",
  attackingFormation: "attacking-1-2-3",
  defensiveFormation: "defensive-1-2-1-2",
});
await solo.waitFor("match:setup", (payload) => payload.ready === true);
solo.send("game:shoot", { bodyId: "mint-1", dirX: 0, dirY: -1, pull: 50 });
await solo.waitFor("game:shot", (payload) => payload.sequence === 1);
solo.send("game:settled", {
  matchId: botMatch.payload?.matchId,
  snapshot: snapshot("coral"),
});
await solo.waitFor(
  "game:aim",
  (payload) => typeof payload.bodyId === "string" && payload.bodyId.startsWith("coral-"),
  8_000,
);
await solo.waitFor("game:shot", (payload) => payload.sequence === 2, 8_000);
solo.send("game:settled", {
  matchId: botMatch.payload?.matchId,
  snapshot: snapshot("mint", "finished"),
});
await solo.waitFor("game:sync", (payload) => payload.sequence === 2);
solo.send("match:rematch");
await solo.waitFor("match:reset", (payload) => payload.sequence === 3);
await solo.close();

console.log("Cloudflare Durable Object matchmaking, setup, aim and shot relay, settled snapshots, chat, reactions, reconnect, rematch, private rooms, and bot turns passed.");
