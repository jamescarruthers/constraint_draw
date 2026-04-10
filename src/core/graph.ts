import { BaseConstraint } from './constraint';
import { Entity } from './entity';

/**
 * Constraint graph: entities as nodes, constraints as (hyper)edges.
 * Supports connected component decomposition and cycle detection.
 */
export class ConstraintGraph {
  /** Adjacency: entity ID -> set of constraint IDs involving it */
  private entityToConstraints = new Map<string, Set<string>>();
  /** Constraint ID -> constraint */
  private constraintMap = new Map<string, BaseConstraint>();
  /** Entity ID -> entity */
  private entityMap = new Map<string, Entity>();

  build(entities: Entity[], constraints: BaseConstraint[]): void {
    this.entityToConstraints.clear();
    this.constraintMap.clear();
    this.entityMap.clear();

    for (const e of entities) {
      this.entityMap.set(e.id, e);
      this.entityToConstraints.set(e.id, new Set());
    }
    for (const c of constraints) {
      this.constraintMap.set(c.id, c);
      for (const eid of c.entityIds) {
        const set = this.entityToConstraints.get(eid);
        if (set) set.add(c.id);
      }
    }
  }

  /**
   * Find connected components: groups of entities connected by constraints.
   * Returns arrays of entity IDs forming each component.
   */
  findConnectedComponents(): string[][] {
    const visited = new Set<string>();
    const components: string[][] = [];

    for (const eid of this.entityMap.keys()) {
      if (visited.has(eid)) continue;

      const component: string[] = [];
      const stack: string[] = [eid];

      while (stack.length > 0) {
        const current = stack.pop()!;
        if (visited.has(current)) continue;
        visited.add(current);
        component.push(current);

        // Find all entities connected through shared constraints
        const constraintIds = this.entityToConstraints.get(current);
        if (!constraintIds) continue;

        for (const cid of constraintIds) {
          const c = this.constraintMap.get(cid);
          if (!c) continue;
          for (const neighbor of c.entityIds) {
            if (!visited.has(neighbor)) {
              stack.push(neighbor);
            }
          }
        }
      }

      components.push(component);
    }

    return components;
  }

  /**
   * Get constraints for a given set of entity IDs.
   */
  getConstraintsForEntities(entityIds: Set<string>): BaseConstraint[] {
    const result: BaseConstraint[] = [];
    const seen = new Set<string>();

    for (const eid of entityIds) {
      const cids = this.entityToConstraints.get(eid);
      if (!cids) continue;
      for (const cid of cids) {
        if (seen.has(cid)) continue;
        seen.add(cid);
        const c = this.constraintMap.get(cid);
        if (c && c.entityIds.every(e => entityIds.has(e))) {
          result.push(c);
        }
      }
    }

    return result;
  }

  /**
   * Detect strongly connected components (cycles) using Tarjan's algorithm.
   * Operates on the constraint-entity bipartite graph projected to entity nodes.
   */
  findStrongComponents(): string[][] {
    let index = 0;
    const stack: string[] = [];
    const onStack = new Set<string>();
    const indices = new Map<string, number>();
    const lowlinks = new Map<string, number>();
    const components: string[][] = [];

    const strongconnect = (v: string) => {
      indices.set(v, index);
      lowlinks.set(v, index);
      index++;
      stack.push(v);
      onStack.add(v);

      // Neighbors: entities connected through constraints
      const cids = this.entityToConstraints.get(v);
      if (cids) {
        for (const cid of cids) {
          const c = this.constraintMap.get(cid);
          if (!c) continue;
          for (const w of c.entityIds) {
            if (w === v) continue;
            if (!indices.has(w)) {
              strongconnect(w);
              lowlinks.set(v, Math.min(lowlinks.get(v)!, lowlinks.get(w)!));
            } else if (onStack.has(w)) {
              lowlinks.set(v, Math.min(lowlinks.get(v)!, indices.get(w)!));
            }
          }
        }
      }

      if (lowlinks.get(v) === indices.get(v)) {
        const component: string[] = [];
        let w: string;
        do {
          w = stack.pop()!;
          onStack.delete(w);
          component.push(w);
        } while (w !== v);
        components.push(component);
      }
    };

    for (const eid of this.entityMap.keys()) {
      if (!indices.has(eid)) {
        strongconnect(eid);
      }
    }

    return components;
  }
}
