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
  ArcEndpointCouplingConstraint,
  resolveSubPart,
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
    // Arcs: accept either 5 canonical values (cx, cy, r, θs, θe) or the full
    // 9-value form (appending the start/end endpoint positions). When given
    // 5 values, derive the 4 endpoint values so the caller doesn't have to.
    let values = initialValues;
    if (type === 'arc' && initialValues.length === 5) {
      const [cx, cy, r, ts, te] = initialValues;
      values = [
        cx, cy, r, ts, te,
        cx + r * Math.cos(ts), cy + r * Math.sin(ts),
        cx + r * Math.cos(te), cy + r * Math.sin(te),
      ];
    }

    const { entity, newOffset } = createEntity(type, values, this.nextVarOffset, id);
    this.entities.push(entity);

    // Extend q with initial values
    for (const val of values) {
      this.q.push(val);
    }
    this.nextVarOffset = newOffset;

    // Apply fixed flags
    for (let i = 0; i < entity.fixed.length; i++) {
      if (entity.fixed[i]) {
        this.fixedVars.add(entity.vars[i]);
      }
    }

    // Auto-add the arc endpoint coupling constraint so the endpoint vars
    // stay consistent with (center, radius, θs, θe).
    if (type === 'arc') {
      const v = entity.vars;
      const coupling = new ArcEndpointCouplingConstraint(
        v[0], v[1], v[2], v[3], v[4], v[5], v[6], v[7], v[8],
        [entity.id]
      );
      this.constraints.push(coupling);
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
     * Optional per-entity sub-part labels ('p1', 'p2', 'center', or null).
     * Identifies which point-like part of each entity the constraint
     * attaches to. Used by constraints like coincident/midpoint/pointOnLine
     * that take a point-like slot from any entity. Stored on the created
     * constraint so the sub-part intent survives save/load and undo/redo.
     */
    subParts?: (string | null)[]
  ): BaseConstraint | null {
    const entities = entityIds.map(eid => this.getEntity(eid)).filter(Boolean) as Entity[];
    if (entities.length !== entityIds.length) return null;

    // Translate sub-part labels into absolute [x, y] var overrides for the
    // constraint factory.
    const pointVarOverrides = subParts?.map((sp, i) => {
      const ent = entities[i];
      return ent ? resolveSubPart(ent, sp) : null;
    });

    const constraint = this.createConstraint(type, entities, params, id, pointVarOverrides);
    if (!constraint) return null;

    if (subParts && subParts.some(sp => sp != null)) {
      constraint.subParts = [...subParts];
    }

    this.constraints.push(constraint);
    this.markDirty();
    return constraint;
  }

  removeConstraint(id: string): void {
    this.constraints = this.constraints.filter(c => c.id !== id);
    this.markDirty();
  }

  /** Update a dimensional constraint's parameter values in place. */
  updateConstraintParams(constraintId: string, params: number[]): boolean {
    const c = this.constraints.find(x => x.id === constraintId);
    if (!c) return false;
    c.setParams(params);
    this.markDirty();
    return true;
  }

  /**
   * Reassign one of a constraint's entity slots to a different entity.
   * Re-creates the underlying constraint in place with the new target
   * (keeping the same id), using the target entity's default sub-part.
   */
  reassignConstraintEntity(
    constraintId: string,
    slotIndex: number,
    newEntityId: string
  ): boolean {
    const idx = this.constraints.findIndex(c => c.id === constraintId);
    if (idx < 0) return false;

    const old = this.constraints[idx];
    if (slotIndex < 0 || slotIndex >= old.entityIds.length) return false;
    if (old.entityIds[slotIndex] === newEntityId) return true;

    const newEntityIds = [...old.entityIds];
    newEntityIds[slotIndex] = newEntityId;

    const entities = newEntityIds.map(eid => this.getEntity(eid)).filter(Boolean) as Entity[];
    if (entities.length !== newEntityIds.length) return false;

    // Preserve the existing sub-part labels for untouched slots; clear the
    // reassigned slot so the new entity's default sub-part is used.
    const newSubParts = old.subParts ? [...old.subParts] : undefined;
    if (newSubParts) newSubParts[slotIndex] = null;

    const overrides = newSubParts?.map((sp, i) => {
      const ent = entities[i];
      return ent ? resolveSubPart(ent, sp) : null;
    });

    const rebuilt = this.createConstraint(old.type, entities, [...old.params], old.id, overrides);
    if (!rebuilt) return false;

    if (newSubParts && newSubParts.some(sp => sp != null)) {
      rebuilt.subParts = newSubParts;
    }

    this.constraints[idx] = rebuilt;
    this.markDirty();
    return true;
  }

  /**
   * Rename an entity. Updates entity.id and every constraint's entityIds
   * that referenced the old id. Returns false if newId is empty, already
   * in use, or the oldId doesn't exist.
   */
  renameEntity(oldId: string, newId: string): boolean {
    const trimmed = newId.trim();
    if (!trimmed) return false;
    if (oldId === trimmed) return true;
    if (this.entities.some(e => e.id === trimmed)) return false;

    const entity = this.getEntity(oldId);
    if (!entity) return false;

    entity.id = trimmed;
    for (const c of this.constraints) {
      for (let i = 0; i < c.entityIds.length; i++) {
        if (c.entityIds[i] === oldId) c.entityIds[i] = trimmed;
      }
    }
    this.markDirty();
    return true;
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

  /** Wall-clock duration of the last solve in milliseconds */
  lastSolveMs = 0;

  solve(): boolean {
    if (this.constraints.length === 0) {
      this.state = 'solved';
      this.lastSolveMs = 0;
      return true;
    }

    this.state = 'solving';
    const t0 = performance.now();
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

    this.lastSolveMs = performance.now() - t0;
    this.state = allConverged ? 'solved' : 'conflict';
    this.runDOFAnalysis();
    return allConverged;
  }

  /**
   * Solve with an extra set of variables temporarily pinned on top of the
   * permanent `fixedVars`. Used when the user applies a constraint so that
   * the "target" entity (the reference — usually the last clicked) doesn't
   * move if it doesn't have to. Leaves `fixedVars` unchanged on exit.
   */
  solveWithExtraFixed(extraFixed: Iterable<number>): boolean {
    const saved = this.fixedVars;
    const augmented = new Set(saved);
    for (const v of extraFixed) augmented.add(v);
    this.fixedVars = augmented;
    try {
      return this.solve();
    } finally {
      this.fixedVars = saved;
      // Re-run DOF analysis with the permanent fixed set so the UI isn't
      // left reflecting the temporarily pinned state.
      this.runDOFAnalysis();
    }
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

  /**
   * Rigidly translate a line by setting its endpoint positions directly
   * and solving with the line pinned. Used for dragging a line by its body.
   * The solver then adjusts any connected geometry (coincident neighbours,
   * tangent circles, etc.) to satisfy the constraints.
   */
  translateLineRigid(
    line: Entity,
    newP1: [number, number],
    newP2: [number, number]
  ): void {
    const v = line.vars;
    this.q[v[0]] = newP1[0];
    this.q[v[1]] = newP1[1];
    this.q[v[2]] = newP2[0];
    this.q[v[3]] = newP2[1];

    const fixed = new Set(this.fixedVars);
    fixed.add(v[0]);
    fixed.add(v[1]);
    fixed.add(v[2]);
    fixed.add(v[3]);

    this.state = 'solving';
    const t0 = performance.now();
    const result = this.solver.solve(this.q, this.constraints, fixed);
    this.q = result.q;
    this.lastSolveMs = performance.now() - t0;
    this.state = 'dragging';
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
      entities: this.entities.map(e => {
        // Arcs serialise only their 5 canonical params; the endpoint vars
        // are re-derived on load via addEntity's 5→9 expansion.
        const vars = e.type === 'arc' ? e.vars.slice(0, 5) : e.vars;
        const fixed = e.type === 'arc' ? e.fixed.slice(0, 5) : e.fixed;
        return {
          id: e.id,
          type: e.type,
          q: vars.map(v => this.q[v]),
          fixed,
          construction: e.construction,
        };
      }),
      constraints: this.constraints
        // Don't emit auto-added internal constraints — they're re-added
        // during addEntity on load.
        .filter(c => c.type !== 'arcEndpointCoupling')
        .map(c => ({
          id: c.id,
          type: c.type,
          entities: c.entityIds,
          params: c.params,
          subParts: c.subParts ?? null,
        })),
    };
  }

  /**
   * Replace this document's contents with the data from a JSON snapshot.
   * Used by undo/redo and the SVG loader so the existing document instance
   * (and therefore all references held by the renderer / interaction
   * handler) can be reused.
   */
  loadFromJSON(data: { entities: any[]; constraints: any[] }): void {
    this.entities = [];
    this.constraints = [];
    this.q = [];
    this.fixedVars = new Set();
    this.nextVarOffset = 0;
    this.underConstrainedIds = new Set();
    this.overConstrainedIds = new Set();

    for (const e of data.entities) {
      const entity = this.addEntity(e.type, e.q, e.id);
      if (e.fixed) {
        for (let i = 0; i < e.fixed.length; i++) {
          entity.fixed[i] = e.fixed[i];
          if (e.fixed[i]) this.fixedVars.add(entity.vars[i]);
        }
      }
      if (e.construction) entity.construction = true;
    }

    for (const c of data.constraints) {
      this.addConstraint(
        c.type,
        c.entities,
        c.params || [],
        c.id,
        c.subParts ?? undefined
      );
    }

    this.solve();
  }

  static fromJSON(data: { entities: any[]; constraints: any[] }): SketchDocument {
    const doc = new SketchDocument();
    doc.loadFromJSON(data);
    return doc;
  }

  // ─── Undo / Redo ───────────────────────────────────────────────

  private undoStack: string[] = [];
  private redoStack: string[] = [];
  private readonly MAX_UNDO = 200;

  /**
   * Snapshot the current state onto the undo stack. Call this BEFORE
   * performing any user-initiated mutation so that undo() can restore
   * the pre-mutation state.
   */
  pushUndo(): void {
    const snapshot = JSON.stringify(this.toJSON());
    this.undoStack.push(snapshot);
    if (this.undoStack.length > this.MAX_UNDO) this.undoStack.shift();
    // Any new mutation invalidates the redo stack
    this.redoStack = [];
  }

  canUndo(): boolean { return this.undoStack.length > 0; }
  canRedo(): boolean { return this.redoStack.length > 0; }

  /**
   * Restore the most recent snapshot from the undo stack. Pushes the
   * current state onto the redo stack first so redo() can reverse it.
   */
  undo(): boolean {
    const snapshot = this.undoStack.pop();
    if (!snapshot) return false;
    this.redoStack.push(JSON.stringify(this.toJSON()));
    if (this.redoStack.length > this.MAX_UNDO) this.redoStack.shift();
    this.loadFromJSON(JSON.parse(snapshot));
    return true;
  }

  /** Reapply the most recent undone snapshot. */
  redo(): boolean {
    const snapshot = this.redoStack.pop();
    if (!snapshot) return false;
    this.undoStack.push(JSON.stringify(this.toJSON()));
    if (this.undoStack.length > this.MAX_UNDO) this.undoStack.shift();
    this.loadFromJSON(JSON.parse(snapshot));
    return true;
  }

  /**
   * Drop the most recently pushed undo snapshot without restoring anything.
   * Useful when a caller pushed an undo speculatively and then found the
   * mutation didn't actually happen (e.g. a rename was rejected).
   */
  dropLastUndo(): void {
    this.undoStack.pop();
  }

  clearHistory(): void {
    this.undoStack = [];
    this.redoStack = [];
  }
}
