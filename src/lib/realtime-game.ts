import { randomUUID } from "node:crypto";
import type Redis from "ioredis";
import type { WebSocket } from "ws";
import { fieldsToObject, realtimeRedis } from "./realtime-redis.ts";

type Team = "mint" | "coral";

type QueueEntry = {
  socketId: string;
  name: string;
};

type Player = QueueEntry & {
  team: Team;
};

type MatchRoom = {
  id: string;
  activeTeam: Team;
  shotInProgress: boolean;
  finished: boolean;
  sequence: number;
  privateCode: string | null;
  rematchVotes: Set<string>;
  players: [Player, Player];
};

type PrivateRoom = {
  code: string;
  host: QueueEntry;
  createdAt: number;
};

type GameState = {
  queue: QueueEntry[];
  matches: Map<string, MatchRoom>;
  playerMatches: Map<string, string>;
  privateRooms: Map<string, PrivateRoom>;
  privateRoomByHost: Map<string, string>;
};

type SavedGameState = {
  queue: QueueEntry[];
  matches: Array<Omit<MatchRoom, "rematchVotes"> & { rematchVotes: string[] }>;
  playerMatches: Array<[string, string]>;
  privateRooms: Array<[string, PrivateRoom]>;
  privateRoomByHost: Array<[string, string]>;
};

type OutboundEvent = {
  targets: string[];
  event: string;
  payload?: unknown;
};

type ClientEnvelope = {
  event: string;
  payload?: unknown;
};

type LocalHub = {
  instanceId: string;
  sockets: Map<string, WebSocket>;
  socketIds: Map<WebSocket, string>;
  memoryState: GameState;
  streamClient: Redis | null;
  streaming: boolean;
  lastEventId: string;
  heartbeat: ReturnType<typeof setInterval> | null;
};

const ROOM_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const STATE_KEY = "flickxi:v1:state";
const STATE_LOCK_KEY = "flickxi:v1:state-lock";
const EVENT_STREAM = "flickxi:v1:events";
const CONNECTION_PREFIX = "flickxi:v1:connection:";
const CONNECTION_TTL_SECONDS = 35;
const HEARTBEAT_MS = 10_000;
const STREAM_BLOCK_MS = 5_000;
const STREAM_MAX_LENGTH = 2_000;

const globalForRealtime = globalThis as typeof globalThis & {
  __flickXiHub?: LocalHub;
};

function createGameState(): GameState {
  return {
    queue: [],
    matches: new Map(),
    playerMatches: new Map(),
    privateRooms: new Map(),
    privateRoomByHost: new Map(),
  };
}

const hub: LocalHub = globalForRealtime.__flickXiHub ??
  (globalForRealtime.__flickXiHub = {
    instanceId: randomUUID(),
    sockets: new Map(),
    socketIds: new Map(),
    memoryState: createGameState(),
    streamClient: null,
    streaming: false,
    lastEventId: "0-0",
    heartbeat: null,
  });

const sleep = (milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds));

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? value as Record<string, unknown> : {};
}

function serializeState(state: GameState) {
  const saved: SavedGameState = {
    queue: state.queue,
    matches: [...state.matches.values()].map((room) => ({
      ...room,
      rematchVotes: [...room.rematchVotes],
    })),
    playerMatches: [...state.playerMatches],
    privateRooms: [...state.privateRooms],
    privateRoomByHost: [...state.privateRoomByHost],
  };
  return JSON.stringify(saved);
}

function deserializeState(raw: string | null): GameState {
  if (!raw) return createGameState();
  try {
    const saved = JSON.parse(raw) as Partial<SavedGameState>;
    return {
      queue: Array.isArray(saved.queue) ? saved.queue : [],
      matches: new Map((Array.isArray(saved.matches) ? saved.matches : []).map((room) => [
        room.id,
        { ...room, rematchVotes: new Set(room.rematchVotes) },
      ])),
      playerMatches: new Map(Array.isArray(saved.playerMatches) ? saved.playerMatches : []),
      privateRooms: new Map(Array.isArray(saved.privateRooms) ? saved.privateRooms : []),
      privateRoomByHost: new Map(Array.isArray(saved.privateRoomByHost) ? saved.privateRoomByHost : []),
    };
  } catch (error) {
    console.error("[FlickXI] Could not read shared realtime state", error);
    return createGameState();
  }
}

function send(socket: WebSocket | undefined, event: string, payload?: unknown) {
  if (!socket || socket.readyState !== 1) return;
  try {
    socket.send(JSON.stringify({ event, payload }));
  } catch {
    // The close event performs cleanup when a connection disappears mid-send.
  }
}

function deliverLocally(outbound: OutboundEvent) {
  for (const target of outbound.targets) send(hub.sockets.get(target), outbound.event, outbound.payload);
}

function direct(socketId: string, event: string, payload?: unknown): OutboundEvent {
  return { targets: [socketId], event, payload };
}

function toMatch(room: MatchRoom, event: string, payload?: unknown): OutboundEvent {
  return { targets: room.players.map((player) => player.socketId), event, payload };
}

async function acquireStateLock() {
  if (!realtimeRedis) return null;
  const token = randomUUID();
  const deadline = Date.now() + 4_000;
  while (Date.now() < deadline) {
    const acquired = await realtimeRedis.set(STATE_LOCK_KEY, token, "PX", 10_000, "NX");
    if (acquired === "OK") return token;
    await sleep(15);
  }
  throw new Error("Timed out waiting for the shared game-state lock.");
}

async function releaseStateLock(token: string | null) {
  if (!realtimeRedis || !token) return;
  await realtimeRedis.eval(
    "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end",
    1,
    STATE_LOCK_KEY,
    token,
  );
}

async function publishRedisState(state: GameState, outbound: OutboundEvent[]) {
  if (!realtimeRedis) return;
  const transaction = realtimeRedis.multi().set(STATE_KEY, serializeState(state));
  for (const event of outbound) {
    transaction.xadd(
      EVENT_STREAM,
      "MAXLEN",
      "~",
      STREAM_MAX_LENGTH,
      "*",
      "d",
      JSON.stringify(event),
      "o",
      hub.instanceId,
    );
  }
  await transaction.exec();
}

async function withGameState(mutator: (state: GameState) => Promise<OutboundEvent[]> | OutboundEvent[]) {
  if (!realtimeRedis) {
    const outbound = await mutator(hub.memoryState);
    outbound.forEach(deliverLocally);
    return;
  }

  const token = await acquireStateLock();
  try {
    const state = deserializeState(await realtimeRedis.get(STATE_KEY));
    const outbound = await mutator(state);
    await publishRedisState(state, outbound);
    outbound.forEach(deliverLocally);
  } finally {
    await releaseStateLock(token);
  }
}

async function connectionIsAlive(socketId: string) {
  if (!realtimeRedis) return hub.sockets.has(socketId);
  return (await realtimeRedis.exists(`${CONNECTION_PREFIX}${socketId}`)) === 1;
}

async function touchConnection(socketId: string) {
  if (!realtimeRedis) return;
  await realtimeRedis.set(`${CONNECTION_PREFIX}${socketId}`, hub.instanceId, "EX", CONNECTION_TTL_SECONDS);
}

function safeName(value: unknown, fallback: string) {
  if (typeof value !== "string") return fallback;
  const clean = value.replace(/[^a-zA-Z0-9 _-]/g, "").trim().slice(0, 18);
  return clean || fallback;
}

function removeFromQueue(state: GameState, socketId: string) {
  const index = state.queue.findIndex((entry) => entry.socketId === socketId);
  if (index >= 0) state.queue.splice(index, 1);
}

function removePrivateRoomForHost(
  state: GameState,
  socketId: string,
  outbound: OutboundEvent[],
  notify = true,
) {
  const code = state.privateRoomByHost.get(socketId);
  if (!code) return;
  state.privateRoomByHost.delete(socketId);
  state.privateRooms.delete(code);
  if (notify) outbound.push(direct(socketId, "room:closed"));
}

function createRoomCode(state: GameState) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    let code = "";
    for (let index = 0; index < 6; index += 1) {
      code += ROOM_ALPHABET[Math.floor(Math.random() * ROOM_ALPHABET.length)];
    }
    if (!state.privateRooms.has(code)) return code;
  }
  return randomUUID().replaceAll("-", "").slice(0, 6).toUpperCase();
}

function cleanRoomCode(value: unknown) {
  if (typeof value !== "string") return "";
  return value.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 6);
}

function publicPlayer(player: Player) {
  return { name: player.name, team: player.team };
}

function startMatch(
  state: GameState,
  firstEntry: QueueEntry,
  secondEntry: QueueEntry,
  outbound: OutboundEvent[],
  privateCode: string | null = null,
) {
  const matchId = randomUUID();
  const room: MatchRoom = {
    id: matchId,
    activeTeam: "mint",
    shotInProgress: false,
    finished: false,
    sequence: 0,
    privateCode,
    rematchVotes: new Set(),
    players: [
      { ...firstEntry, team: "mint" },
      { ...secondEntry, team: "coral" },
    ],
  };

  state.matches.set(matchId, room);
  for (const player of room.players) state.playerMatches.set(player.socketId, matchId);

  for (const player of room.players) {
    const opponent = room.players.find((candidate) => candidate.socketId !== player.socketId);
    if (!opponent) continue;
    outbound.push(direct(player.socketId, "match:found", {
      matchId,
      myTeam: player.team,
      player: publicPlayer(player),
      opponent: publicPlayer(opponent),
      startsAt: Date.now() + 750,
      roomCode: privateCode,
    }));
  }
}

async function attemptMatchmaking(state: GameState, outbound: OutboundEvent[]) {
  while (state.queue.length >= 2) {
    const first = state.queue.shift();
    const second = state.queue.shift();
    if (!first || !second) return;
    const [firstConnected, secondConnected] = await Promise.all([
      connectionIsAlive(first.socketId),
      connectionIsAlive(second.socketId),
    ]);
    if (!firstConnected || state.playerMatches.has(first.socketId)) {
      if (secondConnected && !state.playerMatches.has(second.socketId)) state.queue.unshift(second);
      continue;
    }
    if (!secondConnected || state.playerMatches.has(second.socketId)) {
      state.queue.unshift(first);
      continue;
    }
    startMatch(state, first, second, outbound);
  }
}

function validShot(payload: unknown, team: Team) {
  const value = record(payload);
  const bodyId = typeof value.bodyId === "string" ? value.bodyId : "";
  const dirX = Number(value.dirX);
  const dirY = Number(value.dirY);
  const pull = Number(value.pull);
  if (!bodyId.startsWith(`${team}-`)) return null;
  if (![dirX, dirY, pull].every(Number.isFinite)) return null;
  const length = Math.hypot(dirX, dirY);
  if (length < 0.8 || length > 1.2 || pull < 8 || pull > 92.5) return null;
  return {
    bodyId,
    dirX: dirX / length,
    dirY: dirY / length,
    pull: Math.min(92, pull),
  };
}

function validSnapshot(snapshot: unknown) {
  const value = record(snapshot);
  const score = record(value.score);
  if (value.activeTeam !== "mint" && value.activeTeam !== "coral") return false;
  if (!Array.isArray(value.bodies) || value.bodies.length !== 13) return false;
  if (!Number.isInteger(score.mint) || !Number.isInteger(score.coral)) return false;
  const mintScore = Number(score.mint);
  const coralScore = Number(score.coral);
  if (mintScore < 0 || coralScore < 0 || mintScore > 3 || coralScore > 3) return false;
  return value.bodies.every((body) => {
    const item = record(body);
    return typeof item.id === "string" &&
      [item.x, item.y, item.vx, item.vy].every((entry) => Number.isFinite(entry));
  });
}

function getRoom(state: GameState, socketId: string) {
  const matchId = state.playerMatches.get(socketId);
  return matchId ? state.matches.get(matchId) ?? null : null;
}

async function handleEvent(state: GameState, socketId: string, event: string, payload: unknown) {
  const outbound: OutboundEvent[] = [];
  const value = record(payload);

  switch (event) {
    case "match:find": {
      if (state.playerMatches.has(socketId)) return outbound;
      removeFromQueue(state, socketId);
      removePrivateRoomForHost(state, socketId, outbound, false);
      const fallback = `Player ${socketId.slice(0, 4).toUpperCase()}`;
      state.queue.push({ socketId, name: safeName(value.name, fallback) });
      outbound.push(direct(socketId, "match:searching", { position: state.queue.length }));
      await attemptMatchmaking(state, outbound);
      return outbound;
    }
    case "match:cancel":
      removeFromQueue(state, socketId);
      outbound.push(direct(socketId, "match:cancelled"));
      return outbound;
    case "room:create": {
      if (state.playerMatches.has(socketId)) return outbound;
      removeFromQueue(state, socketId);
      removePrivateRoomForHost(state, socketId, outbound, false);
      const fallback = `Player ${socketId.slice(0, 4).toUpperCase()}`;
      const code = createRoomCode(state);
      state.privateRooms.set(code, {
        code,
        host: { socketId, name: safeName(value.name, fallback) },
        createdAt: Date.now(),
      });
      state.privateRoomByHost.set(socketId, code);
      outbound.push(direct(socketId, "room:created", { code }));
      return outbound;
    }
    case "room:join": {
      if (state.playerMatches.has(socketId)) return outbound;
      removeFromQueue(state, socketId);
      const code = cleanRoomCode(value.code);
      if (code.length !== 6) {
        outbound.push(direct(socketId, "room:error", {
          action: "join",
          message: "Enter a valid 6-character room code.",
        }));
        return outbound;
      }
      const privateRoom = state.privateRooms.get(code);
      const hostConnected = privateRoom ? await connectionIsAlive(privateRoom.host.socketId) : false;
      if (!privateRoom || !hostConnected) {
        if (privateRoom) {
          state.privateRooms.delete(code);
          state.privateRoomByHost.delete(privateRoom.host.socketId);
        }
        outbound.push(direct(socketId, "room:error", {
          action: "join",
          message: "Room not found or no longer available.",
        }));
        return outbound;
      }
      if (privateRoom.host.socketId === socketId) {
        outbound.push(direct(socketId, "room:error", {
          action: "join",
          message: "Share this code with a different player.",
        }));
        return outbound;
      }
      const fallback = `Player ${socketId.slice(0, 4).toUpperCase()}`;
      const guest = { socketId, name: safeName(value.name, fallback) };
      state.privateRooms.delete(code);
      state.privateRoomByHost.delete(privateRoom.host.socketId);
      startMatch(state, privateRoom.host, guest, outbound, code);
      return outbound;
    }
    case "room:cancel":
      removePrivateRoomForHost(state, socketId, outbound);
      outbound.push(direct(socketId, "room:cancelled"));
      return outbound;
    case "game:shoot": {
      const room = getRoom(state, socketId);
      if (!room || room.shotInProgress || room.finished) return outbound;
      const player = room.players.find((candidate) => candidate.socketId === socketId);
      if (!player || player.team !== room.activeTeam) {
        outbound.push(direct(socketId, "game:error", { message: "It is not your turn." }));
        return outbound;
      }
      const shot = validShot(payload, player.team);
      if (!shot) {
        outbound.push(direct(socketId, "game:error", { message: "That shot was rejected." }));
        return outbound;
      }
      room.shotInProgress = true;
      room.sequence += 1;
      outbound.push(toMatch(room, "game:shot", {
        ...shot,
        sequence: room.sequence,
        serverTime: Date.now(),
      }));
      return outbound;
    }
    case "game:settled": {
      const room = getRoom(state, socketId);
      if (!room || value.matchId !== room.id || !validSnapshot(value.snapshot)) return outbound;
      const player = room.players.find((candidate) => candidate.socketId === socketId);
      if (!player || player.team !== room.activeTeam) return outbound;
      const snapshot = record(value.snapshot);
      room.activeTeam = snapshot.activeTeam as Team;
      room.finished = snapshot.phase === "finished";
      room.shotInProgress = false;
      outbound.push(toMatch(room, "game:sync", {
        snapshot: value.snapshot,
        sequence: room.sequence,
        serverTime: Date.now(),
      }));
      return outbound;
    }
    case "match:rematch": {
      const room = getRoom(state, socketId);
      if (!room || !room.finished) return outbound;
      room.rematchVotes.add(socketId);
      outbound.push(toMatch(room, "match:rematch-status", {
        ready: room.rematchVotes.size,
        needed: 2,
      }));
      if (room.rematchVotes.size === 2) {
        room.activeTeam = room.players[room.sequence % 2].team;
        room.shotInProgress = false;
        room.finished = false;
        room.rematchVotes.clear();
        room.sequence += 1;
        outbound.push(toMatch(room, "match:reset", {
          activeTeam: room.activeTeam,
          sequence: room.sequence,
        }));
      }
      return outbound;
    }
    case "match:leave":
      hub.sockets.get(socketId)?.close(1000, "Player left match");
      return outbound;
    default:
      return outbound;
  }
}

function cleanupState(state: GameState, socketId: string) {
  const outbound: OutboundEvent[] = [];
  removeFromQueue(state, socketId);
  removePrivateRoomForHost(state, socketId, outbound);

  const matchId = state.playerMatches.get(socketId);
  if (!matchId) return outbound;
  const room = state.matches.get(matchId);
  if (room) {
    const opponent = room.players.find((candidate) => candidate.socketId !== socketId);
    if (opponent) outbound.push(direct(opponent.socketId, "match:opponent-left"));
    for (const player of room.players) state.playerMatches.delete(player.socketId);
    state.matches.delete(matchId);
  }
  return outbound;
}

async function pruneDisconnected(state: GameState) {
  const outbound: OutboundEvent[] = [];
  const queueStatus = await Promise.all(state.queue.map((entry) => connectionIsAlive(entry.socketId)));
  state.queue = state.queue.filter((_, index) => queueStatus[index]);

  for (const [code, room] of state.privateRooms) {
    if (await connectionIsAlive(room.host.socketId)) continue;
    state.privateRooms.delete(code);
    state.privateRoomByHost.delete(room.host.socketId);
  }

  for (const [matchId, room] of state.matches) {
    const alive = await Promise.all(room.players.map((player) => connectionIsAlive(player.socketId)));
    if (alive.every(Boolean)) continue;
    room.players.forEach((player, index) => {
      state.playerMatches.delete(player.socketId);
      if (alive[index]) outbound.push(direct(player.socketId, "match:opponent-left"));
    });
    state.matches.delete(matchId);
  }
  return outbound;
}

async function processClientFrame(socketId: string, data: WebSocket.RawData) {
  try {
    const message = JSON.parse(data.toString()) as Partial<ClientEnvelope>;
    if (typeof message.event !== "string") return;
    await touchConnection(socketId);
    await withGameState((state) => handleEvent(state, socketId, message.event!, message.payload));
  } catch (error) {
    console.error("[FlickXI] Could not process realtime event", error);
    send(hub.sockets.get(socketId), "server:error", {
      message: "The realtime service is temporarily unavailable. Try again.",
    });
  }
}

async function runEventStream() {
  const client = hub.streamClient;
  if (!client || !realtimeRedis) return;
  try {
    const tail = await realtimeRedis.xrevrange(EVENT_STREAM, "+", "-", "COUNT", 1);
    hub.lastEventId = tail[0]?.[0] ?? "0-0";
  } catch {
    hub.lastEventId = "0-0";
  }

  while (hub.streaming) {
    try {
      const response = await client.xread(
        "BLOCK",
        STREAM_BLOCK_MS,
        "STREAMS",
        EVENT_STREAM,
        hub.lastEventId,
      ) as Array<[string, Array<[string, string[]]>]> | null;
      if (!response) continue;
      for (const [, entries] of response) {
        for (const [id, flatFields] of entries) {
          hub.lastEventId = id;
          const fields = fieldsToObject(flatFields);
          if (fields.o === hub.instanceId) continue;
          try {
            const outbound = JSON.parse(fields.d) as OutboundEvent;
            if (Array.isArray(outbound.targets) && typeof outbound.event === "string") {
              deliverLocally(outbound);
            }
          } catch {
            // Ignore malformed stream entries.
          }
        }
      }
    } catch (error) {
      if (!hub.streaming) break;
      console.error("[FlickXI] Realtime event stream failed", error);
      await sleep(1_000);
    }
  }
}

async function heartbeat() {
  if (!realtimeRedis) return;
  try {
    await Promise.all([...hub.sockets.keys()].map(touchConnection));
    await withGameState(pruneDisconnected);
  } catch (error) {
    console.error("[FlickXI] Realtime heartbeat failed", error);
  }
}

function startRedisInfrastructure() {
  if (!realtimeRedis) return;
  if (!hub.heartbeat) hub.heartbeat = setInterval(() => void heartbeat(), HEARTBEAT_MS);
  if (hub.streaming) return;
  hub.streaming = true;
  hub.streamClient = realtimeRedis.duplicate();
  void runEventStream();
}

function stopRedisInfrastructure() {
  if (hub.sockets.size > 0) return;
  hub.streaming = false;
  if (hub.streamClient) {
    void hub.streamClient.quit().catch(() => undefined);
    hub.streamClient = null;
  }
  if (hub.heartbeat) {
    clearInterval(hub.heartbeat);
    hub.heartbeat = null;
  }
}

async function unregisterGameSocket(socket: WebSocket) {
  const socketId = hub.socketIds.get(socket);
  if (!socketId) return;
  hub.socketIds.delete(socket);
  hub.sockets.delete(socketId);
  if (realtimeRedis) await realtimeRedis.del(`${CONNECTION_PREFIX}${socketId}`);
  try {
    await withGameState((state) => cleanupState(state, socketId));
  } catch (error) {
    console.error("[FlickXI] Realtime disconnect cleanup failed", error);
  }
  stopRedisInfrastructure();
}

export function registerGameSocket(socket: WebSocket) {
  const socketId = randomUUID();
  hub.sockets.set(socketId, socket);
  hub.socketIds.set(socket, socketId);
  startRedisInfrastructure();
  void touchConnection(socketId).catch((error) => {
    console.error("[FlickXI] Could not register realtime connection", error);
  });

  socket.on("message", (data) => void processClientFrame(socketId, data));
  let unregistered = false;
  const unregister = () => {
    if (unregistered) return;
    unregistered = true;
    void unregisterGameSocket(socket);
  };
  socket.once("close", unregister);
  socket.once("error", unregister);
}
