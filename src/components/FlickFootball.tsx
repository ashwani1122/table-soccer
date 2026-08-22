"use client";

import { useEffect, useRef, useState } from "react";
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
) {
  const meta = TEAM_META[body.team as Team];
  ctx.save();
  ctx.translate(body.x, body.y);

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

function drawGame(ctx: CanvasRenderingContext2D, game: Game) {
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
      );
    }
  }
  if (ball) drawBall(ctx, ball);

  if (game.drag) {
    const body = game.bodies.find((item) => item.id === game.drag?.bodyId);
    if (body) drawAim(ctx, game.drag, body);
  }

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
  game.caughtThisMove = false;
  game.message = reason;
  for (const body of game.bodies) {
    body.vx = 0;
    body.vy = 0;
  }
}

export default function FlickFootball() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [session, setSession] = useState(0);
  const [showRules, setShowRules] = useState(false);
  const [hud, setHud] = useState<Hud>(() => toHud(makeGame()));

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
    let frameId = 0;
    let previousTime = performance.now();
    let lastHudKey = "";

    const syncHud = () => {
      const next = toHud(game);
      const key = JSON.stringify(next);
      if (key !== lastHudKey) {
        lastHudKey = key;
        setHud(next);
      }
    };

    const pointFromEvent = (event: PointerEvent) => {
      const rect = canvas.getBoundingClientRect();
      return {
        x: ((event.clientX - rect.left) / rect.width) * WIDTH,
        y: ((event.clientY - rect.top) / rect.height) * HEIGHT,
      };
    };

    const onPointerDown = (event: PointerEvent) => {
      if (game.phase !== "ready") return;
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

      const body = game.bodies.find((item) => item.id === drag.bodyId);
      if (!body) return;
      const launchSpeed = (drag.pull / MAX_PULL) * MAX_SPEED;
      body.vx = drag.dirX * launchSpeed;
      body.vy = drag.dirY * launchSpeed;
      game.lastShooterId = body.id;

      if (game.carrierId === body.id) {
        const ball = game.bodies.find((item) => item.kind === "ball");
        if (ball) {
          ball.vx = body.vx * 1.06;
          ball.vy = body.vy * 1.06;
          ball.x = body.x + drag.dirX * (body.radius + ball.radius + 2);
          ball.y = body.y + drag.dirY * (body.radius + ball.radius + 2);
        }
        game.carrierId = null;
        game.carrierOffset = null;
      }

      game.caughtThisMove = false;
      game.phase = "moving";
      game.message = "BALL IN MOTION";
      syncHud();
    };

    canvas.addEventListener("pointerdown", onPointerDown);
    canvas.addEventListener("pointermove", onPointerMove);
    canvas.addEventListener("pointerup", onPointerUp);
    canvas.addEventListener("pointercancel", onPointerUp);

    const scoreGoal = (scoringTeam: Team, now: number) => {
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
    };

    const updatePhysics = (dt: number, now: number) => {
      if (game.phase === "goal" && game.goalResetAt && now >= game.goalResetAt) {
        const kickoff = game.message.startsWith(TEAM_META.mint.name) ? "coral" : "mint";
        resetPositions(game, kickoff);
        syncHud();
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
            game.message = "PASS CAUGHT — KEEP THE TURN";
            syncHud();
          } else if (game.carrierId !== playerBody.id) {
            if (game.carrierId && playerBody.team !== game.activeTeam) {
              game.carrierId = null;
              game.carrierOffset = null;
              game.caughtThisMove = false;
              game.message = "POSSESSION BROKEN";
            }
            resolveCollision(playerBody, ballBody, 0.94);
          }
        }
      }

      if (game.carrierId && game.carrierOffset) {
        const carrier = game.bodies.find((body) => body.id === game.carrierId);
        if (carrier) {
          const gap = carrier.radius + ball.radius - 1;
          ball.x = carrier.x + game.carrierOffset.x * gap;
          ball.y = carrier.y + game.carrierOffset.y * gap;
          ball.vx = carrier.vx;
          ball.vy = carrier.vy;
        }
      }

      if (ball.y + ball.radius < FIELD.top && ball.x > GOAL_LEFT && ball.x < GOAL_RIGHT) {
        scoreGoal("mint", now);
        return;
      }
      if (ball.y - ball.radius > FIELD.bottom && ball.x > GOAL_LEFT && ball.x < GOAL_RIGHT) {
        scoreGoal("coral", now);
        return;
      }

      const hasMotion = game.bodies.some((body) => speed(body) > 7);
      if (!hasMotion) {
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
          switchTurn(game, "TIME'S UP");
          syncHud();
        }
      }

      updatePhysics(dt, now);
      drawGame(ctx, game);
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
    };
  }, [session]);

  const active = TEAM_META[hud.activeTeam];
  const opponent: Team = hud.activeTeam === "mint" ? "coral" : "mint";

  return (
    <section className={styles.gameShell} aria-label="FlickXI tabletop football game">
      <header className={styles.scoreboard}>
        <button className={styles.iconButton} type="button" aria-label="Leave match">
          <span aria-hidden="true">←</span>
        </button>

        <div className={styles.playerIdentity}>
          <span className={`${styles.avatar} ${styles.mintAvatar}`}>N</span>
          <span className={styles.playerName}>NEON FC</span>
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
          <span className={styles.playerName}>EMBER</span>
          <span className={`${styles.avatar} ${styles.coralAvatar}`}>E</span>
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
          {hud.message}
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
            <strong>{active.name}</strong>
          </div>
        </div>
        <button className={styles.restartButton} type="button" onClick={() => setSession((value) => value + 1)}>
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

      <span className={styles.srOnly} aria-live="polite">
        {TEAM_META[hud.activeTeam].name} turn. Score {hud.score.mint} to {hud.score.coral}.
        {hud.winner ? ` ${TEAM_META[hud.winner].name} won the match.` : ""}
      </span>
    </section>
  );
}
