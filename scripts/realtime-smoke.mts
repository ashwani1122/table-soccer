import { strict as assert } from "node:assert";
import { EventEmitter } from "node:events";
import type { WebSocket } from "ws";
import { registerGameSocket } from "../src/lib/realtime-game.ts";

type Frame = { event: string; payload?: Record<string, unknown> };

class FakeSocket extends EventEmitter {
  readyState = 1;
  frames: Frame[] = [];

  send(frame: string) {
    this.frames.push(JSON.parse(frame) as Frame);
  }

  receive(event: string, payload?: unknown) {
    this.emit("message", Buffer.from(JSON.stringify({ event, payload })));
  }

  close() {
    this.readyState = 3;
    this.emit("close");
  }

  latest(event: string) {
    return this.frames.findLast((frame) => frame.event === event);
  }
}

function connect() {
  const socket = new FakeSocket();
  registerGameSocket(socket as unknown as WebSocket);
  return socket;
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 10));

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

const firstClientId = "smoke-first-client";
const secondClientId = "smoke-second-client";
let first = connect();
const second = connect();
first.receive("session:resume", { clientId: firstClientId, reconnecting: false });
second.receive("session:resume", { clientId: secondClientId, reconnecting: false });
first.receive("match:find", { clientId: firstClientId, name: "First" });
second.receive("match:find", { clientId: secondClientId, name: "Second" });
await settle();

const firstMatch = first.latest("match:found");
const secondMatch = second.latest("match:found");
assert(firstMatch?.payload);
assert(secondMatch?.payload);
assert.equal(firstMatch.payload.myTeam, "mint");
assert.equal(secondMatch.payload.myTeam, "coral");
assert.equal(firstMatch.payload.matchId, secondMatch.payload.matchId);

first.receive("game:shoot", { bodyId: "mint-0", dirX: 0, dirY: -1, pull: 40 });
await settle();
assert.equal(first.latest("game:shot")?.payload?.sequence, 1);
assert.equal(second.latest("game:shot")?.payload?.sequence, 1);

first.receive("game:settled", {
  matchId: firstMatch.payload.matchId,
  snapshot: snapshot("coral"),
});
await settle();
assert.equal(second.latest("game:sync")?.payload?.sequence, 1);

first.close();
await settle();
assert(second.latest("match:opponent-reconnecting"));
second.receive("game:shoot", { bodyId: "coral-0", dirX: 0, dirY: 1, pull: 35 });
await settle();
assert.equal(second.latest("game:error")?.payload?.message, "Waiting for your opponent to reconnect.");

first = connect();
first.receive("session:resume", { clientId: firstClientId, reconnecting: true });
await settle();
assert.equal(first.latest("session:resumed")?.payload?.scope, "match");
assert.equal(first.latest("match:resumed")?.payload?.matchId, firstMatch.payload.matchId);
assert.equal(first.latest("match:resumed")?.payload?.myTeam, "mint");
assert.equal(first.latest("game:sync")?.payload?.sequence, 1);
assert(second.latest("match:opponent-returned"));

second.receive("game:shoot", { bodyId: "coral-0", dirX: 0, dirY: 1, pull: 35 });
await settle();
second.receive("game:settled", {
  matchId: firstMatch.payload.matchId,
  snapshot: snapshot("mint", "finished"),
});
await settle();
first.receive("match:rematch");
second.receive("match:rematch");
await settle();
assert.equal(first.latest("match:reset")?.payload?.sequence, 3);
assert.equal(second.latest("match:reset")?.payload?.sequence, 3);

first.receive("match:leave");
await settle();
second.close();

const host = connect();
const guest = connect();
host.receive("session:resume", { clientId: "smoke-private-host", reconnecting: false });
guest.receive("session:resume", { clientId: "smoke-private-guest", reconnecting: false });
host.receive("room:create", { clientId: "smoke-private-host", name: "Host" });
await settle();
const code = host.latest("room:created")?.payload?.code;
assert.equal(typeof code, "string");
assert.equal(String(code).length, 6);
guest.receive("room:join", { clientId: "smoke-private-guest", name: "Guest", code });
await settle();
assert.equal(host.latest("match:found")?.payload?.roomCode, code);
assert.equal(guest.latest("match:found")?.payload?.roomCode, code);

host.close();
guest.close();
console.log("Realtime matchmaking, reconnect recovery, gameplay relay, rematch, and private-room checks passed.");
