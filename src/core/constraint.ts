import { ConstraintType, SparseEntry, Vec } from './types';

/** Unique constraint ID counter */
let nextConstraintId = 1;

/** Reset constraint ID counter */
export function resetConstraintIdCounter(): void {
  nextConstraintId = 1;
}

/**
 * Base constraint interface.
 * Every constraint can evaluate its residual C(q) and compute Jacobian entries dC/dq.
 */
export abstract class BaseConstraint {
  id: string;
  abstract readonly type: ConstraintType;
  abstract readonly dof: number;
  entityIds: string[];
  params: number[];
  /**
   * Optional per-entity sub-part label describing which point-like part of
   * each entity the constraint attaches to (e.g. 'p1', 'p2', 'center').
   * Used by constraints that take a sub-part of a line or arc as one of
   * their inputs. A null entry means "use the entity's default" (which
   * resolves to the first endpoint for a line, the center for a circle,
   * etc.). Serialised in toJSON so the sub-part intent survives save/load
   * and undo/redo.
   */
  subParts?: (string | null)[];

  constructor(entityIds: string[], params: number[] = [], id?: string) {
    this.id = id ?? `c_${nextConstraintId++}`;
    this.entityIds = entityIds;
    this.params = params;
  }

  abstract evaluate(q: Vec): Vec;
  abstract jacobianEntries(q: Vec, rowOffset: number): SparseEntry[];

  /**
   * Update this constraint's dimensional parameters in place. Called by
   * the info panel when the user edits a value. Default implementation
   * just overwrites `params`; subclasses with cached state (e.g.
   * FixedAngleConstraint's sin/cos) override to keep their caches
   * consistent.
   */
  setParams(params: number[]): void {
    this.params = [...params];
  }
}

/**
 * Resolve a sub-part label on an entity to the [x, y] variable indices.
 * Returns null if the label doesn't apply to the entity type (caller
 * should fall back to the default selection in that case).
 */
export function resolveSubPart(
  entity: {
    type: 'point' | 'line' | 'arc' | 'circle' | 'ellipse';
    vars: number[];
  },
  subPart: string | null | undefined
): [number, number] | null {
  if (!subPart) return null;
  const v = entity.vars;
  switch (entity.type) {
    case 'point':
      return [v[0], v[1]];
    case 'line':
      if (subPart === 'p1') return [v[0], v[1]];
      if (subPart === 'p2') return [v[2], v[3]];
      return null;
    case 'arc':
      if (subPart === 'center') return [v[0], v[1]];
      if (subPart === 'p1') return [v[5], v[6]];
      if (subPart === 'p2') return [v[7], v[8]];
      return null;
    case 'circle':
      if (subPart === 'center') return [v[0], v[1]];
      return null;
    case 'ellipse':
      if (subPart === 'center') return [v[0], v[1]];
      return null;
  }
}

// ─── Point Constraints ─────────────────────────────────────────────

/** Coincident: merge two points */
export class CoincidentConstraint extends BaseConstraint {
  readonly type = 'coincident' as const;
  readonly dof = 2;

  constructor(
    private ax: number, private ay: number,
    private bx: number, private by: number,
    entityIds: string[], id?: string
  ) {
    super(entityIds, [], id);
  }

  evaluate(q: Vec): Vec {
    return [q[this.ax] - q[this.bx], q[this.ay] - q[this.by]];
  }

  jacobianEntries(_q: Vec, row: number): SparseEntry[] {
    return [
      { row, col: this.ax, val: 1 },
      { row, col: this.bx, val: -1 },
      { row: row + 1, col: this.ay, val: 1 },
      { row: row + 1, col: this.by, val: -1 },
    ];
  }
}

/** Fixed point: pin to (xf, yf) */
export class FixedPointConstraint extends BaseConstraint {
  readonly type = 'fixed' as const;
  readonly dof = 2;

  constructor(
    private xi: number, private yi: number,
    private xf: number, private yf: number,
    entityIds: string[], id?: string
  ) {
    super(entityIds, [xf, yf], id);
  }

  evaluate(q: Vec): Vec {
    return [q[this.xi] - this.xf, q[this.yi] - this.yf];
  }

  jacobianEntries(_q: Vec, row: number): SparseEntry[] {
    return [
      { row, col: this.xi, val: 1 },
      { row: row + 1, col: this.yi, val: 1 },
    ];
  }

  setParams(params: number[]): void {
    super.setParams(params);
    this.xf = params[0];
    this.yf = params[1];
  }
}

/** Point on Line: P lies on infinite line through A–B */
export class PointOnLineConstraint extends BaseConstraint {
  readonly type = 'pointOnLine' as const;
  readonly dof = 1;

  constructor(
    private px: number, private py: number,
    private ax: number, private ay: number,
    private bx: number, private by: number,
    entityIds: string[], id?: string
  ) {
    super(entityIds, [], id);
  }

  evaluate(q: Vec): Vec {
    // C = (Px-Ax)(By-Ay) - (Py-Ay)(Bx-Ax)
    const dx = q[this.bx] - q[this.ax];
    const dy = q[this.by] - q[this.ay];
    return [(q[this.px] - q[this.ax]) * dy - (q[this.py] - q[this.ay]) * dx];
  }

  jacobianEntries(q: Vec, row: number): SparseEntry[] {
    const Px = q[this.px], Py = q[this.py];
    const Ax = q[this.ax], Ay = q[this.ay];
    const Bx = q[this.bx], By = q[this.by];
    const dx = Bx - Ax, dy = By - Ay;
    return [
      { row, col: this.px, val: dy },
      { row, col: this.py, val: -dx },
      { row, col: this.ax, val: -dy },
      { row, col: this.ay, val: Bx - Px },
      { row, col: this.bx, val: Ay - Py },
      { row, col: this.by, val: Px - Ax },
    ];
  }
}

/** Point on Circle: dist(P, center) = r */
export class PointOnCircleConstraint extends BaseConstraint {
  readonly type = 'pointOnCircle' as const;
  readonly dof = 1;

  constructor(
    private px: number, private py: number,
    private cx: number, private cy: number, private ri: number,
    entityIds: string[], id?: string
  ) {
    super(entityIds, [], id);
  }

  evaluate(q: Vec): Vec {
    const dx = q[this.px] - q[this.cx];
    const dy = q[this.py] - q[this.cy];
    const r = q[this.ri];
    return [dx * dx + dy * dy - r * r];
  }

  jacobianEntries(q: Vec, row: number): SparseEntry[] {
    const dx = q[this.px] - q[this.cx];
    const dy = q[this.py] - q[this.cy];
    const r = q[this.ri];
    return [
      { row, col: this.px, val: 2 * dx },
      { row, col: this.py, val: 2 * dy },
      { row, col: this.cx, val: -2 * dx },
      { row, col: this.cy, val: -2 * dy },
      { row, col: this.ri, val: -2 * r },
    ];
  }
}

/** Point at Midpoint of a line segment */
export class MidpointConstraint extends BaseConstraint {
  readonly type = 'midpoint' as const;
  readonly dof = 2;

  constructor(
    private px: number, private py: number,
    private ax: number, private ay: number,
    private bx: number, private by: number,
    entityIds: string[], id?: string
  ) {
    super(entityIds, [], id);
  }

  evaluate(q: Vec): Vec {
    return [
      q[this.px] - (q[this.ax] + q[this.bx]) / 2,
      q[this.py] - (q[this.ay] + q[this.by]) / 2,
    ];
  }

  jacobianEntries(_q: Vec, row: number): SparseEntry[] {
    return [
      { row, col: this.px, val: 1 },
      { row, col: this.ax, val: -0.5 },
      { row, col: this.bx, val: -0.5 },
      { row: row + 1, col: this.py, val: 1 },
      { row: row + 1, col: this.ay, val: -0.5 },
      { row: row + 1, col: this.by, val: -0.5 },
    ];
  }
}

// ─── Line Constraints ──────────────────────────────────────────────

/** Horizontal: y1 = y2 */
export class HorizontalConstraint extends BaseConstraint {
  readonly type = 'horizontal' as const;
  readonly dof = 1;

  constructor(
    private y1: number, private y2: number,
    entityIds: string[], id?: string
  ) {
    super(entityIds, [], id);
  }

  evaluate(q: Vec): Vec {
    return [q[this.y1] - q[this.y2]];
  }

  jacobianEntries(_q: Vec, row: number): SparseEntry[] {
    return [
      { row, col: this.y1, val: 1 },
      { row, col: this.y2, val: -1 },
    ];
  }
}

/** Vertical: x1 = x2 */
export class VerticalConstraint extends BaseConstraint {
  readonly type = 'vertical' as const;
  readonly dof = 1;

  constructor(
    private x1: number, private x2: number,
    entityIds: string[], id?: string
  ) {
    super(entityIds, [], id);
  }

  evaluate(q: Vec): Vec {
    return [q[this.x1] - q[this.x2]];
  }

  jacobianEntries(_q: Vec, row: number): SparseEntry[] {
    return [
      { row, col: this.x1, val: 1 },
      { row, col: this.x2, val: -1 },
    ];
  }
}

/** Parallel: cross product of direction vectors = 0 */
export class ParallelConstraint extends BaseConstraint {
  readonly type = 'parallel' as const;
  readonly dof = 1;

  constructor(
    private ax1: number, private ay1: number,
    private ax2: number, private ay2: number,
    private bx1: number, private by1: number,
    private bx2: number, private by2: number,
    entityIds: string[], id?: string
  ) {
    super(entityIds, [], id);
  }

  evaluate(q: Vec): Vec {
    const dAx = q[this.ax2] - q[this.ax1], dAy = q[this.ay2] - q[this.ay1];
    const dBx = q[this.bx2] - q[this.bx1], dBy = q[this.by2] - q[this.by1];
    return [dAx * dBy - dAy * dBx];
  }

  jacobianEntries(q: Vec, row: number): SparseEntry[] {
    const dAx = q[this.ax2] - q[this.ax1], dAy = q[this.ay2] - q[this.ay1];
    const dBx = q[this.bx2] - q[this.bx1], dBy = q[this.by2] - q[this.by1];
    return [
      { row, col: this.ax1, val: -dBy },
      { row, col: this.ay1, val: dBx },
      { row, col: this.ax2, val: dBy },
      { row, col: this.ay2, val: -dBx },
      { row, col: this.bx1, val: dAy },
      { row, col: this.by1, val: -dAx },
      { row, col: this.bx2, val: -dAy },
      { row, col: this.by2, val: dAx },
    ];
  }
}

/** Perpendicular: dot product of direction vectors = 0 */
export class PerpendicularConstraint extends BaseConstraint {
  readonly type = 'perpendicular' as const;
  readonly dof = 1;

  constructor(
    private ax1: number, private ay1: number,
    private ax2: number, private ay2: number,
    private bx1: number, private by1: number,
    private bx2: number, private by2: number,
    entityIds: string[], id?: string
  ) {
    super(entityIds, [], id);
  }

  evaluate(q: Vec): Vec {
    const dAx = q[this.ax2] - q[this.ax1], dAy = q[this.ay2] - q[this.ay1];
    const dBx = q[this.bx2] - q[this.bx1], dBy = q[this.by2] - q[this.by1];
    return [dAx * dBx + dAy * dBy];
  }

  jacobianEntries(q: Vec, row: number): SparseEntry[] {
    const dAx = q[this.ax2] - q[this.ax1], dAy = q[this.ay2] - q[this.ay1];
    const dBx = q[this.bx2] - q[this.bx1], dBy = q[this.by2] - q[this.by1];
    return [
      { row, col: this.ax1, val: -dBx },
      { row, col: this.ay1, val: -dBy },
      { row, col: this.ax2, val: dBx },
      { row, col: this.ay2, val: dBy },
      { row, col: this.bx1, val: -dAx },
      { row, col: this.by1, val: -dAy },
      { row, col: this.bx2, val: dAx },
      { row, col: this.by2, val: dAy },
    ];
  }
}

/** Collinear: parallel + point B1 lies on line A (2 DOF removed) */
export class CollinearConstraint extends BaseConstraint {
  readonly type = 'collinear' as const;
  readonly dof = 2;

  private parallel: ParallelConstraint;
  private pointOnLine: PointOnLineConstraint;

  constructor(
    ax1: number, ay1: number,
    ax2: number, ay2: number,
    bx1: number, by1: number,
    bx2: number, by2: number,
    entityIds: string[], id?: string
  ) {
    super(entityIds, [], id);
    this.parallel = new ParallelConstraint(ax1, ay1, ax2, ay2, bx1, by1, bx2, by2, entityIds);
    this.pointOnLine = new PointOnLineConstraint(bx1, by1, ax1, ay1, ax2, ay2, entityIds);
  }

  evaluate(q: Vec): Vec {
    return [...this.parallel.evaluate(q), ...this.pointOnLine.evaluate(q)];
  }

  jacobianEntries(q: Vec, row: number): SparseEntry[] {
    return [
      ...this.parallel.jacobianEntries(q, row),
      ...this.pointOnLine.jacobianEntries(q, row + 1),
    ];
  }
}

/** Equal Length: |AB|^2 - |CD|^2 = 0 */
export class EqualLengthConstraint extends BaseConstraint {
  readonly type = 'equalLength' as const;
  readonly dof = 1;

  constructor(
    private ax1: number, private ay1: number,
    private ax2: number, private ay2: number,
    private bx1: number, private by1: number,
    private bx2: number, private by2: number,
    entityIds: string[], id?: string
  ) {
    super(entityIds, [], id);
  }

  evaluate(q: Vec): Vec {
    const dAx = q[this.ax2] - q[this.ax1], dAy = q[this.ay2] - q[this.ay1];
    const dBx = q[this.bx2] - q[this.bx1], dBy = q[this.by2] - q[this.by1];
    return [dAx * dAx + dAy * dAy - dBx * dBx - dBy * dBy];
  }

  jacobianEntries(q: Vec, row: number): SparseEntry[] {
    const dAx = q[this.ax2] - q[this.ax1], dAy = q[this.ay2] - q[this.ay1];
    const dBx = q[this.bx2] - q[this.bx1], dBy = q[this.by2] - q[this.by1];
    return [
      { row, col: this.ax1, val: -2 * dAx },
      { row, col: this.ay1, val: -2 * dAy },
      { row, col: this.ax2, val: 2 * dAx },
      { row, col: this.ay2, val: 2 * dAy },
      { row, col: this.bx1, val: 2 * dBx },
      { row, col: this.by1, val: 2 * dBy },
      { row, col: this.bx2, val: -2 * dBx },
      { row, col: this.by2, val: -2 * dBy },
    ];
  }
}

/** Fixed Length: (x2-x1)^2 + (y2-y1)^2 - L^2 = 0 */
export class FixedLengthConstraint extends BaseConstraint {
  readonly type = 'fixedLength' as const;
  readonly dof = 1;

  constructor(
    private x1: number, private y1: number,
    private x2: number, private y2: number,
    private length: number,
    entityIds: string[], id?: string
  ) {
    super(entityIds, [length], id);
  }

  evaluate(q: Vec): Vec {
    const dx = q[this.x2] - q[this.x1], dy = q[this.y2] - q[this.y1];
    return [dx * dx + dy * dy - this.length * this.length];
  }

  jacobianEntries(q: Vec, row: number): SparseEntry[] {
    const dx = q[this.x2] - q[this.x1], dy = q[this.y2] - q[this.y1];
    return [
      { row, col: this.x1, val: -2 * dx },
      { row, col: this.y1, val: -2 * dy },
      { row, col: this.x2, val: 2 * dx },
      { row, col: this.y2, val: 2 * dy },
    ];
  }

  setParams(params: number[]): void {
    super.setParams(params);
    this.length = params[0];
  }
}

/** Fixed Angle: angle of line from +X axis = theta. Uses: (x2-x1)sin(θ) - (y2-y1)cos(θ) = 0 */
export class FixedAngleConstraint extends BaseConstraint {
  readonly type = 'fixedAngle' as const;
  readonly dof = 1;
  private sinT: number;
  private cosT: number;

  constructor(
    private x1: number, private y1: number,
    private x2: number, private y2: number,
    private theta: number,
    entityIds: string[], id?: string
  ) {
    super(entityIds, [theta], id);
    this.sinT = Math.sin(theta);
    this.cosT = Math.cos(theta);
  }

  evaluate(q: Vec): Vec {
    const dx = q[this.x2] - q[this.x1], dy = q[this.y2] - q[this.y1];
    return [dx * this.sinT - dy * this.cosT];
  }

  jacobianEntries(_q: Vec, row: number): SparseEntry[] {
    return [
      { row, col: this.x1, val: -this.sinT },
      { row, col: this.y1, val: this.cosT },
      { row, col: this.x2, val: this.sinT },
      { row, col: this.y2, val: -this.cosT },
    ];
  }

  setParams(params: number[]): void {
    super.setParams(params);
    this.theta = params[0];
    this.sinT = Math.sin(this.theta);
    this.cosT = Math.cos(this.theta);
  }
}

/** Angle Between two lines: dA x dB - |dA||dB| sin(phi) = 0 */
export class AngleBetweenConstraint extends BaseConstraint {
  readonly type = 'angleBetween' as const;
  readonly dof = 1;

  constructor(
    private ax1: number, private ay1: number,
    private ax2: number, private ay2: number,
    private bx1: number, private by1: number,
    private bx2: number, private by2: number,
    private phi: number,
    entityIds: string[], id?: string
  ) {
    super(entityIds, [phi], id);
  }

  evaluate(q: Vec): Vec {
    const dAx = q[this.ax2] - q[this.ax1], dAy = q[this.ay2] - q[this.ay1];
    const dBx = q[this.bx2] - q[this.bx1], dBy = q[this.by2] - q[this.by1];
    const cross = dAx * dBy - dAy * dBx;
    const dot = dAx * dBx + dAy * dBy;
    // Use atan2 form for robustness
    const actualAngle = Math.atan2(cross, dot);
    let diff = actualAngle - this.phi;
    // Normalize to [-pi, pi]
    while (diff > Math.PI) diff -= 2 * Math.PI;
    while (diff < -Math.PI) diff += 2 * Math.PI;
    return [diff];
  }

  jacobianEntries(q: Vec, row: number): SparseEntry[] {
    const dAx = q[this.ax2] - q[this.ax1], dAy = q[this.ay2] - q[this.ay1];
    const dBx = q[this.bx2] - q[this.bx1], dBy = q[this.by2] - q[this.by1];
    const cross = dAx * dBy - dAy * dBx;
    const dot = dAx * dBx + dAy * dBy;
    const denom = cross * cross + dot * dot;
    if (denom < 1e-20) return [];

    // d(atan2(cross, dot))/d(var) = (dot * d(cross)/d(var) - cross * d(dot)/d(var)) / denom
    // d(cross)/d(ax1) = -dBy, d(cross)/d(ay1) = dBx, etc.
    const entries: SparseEntry[] = [];
    const addEntry = (col: number, dCross: number, dDot: number) => {
      const val = (dot * dCross - cross * dDot) / denom;
      if (Math.abs(val) > 1e-20) entries.push({ row, col, val });
    };

    addEntry(this.ax1, -dBy, -dBx);
    addEntry(this.ay1, dBx, -dBy);
    addEntry(this.ax2, dBy, dBx);
    addEntry(this.ay2, -dBx, dBy);
    addEntry(this.bx1, dAy, -dAx);
    addEntry(this.by1, -dAx, -dAy);
    addEntry(this.bx2, -dAy, dAx);
    addEntry(this.by2, dAx, dAy);

    return entries;
  }

  setParams(params: number[]): void {
    super.setParams(params);
    this.phi = params[0];
  }
}

/** Symmetric: point A is mirror of B about line L */
export class SymmetricConstraint extends BaseConstraint {
  readonly type = 'symmetric' as const;
  readonly dof = 2;

  constructor(
    private pax: number, private pay: number,
    private pbx: number, private pby: number,
    private lx1: number, private ly1: number,
    private lx2: number, private ly2: number,
    entityIds: string[], id?: string
  ) {
    super(entityIds, [], id);
  }

  evaluate(q: Vec): Vec {
    // Midpoint M = (A+B)/2 lies on line L
    const mx = (q[this.pax] + q[this.pbx]) / 2;
    const my = (q[this.pay] + q[this.pby]) / 2;
    const ldx = q[this.lx2] - q[this.lx1];
    const ldy = q[this.ly2] - q[this.ly1];
    // Midpoint on line: (M - L1) x (L2 - L1) = 0
    const c1 = (mx - q[this.lx1]) * ldy - (my - q[this.ly1]) * ldx;
    // AB perpendicular to L: (A-B) . (L2-L1) = 0
    const abx = q[this.pax] - q[this.pbx];
    const aby = q[this.pay] - q[this.pby];
    const c2 = abx * ldx + aby * ldy;
    return [c1, c2];
  }

  jacobianEntries(q: Vec, row: number): SparseEntry[] {
    const ldx = q[this.lx2] - q[this.lx1];
    const ldy = q[this.ly2] - q[this.ly1];
    const mx = (q[this.pax] + q[this.pbx]) / 2;
    const my = (q[this.pay] + q[this.pby]) / 2;
    const abx = q[this.pax] - q[this.pbx];
    const aby = q[this.pay] - q[this.pby];

    return [
      // Row 1: midpoint-on-line
      { row, col: this.pax, val: ldy / 2 },
      { row, col: this.pay, val: -ldx / 2 },
      { row, col: this.pbx, val: ldy / 2 },
      { row, col: this.pby, val: -ldx / 2 },
      { row, col: this.lx1, val: -ldy + (my - q[this.ly1]) },
      { row, col: this.ly1, val: ldx - (mx - q[this.lx1]) },
      { row, col: this.lx2, val: -(my - q[this.ly1]) },
      { row, col: this.ly2, val: mx - q[this.lx1] },
      // Row 2: perpendicularity
      { row: row + 1, col: this.pax, val: ldx },
      { row: row + 1, col: this.pay, val: ldy },
      { row: row + 1, col: this.pbx, val: -ldx },
      { row: row + 1, col: this.pby, val: -ldy },
      { row: row + 1, col: this.lx1, val: -abx },
      { row: row + 1, col: this.ly1, val: -aby },
      { row: row + 1, col: this.lx2, val: abx },
      { row: row + 1, col: this.ly2, val: aby },
    ];
  }
}

// ─── Circle / Arc Constraints ──────────────────────────────────────

/** Equal Radius: r_a - r_b = 0 */
export class EqualRadiusConstraint extends BaseConstraint {
  readonly type = 'equalRadius' as const;
  readonly dof = 1;

  constructor(
    private ra: number, private rb: number,
    entityIds: string[], id?: string
  ) {
    super(entityIds, [], id);
  }

  evaluate(q: Vec): Vec {
    return [q[this.ra] - q[this.rb]];
  }

  jacobianEntries(_q: Vec, row: number): SparseEntry[] {
    return [
      { row, col: this.ra, val: 1 },
      { row, col: this.rb, val: -1 },
    ];
  }
}

/** Fixed Radius: r - R_target = 0 */
export class FixedRadiusConstraint extends BaseConstraint {
  readonly type = 'fixedRadius' as const;
  readonly dof = 1;

  constructor(
    private ri: number, private target: number,
    entityIds: string[], id?: string
  ) {
    super(entityIds, [target], id);
  }

  evaluate(q: Vec): Vec {
    return [q[this.ri] - this.target];
  }

  jacobianEntries(_q: Vec, row: number): SparseEntry[] {
    return [{ row, col: this.ri, val: 1 }];
  }

  setParams(params: number[]): void {
    super.setParams(params);
    this.target = params[0];
  }
}

/** Concentric: centers coincide */
export class ConcentricConstraint extends BaseConstraint {
  readonly type = 'concentric' as const;
  readonly dof = 2;

  constructor(
    private cx_a: number, private cy_a: number,
    private cx_b: number, private cy_b: number,
    entityIds: string[], id?: string
  ) {
    super(entityIds, [], id);
  }

  evaluate(q: Vec): Vec {
    return [q[this.cx_a] - q[this.cx_b], q[this.cy_a] - q[this.cy_b]];
  }

  jacobianEntries(_q: Vec, row: number): SparseEntry[] {
    return [
      { row, col: this.cx_a, val: 1 },
      { row, col: this.cx_b, val: -1 },
      { row: row + 1, col: this.cy_a, val: 1 },
      { row: row + 1, col: this.cy_b, val: -1 },
    ];
  }
}

/** Tangent Line-Circle: signed distance from centre to line = r (squared form) */
export class TangentLineCircleConstraint extends BaseConstraint {
  readonly type = 'tangentLineCircle' as const;
  readonly dof = 1;

  constructor(
    private cx: number, private cy: number, private ri: number,
    private lx1: number, private ly1: number,
    private lx2: number, private ly2: number,
    entityIds: string[], id?: string
  ) {
    super(entityIds, [], id);
  }

  evaluate(q: Vec): Vec {
    const Cx = q[this.cx], Cy = q[this.cy], r = q[this.ri];
    const x1 = q[this.lx1], y1 = q[this.ly1];
    const x2 = q[this.lx2], y2 = q[this.ly2];
    const dx = x2 - x1, dy = y2 - y1;
    const cross = (Cx - x1) * dy - (Cy - y1) * dx;
    const len2 = dx * dx + dy * dy;
    if (len2 < 1e-20) return [0];
    return [cross * cross / len2 - r * r];
  }

  jacobianEntries(q: Vec, row: number): SparseEntry[] {
    const Cx = q[this.cx], Cy = q[this.cy], r = q[this.ri];
    const x1 = q[this.lx1], y1 = q[this.ly1];
    const x2 = q[this.lx2], y2 = q[this.ly2];
    const dx = x2 - x1, dy = y2 - y1;
    const len2 = dx * dx + dy * dy;
    if (len2 < 1e-20) return [];
    const cross = (Cx - x1) * dy - (Cy - y1) * dx;
    const k = 2 * cross / len2;

    // Partials of cross: dC/dCx=dy, dC/dCy=-dx, dC/dx1=-dy+(Cy-y1) hmm
    // Actually: cross = (Cx-x1)*dy - (Cy-y1)*dx
    // d(cross)/dCx = dy
    // d(cross)/dCy = -dx
    // d(cross)/dx1 = -dy  (from -(Cx-x1) deriv w.r.t. x1 part = 0, and +(Cy-y1) term: -(Cy-y1)*(-1)=0... )
    // Wait: cross = (Cx-x1)(y2-y1) - (Cy-y1)(x2-x1)
    // d(cross)/dx1 = -(y2-y1) + (Cy-y1) = -dy + (Cy-y1)
    // d(cross)/dy1 = (Cx-x1) + (x2-x1)  ... wait: -(Cx-x1)*(-1) from d(y2-y1)/dy1 + (Cy-y1) from d/dy1...
    // Actually let me be careful:
    // cross = (Cx-x1)*dy - (Cy-y1)*dx
    //   where dx=x2-x1, dy=y2-y1
    // d(cross)/dx1 = -dy - (Cy-y1)*(-1) = -dy + (Cy-y1)
    // d(cross)/dy1 = (Cx-x1)*(-1) - (-dx) = -(Cx-x1) + dx = x2 - Cx
    // d(cross)/dx2 = -(Cy-y1)
    // d(cross)/dy2 = (Cx-x1)
    //
    // For len2 = dx^2 + dy^2:
    // d(len2)/dx1 = -2*dx, d(len2)/dy1 = -2*dy, d(len2)/dx2 = 2*dx, d(len2)/dy2 = 2*dy
    //
    // C = cross^2/len2 - r^2
    // dC/dvar = (2*cross*d(cross)/dvar * len2 - cross^2 * d(len2)/dvar) / len2^2

    const cross2 = cross * cross;
    const len4 = len2 * len2;

    const dcross_dCx = dy;
    const dcross_dCy = -dx;
    const dcross_dx1 = -dy + (Cy - y1);
    const dcross_dy1 = -(Cx - x1) + dx;
    const dcross_dx2 = -(Cy - y1);
    const dcross_dy2 = (Cx - x1);

    const dlen2_dx1 = -2 * dx;
    const dlen2_dy1 = -2 * dy;
    const dlen2_dx2 = 2 * dx;
    const dlen2_dy2 = 2 * dy;

    const dCdvar = (dc: number, dl: number) =>
      (2 * cross * dc * len2 - cross2 * dl) / len4;

    return [
      { row, col: this.cx, val: k * dy }, // = 2*cross*dy/len2
      { row, col: this.cy, val: -k * dx },
      { row, col: this.ri, val: -2 * r },
      { row, col: this.lx1, val: dCdvar(dcross_dx1, dlen2_dx1) },
      { row, col: this.ly1, val: dCdvar(dcross_dy1, dlen2_dy1) },
      { row, col: this.lx2, val: dCdvar(dcross_dx2, dlen2_dx2) },
      { row, col: this.ly2, val: dCdvar(dcross_dy2, dlen2_dy2) },
    ];
  }
}

/** Tangent Circle-Circle (external): dist^2 = (r1+r2)^2 */
export class TangentCircleCircleConstraint extends BaseConstraint {
  readonly type = 'tangentCircleCircle' as const;
  readonly dof = 1;
  private internal: boolean;

  constructor(
    private cx_a: number, private cy_a: number, private ra: number,
    private cx_b: number, private cy_b: number, private rb: number,
    entityIds: string[],
    internal = false,
    id?: string
  ) {
    super(entityIds, [], id);
    this.internal = internal;
  }

  evaluate(q: Vec): Vec {
    const dx = q[this.cx_a] - q[this.cx_b];
    const dy = q[this.cy_a] - q[this.cy_b];
    const rsum = this.internal
      ? q[this.ra] - q[this.rb]
      : q[this.ra] + q[this.rb];
    return [dx * dx + dy * dy - rsum * rsum];
  }

  jacobianEntries(q: Vec, row: number): SparseEntry[] {
    const dx = q[this.cx_a] - q[this.cx_b];
    const dy = q[this.cy_a] - q[this.cy_b];
    const rsum = this.internal
      ? q[this.ra] - q[this.rb]
      : q[this.ra] + q[this.rb];
    const sign_b = this.internal ? -1 : 1;
    return [
      { row, col: this.cx_a, val: 2 * dx },
      { row, col: this.cy_a, val: 2 * dy },
      { row, col: this.cx_b, val: -2 * dx },
      { row, col: this.cy_b, val: -2 * dy },
      { row, col: this.ra, val: -2 * rsum },
      { row, col: this.rb, val: -2 * rsum * sign_b },
    ];
  }
}

// ─── Dimensional Constraints ───────────────────────────────────────

/** Horizontal distance: x2 - x1 - d = 0 */
export class HorizontalDistConstraint extends BaseConstraint {
  readonly type = 'horizontalDist' as const;
  readonly dof = 1;

  constructor(
    private x1: number, private x2: number,
    private dist: number,
    entityIds: string[], id?: string
  ) {
    super(entityIds, [dist], id);
  }

  evaluate(q: Vec): Vec {
    return [q[this.x2] - q[this.x1] - this.dist];
  }

  jacobianEntries(_q: Vec, row: number): SparseEntry[] {
    return [
      { row, col: this.x1, val: -1 },
      { row, col: this.x2, val: 1 },
    ];
  }

  setParams(params: number[]): void {
    super.setParams(params);
    this.dist = params[0];
  }
}

/** Vertical distance: y2 - y1 - d = 0 */
export class VerticalDistConstraint extends BaseConstraint {
  readonly type = 'verticalDist' as const;
  readonly dof = 1;

  constructor(
    private y1: number, private y2: number,
    private dist: number,
    entityIds: string[], id?: string
  ) {
    super(entityIds, [dist], id);
  }

  evaluate(q: Vec): Vec {
    return [q[this.y2] - q[this.y1] - this.dist];
  }

  jacobianEntries(_q: Vec, row: number): SparseEntry[] {
    return [
      { row, col: this.y1, val: -1 },
      { row, col: this.y2, val: 1 },
    ];
  }

  setParams(params: number[]): void {
    super.setParams(params);
    this.dist = params[0];
  }
}

/**
 * Perpendicular distance from a point to a line.
 *
 * Enforces signed distance = d where
 *   cross = (px - x1)(y2 - y1) - (py - y1)(x2 - x1)
 *   |L|   = sqrt((x2 - x1)^2 + (y2 - y1)^2)
 *   C     = cross - d * |L|
 *
 * i.e. cross / |L| = d. The sign of d distinguishes which side of the
 * line the point lies on. Combining this with a Parallel constraint
 * makes two lines stay a fixed perpendicular distance apart.
 */
export class PerpDistanceConstraint extends BaseConstraint {
  readonly type = 'perpDistance' as const;
  readonly dof = 1;

  constructor(
    private px: number, private py: number,
    private x1: number, private y1: number,
    private x2: number, private y2: number,
    private dist: number,
    entityIds: string[], id?: string
  ) {
    super(entityIds, [dist], id);
  }

  evaluate(q: Vec): Vec {
    const px = q[this.px], py = q[this.py];
    const x1 = q[this.x1], y1 = q[this.y1];
    const x2 = q[this.x2], y2 = q[this.y2];
    const dx = x2 - x1, dy = y2 - y1;
    const len2 = dx * dx + dy * dy;
    if (len2 < 1e-20) return [0];
    const len = Math.sqrt(len2);
    const cross = (px - x1) * dy - (py - y1) * dx;
    return [cross - this.dist * len];
  }

  jacobianEntries(q: Vec, row: number): SparseEntry[] {
    const px = q[this.px], py = q[this.py];
    const x1 = q[this.x1], y1 = q[this.y1];
    const x2 = q[this.x2], y2 = q[this.y2];
    const dx = x2 - x1, dy = y2 - y1;
    const len2 = dx * dx + dy * dy;
    if (len2 < 1e-20) return [];
    const len = Math.sqrt(len2);
    const d = this.dist;

    // C = cross - d*|L|
    // ∂cross/∂var:
    //   ∂/∂px = dy
    //   ∂/∂py = -dx
    //   ∂/∂x1 = py - y2
    //   ∂/∂y1 = x2 - px
    //   ∂/∂x2 = y1 - py
    //   ∂/∂y2 = px - x1
    // ∂|L|/∂var (px,py are 0):
    //   ∂/∂x1 = -dx/|L|,  ∂/∂y1 = -dy/|L|
    //   ∂/∂x2 =  dx/|L|,  ∂/∂y2 =  dy/|L|

    return [
      { row, col: this.px, val: dy },
      { row, col: this.py, val: -dx },
      { row, col: this.x1, val: (py - y2) - d * (-dx / len) },
      { row, col: this.y1, val: (x2 - px) - d * (-dy / len) },
      { row, col: this.x2, val: (y1 - py) - d * (dx / len) },
      { row, col: this.y2, val: (px - x1) - d * (dy / len) },
    ];
  }

  setParams(params: number[]): void {
    super.setParams(params);
    this.dist = params[0];
  }
}

/** Point on Ellipse: rotated-distance formula = 1 */
export class PointOnEllipseConstraint extends BaseConstraint {
  readonly type = 'pointOnEllipse' as const;
  readonly dof = 1;

  constructor(
    private px: number, private py: number,
    private ecx: number, private ecy: number,
    private erx: number, private ery: number,
    private eangle: number,
    entityIds: string[], id?: string
  ) {
    super(entityIds, [], id);
  }

  evaluate(q: Vec): Vec {
    const dx = q[this.px] - q[this.ecx];
    const dy = q[this.py] - q[this.ecy];
    const cosA = Math.cos(q[this.eangle]);
    const sinA = Math.sin(q[this.eangle]);
    const u = dx * cosA + dy * sinA;
    const v = dy * cosA - dx * sinA;
    const rx = q[this.erx], ry = q[this.ery];
    return [(u * u) / (rx * rx) + (v * v) / (ry * ry) - 1];
  }

  jacobianEntries(q: Vec, row: number): SparseEntry[] {
    const dx = q[this.px] - q[this.ecx];
    const dy = q[this.py] - q[this.ecy];
    const angle = q[this.eangle];
    const cosA = Math.cos(angle);
    const sinA = Math.sin(angle);
    const u = dx * cosA + dy * sinA;
    const v = dy * cosA - dx * sinA;
    const rx = q[this.erx], ry = q[this.ery];
    const rx2 = rx * rx, ry2 = ry * ry;

    const du_dpx = cosA, du_dpy = sinA;
    const dv_dpx = -sinA, dv_dpy = cosA;

    const dC_du = 2 * u / rx2;
    const dC_dv = 2 * v / ry2;

    const entries: SparseEntry[] = [
      { row, col: this.px, val: dC_du * du_dpx + dC_dv * dv_dpx },
      { row, col: this.py, val: dC_du * du_dpy + dC_dv * dv_dpy },
      { row, col: this.ecx, val: -(dC_du * du_dpx + dC_dv * dv_dpx) },
      { row, col: this.ecy, val: -(dC_du * du_dpy + dC_dv * dv_dpy) },
      { row, col: this.erx, val: -2 * u * u / (rx * rx2) },
      { row, col: this.ery, val: -2 * v * v / (ry * ry2) },
    ];

    // d/d(angle)
    const du_da = -dx * sinA + dy * cosA; // = v
    const dv_da = -dy * sinA - dx * cosA; // = -u
    entries.push({ row, col: this.eangle, val: dC_du * du_da + dC_dv * dv_da });

    return entries;
  }
}

// ─── Internal: Arc Endpoint Coupling ───────────────────────────────

/**
 * Couples an arc's explicit start/end endpoint variables to its canonical
 * (center, radius, theta_start, theta_end) parameterization:
 *
 *   sx = cx + r·cos(θs)
 *   sy = cy + r·sin(θs)
 *   ex = cx + r·cos(θe)
 *   ey = cy + r·sin(θe)
 *
 * Added automatically when an arc entity is created, so the endpoint
 * variables can be used like line endpoints for constraints and dragging.
 * Net DOF contribution: -4 (balancing the 4 extra endpoint variables),
 * keeping the arc at 5 effective DOF.
 */
export class ArcEndpointCouplingConstraint extends BaseConstraint {
  readonly type = 'arcEndpointCoupling' as const;
  readonly dof = 4;

  constructor(
    private cxi: number, private cyi: number,
    private ri: number,
    private tsi: number, private tei: number,
    private sxi: number, private syi: number,
    private exi: number, private eyi: number,
    entityIds: string[], id?: string
  ) {
    super(entityIds, [], id);
  }

  evaluate(q: Vec): Vec {
    const cx = q[this.cxi], cy = q[this.cyi];
    const r = q[this.ri];
    const ts = q[this.tsi], te = q[this.tei];
    const sx = q[this.sxi], sy = q[this.syi];
    const ex = q[this.exi], ey = q[this.eyi];
    return [
      sx - cx - r * Math.cos(ts),
      sy - cy - r * Math.sin(ts),
      ex - cx - r * Math.cos(te),
      ey - cy - r * Math.sin(te),
    ];
  }

  jacobianEntries(q: Vec, row: number): SparseEntry[] {
    const r = q[this.ri];
    const ts = q[this.tsi], te = q[this.tei];
    const cts = Math.cos(ts), sts = Math.sin(ts);
    const cte = Math.cos(te), ste = Math.sin(te);
    return [
      // Row 0: sx - cx - r*cos(ts)
      { row, col: this.sxi, val: 1 },
      { row, col: this.cxi, val: -1 },
      { row, col: this.ri, val: -cts },
      { row, col: this.tsi, val: r * sts },
      // Row 1: sy - cy - r*sin(ts)
      { row: row + 1, col: this.syi, val: 1 },
      { row: row + 1, col: this.cyi, val: -1 },
      { row: row + 1, col: this.ri, val: -sts },
      { row: row + 1, col: this.tsi, val: -r * cts },
      // Row 2: ex - cx - r*cos(te)
      { row: row + 2, col: this.exi, val: 1 },
      { row: row + 2, col: this.cxi, val: -1 },
      { row: row + 2, col: this.ri, val: -cte },
      { row: row + 2, col: this.tei, val: r * ste },
      // Row 3: ey - cy - r*sin(te)
      { row: row + 3, col: this.eyi, val: 1 },
      { row: row + 3, col: this.cyi, val: -1 },
      { row: row + 3, col: this.ri, val: -ste },
      { row: row + 3, col: this.tei, val: -r * cte },
    ];
  }
}
