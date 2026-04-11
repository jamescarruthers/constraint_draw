/** Global coordinate vector type */
export type Vec = number[];

/** A single non-zero entry in a sparse matrix */
export interface SparseEntry {
  row: number;
  col: number;
  val: number;
}

/** Sparse matrix in COO format, convertible to dense */
export class SparseMatrix {
  entries: SparseEntry[] = [];
  rows: number;
  cols: number;

  constructor(rows: number, cols: number) {
    this.rows = rows;
    this.cols = cols;
  }

  add(r: number, c: number, v: number): void {
    if (v !== 0) {
      this.entries.push({ row: r, col: c, val: v });
    }
  }

  toDense(): number[][] {
    const A = Array.from({ length: this.rows }, () => new Array(this.cols).fill(0));
    for (const { row, col, val } of this.entries) {
      A[row][col] += val;
    }
    return A;
  }
}

/** Result of a solver run */
export interface SolveResult {
  status: 'converged' | 'failed';
  iterations: number;
  q: Vec;
  residualNorm: number;
}

/** Entity type enum */
export type EntityType = 'point' | 'line' | 'arc' | 'circle' | 'ellipse';

/** Constraint type enum */
export type ConstraintType =
  | 'coincident'
  | 'fixed'
  | 'pointOnLine'
  | 'pointOnCircle'
  | 'pointOnArc'
  | 'midpoint'
  | 'pointOnEllipse'
  | 'horizontal'
  | 'vertical'
  | 'parallel'
  | 'perpendicular'
  | 'collinear'
  | 'equalLength'
  | 'fixedLength'
  | 'fixedAngle'
  | 'angleBetween'
  | 'symmetric'
  | 'equalRadius'
  | 'fixedRadius'
  | 'concentric'
  | 'tangentLineCircle'
  | 'tangentCircleCircle'
  | 'horizontalDist'
  | 'verticalDist'
  | 'perpDistance'
  /** Internal: couples an arc's endpoint vars to its (cx,cy,r,θs,θe) params */
  | 'arcEndpointCoupling';

/** Solver states */
export type SolverState = 'idle' | 'dirty' | 'solving' | 'solved' | 'conflict' | 'dragging';

/** DOF classification */
export type DOFState = 'under-constrained' | 'fully-constrained' | 'over-constrained';

/** Conflict report from DOF analysis */
export interface ConflictReport {
  rank: number;
  totalConstraintRows: number;
  redundantConstraintIds: string[];
}
