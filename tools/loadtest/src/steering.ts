export interface SteeringTarget {
  x: number;
  y: number;
}

export interface SteeringControls {
  up: boolean;
  down: boolean;
  left: boolean;
  right: boolean;
}

const HWY_Y_CENTERS = [
  3.0, 12.0, 21.0, 30.0, 39.0, 44.0, 53.0, 62.0, 71.0, 80.0, 89.0, 98.0,
];

const OPEN_AISLE_X_CENTERS = [
  2.5, 4.5, 6.5, 9.5, 10.5, 11.5, 14.5, 15.5, 16.5, 19.5, 20.5, 21.5, 24.5,
  25.5, 26.5, 29.5, 30.5, 31.5, 34.5, 35.5, 40.5, 45.5, 49.5, 50.5, 51.5, 55.5,
];

function normalizeAngle(rad: number): number {
  let a = rad;
  while (a > Math.PI) a -= Math.PI * 2;
  while (a < -Math.PI) a += Math.PI * 2;
  return a;
}

function nearestHighwayY(y: number, targetY: number): number {
  let best = HWY_Y_CENTERS[0];
  let bestScore = Infinity;
  for (const hy of HWY_Y_CENTERS) {
    const score = Math.abs(y - hy) + Math.abs(targetY - hy) * 0.5;
    if (score < bestScore) {
      bestScore = score;
      best = hy;
    }
  }
  return best;
}

function nearestOpenAisleX(x: number): number {
  let best = OPEN_AISLE_X_CENTERS[0];
  let bestDist = Infinity;
  for (const ax of OPEN_AISLE_X_CENTERS) {
    const d = Math.abs(x - ax);
    if (d < bestDist) {
      bestDist = d;
      best = ax;
    }
  }
  return best;
}

/**
 * Pure client-side waypoint + heading controller for human vehicles.
 * Navigates warehouse aisles via horizontal highway bands using only HUD wire coordinates.
 */
export function computeSteeringControls(params: {
  vx: number;
  vy: number;
  angle: number;
  speedNow: number;
  targetX: number;
  targetY: number;
  stuckTicks: number;
}): { controls: SteeringControls; distance: number; nextStuckTicks: number } {
  const { vx, vy, angle, speedNow, targetX, targetY, stuckTicks } = params;
  const tx = targetX + 0.5;
  const ty = targetY + 0.5;
  const distance = Math.hypot(tx - vx, ty - vy);

  if (distance <= 1.45) {
    return {
      controls: { up: false, down: false, left: false, right: false },
      distance,
      nextStuckTicks: 0,
    };
  }

  const nextStuckTicks = Math.abs(speedNow) < 0.05 ? stuckTicks + 1 : 0;

  // Unstick maneuver if blocked against a rack corner or another vehicle for several 10Hz ticks
  if (nextStuckTicks >= 4 && nextStuckTicks <= 8) {
    return {
      controls: {
        up: false,
        down: true,
        left: nextStuckTicks <= 6,
        right: nextStuckTicks > 6,
      },
      distance,
      nextStuckTicks: nextStuckTicks >= 8 ? 0 : nextStuckTicks,
    };
  }

  // Determine intermediate waypoint so vehicles use horizontal highways between rack aisles
  // and vertical lane x = 55.5 for East bay approaches (east of the x = 52 conveyor wall).
  let wx = tx;
  let wy = ty;
  const dxAbs = Math.abs(tx - vx);
  const dyAbs = Math.abs(ty - vy);

  if (tx >= 56 && vx >= 53.5 && dyAbs > 0.65) {
    // Already east of the conveyor wall (x=52): align with vertical highway column x=55.5 first,
    // then move vertically to targetY before pulling into the bay at x=58.5.
    wx = Math.abs(vx - 55.5) > 0.55 ? 55.5 : tx;
    wy = ty;
  } else if (dxAbs > 0.45) {
    const hwyY = nearestHighwayY(vy, ty);
    if (Math.abs(vy - hwyY) > 1.25) {
      // First move vertically in nearest open aisle center to reach the nearest horizontal highway
      wx = nearestOpenAisleX(vx);
      wy = hwyY;
    } else {
      // Move horizontally along the 4-tile-wide highway to align with target aisle X (or x=55.5 for East bays)
      wx = tx >= 56 && dyAbs > 0.65 ? 55.5 : tx;
      wy = hwyY;
    }
  }

  const desiredAngle = Math.atan2(wy - vy, wx - vx);
  const diff = normalizeAngle(desiredAngle - angle);

  const left = diff < -0.11;
  const right = diff > 0.11;
  const up = Math.abs(diff) < 1.15 || Math.abs(speedNow) < 0.15;
  const down = Math.abs(diff) >= 1.85 && speedNow > 0.5;

  return {
    controls: { up, down, left, right },
    distance,
    nextStuckTicks,
  };
}
