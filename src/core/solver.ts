import { BaseConstraint } from './constraint';
import { solveLinearSystem, vecNorm } from './linalg';
import { SparseMatrix, SolveResult, Vec } from './types';

/**
 * Newton-Raphson static constraint solver.
 * Solves C(q) = 0 for the free variables in q.
 */
export class NRSolver {
  private readonly TOL = 1e-10;
  private readonly MAX_ITER = 50;
  private readonly ARMIJO_C = 0.01;
  private readonly MIN_ALPHA = 1e-10;

  solve(q: Vec, constraints: BaseConstraint[], fixed: Set<number>): SolveResult {
    if (constraints.length === 0) {
      return { status: 'converged', iterations: 0, q: [...q], residualNorm: 0 };
    }

    const free = q.map((_, i) => i).filter(i => !fixed.has(i));
    const n = free.length;
    const m = constraints.reduce((s, c) => s + c.dof, 0);

    if (n === 0) {
      const c = this.assembleResidual(q, constraints);
      return {
        status: vecNorm(c) < this.TOL ? 'converged' : 'failed',
        iterations: 0,
        q: [...q],
        residualNorm: vecNorm(c),
      };
    }

    const qWork = [...q];

    for (let iter = 0; iter < this.MAX_ITER; iter++) {
      const c = this.assembleResidual(qWork, constraints);
      const norm = vecNorm(c);

      if (norm < this.TOL) {
        return { status: 'converged', iterations: iter, q: qWork, residualNorm: norm };
      }

      const J = this.assembleJacobian(qWork, constraints, free);
      const Jd = J.toDense();
      const negC = c.map(v => -v);

      const dqFree = solveLinearSystem(Jd, negC, m, n);
      if (!dqFree) {
        return { status: 'failed', iterations: iter, q: qWork, residualNorm: norm };
      }

      // Backtracking line search (Armijo condition)
      let alpha = 1.0;
      const qTry = [...qWork];

      while (alpha > this.MIN_ALPHA) {
        for (let fi = 0; fi < n; fi++) {
          qTry[free[fi]] = qWork[free[fi]] + alpha * dqFree[fi];
        }
        const cTry = this.assembleResidual(qTry, constraints);
        const normTry = vecNorm(cTry);

        if (normTry <= norm * (1 - this.ARMIJO_C * alpha)) {
          break;
        }
        // Also accept if we made progress (even if Armijo not satisfied strictly)
        if (normTry < norm * 0.999 && alpha <= 0.25) {
          break;
        }
        alpha *= 0.5;
      }

      if (alpha <= this.MIN_ALPHA) {
        // Try full step anyway if residual decreased
        for (let fi = 0; fi < n; fi++) {
          qTry[free[fi]] = qWork[free[fi]] + dqFree[fi];
        }
        const cFull = this.assembleResidual(qTry, constraints);
        if (vecNorm(cFull) < norm) {
          for (let fi = 0; fi < n; fi++) {
            qWork[free[fi]] = qTry[free[fi]];
          }
          continue;
        }
        return { status: 'failed', iterations: iter, q: qWork, residualNorm: norm };
      }

      for (let fi = 0; fi < n; fi++) {
        qWork[free[fi]] += alpha * dqFree[fi];
      }
    }

    const finalResidual = vecNorm(this.assembleResidual(qWork, constraints));
    return {
      status: finalResidual < this.TOL * 100 ? 'converged' : 'failed',
      iterations: this.MAX_ITER,
      q: qWork,
      residualNorm: finalResidual,
    };
  }

  assembleResidual(q: Vec, constraints: BaseConstraint[]): Vec {
    const result: number[] = [];
    for (const c of constraints) {
      result.push(...c.evaluate(q));
    }
    return result;
  }

  private assembleJacobian(
    q: Vec,
    constraints: BaseConstraint[],
    free: number[]
  ): SparseMatrix {
    const freeMap = new Map(free.map((gi, li) => [gi, li]));
    const m = constraints.reduce((s, c) => s + c.dof, 0);
    const n = free.length;
    const J = new SparseMatrix(m, n);

    let rowOff = 0;
    for (const c of constraints) {
      for (const e of c.jacobianEntries(q, rowOff)) {
        const col = freeMap.get(e.col);
        if (col !== undefined) {
          J.add(e.row, col, e.val);
        }
      }
      rowOff += c.dof;
    }
    return J;
  }
}
