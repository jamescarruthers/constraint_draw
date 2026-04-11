import { Entity, createEntity, ENTITY_DOF } from './core/entity';
import {
  BaseConstraint,
  CoincidentConstraint,
  FixedPointConstraint,
  PointOnLineConstraint,
  PointOnCircleConstraint,
  MidpointConstraint,
  HorizontalConstraint,
  VerticalConstraint,
  ParallelConstraint,
  PerpendicularConstraint,
  CollinearConstraint,
  EqualLengthConstraint,
  FixedLengthConstraint,
  FixedAngleConstraint,
  AngleBetweenConstraint,
  SymmetricConstraint,
  EqualRadiusConstraint,
  FixedRadiusConstraint,
  ConcentricConstraint,
  TangentLineCircleConstraint,
  TangentCircleCircleConstraint,
  HorizontalDistConstraint,
  VerticalDistConstraint,
} from './core/constraint';
import { NRSolver } from './core/solver';
import { DOFAnalyser } from './core/dof';
import { DragIntegrator } from './core/drag';
import { ConstraintGraph } from './core/graph';
import { ConstraintType, DOFState, EntityType, SolverState, Vec } from './core/types';

/**
 * The main sketch document: holds all entities, constraints, parameters,
 * and orchestrates the solver, DOF analysis, and drag system.
 */
export class SketchDocument {
  entities: Entity[] = [];
  constraints: BaseConstraint[] = [];
  q: Vec = [];
  fixedVars = new Set<number>();

  state: SolverState = 'idle';
  dofState: DOFState = 'under-constrained';
  dofCount = 0;
  underConstrainedIds = new Set<string>();
  overConstrainedIds = new Set<string>();

  private solver = new NRSolver();
  private dofAnalyser = new DOFAnalyser();
  private dragIntegrator = new DragIntegrator();
  private graph = new ConstraintGraph();

  private nextVarOffset = 0;

  // ─── Entity Management ─────────────────────────────────────────

  addEntity(type: EntityType, initialValues: number[], id?: string): Entity {
    const { entity, newOffset } = createEntity(type, initialValues, this.nextVarOffset, id);
    this.entities.push(entity);

    // Extend q with initial values
    for (const val of initialValues) {
      this.q.push(val);
    }
    this.nextVarOffset = newOffset;

    // Apply fixed flags
    for (let i = 0; i < entity.fixed.length; i++) {
      if (entity.fixed[i]) {
        this.fixedVars.add(entity.vars[i]);
      }
    }

    this.markDirty();
    return entity;
  }

  removeEntity(id: string): void {
    const idx = this.entities.findIndex(e => e.id === id);
    if (idx < 0) return;

    // Remove constraints referencing this entity
    this.constraints = this.constraints.filter(
      c => !c.entityIds.includes(id)
    );

    // Remove entity (don't compact q — indices remain stable)
    const entity = this.entities[idx];
    for (const v of entity.vars) {
      this.fixedVars.delete(v);
    }
    this.entities.splice(idx, 1);
    this.markDirty();
  }

  getEntity(id: string): Entity | undefined {
    return this.entities.find(e => e.id === id);
  }

  // ─── Constraint Management ─────────────────────────────────────

  addConstraint(
    type: ConstraintType,
    entityIds: string[],
    params: number[] = [],
    id?: string,
    /**
     * Optional per-entity overrides for the "point vars" used by constraints
     * like coincident, midpoint, point-on-line, etc. When provided for a given
     * entity slot, those variable indices are used instead of the default
     * (which picks the first endpoint/center). This lets callers express
     * intent like "the p2 endpoint of this line".
     */
    pointVarOverrides?: (([number, number] | null) | undefined)[]
  ): BaseConstraint | null {
    const entities = entityIds.map(eid => this.getEntity(eid)).filter(Boolean) as Entity[];
    if (entities.length !== entityIds.length) return null;

    const constraint = this.createConstraint(type, entities, params, id, pointVarOverrides);
    if (!constraint) return null;

    this.constraints.push(constraint);
    this.markDirty();
    return constraint;
  }

  removeConstraint(id: string): void {
    this.constraints = this.constraints.filter(c => c.id !== id);
    this.markDirty();
  }

  private createConstraint(
    type: ConstraintType,
    entities: Entity[],
    params: number[],
    id?: string,
    pointVarOverrides?: (([number, number] | null) | undefined)[]
  ): BaseConstraint | null {
    const eids = entities.map(e => e.id);
    const pv = (i: number, ent: Entity): [number, number] | null => {
      const override = pointVarOverrides?.[i];
      if (override) return override;
      return this.getPointVars(ent);
    };

    switch (type) {
      case 'coincident': {
        // Two points (or line endpoints / circle centers)
        const [a, b] = entities;
        if (!a || !b) return null;
        const av = pv(0, a);
        const bv = pv(1, b);
        if (!av || !bv) return null;
        return new CoincidentConstraint(av[0], av[1], bv[0], bv[1], eids, id);
      }
      case 'fixed': {
        const [a] = entities;
        if (!a) return null;
        const av = pv(0, a);
        if (!av) return null;
        return new FixedPointConstraint(av[0], av[1], this.q[av[0]], this.q[av[1]], eids, id);
      }
      case 'pointOnLine': {
        const [pt, line] = entities;
        if (!pt || !line || line.type !== 'line') return null;
        const ptv = pv(0, pt);
        if (!ptv) return null;
        const lv = line.vars;
        return new PointOnLineConstraint(ptv[0], ptv[1], lv[0], lv[1], lv[2], lv[3], eids, id);
      }
      case 'pointOnCircle': {
        const [pt, circ] = entities;
        if (!pt || !circ) return null;
        const ptv = pv(0, pt);
        if (!ptv) return null;
        const cv = circ.vars;
        return new PointOnCircleConstraint(ptv[0], ptv[1], cv[0], cv[1], cv[2], eids, id);
      }
      case 'midpoint': {
        const [pt, line] = entities;
        if (!pt || !line || line.type !== 'line') return null;
        const ptv = pv(0, pt);
        if (!ptv) return null;
        const lv = line.vars;
        return new MidpointConstraint(ptv[0], ptv[1], lv[0], lv[1], lv[2], lv[3], eids, id);
      }
      case 'horizontal': {
        const [line] = entities;
        if (!line || line.type !== 'line') return null;
        return new HorizontalConstraint(line.vars[1], line.vars[3], eids, id);
      }
      case 'vertical': {
        const [line] = entities;
        if (!line || line.type !== 'line') return null;
        return new VerticalConstraint(line.vars[0], line.vars[2], eids, id);
      }
      case 'parallel': {
        const [a, b] = entities;
        if (!a || !b || a.type !== 'line' || b.type !== 'line') return null;
        const av = a.vars, bv = b.vars;
        return new ParallelConstraint(av[0], av[1], av[2], av[3], bv[0], bv[1], bv[2], bv[3], eids, id);
      }
      case 'perpendicular': {
        const [a, b] = entities;
        if (!a || !b || a.type !== 'line' || b.type !== 'line') return null;
        const av = a.vars, bv = b.vars;
        return new PerpendicularConstraint(av[0], av[1], av[2], av[3], bv[0], bv[1], bv[2], bv[3], eids, id);
      }
      case 'collinear': {
        const [a, b] = entities;
        if (!a || !b || a.type !== 'line' || b.type !== 'line') return null;
        const av = a.vars, bv = b.vars;
        return new CollinearConstraint(av[0], av[1], av[2], av[3], bv[0], bv[1], bv[2], bv[3], eids, id);
      }
      case 'equalLength': {
        const [a, b] = entities;
        if (!a || !b || a.type !== 'line' || b.type !== 'line') return null;
        const av = a.vars, bv = b.vars;
        return new EqualLengthConstraint(av[0], av[1], av[2], av[3], bv[0], bv[1], bv[2], bv[3], eids, id);
      }
      case 'fixedLength': {
        const [line] = entities;
        if (!line || line.type !== 'line') return null;
        const L = params[0] ?? this.computeLineLength(line);
        return new FixedLengthConstraint(line.vars[0], line.vars[1], line.vars[2], line.vars[3], L, eids, id);
      }
      case 'fixedAngle': {
        const [line] = entities;
        if (!line || line.type !== 'line') return null;
        const theta = params[0] ?? this.computeLineAngle(line);
        return new FixedAngleConstraint(line.vars[0], line.vars[1], line.vars[2], line.vars[3], theta, eids, id);
      }
      case 'angleBetween': {
        const [a, b] = entities;
        if (!a || !b || a.type !== 'line' || b.type !== 'line') return null;
        const phi = params[0] ?? Math.PI / 2;
        const av = a.vars, bv = b.vars;
        return new AngleBetweenConstraint(av[0], av[1], av[2], av[3], bv[0], bv[1], bv[2], bv[3], phi, eids, id);
      }
      case 'symmetric': {
        const [ptA, ptB, line] = entities;
        if (!ptA || !ptB || !line || line.type !== 'line') return null;
        const pav = pv(0, ptA);
        const pbv = pv(1, ptB);
        if (!pav || !pbv) return null;
        const lv = line.vars;
        return new SymmetricConstraint(pav[0], pav[1], pbv[0], pbv[1], lv[0], lv[1], lv[2], lv[3], eids, id);
      }
      case 'equalRadius': {
        const [a, b] = entities;
        if (!a || !b) return null;
        const ra = this.getRadiusVar(a);
        const rb = this.getRadiusVar(b);
        if (ra === null || rb === null) return null;
        return new EqualRadiusConstraint(ra, rb, eids, id);
      }
      case 'fixedRadius': {
        const [c] = entities;
        if (!c) return null;
        const ri = this.getRadiusVar(c);
        if (ri === null) return null;
        const R = params[0] ?? this.q[ri];
        return new FixedRadiusConstraint(ri, R, eids, id);
      }
      case 'concentric': {
        const [a, b] = entities;
        if (!a || !b) return null;
        return new ConcentricConstraint(a.vars[0], a.vars[1], b.vars[0], b.vars[1], eids, id);
      }
      case 'tangentLineCircle': {
        const [line, circ] = entities;
        if (!line || !circ || line.type !== 'line') return null;
        const ri = this.getRadiusVar(circ);
        if (ri === null) return null;
        return new TangentLineCircleConstraint(
          circ.vars[0], circ.vars[1], ri,
          line.vars[0], line.vars[1], line.vars[2], line.vars[3],
          eids, id
        );
      }
      case 'tangentCircleCircle': {
        const [a, b] = entities;
        if (!a || !b) return null;
        const ra = this.getRadiusVar(a);
        const rb = this.getRadiusVar(b);
        if (ra === null || rb === null) return null;
        return new TangentCircleCircleConstraint(
          a.vars[0], a.vars[1], ra,
          b.vars[0], b.vars[1], rb,
          eids, false, id
        );
      }
      case 'horizontalDist': {
        const [a, b] = entities;
        if (!a || !b) return null;
        const av = pv(0, a);
        const bv = pv(1, b);
        if (!av || !bv) return null;
        const d = params[0] ?? (this.q[bv[0]] - this.q[av[0]]);
        return new HorizontalDistConstraint(av[0], bv[0], d, eids, id);
      }
      case 'verticalDist': {
        const [a, b] = entities;
        if (!a || !b) return null;
        const av = pv(0, a);
        const bv = pv(1, b);
        if (!av || !bv) return null;
        const d = params[0] ?? (this.q[bv[1]] - this.q[av[1]]);
        return new VerticalDistConstraint(av[1], bv[1], d, eids, id);
      }
      default:
        return null;
    }
  }

  /** Get point variable indices [x, y] — works for point entities or line endpoints */
  private getPointVars(entity: Entity): [number, number] | null {
    if (entity.type === 'point') return [entity.vars[0], entity.vars[1]];
    // For line, use first endpoint by default
    if (entity.type === 'line') return [entity.vars[0], entity.vars[1]];
    // For circle/arc/ellipse, use center
    return [entity.vars[0], entity.vars[1]];
  }

  /** Get radius variable index for circle/arc */
  private getRadiusVar(entity: Entity): number | null {
    if (entity.type === 'circle' || entity.type === 'arc') return entity.vars[2];
    return null;
  }

  private computeLineLength(line: Entity): number {
    const v = line.vars;
    const dx = this.q[v[2]] - this.q[v[0]];
    const dy = this.q[v[3]] - this.q[v[1]];
    return Math.hypot(dx, dy);
  }

  private computeLineAngle(line: Entity): number {
    const v = line.vars;
    return Math.atan2(this.q[v[3]] - this.q[v[1]], this.q[v[2]] - this.q[v[0]]);
  }

  // ─── Solver Operations ─────────────────────────────────────────

  markDirty(): void {
    this.state = 'dirty';
    this.runDOFAnalysis();
  }

  runDOFAnalysis(): void {
    this.dofCount = this.dofAnalyser.computeDOF(this.entities, this.constraints, this.fixedVars);
    this.dofState = this.dofAnalyser.classifyDOF(this.dofCount);

    this.underConstrainedIds = this.dofAnalyser.findUnderConstrainedEntities(
      this.entities, this.constraints, this.q, this.fixedVars, this.q.length
    );

    this.overConstrainedIds.clear();
    if (this.dofState === 'over-constrained') {
      const report = this.dofAnalyser.findConflicts(
        this.q, this.constraints, this.fixedVars, this.q.length
      );
      for (const cid of report.redundantConstraintIds) {
        const c = this.constraints.find(x => x.id === cid);
        if (c) {
          for (const eid of c.entityIds) this.overConstrainedIds.add(eid);
        }
      }
    }
  }

  solve(): boolean {
    if (this.constraints.length === 0) {
      this.state = 'solved';
      return true;
    }

    this.state = 'solving';
    this.graph.build(this.entities, this.constraints);

    // Solve each connected component independently
    const components = this.graph.findConnectedComponents();
    let allConverged = true;

    for (const component of components) {
      const entitySet = new Set(component);
      const componentConstraints = this.graph.getConstraintsForEntities(entitySet);
      if (componentConstraints.length === 0) continue;

      const result = this.solver.solve(this.q, componentConstraints, this.fixedVars);
      this.q = result.q;
      if (result.status !== 'converged') {
        allConverged = false;
      }
    }

    this.state = allConverged ? 'solved' : 'conflict';
    this.runDOFAnalysis();
    return allConverged;
  }

  // ─── Drag Operations ───────────────────────────────────────────

  /** Variables temporarily pinned for the duration of the current drag */
  private tempFixedVars: number[] = [];

  startDrag(
    _grabVarX: number,
    _grabVarY: number,
    tempFixed: number[] = []
  ): void {
    this.state = 'dragging';
    this.tempFixedVars = tempFixed;
    this.dragIntegrator.init(this.q);
  }

  dragStep(grabVars: [number, number], cursor: [number, number]): void {
    // Build an effective fixed set that combines permanent and temporary pins
    let effectiveFixed = this.fixedVars;
    if (this.tempFixedVars.length > 0) {
      effectiveFixed = new Set(this.fixedVars);
      for (const v of this.tempFixedVars) effectiveFixed.add(v);
    }

    this.q = this.dragIntegrator.stepSimple(
      this.q,
      this.constraints,
      effectiveFixed,
      grabVars,
      cursor
    );
  }

  endDrag(): void {
    this.tempFixedVars = [];
    this.state = 'dirty';
    this.solve();
  }

  // ─── Construction Toggle ───────────────────────────────────────

  toggleConstruction(entityId: string): void {
    const entity = this.getEntity(entityId);
    if (!entity) return;
    entity.construction = !entity.construction;
    // Construction doesn't affect the solver, but repaint
    this.state = this.state === 'solved' ? 'solved' : this.state;
  }

  // ─── Serialization ─────────────────────────────────────────────

  toJSON(): object {
    return {
      entities: this.entities.map(e => ({
        id: e.id,
        type: e.type,
        q: e.vars.map(v => this.q[v]),
        fixed: e.fixed,
        construction: e.construction,
      })),
      constraints: this.constraints.map(c => ({
        id: c.id,
        type: c.type,
        entities: c.entityIds,
        params: c.params,
      })),
    };
  }

  static fromJSON(data: { entities: any[]; constraints: any[] }): SketchDocument {
    const doc = new SketchDocument();

    for (const e of data.entities) {
      const entity = doc.addEntity(e.type, e.q, e.id);
      if (e.fixed) {
        for (let i = 0; i < e.fixed.length; i++) {
          entity.fixed[i] = e.fixed[i];
          if (e.fixed[i]) doc.fixedVars.add(entity.vars[i]);
        }
      }
      if (e.construction) entity.construction = true;
    }

    for (const c of data.constraints) {
      doc.addConstraint(c.type, c.entities, c.params || [], c.id);
    }

    doc.solve();
    return doc;
  }
}
