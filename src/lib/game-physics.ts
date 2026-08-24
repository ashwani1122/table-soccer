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

export function resolvePossessedBallCollision(
  player: MovingCollisionBody,
  carrier: MovingCollisionBody,
  ball: MovingCollisionBody,
  restitution: number,
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
    player.vx -= (impulse * normalX) / player.mass;
    player.vy -= (impulse * normalY) / player.mass;
    carrier.vx += (impulse * normalX) / possessionMass;
    carrier.vy += (impulse * normalY) / possessionMass;
  }

  ball.vx = carrier.vx;
  ball.vy = carrier.vy;
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
