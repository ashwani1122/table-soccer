import { randomUUID } from "node:crypto";
import type Redis from "ioredis";
import type { WebSocket } from "ws";
import {
  BOT_PLAYER_SETUP,
  isCountryCode,
  isFormationId,
  type FormationId,
  type PlayerSetup,
  type Team,
} from "./match-setup.ts";
import { fieldsToObject, realtimeRedis } from "./realtime-redis.ts";

type QueueEntry = {
  socketId: string;
  clientId: string;
  name: string;
  isBot?: boolean;
  queuedAt?: number;
};

type Player = QueueEntry & {
  team: Team;
  isBot: boolean;
  disconnectedAt: number | null;
  countryCode?: string;
  formation?: FormationId;
  lastChatAt?: number;
  lastReactionAt?: number;
};

type RelayedShot = {
  bodyId: string;
  dirX: number;
  dirY: number;
  pull: number;
  sequence: number;
  serverTime: number;
};

type BotShot = Omit<RelayedShot, "sequence" | "serverTime">;

type BotAction = {
  stage: "thinking" | "aiming";
  dueAt: number;
  shot: BotShot | null;
};

type RealtimeChatMessage = {
  id: string;
  matchId: string;
  senderTeam: Team;
  senderName: string;
  text: string;
  sentAt: number;
};

type MatchRoom = {
  id: string;
  activeTeam: Team;
  shotInProgress: boolean;
  finished: boolean;
  sequence: number;
  privateCode: string | null;
  rematchVotes: Set<string>;
  lastSnapshot: unknown | null;
  snapshotSequence: number;
  lastShot: RelayedShot | null;
  botAction: BotAction | null;
  chatMessages: RealtimeChatMessage[];
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
  clientMatches: Map<string, string>;
  privateRooms: Map<string, PrivateRoom>;
  privateRoomByHost: Map<string, string>;
};

type SavedGameState = {
  queue: QueueEntry[];
  matches: Array<Omit<MatchRoom, "rematchVotes"> & { rematchVotes: string[] }>;
  playerMatches: Array<[string, string]>;
  clientMatches: Array<[string, string]>;
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
  socketTasks: Map<string, Promise<void>>;
  memoryState: GameState;
  streamClient: Redis | null;
  streaming: boolean;
  lastEventId: string;
  heartbeat: ReturnType<typeof setInterval> | null;
  botTimers: Map<string, ReturnType<typeof setTimeout>>;
  queueBotTimers: Map<string, ReturnType<typeof setTimeout>>;
};

const ROOM_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const STATE_KEY = "flickxi:v2:state";
const STATE_LOCK_KEY = "flickxi:v2:state-lock";
const EVENT_STREAM = "flickxi:v2:events";
const CONNECTION_PREFIX = "flickxi:v2:connection:";
const CONNECTION_TTL_SECONDS = 35;
const RECONNECT_GRACE_MS = 90_000;
const BOT_MATCH_DELAY_MS = 6_000;
const BOT_THINK_MIN_MS = 650;
const BOT_THINK_VARIANCE_MS = 550;
const BOT_AIM_MIN_MS = 700;
const BOT_AIM_VARIANCE_MS = 450;
const HEARTBEAT_MS = 10_000;
const STREAM_BLOCK_MS = 5_000;
const STREAM_MAX_LENGTH = 2_000;
const CHAT_MAX_LENGTH = 160;
const CHAT_COOLDOWN_MS = 650;
const REACTION_COOLDOWN_MS = 500;
const ALLOWED_REACTIONS = new Set(["⚽", "🔥", "👏", "😂", "😮", "💚"]);

const globalForRealtime = globalThis as typeof globalThis & {
  __flickXiHub?: LocalHub;
};

function createGameState(): GameState {
  return {
    queue: [],
    matches: new Map(),
    playerMatches: new Map(),
    clientMatches: new Map(),
    privateRooms: new Map(),
    privateRoomByHost: new Map(),
  };
}

const hub: LocalHub = globalForRealtime.__flickXiHub ??
  (globalForRealtime.__flickXiHub = {
    instanceId: randomUUID(),
    sockets: new Map(),
    socketIds: new Map(),
    socketTasks: new Map(),
    memoryState: createGameState(),
    streamClient: null,
    streaming: false,
    lastEventId: "0-0",
    heartbeat: null,
    botTimers: new Map(),
    queueBotTimers: new Map(),
  });
hub.socketTasks ??= new Map();
hub.botTimers ??= new Map();
hub.queueBotTimers ??= new Map();

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
    clientMatches: [...state.clientMatches],
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
      matches: new Map((Array.isArray(saved.matches) ? saved.matches : []).map((room) => {
        const players = room.players.map((player) => ({
          ...player,
          isBot: player.isBot === true,
        })) as [Player, Player];
        return [
          room.id,
          {
            ...room,
            players,
            botAction: room.botAction ?? null,
            chatMessages: Array.isArray(room.chatMessages) ? room.chatMessages : [],
            rematchVotes: new Set(room.rematchVotes),
          },
        ];
      })),
      playerMatches: new Map(Array.isArray(saved.playerMatches) ? saved.playerMatches : []),
      clientMatches: new Map(Array.isArray(saved.clientMatches) ? saved.clientMatches : []),
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
  return {
    targets: room.players.filter((player) => !player.isBot).map((player) => player.socketId),
    event,
    payload,
  };
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

function safeClientId(value: unknown, socketId: string) {
  if (typeof value !== "string") return `legacy-${socketId}`;
  const clean = value.replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 80);
  return clean.length >= 12 ? clean : `legacy-${socketId}`;
}

function safeChatText(value: unknown) {
  if (typeof value !== "string") return "";
  return value
    .replace(/[\u0000-\u001F\u007F]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, CHAT_MAX_LENGTH);
}

function cancelQueueBotTimer(clientId: string) {
  const timer = hub.queueBotTimers.get(clientId);
  if (timer) clearTimeout(timer);
  hub.queueBotTimers.delete(clientId);
}

function cancelBotTimer(matchId: string) {
  const timer = hub.botTimers.get(matchId);
  if (timer) clearTimeout(timer);
  hub.botTimers.delete(matchId);
}

function removeFromQueue(state: GameState, socketId: string) {
  const index = state.queue.findIndex((entry) => entry.socketId === socketId);
  if (index >= 0) {
    const [removed] = state.queue.splice(index, 1);
    if (removed) cancelQueueBotTimer(removed.clientId);
  }
}

function removeClientFromQueue(state: GameState, clientId: string) {
  cancelQueueBotTimer(clientId);
  state.queue = state.queue.filter((entry) => entry.clientId !== clientId);
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
  return {
    name: player.name,
    team: player.team,
    isBot: player.isBot,
    countryCode: player.countryCode,
    formation: player.formation,
  };
}

function playerSetup(player: Player): PlayerSetup | null {
  if (!isCountryCode(player.countryCode) || !isFormationId(player.formation)) return null;
  return { countryCode: player.countryCode.toUpperCase(), formation: player.formation };
}

function roomSetupPayload(room: MatchRoom) {
  const mint = room.players.find((player) => player.team === "mint");
  const coral = room.players.find((player) => player.team === "coral");
  const players = {
    mint: mint ? playerSetup(mint) : null,
    coral: coral ? playerSetup(coral) : null,
  };
  return {
    matchId: room.id,
    players,
    ready: players.mint !== null && players.coral !== null,
    startsAt: players.mint !== null && players.coral !== null ? Date.now() + 350 : null,
  };
}

function roomSetupReady(room: MatchRoom) {
  return room.players.every((player) => playerSetup(player) !== null);
}

function matchInfo(room: MatchRoom, player: Player) {
  const opponent = room.players.find((candidate) => candidate.clientId !== player.clientId);
  if (!opponent) return null;
  return {
    matchId: room.id,
    myTeam: player.team,
    player: publicPlayer(player),
    opponent: publicPlayer(opponent),
    startsAt: Date.now() + 250,
    setupReady: roomSetupReady(room),
    roomCode: room.privateCode,
  };
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
    lastSnapshot: null,
    snapshotSequence: 0,
    lastShot: null,
    botAction: null,
    chatMessages: [],
    players: [firstEntry, secondEntry].map((entry, index) => ({
      ...entry,
      team: index === 0 ? "mint" : "coral",
      isBot: entry.isBot === true,
      disconnectedAt: null,
      ...(entry.isBot ? BOT_PLAYER_SETUP : {}),
    })) as [Player, Player],
  };

  state.matches.set(matchId, room);
  for (const player of room.players) {
    cancelQueueBotTimer(player.clientId);
    if (player.isBot) continue;
    state.playerMatches.set(player.socketId, matchId);
    state.clientMatches.set(player.clientId, matchId);
  }

  for (const player of room.players.filter((candidate) => !candidate.isBot)) {
    const info = matchInfo(room, player);
    if (info) outbound.push(direct(player.socketId, "match:found", info));
  }
  prepareBotTurn(room);
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

type BotBody = { id: string; x: number; y: number };

const DEFAULT_BOT_BODIES: BotBody[] = [
  { id: "coral-1", x: 210, y: 70 },
  { id: "coral-2", x: 110, y: 158 },
  { id: "coral-3", x: 210, y: 142 },
  { id: "coral-4", x: 310, y: 158 },
  { id: "coral-5", x: 158, y: 250 },
  { id: "coral-6", x: 262, y: 250 },
  { id: "mint-1", x: 210, y: 650 },
  { id: "mint-2", x: 110, y: 562 },
  { id: "mint-3", x: 210, y: 578 },
  { id: "mint-4", x: 310, y: 562 },
  { id: "mint-5", x: 158, y: 470 },
  { id: "mint-6", x: 262, y: 470 },
  { id: "ball", x: 210, y: 360 },
];

function botBodies(snapshot: unknown): BotBody[] {
  const bodies = record(snapshot).bodies;
  if (!Array.isArray(bodies)) return DEFAULT_BOT_BODIES;
  const parsed = bodies.flatMap((body) => {
    const value = record(body);
    const id = typeof value.id === "string" ? value.id : "";
    const x = Number(value.x);
    const y = Number(value.y);
    return id && Number.isFinite(x) && Number.isFinite(y) ? [{ id, x, y }] : [];
  });
  return parsed.length === 13 ? parsed : DEFAULT_BOT_BODIES;
}

function botShot(room: MatchRoom): BotShot | null {
  const bot = room.players.find((player) => player.isBot && player.team === room.activeTeam);
  if (!bot) return null;
  const snapshot = record(room.lastSnapshot);
  const bodies = botBodies(room.lastSnapshot);
  const ball = bodies.find((body) => body.id === "ball");
  if (!ball) return null;
  const goal = { x: 210, y: bot.team === "mint" ? 30 : 690 };
  const carrierId = typeof snapshot.carrierId === "string" ? snapshot.carrierId : null;
  const carrier = carrierId?.startsWith(`${bot.team}-`)
    ? bodies.find((body) => body.id === carrierId)
    : null;

  if (carrier) {
    const dx = goal.x - ball.x;
    const dy = goal.y - ball.y;
    const error = (Math.random() - 0.5) * 0.055;
    const angle = Math.atan2(dy, dx) + error;
    return {
      bodyId: carrier.id,
      dirX: Math.cos(angle),
      dirY: Math.sin(angle),
      pull: 74 + Math.random() * 14,
    };
  }

  const goalX = goal.x - ball.x;
  const goalY = goal.y - ball.y;
  const goalLength = Math.max(1, Math.hypot(goalX, goalY));
  const desiredX = goalX / goalLength;
  const desiredY = goalY / goalLength;
  const candidates = bodies
    .filter((body) => body.id.startsWith(`${bot.team}-`))
    .map((body) => {
      const dx = ball.x - body.x;
      const dy = ball.y - body.y;
      const distance = Math.max(1, Math.hypot(dx, dy));
      const dirX = dx / distance;
      const dirY = dy / distance;
      const alignment = dirX * desiredX + dirY * desiredY;
      return { body, distance, dirX, dirY, score: distance - alignment * 145 };
    })
    .sort((first, second) => first.score - second.score);
  const selected = candidates[0];
  if (!selected) return null;
  const error = (Math.random() - 0.5) * 0.09;
  const angle = Math.atan2(selected.dirY, selected.dirX) + error;
  return {
    bodyId: selected.body.id,
    dirX: Math.cos(angle),
    dirY: Math.sin(angle),
    pull: Math.min(90, 48 + selected.distance * 0.3 + Math.random() * 8),
  };
}

function botPlayerForTurn(room: MatchRoom) {
  return room.players.find((player) => player.isBot && player.team === room.activeTeam) ?? null;
}

function scheduleBotWake(matchId: string, dueAt: number) {
  cancelBotTimer(matchId);
  const timer = setTimeout(() => {
    hub.botTimers.delete(matchId);
    void withGameState((state) => advanceBotMatch(state, matchId)).catch((error) => {
      console.error("[FlickXI] Bot turn failed", error);
    });
  }, Math.max(0, dueAt - Date.now()));
  timer.unref?.();
  hub.botTimers.set(matchId, timer);
}

function prepareBotTurn(room: MatchRoom) {
  if (
    !roomSetupReady(room) ||
    !botPlayerForTurn(room) ||
    room.finished ||
    room.shotInProgress ||
    room.botAction
  ) return;
  room.botAction = {
    stage: "thinking",
    dueAt: Date.now() + BOT_THINK_MIN_MS + Math.random() * BOT_THINK_VARIANCE_MS,
    shot: null,
  };
  scheduleBotWake(room.id, room.botAction.dueAt);
}

function advanceBotMatch(state: GameState, matchId: string) {
  const outbound: OutboundEvent[] = [];
  const room = state.matches.get(matchId);
  if (!room?.botAction || !botPlayerForTurn(room) || room.finished || room.shotInProgress) {
    cancelBotTimer(matchId);
    return outbound;
  }
  const human = room.players.find((player) => !player.isBot);
  if (!human || human.disconnectedAt !== null) {
    room.botAction.dueAt = Date.now() + 1_000;
    scheduleBotWake(room.id, room.botAction.dueAt);
    return outbound;
  }
  if (Date.now() < room.botAction.dueAt) {
    scheduleBotWake(room.id, room.botAction.dueAt);
    return outbound;
  }

  if (room.botAction.stage === "thinking") {
    const shot = botShot(room);
    if (!shot) {
      room.botAction.dueAt = Date.now() + 1_000;
      scheduleBotWake(room.id, room.botAction.dueAt);
      return outbound;
    }
    room.botAction = {
      stage: "aiming",
      dueAt: Date.now() + BOT_AIM_MIN_MS + Math.random() * BOT_AIM_VARIANCE_MS,
      shot,
    };
    outbound.push(direct(human.socketId, "game:aim", {
      ...shot,
      serverTime: Date.now(),
    }));
    scheduleBotWake(room.id, room.botAction.dueAt);
    return outbound;
  }

  const shot = room.botAction.shot;
  room.botAction = null;
  if (!shot) return outbound;
  room.shotInProgress = true;
  room.sequence += 1;
  room.lastShot = {
    ...shot,
    sequence: room.sequence,
    serverTime: Date.now(),
  };
  outbound.push(direct(human.socketId, "game:aim-clear"));
  outbound.push(toMatch(room, "game:shot", room.lastShot));
  return outbound;
}

function scheduleBotFallback(entry: QueueEntry) {
  cancelQueueBotTimer(entry.clientId);
  const dueAt = (entry.queuedAt ?? Date.now()) + BOT_MATCH_DELAY_MS;
  const timer = setTimeout(() => {
    hub.queueBotTimers.delete(entry.clientId);
    void withGameState(async (state) => {
      const outbound: OutboundEvent[] = [];
      const index = state.queue.findIndex((candidate) => candidate.clientId === entry.clientId);
      if (index < 0) return outbound;
      const queued = state.queue[index];
      if (!queued || !(await connectionIsAlive(queued.socketId))) {
        state.queue.splice(index, 1);
        return outbound;
      }
      state.queue.splice(index, 1);
      const botId = randomUUID();
      startMatch(state, queued, {
        socketId: `bot-${botId}`,
        clientId: `bot-${botId}`,
        name: "FlickBot",
        isBot: true,
      }, outbound);
      return outbound;
    }).catch((error) => {
      console.error("[FlickXI] Bot matchmaking failed", error);
    });
  }, Math.max(0, dueAt - Date.now()));
  timer.unref?.();
  hub.queueBotTimers.set(entry.clientId, timer);
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

function validAim(payload: unknown, team: Team) {
  const value = record(payload);
  const bodyId = typeof value.bodyId === "string" ? value.bodyId : "";
  const dirX = Number(value.dirX);
  const dirY = Number(value.dirY);
  const pull = Number(value.pull);
  if (!bodyId.startsWith(`${team}-`)) return null;
  if (![dirX, dirY, pull].every(Number.isFinite)) return null;
  const length = Math.hypot(dirX, dirY);
  if (length < 0.8 || length > 1.2 || pull < 0 || pull > 92.5) return null;
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

function deleteMatch(state: GameState, room: MatchRoom) {
  cancelBotTimer(room.id);
  for (const player of room.players) {
    state.playerMatches.delete(player.socketId);
    state.clientMatches.delete(player.clientId);
  }
  state.matches.delete(room.id);
}

function leaveMatch(state: GameState, socketId: string) {
  const outbound: OutboundEvent[] = [];
  const room = getRoom(state, socketId);
  if (!room) return outbound;
  const opponent = room.players.find((candidate) => candidate.socketId !== socketId);
  if (opponent) outbound.push(direct(opponent.socketId, "match:opponent-left"));
  deleteMatch(state, room);
  return outbound;
}

async function resumeSession(
  state: GameState,
  socketId: string,
  value: Record<string, unknown>,
) {
  const outbound: OutboundEvent[] = [];
  const clientId = safeClientId(value.clientId, socketId);
  const reconnecting = value.reconnecting === true;
  const matchId = state.clientMatches.get(clientId);
  const room = matchId ? state.matches.get(matchId) : null;
  const player = room?.players.find((candidate) => candidate.clientId === clientId);

  if (room && player) {
    if (player.disconnectedAt && Date.now() - player.disconnectedAt > RECONNECT_GRACE_MS) {
      const opponent = room.players.find((candidate) => candidate.clientId !== clientId);
      if (opponent) outbound.push(direct(opponent.socketId, "match:opponent-left"));
      deleteMatch(state, room);
      outbound.push(direct(socketId, "session:expired", { message: "Reconnect time expired." }));
      return outbound;
    }

    const previousSocketId = player.socketId;
    state.playerMatches.delete(previousSocketId);
    player.socketId = socketId;
    player.disconnectedAt = null;
    state.playerMatches.set(socketId, room.id);
    if (room.rematchVotes.delete(previousSocketId)) room.rematchVotes.add(socketId);
    if (previousSocketId !== socketId) {
      outbound.push(direct(previousSocketId, "session:replaced"));
    }
    const info = matchInfo(room, player);
    outbound.push(direct(socketId, "session:resumed", { scope: "match" }));
    if (info) outbound.push(direct(socketId, "match:resumed", info));
    outbound.push(direct(socketId, "match:setup", roomSetupPayload(room)));
    outbound.push(direct(socketId, "chat:history", {
      matchId: room.id,
      messages: room.chatMessages ?? [],
    }));
    const opponent = room.players.find((candidate) => candidate.clientId !== clientId);
    if (opponent) outbound.push(direct(opponent.socketId, "match:opponent-returned"));
    if (room.lastSnapshot) {
      outbound.push(direct(socketId, "game:sync", {
        snapshot: room.lastSnapshot,
        sequence: room.snapshotSequence,
        serverTime: Date.now(),
      }));
    }
    if (room.lastShot) outbound.push(direct(socketId, "game:shot", room.lastShot));
    if (room.botAction) scheduleBotWake(room.id, room.botAction.dueAt);
    else prepareBotTurn(room);
    return outbound;
  }

  const queued = state.queue.find((entry) => entry.clientId === clientId);
  if (queued) {
    state.playerMatches.delete(queued.socketId);
    queued.socketId = socketId;
    scheduleBotFallback(queued);
    outbound.push(direct(socketId, "session:resumed", { scope: "queue" }));
    outbound.push(direct(socketId, "match:searching", { position: state.queue.indexOf(queued) + 1 }));
    return outbound;
  }

  const privateRoom = [...state.privateRooms.values()]
    .find((candidate) => candidate.host.clientId === clientId);
  if (privateRoom) {
    state.privateRoomByHost.delete(privateRoom.host.socketId);
    privateRoom.host.socketId = socketId;
    state.privateRoomByHost.set(socketId, privateRoom.code);
    outbound.push(direct(socketId, "session:resumed", { scope: "room" }));
    outbound.push(direct(socketId, "room:created", { code: privateRoom.code }));
    return outbound;
  }

  outbound.push(direct(socketId, reconnecting ? "session:expired" : "session:ready", {
    message: reconnecting ? "The previous match is no longer available." : undefined,
  }));
  return outbound;
}

async function handleEvent(state: GameState, socketId: string, event: string, payload: unknown) {
  const outbound: OutboundEvent[] = [];
  const value = record(payload);

  switch (event) {
    case "session:resume":
      return resumeSession(state, socketId, value);
    case "match:find": {
      if (state.playerMatches.has(socketId)) return outbound;
      const clientId = safeClientId(value.clientId, socketId);
      removeFromQueue(state, socketId);
      removeClientFromQueue(state, clientId);
      removePrivateRoomForHost(state, socketId, outbound, false);
      const fallback = `Player ${socketId.slice(0, 4).toUpperCase()}`;
      const entry = {
        socketId,
        clientId,
        name: safeName(value.name, fallback),
        queuedAt: Date.now(),
      };
      state.queue.push(entry);
      scheduleBotFallback(entry);
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
      const clientId = safeClientId(value.clientId, socketId);
      removeFromQueue(state, socketId);
      removeClientFromQueue(state, clientId);
      removePrivateRoomForHost(state, socketId, outbound, false);
      const fallback = `Player ${socketId.slice(0, 4).toUpperCase()}`;
      const code = createRoomCode(state);
      state.privateRooms.set(code, {
        code,
        host: { socketId, clientId, name: safeName(value.name, fallback) },
        createdAt: Date.now(),
      });
      state.privateRoomByHost.set(socketId, code);
      outbound.push(direct(socketId, "room:created", { code }));
      return outbound;
    }
    case "room:join": {
      if (state.playerMatches.has(socketId)) return outbound;
      const clientId = safeClientId(value.clientId, socketId);
      removeFromQueue(state, socketId);
      removeClientFromQueue(state, clientId);
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
      if (privateRoom.host.clientId === clientId) {
        outbound.push(direct(socketId, "room:error", {
          action: "join",
          message: "Share this code with a different player.",
        }));
        return outbound;
      }
      const fallback = `Player ${socketId.slice(0, 4).toUpperCase()}`;
      const guest = { socketId, clientId, name: safeName(value.name, fallback) };
      state.privateRooms.delete(code);
      state.privateRoomByHost.delete(privateRoom.host.socketId);
      startMatch(state, privateRoom.host, guest, outbound, code);
      return outbound;
    }
    case "room:cancel":
      removePrivateRoomForHost(state, socketId, outbound);
      outbound.push(direct(socketId, "room:cancelled"));
      return outbound;
    case "match:configure": {
      const room = getRoom(state, socketId);
      if (!room || room.shotInProgress || room.finished) return outbound;
      const player = room.players.find((candidate) => candidate.socketId === socketId);
      if (!player || player.isBot) return outbound;
      const countryCode = typeof value.countryCode === "string"
        ? value.countryCode.toUpperCase()
        : value.countryCode;
      if (!isCountryCode(countryCode) || !isFormationId(value.formation)) {
        outbound.push(direct(socketId, "game:error", {
          message: "Choose a valid country and formation.",
        }));
        return outbound;
      }
      player.countryCode = countryCode;
      player.formation = value.formation;
      const setup = roomSetupPayload(room);
      outbound.push(toMatch(room, "match:setup", setup));
      if (setup.ready) prepareBotTurn(room);
      return outbound;
    }
    case "chat:send": {
      const room = getRoom(state, socketId);
      if (!room) return outbound;
      const player = room.players.find((candidate) => candidate.socketId === socketId);
      if (!player || player.isBot || player.disconnectedAt !== null) return outbound;
      const text = safeChatText(value.text);
      const sentAt = Date.now();
      if (!text || sentAt - (player.lastChatAt ?? 0) < CHAT_COOLDOWN_MS) return outbound;
      player.lastChatAt = sentAt;
      const message: RealtimeChatMessage = {
        id: randomUUID(),
        matchId: room.id,
        senderTeam: player.team,
        senderName: player.name,
        text,
        sentAt,
      };
      room.chatMessages = [...(room.chatMessages ?? []), message].slice(-40);
      outbound.push(toMatch(room, "chat:message", message));
      return outbound;
    }
    case "reaction:send": {
      const room = getRoom(state, socketId);
      if (!room) return outbound;
      const player = room.players.find((candidate) => candidate.socketId === socketId);
      const emoji = typeof value.emoji === "string" ? value.emoji : "";
      const sentAt = Date.now();
      if (!player || player.isBot || player.disconnectedAt !== null || !ALLOWED_REACTIONS.has(emoji)) {
        return outbound;
      }
      if (sentAt - (player.lastReactionAt ?? 0) < REACTION_COOLDOWN_MS) return outbound;
      player.lastReactionAt = sentAt;
      outbound.push(toMatch(room, "reaction:show", {
        id: randomUUID(),
        matchId: room.id,
        senderTeam: player.team,
        emoji,
        sentAt,
      }));
      return outbound;
    }
    case "game:aim": {
      const room = getRoom(state, socketId);
      if (!room || !roomSetupReady(room) || room.shotInProgress || room.finished) return outbound;
      if (room.players.some((player) => player.disconnectedAt !== null)) return outbound;
      const player = room.players.find((candidate) => candidate.socketId === socketId);
      if (!player || player.team !== room.activeTeam) return outbound;
      const aim = validAim(payload, player.team);
      if (!aim) return outbound;
      const opponent = room.players.find((candidate) => candidate.socketId !== socketId);
      if (opponent) {
        outbound.push(direct(opponent.socketId, "game:aim", {
          ...aim,
          serverTime: Date.now(),
        }));
      }
      return outbound;
    }
    case "game:aim-clear": {
      const room = getRoom(state, socketId);
      if (!room || !roomSetupReady(room)) return outbound;
      const player = room.players.find((candidate) => candidate.socketId === socketId);
      if (!player || player.team !== room.activeTeam) return outbound;
      const opponent = room.players.find((candidate) => candidate.socketId !== socketId);
      if (opponent) outbound.push(direct(opponent.socketId, "game:aim-clear"));
      return outbound;
    }
    case "game:shoot": {
      const room = getRoom(state, socketId);
      if (!room || room.shotInProgress || room.finished) return outbound;
      if (!roomSetupReady(room)) {
        outbound.push(direct(socketId, "game:error", {
          message: "Waiting for both players to finish team setup.",
        }));
        return outbound;
      }
      if (room.players.some((player) => player.disconnectedAt !== null)) {
        outbound.push(direct(socketId, "game:error", {
          message: "Waiting for your opponent to reconnect.",
        }));
        return outbound;
      }
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
      room.lastShot = {
        ...shot,
        sequence: room.sequence,
        serverTime: Date.now(),
      };
      const opponent = room.players.find((candidate) => candidate.socketId !== socketId);
      if (opponent) outbound.push(direct(opponent.socketId, "game:aim-clear"));
      outbound.push(toMatch(room, "game:shot", room.lastShot));
      return outbound;
    }
    case "game:settled": {
      const room = getRoom(state, socketId);
      if (!room || value.matchId !== room.id || !validSnapshot(value.snapshot)) return outbound;
      const player = room.players.find((candidate) => candidate.socketId === socketId);
      const activePlayer = room.players.find((candidate) => candidate.team === room.activeTeam);
      const canSettleTurn = player && (
        player.team === room.activeTeam || (activePlayer?.isBot === true && player.isBot === false)
      );
      if (!canSettleTurn) return outbound;
      const snapshot = record(value.snapshot);
      room.activeTeam = snapshot.activeTeam as Team;
      room.finished = snapshot.phase === "finished";
      room.shotInProgress = false;
      room.lastSnapshot = value.snapshot;
      room.snapshotSequence = room.sequence;
      room.lastShot = null;
      room.botAction = null;
      cancelBotTimer(room.id);
      outbound.push(toMatch(room, "game:sync", {
        snapshot: value.snapshot,
        sequence: room.sequence,
        serverTime: Date.now(),
      }));
      prepareBotTurn(room);
      return outbound;
    }
    case "match:rematch": {
      const room = getRoom(state, socketId);
      if (!room || !room.finished) return outbound;
      room.rematchVotes.add(socketId);
      const bot = room.players.find((player) => player.isBot);
      if (bot) room.rematchVotes.add(bot.socketId);
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
        room.lastSnapshot = null;
        room.snapshotSequence = room.sequence;
        room.lastShot = null;
        room.botAction = null;
        outbound.push(toMatch(room, "match:reset", {
          activeTeam: room.activeTeam,
          sequence: room.sequence,
        }));
        prepareBotTurn(room);
      }
      return outbound;
    }
    case "match:leave":
      outbound.push(...leaveMatch(state, socketId));
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
    const player = room.players.find((candidate) => candidate.socketId === socketId);
    if (!player) return outbound;
    state.playerMatches.delete(socketId);
    player.disconnectedAt = Date.now();
    const opponent = room.players.find((candidate) => candidate.clientId !== player.clientId);
    if (opponent) {
      outbound.push(direct(opponent.socketId, "match:opponent-reconnecting", {
        graceMs: RECONNECT_GRACE_MS,
      }));
    }
  }
  return outbound;
}

async function pruneDisconnected(state: GameState) {
  const outbound: OutboundEvent[] = [];
  const queueStatus = await Promise.all(state.queue.map((entry) => connectionIsAlive(entry.socketId)));
  state.queue = state.queue.filter((entry, index) => {
    if (queueStatus[index]) {
      if (!hub.queueBotTimers.has(entry.clientId)) scheduleBotFallback(entry);
      return true;
    }
    cancelQueueBotTimer(entry.clientId);
    return false;
  });

  for (const [code, room] of state.privateRooms) {
    if (await connectionIsAlive(room.host.socketId)) continue;
    state.privateRooms.delete(code);
    state.privateRoomByHost.delete(room.host.socketId);
  }

  for (const room of state.matches.values()) {
    const alive = await Promise.all(room.players.map((player) =>
      player.isBot ? Promise.resolve(true) : connectionIsAlive(player.socketId)
    ));
    room.players.forEach((player, index) => {
      if (!alive[index] && player.disconnectedAt === null) {
        state.playerMatches.delete(player.socketId);
        player.disconnectedAt = Date.now();
        const opponent = room.players[1 - index];
        if (alive[1 - index]) {
          outbound.push(direct(opponent.socketId, "match:opponent-reconnecting", {
            graceMs: RECONNECT_GRACE_MS,
          }));
        }
      }
    });
    const expired = room.players.some((player) =>
      player.disconnectedAt !== null && Date.now() - player.disconnectedAt > RECONNECT_GRACE_MS
    );
    if (!expired) continue;
    room.players.forEach((player, index) => {
      if (alive[index]) outbound.push(direct(player.socketId, "match:opponent-left"));
    });
    deleteMatch(state, room);
  }
  for (const room of state.matches.values()) {
    if (room.botAction && !hub.botTimers.has(room.id)) {
      scheduleBotWake(room.id, room.botAction.dueAt);
    } else if (!room.botAction) {
      prepareBotTurn(room);
    }
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
  try {
    if (realtimeRedis) await Promise.all([...hub.sockets.keys()].map(touchConnection));
    await withGameState(pruneDisconnected);
  } catch (error) {
    console.error("[FlickXI] Realtime heartbeat failed", error);
  }
}

function startRedisInfrastructure() {
  if (!hub.heartbeat) hub.heartbeat = setInterval(() => void heartbeat(), HEARTBEAT_MS);
  if (!realtimeRedis) return;
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

export async function getOnlinePlayerCount() {
  const state = realtimeRedis
    ? deserializeState(await realtimeRedis.get(STATE_KEY))
    : hub.memoryState;
  const activeHumanSocketIds = new Set<string>();

  for (const room of state.matches.values()) {
    if (room.finished) continue;
    for (const player of room.players) {
      if (!player.isBot) activeHumanSocketIds.add(player.socketId);
    }
  }

  const connected = await Promise.all(
    [...activeHumanSocketIds].map((socketId) => connectionIsAlive(socketId)),
  );
  return connected.filter(Boolean).length;
}

async function unregisterGameSocket(socket: WebSocket) {
  const socketId = hub.socketIds.get(socket);
  if (!socketId) return;
  await hub.socketTasks.get(socketId)?.catch(() => undefined);
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

  socket.on("message", (data) => {
    const previous = hub.socketTasks.get(socketId) ?? Promise.resolve();
    const task = previous.then(() => processClientFrame(socketId, data));
    hub.socketTasks.set(socketId, task);
    void task.finally(() => {
      if (hub.socketTasks.get(socketId) === task) hub.socketTasks.delete(socketId);
    });
  });
  let unregistered = false;
  const unregister = () => {
    if (unregistered) return;
    unregistered = true;
    void unregisterGameSocket(socket);
  };
  socket.once("close", unregister);
  socket.once("error", unregister);
}
