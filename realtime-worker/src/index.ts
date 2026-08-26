import { DurableObject } from "cloudflare:workers";
import {
  BOT_PLAYER_SETUP,
  DEFAULT_PLAYER_SETUP,
  isAttackingFormationId,
  isCountryCode,
  isDefensiveFormationId,
  isFormationId,
  type AttackingFormationId,
  type DefensiveFormationId,
  type FormationId,
  type PlayerSetup,
  type Team,
} from "../../src/lib/match-setup.ts";

type Env = {
  GAME_HUB: DurableObjectNamespace<GameHub>;
  ALLOWED_ORIGINS?: string;
};

type SocketAttachment = {
  socketId: string;
};

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
  attackingFormation?: AttackingFormationId;
  defensiveFormation?: DefensiveFormationId;
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

type HandlerResult = {
  outbound: OutboundEvent[];
  dirty: boolean;
  close?: boolean;
};

type BotBody = { id: string; x: number; y: number };

const STATE_KEY = "game-state-v1";
const ROOM_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const RECONNECT_GRACE_MS = 90_000;
const BOT_MATCH_DELAY_MS = 6_000;
const BOT_THINK_MIN_MS = 650;
const BOT_THINK_VARIANCE_MS = 550;
const BOT_AIM_MIN_MS = 700;
const BOT_AIM_VARIANCE_MS = 450;
const CHAT_MAX_LENGTH = 160;
const CHAT_COOLDOWN_MS = 650;
const REACTION_COOLDOWN_MS = 500;
const ALLOWED_REACTIONS = new Set([
  "\u26BD",
  "\u{1F525}",
  "\u{1F44F}",
  "\u{1F602}",
  "\u{1F62E}",
  "\u{1F49A}",
]);

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

function saveGameState(state: GameState): SavedGameState {
  return {
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
}

function restoreGameState(saved: SavedGameState | null): GameState {
  if (!saved) return createGameState();
  try {
    return {
      queue: Array.isArray(saved.queue) ? saved.queue : [],
      matches: new Map((Array.isArray(saved.matches) ? saved.matches : []).map((room) => [
        room.id,
        {
          ...room,
          players: room.players.map((player) => ({
            ...player,
            isBot: player.isBot === true,
          })) as [Player, Player],
          botAction: room.botAction ?? null,
          chatMessages: Array.isArray(room.chatMessages) ? room.chatMessages : [],
          rematchVotes: new Set(room.rematchVotes),
        },
      ])),
      playerMatches: new Map(Array.isArray(saved.playerMatches) ? saved.playerMatches : []),
      clientMatches: new Map(Array.isArray(saved.clientMatches) ? saved.clientMatches : []),
      privateRooms: new Map(Array.isArray(saved.privateRooms) ? saved.privateRooms : []),
      privateRoomByHost: new Map(Array.isArray(saved.privateRoomByHost) ? saved.privateRoomByHost : []),
    };
  } catch (error) {
    console.error("[FlickXI Worker] Could not restore match state", error);
    return createGameState();
  }
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? value as Record<string, unknown> : {};
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

function removeFromQueue(state: GameState, socketId: string) {
  const index = state.queue.findIndex((entry) => entry.socketId === socketId);
  if (index < 0) return false;
  state.queue.splice(index, 1);
  return true;
}

function removeClientFromQueue(state: GameState, clientId: string) {
  state.queue = state.queue.filter((entry) => entry.clientId !== clientId);
}

function removePrivateRoomForHost(
  state: GameState,
  socketId: string,
  outbound: OutboundEvent[],
  notify = true,
) {
  const code = state.privateRoomByHost.get(socketId);
  if (!code) return false;
  state.privateRoomByHost.delete(socketId);
  state.privateRooms.delete(code);
  if (notify) outbound.push(direct(socketId, "room:closed"));
  return true;
}

function createRoomCode(state: GameState) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    let code = "";
    for (let index = 0; index < 6; index += 1) {
      code += ROOM_ALPHABET[Math.floor(Math.random() * ROOM_ALPHABET.length)];
    }
    if (!state.privateRooms.has(code)) return code;
  }
  return crypto.randomUUID().replaceAll("-", "").slice(0, 6).toUpperCase();
}

function cleanRoomCode(value: unknown) {
  if (typeof value !== "string") return "";
  return value.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 6);
}

function playerSetup(player: Player): PlayerSetup | null {
  if (!isCountryCode(player.countryCode)) return null;
  const hasStoredFormation = isAttackingFormationId(player.attackingFormation) ||
    isDefensiveFormationId(player.defensiveFormation) ||
    isFormationId(player.formation);
  if (!hasStoredFormation) return null;

  return {
    countryCode: player.countryCode.toUpperCase(),
    attackingFormation: isAttackingFormationId(player.attackingFormation)
      ? player.attackingFormation
      : isAttackingFormationId(player.formation)
        ? player.formation
        : DEFAULT_PLAYER_SETUP.attackingFormation,
    defensiveFormation: isDefensiveFormationId(player.defensiveFormation)
      ? player.defensiveFormation
      : isDefensiveFormationId(player.formation)
        ? player.formation
        : DEFAULT_PLAYER_SETUP.defensiveFormation,
  };
}

function publicPlayer(player: Player) {
  return {
    name: player.name,
    team: player.team,
    isBot: player.isBot,
    ...playerSetup(player),
  };
}

function roomSetupReady(room: MatchRoom) {
  return room.players.every((player) => playerSetup(player) !== null);
}

function roomSetupPayload(room: MatchRoom) {
  const mint = room.players.find((player) => player.team === "mint");
  const coral = room.players.find((player) => player.team === "coral");
  const players = {
    mint: mint ? playerSetup(mint) : null,
    coral: coral ? playerSetup(coral) : null,
  };
  const ready = players.mint !== null && players.coral !== null;
  return {
    matchId: room.id,
    players,
    ready,
    startsAt: ready ? Date.now() + 350 : null,
  };
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
    const angle = Math.atan2(goal.y - ball.y, goal.x - ball.x) + (Math.random() - 0.5) * 0.055;
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
  const selected = bodies
    .filter((body) => body.id.startsWith(`${bot.team}-`))
    .map((body) => {
      const dx = ball.x - body.x;
      const dy = ball.y - body.y;
      const distance = Math.max(1, Math.hypot(dx, dy));
      const dirX = dx / distance;
      const dirY = dy / distance;
      return {
        body,
        distance,
        dirX,
        dirY,
        score: distance - (dirX * desiredX + dirY * desiredY) * 145,
      };
    })
    .sort((first, second) => first.score - second.score)[0];
  if (!selected) return null;
  const angle = Math.atan2(selected.dirY, selected.dirX) + (Math.random() - 0.5) * 0.09;
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
}

function advanceBotMatch(state: GameState, matchId: string) {
  const outbound: OutboundEvent[] = [];
  const room = state.matches.get(matchId);
  if (!room?.botAction || !botPlayerForTurn(room) || room.finished || room.shotInProgress) {
    if (room) room.botAction = null;
    return outbound;
  }
  const human = room.players.find((player) => !player.isBot);
  if (!human || human.disconnectedAt !== null) {
    room.botAction.dueAt = Date.now() + 1_000;
    return outbound;
  }
  if (Date.now() < room.botAction.dueAt) return outbound;

  if (room.botAction.stage === "thinking") {
    const shot = botShot(room);
    if (!shot) {
      room.botAction.dueAt = Date.now() + 1_000;
      return outbound;
    }
    room.botAction = {
      stage: "aiming",
      dueAt: Date.now() + BOT_AIM_MIN_MS + Math.random() * BOT_AIM_VARIANCE_MS,
      shot,
    };
    outbound.push(direct(human.socketId, "game:aim", { ...shot, serverTime: Date.now() }));
    return outbound;
  }

  const shot = room.botAction.shot;
  room.botAction = null;
  if (!shot) return outbound;
  room.shotInProgress = true;
  room.sequence += 1;
  room.lastShot = { ...shot, sequence: room.sequence, serverTime: Date.now() };
  outbound.push(direct(human.socketId, "game:aim-clear"));
  outbound.push(toMatch(room, "game:shot", room.lastShot));
  return outbound;
}

function validShot(payload: unknown, team: Team) {
  const value = record(payload);
  const bodyId = typeof value.bodyId === "string" ? value.bodyId : "";
  const dirX = Number(value.dirX);
  const dirY = Number(value.dirY);
  const pull = Number(value.pull);
  if (!bodyId.startsWith(`${team}-`) || ![dirX, dirY, pull].every(Number.isFinite)) return null;
  const length = Math.hypot(dirX, dirY);
  if (length < 0.8 || length > 1.2 || pull < 8 || pull > 92.5) return null;
  return { bodyId, dirX: dirX / length, dirY: dirY / length, pull: Math.min(92, pull) };
}

function validAim(payload: unknown, team: Team) {
  const value = record(payload);
  const bodyId = typeof value.bodyId === "string" ? value.bodyId : "";
  const dirX = Number(value.dirX);
  const dirY = Number(value.dirY);
  const pull = Number(value.pull);
  if (!bodyId.startsWith(`${team}-`) || ![dirX, dirY, pull].every(Number.isFinite)) return null;
  const length = Math.hypot(dirX, dirY);
  if (length < 0.8 || length > 1.2 || pull < 0 || pull > 92.5) return null;
  return { bodyId, dirX: dirX / length, dirY: dirY / length, pull: Math.min(92, pull) };
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

function originAllowed(request: Request, env: Env) {
  const configured = env.ALLOWED_ORIGINS?.split(",").map((origin) => origin.trim()).filter(Boolean) ?? [];
  if (configured.length === 0 || configured.includes("*")) return true;
  const origin = request.headers.get("Origin");
  return !origin || configured.includes(origin);
}

export class GameHub extends DurableObject<Env> {
  private state = createGameState();
  private ready: Promise<void>;
  private operation: Promise<void> = Promise.resolve();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.ready = this.ctx.blockConcurrencyWhile(async () => {
      const saved = await this.ctx.storage.get<SavedGameState>(STATE_KEY);
      this.state = restoreGameState(saved ?? null);
    });
  }

  async fetch(request: Request) {
    await this.ready;
    const url = new URL(request.url);
    if (url.pathname === "/presence") {
      return Response.json(
        { players: this.onlinePlayerCount() },
        { headers: { "Cache-Control": "no-store, max-age=0" } },
      );
    }
    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
      return Response.json({ error: "WebSocket upgrade required" }, { status: 426 });
    }

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    const socketId = crypto.randomUUID();
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({ socketId } satisfies SocketAttachment);
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(socket: WebSocket, message: string | ArrayBuffer) {
    const run = this.operation.then(() => this.processMessage(socket, message));
    this.operation = run.catch(() => undefined);
    await run;
  }

  async webSocketClose(socket: WebSocket) {
    const run = this.operation.then(() => this.disconnectSocket(socket));
    this.operation = run.catch(() => undefined);
    await run;
  }

  async webSocketError(socket: WebSocket) {
    const run = this.operation.then(() => this.disconnectSocket(socket));
    this.operation = run.catch(() => undefined);
    await run;
  }

  async alarm() {
    const run = this.operation.then(() => this.runScheduledWork());
    this.operation = run.catch(() => undefined);
    await run;
  }

  private socketId(socket: WebSocket) {
    const attachment = socket.deserializeAttachment() as SocketAttachment | null;
    return typeof attachment?.socketId === "string" ? attachment.socketId : null;
  }

  private socketForId(socketId: string) {
    return this.ctx.getWebSockets().find((socket) => this.socketId(socket) === socketId) ?? null;
  }

  private isConnected(socketId: string) {
    return this.socketForId(socketId)?.readyState === 1;
  }

  private send(socketId: string, event: string, payload?: unknown) {
    const socket = this.socketForId(socketId);
    if (!socket || socket.readyState !== 1) return;
    try {
      socket.send(JSON.stringify({ event, payload }));
    } catch {
      // The close callback performs match cleanup.
    }
  }

  private deliver(events: OutboundEvent[]) {
    for (const outbound of events) {
      for (const target of outbound.targets) this.send(target, outbound.event, outbound.payload);
    }
  }

  private async persist() {
    await this.ctx.storage.put(STATE_KEY, saveGameState(this.state));
  }

  private async scheduleNextAlarm() {
    let nextAt = Number.POSITIVE_INFINITY;
    for (const entry of this.state.queue) {
      nextAt = Math.min(nextAt, (entry.queuedAt ?? Date.now()) + BOT_MATCH_DELAY_MS);
    }
    for (const room of this.state.matches.values()) {
      if (room.botAction) nextAt = Math.min(nextAt, room.botAction.dueAt);
      for (const player of room.players) {
        if (player.disconnectedAt !== null) {
          nextAt = Math.min(nextAt, player.disconnectedAt + RECONNECT_GRACE_MS);
        }
      }
    }

    const existing = await this.ctx.storage.getAlarm();
    if (!Number.isFinite(nextAt)) {
      if (existing !== null) await this.ctx.storage.deleteAlarm();
      return;
    }
    const scheduled = Math.max(Date.now() + 50, Math.ceil(nextAt));
    if (existing === null || Math.abs(existing - scheduled) > 25) {
      await this.ctx.storage.setAlarm(scheduled);
    }
  }

  private startMatch(
    firstEntry: QueueEntry,
    secondEntry: QueueEntry,
    outbound: OutboundEvent[],
    privateCode: string | null = null,
  ) {
    const matchId = crypto.randomUUID();
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
    this.state.matches.set(matchId, room);
    for (const player of room.players) {
      if (player.isBot) continue;
      this.state.playerMatches.set(player.socketId, matchId);
      this.state.clientMatches.set(player.clientId, matchId);
    }
    for (const player of room.players.filter((candidate) => !candidate.isBot)) {
      const info = matchInfo(room, player);
      if (info) outbound.push(direct(player.socketId, "match:found", info));
    }
    prepareBotTurn(room);
  }

  private attemptMatchmaking(outbound: OutboundEvent[]) {
    while (this.state.queue.length >= 2) {
      const first = this.state.queue.shift();
      const second = this.state.queue.shift();
      if (!first || !second) return;
      const firstConnected = this.isConnected(first.socketId);
      const secondConnected = this.isConnected(second.socketId);
      if (!firstConnected || this.state.playerMatches.has(first.socketId)) {
        if (secondConnected && !this.state.playerMatches.has(second.socketId)) {
          this.state.queue.unshift(second);
        }
        continue;
      }
      if (!secondConnected || this.state.playerMatches.has(second.socketId)) {
        this.state.queue.unshift(first);
        continue;
      }
      this.startMatch(first, second, outbound);
    }
  }

  private resumeSession(socketId: string, value: Record<string, unknown>): HandlerResult {
    const outbound: OutboundEvent[] = [];
    const clientId = safeClientId(value.clientId, socketId);
    const reconnecting = value.reconnecting === true;
    const matchId = this.state.clientMatches.get(clientId);
    const room = matchId ? this.state.matches.get(matchId) : null;
    const player = room?.players.find((candidate) => candidate.clientId === clientId);

    if (room && player) {
      if (player.disconnectedAt && Date.now() - player.disconnectedAt > RECONNECT_GRACE_MS) {
        const opponent = room.players.find((candidate) => candidate.clientId !== clientId);
        if (opponent) outbound.push(direct(opponent.socketId, "match:opponent-left"));
        deleteMatch(this.state, room);
        outbound.push(direct(socketId, "session:expired", { message: "Reconnect time expired." }));
        return { outbound, dirty: true };
      }
      const previousSocketId = player.socketId;
      this.state.playerMatches.delete(previousSocketId);
      player.socketId = socketId;
      player.disconnectedAt = null;
      this.state.playerMatches.set(socketId, room.id);
      if (room.rematchVotes.delete(previousSocketId)) room.rematchVotes.add(socketId);
      if (previousSocketId !== socketId) outbound.push(direct(previousSocketId, "session:replaced"));
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
      if (!room.botAction) prepareBotTurn(room);
      return { outbound, dirty: true };
    }

    const queued = this.state.queue.find((entry) => entry.clientId === clientId);
    if (queued) {
      queued.socketId = socketId;
      outbound.push(direct(socketId, "session:resumed", { scope: "queue" }));
      outbound.push(direct(socketId, "match:searching", {
        position: this.state.queue.indexOf(queued) + 1,
      }));
      return { outbound, dirty: true };
    }

    const privateRoom = [...this.state.privateRooms.values()]
      .find((candidate) => candidate.host.clientId === clientId);
    if (privateRoom) {
      this.state.privateRoomByHost.delete(privateRoom.host.socketId);
      privateRoom.host.socketId = socketId;
      this.state.privateRoomByHost.set(socketId, privateRoom.code);
      outbound.push(direct(socketId, "session:resumed", { scope: "room" }));
      outbound.push(direct(socketId, "room:created", { code: privateRoom.code }));
      return { outbound, dirty: true };
    }

    outbound.push(direct(socketId, reconnecting ? "session:expired" : "session:ready", {
      message: reconnecting ? "The previous match is no longer available." : undefined,
    }));
    return { outbound, dirty: false };
  }

  private handleEvent(socketId: string, event: string, payload: unknown): HandlerResult {
    const outbound: OutboundEvent[] = [];
    const value = record(payload);

    switch (event) {
      case "session:resume":
        return this.resumeSession(socketId, value);
      case "match:find": {
        if (this.state.playerMatches.has(socketId)) return { outbound, dirty: false };
        const clientId = safeClientId(value.clientId, socketId);
        removeFromQueue(this.state, socketId);
        removeClientFromQueue(this.state, clientId);
        removePrivateRoomForHost(this.state, socketId, outbound, false);
        this.state.queue.push({
          socketId,
          clientId,
          name: safeName(value.name, `Player ${socketId.slice(0, 4).toUpperCase()}`),
          queuedAt: Date.now(),
        });
        outbound.push(direct(socketId, "match:searching", { position: this.state.queue.length }));
        this.attemptMatchmaking(outbound);
        return { outbound, dirty: true };
      }
      case "match:cancel":
        removeFromQueue(this.state, socketId);
        outbound.push(direct(socketId, "match:cancelled"));
        return { outbound, dirty: true };
      case "room:create": {
        if (this.state.playerMatches.has(socketId)) return { outbound, dirty: false };
        const clientId = safeClientId(value.clientId, socketId);
        removeFromQueue(this.state, socketId);
        removeClientFromQueue(this.state, clientId);
        removePrivateRoomForHost(this.state, socketId, outbound, false);
        const code = createRoomCode(this.state);
        this.state.privateRooms.set(code, {
          code,
          host: {
            socketId,
            clientId,
            name: safeName(value.name, `Player ${socketId.slice(0, 4).toUpperCase()}`),
          },
          createdAt: Date.now(),
        });
        this.state.privateRoomByHost.set(socketId, code);
        outbound.push(direct(socketId, "room:created", { code }));
        return { outbound, dirty: true };
      }
      case "room:join": {
        if (this.state.playerMatches.has(socketId)) return { outbound, dirty: false };
        const clientId = safeClientId(value.clientId, socketId);
        removeFromQueue(this.state, socketId);
        removeClientFromQueue(this.state, clientId);
        const code = cleanRoomCode(value.code);
        if (code.length !== 6) {
          outbound.push(direct(socketId, "room:error", {
            action: "join",
            message: "Enter a valid 6-character room code.",
          }));
          return { outbound, dirty: true };
        }
        const privateRoom = this.state.privateRooms.get(code);
        if (!privateRoom || !this.isConnected(privateRoom.host.socketId)) {
          if (privateRoom) {
            this.state.privateRooms.delete(code);
            this.state.privateRoomByHost.delete(privateRoom.host.socketId);
          }
          outbound.push(direct(socketId, "room:error", {
            action: "join",
            message: "Room not found or no longer available.",
          }));
          return { outbound, dirty: true };
        }
        if (privateRoom.host.clientId === clientId) {
          outbound.push(direct(socketId, "room:error", {
            action: "join",
            message: "Share this code with a different player.",
          }));
          return { outbound, dirty: false };
        }
        const guest = {
          socketId,
          clientId,
          name: safeName(value.name, `Player ${socketId.slice(0, 4).toUpperCase()}`),
        };
        this.state.privateRooms.delete(code);
        this.state.privateRoomByHost.delete(privateRoom.host.socketId);
        this.startMatch(privateRoom.host, guest, outbound, code);
        return { outbound, dirty: true };
      }
      case "room:cancel":
        removePrivateRoomForHost(this.state, socketId, outbound);
        outbound.push(direct(socketId, "room:cancelled"));
        return { outbound, dirty: true };
      case "match:configure": {
        const room = getRoom(this.state, socketId);
        if (!room || room.shotInProgress || room.finished) return { outbound, dirty: false };
        const player = room.players.find((candidate) => candidate.socketId === socketId);
        if (!player || player.isBot) return { outbound, dirty: false };
        const countryCode = typeof value.countryCode === "string"
          ? value.countryCode.toUpperCase()
          : value.countryCode;
        if (
          !isCountryCode(countryCode) ||
          !isAttackingFormationId(value.attackingFormation) ||
          !isDefensiveFormationId(value.defensiveFormation)
        ) {
          outbound.push(direct(socketId, "game:error", {
            message: "Choose a valid country and formation.",
          }));
          return { outbound, dirty: false };
        }
        player.countryCode = countryCode;
        player.attackingFormation = value.attackingFormation;
        player.defensiveFormation = value.defensiveFormation;
        player.formation = undefined;
        const setup = roomSetupPayload(room);
        outbound.push(toMatch(room, "match:setup", setup));
        if (setup.ready) prepareBotTurn(room);
        return { outbound, dirty: true };
      }
      case "chat:send": {
        const room = getRoom(this.state, socketId);
        const player = room?.players.find((candidate) => candidate.socketId === socketId);
        if (!room || !player || player.isBot || player.disconnectedAt !== null) {
          return { outbound, dirty: false };
        }
        const text = safeChatText(value.text);
        const sentAt = Date.now();
        if (!text || sentAt - (player.lastChatAt ?? 0) < CHAT_COOLDOWN_MS) {
          return { outbound, dirty: false };
        }
        player.lastChatAt = sentAt;
        const message: RealtimeChatMessage = {
          id: crypto.randomUUID(),
          matchId: room.id,
          senderTeam: player.team,
          senderName: player.name,
          text,
          sentAt,
        };
        room.chatMessages = [...room.chatMessages, message].slice(-40);
        outbound.push(toMatch(room, "chat:message", message));
        return { outbound, dirty: true };
      }
      case "reaction:send": {
        const room = getRoom(this.state, socketId);
        const player = room?.players.find((candidate) => candidate.socketId === socketId);
        const emoji = typeof value.emoji === "string" ? value.emoji : "";
        const sentAt = Date.now();
        if (
          !room || !player || player.isBot || player.disconnectedAt !== null ||
          !ALLOWED_REACTIONS.has(emoji) || sentAt - (player.lastReactionAt ?? 0) < REACTION_COOLDOWN_MS
        ) return { outbound, dirty: false };
        player.lastReactionAt = sentAt;
        outbound.push(toMatch(room, "reaction:show", {
          id: crypto.randomUUID(),
          matchId: room.id,
          senderTeam: player.team,
          emoji,
          sentAt,
        }));
        return { outbound, dirty: true };
      }
      case "game:aim": {
        const room = getRoom(this.state, socketId);
        if (!room || !roomSetupReady(room) || room.shotInProgress || room.finished) {
          return { outbound, dirty: false };
        }
        if (room.players.some((player) => player.disconnectedAt !== null)) {
          return { outbound, dirty: false };
        }
        const player = room.players.find((candidate) => candidate.socketId === socketId);
        if (!player || player.team !== room.activeTeam) return { outbound, dirty: false };
        const aim = validAim(payload, player.team);
        if (!aim) return { outbound, dirty: false };
        const opponent = room.players.find((candidate) => candidate.socketId !== socketId);
        if (opponent) {
          outbound.push(direct(opponent.socketId, "game:aim", { ...aim, serverTime: Date.now() }));
        }
        return { outbound, dirty: false };
      }
      case "game:aim-clear": {
        const room = getRoom(this.state, socketId);
        const player = room?.players.find((candidate) => candidate.socketId === socketId);
        if (!room || !roomSetupReady(room) || !player || player.team !== room.activeTeam) {
          return { outbound, dirty: false };
        }
        const opponent = room.players.find((candidate) => candidate.socketId !== socketId);
        if (opponent) outbound.push(direct(opponent.socketId, "game:aim-clear"));
        return { outbound, dirty: false };
      }
      case "game:shoot": {
        const room = getRoom(this.state, socketId);
        if (!room || room.shotInProgress || room.finished) return { outbound, dirty: false };
        if (!roomSetupReady(room)) {
          outbound.push(direct(socketId, "game:error", {
            message: "Waiting for both players to finish team setup.",
          }));
          return { outbound, dirty: false };
        }
        if (room.players.some((player) => player.disconnectedAt !== null)) {
          outbound.push(direct(socketId, "game:error", {
            message: "Waiting for your opponent to reconnect.",
          }));
          return { outbound, dirty: false };
        }
        const player = room.players.find((candidate) => candidate.socketId === socketId);
        if (!player || player.team !== room.activeTeam) {
          outbound.push(direct(socketId, "game:error", { message: "It is not your turn." }));
          return { outbound, dirty: false };
        }
        const shot = validShot(payload, player.team);
        if (!shot) {
          outbound.push(direct(socketId, "game:error", { message: "That shot was rejected." }));
          return { outbound, dirty: false };
        }
        room.shotInProgress = true;
        room.sequence += 1;
        room.lastShot = { ...shot, sequence: room.sequence, serverTime: Date.now() };
        const opponent = room.players.find((candidate) => candidate.socketId !== socketId);
        if (opponent) outbound.push(direct(opponent.socketId, "game:aim-clear"));
        outbound.push(toMatch(room, "game:shot", room.lastShot));
        return { outbound, dirty: true };
      }
      case "game:settled": {
        const room = getRoom(this.state, socketId);
        if (!room || value.matchId !== room.id || !validSnapshot(value.snapshot)) {
          return { outbound, dirty: false };
        }
        const player = room.players.find((candidate) => candidate.socketId === socketId);
        const activePlayer = room.players.find((candidate) => candidate.team === room.activeTeam);
        const canSettle = player && (
          player.team === room.activeTeam || (activePlayer?.isBot === true && player.isBot === false)
        );
        if (!canSettle) return { outbound, dirty: false };
        const snapshot = record(value.snapshot);
        room.activeTeam = snapshot.activeTeam as Team;
        room.finished = snapshot.phase === "finished";
        room.shotInProgress = false;
        room.lastSnapshot = value.snapshot;
        room.snapshotSequence = room.sequence;
        room.lastShot = null;
        room.botAction = null;
        outbound.push(toMatch(room, "game:sync", {
          snapshot: value.snapshot,
          sequence: room.sequence,
          serverTime: Date.now(),
        }));
        prepareBotTurn(room);
        return { outbound, dirty: true };
      }
      case "match:rematch": {
        const room = getRoom(this.state, socketId);
        if (!room || !room.finished) return { outbound, dirty: false };
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
        return { outbound, dirty: true };
      }
      case "match:leave":
        outbound.push(...leaveMatch(this.state, socketId));
        return { outbound, dirty: true, close: true };
      default:
        return { outbound, dirty: false };
    }
  }

  private async processMessage(socket: WebSocket, raw: string | ArrayBuffer) {
    await this.ready;
    const socketId = this.socketId(socket);
    if (!socketId) return;
    try {
      const text = typeof raw === "string" ? raw : new TextDecoder().decode(raw);
      const message = JSON.parse(text) as Partial<ClientEnvelope>;
      if (typeof message.event !== "string") return;
      const result = this.handleEvent(socketId, message.event, message.payload);
      if (result.dirty) {
        await this.persist();
        await this.scheduleNextAlarm();
      }
      this.deliver(result.outbound);
      if (result.close && socket.readyState === 1) socket.close(1000, "Player left match");
    } catch (error) {
      console.error("[FlickXI Worker] Could not process realtime event", error);
      this.send(socketId, "server:error", {
        message: "The realtime service is temporarily unavailable. Try again.",
      });
    }
  }

  private cleanupSocket(socketId: string) {
    const outbound: OutboundEvent[] = [];
    const removedFromQueue = removeFromQueue(this.state, socketId);
    const removedPrivateRoom = removePrivateRoomForHost(this.state, socketId, outbound, false);
    const matchId = this.state.playerMatches.get(socketId);
    if (!matchId) return { outbound, dirty: removedFromQueue || removedPrivateRoom };
    const room = this.state.matches.get(matchId);
    const player = room?.players.find((candidate) => candidate.socketId === socketId);
    if (!room || !player) return { outbound, dirty: false };
    this.state.playerMatches.delete(socketId);
    player.disconnectedAt = Date.now();
    const opponent = room.players.find((candidate) => candidate.clientId !== player.clientId);
    if (opponent) {
      outbound.push(direct(opponent.socketId, "match:opponent-reconnecting", {
        graceMs: RECONNECT_GRACE_MS,
      }));
    }
    return { outbound, dirty: true };
  }

  private async disconnectSocket(socket: WebSocket) {
    await this.ready;
    const socketId = this.socketId(socket);
    if (!socketId) return;
    const result = this.cleanupSocket(socketId);
    if (!result.dirty) return;
    await this.persist();
    await this.scheduleNextAlarm();
    this.deliver(result.outbound);
  }

  private async runScheduledWork() {
    await this.ready;
    const outbound: OutboundEvent[] = [];
    const now = Date.now();

    this.state.queue = this.state.queue.filter((entry) => this.isConnected(entry.socketId));
    for (const [code, room] of this.state.privateRooms) {
      if (this.isConnected(room.host.socketId)) continue;
      this.state.privateRooms.delete(code);
      this.state.privateRoomByHost.delete(room.host.socketId);
    }

    for (const room of [...this.state.matches.values()]) {
      for (const player of room.players) {
        if (player.isBot || this.isConnected(player.socketId) || player.disconnectedAt !== null) continue;
        this.state.playerMatches.delete(player.socketId);
        player.disconnectedAt = now;
        const opponent = room.players.find((candidate) => candidate.clientId !== player.clientId);
        if (opponent) {
          outbound.push(direct(opponent.socketId, "match:opponent-reconnecting", {
            graceMs: RECONNECT_GRACE_MS,
          }));
        }
      }
      const expired = room.players.some((player) =>
        player.disconnectedAt !== null && now - player.disconnectedAt >= RECONNECT_GRACE_MS
      );
      if (expired) {
        for (const player of room.players) {
          if (!player.isBot && this.isConnected(player.socketId)) {
            outbound.push(direct(player.socketId, "match:opponent-left"));
          }
        }
        deleteMatch(this.state, room);
      }
    }

    const dueEntries = this.state.queue.filter((entry) =>
      now >= (entry.queuedAt ?? now) + BOT_MATCH_DELAY_MS
    );
    for (const entry of dueEntries) {
      const index = this.state.queue.findIndex((candidate) => candidate.clientId === entry.clientId);
      if (index < 0 || !this.isConnected(entry.socketId)) continue;
      this.state.queue.splice(index, 1);
      const botId = crypto.randomUUID();
      this.startMatch(entry, {
        socketId: `bot-${botId}`,
        clientId: `bot-${botId}`,
        name: "FlickBot",
        isBot: true,
      }, outbound);
    }

    for (const room of this.state.matches.values()) {
      if (!room.botAction) prepareBotTurn(room);
      if (room.botAction && room.botAction.dueAt <= now) {
        outbound.push(...advanceBotMatch(this.state, room.id));
      }
    }

    await this.persist();
    await this.scheduleNextAlarm();
    this.deliver(outbound);
  }

  private onlinePlayerCount() {
    const active = new Set<string>();
    for (const room of this.state.matches.values()) {
      if (room.finished) continue;
      for (const player of room.players) {
        if (!player.isBot && this.isConnected(player.socketId)) active.add(player.socketId);
      }
    }
    return active.size;
  }
}

const worker = {
  async fetch(request: Request, env: Env) {
    const url = new URL(request.url);
    if (url.pathname === "/health") {
      return Response.json({ ok: true, service: "flickxi-realtime" });
    }
    if (url.pathname !== "/ws" && url.pathname !== "/presence") {
      return Response.json({ error: "Not found" }, { status: 404 });
    }
    if (!originAllowed(request, env)) {
      return Response.json({ error: "Origin is not allowed" }, { status: 403 });
    }
    const id = env.GAME_HUB.idFromName("flickxi-global-hub");
    return env.GAME_HUB.get(id).fetch(request);
  },
};

export default worker;
