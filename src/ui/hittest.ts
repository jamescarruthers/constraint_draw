import { Entity, getPointPos, getLineEndpoints, getCircleParams, getArcParams, getArcEndpoints, getEllipseParams } from '../core/entity';
import { Vec } from '../core/types';

/** Hit test result */
export interface HitResult {
  entity: Entity;
  /** The specific sub-part hit: 'body', 'p1', 'p2', 'center' */
  part: string;
  /** Distance in world coords from the test point */
  distance: number;
  /** Variable indices of the hit part (for dragging) */
  vars: number[];
}

/**
 * Hit test against all entities, returning matches sorted by priority/distance.
 * Thresholds are in world coordinates.
 */
export function hitTest(
  entities: Entity[],
  q: Vec,
  wx: number,
  wy: number,
  pointThreshold: number,
  lineThreshold: number
): HitResult[] {
  const results: HitResult[] = [];

  for (const entity of entities) {
    switch (entity.type) {
      case 'point': {
        const [px, py] = getPointPos(entity, q);
        const d = Math.hypot(wx - px, wy - py);
        if (d < pointThreshold) {
          results.push({
            entity,
            part: 'body',
            distance: d,
            vars: [...entity.vars],
          });
        }
        break;
      }
      case 'line': {
        const [[x1, y1], [x2, y2]] = getLineEndpoints(entity, q);
        const v = entity.vars;

        // Test endpoints first (higher priority)
        const d1 = Math.hypot(wx - x1, wy - y1);
        if (d1 < pointThreshold) {
          results.push({ entity, part: 'p1', distance: d1, vars: [v[0], v[1]] });
        }
        const d2 = Math.hypot(wx - x2, wy - y2);
        if (d2 < pointThreshold) {
          results.push({ entity, part: 'p2', distance: d2, vars: [v[2], v[3]] });
        }

        // Test line body
        const dLine = distPointToSegment(wx, wy, x1, y1, x2, y2);
        if (dLine < lineThreshold) {
          results.push({ entity, part: 'body', distance: dLine, vars: [...entity.vars] });
        }
        break;
      }
      case 'circle': {
        const { cx, cy, r } = getCircleParams(entity, q);
        const v = entity.vars;

        // Test center
        const dc = Math.hypot(wx - cx, wy - cy);
        if (dc < pointThreshold) {
          results.push({ entity, part: 'center', distance: dc, vars: [v[0], v[1]] });
        }

        // Test circle edge
        const dEdge = Math.abs(dc - Math.abs(r));
        if (dEdge < lineThreshold) {
          results.push({ entity, part: 'body', distance: dEdge, vars: [...entity.vars] });
        }
        break;
      }
      case 'arc': {
        const { cx, cy, r, thetaStart, thetaEnd } = getArcParams(entity, q);
        const { start, end } = getArcEndpoints(entity, q);
        const v = entity.vars;

        // Test start/end endpoints
        const dStart = Math.hypot(wx - start[0], wy - start[1]);
        if (dStart < pointThreshold) {
          results.push({ entity, part: 'p1', distance: dStart, vars: [v[5], v[6]] });
        }
        const dEnd = Math.hypot(wx - end[0], wy - end[1]);
        if (dEnd < pointThreshold) {
          results.push({ entity, part: 'p2', distance: dEnd, vars: [v[7], v[8]] });
        }

        // Test center
        const dc = Math.hypot(wx - cx, wy - cy);
        if (dc < pointThreshold) {
          results.push({ entity, part: 'center', distance: dc, vars: [v[0], v[1]] });
        }

        // Test arc edge
        const angle = Math.atan2(wy - cy, wx - cx);
        const inArc = isAngleInRange(angle, thetaStart, thetaEnd);
        if (inArc) {
          const dEdge = Math.abs(dc - Math.abs(r));
          if (dEdge < lineThreshold) {
            results.push({ entity, part: 'body', distance: dEdge, vars: [...entity.vars] });
          }
        }
        break;
      }
      case 'ellipse': {
        const { cx, cy, rx, ry, angle } = getEllipseParams(entity, q);
        const v = entity.vars;

        // Test center
        const dc = Math.hypot(wx - cx, wy - cy);
        if (dc < pointThreshold) {
          results.push({ entity, part: 'center', distance: dc, vars: [v[0], v[1]] });
        }

        // Approximate ellipse edge test
        const cosA = Math.cos(angle), sinA = Math.sin(angle);
        const dx = wx - cx, dy = wy - cy;
        const u = dx * cosA + dy * sinA;
        const vv = dy * cosA - dx * sinA;
        const ellipseVal = (u * u) / (rx * rx) + (vv * vv) / (ry * ry);
        const dEdge = Math.abs(Math.sqrt(ellipseVal) - 1) * Math.max(Math.abs(rx), Math.abs(ry));
        if (dEdge < lineThreshold) {
          results.push({ entity, part: 'body', distance: dEdge, vars: [...entity.vars] });
        }
        break;
      }
    }
  }

  // Sort by priority: points > endpoints > centres > edges, then by distance
  results.sort((a, b) => {
    const priority = (r: HitResult) => {
      if (r.entity.type === 'point') return 0;
      if (r.part === 'p1' || r.part === 'p2') return 1;
      if (r.part === 'center') return 2;
      return 3;
    };
    const pa = priority(a), pb = priority(b);
    if (pa !== pb) return pa - pb;
    return a.distance - b.distance;
  });

  return results;
}

/** Distance from point (px,py) to line segment (x1,y1)-(x2,y2) */
function distPointToSegment(
  px: number, py: number,
  x1: number, y1: number, x2: number, y2: number
): number {
  const dx = x2 - x1, dy = y2 - y1;
  const len2 = dx * dx + dy * dy;
  if (len2 < 1e-10) return Math.hypot(px - x1, py - y1);

  let t = ((px - x1) * dx + (py - y1) * dy) / len2;
  t = Math.max(0, Math.min(1, t));

  const projX = x1 + t * dx;
  const projY = y1 + t * dy;
  return Math.hypot(px - projX, py - projY);
}

/** Check if angle is within [start, end] arc range, handling wrapping */
function isAngleInRange(angle: number, start: number, end: number): boolean {
  // Normalize to [0, 2pi]
  const TWO_PI = Math.PI * 2;
  const norm = (a: number) => ((a % TWO_PI) + TWO_PI) % TWO_PI;

  const a = norm(angle);
  const s = norm(start);
  const e = norm(end);

  if (s <= e) return a >= s && a <= e;
  return a >= s || a <= e;
}
