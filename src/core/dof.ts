import { BaseConstraint } from './constraint';
import { matrixRank } from './linalg';
import { Entity, ENTITY_DOF } from './entity';
import { ConflictReport, DOFState, SparseMatrix, Vec } from './types';

/**
 * DOF analysis: counts free degrees of freedom, detects over/under-constrained states,
 * and identifies conflicting constraints.
 */
export class DOFAnalyser {
  /**
   * Compute total DOF = sum(entity_dof) - sum(constraint_dof) - fixed_vars
   */
  computeDOF(
    entities: Entity[],
    constraints: BaseConstraint[],
    fixedVars: Set<number>
  ): number {
    const entityDOF = entities.reduce((s, e) => s + ENTITY_DOF[e.type], 0);
    const constraintDOF = constraints.reduce((s, c) => s + c.dof, 0);
    return entityDOF - constraintDOF - fixedVars.size;
  }

  /**
   * Classify DOF state
   */
  classifyDOF(dof: number): DOFState {
    if (dof > 0) return 'under-constrained';
    if (dof === 0) return 'fully-constrained';
    return 'over-constrained';
  }

  /**
   * Detect conflicting constraints via Jacobian rank analysis.
   * When rank(J) < rows(J), some constraints are redundant/conflicting.
   */
  findConflicts(
    q: Vec,
    constraints: BaseConstraint[],
    fixedVars: Set<number>,
    totalVars: number
  ): ConflictReport {
    if (constraints.length === 0) {
      return { rank: 0, totalConstraintRows: 0, redundantConstraintIds: [] };
    }

    const free = Array.from({ length: totalVars }, (_, i) => i).filter(i => !fixedVars.has(i));
    const freeMap = new Map(free.map((gi, li) => [gi, li]));
    const m = constraints.reduce((s, c) => s + c.dof, 0);
    const n = free.length;

    // Build dense Jacobian for rank analysis
    const J = new SparseMatrix(m, n);
    let rowOff = 0;
    for (const c of constraints) {
      for (const e of c.jacobianEntries(q, rowOff)) {
        const col = freeMap.get(e.col);
        if (col !== undefined) J.add(e.row, col, e.val);
      }
      rowOff += c.dof;
    }

    const Jd = J.toDense();
    const rank = matrixRank(Jd);

    const redundant: string[] = [];
    if (rank < m) {
      // Identify which constraints might be redundant by checking which rows
      // are linearly dependent. Simple heuristic: try removing each constraint
      // and see if rank stays the same.
      for (const c of constraints) {
        const withoutC = constraints.filter(x => x !== c);
        const mReduced = withoutC.reduce((s, x) => s + x.dof, 0);
        const Jr = new SparseMatrix(mReduced, n);
        let ro = 0;
        for (const x of withoutC) {
          for (const e of x.jacobianEntries(q, ro)) {
            const col = freeMap.get(e.col);
            if (col !== undefined) Jr.add(e.row, col, e.val);
          }
          ro += x.dof;
        }
        const rankReduced = matrixRank(Jr.toDense());
        if (rankReduced === rank) {
          redundant.push(c.id);
        }
      }
    }

    return { rank, totalConstraintRows: m, redundantConstraintIds: redundant };
  }

  /**
   * Find which entities are under-constrained (have remaining DOF).
   * Returns entity IDs that still have free movement.
   */
  findUnderConstrainedEntities(
    entities: Entity[],
    constraints: BaseConstraint[],
    q: Vec,
    fixedVars: Set<number>,
    totalVars: number
  ): Set<string> {
    const result = new Set<string>();

    for (const entity of entities) {
      // Check if all variables of this entity are determined
      const entityVarsFixed = entity.vars.every(v => fixedVars.has(v));
      if (entityVarsFixed) continue;

      // Check if the entity's free variables are fully constrained
      const entityFreeVars = entity.vars.filter(v => !fixedVars.has(v));
      if (entityFreeVars.length === 0) continue;

      // Count effective constraints on this entity's variables
      let constraintRowsOnEntity = 0;
      for (const c of constraints) {
        const entries = c.jacobianEntries(q, 0);
        const touchesEntity = entries.some(e => entityFreeVars.includes(e.col) && e.val !== 0);
        if (touchesEntity) {
          constraintRowsOnEntity += c.dof;
        }
      }

      if (constraintRowsOnEntity < entityFreeVars.length) {
        result.add(entity.id);
      }
    }

    return result;
  }
}
