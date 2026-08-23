export type CollisionBody = {
  x: number;
  y: number;
  radius: number;
  mass: number;
};

export type PossessionImpact = {
  travel: number;
  normalX: number;
  normalY: number;
  ballVx: number;
  ballVy: number;
};

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
