export type CollisionBody = {
  x: number;
  y: number;
  radius: number;
  mass: number;
};

export type MovingCollisionBody = CollisionBody & {
  vx: number;
  vy: number;
};

export type GoalArena = {
  left: number;
  right: number;
  top: number;
  bottom: number;
  goalLeft: number;
  goalRight: number;
  topGoalBack: number;
  bottomGoalBack: number;
};

export const FIXED_PHYSICS_STEP_SECONDS = 1 / 120;

const FIXED_STEP_EPSILON = 1e-9;
const DEFAULT_MAX_FRAME_CATCHUP = 1;
const DEFAULT_MAX_STEPS_PER_FRAME = 120;

export function advanceFixedPhysicsClock(
  accumulator: number,
  frameDelta: number,
  fixedStep = FIXED_PHYSICS_STEP_SECONDS,
  maxFrameCatchup = DEFAULT_MAX_FRAME_CATCHUP,
  maxSteps = DEFAULT_MAX_STEPS_PER_FRAME,
) {
  const safeStep = Math.max(0.0001, fixedStep);
  const elapsed = Math.min(
    Math.max(0, Number.isFinite(frameDelta) ? frameDelta : 0),
    Math.max(0, maxFrameCatchup),
  );
  let remaining = Math.max(0, Number.isFinite(accumulator) ? accumulator : 0) + elapsed;
  const availableSteps = Math.floor((remaining + FIXED_STEP_EPSILON) / safeStep);
  const steps = Math.min(Math.max(0, Math.floor(maxSteps)), availableSteps);
  remaining = Math.max(0, remaining - steps * safeStep);

  if (steps === maxSteps && remaining + FIXED_STEP_EPSILON >= safeStep) {
    remaining %= safeStep;
  }

  return { accumulator: remaining, elapsed, steps };
}

export function capturePossessionMomentum(
  receiver: MovingCollisionBody,
  ball: MovingCollisionBody,
  transferScale = 1,
) {
  const combinedMass = receiver.mass + ball.mass;
  if (!Number.isFinite(combinedMass) || combinedMass <= 0.001) {
    receiver.vx = 0;
    receiver.vy = 0;
    ball.vx = 0;
    ball.vy = 0;
    return { vx: 0, vy: 0 };
  }

  const receiverVx = receiver.vx;
  const receiverVy = receiver.vy;
  const mergedVx = (receiverVx * receiver.mass + ball.vx * ball.mass) / combinedMass;
  const mergedVy = (receiverVy * receiver.mass + ball.vy * ball.mass) / combinedMass;
  const retainedTransfer = Math.max(0, Math.min(1, transferScale));
  const vx = receiverVx + (mergedVx - receiverVx) * retainedTransfer;
  const vy = receiverVy + (mergedVy - receiverVy) * retainedTransfer;
  receiver.vx = vx;
  receiver.vy = vy;
  ball.vx = vx;
  ball.vy = vy;
  return { vx, vy };
}

export function constrainBodyToGoalArena(
  body: MovingCollisionBody,
  arena: GoalArena,
  restitution: number,
) {
  const bounce = Math.max(0, Math.min(1, restitution));
  let collided = false;

  const reboundLeft = (x: number) => {
    body.x = x;
    if (body.vx < 0) body.vx = Math.abs(body.vx) * bounce;
    collided = true;
  };
  const reboundRight = (x: number) => {
    body.x = x;
    if (body.vx > 0) body.vx = -Math.abs(body.vx) * bounce;
    collided = true;
  };
  const reboundTop = (y: number) => {
    body.y = y;
    if (body.vy < 0) body.vy = Math.abs(body.vy) * bounce;
    collided = true;
  };
  const reboundBottom = (y: number) => {
    body.y = y;
    if (body.vy > 0) body.vy = -Math.abs(body.vy) * bounce;
    collided = true;
  };

  if (body.y < arena.top) {
    if (body.x - body.radius < arena.goalLeft) reboundLeft(arena.goalLeft + body.radius);
    if (body.x + body.radius > arena.goalRight) reboundRight(arena.goalRight - body.radius);
    if (body.y - body.radius < arena.topGoalBack) reboundTop(arena.topGoalBack + body.radius);
    return collided;
  }

  if (body.y > arena.bottom) {
    if (body.x - body.radius < arena.goalLeft) reboundLeft(arena.goalLeft + body.radius);
    if (body.x + body.radius > arena.goalRight) reboundRight(arena.goalRight - body.radius);
    if (body.y + body.radius > arena.bottomGoalBack) reboundBottom(arena.bottomGoalBack - body.radius);
    return collided;
  }

  if (body.x - body.radius < arena.left) reboundLeft(arena.left + body.radius);
  if (body.x + body.radius > arena.right) reboundRight(arena.right - body.radius);

  const clearsGoalMouth =
    body.x - body.radius >= arena.goalLeft &&
    body.x + body.radius <= arena.goalRight;
  if (!clearsGoalMouth && body.y - body.radius < arena.top) {
    reboundTop(arena.top + body.radius);
  }
  if (!clearsGoalMouth && body.y + body.radius > arena.bottom) {
    reboundBottom(arena.bottom - body.radius);
  }

  return collided;
}

export function resolvePossessedBallCollision(
  player: MovingCollisionBody,
  carrier: MovingCollisionBody,
  ball: MovingCollisionBody,
  restitution: number,
  possessionToPlayerTransfer = 1,
) {
  let dx = ball.x - player.x;
  let dy = ball.y - player.y;
  let distance = Math.hypot(dx, dy);
  const minimumDistance = player.radius + ball.radius;
  if (distance >= minimumDistance) return false;

  if (distance < 0.001) {
    dx = 0.001;
    dy = 0;
    distance = 0.001;
  }

  const normalX = dx / distance;
  const normalY = dy / distance;
  const overlap = minimumDistance - distance;
  const possessionMass = carrier.mass + ball.mass;
  const totalMass = player.mass + possessionMass;
  const playerShift = overlap * (possessionMass / totalMass);
  const possessionShift = overlap * (player.mass / totalMass);

  player.x -= normalX * playerShift;
  player.y -= normalY * playerShift;
  carrier.x += normalX * possessionShift;
  carrier.y += normalY * possessionShift;
  ball.x += normalX * possessionShift;
  ball.y += normalY * possessionShift;

  const relativeX = carrier.vx - player.vx;
  const relativeY = carrier.vy - player.vy;
  const closingSpeed = relativeX * normalX + relativeY * normalY;
  if (closingSpeed < 0) {
    const impulse = (-(1 + restitution) * closingSpeed) /
      (1 / player.mass + 1 / possessionMass);
    const playerTowardImpact = Math.max(0, player.vx * normalX + player.vy * normalY);
    const possessionTowardPlayer = Math.max(0, -(carrier.vx * normalX + carrier.vy * normalY));
    const playerResponse = possessionTowardPlayer > playerTowardImpact
      ? Math.max(0, Math.min(1, possessionToPlayerTransfer))
      : 1;
    player.vx -= ((impulse * normalX) / player.mass) * playerResponse;
    player.vy -= ((impulse * normalY) / player.mass) * playerResponse;
    carrier.vx += (impulse * normalX) / possessionMass;
    carrier.vy += (impulse * normalY) / possessionMass;
  }

  ball.vx = carrier.vx;
  ball.vy = carrier.vy;
  return true;
}

export function resolveBallPlayerCollision(
  player: MovingCollisionBody,
  ball: MovingCollisionBody,
  restitution: number,
  ballToPlayerTransfer = 1,
) {
  let dx = ball.x - player.x;
  let dy = ball.y - player.y;
  let distance = Math.hypot(dx, dy);
  const minimumDistance = player.radius + ball.radius;
  if (distance >= minimumDistance) return false;

  if (distance < 0.001) {
    dx = 0.001;
    dy = 0;
    distance = 0.001;
  }

  const normalX = dx / distance;
  const normalY = dy / distance;
  const overlap = minimumDistance - distance;
  const totalMass = player.mass + ball.mass;
  player.x -= normalX * overlap * (ball.mass / totalMass);
  player.y -= normalY * overlap * (ball.mass / totalMass);
  ball.x += normalX * overlap * (player.mass / totalMass);
  ball.y += normalY * overlap * (player.mass / totalMass);

  const relativeX = ball.vx - player.vx;
  const relativeY = ball.vy - player.vy;
  const closingSpeed = relativeX * normalX + relativeY * normalY;
  if (closingSpeed >= 0) return true;

  const impulse = (-(1 + restitution) * closingSpeed) /
    (1 / player.mass + 1 / ball.mass);
  const playerTowardBall = Math.max(0, player.vx * normalX + player.vy * normalY);
  const ballTowardPlayer = Math.max(0, -(ball.vx * normalX + ball.vy * normalY));
  const playerResponse = ballTowardPlayer > playerTowardBall
    ? Math.max(0, Math.min(1, ballToPlayerTransfer))
    : 1;
  player.vx -= ((impulse * normalX) / player.mass) * playerResponse;
  player.vy -= ((impulse * normalY) / player.mass) * playerResponse;
  ball.vx += (impulse * normalX) / ball.mass;
  ball.vy += (impulse * normalY) / ball.mass;
  return true;
}

export function isWithinPassControl(
  player: Pick<CollisionBody, "x" | "y" | "radius">,
  ball: Pick<CollisionBody, "x" | "y" | "radius">,
  controlGap: number,
) {
  const controlDistance = player.radius + ball.radius + Math.max(0, controlGap);
  return Math.hypot(player.x - ball.x, player.y - ball.y) <= controlDistance;
}

export type PossessionImpact = {
  travel: number;
  normalX: number;
  normalY: number;
  ballVx: number;
  ballVy: number;
};

export type BallRoll = {
  phase: number;
  angle: number;
};

export function advanceBallRoll(
  currentPhase: number,
  currentAngle: number,
  travelX: number,
  travelY: number,
  radius: number,
): BallRoll {
  const distance = Math.hypot(travelX, travelY);
  if (!Number.isFinite(distance) || distance < 0.0001) {
    return { phase: currentPhase, angle: currentAngle };
  }

  return {
    phase: currentPhase + distance / Math.max(0.001, radius),
    angle: Math.atan2(travelY, travelX),
  };
}

export function calculatePossessionImpact(
  player: CollisionBody,
  ball: CollisionBody,
  direction: { x: number; y: number },
  launchSpeed: number,
  restitution: number,
): PossessionImpact | null {
  const directionLength = Math.hypot(direction.x, direction.y);
  if (!Number.isFinite(directionLength) || directionLength < 0.001 || launchSpeed <= 0) return null;
  const dirX = direction.x / directionLength;
  const dirY = direction.y / directionLength;
  const toBallX = ball.x - player.x;
  const toBallY = ball.y - player.y;
  const forwardDistance = toBallX * dirX + toBallY * dirY;
  if (forwardDistance <= 0) return null;

  const collisionDistance = player.radius + ball.radius;
  const perpendicularSquared = Math.max(
    0,
    toBallX * toBallX + toBallY * toBallY - forwardDistance * forwardDistance,
  );
  if (perpendicularSquared > collisionDistance * collisionDistance) return null;

  const travel = Math.max(
    0,
    forwardDistance - Math.sqrt(collisionDistance * collisionDistance - perpendicularSquared),
  );
  const impactPlayerX = player.x + dirX * travel;
  const impactPlayerY = player.y + dirY * travel;
  const normalXRaw = ball.x - impactPlayerX;
  const normalYRaw = ball.y - impactPlayerY;
  const normalLength = Math.max(0.001, Math.hypot(normalXRaw, normalYRaw));
  const normalX = normalXRaw / normalLength;
  const normalY = normalYRaw / normalLength;
  const normalApproach = Math.max(0, dirX * normalX + dirY * normalY);
  if (normalApproach < 0.04) return null;

  const transferredSpeed = launchSpeed * normalApproach *
    ((1 + restitution) * player.mass) / (player.mass + ball.mass);
  const tangentX = -normalY;
  const tangentY = normalX;
  const tangentialApproach = dirX * tangentX + dirY * tangentY;
  const tangentialSpeed = launchSpeed * tangentialApproach * 0.08;

  return {
    travel,
    normalX,
    normalY,
    ballVx: normalX * transferredSpeed + tangentX * tangentialSpeed,
    ballVy: normalY * transferredSpeed + tangentY * tangentialSpeed,
  };
}
