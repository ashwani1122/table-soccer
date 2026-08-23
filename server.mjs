import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import next from "next";
import { Server } from "socket.io";

const dev = process.argv.includes("--dev");
const realtimeOnly = process.argv.includes("--realtime-only");
const hostname = process.env.HOST || "0.0.0.0";
const port = Number(process.env.PORT || 3000);
const app = realtimeOnly ? null : next({ dev, hostname, port });
let handle = null;

if (app) {
  await app.prepare();
  handle = app.getRequestHandler();
}

const httpServer = createServer((request, response) => {
  if (handle) return handle(request, response);
  response.writeHead(200, { "content-type": "application/json" });
  response.end(JSON.stringify({ service: "FlickXI realtime", status: "ready" }));
});
const io = new Server(httpServer, {
  transports: ["websocket"],
  serveClient: false,
  maxHttpBufferSize: 100_000,
  cors: realtimeOnly ? { origin: true, credentials: true } : undefined,
});

const queue = [];
const matches = new Map();
const playerMatches = new Map();
const privateRooms = new Map();
const privateRoomByHost = new Map();
const ROOM_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

function safeName(value, fallback) {
  if (typeof value !== "string") return fallback;
  const clean = value.replace(/[^a-zA-Z0-9 _-]/g, "").trim().slice(0, 18);
  return clean || fallback;
}

function removeFromQueue(socketId) {
  const index = queue.findIndex((entry) => entry.socketId === socketId);
  if (index >= 0) queue.splice(index, 1);
}

function removePrivateRoomForHost(socketId, notify = true) {
  const code = privateRoomByHost.get(socketId);
  if (!code) return;
  privateRoomByHost.delete(socketId);
  privateRooms.delete(code);
  if (notify) io.to(`private:${code}`).emit("room:closed");
}

function createRoomCode() {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    let code = "";
    for (let index = 0; index < 6; index += 1) {
      code += ROOM_ALPHABET[Math.floor(Math.random() * ROOM_ALPHABET.length)];
    }
    if (!privateRooms.has(code)) return code;
  }
  return randomUUID().replaceAll("-", "").slice(0, 6).toUpperCase();
}

function cleanRoomCode(value) {
  if (typeof value !== "string") return "";
  return value.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 6);
}

function getRoomForSocket(socket) {
  const matchId = playerMatches.get(socket.id);
  if (!matchId) return null;
  return matches.get(matchId) || null;
}

function publicPlayer(player) {
  return { name: player.name, team: player.team };
}

function startMatch(firstEntry, secondEntry, privateCode = null) {
  const firstSocket = io.sockets.sockets.get(firstEntry.socketId);
  const secondSocket = io.sockets.sockets.get(secondEntry.socketId);
  if (!firstSocket || !secondSocket) return;

  const matchId = randomUUID();
  const room = {
    id: matchId,
    activeTeam: "mint",
    shotInProgress: false,
    finished: false,
    sequence: 0,
    privateCode,
    rematchVotes: new Set(),
    players: [
      { socketId: firstSocket.id, name: firstEntry.name, team: "mint" },
      { socketId: secondSocket.id, name: secondEntry.name, team: "coral" },
    ],
  };

  matches.set(matchId, room);
  for (const player of room.players) {
    playerMatches.set(player.socketId, matchId);
    io.sockets.sockets.get(player.socketId)?.join(matchId);
  }

  for (const player of room.players) {
    const opponent = room.players.find((candidate) => candidate.socketId !== player.socketId);
    io.to(player.socketId).emit("match:found", {
      matchId,
      myTeam: player.team,
      player: publicPlayer(player),
      opponent: publicPlayer(opponent),
      startsAt: Date.now() + 750,
      roomCode: privateCode,
    });
  }
}

function attemptMatchmaking() {
  while (queue.length >= 2) {
    const first = queue.shift();
    const second = queue.shift();
    if (!first || !second) return;
    const firstConnected = io.sockets.sockets.has(first.socketId);
    const secondConnected = io.sockets.sockets.has(second.socketId);
    if (!firstConnected || playerMatches.has(first.socketId)) {
      if (secondConnected && !playerMatches.has(second.socketId)) queue.unshift(second);
      continue;
    }
    if (!secondConnected || playerMatches.has(second.socketId)) {
      queue.unshift(first);
      continue;
    }
    startMatch(first, second);
  }
}

function validShot(payload, team) {
  if (!payload || typeof payload !== "object") return null;
  const bodyId = typeof payload.bodyId === "string" ? payload.bodyId : "";
  const dirX = Number(payload.dirX);
  const dirY = Number(payload.dirY);
  const pull = Number(payload.pull);
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

function validSnapshot(snapshot) {
  if (!snapshot || typeof snapshot !== "object") return false;
  if (snapshot.activeTeam !== "mint" && snapshot.activeTeam !== "coral") return false;
  if (!Array.isArray(snapshot.bodies) || snapshot.bodies.length !== 13) return false;
  if (!snapshot.score || !Number.isInteger(snapshot.score.mint) || !Number.isInteger(snapshot.score.coral)) return false;
  if (snapshot.score.mint < 0 || snapshot.score.coral < 0 || snapshot.score.mint > 3 || snapshot.score.coral > 3) return false;
  return snapshot.bodies.every((body) =>
    body && typeof body.id === "string" &&
    [body.x, body.y, body.vx, body.vy].every((value) => Number.isFinite(value)),
  );
}

io.on("connection", (socket) => {
  socket.on("match:find", (payload = {}) => {
    if (playerMatches.has(socket.id)) return;
    removeFromQueue(socket.id);
    removePrivateRoomForHost(socket.id, false);
    const fallback = `Player ${socket.id.slice(0, 4).toUpperCase()}`;
    queue.push({ socketId: socket.id, name: safeName(payload.name, fallback) });
    socket.emit("match:searching", { position: queue.length });
    attemptMatchmaking();
  });

  socket.on("match:cancel", () => {
    removeFromQueue(socket.id);
    socket.emit("match:cancelled");
  });

  socket.on("room:create", (payload = {}) => {
    if (playerMatches.has(socket.id)) return;
    removeFromQueue(socket.id);
    removePrivateRoomForHost(socket.id, false);
    const fallback = `Player ${socket.id.slice(0, 4).toUpperCase()}`;
    const code = createRoomCode();
    const room = {
      code,
      host: { socketId: socket.id, name: safeName(payload.name, fallback) },
      createdAt: Date.now(),
    };
    privateRooms.set(code, room);
    privateRoomByHost.set(socket.id, code);
    socket.join(`private:${code}`);
    socket.emit("room:created", { code });
  });

  socket.on("room:join", (payload = {}) => {
    if (playerMatches.has(socket.id)) return;
    removeFromQueue(socket.id);
    const code = cleanRoomCode(payload.code);
    if (code.length !== 6) {
      socket.emit("room:error", { action: "join", message: "Enter a valid 6-character room code." });
      return;
    }
    const privateRoom = privateRooms.get(code);
    const hostSocket = privateRoom ? io.sockets.sockets.get(privateRoom.host.socketId) : null;
    if (!privateRoom || !hostSocket) {
      if (privateRoom) {
        privateRooms.delete(code);
        privateRoomByHost.delete(privateRoom.host.socketId);
      }
      socket.emit("room:error", { action: "join", message: "Room not found or no longer available." });
      return;
    }
    if (privateRoom.host.socketId === socket.id) {
      socket.emit("room:error", { action: "join", message: "Share this code with a different player." });
      return;
    }
    const fallback = `Player ${socket.id.slice(0, 4).toUpperCase()}`;
    const guest = { socketId: socket.id, name: safeName(payload.name, fallback) };
    privateRooms.delete(code);
    privateRoomByHost.delete(privateRoom.host.socketId);
    startMatch(privateRoom.host, guest, code);
  });

  socket.on("room:cancel", () => {
    removePrivateRoomForHost(socket.id);
    socket.emit("room:cancelled");
  });

  socket.on("game:shoot", (payload) => {
    const room = getRoomForSocket(socket);
    if (!room || room.shotInProgress || room.finished) return;
    const player = room.players.find((candidate) => candidate.socketId === socket.id);
    if (!player || player.team !== room.activeTeam) {
      socket.emit("game:error", { message: "It is not your turn." });
      return;
    }
    const shot = validShot(payload, player.team);
    if (!shot) {
      socket.emit("game:error", { message: "That shot was rejected." });
      return;
    }
    room.shotInProgress = true;
    room.sequence += 1;
    io.to(room.id).emit("game:shot", { ...shot, sequence: room.sequence, serverTime: Date.now() });
  });

  socket.on("game:settled", (payload) => {
    const room = getRoomForSocket(socket);
    if (!room || !payload || payload.matchId !== room.id || !validSnapshot(payload.snapshot)) return;
    const player = room.players.find((candidate) => candidate.socketId === socket.id);
    if (!player || player.team !== room.activeTeam) return;
    room.activeTeam = payload.snapshot.activeTeam;
    room.finished = payload.snapshot.phase === "finished";
    room.shotInProgress = false;
    io.to(room.id).emit("game:sync", {
      snapshot: payload.snapshot,
      sequence: room.sequence,
      serverTime: Date.now(),
    });
  });

  socket.on("match:rematch", () => {
    const room = getRoomForSocket(socket);
    if (!room || !room.finished) return;
    room.rematchVotes.add(socket.id);
    io.to(room.id).emit("match:rematch-status", { ready: room.rematchVotes.size, needed: 2 });
    if (room.rematchVotes.size === 2) {
      room.activeTeam = room.players[room.sequence % 2].team;
      room.shotInProgress = false;
      room.finished = false;
      room.rematchVotes.clear();
      room.sequence += 1;
      io.to(room.id).emit("match:reset", { activeTeam: room.activeTeam, sequence: room.sequence });
    }
  });

  socket.on("match:leave", () => {
    socket.disconnect(true);
  });

  socket.on("disconnect", () => {
    removeFromQueue(socket.id);
    removePrivateRoomForHost(socket.id);
    const matchId = playerMatches.get(socket.id);
    if (!matchId) return;
    const room = matches.get(matchId);
    if (room) {
      const opponent = room.players.find((candidate) => candidate.socketId !== socket.id);
      if (opponent) io.to(opponent.socketId).emit("match:opponent-left");
      for (const player of room.players) playerMatches.delete(player.socketId);
      matches.delete(matchId);
    }
  });
});

httpServer.listen(port, hostname, () => {
  const mode = realtimeOnly ? "realtime" : dev ? "development" : "production";
  console.log(`FlickXI ${mode} server ready on http://localhost:${port}`);
});
