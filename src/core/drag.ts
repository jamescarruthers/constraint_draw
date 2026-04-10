import { BaseConstraint } from './constraint';
import { NRSolver } from './solver';
import { Vec } from './types';

/**
 * BDF-2 DAE drag integrator.
 * Integrates the mass-damper system under constraints using BDF-2 time stepping
 * with constraint projection.
 */
export class DragIntegrator {
  private h = 1 / 60;
  private mass = 1.0;
  private damping = 50.0;
  private kSpring = 1e4;

  /** Two previous states for BDF-2 */
  private q0: Vec = [];
  private q1: Vec = [];
  private stepCount = 0;

  /** Initialize with current state */
  init(q: Vec): void {
    this.q0 = [...q];
    this.q1 = [...q];
    this.stepCount = 0;
  }

  /**
   * Advance one timestep.
   * @param q Current state
   * @param constraints Active constraints
   * @param fixed Fixed variable indices
   * @param grabVars [xi, yi] indices of grabbed point in q
   * @param cursor [cx, cy] cursor world position
   * @returns Updated q vector
   */
  step(
    q: Vec,
    constraints: BaseConstraint[],
    fixed: Set<number>,
    grabVars: [number, number],
    cursor: [number, number]
  ): Vec {
    const h = this.h;
    const n = q.length;

    // External force: drag spring on grabbed point
    const Fext = new Array(n).fill(0);
    Fext[grabVars[0]] = this.kSpring * (cursor[0] - q[grabVars[0]]);
    Fext[grabVars[1]] = this.kSpring * (cursor[1] - q[grabVars[1]]);

    this.stepCount++;

    let qPred: Vec;

    if (this.stepCount <= 1) {
      // BDF-1 (backward Euler) for startup
      // q_dot ≈ (q_new - q0) / h
      // M * q_ddot + D * q_dot = Fext
      // Approximate: predict with explicit Euler + force
      qPred = q.map((qi, i) => {
        const qdot = (qi - this.q0[i]) / h;
        const qddot = (Fext[i] - this.damping * qdot) / this.mass;
        return qi + h * qdot + 0.5 * h * h * qddot;
      });
    } else {
      // BDF-2: q_dot ≈ (3q - 4q0 + q1) / (2h)
      qPred = q.map((qi, i) => {
        const qdot = (3 * qi - 4 * this.q0[i] + this.q1[i]) / (2 * h);
        const qddot = (Fext[i] - this.damping * qdot) / this.mass;
        return qi + h * qdot + 0.5 * h * h * qddot;
      });
    }

    // Project back onto constraint manifold using NR
    const solver = new NRSolver();
    const result = solver.solve(qPred, constraints, fixed);

    // Update history
    this.q1 = [...this.q0];
    this.q0 = [...q];

    return result.q;
  }

  /**
   * Simple Baumgarte-style position projection (alternative to full BDF-2).
   * Moves grabbed point toward cursor, then projects onto constraint manifold.
   */
  stepSimple(
    q: Vec,
    constraints: BaseConstraint[],
    fixed: Set<number>,
    grabVars: [number, number],
    cursor: [number, number],
    alpha = 0.3
  ): Vec {
    const qNew = [...q];

    // Move grabbed point toward cursor with damping
    qNew[grabVars[0]] += alpha * (cursor[0] - q[grabVars[0]]);
    qNew[grabVars[1]] += alpha * (cursor[1] - q[grabVars[1]]);

    // Project onto constraint manifold
    const solver = new NRSolver();
    const result = solver.solve(qNew, constraints, fixed);

    return result.q;
  }
}
