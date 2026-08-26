"use client";

import dynamic from "next/dynamic";
import { type FormEvent, useEffect, useMemo, useRef, useState } from "react";
import {
  advanceFixedPhysicsClock,
  advanceBallOrientation,
  calculatePossessionImpact,
  capturePossessionMomentum,
  constrainBodyToGoalArena,
  isWithinPassControl,
  resolveBallPlayerCollision,
  resolvePossessedBallCollision,
  FIXED_PHYSICS_STEP_SECONDS,
  IDENTITY_BALL_ORIENTATION,
  orientVectorWithBall,
  type BallOrientation,
} from "@/lib/game-physics";
import { RealtimeClient } from "@/lib/realtime-client";
import {
  BOT_PLAYER_SETUP,
  COUNTRY_CODES,
  DEFAULT_PLAYER_SETUP,
  FORMATION_OPTIONS,
  countryFlagEmoji,
  countryName,
  type AttackingFormationId,
  type DefensiveFormationId,
  type FormationId,
  type PlayerSetup,
  type Team,
} from "@/lib/match-setup";
import styles from "./FlickFootball.module.css";

const AuthIdentity = dynamic(() => import("./AuthIdentity"), { ssr: false });

const WIDTH = 420;
const HEIGHT = 720;
const FIELD = { left: 27, right: 393, top: 42, bottom: 678 };
const GOAL_LEFT = 157;
const GOAL_RIGHT = 263;
const GOAL_CENTER_X = (GOAL_LEFT + GOAL_RIGHT) / 2;
const GOAL_ARENA = {
  ...FIELD,
  goalLeft: GOAL_LEFT,
  goalRight: GOAL_RIGHT,
  topGoalBack: 7,
  bottomGoalBack: HEIGHT - 7,
};
const MAX_PULL = 92;
const MAX_SPEED = 960;
const BALL_RADIUS = 12;
const PLAYER_PUCK_HEIGHT = 6;
const BALL_WALL_RESTITUTION = 0.997;
const BALL_COLLISION_RESTITUTION = 0.999;
const BALL_FRICTION = 1.05;
const PLAYER_FRICTION = 2.2;
const REACTION_OPTIONS = ["⚽", "🔥", "👏", "😂", "😮", "💚"] as const;
const POSSESSION_FRICTION = 1.95;
const TURN_TIME = 10;
const PASS_GAP = 7;
const PASS_ALIGN_DELAY = 1;
const PASS_MOMENTUM_TRANSFER = 0.5;
const BALL_TO_PLAYER_TRANSFER = 0.5;
const RESULT_HOME_DELAY = 3_000;
const AIM_BROADCAST_MS = 60;
const TURF_TRAIL_MIN_SPEED = 210;
const COLLISION_SOLVER_PASSES = 4;

type Phase = "ready" | "moving" | "goal" | "finished";
type SetupStage = "country" | "formation" | "waiting" | "ready";
type TeamSetups = Record<Team, PlayerSetup>;

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
  rollOrientation?: BallOrientation;
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
  passChain: number;
  turnTime: number;
  turnTick: number;
  drag: Drag | null;
  lastShooterId: string | null;
  carrierId: string | null;
  carrierOffset: { x: number; y: number } | null;
  carrierTargetOffset: { x: number; y: number } | null;
  carrierAlignDelay: number;
  caughtThisMove: boolean;
  goalResetAt: number | null;
  message: string;
  winner: Team | null;
};

type Hud = {
  activeTeam: Team;
  phase: Phase;
  score: Record<Team, number>;
  passChain: number;
  turnTime: number;
  message: string;
  winner: Team | null;
};

type OnlineStage =
  | "menu"
  | "searching"
  | "join-room"
  | "waiting-room"
  | "matched"
  | "practice"
  | "disconnected";

type MatchInfo = {
  matchId: string;
  myTeam: Team;
  player: {
    name: string;
    team: Team;
    isBot?: boolean;
    countryCode?: string;
    attackingFormation?: AttackingFormationId;
    defensiveFormation?: DefensiveFormationId;
  };
  opponent: {
    name: string;
    team: Team;
    isBot?: boolean;
    countryCode?: string;
    attackingFormation?: AttackingFormationId;
    defensiveFormation?: DefensiveFormationId;
  };
  startsAt: number;
  setupReady?: boolean;
  roomCode?: string | null;
};

type MatchSetupPayload = {
  matchId: string;
  players: Record<Team, PlayerSetup | null>;
  ready: boolean;
  startsAt: number | null;
};

type ChatMessage = {
  id: string;
  matchId: string;
  senderTeam: Team;
  senderName: string;
  text: string;
  sentAt: number;
};

type GameReaction = {
  id: string;
  matchId: string;
  senderTeam: Team;
  emoji: string;
  sentAt: number;
  expiresAt: number;
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

type SequencedShot = Shot & { sequence: number };

type CachedSync = {
  matchId: string;
  snapshot: GameSnapshot;
  sequence: number;
};

type CachedShot = {
  matchId: string;
  shot: SequencedShot;
};

type SoundEngine = {
  unlock: () => void;
  setEnabled: (enabled: boolean) => void;
  flick: (power: number) => void;
  impact: (kind: "disc" | "ball", strength: number) => void;
  wall: (strength: number) => void;
  pass: () => void;
  goal: () => void;
  win: () => void;
  turn: () => void;
  dispose: () => void;
};

type ConfettiPiece = {
  x: number;
  y: number;
  vx: number;
  vy: number;
  size: number;
  rotation: number;
  spin: number;
  life: number;
  color: string;
};

type TurfParticle = {
  x: number;
  y: number;
  vx: number;
  vy: number;
  length: number;
  rotation: number;
  color: string;
  life: number;
  maxLife: number;
};

const TEAM_META = {
  mint: { name: "NEON FC", short: "N", primary: "#48e0aa", dark: "#096f67" },
  coral: { name: "EMBER", short: "E", primary: "#ff6d73", dark: "#9f2446" },
} as const;

function createSoundEngine(): SoundEngine {
  let context: AudioContext | null = null;
  let enabled = true;
  let lastImpactAt = 0;
  let lastWallAt = 0;
  let ballHitBuffer: AudioBuffer | null = null;
  let applauseBuffer: AudioBuffer | null = null;
  let samplesLoading = false;

  const getContext = () => {
    if (!enabled) return null;
    context ??= new AudioContext();
    if (context.state === "suspended") void context.resume();
    return context;
  };

  const loadSamples = () => {
    const audio = getContext();
    if (!audio || samplesLoading) return;
    samplesLoading = true;
    const decode = async (url: string) => {
      const response = await fetch(url);
      if (!response.ok) throw new Error(`Could not load ${url}`);
      return audio.decodeAudioData(await response.arrayBuffer());
    };
    void Promise.all([
      decode("/sounds/player-ball-hit.wav"),
      decode("/sounds/match-win-applause.wav"),
    ]).then(([ballHit, applause]) => {
      ballHitBuffer = ballHit;
      applauseBuffer = applause;
    }).catch(() => {
      samplesLoading = false;
    });
  };

  const playBuffer = (
    buffer: AudioBuffer,
    volume: number,
    playbackRate = 1,
    maximumDuration?: number,
  ) => {
    const audio = getContext();
    if (!audio) return;
    const source = audio.createBufferSource();
    const gain = audio.createGain();
    source.buffer = buffer;
    source.playbackRate.value = playbackRate;
    gain.gain.value = volume;
    source.connect(gain);
    gain.connect(audio.destination);
    source.start();
    if (maximumDuration) source.stop(audio.currentTime + Math.min(maximumDuration, buffer.duration));
  };

  const tone = (
    startFrequency: number,
    endFrequency: number,
    duration: number,
    volume: number,
    type: OscillatorType = "sine",
    delay = 0,
  ) => {
    const audio = getContext();
    if (!audio) return;
    const start = audio.currentTime + delay;
    const oscillator = audio.createOscillator();
    const gain = audio.createGain();
    oscillator.type = type;
    oscillator.frequency.setValueAtTime(startFrequency, start);
    oscillator.frequency.exponentialRampToValueAtTime(Math.max(30, endFrequency), start + duration);
    gain.gain.setValueAtTime(Math.max(0.0001, volume), start);
    gain.gain.exponentialRampToValueAtTime(0.0001, start + duration);
    oscillator.connect(gain);
    gain.connect(audio.destination);
    oscillator.start(start);
    oscillator.stop(start + duration + 0.01);
  };

  return {
    unlock: () => {
      getContext();
      loadSamples();
    },
    setEnabled: (nextEnabled) => {
      enabled = nextEnabled;
      if (!enabled && context?.state === "running") void context.suspend();
      if (enabled && context?.state === "suspended") void context.resume();
    },
    flick: (power) => {
      tone(250 + power * 120, 95, 0.075 + power * 0.035, 0.025 + power * 0.035, "sawtooth");
    },
    impact: (kind, strength) => {
      const now = performance.now();
      if (now - lastImpactAt < 38) return;
      lastImpactAt = now;
      const force = clamp(strength, 0.15, 1);
      if (kind === "ball") {
        loadSamples();
        if (ballHitBuffer) {
          playBuffer(ballHitBuffer, 0.18 + force * 0.42, 0.94 + force * 0.1, 0.55);
        }
        else tone(720, 430, 0.035, 0.018 + force * 0.035, "triangle");
      } else {
        tone(240, 145, 0.045, 0.015 + force * 0.032, "square");
      }
    },
    wall: (strength) => {
      const now = performance.now();
      if (now - lastWallAt < 55) return;
      lastWallAt = now;
      tone(165, 105, 0.05, 0.015 + clamp(strength, 0, 1) * 0.025, "square");
    },
    pass: () => {
      tone(540, 880, 0.09, 0.035, "sine");
      tone(820, 1040, 0.07, 0.018, "sine", 0.055);
    },
    goal: () => {
      [0, 0.075, 0.15, 0.24].forEach((delay, index) => {
        const frequencies = [420, 560, 700, 940];
        tone(frequencies[index] ?? 700, (frequencies[index] ?? 700) * 1.08, 0.16, 0.045, "triangle", delay);
      });
    },
    win: () => {
      loadSamples();
      if (applauseBuffer) playBuffer(applauseBuffer, 0.72, 1, 5);
      else tone(520, 880, 0.4, 0.04, "triangle");
    },
    turn: () => {
      tone(310, 390, 0.065, 0.022, "sine");
    },
    dispose: () => {
      if (context) void context.close();
      context = null;
      ballHitBuffer = null;
      applauseBuffer = null;
    },
  };
}

const CONFETTI_COLORS = ["#48e0aa", "#ff6d73", "#ffd75a", "#65a9ff", "#ffffff", "#bc75ff"];

function addConfetti(pieces: ConfettiPiece[], amount: number) {
  for (let index = 0; index < amount; index += 1) {
    pieces.push({
      x: Math.random() * WIDTH,
      y: -10 - Math.random() * 150,
      vx: (Math.random() - 0.5) * 150,
      vy: 105 + Math.random() * 230,
      size: 4 + Math.random() * 7,
      rotation: Math.random() * Math.PI,
      spin: (Math.random() - 0.5) * 9,
      life: 2.5 + Math.random() * 2.1,
      color: CONFETTI_COLORS[index % CONFETTI_COLORS.length] ?? "#ffffff",
    });
  }
  if (pieces.length > 420) pieces.splice(0, pieces.length - 420);
}

function updateAndDrawConfetti(
  ctx: CanvasRenderingContext2D,
  pieces: ConfettiPiece[],
  dt: number,
) {
  for (let index = pieces.length - 1; index >= 0; index -= 1) {
    const piece = pieces[index];
    if (!piece) continue;
    piece.life -= dt;
    piece.vy += 270 * dt;
    piece.vx *= Math.exp(-0.35 * dt);
    piece.x += piece.vx * dt;
    piece.y += piece.vy * dt;
    piece.rotation += piece.spin * dt;
    if (piece.life <= 0 || piece.y > HEIGHT + 30) {
      pieces.splice(index, 1);
      continue;
    }
    ctx.save();
    ctx.translate(piece.x, piece.y);
    ctx.rotate(piece.rotation);
    ctx.globalAlpha = Math.min(1, piece.life * 1.8);
    ctx.fillStyle = piece.color;
    ctx.fillRect(-piece.size / 2, -piece.size / 4, piece.size, piece.size / 2);
    ctx.restore();
  }
}

function updateTurfTrail(particles: TurfParticle[], ball: Body, dt: number) {
  for (let index = particles.length - 1; index >= 0; index -= 1) {
    const particle = particles[index];
    if (!particle) continue;
    particle.life -= dt;
    particle.x += particle.vx * dt;
    particle.y += particle.vy * dt;
    particle.vx *= Math.exp(-8 * dt);
    particle.vy *= Math.exp(-8 * dt);
    particle.rotation += 2.4 * dt;
    if (particle.life <= 0) particles.splice(index, 1);
  }

  const ballSpeed = speed(ball);
  if (ballSpeed < TURF_TRAIL_MIN_SPEED) return;
  const emissionChance = Math.min(1, dt * (10 + ballSpeed / 85));
  if (Math.random() > emissionChance) return;

  const directionX = ball.vx / ballSpeed;
  const directionY = ball.vy / ballSpeed;
  const sideways = (Math.random() - 0.5) * ball.radius * 1.15;
  const sideDirection = Math.random() < 0.5 ? -1 : 1;
  const maxLife = 0.16 + Math.random() * 0.16;
  particles.push({
    x: ball.x - directionX * (ball.radius * 0.75) - directionY * sideways,
    y: ball.y - directionY * (ball.radius * 0.75) + directionX * sideways,
    vx: -directionX * (8 + Math.random() * 10) - directionY * sideDirection * (6 + Math.random() * 10),
    vy: -directionY * (8 + Math.random() * 10) + directionX * sideDirection * (6 + Math.random() * 10),
    length: 1.8 + Math.random() * 2.4,
    rotation: Math.atan2(directionY, directionX) + (Math.random() - 0.5) * 1.4,
    color: Math.random() > 0.45 ? "#86b85f" : "#397d43",
    life: maxLife,
    maxLife,
  });
  if (particles.length > 28) particles.splice(0, particles.length - 28);
}

function drawTurfTrail(ctx: CanvasRenderingContext2D, particles: TurfParticle[]) {
  ctx.save();
  for (const particle of particles) {
    const progress = clamp(particle.life / particle.maxLife, 0, 1);
    ctx.save();
    ctx.translate(particle.x, particle.y);
    ctx.rotate(particle.rotation);
    ctx.globalAlpha = Math.sin(progress * Math.PI) * 0.58;
    ctx.strokeStyle = particle.color;
    ctx.lineWidth = 0.85;
    ctx.lineCap = "round";
    ctx.beginPath();
    ctx.moveTo(-particle.length * 0.5, 0);
    ctx.lineTo(particle.length * 0.5, 0);
    ctx.stroke();
    ctx.restore();
  }
  ctx.restore();
}

function player(id: string, team: Team, number: number, x: number, y: number): Body {
  return { id, kind: "player", team, number, x, y, vx: 0, vy: 0, radius: 19, mass: 2.6 };
}

const DEFAULT_TEAM_SETUPS: TeamSetups = {
  mint: { ...DEFAULT_PLAYER_SETUP },
  coral: { ...BOT_PLAYER_SETUP },
};

const FORMATION_POSITIONS: Record<FormationId, readonly (readonly [number, number])[]> = {
  "attacking-1-3-2": [[210, 650], [110, 562], [210, 578], [310, 562], [158, 470], [262, 470]],
  "attacking-1-2-3": [[210, 650], [150, 570], [270, 570], [95, 475], [210, 450], [325, 475]],
  "attacking-1-4-1": [[210, 650], [85, 560], [165, 575], [255, 575], [335, 560], [210, 445]],
  "attacking-1-2-1-2": [[210, 650], [145, 580], [275, 580], [210, 520], [145, 450], [275, 450]],
  "defensive-1-3-2": [[210, 650], [110, 600], [210, 610], [310, 600], [160, 535], [260, 535]],
  "defensive-1-2-3": [[210, 650], [150, 605], [270, 605], [100, 545], [210, 525], [320, 545]],
  "defensive-1-4-1": [[210, 650], [85, 600], [165, 610], [255, 610], [335, 600], [210, 520]],
  "defensive-1-2-1-2": [[210, 650], [145, 610], [275, 610], [210, 560], [150, 510], [270, 510]],
};

function makeBodies(
  teamSetups: TeamSetups = DEFAULT_TEAM_SETUPS,
  activeTeam: Team = "mint",
): Body[] {
  const mintFormation = activeTeam === "mint"
    ? teamSetups.mint.attackingFormation
    : teamSetups.mint.defensiveFormation;
  const coralFormation = activeTeam === "coral"
    ? teamSetups.coral.attackingFormation
    : teamSetups.coral.defensiveFormation;
  const mintPositions = FORMATION_POSITIONS[mintFormation];
  const coralPositions = FORMATION_POSITIONS[coralFormation]
    .map(([x, y]) => [WIDTH - x, HEIGHT - y] as const);
  return [
    ...coralPositions.map(([x, y], index) => player(`coral-${index + 1}`, "coral", index + 1, x, y)),
    ...mintPositions.map(([x, y], index) => player(`mint-${index + 1}`, "mint", index + 1, x, y)),
    {
      id: "ball",
      kind: "ball",
      x: 210,
      y: 360,
      vx: 0,
      vy: 0,
      radius: BALL_RADIUS,
      mass: 0.7,
      rollOrientation: [...IDENTITY_BALL_ORIENTATION],
    },
  ];
}

function makeGame(
  teamSetups: TeamSetups = DEFAULT_TEAM_SETUPS,
  activeTeam: Team = "mint",
): Game {
  return {
    bodies: makeBodies(teamSetups, activeTeam),
    activeTeam,
    phase: "ready",
    score: { mint: 0, coral: 0 },
    passChain: 0,
    turnTime: TURN_TIME,
    turnTick: 0,
    drag: null,
    lastShooterId: null,
    carrierId: null,
    carrierOffset: null,
    carrierTargetOffset: null,
    carrierAlignDelay: 0,
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
    passChain: game.passChain,
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

function directionToOpponentGoal(body: Body, team: Team) {
  const dx = GOAL_CENTER_X - body.x;
  const dy = (team === "mint" ? FIELD.top : FIELD.bottom) - body.y;
  const length = Math.max(0.001, Math.hypot(dx, dy));
  return { x: dx / length, y: dy / length };
}

function constrainPlayerToPitch(body: Body) {
  return constrainBodyToGoalArena(body, GOAL_ARENA, 0.84);
}

function constrainFreeBallToPitch(ball: Body) {
  return constrainBodyToGoalArena(ball, GOAL_ARENA, BALL_WALL_RESTITUTION);
}

function lockBallToCarrier(
  carrier: Body,
  ball: Body,
  offset: { x: number; y: number },
) {
  const controlDistance = carrier.radius + ball.radius + PASS_GAP;
  const placeBall = () => {
    ball.x = carrier.x + offset.x * controlDistance;
    ball.y = carrier.y + offset.y * controlDistance;
    ball.vx = carrier.vx;
    ball.vy = carrier.vy;
  };

  placeBall();
  const desiredX = ball.x;
  const desiredY = ball.y;
  constrainFreeBallToPitch(ball);

  if (ball.x !== desiredX || ball.y !== desiredY) {
    carrier.x += ball.x - desiredX;
    carrier.y += ball.y - desiredY;
    carrier.vx = ball.vx;
    carrier.vy = ball.vy;
  }

  constrainPlayerToPitch(carrier);
  placeBall();
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

function drawCrowdStand(
  ctx: CanvasRenderingContext2D,
  x: number,
  width: number,
  rightSide: boolean,
) {
  const stand = ctx.createLinearGradient(x, 0, x + width, 0);
  if (rightSide) {
    stand.addColorStop(0, "#33413d");
    stand.addColorStop(0.3, "#17231f");
    stand.addColorStop(1, "#080f0e");
  } else {
    stand.addColorStop(0, "#080f0e");
    stand.addColorStop(0.7, "#17231f");
    stand.addColorStop(1, "#33413d");
  }
  ctx.fillStyle = stand;
  ctx.fillRect(x, 54, width, 612);

  const crowdColors = ["#f5c451", "#ed5d65", "#58b6e8", "#e8eef2", "#75d68e", "#b875e2"];
  for (let row = 0; row < 39; row += 1) {
    const y = 61 + row * 15.2;
    for (let column = 0; column < 3; column += 1) {
      const colorIndex = (row * 5 + column * 3 + (rightSide ? 2 : 0)) % crowdColors.length;
      const personX = x + 4 + column * 6 + ((row + column) % 2) * 1.5;
      ctx.fillStyle = crowdColors[colorIndex] ?? "#e8eef2";
      ctx.fillRect(personX - 1.5, y + 2.6, 3, 4.8);
      ctx.fillStyle = (row + column) % 3 === 0 ? "#c88b65" : "#f0b98c";
      ctx.beginPath();
      ctx.arc(personX, y, 1.55, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  ctx.strokeStyle = "rgba(193, 208, 203, 0.42)";
  ctx.lineWidth = 1;
  for (let y = 54; y <= 666; y += 68) {
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(x + width, y);
    ctx.stroke();
  }
  ctx.fillStyle = "#94a09c";
  ctx.fillRect(rightSide ? x : x + width - 2, 48, 2, 624);
}

function drawStadiumGoal(ctx: CanvasRenderingContext2D, top: boolean) {
  const frontY = top ? FIELD.top : FIELD.bottom;
  const backY = top ? 7 : HEIGHT - 7;
  const backLeft = GOAL_LEFT + 7;
  const backRight = GOAL_RIGHT - 7;

  ctx.save();
  ctx.beginPath();
  ctx.moveTo(GOAL_LEFT, frontY);
  ctx.lineTo(backLeft, backY);
  ctx.lineTo(backRight, backY);
  ctx.lineTo(GOAL_RIGHT, frontY);
  ctx.closePath();
  const netShade = ctx.createLinearGradient(0, backY, 0, frontY);
  netShade.addColorStop(0, "rgba(226, 239, 242, 0.2)");
  netShade.addColorStop(1, "rgba(226, 239, 242, 0.04)");
  ctx.fillStyle = netShade;
  ctx.shadowColor = "rgba(0, 0, 0, 0.3)";
  ctx.shadowBlur = 8;
  ctx.fill();
  ctx.shadowColor = "transparent";

  ctx.strokeStyle = "rgba(226, 239, 242, 0.48)";
  ctx.lineWidth = 0.8;
  for (let column = 0; column <= 12; column += 1) {
    const amount = column / 12;
    ctx.beginPath();
    ctx.moveTo(GOAL_LEFT + (GOAL_RIGHT - GOAL_LEFT) * amount, frontY);
    ctx.lineTo(backLeft + (backRight - backLeft) * amount, backY);
    ctx.stroke();
  }
  for (let row = 1; row < 6; row += 1) {
    const amount = row / 6;
    const y = frontY + (backY - frontY) * amount;
    const left = GOAL_LEFT + (backLeft - GOAL_LEFT) * amount;
    const right = GOAL_RIGHT + (backRight - GOAL_RIGHT) * amount;
    ctx.beginPath();
    ctx.moveTo(left, y);
    ctx.lineTo(right, y);
    ctx.stroke();
  }

  const framePath = () => {
    ctx.beginPath();
    ctx.moveTo(GOAL_LEFT, frontY);
    ctx.lineTo(backLeft, backY);
    ctx.lineTo(backRight, backY);
    ctx.lineTo(GOAL_RIGHT, frontY);
    ctx.moveTo(GOAL_LEFT, frontY);
    ctx.lineTo(GOAL_RIGHT, frontY);
  };
  framePath();
  ctx.strokeStyle = "rgba(4, 12, 15, 0.62)";
  ctx.lineWidth = 6;
  ctx.stroke();
  framePath();
  const metal = ctx.createLinearGradient(GOAL_LEFT, 0, GOAL_RIGHT, 0);
  metal.addColorStop(0, "#87969d");
  metal.addColorStop(0.35, "#f7ffff");
  metal.addColorStop(0.7, "#b9c8cc");
  metal.addColorStop(1, "#6f7e84");
  ctx.strokeStyle = metal;
  ctx.lineWidth = 3;
  ctx.stroke();
  ctx.restore();
}

function drawCornerFlag(ctx: CanvasRenderingContext2D, x: number, y: number, top: boolean, left: boolean) {
  const directionY = top ? -1 : 1;
  const poleTopY = y + directionY * 17;
  ctx.strokeStyle = "#d7e1df";
  ctx.lineWidth = 1.4;
  ctx.beginPath();
  ctx.moveTo(x, y);
  ctx.lineTo(x, poleTopY);
  ctx.stroke();
  ctx.fillStyle = top ? "#ff5068" : "#45b9ef";
  ctx.beginPath();
  ctx.moveTo(x, poleTopY);
  ctx.quadraticCurveTo(x + (left ? 5 : -5), poleTopY + directionY * 2, x + (left ? 10 : -10), poleTopY + directionY * 7);
  ctx.lineTo(x, poleTopY + directionY * 9);
  ctx.closePath();
  ctx.fill();
}

function drawPitch(ctx: CanvasRenderingContext2D) {
  ctx.clearRect(0, 0, WIDTH, HEIGHT);

  const surround = ctx.createLinearGradient(0, 0, WIDTH, HEIGHT);
  surround.addColorStop(0, "#173f29");
  surround.addColorStop(0.5, "#0e2f22");
  surround.addColorStop(1, "#071d17");
  ctx.fillStyle = surround;
  ctx.fillRect(0, 0, WIDTH, HEIGHT);

  drawCrowdStand(ctx, 2, 20, false);
  drawCrowdStand(ctx, WIDTH - 22, 20, true);

  for (let y = FIELD.top; y < FIELD.bottom; y += 53) {
    const stripe = Math.floor((y - FIELD.top) / 53) % 2;
    const grass = ctx.createLinearGradient(FIELD.left, y, FIELD.right, y + 53);
    grass.addColorStop(0, stripe === 0 ? "#2e8a45" : "#277e3e");
    grass.addColorStop(0.5, stripe === 0 ? "#45a955" : "#38994c");
    grass.addColorStop(1, stripe === 0 ? "#277e3e" : "#237439");
    ctx.fillStyle = grass;
    ctx.fillRect(FIELD.left, y, FIELD.right - FIELD.left, Math.min(53, FIELD.bottom - y));
  }

  ctx.fillStyle = "rgba(228, 255, 199, 0.075)";
  for (let blade = 0; blade < 190; blade += 1) {
    const x = FIELD.left + ((blade * 83) % (FIELD.right - FIELD.left));
    const y = FIELD.top + ((blade * 137) % (FIELD.bottom - FIELD.top));
    ctx.fillRect(x, y, 1, 3 + (blade % 4));
  }

  const vignette = ctx.createRadialGradient(210, 360, 65, 210, 360, 390);
  vignette.addColorStop(0, "rgba(210, 255, 178, 0.1)");
  vignette.addColorStop(0.72, "rgba(18, 78, 36, 0.02)");
  vignette.addColorStop(1, "rgba(0, 18, 11, 0.34)");
  ctx.fillStyle = vignette;
  ctx.fillRect(FIELD.left, FIELD.top, FIELD.right - FIELD.left, FIELD.bottom - FIELD.top);

  drawStadiumGoal(ctx, true);
  drawStadiumGoal(ctx, false);

  ctx.strokeStyle = "rgba(246, 250, 238, 0.9)";
  ctx.lineWidth = 2.1;
  ctx.strokeRect(FIELD.left, FIELD.top, FIELD.right - FIELD.left, FIELD.bottom - FIELD.top);
  ctx.beginPath();
  ctx.moveTo(FIELD.left, HEIGHT / 2);
  ctx.lineTo(FIELD.right, HEIGHT / 2);
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(WIDTH / 2, HEIGHT / 2, 58, 0, Math.PI * 2);
  ctx.stroke();
  ctx.fillStyle = "rgba(247, 251, 239, 0.82)";
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
  ctx.fillStyle = "rgba(247, 251, 239, 0.86)";
  ctx.beginPath();
  ctx.arc(WIDTH / 2, FIELD.top + 61, 2.5, 0, Math.PI * 2);
  ctx.arc(WIDTH / 2, FIELD.bottom - 61, 2.5, 0, Math.PI * 2);
  ctx.fill();

  const sideWall = ctx.createLinearGradient(FIELD.left - 6, 0, FIELD.left + 2, 0);
  sideWall.addColorStop(0, "#5e6769");
  sideWall.addColorStop(0.45, "#d8dedd");
  sideWall.addColorStop(1, "#6d7779");
  ctx.fillStyle = sideWall;
  ctx.shadowColor = "rgba(0, 0, 0, 0.38)";
  ctx.shadowBlur = 5;
  ctx.fillRect(FIELD.left - 6, FIELD.top, 7, FIELD.bottom - FIELD.top);
  ctx.fillRect(FIELD.right - 1, FIELD.top, 7, FIELD.bottom - FIELD.top);
  ctx.shadowColor = "transparent";
  ctx.strokeStyle = "rgba(65, 72, 73, 0.52)";
  ctx.lineWidth = 0.8;
  for (let y = FIELD.top + 42; y < FIELD.bottom; y += 42) {
    ctx.beginPath();
    ctx.moveTo(FIELD.left - 6, y);
    ctx.lineTo(FIELD.left + 1, y);
    ctx.moveTo(FIELD.right - 1, y);
    ctx.lineTo(FIELD.right + 6, y);
    ctx.stroke();
  }

  const endWall = ctx.createLinearGradient(0, FIELD.top - 6, 0, FIELD.top + 1);
  endWall.addColorStop(0, "#646d70");
  endWall.addColorStop(0.5, "#e0e4e3");
  endWall.addColorStop(1, "#737d80");
  ctx.fillStyle = endWall;
  ctx.fillRect(FIELD.left, FIELD.top - 6, GOAL_LEFT - FIELD.left, 7);
  ctx.fillRect(GOAL_RIGHT, FIELD.top - 6, FIELD.right - GOAL_RIGHT, 7);
  ctx.fillRect(FIELD.left, FIELD.bottom - 1, GOAL_LEFT - FIELD.left, 7);
  ctx.fillRect(GOAL_RIGHT, FIELD.bottom - 1, FIELD.right - GOAL_RIGHT, 7);
  ctx.strokeStyle = "rgba(79, 87, 89, 0.6)";
  for (let x = FIELD.left + 42; x < FIELD.right; x += 42) {
    if (x > GOAL_LEFT && x < GOAL_RIGHT) continue;
    ctx.beginPath();
    ctx.moveTo(x, FIELD.top - 6);
    ctx.lineTo(x, FIELD.top + 1);
    ctx.moveTo(x, FIELD.bottom - 1);
    ctx.lineTo(x, FIELD.bottom + 6);
    ctx.stroke();
  }

  drawCornerFlag(ctx, FIELD.left - 4, FIELD.top + 1, true, true);
  drawCornerFlag(ctx, FIELD.right + 4, FIELD.top + 1, true, false);
  drawCornerFlag(ctx, FIELD.left - 4, FIELD.bottom - 1, false, true);
  drawCornerFlag(ctx, FIELD.right + 4, FIELD.bottom - 1, false, false);
}

type BallVector = [number, number, number];

const FOOTBALL_PHI = (1 + Math.sqrt(5)) / 2;
const FOOTBALL_PANEL_CENTERS: BallVector[] = [
  [0, -1, -FOOTBALL_PHI], [0, -1, FOOTBALL_PHI],
  [0, 1, -FOOTBALL_PHI], [0, 1, FOOTBALL_PHI],
  [-1, -FOOTBALL_PHI, 0], [-1, FOOTBALL_PHI, 0],
  [1, -FOOTBALL_PHI, 0], [1, FOOTBALL_PHI, 0],
  [-FOOTBALL_PHI, 0, -1], [-FOOTBALL_PHI, 0, 1],
  [FOOTBALL_PHI, 0, -1], [FOOTBALL_PHI, 0, 1],
].map(([x, y, z]) => {
  const length = Math.hypot(x, y, z);
  return [x / length, y / length, z / length];
});

function crossBallVectors(a: BallVector, b: BallVector): BallVector {
  return [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ];
}

function normalizeBallVector([x, y, z]: BallVector): BallVector {
  const length = Math.max(0.0001, Math.hypot(x, y, z));
  return [x / length, y / length, z / length];
}

function rotateBallVector(
  vector: BallVector,
  axis: BallVector,
  angle: number,
): BallVector {
  const cosine = Math.cos(angle);
  const sine = Math.sin(angle);
  const dot = vector[0] * axis[0] + vector[1] * axis[1] + vector[2] * axis[2];
  const cross = crossBallVectors(axis, vector);
  return [
    vector[0] * cosine + cross[0] * sine + axis[0] * dot * (1 - cosine),
    vector[1] * cosine + cross[1] * sine + axis[1] * dot * (1 - cosine),
    vector[2] * cosine + cross[2] * sine + axis[2] * dot * (1 - cosine),
  ];
}

function orientFootballVector(vector: BallVector, orientation: BallOrientation) {
  const presentationTilt = Math.atan(1 / FOOTBALL_PHI);
  return orientVectorWithBall(
    rotateBallVector(vector, [1, 0, 0], presentationTilt),
    orientation,
  );
}

function drawBall(ctx: CanvasRenderingContext2D, ball: Body) {
  ctx.save();
  ctx.translate(ball.x, ball.y);

  const radius = ball.radius;
  const ballSpeed = speed(ball);
  const speedRatio = clamp(ballSpeed / MAX_SPEED, 0, 1);
  const directionX = ballSpeed > 0.01 ? ball.vx / ballSpeed : 0;
  const directionY = ballSpeed > 0.01 ? ball.vy / ballSpeed : 0;
  const contactTrail = speedRatio * 2.2;

  // A tight, speed-reactive contact shadow keeps the ball planted on the turf.
  // The previous soft shadow made the ball appear to hover and skate.
  ctx.fillStyle = `rgba(0, 0, 0, ${0.46 - speedRatio * 0.08})`;
  ctx.shadowColor = "rgba(0, 0, 0, 0.28)";
  ctx.shadowBlur = 2.5 - speedRatio;
  ctx.beginPath();
  ctx.ellipse(
    0.8 - directionX * contactTrail,
    radius * 0.66 - directionY * contactTrail,
    radius * (0.72 + speedRatio * 0.08),
    radius * (0.18 + (1 - speedRatio) * 0.035),
    0,
    0,
    Math.PI * 2,
  );
  ctx.fill();
  ctx.shadowColor = "transparent";

  const shell = ctx.createRadialGradient(
    -radius * 0.42,
    -radius * 0.48,
    radius * 0.04,
    radius * 0.14,
    radius * 0.16,
    radius * 1.14,
  );
  shell.addColorStop(0, "#ffffff");
  shell.addColorStop(0.38, "#fbfcfa");
  shell.addColorStop(0.7, "#e8eceb");
  shell.addColorStop(0.9, "#bbc4c4");
  shell.addColorStop(1, "#717c82");
  ctx.fillStyle = shell;
  ctx.beginPath();
  ctx.arc(0, 0, radius, 0, Math.PI * 2);
  ctx.fill();

  // Project the twelve pentagons of a traditional 32-panel football onto the
  // sphere. The projection rolls around the travel axis while the light stays put.
  ctx.save();
  ctx.beginPath();
  ctx.arc(0, 0, radius - 0.55, 0, Math.PI * 2);
  ctx.clip();

  const rollOrientation = ball.rollOrientation ?? IDENTITY_BALL_ORIENTATION;
  const panelRadius = 0.285;
  const seamRadius = 0.5;
  const panels = FOOTBALL_PANEL_CENTERS.map((sourceCenter) => {
    const reference: BallVector = Math.abs(sourceCenter[2]) > 0.86 ? [0, 1, 0] : [0, 0, 1];
    const sourceTangent = normalizeBallVector(crossBallVectors(reference, sourceCenter));
    const sourceBitangent = normalizeBallVector(crossBallVectors(sourceCenter, sourceTangent));
    const center = orientFootballVector(sourceCenter, rollOrientation);
    const tangent = orientFootballVector(sourceTangent, rollOrientation);
    const bitangent = orientFootballVector(sourceBitangent, rollOrientation);
    return { center, tangent, bitangent };
  }).filter(({ center }) => center[2] > -0.1)
    .sort((a, b) => a.center[2] - b.center[2]);

  const panelPoint = (
    center: BallVector,
    tangent: BallVector,
    bitangent: BallVector,
    angle: number,
    angularRadius: number,
  ) => normalizeBallVector([
    center[0] * Math.cos(angularRadius)
      + (tangent[0] * Math.cos(angle) + bitangent[0] * Math.sin(angle)) * Math.sin(angularRadius),
    center[1] * Math.cos(angularRadius)
      + (tangent[1] * Math.cos(angle) + bitangent[1] * Math.sin(angle)) * Math.sin(angularRadius),
    center[2] * Math.cos(angularRadius)
      + (tangent[2] * Math.cos(angle) + bitangent[2] * Math.sin(angle)) * Math.sin(angularRadius),
  ]);

  // Short recessed seams imply the surrounding white hexagons without turning
  // the small in-game ball into a noisy icon.
  ctx.strokeStyle = "rgba(80, 90, 94, 0.62)";
  ctx.lineWidth = 0.52;
  ctx.lineCap = "round";
  for (const { center, tangent, bitangent } of panels) {
    if (center[2] < 0.05) continue;
    for (let corner = 0; corner < 5; corner += 1) {
      const angle = -Math.PI / 2 + (Math.PI * 2 * corner) / 5;
      const start = panelPoint(center, tangent, bitangent, angle, panelRadius * 1.04);
      const end = panelPoint(center, tangent, bitangent, angle, seamRadius);
      if (start[2] < 0 || end[2] < 0) continue;
      ctx.beginPath();
      ctx.moveTo(start[0] * radius, start[1] * radius);
      ctx.lineTo(end[0] * radius, end[1] * radius);
      ctx.stroke();
    }
  }

  for (const { center, tangent, bitangent } of panels) {
    if (center[2] < -0.02) continue;
    const vertices: BallVector[] = [];
    for (let corner = 0; corner < 5; corner += 1) {
      vertices.push(panelPoint(
        center,
        tangent,
        bitangent,
        -Math.PI / 2 + (Math.PI * 2 * corner) / 5,
        panelRadius,
      ));
    }

    ctx.beginPath();
    vertices.forEach((vertex, index) => {
      const x = vertex[0] * radius;
      const y = vertex[1] * radius;
      if (index === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.closePath();

    const panelLight = clamp(center[2], 0, 1);
    const panelFill = ctx.createLinearGradient(
      center[0] * radius - 2.5,
      center[1] * radius - 3,
      center[0] * radius + 2.5,
      center[1] * radius + 3,
    );
    panelFill.addColorStop(0, panelLight > 0.55 ? "#263139" : "#323c41");
    panelFill.addColorStop(0.48, panelLight > 0.55 ? "#0c1216" : "#192126");
    panelFill.addColorStop(1, "#03070a");
    ctx.fillStyle = panelFill;
    ctx.fill();
    ctx.strokeStyle = "rgba(21, 27, 30, 0.92)";
    ctx.lineWidth = 0.72;
    ctx.stroke();

    ctx.strokeStyle = "rgba(255, 255, 255, 0.12)";
    ctx.lineWidth = 0.34;
    ctx.beginPath();
    ctx.moveTo(vertices[4][0] * radius, vertices[4][1] * radius);
    ctx.lineTo(vertices[0][0] * radius, vertices[0][1] * radius);
    ctx.lineTo(vertices[1][0] * radius, vertices[1][1] * radius);
    ctx.stroke();
  }

  // An asymmetric printed mark gives the eye a stable point to track while the
  // otherwise repeating black-and-white panel pattern rolls.
  const logoAnchor = orientFootballVector(
    normalizeBallVector([0.42, -0.28, 0.86]),
    rollOrientation,
  );
  if (logoAnchor[2] > 0.08) {
    ctx.globalAlpha = clamp((logoAnchor[2] - 0.08) / 0.72, 0, 0.82);
    ctx.fillStyle = "#287fc4";
    ctx.beginPath();
    ctx.ellipse(
      logoAnchor[0] * radius,
      logoAnchor[1] * radius,
      1.25,
      Math.max(0.45, logoAnchor[2] * 0.9),
      Math.atan2(logoAnchor[1], logoAnchor[0]),
      0,
      Math.PI * 2,
    );
    ctx.fill();
    ctx.globalAlpha = 1;
  }
  ctx.restore();

  const edgeShade = ctx.createRadialGradient(
    -radius * 0.32,
    -radius * 0.38,
    radius * 0.36,
    0,
    0,
    radius * 1.08,
  );
  edgeShade.addColorStop(0.48, "rgba(15, 25, 31, 0)");
  edgeShade.addColorStop(0.78, "rgba(15, 25, 31, 0.08)");
  edgeShade.addColorStop(0.93, "rgba(15, 25, 31, 0.25)");
  edgeShade.addColorStop(1, "rgba(7, 13, 17, 0.48)");
  ctx.fillStyle = edgeShade;
  ctx.beginPath();
  ctx.arc(0, 0, radius - 0.35, 0, Math.PI * 2);
  ctx.fill();

  const shine = ctx.createRadialGradient(
    -radius * 0.43,
    -radius * 0.5,
    0,
    -radius * 0.43,
    -radius * 0.5,
    radius * 0.48,
  );
  shine.addColorStop(0, "rgba(255, 255, 255, 0.92)");
  shine.addColorStop(0.28, "rgba(255, 255, 255, 0.43)");
  shine.addColorStop(1, "rgba(255,255,255,0)");
  ctx.fillStyle = shine;
  ctx.beginPath();
  ctx.arc(0, 0, radius - 0.55, 0, Math.PI * 2);
  ctx.fill();

  ctx.strokeStyle = "rgba(4, 10, 13, 0.9)";
  ctx.lineWidth = 1.15;
  ctx.beginPath();
  ctx.arc(0, 0, radius, 0, Math.PI * 2);
  ctx.stroke();

  ctx.strokeStyle = "rgba(255, 255, 255, 0.58)";
  ctx.lineWidth = 0.62;
  ctx.beginPath();
  ctx.arc(-0.35, -0.45, radius - 1.25, Math.PI * 1.08, Math.PI * 1.78);
  ctx.stroke();

  // A few tiny specular flecks give the synthetic leather a subtle grain.
  ctx.fillStyle = "rgba(255, 255, 255, 0.34)";
  for (const [x, y] of [[-5.2, -1.9], [-3.8, 3.1], [1.5, -5.6], [4.6, -1.2]]) {
    ctx.beginPath();
    ctx.arc(x * (radius / 12), y * (radius / 12), 0.28, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
}

function drawPlayer(
  ctx: CanvasRenderingContext2D,
  body: Body,
  activeTeam: Team,
  hideActiveRing: boolean,
  carrier: boolean,
  carrierFacing: { x: number; y: number } | null,
  keepUpright: boolean,
  animationTime: number,
  countryCode: string,
) {
  const meta = TEAM_META[body.team as Team];
  ctx.save();
  ctx.translate(body.x, body.y);
  if (keepUpright) ctx.rotate(Math.PI);

  ctx.shadowColor = "rgba(0, 0, 0, 0.42)";
  ctx.shadowBlur = 9;
  ctx.shadowOffsetY = 2;
  ctx.fillStyle = "rgba(8, 19, 14, 0.3)";
  ctx.beginPath();
  ctx.ellipse(
    0,
    PLAYER_PUCK_HEIGHT + 2.5,
    body.radius * 0.88,
    body.radius * 0.48,
    0,
    0,
    Math.PI * 2,
  );
  ctx.fill();
  ctx.shadowColor = "transparent";

  // Build a visible metallic side wall beneath the flag face. Drawing the lower
  // layers first leaves a shaded crescent below the top circle and makes the puck
  // read as physically raised without changing its collision radius.
  for (let layer = PLAYER_PUCK_HEIGHT; layer >= 1; layer -= 1) {
    const depth = layer / PLAYER_PUCK_HEIGHT;
    const red = Math.round(167 - depth * 76);
    const green = Math.round(181 - depth * 70);
    const blue = Math.round(186 - depth * 66);
    ctx.fillStyle = `rgb(${red}, ${green}, ${blue})`;
    ctx.beginPath();
    ctx.ellipse(0, layer, body.radius, body.radius - 1.2, 0, 0, Math.PI * 2);
    ctx.fill();
  }

  ctx.strokeStyle = "rgba(229, 240, 242, 0.34)";
  ctx.lineWidth = 0.75;
  ctx.beginPath();
  ctx.ellipse(
    0,
    PLAYER_PUCK_HEIGHT,
    body.radius - 0.5,
    body.radius - 1.7,
    0,
    0.08 * Math.PI,
    0.92 * Math.PI,
  );
  ctx.stroke();

  const rim = ctx.createRadialGradient(
    -body.radius * 0.42,
    -body.radius * 0.5,
    1,
    0,
    0,
    body.radius,
  );
  rim.addColorStop(0, "#f5fbfc");
  rim.addColorStop(0.32, "#d2dbde");
  rim.addColorStop(0.72, "#89979c");
  rim.addColorStop(1, "#5f6e73");
  ctx.fillStyle = rim;
  ctx.beginPath();
  ctx.arc(0, 0, body.radius, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = "rgba(233, 244, 246, 0.76)";
  ctx.lineWidth = 0.9;
  ctx.stroke();

  if (body.team === activeTeam && !hideActiveRing) {
    ctx.save();
    ctx.strokeStyle = meta.primary;
    ctx.shadowColor = meta.primary;
    ctx.shadowBlur = 7;
    ctx.lineWidth = 2.3;
    ctx.setLineDash([8, 7]);
    ctx.lineDashOffset = -(animationTime * 0.045);
    ctx.beginPath();
    ctx.arc(0, 0, body.radius + 7, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();
  }

  if (carrier) {
    ctx.strokeStyle = "#ffd75a";
    ctx.lineWidth = 2;
    ctx.setLineDash([3, 3]);
    ctx.lineDashOffset = animationTime * 0.035;
    ctx.beginPath();
    ctx.arc(0, 0, body.radius + 11, 0, Math.PI * 2);
    ctx.stroke();
    ctx.setLineDash([]);
  }

  ctx.save();
  ctx.beginPath();
  const faceRadius = body.radius - 1.55;
  ctx.arc(0, 0, faceRadius, 0, Math.PI * 2);
  ctx.clip();

  // Enlarge the selected flag beyond the circular clipping area so it becomes
  // the complete top surface instead of a small badge in the middle.
  ctx.fillStyle = "#f7faf8";
  ctx.fillRect(-body.radius, -body.radius, body.radius * 2, body.radius * 2);
  ctx.save();
  ctx.scale(1.08, 1.18);
  ctx.font = `${body.radius * 2.55}px 'Segoe UI Emoji', 'Apple Color Emoji', 'Noto Color Emoji', sans-serif`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(countryFlagEmoji(countryCode), 0, 0.4);
  ctx.restore();

  const faceLight = ctx.createRadialGradient(
    -body.radius * 0.42,
    -body.radius * 0.52,
    1,
    0,
    0,
    body.radius,
  );
  faceLight.addColorStop(0, "rgba(255,255,255,0.38)");
  faceLight.addColorStop(0.42, "rgba(255,255,255,0.04)");
  faceLight.addColorStop(0.78, "rgba(20,32,27,0.02)");
  faceLight.addColorStop(1, "rgba(20,32,27,0.2)");
  ctx.fillStyle = faceLight;
  ctx.fillRect(-body.radius, -body.radius, body.radius * 2, body.radius * 2);
  ctx.restore();

  ctx.strokeStyle = "rgba(246,252,250,0.72)";
  ctx.lineWidth = 0.9;
  ctx.beginPath();
  ctx.arc(0, 0, faceRadius, 0, Math.PI * 2);
  ctx.stroke();

  ctx.strokeStyle = "rgba(255,255,255,0.46)";
  ctx.lineWidth = 0.65;
  ctx.beginPath();
  ctx.arc(-0.35, -0.45, body.radius - 2.35, Math.PI * 1.08, Math.PI * 1.82);
  ctx.stroke();

  // Keep a very small possession-facing marker without covering the flag face.
  if (carrierFacing) {
    const viewDirection = keepUpright
      ? { x: -carrierFacing.x, y: -carrierFacing.y }
      : carrierFacing;
    ctx.fillStyle = "rgba(255,255,255,0.96)";
    ctx.shadowColor = meta.primary;
    ctx.shadowBlur = 4;
    ctx.beginPath();
    ctx.arc(
      viewDirection.x * (body.radius - 4),
      viewDirection.y * (body.radius - 4),
      1.8,
      0,
      Math.PI * 2,
    );
    ctx.fill();
    ctx.shadowColor = "transparent";
  }
  ctx.restore();
}

function drawAim(ctx: CanvasRenderingContext2D, drag: Drag, body: Body, possessionBall?: Body) {
  const power = drag.pull / MAX_PULL;
  const frontX = body.x + drag.dirX * (body.radius + 15);
  const frontY = body.y + drag.dirY * (body.radius + 15);
  const length = 42 + power * 62;
  const tipX = frontX + drag.dirX * length;
  const tipY = frontY + drag.dirY * length;
  const perpendicularX = -drag.dirY;
  const perpendicularY = drag.dirX;
  const shaftHalfWidth = 3.25;
  const headHalfWidth = 11;
  const headLength = 16;
  const shoulderX = tipX - drag.dirX * headLength;
  const shoulderY = tipY - drag.dirY * headLength;

  ctx.save();
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.fillStyle = "#ffffff";
  ctx.shadowColor = "rgba(4, 17, 11, 0.5)";
  ctx.shadowBlur = 5;
  ctx.shadowOffsetY = 2;
  ctx.beginPath();
  ctx.moveTo(frontX + perpendicularX * shaftHalfWidth, frontY + perpendicularY * shaftHalfWidth);
  ctx.lineTo(shoulderX + perpendicularX * shaftHalfWidth, shoulderY + perpendicularY * shaftHalfWidth);
  ctx.lineTo(shoulderX + perpendicularX * headHalfWidth, shoulderY + perpendicularY * headHalfWidth);
  ctx.lineTo(tipX, tipY);
  ctx.lineTo(shoulderX - perpendicularX * headHalfWidth, shoulderY - perpendicularY * headHalfWidth);
  ctx.lineTo(shoulderX - perpendicularX * shaftHalfWidth, shoulderY - perpendicularY * shaftHalfWidth);
  ctx.lineTo(frontX - perpendicularX * shaftHalfWidth, frontY - perpendicularY * shaftHalfWidth);
  ctx.closePath();
  ctx.fill();
  ctx.shadowColor = "transparent";

  ctx.strokeStyle = "rgba(255,255,255,0.3)";
  ctx.lineWidth = 2;
  ctx.setLineDash([5, 7]);
  ctx.beginPath();
  ctx.moveTo(body.x - drag.dirX * body.radius, body.y - drag.dirY * body.radius);
  ctx.lineTo(drag.pointerX, drag.pointerY);
  ctx.stroke();

  if (possessionBall && drag.pull >= 8) {
    const impact = calculatePossessionImpact(
      body,
      possessionBall,
      { x: drag.dirX, y: drag.dirY },
      power * MAX_SPEED,
      BALL_COLLISION_RESTITUTION,
    );
    if (impact) {
      const impactSpeed = Math.max(1, Math.hypot(impact.ballVx, impact.ballVy));
      const trajectoryLength = 34 + power * 48;
      const endX = possessionBall.x + (impact.ballVx / impactSpeed) * trajectoryLength;
      const endY = possessionBall.y + (impact.ballVy / impactSpeed) * trajectoryLength;
      ctx.setLineDash([4, 5]);
      ctx.strokeStyle = "rgba(89, 232, 255, 0.92)";
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.moveTo(possessionBall.x, possessionBall.y);
      ctx.lineTo(endX, endY);
      ctx.stroke();
    } else {
      ctx.setLineDash([]);
      ctx.fillStyle = "rgba(255, 116, 123, 0.92)";
      ctx.font = "800 9px Arial";
      ctx.textAlign = "center";
      ctx.fillText("MISS", possessionBall.x, possessionBall.y - possessionBall.radius - 8);
    }
  }
  ctx.restore();
}

function drawGame(
  ctx: CanvasRenderingContext2D,
  game: Game,
  viewTeam: Team,
  animationTime: number,
  turf: TurfParticle[],
  remoteAim: Drag | null,
  teamSetups: TeamSetups,
) {
  const flipped = viewTeam === "coral";
  ctx.save();
  if (flipped) {
    ctx.translate(WIDTH, HEIGHT);
    ctx.rotate(Math.PI);
  }
  drawPitch(ctx);
  drawTurfTrail(ctx, turf);
  const ball = game.bodies.find((body) => body.kind === "ball");
  const visibleAim = game.drag ?? remoteAim;
  for (const body of game.bodies) {
    if (body.kind === "player") {
      drawPlayer(
        ctx,
        body,
        game.activeTeam,
        visibleAim !== null,
        game.carrierId === body.id,
        game.carrierId === body.id ? game.carrierOffset : null,
        flipped,
        animationTime,
        teamSetups[body.team as Team].countryCode,
      );
    }
  }
  if (ball) drawBall(ctx, ball);

  if (visibleAim) {
    const body = game.bodies.find((item) => item.id === visibleAim.bodyId);
    if (body) {
      drawAim(
        ctx,
        visibleAim,
        body,
        game.carrierId === body.id ? ball : undefined,
      );
    }
  }
  ctx.restore();
}

function resetPositions(game: Game, kickoffTeam: Team, teamSetups: TeamSetups) {
  game.bodies = makeBodies(teamSetups, kickoffTeam);
  game.activeTeam = kickoffTeam;
  game.phase = "ready";
  game.passChain = 0;
  game.turnTime = TURN_TIME;
  game.turnTick = 0;
  game.drag = null;
  game.lastShooterId = null;
  game.carrierId = null;
  game.carrierOffset = null;
  game.carrierTargetOffset = null;
  game.carrierAlignDelay = 0;
  game.caughtThisMove = false;
  game.goalResetAt = null;
  game.message = kickoffTeam === "mint" ? "NEON FC KICKOFF" : "EMBER KICKOFF";
}

function switchTurn(game: Game, reason = "TURN CHANGED") {
  game.activeTeam = game.activeTeam === "mint" ? "coral" : "mint";
  game.phase = "ready";
  game.passChain = 0;
  game.turnTime = TURN_TIME;
  game.turnTick = 0;
  game.drag = null;
  game.lastShooterId = null;
  game.carrierId = null;
  game.carrierOffset = null;
  game.carrierTargetOffset = null;
  game.carrierAlignDelay = 0;
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
    bodies: game.bodies.map((body) => ({
      ...body,
      rollOrientation: body.rollOrientation
        ? [...body.rollOrientation] as BallOrientation
        : undefined,
    })),
    score: { ...game.score },
    carrierOffset: game.carrierOffset ? { ...game.carrierOffset } : null,
    carrierTargetOffset: game.carrierTargetOffset ? { ...game.carrierTargetOffset } : null,
    drag: null,
    goalResetAt: null,
  };
}

function applySnapshot(game: Game, snapshot: GameSnapshot) {
  game.bodies = snapshot.bodies.map((body) => ({
    ...body,
    rollOrientation: body.rollOrientation
      ? [...body.rollOrientation] as BallOrientation
      : undefined,
  }));
  game.activeTeam = snapshot.activeTeam;
  game.phase = snapshot.phase;
  game.score = { ...snapshot.score };
  game.passChain = snapshot.passChain;
  game.turnTime = snapshot.turnTime;
  game.turnTick = snapshot.turnTick;
  game.drag = null;
  game.lastShooterId = snapshot.lastShooterId;
  game.carrierId = snapshot.carrierId;
  game.carrierOffset = snapshot.carrierOffset ? { ...snapshot.carrierOffset } : null;
  game.carrierTargetOffset = snapshot.carrierTargetOffset ? { ...snapshot.carrierTargetOffset } : null;
  game.carrierAlignDelay = snapshot.carrierAlignDelay;
  game.caughtThisMove = snapshot.caughtThisMove;
  game.goalResetAt = snapshot.phase === "goal" ? performance.now() + 1350 : null;
  game.message = snapshot.message;
  game.winner = snapshot.winner;
}

function normalizeRoomCode(value: string) {
  return value.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 6);
}

export default function FlickFootball({
  initialRoomCode = "",
  authEnabled = false,
}: {
  initialRoomCode?: string;
  authEnabled?: boolean;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const chatListRef = useRef<HTMLDivElement>(null);
  const chatComposerRef = useRef<HTMLDivElement>(null);
  const chatOpenRef = useRef(false);
  const socketRef = useRef<RealtimeClient | null>(null);
  const soundRef = useRef<SoundEngine | null>(null);
  const kickoffTeamRef = useRef<Team>("mint");
  const connectionReadyRef = useRef(true);
  const opponentConnectedRef = useRef(true);
  const onlineStageRef = useRef<OnlineStage>("menu");
  const matchRef = useRef<MatchInfo | null>(null);
  const latestSyncRef = useRef<CachedSync | null>(null);
  const latestShotRef = useRef<CachedShot | null>(null);
  const matchSetupReadyRef = useRef(true);
  const teamSetupsRef = useRef<TeamSetups>({
    mint: { ...DEFAULT_TEAM_SETUPS.mint },
    coral: { ...DEFAULT_TEAM_SETUPS.coral },
  });
  const [session, setSession] = useState(0);
  const [showRules, setShowRules] = useState(false);
  const [hud, setHud] = useState<Hud>(() => toHud(makeGame()));
  const initialCode = normalizeRoomCode(initialRoomCode);
  const [onlineStage, setOnlineStage] = useState<OnlineStage>(initialCode ? "join-room" : "menu");
  const [match, setMatch] = useState<MatchInfo | null>(null);
  const [playerName, setPlayerName] = useState("Ashwani");
  const [searchSeconds, setSearchSeconds] = useState(0);
  const [networkMessage, setNetworkMessage] = useState("");
  const [roomCode, setRoomCode] = useState(initialCode);
  const [roomPending, setRoomPending] = useState(false);
  const [roomCopied, setRoomCopied] = useState(false);
  const [reconnecting, setReconnecting] = useState(false);
  const [opponentReconnecting, setOpponentReconnecting] = useState(false);
  const [onlinePlayers, setOnlinePlayers] = useState<number | null>(null);
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([]);
  const [incomingChatPopup, setIncomingChatPopup] = useState<ChatMessage | null>(null);
  const [chatInput, setChatInput] = useState("");
  const [chatOpen, setChatOpen] = useState(false);
  const [unreadChat, setUnreadChat] = useState(0);
  const [reactionPickerOpen, setReactionPickerOpen] = useState(false);
  const [reactions, setReactions] = useState<GameReaction[]>([]);
  const [setupStage, setSetupStage] = useState<SetupStage>("ready");
  const [selectedCountry, setSelectedCountry] = useState(DEFAULT_PLAYER_SETUP.countryCode);
  const [selectedAttackingFormation, setSelectedAttackingFormation] =
    useState<AttackingFormationId>(DEFAULT_PLAYER_SETUP.attackingFormation);
  const [selectedDefensiveFormation, setSelectedDefensiveFormation] =
    useState<DefensiveFormationId>(DEFAULT_PLAYER_SETUP.defensiveFormation);
  const [countryQuery, setCountryQuery] = useState("");
  const [teamSetups, setTeamSetups] = useState<TeamSetups>({
    mint: { ...DEFAULT_TEAM_SETUPS.mint },
    coral: { ...DEFAULT_TEAM_SETUPS.coral },
  });
  const visibleCountries = useMemo(() => {
    const query = countryQuery.trim().toLowerCase();
    return [...COUNTRY_CODES]
      .sort((first, second) => countryName(first).localeCompare(countryName(second)))
      .filter((code) => !query || countryName(code).toLowerCase().includes(query) || code.toLowerCase().includes(query));
  }, [countryQuery]);

  useEffect(() => {
    onlineStageRef.current = onlineStage;
  }, [onlineStage]);

  useEffect(() => {
    chatOpenRef.current = chatOpen;
  }, [chatOpen]);

  useEffect(() => {
    if (!chatOpen) return;
    chatListRef.current?.scrollTo({
      top: chatListRef.current.scrollHeight,
      behavior: "smooth",
    });
  }, [chatMessages, chatOpen]);

  useEffect(() => {
    if (!incomingChatPopup) return;
    const popupId = incomingChatPopup.id;
    const timer = window.setTimeout(() => {
      setIncomingChatPopup((current) => current?.id === popupId ? null : current);
    }, 1_000);
    return () => window.clearTimeout(timer);
  }, [incomingChatPopup]);

  useEffect(() => {
    if (!chatOpen) return;

    const closeChatOnOutsidePress = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      const clickedMessage = target instanceof Element
        && Boolean(target.closest(`.${styles.chatMessage}`));
      if (clickedMessage || chatComposerRef.current?.contains(target)) return;

      event.preventDefault();
      event.stopPropagation();
      chatOpenRef.current = false;
      setChatOpen(false);
      if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
    };
    const closeChatOnEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      chatOpenRef.current = false;
      setChatOpen(false);
      if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
    };

    document.addEventListener("pointerdown", closeChatOnOutsidePress, true);
    window.addEventListener("keydown", closeChatOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeChatOnOutsidePress, true);
      window.removeEventListener("keydown", closeChatOnEscape);
    };
  }, [chatOpen]);

  useEffect(() => {
    if (reactions.length === 0) return;
    const nextExpiry = Math.min(...reactions.map((reaction) => reaction.expiresAt));
    const timer = window.setTimeout(() => {
      const now = Date.now();
      setReactions((current) => current.filter((reaction) => reaction.expiresAt > now));
    }, Math.max(0, nextExpiry - Date.now()));
    return () => window.clearTimeout(timer);
  }, [reactions]);

  useEffect(() => {
    if (!showRules) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setShowRules(false);
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [showRules]);

  useEffect(() => {
    matchRef.current = match;
  }, [match]);

  const installTeamSetups = (next: TeamSetups) => {
    teamSetupsRef.current = next;
    setTeamSetups(next);
  };

  const installMatchSetup = (data: MatchInfo) => {
    const next: TeamSetups = {
      mint: { ...DEFAULT_TEAM_SETUPS.mint },
      coral: { ...DEFAULT_TEAM_SETUPS.coral },
    };
    for (const participant of [data.player, data.opponent]) {
      if (
        participant.countryCode &&
        participant.attackingFormation &&
        participant.defensiveFormation
      ) {
        next[participant.team] = {
          countryCode: participant.countryCode,
          attackingFormation: participant.attackingFormation,
          defensiveFormation: participant.defensiveFormation,
        };
      }
    }
    installTeamSetups(next);
    const localSetup = data.player.countryCode &&
      data.player.attackingFormation &&
      data.player.defensiveFormation
      ? {
          countryCode: data.player.countryCode,
          attackingFormation: data.player.attackingFormation,
          defensiveFormation: data.player.defensiveFormation,
        }
      : null;
    if (localSetup) {
      setSelectedCountry(localSetup.countryCode);
      setSelectedAttackingFormation(localSetup.attackingFormation);
      setSelectedDefensiveFormation(localSetup.defensiveFormation);
    }
    matchSetupReadyRef.current = data.setupReady === true;
    setSetupStage(data.setupReady === true ? "ready" : localSetup ? "waiting" : "country");
  };

  useEffect(() => {
    if (onlineStage !== "searching") return;
    const timer = window.setInterval(() => setSearchSeconds((value) => value + 1), 1000);
    return () => window.clearInterval(timer);
  }, [onlineStage]);

  useEffect(() => {
    if (onlineStage !== "menu") return;
    let active = true;
    let request: AbortController | null = null;

    const refreshOnlinePlayers = async () => {
      request?.abort();
      const controller = new AbortController();
      request = controller;
      try {
        const response = await fetch("/api/presence", {
          cache: "no-store",
          signal: controller.signal,
        });
        if (!response.ok) return;
        const data = await response.json() as { players?: unknown };
        if (!active || typeof data.players !== "number" || !Number.isFinite(data.players)) return;
        setOnlinePlayers(Math.max(0, Math.floor(data.players)));
      } catch (error) {
        if (error instanceof DOMException && error.name === "AbortError") return;
        // Presence is optional; matchmaking remains available if this request fails.
      }
    };

    const refreshWhenVisible = () => {
      if (document.visibilityState === "visible") void refreshOnlinePlayers();
    };

    void refreshOnlinePlayers();
    const timer = window.setInterval(() => void refreshOnlinePlayers(), 8_000);
    document.addEventListener("visibilitychange", refreshWhenVisible);
    return () => {
      active = false;
      request?.abort();
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", refreshWhenVisible);
    };
  }, [onlineStage]);

  useEffect(() => {
    const sound = createSoundEngine();
    soundRef.current = sound;
    return () => {
      socketRef.current?.disconnect();
      sound.dispose();
      soundRef.current = null;
    };
  }, []);

  const closeSocket = () => {
    socketRef.current?.removeAllListeners();
    socketRef.current?.disconnect();
    socketRef.current = null;
    connectionReadyRef.current = true;
    opponentConnectedRef.current = true;
    setReconnecting(false);
    setOpponentReconnecting(false);
  };

  const connectRealtime = async (
    onConnect: (socket: RealtimeClient) => void,
    errorStage: Extract<OnlineStage, "menu" | "join-room" | "disconnected">,
    resumePrevious = false,
  ) => {
    closeSocket();
    try {
      const socket = new RealtimeClient();
      socketRef.current = socket;

      socket.on("connect", () => onConnect(socket));
      socket.on("connect_error", () => {
        setReconnecting(false);
        setRoomPending(false);
        setNetworkMessage("Could not reach the game server. Try again.");
        setOnlineStage(errorStage);
      });
      socket.on("disconnect", () => {
        connectionReadyRef.current = false;
        setReconnecting(true);
        setRoomPending(false);
        setNetworkMessage("Reconnecting to your match...");
      });
      socket.on("reconnect", () => {
        setNetworkMessage("Restoring your match...");
      });
      socket.on("session:resumed", () => {
        connectionReadyRef.current = true;
        setReconnecting(false);
        setNetworkMessage("");
      });
      socket.on("session:expired", ({ message }: { message?: string }) => {
        connectionReadyRef.current = false;
        matchRef.current = null;
        setReconnecting(false);
        setMatch(null);
        setNetworkMessage(message || "The previous match is no longer available.");
        setOnlineStage("disconnected");
      });
      socket.on("session:replaced", () => {
        socket.disconnect();
        connectionReadyRef.current = false;
        matchRef.current = null;
        setReconnecting(false);
        setMatch(null);
        setNetworkMessage("This match was resumed in another window.");
        setOnlineStage("disconnected");
      });
      socket.on("server:error", ({ message }: { message: string }) => {
        setRoomPending(false);
        setNetworkMessage(message);
        setOnlineStage("disconnected");
      });
      socket.on("game:shot", (shot: SequencedShot) => {
        const activeMatch = matchRef.current;
        if (activeMatch) latestShotRef.current = { matchId: activeMatch.matchId, shot };
      });
      socket.on("game:sync", ({ snapshot, sequence }: { snapshot: GameSnapshot; sequence: number }) => {
        const activeMatch = matchRef.current;
        if (!activeMatch) return;
        latestSyncRef.current = { matchId: activeMatch.matchId, snapshot, sequence };
        if (latestShotRef.current?.matchId === activeMatch.matchId &&
          latestShotRef.current.shot.sequence <= sequence) {
          latestShotRef.current = null;
        }
      });
      socket.on("chat:message", (message: ChatMessage) => {
        const activeMatch = matchRef.current;
        if (!activeMatch || message.matchId !== activeMatch.matchId || !message.id || !message.text) return;
        setChatMessages((current) => (
          current.some((item) => item.id === message.id)
            ? current
            : [...current.slice(-39), message]
        ));
        if (message.senderTeam !== activeMatch.myTeam && !chatOpenRef.current) {
          setUnreadChat((current) => Math.min(9, current + 1));
          setIncomingChatPopup(message);
        }
      });
      socket.on("chat:history", ({
        matchId,
        messages,
      }: {
        matchId: string;
        messages: ChatMessage[];
      }) => {
        if (matchRef.current?.matchId !== matchId || !Array.isArray(messages)) return;
        setChatMessages(messages.slice(-40));
      });
      socket.on("reaction:show", (reaction: Omit<GameReaction, "expiresAt">) => {
        const activeMatch = matchRef.current;
        if (!activeMatch || reaction.matchId !== activeMatch.matchId || !reaction.id || !reaction.emoji) return;
        setReactions((current) => [
          ...current.filter((item) => item.senderTeam !== reaction.senderTeam),
          { ...reaction, expiresAt: Date.now() + 2_200 },
        ]);
      });
      socket.on("room:created", ({ code }: { code: string }) => {
        connectionReadyRef.current = true;
        setReconnecting(false);
        setRoomCode(code);
        setRoomPending(false);
        setNetworkMessage("");
        setOnlineStage("waiting-room");
      });
      socket.on("room:error", ({ action, message }: { action: string; message: string }) => {
        setRoomPending(false);
        setNetworkMessage(message);
        setOnlineStage(action === "join" ? "join-room" : "menu");
      });
      socket.on("room:closed", () => {
        setRoomPending(false);
        setNetworkMessage("This private room was closed.");
        setOnlineStage("disconnected");
      });
      socket.on("match:setup", (data: MatchSetupPayload) => {
        const activeMatch = matchRef.current;
        if (!activeMatch || data.matchId !== activeMatch.matchId) return;
        const next: TeamSetups = {
          mint: data.players.mint ?? teamSetupsRef.current.mint,
          coral: data.players.coral ?? teamSetupsRef.current.coral,
        };
        installTeamSetups(next);
        setMatch((current) => {
          if (!current || current.matchId !== data.matchId) return current;
          const localSetup = data.players[current.myTeam];
          const opponentTeam: Team = current.myTeam === "mint" ? "coral" : "mint";
          const opponentSetup = data.players[opponentTeam];
          return {
            ...current,
            setupReady: data.ready,
            player: { ...current.player, ...localSetup },
            opponent: { ...current.opponent, ...opponentSetup },
          };
        });
        const wasReady = matchSetupReadyRef.current;
        matchSetupReadyRef.current = data.ready;
        setSetupStage(data.ready ? "ready" : data.players[activeMatch.myTeam] ? "waiting" : "country");
        if (data.ready && !wasReady) setSession((value) => value + 1);
      });
      socket.on("match:found", (data: MatchInfo) => {
        connectionReadyRef.current = true;
        kickoffTeamRef.current = "mint";
        matchRef.current = data;
        latestSyncRef.current = null;
        latestShotRef.current = null;
        setMatch(data);
        setRoomPending(false);
        if (data.roomCode) setRoomCode(data.roomCode);
        setNetworkMessage("");
        setReconnecting(false);
        setOpponentReconnecting(false);
        setChatMessages([]);
        setIncomingChatPopup(null);
        setChatInput("");
        setChatOpen(false);
        setUnreadChat(0);
        setReactionPickerOpen(false);
        setReactions([]);
        opponentConnectedRef.current = true;
        installMatchSetup(data);
        setOnlineStage("matched");
        if (data.setupReady) setSession((value) => value + 1);
      });
      socket.on("match:resumed", (data: MatchInfo) => {
        const needsCanvasRestore = onlineStageRef.current !== "matched";
        connectionReadyRef.current = true;
        opponentConnectedRef.current = true;
        matchRef.current = data;
        onlineStageRef.current = "matched";
        setMatch((current) => current?.matchId === data.matchId ? current : data);
        setReconnecting(false);
        setOpponentReconnecting(false);
        setNetworkMessage("");
        installMatchSetup(data);
        setOnlineStage("matched");
        if (needsCanvasRestore && data.setupReady) setSession((value) => value + 1);
      });
      socket.on("match:opponent-reconnecting", () => {
        opponentConnectedRef.current = false;
        setOpponentReconnecting(true);
      });
      socket.on("match:opponent-returned", () => {
        opponentConnectedRef.current = true;
        setOpponentReconnecting(false);
      });
      socket.on("match:opponent-left", () => {
        opponentConnectedRef.current = false;
        matchRef.current = null;
        setOpponentReconnecting(false);
        setMatch(null);
        setNetworkMessage("Your opponent left the match.");
        setOnlineStage("disconnected");
      });
      socket.on("match:reset", ({ activeTeam }: { activeTeam: Team }) => {
        connectionReadyRef.current = true;
        kickoffTeamRef.current = activeTeam;
        latestSyncRef.current = null;
        latestShotRef.current = null;
        setNetworkMessage("");
        setSession((value) => value + 1);
      });
      socket.connect(resumePrevious);
    } catch {
      setReconnecting(false);
      setRoomPending(false);
      setNetworkMessage("Could not start the realtime connection. Try again.");
      setOnlineStage(errorStage);
    }
  };

  const startMatchmaking = async () => {
    soundRef.current?.unlock();
    setMatch(null);
    setRoomCode("");
    setNetworkMessage("");
    setSearchSeconds(0);
    setOnlineStage("searching");
    await connectRealtime(
      (socket) => socket.emit("match:find", {
        clientId: socket.clientId,
        name: playerName.trim() || "Player",
      }),
      "menu",
    );
  };

  const createPrivateRoom = async () => {
    soundRef.current?.unlock();
    setMatch(null);
    setRoomCode("");
    setRoomCopied(false);
    setRoomPending(true);
    setNetworkMessage("");
    setOnlineStage("waiting-room");
    await connectRealtime(
      (socket) => socket.emit("room:create", {
        clientId: socket.clientId,
        name: playerName.trim() || "Player",
      }),
      "menu",
    );
  };

  const joinPrivateRoom = async () => {
    const code = normalizeRoomCode(roomCode);
    if (code.length !== 6) {
      setNetworkMessage("Enter the complete 6-character room code.");
      return;
    }
    soundRef.current?.unlock();
    setMatch(null);
    setRoomCode(code);
    setRoomPending(true);
    setNetworkMessage("");
    await connectRealtime(
      (socket) => socket.emit("room:join", {
        clientId: socket.clientId,
        code,
        name: playerName.trim() || "Player",
      }),
      "join-room",
    );
  };

  const reconnectMatch = async () => {
    if (!matchRef.current) return;
    connectionReadyRef.current = false;
    setReconnecting(true);
    setNetworkMessage("Reconnecting to your saved match...");
    await connectRealtime(() => undefined, "disconnected", true);
    connectionReadyRef.current = false;
    setReconnecting(true);
  };

  const sharePrivateRoom = async () => {
    if (!roomCode) return;
    const url = `${window.location.origin}${window.location.pathname}?room=${roomCode}`;
    const shareData = {
      title: "Join my FlickXI match",
      text: `Join my FlickXI room with code ${roomCode}.`,
      url,
    };
    try {
      if (navigator.share) {
        await navigator.share(shareData);
      } else {
        await navigator.clipboard.writeText(`${shareData.text} ${url}`);
      }
      setRoomCopied(true);
      window.setTimeout(() => setRoomCopied(false), 1800);
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") return;
      setNetworkMessage("Could not share automatically. Copy the room code instead.");
    }
  };

  const sendChatMessage = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const text = chatInput.replace(/\s+/g, " ").trim().slice(0, 160);
    if (!text || onlineStage !== "matched" || !match || match.opponent.isBot) return;
    socketRef.current?.emit("chat:send", { text });
    setChatInput("");
    chatOpenRef.current = false;
    setChatOpen(false);
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
  };

  const sendReaction = (emoji: string) => {
    if (onlineStage !== "matched" || !match || match.opponent.isBot) return;
    socketRef.current?.emit("reaction:send", { emoji });
    setReactionPickerOpen(false);
  };

  const openChat = () => {
    chatOpenRef.current = true;
    setChatOpen(true);
    setIncomingChatPopup(null);
    setReactionPickerOpen(false);
    setUnreadChat(0);
  };

  const resetMatchSocial = () => {
    chatOpenRef.current = false;
    setChatMessages([]);
    setIncomingChatPopup(null);
    setChatInput("");
    setChatOpen(false);
    setUnreadChat(0);
    setReactionPickerOpen(false);
    setReactions([]);
  };

  const cancelSearch = () => {
    socketRef.current?.emit("match:cancel");
    closeSocket();
    setOnlineStage("menu");
  };

  const cancelPrivateRoom = () => {
    socketRef.current?.emit("room:cancel");
    closeSocket();
    setRoomCode("");
    setRoomPending(false);
    setNetworkMessage("");
    setOnlineStage("menu");
  };

  const confirmFormation = () => {
    const localSetup: PlayerSetup = {
      countryCode: selectedCountry,
      attackingFormation: selectedAttackingFormation,
      defensiveFormation: selectedDefensiveFormation,
    };
    const localSetupTeam: Team = match?.myTeam ?? "mint";
    installTeamSetups({
      ...teamSetupsRef.current,
      [localSetupTeam]: localSetup,
    });
    if (onlineStage === "matched") {
      matchSetupReadyRef.current = false;
      setSetupStage("waiting");
      socketRef.current?.emit("match:configure", localSetup);
      return;
    }
    matchSetupReadyRef.current = true;
    setSetupStage("ready");
    setSession((value) => value + 1);
  };

  const leaveMatch = () => {
    socketRef.current?.emit("match:leave");
    closeSocket();
    kickoffTeamRef.current = "mint";
    setMatch(null);
    setRoomCode("");
    setRoomPending(false);
    setNetworkMessage("");
    resetMatchSocial();
    matchSetupReadyRef.current = true;
    setSetupStage("ready");
    setOnlineStage("menu");
    setSession((value) => value + 1);
  };

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const sounds = soundRef.current;

    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = WIDTH * dpr;
    canvas.height = HEIGHT * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    const game = makeGame(teamSetupsRef.current, kickoffTeamRef.current);
    const viewTeam: Team = onlineStage === "matched" && match ? match.myTeam : "mint";
    game.message = onlineStage === "matched"
      ? `${TEAM_META[game.activeTeam].name} STARTS`
      : "PULL BACK A DISC TO SHOOT";
    let frameId = 0;
    let previousTime = performance.now();
    let physicsAccumulator = 0;
    let lastHudKey = "";
    let shotPending = false;
    let lastSequence = -1;
    let lastAimBroadcast = 0;
    let remoteAim: Drag | null = null;
    const confetti: ConfettiPiece[] = [];
    const turf: TurfParticle[] = [];
    const cachedSync = match && latestSyncRef.current?.matchId === match.matchId
      ? latestSyncRef.current
      : null;
    if (cachedSync) {
      applySnapshot(game, cachedSync.snapshot);
      lastSequence = cachedSync.sequence;
    }

    const celebrate = (matchWon: boolean) => {
      addConfetti(confetti, matchWon ? 260 : 90);
      sounds?.goal();
      if (matchWon) sounds?.win();
    };

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

    const canPublishTurn = (authorityTeam: Team) =>
      match?.myTeam === authorityTeam || match?.opponent.isBot === true;

    const broadcastAim = (drag: Drag, force = false) => {
      if (onlineStage !== "matched" || !match) return;
      const now = performance.now();
      if (!force && now - lastAimBroadcast < AIM_BROADCAST_MS) return;
      lastAimBroadcast = now;
      socketRef.current?.emit("game:aim", {
        bodyId: drag.bodyId,
        dirX: drag.dirX,
        dirY: drag.dirY,
        pull: drag.pull,
      });
    };

    const clearBroadcastAim = () => {
      if (onlineStage === "matched") socketRef.current?.emit("game:aim-clear");
    };

    const applyShot = (shot: Shot) => {
      if (game.phase !== "ready") return;
      const body = game.bodies.find((item) => item.id === shot.bodyId);
      if (!body || body.kind !== "player" || body.team !== game.activeTeam) return;
      const launchSpeed = (shot.pull / MAX_PULL) * MAX_SPEED;
      const ball = game.bodies.find((item) => item.kind === "ball");
      const isPossessionKick = game.carrierId === body.id && ball;

      if (isPossessionKick) {
        game.carrierId = null;
        game.carrierOffset = null;
        game.carrierTargetOffset = null;
        game.carrierAlignDelay = 0;
      }
      body.vx = shot.dirX * launchSpeed;
      body.vy = shot.dirY * launchSpeed;
      physicsAccumulator = 0;
      previousTime = performance.now();
      game.lastShooterId = body.id;

      shotPending = false;
      game.caughtThisMove = false;
      game.phase = "moving";
      game.message = "BALL IN MOTION";
      sounds?.flick(shot.pull / MAX_PULL);
      syncHud();
    };

    const cachedShot = match && latestShotRef.current?.matchId === match.matchId
      ? latestShotRef.current.shot
      : null;
    if (cachedShot && cachedShot.sequence > lastSequence) {
      lastSequence = cachedShot.sequence;
      applyShot(cachedShot);
    }

    const pointFromEvent = (event: PointerEvent) => {
      const rect = canvas.getBoundingClientRect();
      const screenX = ((event.clientX - rect.left) / rect.width) * WIDTH;
      const screenY = ((event.clientY - rect.top) / rect.height) * HEIGHT;
      return viewTeam === "coral"
        ? { x: WIDTH - screenX, y: HEIGHT - screenY }
        : { x: screenX, y: screenY };
    };

    const onPointerDown = (event: PointerEvent) => {
      sounds?.unlock();
      if (!matchSetupReadyRef.current) return;
      if (game.phase !== "ready" || shotPending) return;
      if (onlineStage !== "practice" && onlineStage !== "matched") return;
      if (onlineStage === "matched" && !connectionReadyRef.current) {
        game.message = "RECONNECTING TO MATCH";
        syncHud();
        return;
      }
      if (onlineStage === "matched" && !opponentConnectedRef.current) {
        game.message = "WAITING FOR OPPONENT";
        syncHud();
        return;
      }
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
      canvas.setPointerCapture(event.pointerId);
      const defaultDirectionY = selectable.team === "mint" ? -1 : 1;
      game.drag = {
        bodyId: selectable.id,
        pointerX: point.x,
        pointerY: point.y,
        pull: 0,
        dirX: 0,
        dirY: defaultDirectionY,
      };
      broadcastAim(game.drag, true);
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
      broadcastAim(game.drag);
    };

    const onPointerUp = (event: PointerEvent) => {
      if (!game.drag) return;
      const drag = game.drag;
      game.drag = null;
      clearBroadcastAim();
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
    const onRemoteAim = (aim: Shot) => {
      if (game.phase !== "ready") return;
      const body = game.bodies.find((item) => item.id === aim.bodyId);
      if (!body || body.kind !== "player" || body.team !== game.activeTeam) return;
      remoteAim = {
        ...aim,
        pointerX: body.x - aim.dirX * aim.pull,
        pointerY: body.y - aim.dirY * aim.pull,
      };
    };
    const onRemoteAimClear = () => {
      remoteAim = null;
    };
    const onRemoteShot = (shot: Shot & { sequence: number }) => {
      if (shot.sequence <= lastSequence) return;
      lastSequence = shot.sequence;
      remoteAim = null;
      applyShot(shot);
    };
    const onRemoteSync = ({ snapshot, sequence }: { snapshot: GameSnapshot; sequence: number }) => {
      if (sequence < lastSequence) return;
      lastSequence = sequence;
      physicsAccumulator = 0;
      previousTime = performance.now();
      shotPending = false;
      remoteAim = null;
      const previousPhase = game.phase;
      applySnapshot(game, snapshot);
      if (previousPhase !== snapshot.phase && (snapshot.phase === "goal" || snapshot.phase === "finished")) {
        celebrate(snapshot.phase === "finished");
      }
      syncHud();
    };
    const onGameError = ({ message }: { message: string }) => {
      shotPending = false;
      game.message = message.toUpperCase();
      syncHud();
    };
    socket?.on("game:aim", onRemoteAim);
    socket?.on("game:aim-clear", onRemoteAimClear);
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
      celebrate(game.phase === "finished");
      if (onlineStage === "matched" && canPublishTurn(authorityTeam)) publishState();
    };

    const updatePhysics = (dt: number, now: number) => {
      if (game.phase === "goal" && game.goalResetAt && now >= game.goalResetAt) {
        const authorityTeam = game.activeTeam;
        const kickoff = game.message.startsWith(TEAM_META.mint.name) ? "coral" : "mint";
        resetPositions(game, kickoff, teamSetupsRef.current);
        syncHud();
        sounds?.turn();
        if (onlineStage === "matched" && canPublishTurn(authorityTeam)) publishState();
        return;
      }
      if (game.phase !== "moving") return;

      const ball = game.bodies.find((body) => body.kind === "ball");
      if (!ball) return;
      const ballStartX = ball.x;
      const ballStartY = ball.y;

      for (const body of game.bodies) {
        const travelX = body.vx * dt;
        const travelY = body.vy * dt;
        body.x += travelX;
        body.y += travelY;
        const isPossessionBody = Boolean(
          game.carrierId && (body.kind === "ball" || body.id === game.carrierId),
        );
        const friction = isPossessionBody
          ? POSSESSION_FRICTION
          : body.kind === "ball" ? BALL_FRICTION : PLAYER_FRICTION;
        const damping = Math.exp(-friction * dt);
        body.vx *= damping;
        body.vy *= damping;
        if (speed(body) < 5) {
          body.vx = 0;
          body.vy = 0;
        }
      }

      for (const body of game.bodies) {
        if (body.kind === "ball" && game.carrierId) continue;
        const impactSpeed = speed(body);
        const collided = body.kind === "player"
          ? constrainPlayerToPitch(body)
          : constrainFreeBallToPitch(body);
        if (collided && impactSpeed > 20) sounds?.wall(impactSpeed / MAX_SPEED);
      }

      for (let solverPass = 0; solverPass < COLLISION_SOLVER_PASSES; solverPass += 1) {
        for (let i = 0; i < game.bodies.length; i += 1) {
          for (let j = i + 1; j < game.bodies.length; j += 1) {
          const a = game.bodies[i];
          const b = game.bodies[j];
          if (!a || !b) continue;
          if (a.kind === "player" && b.kind === "player") {
            const impactSpeed = Math.hypot(a.vx - b.vx, a.vy - b.vy);
            const collided = resolveCollision(a, b, 0.9);
            if (collided && game.carrierId && game.carrierOffset) {
              const carrier = a.id === game.carrierId ? a : b.id === game.carrierId ? b : null;
              if (carrier) lockBallToCarrier(carrier, ball, game.carrierOffset);
            }
            if (collided && solverPass === 0 && impactSpeed > 40) {
              sounds?.impact("disc", impactSpeed / MAX_SPEED);
            }
            continue;
          }

          const playerBody = a.kind === "player" ? a : b.kind === "player" ? b : null;
          const ballBody = a.kind === "ball" ? a : b.kind === "ball" ? b : null;
          if (!playerBody || !ballBody) continue;
          const touching = Math.hypot(playerBody.x - ballBody.x, playerBody.y - ballBody.y) <
            playerBody.radius + ballBody.radius;

          const isReceiver =
            playerBody.team === game.activeTeam &&
            playerBody.id !== game.lastShooterId &&
            !game.carrierId &&
            isWithinPassControl(playerBody, ballBody, PASS_GAP);

          if (isReceiver) {
            const dx = ballBody.x - playerBody.x;
            const dy = ballBody.y - playerBody.y;
            const length = Math.hypot(dx, dy);
            const contactDirection = length > 0.001
              ? { x: dx / length, y: dy / length }
              : { x: 0, y: playerBody.team === "mint" ? -1 : 1 };
            game.carrierId = playerBody.id;
            game.carrierOffset = contactDirection;
            game.carrierTargetOffset = directionToOpponentGoal(ballBody, playerBody.team as Team);
            game.carrierAlignDelay = PASS_ALIGN_DELAY;
            game.caughtThisMove = true;
            game.passChain += 1;
            game.message = "NICE PASS - BALL CONTROLLED";
            capturePossessionMomentum(playerBody, ballBody, PASS_MOMENTUM_TRANSFER);
            lockBallToCarrier(playerBody, ballBody, contactDirection);
            sounds?.pass();
            syncHud();
            continue;
          }

          if (game.carrierId) {
            const carrier = game.bodies.find((body) => body.id === game.carrierId);
            if (!carrier || playerBody.id === carrier.id || !touching) continue;
            const impactSpeed = Math.hypot(
              playerBody.vx - carrier.vx,
              playerBody.vy - carrier.vy,
            );
            const collided = resolvePossessedBallCollision(
              playerBody,
              carrier,
              ballBody,
              BALL_COLLISION_RESTITUTION,
              BALL_TO_PLAYER_TRANSFER,
            );
            if (collided && solverPass === 0 && impactSpeed > 35) {
              sounds?.impact("ball", impactSpeed / MAX_SPEED);
            }
            continue;
          }
          if (!touching) continue;

          const impactSpeed = Math.hypot(
            playerBody.vx - ballBody.vx,
            playerBody.vy - ballBody.vy,
          );
          if (
            resolveBallPlayerCollision(
              playerBody,
              ballBody,
              BALL_COLLISION_RESTITUTION,
              BALL_TO_PLAYER_TRANSFER,
            ) &&
            solverPass === 0 &&
            impactSpeed > 35
          ) {
            sounds?.impact("ball", impactSpeed / MAX_SPEED);
          }
          }
        }

        if (game.carrierId && game.carrierOffset) {
          const carrier = game.bodies.find((body) => body.id === game.carrierId);
          if (carrier) lockBallToCarrier(carrier, ball, game.carrierOffset);
        }
      }

      if (game.carrierId && game.carrierOffset) {
        const carrier = game.bodies.find((body) => body.id === game.carrierId);
        if (carrier) {
          const targetOffset = game.carrierTargetOffset
            ? directionToOpponentGoal(ball, carrier.team as Team)
            : null;
          if (targetOffset) {
            game.carrierTargetOffset = targetOffset;
            game.carrierAlignDelay = Math.max(0, game.carrierAlignDelay - dt);
            if (game.carrierAlignDelay === 0) {
              const nextOffset = rotateToward(
                game.carrierOffset,
                targetOffset,
                6 * dt,
              );
              const aligned = Math.hypot(
                nextOffset.x - targetOffset.x,
                nextOffset.y - targetOffset.y,
              ) <= 0.015;
              game.carrierOffset = aligned ? { ...targetOffset } : nextOffset;

              // The ball is the pivot: move the disc around it until the ball
              // sits between the disc and the opponent's goal.
              const controlDistance = carrier.radius + ball.radius + PASS_GAP;
              const desiredCarrierX = ball.x - game.carrierOffset.x * controlDistance;
              const desiredCarrierY = ball.y - game.carrierOffset.y * controlDistance;
              carrier.x = desiredCarrierX;
              carrier.y = desiredCarrierY;
              constrainPlayerToPitch(carrier);
              ball.x += carrier.x - desiredCarrierX;
              ball.y += carrier.y - desiredCarrierY;
              lockBallToCarrier(carrier, ball, game.carrierOffset);

              if (aligned) game.carrierTargetOffset = null;
            } else {
              lockBallToCarrier(carrier, ball, game.carrierOffset);
            }
          } else {
            lockBallToCarrier(carrier, ball, game.carrierOffset);
          }
        }
      }

      for (const body of game.bodies) {
        if (body.kind === "player") {
          constrainPlayerToPitch(body);
        }
      }
      if (!game.carrierId) constrainFreeBallToPitch(ball);

      // Use the final displacement after wall, disc, and possession corrections.
      // This keeps angular travel at exactly distance / radius with no visual slip.
      ball.rollOrientation = advanceBallOrientation(
        ball.rollOrientation ?? IDENTITY_BALL_ORIENTATION,
        ball.x - ballStartX,
        ball.y - ballStartY,
        ball.radius,
      );

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
        (game.carrierAlignDelay > 0 ||
          Math.hypot(
            game.carrierOffset.x - game.carrierTargetOffset.x,
            game.carrierOffset.y - game.carrierTargetOffset.y,
          ) > 0.015),
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
          game.carrierTargetOffset = null;
          game.carrierAlignDelay = 0;
          game.message = `PASS ${game.passChain} COMPLETE — SHOOT THE BALL`;
          syncHud();
        } else {
          switchTurn(game);
          sounds?.turn();
          syncHud();
        }
        if (onlineStage === "matched" && canPublishTurn(authorityTeam)) publishState();
      }
    };

    const updateTurnClock = (dt: number) => {
      if (!matchSetupReadyRef.current) return;
      if (game.phase !== "ready" || game.drag) return;
      game.turnTime -= dt;
      const tick = Math.ceil(game.turnTime);
      if (tick !== game.turnTick) {
        game.turnTick = tick;
        syncHud();
      }
      if (game.turnTime > 0) return;

      const authorityTeam = game.activeTeam;
      switchTurn(game, "TIME'S UP");
      sounds?.turn();
      syncHud();
      if (onlineStage === "matched" && canPublishTurn(authorityTeam)) publishState();
    };

    const loop = (now: number) => {
      const fixedFrame = advanceFixedPhysicsClock(
        physicsAccumulator,
        (now - previousTime) / 1000,
      );
      previousTime = now;
      physicsAccumulator = fixedFrame.accumulator;

      for (let physicsStep = 0; physicsStep < fixedFrame.steps; physicsStep += 1) {
        updateTurnClock(FIXED_PHYSICS_STEP_SECONDS);
        updatePhysics(FIXED_PHYSICS_STEP_SECONDS, now);
      }

      const ball = game.bodies.find((body) => body.kind === "ball");
      if (ball) updateTurfTrail(turf, ball, fixedFrame.elapsed);
      drawGame(ctx, game, viewTeam, now, turf, remoteAim, teamSetupsRef.current);
      updateAndDrawConfetti(ctx, confetti, fixedFrame.elapsed);
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
      socket?.off("game:aim", onRemoteAim);
      socket?.off("game:aim-clear", onRemoteAimClear);
      socket?.off("game:shot", onRemoteShot);
      socket?.off("game:sync", onRemoteSync);
      socket?.off("game:error", onGameError);
    };
  }, [match, onlineStage, session]);

  useEffect(() => {
    if (hud.phase !== "finished" || (onlineStage !== "matched" && onlineStage !== "practice")) return;
    const timer = window.setTimeout(() => {
      if (onlineStage === "matched") socketRef.current?.emit("match:leave");
      socketRef.current?.removeAllListeners();
      socketRef.current?.disconnect();
      socketRef.current = null;
      kickoffTeamRef.current = "mint";
      setMatch(null);
      setRoomCode("");
      setRoomPending(false);
      setNetworkMessage("");
      chatOpenRef.current = false;
      setChatMessages([]);
      setIncomingChatPopup(null);
      setChatInput("");
      setChatOpen(false);
      setUnreadChat(0);
      setReactionPickerOpen(false);
      setReactions([]);
      setOnlineStage("menu");
      setSession((value) => value + 1);

      const homeUrl = new URL(window.location.href);
      homeUrl.searchParams.delete("room");
      window.history.replaceState({}, "", `${homeUrl.pathname}${homeUrl.search}${homeUrl.hash}`);
    }, RESULT_HOME_DELAY);
    return () => window.clearTimeout(timer);
  }, [hud.phase, onlineStage]);

  const nameForTeam = (team: Team) => {
    if (!match) return TEAM_META[team].name;
    return match.player.team === team ? match.player.name : match.opponent.name;
  };
  const mintName = nameForTeam("mint");
  const coralName = nameForTeam("coral");
  const localTeam: Team = onlineStage === "matched" && match ? match.myTeam : "mint";
  const showTeamSetup = (onlineStage === "matched" || onlineStage === "practice")
    && setupStage !== "ready"
    && !reconnecting;
  const socialEnabled = onlineStage === "matched"
    && setupStage === "ready"
    && Boolean(match && !match.opponent.isBot);
  const localPlayerWon = hud.winner === localTeam;
  const showResultModal = (onlineStage === "matched" || onlineStage === "practice")
    && (hud.phase === "goal" || hud.phase === "finished")
    && !reconnecting;
  const turnMessage = reconnecting
    ? "RECONNECTING TO MATCH..."
    : opponentReconnecting
      ? "OPPONENT IS RECONNECTING..."
      : setupStage !== "ready"
        ? setupStage === "waiting" ? "WAITING FOR TEAM SETUP" : "SELECT YOUR TEAM"
      : onlineStage === "matched" && match?.myTeam !== hud.activeTeam && hud.phase === "ready"
        ? "OPPONENT IS AIMING"
        : hud.message;

  return (
    <section
      className={styles.gameShell}
      data-lobby={onlineStage !== "matched" && onlineStage !== "practice"}
      aria-label="FlickXI tabletop football game"
    >
      <header className={styles.scoreboard}>
        <button className={styles.iconButton} type="button" aria-label="Leave match" onClick={leaveMatch}>
          <span aria-hidden="true">←</span>
        </button>

        <div className={styles.playerIdentity}>
          <span className={`${styles.avatar} ${styles.mintAvatar}`}>{countryFlagEmoji(teamSetups.mint.countryCode)}</span>
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
          <span className={`${styles.avatar} ${styles.coralAvatar}`}>{countryFlagEmoji(teamSetups.coral.countryCode)}</span>
        </div>

        <button
          className={styles.iconButton}
          type="button"
          aria-label="Open match menu"
          onClick={() => setShowRules(true)}
        >
          <span aria-hidden="true">⋯</span>
        </button>
      </header>

      <div className={styles.turnStrip} data-team={hud.activeTeam}>
        <div>
          <span className={styles.liveDot} />
          {turnMessage}
        </div>
        <div className={styles.passPips} aria-label={`${hud.passChain} completed passes in this turn`}>
          <span>PASS CHAIN</span>
          <b>×{hud.passChain}</b>
        </div>
      </div>

      <div className={styles.pitchFrame}>
        <canvas
          ref={canvasRef}
          className={styles.canvas}
          aria-label="Interactive football pitch. Drag an active team disc backwards and release to shoot."
        />
        {socialEnabled ? (
          <>
            <div className={styles.reactionLayer} aria-live="polite" aria-atomic="false">
              {reactions.map((reaction) => (
                <span
                  className={styles.reactionBurst}
                  data-local={reaction.senderTeam === localTeam}
                  key={reaction.id}
                  aria-label={`${reaction.senderTeam === localTeam ? "You" : "Opponent"} reacted ${reaction.emoji}`}
                >
                  {reaction.emoji}
                </span>
              ))}
            </div>

            {!chatOpen && incomingChatPopup ? (
              <div className={styles.tableChatFeed} aria-live="polite" aria-atomic="false">
                <div className={styles.tableChatBubble} key={incomingChatPopup.id}>
                  <span>{incomingChatPopup.senderName}</span>
                  <p>{incomingChatPopup.text}</p>
                </div>
              </div>
            ) : null}

            {chatOpen ? (
              <aside className={styles.chatPanel} aria-label="Match chat history">
                <div className={styles.chatHeader}>
                  <div><span /> MATCH CHAT</div>
                  <small>TAP TABLE TO CLOSE</small>
                </div>
                <div className={styles.chatMessages} ref={chatListRef} aria-live="polite">
                  {chatMessages.length === 0 ? (
                    <p className={styles.emptyChat}>Say hello to your opponent.</p>
                  ) : chatMessages.map((message) => {
                    const mine = message.senderTeam === localTeam;
                    return (
                      <div className={styles.chatMessage} data-mine={mine} key={message.id}>
                        <span>{mine ? "YOU" : message.senderName}</span>
                        <p>{message.text}</p>
                      </div>
                    );
                  })}
                </div>
              </aside>
            ) : null}
          </>
        ) : null}
      </div>

      {socialEnabled ? (
        <div className={styles.matchChatBar} ref={chatComposerRef}>
          {reactionPickerOpen ? (
            <div className={styles.reactionPicker} role="toolbar" aria-label="Send a quick reaction">
              {REACTION_OPTIONS.map((emoji) => (
                <button type="button" key={emoji} onClick={() => sendReaction(emoji)} aria-label={`React with ${emoji}`}>
                  {emoji}
                </button>
              ))}
            </div>
          ) : null}
          <button
            className={styles.reactionToggle}
            type="button"
            data-active={reactionPickerOpen}
            onClick={() => {
              chatOpenRef.current = false;
              setChatOpen(false);
              setReactionPickerOpen((current) => !current);
            }}
            aria-label="Open emoji reactions"
          >
            <span aria-hidden="true">😊</span>
          </button>
          <form className={styles.inlineChatComposer} onSubmit={sendChatMessage}>
            <div className={styles.inlineChatField}>
              <input
                value={chatInput}
                maxLength={160}
                autoComplete="off"
                placeholder="Message your opponent..."
                onFocus={openChat}
                onClick={openChat}
                onChange={(event) => setChatInput(event.target.value)}
                aria-label="Chat message"
              />
              {unreadChat > 0 ? <b className={styles.inlineUnread}>{unreadChat}</b> : null}
            </div>
            <button type="submit" disabled={!chatInput.trim()} aria-label="Send message">↑</button>
          </form>
        </div>
      ) : null}

      {showTeamSetup ? (
        <div className={styles.setupBackdrop}>
          <section className={styles.setupCard} role="dialog" aria-modal="true" aria-labelledby="setup-title">
            {setupStage === "country" ? (
              <>
                <div className={styles.setupHeading}>
                  <div>
                    <span>TEAM SETUP · 1 OF 2</span>
                    <h2 id="setup-title">Select your country</h2>
                  </div>
                  <b>{countryFlagEmoji(selectedCountry)}</b>
                </div>
                <label className={styles.countrySearch}>
                  <span className={styles.srOnly}>Search countries</span>
                  <input
                    type="search"
                    value={countryQuery}
                    placeholder="Search any country..."
                    autoComplete="off"
                    enterKeyHint="search"
                    onChange={(event) => setCountryQuery(event.target.value)}
                  />
                </label>
                <div className={styles.countryGrid} role="listbox" aria-label="Countries">
                  {visibleCountries.map((countryCode) => (
                    <button
                      type="button"
                      role="option"
                      aria-selected={selectedCountry === countryCode}
                      data-selected={selectedCountry === countryCode}
                      key={countryCode}
                      onClick={() => {
                        setSelectedCountry(countryCode);
                        if (document.activeElement instanceof HTMLElement) {
                          document.activeElement.blur();
                        }
                      }}
                      title={countryName(countryCode)}
                    >
                      <span>{countryFlagEmoji(countryCode)}</span>
                      <small>{countryName(countryCode)}</small>
                    </button>
                  ))}
                </div>
                <div className={styles.setupFooter}>
                  <div>
                    <span>SELECTED TEAM</span>
                    <strong>{countryFlagEmoji(selectedCountry)} {countryName(selectedCountry)}</strong>
                  </div>
                  <button type="button" onClick={() => setSetupStage("formation")}>CONTINUE <span>→</span></button>
                </div>
              </>
            ) : setupStage === "formation" ? (
              <>
                <div className={styles.setupHeading}>
                  <div>
                    <span>TEAM SETUP · 2 OF 2</span>
                    <h2 id="setup-title">Select both formations</h2>
                  </div>
                  <b>{countryFlagEmoji(selectedCountry)}</b>
                </div>
                <div className={styles.formationScroll}>
                  {(["attacking", "defensive"] as const).map((style) => (
                    <section className={styles.formationGroup} key={style}>
                      <div className={styles.formationGroupTitle}>
                        <span>{style === "attacking" ? "ATTACKING" : "DEFENSIVE"}</span>
                        <small>{style === "attacking" ? "More players forward" : "Protect your goal"}</small>
                      </div>
                      <div className={styles.formationGrid}>
                        {FORMATION_OPTIONS.filter((option) => option.style === style).map((option) => {
                          const selected = style === "attacking"
                            ? selectedAttackingFormation === option.id
                            : selectedDefensiveFormation === option.id;
                          return (
                            <button
                              type="button"
                              data-selected={selected}
                              aria-pressed={selected}
                              key={option.id}
                              onClick={() => {
                                if (style === "attacking") {
                                  setSelectedAttackingFormation(option.id as AttackingFormationId);
                                } else {
                                  setSelectedDefensiveFormation(option.id as DefensiveFormationId);
                                }
                              }}
                            >
                              <span className={styles.miniPitch} aria-hidden="true">
                                <i className={styles.miniGoal} />
                                <i className={styles.miniHalfway} />
                                {FORMATION_POSITIONS[option.id].map(([x, y], index) => (
                                  <i
                                    className={styles.miniDisc}
                                    key={`${option.id}-${index}`}
                                    style={{
                                      left: `${8 + ((x - 60) / 300) * 84}%`,
                                      top: `${8 + ((y - 430) / 230) * 80}%`,
                                    }}
                                  />
                                ))}
                              </span>
                              <strong>{option.label}</strong>
                            </button>
                          );
                        })}
                      </div>
                    </section>
                  ))}
                </div>
                <div className={styles.setupFooter}>
                  <button className={styles.setupBack} type="button" onClick={() => setSetupStage("country")}>← BACK</button>
                  <button type="button" onClick={confirmFormation}>CONFIRM FORMATION <span>✓</span></button>
                </div>
              </>
            ) : (
              <div className={styles.setupWaiting}>
                <div className={styles.waitingBadge}>{countryFlagEmoji(selectedCountry)}</div>
                <span className={styles.waitingPulse} aria-hidden="true" />
                <p>YOUR TEAM IS READY</p>
                <h2 id="setup-title">Waiting for opponent</h2>
                <div className={styles.waitingSelection}>
                  <span>{countryName(selectedCountry)}</span>
                  <strong>ATTACK · {FORMATION_OPTIONS.find((option) => option.id === selectedAttackingFormation)?.label}</strong>
                  <strong>DEFENCE · {FORMATION_OPTIONS.find((option) => option.id === selectedDefensiveFormation)?.label}</strong>
                </div>
                <small>The match begins automatically when both teams confirm.</small>
              </div>
            )}
          </section>
        </div>
      ) : null}

      {showResultModal ? (
        <div className={styles.statusBackdrop}>
          <section
            className={styles.statusCard}
            data-tone={hud.phase === "goal" ? "goal" : localPlayerWon ? "won" : "lost"}
            role="status"
            aria-live="assertive"
            aria-atomic="true"
          >
            <div className={styles.statusIcon} aria-hidden="true">
              {hud.phase === "goal" ? "⚽" : localPlayerWon ? "★" : "×"}
            </div>
            <p className={styles.statusEyebrow}>
              {hud.phase === "goal" ? "GOAL SCORED" : "MATCH COMPLETE"}
            </p>
            <h2 className={styles.statusTitle}>
              {hud.phase === "goal" ? "Goal!" : localPlayerWon ? "You won" : "You lost"}
            </h2>
            <div className={styles.statusScore} aria-label={`Score ${hud.score.mint} to ${hud.score.coral}`}>
              <span>{mintName}</span>
              <strong>{hud.score.mint} - {hud.score.coral}</strong>
              <span>{coralName}</span>
            </div>
            <p className={styles.statusCopy}>
              {hud.phase === "goal" ? hud.message : "Returning to the lobby in a moment."}
            </p>
          </section>
        </div>
      ) : null}

      {showRules ? (
        <div className={styles.rulesBackdrop} role="presentation" onClick={() => setShowRules(false)}>
          <article className={styles.rulesCard} role="dialog" aria-modal="true" aria-labelledby="rules-title" onClick={(event) => event.stopPropagation()}>
            <div className={styles.rulesTopline}>
              <span>MATCH MENU</span>
              <button type="button" autoFocus onClick={() => setShowRules(false)} aria-label="Close match menu">×</button>
            </div>
            <h2 id="rules-title">Control the angle.<br />Own the chain.</h2>
            <ol>
              <li><b>Pull back</b><span>Drag opposite the direction you want the disc to travel.</span></li>
              <li><b>Read the power</b><span>A longer pull creates more force and a faster collision.</span></li>
              <li><b>Receive a pass</b><span>The ball stops with a small gap at any teammate it reaches, even from a hard hit.</span></li>
              <li><b>Shoot the ball</b><span>Flick through the gap—the contact angle controls the ball. The cyan line previews its path.</span></li>
              <li><b>Break possession</b><span>An opponent collision bounces normally and ends the passing chain.</span></li>
            </ol>
            <div className={styles.rulesActions}>
              <button className={styles.playButton} type="button" onClick={() => setShowRules(false)}>CONTINUE PLAYING</button>
              <button
                className={styles.quitButton}
                type="button"
                onClick={() => {
                  setShowRules(false);
                  leaveMatch();
                }}
              >
                QUIT MATCH
              </button>
            </div>
          </article>
        </div>
      ) : null}

      {onlineStage === "menu" ? (
        <div className={`${styles.matchOverlay} ${styles.homeOverlay}`}>
          <div className={styles.matchCard}>
            <div className={styles.livePill} role="status" aria-live="polite">
              <span />
              {onlinePlayers === null ? (
                <>CHECKING LIVE PLAYERS</>
              ) : (
                <><strong>{onlinePlayers}</strong> {onlinePlayers === 1 ? "PLAYER" : "PLAYERS"} PLAYING NOW</>
              )}
            </div>
            <p className={styles.eyebrow}>FLICK FOOTBALL</p>
            <h1>Your pitch.<br />Your match.</h1>
            <p className={styles.matchCopy}>Find a rival now, or create a private room and invite one friend.</p>
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
            <div className={styles.homeActions}>
              <button className={styles.onlineButton} type="button" onClick={() => void startMatchmaking()}>
                <span>QUICK MATCH</span><b>1 VS 1</b>
              </button>
              <button className={styles.roomButton} type="button" onClick={() => void createPrivateRoom()}>
                <span><b>+</b><i>CREATE PRIVATE ROOM</i></span><small>GET CODE</small>
              </button>
              <button
                className={styles.roomButton}
                type="button"
                onClick={() => {
                  setNetworkMessage("");
                  setOnlineStage("join-room");
                }}
              >
                <span><b>→</b><i>JOIN A FRIEND</i></span><small>ENTER CODE</small>
              </button>
            </div>
          </div>
          {authEnabled ? (
            <div className={styles.landingAuth}>
              <AuthIdentity onIdentity={setPlayerName} />
            </div>
          ) : null}
        </div>
      ) : null}

      {onlineStage === "join-room" ? (
        <div className={styles.matchOverlay}>
          <div className={`${styles.matchCard} ${styles.roomCard}`}>
            <button
              className={styles.backButton}
              type="button"
              onClick={() => {
                closeSocket();
                setRoomPending(false);
                setNetworkMessage("");
                setOnlineStage("menu");
              }}
            >
              ← BACK
            </button>
            <div className={styles.roomMark} aria-hidden="true">#</div>
            <p className={styles.eyebrow}>PRIVATE MATCH</p>
            <h2>Join your friend</h2>
            <p className={styles.matchCopy}>Enter the six-character code from their invitation.</p>
            <label className={styles.nameField}>
              <span>PLAYER NAME</span>
              <input
                value={playerName}
                maxLength={18}
                onChange={(event) => setPlayerName(event.target.value)}
                aria-label="Player name"
              />
            </label>
            <label className={styles.codeField}>
              <span>ROOM CODE</span>
              <input
                autoFocus
                autoCapitalize="characters"
                autoComplete="off"
                inputMode="text"
                value={roomCode}
                maxLength={6}
                placeholder="ABC123"
                onChange={(event) => {
                  setRoomCode(normalizeRoomCode(event.target.value));
                  setNetworkMessage("");
                }}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && roomCode.length === 6 && !roomPending) {
                    void joinPrivateRoom();
                  }
                }}
                aria-label="Six-character room code"
              />
            </label>
            {networkMessage ? <p className={styles.networkError}>{networkMessage}</p> : null}
            <button
              className={styles.onlineButton}
              type="button"
              disabled={roomPending || roomCode.length !== 6}
              onClick={() => void joinPrivateRoom()}
            >
              <span>{roomPending ? "JOINING ROOM..." : "JOIN ROOM"}</span><b>PLAY</b>
            </button>
          </div>
        </div>
      ) : null}

      {onlineStage === "waiting-room" ? (
        <div className={styles.matchOverlay}>
          <div className={`${styles.matchCard} ${styles.roomCard}`}>
            <div className={styles.livePill}><span /> PRIVATE ROOM</div>
            {roomPending && !roomCode ? (
              <div className={styles.miniLoader} aria-label="Creating room" />
            ) : (
              <div className={styles.waitingPlayers} aria-hidden="true">
                <span>YOU</span><i>···</i><span>?</span>
              </div>
            )}
            <p className={styles.eyebrow}>{roomPending && !roomCode ? "CREATING ROOM" : "ROOM IS READY"}</p>
            <h2>{roomPending && !roomCode ? "Preparing your pitch" : "Invite your rival"}</h2>
            <p className={styles.matchCopy}>
              {roomPending && !roomCode
                ? "Generating a private room code..."
                : "Share this code or invite link. The game starts when your friend joins."}
            </p>
            {roomCode ? (
              <div className={styles.roomCodeDisplay} aria-label={`Room code ${roomCode}`}>
                {roomCode.split("").map((character, index) => <span key={`${character}-${index}`}>{character}</span>)}
              </div>
            ) : null}
            {networkMessage ? <p className={styles.networkError}>{networkMessage}</p> : null}
            <button
              className={styles.onlineButton}
              type="button"
              disabled={!roomCode}
              onClick={() => void sharePrivateRoom()}
            >
              <span>{roomCopied ? "INVITE COPIED" : "SHARE INVITE"}</span><b>{roomCopied ? "✓" : "↗"}</b>
            </button>
            <div className={styles.queueStatus}><span /> WAITING FOR ONE FRIEND</div>
            <button className={styles.practiceButton} type="button" onClick={cancelPrivateRoom}>CANCEL ROOM</button>
          </div>
        </div>
      ) : null}

      {onlineStage === "searching" ? (
        <div className={styles.matchOverlay}>
          <div className={`${styles.matchCard} ${styles.searchCard}`}>
            <div className={styles.searchOrb} aria-hidden="true"><i /><i /><span>VS</span></div>
            <p className={styles.eyebrow}>MATCHMAKING</p>
            <h2>Finding your opponent</h2>
            <p className={styles.matchCopy}>Searching for a real player. FlickBot joins after 6 seconds if nobody is available.</p>
            <div className={styles.queueStatus}>
              <span /> {searchSeconds >= 4 ? "PREPARING FLICKBOT" : "SEARCHING"} <b>{searchSeconds}s</b>
            </div>
            <button className={styles.practiceButton} type="button" onClick={cancelSearch}>CANCEL SEARCH</button>
          </div>
        </div>
      ) : null}

      {onlineStage === "matched" && reconnecting ? (
        <div className={styles.statusBackdrop}>
          <section className={styles.statusCard} data-tone="warning" role="dialog" aria-modal="true" aria-labelledby="reconnect-title">
            <div className={styles.statusIcon} aria-hidden="true">!</div>
            <p className={styles.statusEyebrow}>CONNECTION INTERRUPTED</p>
            <h2 className={styles.statusTitle} id="reconnect-title">Your match is saved</h2>
            <p className={styles.statusCopy}>Automatic recovery is running. You can also reconnect immediately.</p>
            <div className={styles.statusActions}>
              <button className={styles.onlineButton} type="button" autoFocus onClick={() => void reconnectMatch()}>
                <span>RECONNECT NOW</span><b>GO</b>
              </button>
              <button className={styles.practiceButton} type="button" onClick={leaveMatch}>LEAVE MATCH</button>
            </div>
          </section>
        </div>
      ) : null}

      {onlineStage === "disconnected" ? (
        <div className={styles.statusBackdrop}>
          <section className={styles.statusCard} data-tone="lost" role="dialog" aria-modal="true" aria-labelledby="disconnected-title">
            <div className={styles.statusIcon} aria-hidden="true">!</div>
            <p className={styles.statusEyebrow}>CONNECTION LOST</p>
            <h2 className={styles.statusTitle} id="disconnected-title">
              {match ? "Reconnect to your match" : "Match unavailable"}
            </h2>
            <p className={styles.statusCopy}>{networkMessage || "This match is no longer active."}</p>
            <div className={styles.statusActions}>
              {match ? (
                <button
                  className={styles.onlineButton}
                  type="button"
                  autoFocus
                  disabled={reconnecting}
                  onClick={() => void reconnectMatch()}
                >
                  <span>{reconnecting ? "RECONNECTING..." : "RECONNECT MATCH"}</span><b>GO</b>
                </button>
              ) : null}
              <button className={styles.onlineButton} type="button" autoFocus={!match} onClick={() => void startMatchmaking()}>
                <span>FIND NEW RIVAL</span><b>GO</b>
              </button>
              <button className={styles.practiceButton} type="button" onClick={leaveMatch}>BACK TO LOBBY</button>
            </div>
          </section>
        </div>
      ) : null}

      <span className={styles.srOnly} aria-live="polite">
        {TEAM_META[hud.activeTeam].name} turn. Score {hud.score.mint} to {hud.score.coral}.
        {hud.winner ? ` ${TEAM_META[hud.winner].name} won the match.` : ""}
      </span>
    </section>
  );
}
