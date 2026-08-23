import { strict as assert } from "node:assert";
import { EventEmitter } from "node:events";
import type { WebSocket } from "ws";
import {
  advanceBallRoll,
  calculatePossessionImpact,
  isWithinPassControl,
} from "../src/lib/game-physics.ts";
import { registerGameSocket } from "../src/lib/realtime-game.ts";

type Frame = { event: string; payload?: Record<string, unknown> };

const glancingImpact = calculatePossessionImpact(
  { x: 100, y: 138, radius: 19, mass: 2.6 },
  { x: 100, y: 100, radius: 12, mass: 0.7 },
  { x: 0.35, y: -0.94 },
  900,
  0.98,
);
assert(glancingImpact);
assert(glancingImpact.ballVx < 0);
assert(glancingImpact.ballVy < 0);
assert.equal(calculatePossessionImpact(
  { x: 100, y: 138, radius: 19, mass: 2.6 },
  { x: 100, y: 100, radius: 12, mass: 0.7 },
  { x: 0, y: 1 },
  900,
  0.98,
), null);

const eastRoll = advanceBallRoll(0, 0, 12, 0, 12);
assert.equal(eastRoll.phase, 1);
assert.equal(eastRoll.angle, 0);
const northWestRoll = advanceBallRoll(eastRoll.phase, eastRoll.angle, -6, -6, 12);
assert(northWestRoll.phase > eastRoll.phase);
assert(northWestRoll.angle < -Math.PI / 2);

const passPlayer = { x: 100, y: 100, radius: 19 };
const passBall = { x: 138, y: 100, radius: 12 };
assert.equal(isWithinPassControl(passPlayer, passBall, 7), true);
assert.equal(isWithinPassControl(passPlayer, { ...passBall, x: 138.1 }, 7), false);

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

async function waitForFrame(
  socket: FakeSocket,
  event: string,
  predicate: (frame: Frame) => boolean = () => true,
  timeoutMs = 10_000,
) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const frame = socket.frames.findLast((candidate) =>
      candidate.event === event && predicate(candidate)
    );
    if (frame) return frame;
    await settle();
  }
  throw new Error(`Timed out waiting for ${event}`);
}

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

first.receive("game:aim", { bodyId: "mint-0", dirX: 0.6, dirY: -0.8, pull: 32 });
await settle();
assert.equal(second.latest("game:aim")?.payload?.bodyId, "mint-0");
assert.equal(second.latest("game:aim")?.payload?.pull, 32);
assert.equal(first.latest("game:aim"), undefined);
first.receive("game:aim-clear");
await settle();
assert(second.latest("game:aim-clear"));

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
assert.equal(second.latest("match:opponent-reconnecting")?.payload?.graceMs, 90_000);
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

const solo = connect();
solo.receive("session:resume", { clientId: "smoke-solo-client", reconnecting: false });
solo.receive("match:find", { clientId: "smoke-solo-client", name: "Solo" });
const botMatch = await waitForFrame(
  solo,
  "match:found",
  (frame) => typeof frame.payload?.opponent === "object" &&
    frame.payload.opponent !== null &&
    (frame.payload.opponent as Record<string, unknown>).isBot === true,
);
assert.equal((botMatch.payload?.opponent as Record<string, unknown>).name, "FlickBot");

solo.receive("game:shoot", { bodyId: "mint-0", dirX: 0, dirY: -1, pull: 40 });
await settle();
solo.receive("game:settled", {
  matchId: botMatch.payload?.matchId,
  snapshot: snapshot("coral"),
});
const botAim = await waitForFrame(
  solo,
  "game:aim",
  (frame) => typeof frame.payload?.bodyId === "string" && frame.payload.bodyId.startsWith("coral-"),
);
assert(Number(botAim.payload?.pull) >= 8);
const botShot = await waitForFrame(
  solo,
  "game:shot",
  (frame) => Number(frame.payload?.sequence) >= 2,
);
assert.equal(typeof botShot.payload?.bodyId, "string");
solo.receive("game:settled", {
  matchId: botMatch.payload?.matchId,
  snapshot: snapshot("mint"),
});
await settle();
assert.equal(solo.latest("game:sync")?.payload?.sequence, 2);
solo.receive("game:settled", {
  matchId: botMatch.payload?.matchId,
  snapshot: snapshot("mint", "finished"),
});
await settle();
solo.receive("match:rematch");
await settle();
assert.equal(solo.latest("match:reset")?.payload?.sequence, 3);
solo.receive("match:leave");
await settle();

console.log("Realtime matchmaking, bot fallback, bot turns, reconnect recovery, gameplay relay, rematch, and private-room checks passed.");
