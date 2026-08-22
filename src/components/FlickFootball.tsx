"use client";

import { useEffect, useRef, useState } from "react";
import type { Socket } from "socket.io-client";
import styles from "./FlickFootball.module.css";

const WIDTH = 420;
const HEIGHT = 720;
const FIELD = { left: 27, right: 393, top: 42, bottom: 678 };
const GOAL_LEFT = 157;
const GOAL_RIGHT = 263;
const MAX_PULL = 92;
const MAX_SPEED = 920;
const TURN_TIME = 20;

type Team = "mint" | "coral";
type Phase = "ready" | "moving" | "goal" | "finished";

type Body = {
  id: string;
  kind: "player" | "ball";
  team?: Team;
  x: number;
  y: number;
  vx: number;
  vy: number;
  radius: number;
  mass: number;
  number?: number;
};

type Drag = {
  bodyId: string;
  pointerX: number;
  pointerY: number;
  pull: number;
  dirX: number;
  dirY: number;
};

type Game = {
  bodies: Body[];
  activeTeam: Team;
  phase: Phase;
  score: Record<Team, number>;
  passesLeft: number;
  turnTime: number;
  turnTick: number;
  drag: Drag | null;
  lastShooterId: string | null;
  carrierId: string | null;
  carrierOffset: { x: number; y: number } | null;
  carrierTargetOffset: { x: number; y: number } | null;
  caughtThisMove: boolean;
  goalResetAt: number | null;
  message: string;
  winner: Team | null;
};

type Hud = {
  activeTeam: Team;
  phase: Phase;
  score: Record<Team, number>;
  passesLeft: number;
  turnTime: number;
  message: string;
  winner: Team | null;
};

type OnlineStage = "menu" | "searching" | "matched" | "practice" | "disconnected";

type MatchInfo = {
  matchId: string;
  myTeam: Team;
  player: { name: string; team: Team };
  opponent: { name: string; team: Team };
  startsAt: number;
};

type Shot = {
  bodyId: string;
  dirX: number;
  dirY: number;
  pull: number;
};

type GameSnapshot = Omit<Game, "drag" | "goalResetAt"> & {
  drag: null;
  goalResetAt: number | null;
};

const TEAM_META = {
  mint: { name: "NEON FC", short: "N", primary: "#48e0aa", dark: "#096f67" },
  coral: { name: "EMBER", short: "E", primary: "#ff6d73", dark: "#9f2446" },
} as const;

function player(id: string, team: Team, number: number, x: number, y: number): Body {
  return { id, kind: "player", team, number, x, y, vx: 0, vy: 0, radius: 19, mass: 2.6 };
}

function makeBodies(): Body[] {
  return [
    player("coral-1", "coral", 1, 210, 70),
    player("coral-2", "coral", 2, 110, 158),
    player("coral-3", "coral", 3, 210, 142),
    player("coral-4", "coral", 4, 310, 158),
    player("coral-5", "coral", 5, 158, 250),
    player("coral-6", "coral", 6, 262, 250),
    player("mint-1", "mint", 1, 210, 650),
    player("mint-2", "mint", 2, 110, 562),
    player("mint-3", "mint", 3, 210, 578),
    player("mint-4", "mint", 4, 310, 562),
    player("mint-5", "mint", 5, 158, 470),
    player("mint-6", "mint", 6, 262, 470),
    { id: "ball", kind: "ball", x: 210, y: 360, vx: 0, vy: 0, radius: 10, mass: 0.7 },
  ];
}

function makeGame(): Game {
  return {
    bodies: makeBodies(),
    activeTeam: "mint",
    phase: "ready",
    score: { mint: 0, coral: 0 },
    passesLeft: 3,
    turnTime: TURN_TIME,
    turnTick: 0,
    drag: null,
    lastShooterId: null,
    carrierId: null,
    carrierOffset: null,
    carrierTargetOffset: null,
    caughtThisMove: false,
    goalResetAt: null,
    message: "YOUR TURN",
    winner: null,
  };
}

function toHud(game: Game): Hud {
  return {
    activeTeam: game.activeTeam,
    phase: game.phase,
    score: { ...game.score },
    passesLeft: game.passesLeft,
    turnTime: Math.max(0, Math.ceil(game.turnTime)),
    message: game.message,
    winner: game.winner,
  };
}

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

function speed(body: Body) {
  return Math.hypot(body.vx, body.vy);
}

function rotateToward(
  current: { x: number; y: number },
  target: { x: number; y: number },
  maxRadians: number,
) {
  const currentAngle = Math.atan2(current.y, current.x);
  const targetAngle = Math.atan2(target.y, target.x);
  const delta = Math.atan2(
    Math.sin(targetAngle - currentAngle),
    Math.cos(targetAngle - currentAngle),
  );
  if (Math.abs(delta) <= maxRadians) return { ...target };
  const angle = currentAngle + Math.sign(delta) * maxRadians;
  return { x: Math.cos(angle), y: Math.sin(angle) };
}

function constrainPlayerToPitch(body: Body) {
  if (body.x - body.radius < FIELD.left) {
    body.x = FIELD.left + body.radius;
    if (body.vx < 0) body.vx = Math.abs(body.vx) * 0.84;
  } else if (body.x + body.radius > FIELD.right) {
    body.x = FIELD.right - body.radius;
    if (body.vx > 0) body.vx = -Math.abs(body.vx) * 0.84;
  }
  if (body.y - body.radius < FIELD.top) {
    body.y = FIELD.top + body.radius;
    if (body.vy < 0) body.vy = Math.abs(body.vy) * 0.84;
  } else if (body.y + body.radius > FIELD.bottom) {
    body.y = FIELD.bottom - body.radius;
    if (body.vy > 0) body.vy = -Math.abs(body.vy) * 0.84;
  }
}

function constrainFreeBallToPitch(ball: Body) {
  if (ball.x - ball.radius < FIELD.left) {
    ball.x = FIELD.left + ball.radius;
    if (ball.vx < 0) ball.vx = Math.abs(ball.vx) * 0.88;
  } else if (ball.x + ball.radius > FIELD.right) {
    ball.x = FIELD.right - ball.radius;
    if (ball.vx > 0) ball.vx = -Math.abs(ball.vx) * 0.88;
  }
  const insideGoalMouth = ball.x > GOAL_LEFT && ball.x < GOAL_RIGHT;
  if (!insideGoalMouth && ball.y - ball.radius < FIELD.top) {
    ball.y = FIELD.top + ball.radius;
    if (ball.vy < 0) ball.vy = Math.abs(ball.vy) * 0.88;
  } else if (!insideGoalMouth && ball.y + ball.radius > FIELD.bottom) {
    ball.y = FIELD.bottom - ball.radius;
    if (ball.vy > 0) ball.vy = -Math.abs(ball.vy) * 0.88;
  }
}

function constrainCarrierPair(carrier: Body, ball: Body) {
  const leftEdge = Math.min(carrier.x - carrier.radius, ball.x - ball.radius);
  const rightEdge = Math.max(carrier.x + carrier.radius, ball.x + ball.radius);
  let shiftX = 0;
  if (leftEdge < FIELD.left) shiftX = FIELD.left - leftEdge;
  else if (rightEdge > FIELD.right) shiftX = FIELD.right - rightEdge;

  const insideGoalMouth = ball.x + shiftX > GOAL_LEFT && ball.x + shiftX < GOAL_RIGHT;
  const topEdge = insideGoalMouth
    ? carrier.y - carrier.radius
    : Math.min(carrier.y - carrier.radius, ball.y - ball.radius);
  const bottomEdge = insideGoalMouth
    ? carrier.y + carrier.radius
    : Math.max(carrier.y + carrier.radius, ball.y + ball.radius);
  let shiftY = 0;
  if (topEdge < FIELD.top) shiftY = FIELD.top - topEdge;
  else if (bottomEdge > FIELD.bottom) shiftY = FIELD.bottom - bottomEdge;

  carrier.x += shiftX;
  carrier.y += shiftY;
  ball.x += shiftX;
  ball.y += shiftY;

  if (shiftX > 0 && ball.vx < 0) ball.vx = Math.abs(ball.vx) * 0.84;
  else if (shiftX < 0 && ball.vx > 0) ball.vx = -Math.abs(ball.vx) * 0.84;
  if (shiftY > 0 && ball.vy < 0) ball.vy = Math.abs(ball.vy) * 0.84;
  else if (shiftY < 0 && ball.vy > 0) ball.vy = -Math.abs(ball.vy) * 0.84;
  carrier.vx = ball.vx;
  carrier.vy = ball.vy;
}

function resolveCollision(a: Body, b: Body, restitution = 0.88) {
  let dx = b.x - a.x;
  let dy = b.y - a.y;
  let distance = Math.hypot(dx, dy);
  const minDistance = a.radius + b.radius;

  if (distance === 0) {
    dx = 0.01;
    dy = 0;
    distance = 0.01;
  }
  if (distance >= minDistance) return false;

  const nx = dx / distance;
  const ny = dy / distance;
  const overlap = minDistance - distance;
  const totalMass = a.mass + b.mass;

  a.x -= nx * overlap * (b.mass / totalMass);
  a.y -= ny * overlap * (b.mass / totalMass);
  b.x += nx * overlap * (a.mass / totalMass);
  b.y += ny * overlap * (a.mass / totalMass);

  const relativeX = b.vx - a.vx;
  const relativeY = b.vy - a.vy;
  const closingSpeed = relativeX * nx + relativeY * ny;
  if (closingSpeed >= 0) return true;

  const impulse = (-(1 + restitution) * closingSpeed) / (1 / a.mass + 1 / b.mass);
  const impulseX = impulse * nx;
  const impulseY = impulse * ny;
  a.vx -= impulseX / a.mass;
  a.vy -= impulseY / a.mass;
  b.vx += impulseX / b.mass;
  b.vy += impulseY / b.mass;
  return true;
}

function drawRoundedRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  radius: number,
) {
  ctx.beginPath();
  ctx.roundRect(x, y, width, height, radius);
}

function drawPitch(ctx: CanvasRenderingContext2D) {
  ctx.clearRect(0, 0, WIDTH, HEIGHT);

  const surround = ctx.createLinearGradient(0, 0, WIDTH, HEIGHT);
  surround.addColorStop(0, "#0b352b");
  surround.addColorStop(1, "#06251f");
  ctx.fillStyle = surround;
  ctx.fillRect(0, 0, WIDTH, HEIGHT);

  for (let y = FIELD.top; y < FIELD.bottom; y += 53) {
    ctx.fillStyle = y % 106 === FIELD.top % 106 ? "#168b62" : "#147e59";
    ctx.fillRect(FIELD.left, y, FIELD.right - FIELD.left, 53);
  }

  const vignette = ctx.createRadialGradient(210, 360, 80, 210, 360, 390);
  vignette.addColorStop(0, "rgba(84, 241, 163, 0.14)");
  vignette.addColorStop(1, "rgba(0, 22, 17, 0.34)");
  ctx.fillStyle = vignette;
  ctx.fillRect(FIELD.left, FIELD.top, FIELD.right - FIELD.left, FIELD.bottom - FIELD.top);

  ctx.strokeStyle = "rgba(232, 255, 246, 0.88)";
  ctx.lineWidth = 2.2;
  ctx.strokeRect(FIELD.left, FIELD.top, FIELD.right - FIELD.left, FIELD.bottom - FIELD.top);
  ctx.beginPath();
  ctx.moveTo(FIELD.left, HEIGHT / 2);
  ctx.lineTo(FIELD.right, HEIGHT / 2);
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(WIDTH / 2, HEIGHT / 2, 58, 0, Math.PI * 2);
  ctx.stroke();
  ctx.fillStyle = "rgba(242,255,249,0.78)";
  ctx.beginPath();
  ctx.arc(WIDTH / 2, HEIGHT / 2, 4, 0, Math.PI * 2);
  ctx.fill();

  ctx.strokeRect(121, FIELD.top, 178, 79);
  ctx.strokeRect(121, FIELD.bottom - 79, 178, 79);
  ctx.strokeRect(163, FIELD.top, 94, 35);
  ctx.strokeRect(163, FIELD.bottom - 35, 94, 35);

  ctx.beginPath();
  ctx.arc(WIDTH / 2, FIELD.top + 79, 44, 0.2, Math.PI - 0.2);
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(WIDTH / 2, FIELD.bottom - 79, 44, Math.PI + 0.2, Math.PI * 2 - 0.2);
  ctx.stroke();

  const drawGoal = (top: boolean) => {
    const y = top ? 17 : 678;
    ctx.save();
    ctx.fillStyle = "rgba(230, 248, 255, 0.08)";
    ctx.strokeStyle = "#dbe9ed";
    ctx.lineWidth = 3;
    ctx.fillRect(GOAL_LEFT, y, GOAL_RIGHT - GOAL_LEFT, 25);
    ctx.strokeRect(GOAL_LEFT, y, GOAL_RIGHT - GOAL_LEFT, 25);
    ctx.strokeStyle = "rgba(219, 233, 237, 0.28)";
    ctx.lineWidth = 1;
    for (let x = GOAL_LEFT + 9; x < GOAL_RIGHT; x += 9) {
      ctx.beginPath();
      ctx.moveTo(x, y);
      ctx.lineTo(x, y + 25);
      ctx.stroke();
    }
    for (let row = 6; row < 25; row += 6) {
      ctx.beginPath();
      ctx.moveTo(GOAL_LEFT, y + row);
      ctx.lineTo(GOAL_RIGHT, y + row);
      ctx.stroke();
    }
    ctx.restore();
  };
  drawGoal(true);
  drawGoal(false);

  ctx.fillStyle = "rgba(4, 14, 20, 0.38)";
  ctx.fillRect(5, 78, 14, 564);
  ctx.fillRect(401, 78, 14, 564);
  for (let y = 87; y < 637; y += 18) {
    ctx.fillStyle = y % 36 === 15 ? "#54d5a0" : "#ff6874";
    ctx.fillRect(9, y, 6, 10);
    ctx.fillRect(405, y, 6, 10);
  }
}

function drawBall(ctx: CanvasRenderingContext2D, ball: Body) {
  ctx.save();
  ctx.translate(ball.x, ball.y);
  ctx.shadowColor = "rgba(0,0,0,0.38)";
  ctx.shadowBlur = 8;
  ctx.shadowOffsetY = 3;
  ctx.fillStyle = "#f8fbff";
  ctx.beginPath();
  ctx.arc(0, 0, ball.radius, 0, Math.PI * 2);
  ctx.fill();
  ctx.shadowColor = "transparent";
  ctx.fillStyle = "#14202d";
  ctx.beginPath();
  ctx.arc(0, 0, 3.6, 0, Math.PI * 2);
  ctx.fill();
  for (let i = 0; i < 5; i += 1) {
    const angle = (Math.PI * 2 * i) / 5 - Math.PI / 2;
    ctx.beginPath();
    ctx.arc(Math.cos(angle) * 7, Math.sin(angle) * 7, 2.1, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
}

function drawPlayer(
  ctx: CanvasRenderingContext2D,
  body: Body,
  activeTeam: Team,
  selected: boolean,
  carrier: boolean,
  keepUpright: boolean,
) {
  const meta = TEAM_META[body.team as Team];
  ctx.save();
  ctx.translate(body.x, body.y);
  if (keepUpright) ctx.rotate(Math.PI);

  ctx.shadowColor = "rgba(0, 0, 0, 0.48)";
  ctx.shadowBlur = 10;
  ctx.shadowOffsetY = 4;
  ctx.fillStyle = "#111a27";
  ctx.beginPath();
  ctx.arc(0, 0, body.radius + 2, 0, Math.PI * 2);
  ctx.fill();
  ctx.shadowColor = "transparent";

  if (body.team === activeTeam) {
    ctx.strokeStyle = selected ? "#ffffff" : `${meta.primary}aa`;
    ctx.lineWidth = selected ? 4 : 2.5;
    ctx.beginPath();
    ctx.arc(0, 0, body.radius + (selected ? 8 : 5), 0, Math.PI * 2);
    ctx.stroke();
  }

  if (carrier) {
    ctx.strokeStyle = "#ffd75a";
    ctx.lineWidth = 2;
    ctx.setLineDash([3, 3]);
    ctx.beginPath();
    ctx.arc(0, 0, body.radius + 11, 0, Math.PI * 2);
    ctx.stroke();
    ctx.setLineDash([]);
  }

  ctx.save();
  ctx.beginPath();
  ctx.arc(0, 0, body.radius - 2, 0, Math.PI * 2);
  ctx.clip();
  ctx.fillStyle = meta.primary;
  ctx.fillRect(-body.radius, -body.radius, body.radius, body.radius * 2);
  ctx.fillStyle = meta.dark;
  ctx.fillRect(0, -body.radius, body.radius, body.radius * 2);
  ctx.restore();

  const goalDirectionY = (body.team === "mint" ? -1 : 1) * (keepUpright ? -1 : 1);
  ctx.fillStyle = "rgba(255,255,255,0.92)";
  ctx.beginPath();
  ctx.moveTo(0, goalDirectionY * (body.radius - 3));
  ctx.lineTo(-4.5, goalDirectionY * (body.radius - 10));
  ctx.lineTo(4.5, goalDirectionY * (body.radius - 10));
  ctx.closePath();
  ctx.fill();

  ctx.strokeStyle = "rgba(255,255,255,0.8)";
  ctx.lineWidth = 1.4;
  ctx.beginPath();
  ctx.arc(0, 0, 9.5, 0, Math.PI * 2);
  ctx.stroke();
  ctx.fillStyle = "#fff";
  ctx.font = "800 9px Arial";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(`${meta.short}${body.number}`, 0, 0.5);
  ctx.restore();
}

function drawAim(ctx: CanvasRenderingContext2D, drag: Drag, body: Body) {
  const power = drag.pull / MAX_PULL;
  const frontX = body.x + drag.dirX * (body.radius + 9);
  const frontY = body.y + drag.dirY * (body.radius + 9);
  const length = 42 + power * 62;

  ctx.save();
  ctx.lineCap = "round";
  ctx.strokeStyle = power > 0.72 ? "#ffda64" : "#f4fbff";
  ctx.fillStyle = ctx.strokeStyle;
  ctx.lineWidth = 4;
  ctx.beginPath();
  ctx.moveTo(frontX, frontY);
  ctx.lineTo(frontX + drag.dirX * length, frontY + drag.dirY * length);
  ctx.stroke();

  const tipX = frontX + drag.dirX * length;
  const tipY = frontY + drag.dirY * length;
  const angle = Math.atan2(drag.dirY, drag.dirX);
  ctx.beginPath();
  ctx.moveTo(tipX, tipY);
  ctx.lineTo(tipX - Math.cos(angle - 0.55) * 13, tipY - Math.sin(angle - 0.55) * 13);
  ctx.lineTo(tipX - Math.cos(angle + 0.55) * 13, tipY - Math.sin(angle + 0.55) * 13);
  ctx.closePath();
  ctx.fill();

  ctx.strokeStyle = "rgba(255,255,255,0.3)";
  ctx.lineWidth = 2;
  ctx.setLineDash([5, 7]);
  ctx.beginPath();
  ctx.moveTo(body.x - drag.dirX * body.radius, body.y - drag.dirY * body.radius);
  ctx.lineTo(drag.pointerX, drag.pointerY);
  ctx.stroke();
  ctx.restore();
}

function drawGame(ctx: CanvasRenderingContext2D, game: Game, viewTeam: Team) {
  const flipped = viewTeam === "coral";
  ctx.save();
  if (flipped) {
    ctx.translate(WIDTH, HEIGHT);
    ctx.rotate(Math.PI);
  }
  drawPitch(ctx);
  const ball = game.bodies.find((body) => body.kind === "ball");
  for (const body of game.bodies) {
    if (body.kind === "player") {
      drawPlayer(
        ctx,
        body,
        game.activeTeam,
        game.drag?.bodyId === body.id,
        game.carrierId === body.id,
        flipped,
      );
    }
  }
  if (ball) drawBall(ctx, ball);

  if (game.drag) {
    const body = game.bodies.find((item) => item.id === game.drag?.bodyId);
    if (body) drawAim(ctx, game.drag, body);
  }
  ctx.restore();

  if (game.phase === "goal" || game.phase === "finished") {
    ctx.fillStyle = "rgba(3, 10, 17, 0.42)";
    ctx.fillRect(0, 0, WIDTH, HEIGHT);
    drawRoundedRect(ctx, 92, 307, 236, 105, 22);
    ctx.fillStyle = "rgba(8, 22, 31, 0.92)";
    ctx.fill();
    ctx.strokeStyle = "rgba(255,255,255,0.12)";
    ctx.stroke();
    ctx.fillStyle = game.phase === "finished" ? "#67e3b2" : "#ffdc66";
    ctx.font = "900 34px Arial";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(game.phase === "finished" ? "MATCH WON" : "GOAL!", 210, 345);
    ctx.fillStyle = "rgba(255,255,255,0.7)";
    ctx.font = "700 12px Arial";
    ctx.fillText(game.message, 210, 382);
  }
}

function resetPositions(game: Game, kickoffTeam: Team) {
  game.bodies = makeBodies();
  game.activeTeam = kickoffTeam;
  game.phase = "ready";
  game.passesLeft = 3;
  game.turnTime = TURN_TIME;
  game.turnTick = 0;
  game.drag = null;
  game.lastShooterId = null;
  game.carrierId = null;
  game.carrierOffset = null;
  game.carrierTargetOffset = null;
  game.caughtThisMove = false;
  game.goalResetAt = null;
  game.message = kickoffTeam === "mint" ? "NEON FC KICKOFF" : "EMBER KICKOFF";
}

function switchTurn(game: Game, reason = "TURN CHANGED") {
  game.activeTeam = game.activeTeam === "mint" ? "coral" : "mint";
  game.phase = "ready";
  game.passesLeft = 3;
  game.turnTime = TURN_TIME;
  game.turnTick = 0;
  game.drag = null;
  game.lastShooterId = null;
  game.carrierId = null;
  game.carrierOffset = null;
  game.carrierTargetOffset = null;
  game.caughtThisMove = false;
  game.message = reason;
  for (const body of game.bodies) {
    body.vx = 0;
    body.vy = 0;
  }
}

function makeSnapshot(game: Game): GameSnapshot {
  return {
    ...game,
    bodies: game.bodies.map((body) => ({ ...body })),
    score: { ...game.score },
    carrierOffset: game.carrierOffset ? { ...game.carrierOffset } : null,
    carrierTargetOffset: game.carrierTargetOffset ? { ...game.carrierTargetOffset } : null,
    drag: null,
    goalResetAt: null,
  };
}

function applySnapshot(game: Game, snapshot: GameSnapshot) {
  game.bodies = snapshot.bodies.map((body) => ({ ...body }));
  game.activeTeam = snapshot.activeTeam;
  game.phase = snapshot.phase;
  game.score = { ...snapshot.score };
  game.passesLeft = snapshot.passesLeft;
  game.turnTime = snapshot.turnTime;
  game.turnTick = snapshot.turnTick;
  game.drag = null;
  game.lastShooterId = snapshot.lastShooterId;
  game.carrierId = snapshot.carrierId;
  game.carrierOffset = snapshot.carrierOffset ? { ...snapshot.carrierOffset } : null;
  game.carrierTargetOffset = snapshot.carrierTargetOffset ? { ...snapshot.carrierTargetOffset } : null;
  game.caughtThisMove = snapshot.caughtThisMove;
  game.goalResetAt = snapshot.phase === "goal" ? performance.now() + 1350 : null;
  game.message = snapshot.message;
  game.winner = snapshot.winner;
}

export default function FlickFootball() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const socketRef = useRef<Socket | null>(null);
  const kickoffTeamRef = useRef<Team>("mint");
  const [session, setSession] = useState(0);
  const [showRules, setShowRules] = useState(false);
  const [hud, setHud] = useState<Hud>(() => toHud(makeGame()));
  const [onlineStage, setOnlineStage] = useState<OnlineStage>("menu");
  const [match, setMatch] = useState<MatchInfo | null>(null);
  const [playerName, setPlayerName] = useState("Ashwani");
  const [searchSeconds, setSearchSeconds] = useState(0);
  const [rematchReady, setRematchReady] = useState(0);
  const [networkMessage, setNetworkMessage] = useState("");

  useEffect(() => {
    if (onlineStage !== "searching") return;
    const timer = window.setInterval(() => setSearchSeconds((value) => value + 1), 1000);
    return () => window.clearInterval(timer);
  }, [onlineStage]);

  useEffect(() => {
    return () => {
      socketRef.current?.disconnect();
    };
  }, []);

  const closeSocket = () => {
    socketRef.current?.removeAllListeners();
    socketRef.current?.disconnect();
    socketRef.current = null;
  };

  const startMatchmaking = async () => {
    closeSocket();
    setMatch(null);
    setNetworkMessage("");
    setRematchReady(0);
    setSearchSeconds(0);
    setOnlineStage("searching");

    const { io } = await import("socket.io-client");
    const realtimeUrl = process.env.NODE_ENV === "development"
      ? `${window.location.protocol}//${window.location.hostname}:3001`
      : undefined;
    const socket = io(realtimeUrl, { transports: ["websocket"], autoConnect: false });
    socketRef.current = socket;

    socket.on("connect", () => {
      socket.emit("match:find", { name: playerName.trim() || "Player" });
    });
    socket.on("connect_error", () => {
      setNetworkMessage("Could not reach the game server. Try again.");
      setOnlineStage("menu");
    });
    socket.on("match:found", (data: MatchInfo) => {
      kickoffTeamRef.current = "mint";
      setMatch(data);
      setNetworkMessage("");
      setRematchReady(0);
      setOnlineStage("matched");
      setSession((value) => value + 1);
    });
    socket.on("match:opponent-left", () => {
      setNetworkMessage("Your opponent left the match.");
      setOnlineStage("disconnected");
    });
    socket.on("match:rematch-status", ({ ready }: { ready: number }) => {
      setRematchReady(ready);
    });
    socket.on("match:reset", ({ activeTeam }: { activeTeam: Team }) => {
      kickoffTeamRef.current = activeTeam;
      setRematchReady(0);
      setNetworkMessage("");
      setSession((value) => value + 1);
    });
    socket.connect();
  };

  const cancelSearch = () => {
    socketRef.current?.emit("match:cancel");
    closeSocket();
    setOnlineStage("menu");
  };

  const startPractice = () => {
    closeSocket();
    kickoffTeamRef.current = "mint";
    setMatch(null);
    setNetworkMessage("");
    setOnlineStage("practice");
    setSession((value) => value + 1);
  };

  const leaveMatch = () => {
    socketRef.current?.emit("match:leave");
    closeSocket();
    kickoffTeamRef.current = "mint";
    setMatch(null);
    setNetworkMessage("");
    setRematchReady(0);
    setOnlineStage("menu");
    setSession((value) => value + 1);
  };

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = WIDTH * dpr;
    canvas.height = HEIGHT * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    const game = makeGame();
    const viewTeam: Team = onlineStage === "matched" && match ? match.myTeam : "mint";
    game.activeTeam = kickoffTeamRef.current;
    game.message = onlineStage === "matched"
      ? `${TEAM_META[game.activeTeam].name} STARTS`
      : "PULL BACK A DISC TO SHOOT";
    let frameId = 0;
    let previousTime = performance.now();
    let lastHudKey = "";
    let shotPending = false;
    let lastSequence = -1;

    const syncHud = () => {
      const next = toHud(game);
      const key = JSON.stringify(next);
      if (key !== lastHudKey) {
        lastHudKey = key;
        setHud(next);
      }
    };

    const publishState = () => {
      if (onlineStage !== "matched" || !match) return;
      socketRef.current?.emit("game:settled", {
        matchId: match.matchId,
        snapshot: makeSnapshot(game),
      });
    };

    const applyShot = (shot: Shot) => {
      if (game.phase !== "ready") return;
      const body = game.bodies.find((item) => item.id === shot.bodyId);
      if (!body || body.kind !== "player" || body.team !== game.activeTeam) return;
      const launchSpeed = (shot.pull / MAX_PULL) * MAX_SPEED;
      body.vx = shot.dirX * launchSpeed;
      body.vy = shot.dirY * launchSpeed;
      game.lastShooterId = body.id;

      if (game.carrierId === body.id) {
        const ball = game.bodies.find((item) => item.kind === "ball");
        if (ball) {
          ball.vx = body.vx * 1.06;
          ball.vy = body.vy * 1.06;
          ball.x = body.x + shot.dirX * (body.radius + ball.radius + 2);
          ball.y = body.y + shot.dirY * (body.radius + ball.radius + 2);
        }
        game.carrierId = null;
        game.carrierOffset = null;
        game.carrierTargetOffset = null;
      }

      shotPending = false;
      game.caughtThisMove = false;
      game.phase = "moving";
      game.message = "BALL IN MOTION";
      syncHud();
    };

    const pointFromEvent = (event: PointerEvent) => {
      const rect = canvas.getBoundingClientRect();
      const screenX = ((event.clientX - rect.left) / rect.width) * WIDTH;
      const screenY = ((event.clientY - rect.top) / rect.height) * HEIGHT;
      return viewTeam === "coral"
        ? { x: WIDTH - screenX, y: HEIGHT - screenY }
        : { x: screenX, y: screenY };
    };

    const onPointerDown = (event: PointerEvent) => {
      if (game.phase !== "ready" || shotPending) return;
      if (onlineStage !== "practice" && onlineStage !== "matched") return;
      if (onlineStage === "matched" && match?.myTeam !== game.activeTeam) {
        game.message = "OPPONENT IS AIMING";
        syncHud();
        return;
      }
      const point = pointFromEvent(event);
      const selectable = game.bodies
        .filter((body) => body.kind === "player" && body.team === game.activeTeam)
        .find((body) => Math.hypot(point.x - body.x, point.y - body.y) <= body.radius + 12);
      if (!selectable) return;
      if (game.carrierId && selectable.id !== game.carrierId) {
        game.message = "PLAY THE BALL CARRIER";
        syncHud();
        return;
      }
      canvas.setPointerCapture(event.pointerId);
      game.drag = {
        bodyId: selectable.id,
        pointerX: point.x,
        pointerY: point.y,
        pull: 0,
        dirX: 0,
        dirY: -1,
      };
      game.message = "PULL BACK TO AIM";
      syncHud();
    };

    const onPointerMove = (event: PointerEvent) => {
      if (!game.drag) return;
      const point = pointFromEvent(event);
      const body = game.bodies.find((item) => item.id === game.drag?.bodyId);
      if (!body) return;
      const rawX = body.x - point.x;
      const rawY = body.y - point.y;
      const distance = Math.hypot(rawX, rawY);
      const pull = clamp(distance, 0, MAX_PULL);
      game.drag.pointerX = body.x - (rawX / Math.max(distance, 0.001)) * pull;
      game.drag.pointerY = body.y - (rawY / Math.max(distance, 0.001)) * pull;
      game.drag.pull = pull;
      game.drag.dirX = rawX / Math.max(distance, 0.001);
      game.drag.dirY = rawY / Math.max(distance, 0.001);
    };

    const onPointerUp = (event: PointerEvent) => {
      if (!game.drag) return;
      const drag = game.drag;
      game.drag = null;
      if (canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId);
      if (drag.pull < 8) {
        game.message = "PULL A LITTLE FURTHER";
        syncHud();
        return;
      }

      const shot = { bodyId: drag.bodyId, dirX: drag.dirX, dirY: drag.dirY, pull: drag.pull };
      if (onlineStage === "matched" && match) {
        shotPending = true;
        game.message = "SHOT LOCKED";
        syncHud();
        socketRef.current?.emit("game:shoot", shot);
      } else {
        applyShot(shot);
      }
    };

    canvas.addEventListener("pointerdown", onPointerDown);
    canvas.addEventListener("pointermove", onPointerMove);
    canvas.addEventListener("pointerup", onPointerUp);
    canvas.addEventListener("pointercancel", onPointerUp);

    const socket = socketRef.current;
    const onRemoteShot = (shot: Shot & { sequence: number }) => {
      if (shot.sequence <= lastSequence) return;
      lastSequence = shot.sequence;
      applyShot(shot);
    };
    const onRemoteSync = ({ snapshot, sequence }: { snapshot: GameSnapshot; sequence: number }) => {
      if (sequence < lastSequence) return;
      lastSequence = sequence;
      shotPending = false;
      applySnapshot(game, snapshot);
      syncHud();
    };
    const onGameError = ({ message }: { message: string }) => {
      shotPending = false;
      game.message = message.toUpperCase();
      syncHud();
    };
    socket?.on("game:shot", onRemoteShot);
    socket?.on("game:sync", onRemoteSync);
    socket?.on("game:error", onGameError);

    const scoreGoal = (scoringTeam: Team, now: number) => {
      const authorityTeam = game.activeTeam;
      game.score[scoringTeam] += 1;
      const scorerName = TEAM_META[scoringTeam].name;
      if (game.score[scoringTeam] >= 3) {
        game.phase = "finished";
        game.winner = scoringTeam;
        game.message = `${scorerName} WINS ${game.score.mint}–${game.score.coral}`;
      } else {
        game.phase = "goal";
        game.message = `${scorerName} SCORES`;
        game.goalResetAt = now + 1350;
      }
      for (const body of game.bodies) {
        body.vx = 0;
        body.vy = 0;
      }
      syncHud();
      if (onlineStage === "matched" && match?.myTeam === authorityTeam) publishState();
    };

    const updatePhysics = (dt: number, now: number) => {
      if (game.phase === "goal" && game.goalResetAt && now >= game.goalResetAt) {
        const authorityTeam = game.activeTeam;
        const kickoff = game.message.startsWith(TEAM_META.mint.name) ? "coral" : "mint";
        resetPositions(game, kickoff);
        syncHud();
        if (onlineStage === "matched" && match?.myTeam === authorityTeam) publishState();
        return;
      }
      if (game.phase !== "moving") return;

      const ball = game.bodies.find((body) => body.kind === "ball");
      if (!ball) return;

      const damping = Math.exp(-2.3 * dt);
      for (const body of game.bodies) {
        body.x += body.vx * dt;
        body.y += body.vy * dt;
        body.vx *= damping;
        body.vy *= damping;
        if (speed(body) < 5) {
          body.vx = 0;
          body.vy = 0;
        }
      }

      for (const body of game.bodies) {
        if (body.kind === "ball" && game.carrierId) continue;
        if (body.x - body.radius < FIELD.left) {
          body.x = FIELD.left + body.radius;
          body.vx = Math.abs(body.vx) * 0.86;
        } else if (body.x + body.radius > FIELD.right) {
          body.x = FIELD.right - body.radius;
          body.vx = -Math.abs(body.vx) * 0.86;
        }

        if (body.kind === "player") {
          if (body.y - body.radius < FIELD.top) {
            body.y = FIELD.top + body.radius;
            body.vy = Math.abs(body.vy) * 0.86;
          } else if (body.y + body.radius > FIELD.bottom) {
            body.y = FIELD.bottom - body.radius;
            body.vy = -Math.abs(body.vy) * 0.86;
          }
        } else {
          const insideGoal = body.x > GOAL_LEFT && body.x < GOAL_RIGHT;
          if (!insideGoal && body.y - body.radius < FIELD.top) {
            body.y = FIELD.top + body.radius;
            body.vy = Math.abs(body.vy) * 0.9;
          } else if (!insideGoal && body.y + body.radius > FIELD.bottom) {
            body.y = FIELD.bottom - body.radius;
            body.vy = -Math.abs(body.vy) * 0.9;
          }
        }
      }

      for (let i = 0; i < game.bodies.length; i += 1) {
        for (let j = i + 1; j < game.bodies.length; j += 1) {
          const a = game.bodies[i];
          const b = game.bodies[j];
          if (!a || !b) continue;
          if (a.kind === "player" && b.kind === "player") {
            resolveCollision(a, b, 0.9);
            continue;
          }

          const playerBody = a.kind === "player" ? a : b.kind === "player" ? b : null;
          const ballBody = a.kind === "ball" ? a : b.kind === "ball" ? b : null;
          if (!playerBody || !ballBody) continue;
          const touching = Math.hypot(playerBody.x - ballBody.x, playerBody.y - ballBody.y) <
            playerBody.radius + ballBody.radius;
          if (!touching) continue;

          const isReceiver =
            playerBody.team === game.activeTeam &&
            playerBody.id !== game.lastShooterId &&
            !game.carrierId &&
            speed(ballBody) > 45 &&
            game.passesLeft > 0;

          if (isReceiver) {
            const dx = ballBody.x - playerBody.x;
            const dy = ballBody.y - playerBody.y;
            const length = Math.max(1, Math.hypot(dx, dy));
            game.carrierId = playerBody.id;
            game.carrierOffset = { x: dx / length, y: dy / length };
            game.carrierTargetOffset = {
              x: 0,
              y: playerBody.team === "mint" ? -1 : 1,
            };
            const combinedVx = (ballBody.vx * ballBody.mass + playerBody.vx * playerBody.mass) /
              (ballBody.mass + playerBody.mass);
            const combinedVy = (ballBody.vy * ballBody.mass + playerBody.vy * playerBody.mass) /
              (ballBody.mass + playerBody.mass);
            playerBody.vx = combinedVx;
            playerBody.vy = combinedVy;
            ballBody.vx = combinedVx;
            ballBody.vy = combinedVy;
            game.caughtThisMove = true;
            game.passesLeft -= 1;
            game.message = "PASS CAUGHT - ALIGNING TO GOAL";
            syncHud();
          } else if (game.carrierId !== playerBody.id) {
            if (game.carrierId && playerBody.team !== game.activeTeam) {
              game.carrierId = null;
              game.carrierOffset = null;
              game.carrierTargetOffset = null;
              game.caughtThisMove = false;
              game.message = "POSSESSION BROKEN";
            }
            resolveCollision(playerBody, ballBody, 0.94);
          }
        }
      }

      if (game.carrierId && game.carrierOffset && game.carrierTargetOffset) {
        const carrier = game.bodies.find((body) => body.id === game.carrierId);
        if (carrier) {
          game.carrierOffset = rotateToward(
            game.carrierOffset,
            game.carrierTargetOffset,
            6 * dt,
          );
          const gap = carrier.radius + ball.radius - 1;
          carrier.x = ball.x - game.carrierOffset.x * gap;
          carrier.y = ball.y - game.carrierOffset.y * gap;
          carrier.vx = ball.vx;
          carrier.vy = ball.vy;
          constrainCarrierPair(carrier, ball);
        }
      }

      for (const body of game.bodies) {
        if (body.kind === "player" && body.id !== game.carrierId) {
          constrainPlayerToPitch(body);
        }
      }
      if (!game.carrierId) constrainFreeBallToPitch(ball);

      if (ball.y + ball.radius < FIELD.top && ball.x > GOAL_LEFT && ball.x < GOAL_RIGHT) {
        scoreGoal("mint", now);
        return;
      }
      if (ball.y - ball.radius > FIELD.bottom && ball.x > GOAL_LEFT && ball.x < GOAL_RIGHT) {
        scoreGoal("coral", now);
        return;
      }

      const carrierIsAligning = Boolean(
        game.carrierOffset &&
        game.carrierTargetOffset &&
        Math.hypot(
          game.carrierOffset.x - game.carrierTargetOffset.x,
          game.carrierOffset.y - game.carrierTargetOffset.y,
        ) > 0.015,
      );
      const hasMotion = carrierIsAligning || game.bodies.some((body) => speed(body) > 7);
      if (!hasMotion) {
        const authorityTeam = game.activeTeam;
        for (const body of game.bodies) {
          body.vx = 0;
          body.vy = 0;
        }
        if (game.caughtThisMove && game.carrierId) {
          game.phase = "ready";
          game.turnTime = TURN_TIME;
          game.turnTick = 0;
          game.lastShooterId = null;
          game.caughtThisMove = false;
          game.message = game.passesLeft > 0 ? "PASS COMPLETE — GO AGAIN" : "FINAL TOUCH";
          syncHud();
        } else {
          switchTurn(game);
          syncHud();
        }
        if (onlineStage === "matched" && match?.myTeam === authorityTeam) publishState();
      }
    };

    const loop = (now: number) => {
      const dt = Math.min((now - previousTime) / 1000, 0.025);
      previousTime = now;

      if (game.phase === "ready" && !game.drag) {
        game.turnTime -= dt;
        const tick = Math.ceil(game.turnTime);
        if (tick !== game.turnTick) {
          game.turnTick = tick;
          syncHud();
        }
        if (game.turnTime <= 0) {
          const authorityTeam = game.activeTeam;
          switchTurn(game, "TIME'S UP");
          syncHud();
          if (onlineStage === "matched" && match?.myTeam === authorityTeam) publishState();
        }
      }

      updatePhysics(dt, now);
      drawGame(ctx, game, viewTeam);
      frameId = requestAnimationFrame(loop);
    };

    syncHud();
    frameId = requestAnimationFrame(loop);

    return () => {
      cancelAnimationFrame(frameId);
      canvas.removeEventListener("pointerdown", onPointerDown);
      canvas.removeEventListener("pointermove", onPointerMove);
      canvas.removeEventListener("pointerup", onPointerUp);
      canvas.removeEventListener("pointercancel", onPointerUp);
      socket?.off("game:shot", onRemoteShot);
      socket?.off("game:sync", onRemoteSync);
      socket?.off("game:error", onGameError);
    };
  }, [match, onlineStage, session]);

  const active = TEAM_META[hud.activeTeam];
  const nameForTeam = (team: Team) => {
    if (!match) return TEAM_META[team].name;
    return match.player.team === team ? match.player.name : match.opponent.name;
  };
  const mintName = nameForTeam("mint");
  const coralName = nameForTeam("coral");
  const turnMessage = onlineStage === "matched" && match?.myTeam !== hud.activeTeam && hud.phase === "ready"
    ? "OPPONENT IS AIMING"
    : hud.message;

  const requestRematch = () => {
    if (onlineStage === "practice") {
      kickoffTeamRef.current = "mint";
      setSession((value) => value + 1);
      return;
    }
    if (onlineStage === "matched" && hud.phase === "finished") {
      socketRef.current?.emit("match:rematch");
    }
  };

  return (
    <section className={styles.gameShell} aria-label="FlickXI tabletop football game">
      <header className={styles.scoreboard}>
        <button className={styles.iconButton} type="button" aria-label="Leave match" onClick={leaveMatch}>
          <span aria-hidden="true">←</span>
        </button>

        <div className={styles.playerIdentity}>
          <span className={`${styles.avatar} ${styles.mintAvatar}`}>{mintName.charAt(0).toUpperCase()}</span>
          <span className={styles.playerName}>{mintName}</span>
        </div>

        <div className={styles.scoreCenter}>
          <div className={styles.clock} aria-label={`${hud.turnTime} seconds remaining`}>
            <span aria-hidden="true">◷</span>
            <i style={{ transform: `scaleX(${hud.turnTime / TURN_TIME})` }} />
          </div>
          <strong>
            {hud.score.mint}<span>–</span>{hud.score.coral}
          </strong>
          <small>FIRST TO 3</small>
        </div>

        <div className={`${styles.playerIdentity} ${styles.playerIdentityRight}`}>
          <span className={styles.playerName}>{coralName}</span>
          <span className={`${styles.avatar} ${styles.coralAvatar}`}>{coralName.charAt(0).toUpperCase()}</span>
        </div>

        <button
          className={styles.iconButton}
          type="button"
          aria-label="Show game rules"
          onClick={() => setShowRules(true)}
        >
          <span aria-hidden="true">?</span>
        </button>
      </header>

      <div className={styles.turnStrip} data-team={hud.activeTeam}>
        <div>
          <span className={styles.liveDot} />
          {turnMessage}
        </div>
        <div className={styles.passPips} aria-label={`${hud.passesLeft} passes remaining`}>
          <span>PASS CHAIN</span>
          {[0, 1, 2].map((index) => (
            <i key={index} className={index < hud.passesLeft ? styles.passActive : undefined} />
          ))}
        </div>
      </div>

      <div className={styles.pitchFrame}>
        <canvas
          ref={canvasRef}
          className={styles.canvas}
          aria-label="Interactive football pitch. Drag an active team disc backwards and release to shoot."
        />
        <div className={styles.powerHint}>
          <span>← PULL</span>
          <i />
          <span>POWER →</span>
        </div>
      </div>

      <footer className={styles.gameFooter}>
        <div className={styles.emotes} aria-label="Quick reactions">
          <button type="button" aria-label="Send fire reaction">🔥</button>
          <button type="button" aria-label="Send applause reaction">👏</button>
          <button type="button" aria-label="Send target reaction">🎯</button>
        </div>
        <div className={styles.activeBadge} data-team={hud.activeTeam}>
          <span>{active.short}</span>
          <div>
            <small>ACTIVE TEAM</small>
            <strong>{nameForTeam(hud.activeTeam)}</strong>
          </div>
        </div>
        <button
          className={styles.restartButton}
          type="button"
          onClick={requestRematch}
          disabled={onlineStage === "matched" && hud.phase !== "finished"}
        >
          {onlineStage === "matched" && rematchReady > 0 ? <span>{rematchReady}/2 </span> : null}
          ↻ <span>Restart</span>
        </button>
      </footer>

      {showRules ? (
        <div className={styles.rulesBackdrop} role="presentation" onClick={() => setShowRules(false)}>
          <article className={styles.rulesCard} role="dialog" aria-modal="true" aria-labelledby="rules-title" onClick={(event) => event.stopPropagation()}>
            <div className={styles.rulesTopline}>
              <span>QUICK RULES</span>
              <button type="button" onClick={() => setShowRules(false)} aria-label="Close rules">×</button>
            </div>
            <h2 id="rules-title">Control the angle.<br />Own the chain.</h2>
            <ol>
              <li><b>Pull back</b><span>Drag opposite the direction you want the disc to travel.</span></li>
              <li><b>Read the power</b><span>A longer pull creates more force and a faster collision.</span></li>
              <li><b>Catch the pass</b><span>Hit a teammate to stick the ball and keep your turn, up to three times.</span></li>
              <li><b>Break possession</b><span>An opponent collision bounces normally and ends the passing chain.</span></li>
            </ol>
            <button className={styles.playButton} type="button" onClick={() => setShowRules(false)}>LET’S PLAY</button>
          </article>
        </div>
      ) : null}

      {onlineStage === "menu" ? (
        <div className={styles.matchOverlay}>
          <div className={styles.matchCard}>
            <div className={styles.livePill}><span /> LIVE MULTIPLAYER</div>
            <div className={styles.brandBall} aria-hidden="true"><i /><b>XI</b></div>
            <p className={styles.eyebrow}>FLICK FOOTBALL</p>
            <h1>Find a rival.<br />Own the pitch.</h1>
            <p className={styles.matchCopy}>Two players, one live match. The game begins only when another player joins the queue.</p>
            <label className={styles.nameField}>
              <span>PLAYER NAME</span>
              <input
                value={playerName}
                maxLength={18}
                onChange={(event) => setPlayerName(event.target.value)}
                aria-label="Player name"
              />
            </label>
            {networkMessage ? <p className={styles.networkError}>{networkMessage}</p> : null}
            <button className={styles.onlineButton} type="button" onClick={() => void startMatchmaking()}>
              <span>PLAY ONLINE</span><b>1 VS 1</b>
            </button>
            <button className={styles.practiceButton} type="button" onClick={startPractice}>PRACTICE ON THIS DEVICE</button>
          </div>
        </div>
      ) : null}

      {onlineStage === "searching" ? (
        <div className={styles.matchOverlay}>
          <div className={`${styles.matchCard} ${styles.searchCard}`}>
            <div className={styles.searchOrb} aria-hidden="true"><i /><i /><span>VS</span></div>
            <p className={styles.eyebrow}>MATCHMAKING</p>
            <h2>Finding your opponent</h2>
            <p className={styles.matchCopy}>Waiting for exactly one available player...</p>
            <div className={styles.queueStatus}><span /> SEARCHING <b>{searchSeconds}s</b></div>
            <button className={styles.practiceButton} type="button" onClick={cancelSearch}>CANCEL SEARCH</button>
          </div>
        </div>
      ) : null}

      {onlineStage === "disconnected" ? (
        <div className={styles.matchOverlay}>
          <div className={`${styles.matchCard} ${styles.searchCard}`}>
            <div className={styles.disconnectIcon} aria-hidden="true">!</div>
            <p className={styles.eyebrow}>MATCH ENDED</p>
            <h2>Opponent disconnected</h2>
            <p className={styles.matchCopy}>{networkMessage || "This match is no longer active."}</p>
            <button className={styles.onlineButton} type="button" onClick={() => void startMatchmaking()}>
              <span>FIND NEW RIVAL</span><b>GO</b>
            </button>
            <button className={styles.practiceButton} type="button" onClick={leaveMatch}>BACK TO LOBBY</button>
          </div>
        </div>
      ) : null}

      <span className={styles.srOnly} aria-live="polite">
        {TEAM_META[hud.activeTeam].name} turn. Score {hud.score.mint} to {hud.score.coral}.
        {hud.winner ? ` ${TEAM_META[hud.winner].name} won the match.` : ""}
      </span>
    </section>
  );
}
