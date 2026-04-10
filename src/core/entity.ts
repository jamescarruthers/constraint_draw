import { EntityType, Vec } from './types';

/** Unique ID counter */
let nextEntityId = 1;

/**
 * A geometric entity in the sketch.
 * Each entity owns a set of indices into the global coordinate vector q.
 */
export interface Entity {
  id: string;
  type: EntityType;
  /** Indices into the global q[] vector for this entity's variables */
  vars: number[];
  /** Per-variable fixed flag */
  fixed: boolean[];
}

/** DOF per entity type */
export const ENTITY_DOF: Record<EntityType, number> = {
  point: 2,    // x, y
  line: 4,     // x1, y1, x2, y2
  arc: 5,      // cx, cy, r, theta_start, theta_end
  circle: 3,   // cx, cy, r
  ellipse: 5,  // cx, cy, rx, ry, angle
};

/**
 * Create a new entity, allocating variable indices starting at `offset`.
 * Returns the entity and the new offset.
 */
export function createEntity(
  type: EntityType,
  initialValues: number[],
  offset: number,
  id?: string
): { entity: Entity; newOffset: number } {
  const dof = ENTITY_DOF[type];
  if (initialValues.length !== dof) {
    throw new Error(`Entity ${type} requires ${dof} values, got ${initialValues.length}`);
  }

  const vars: number[] = [];
  for (let i = 0; i < dof; i++) {
    vars.push(offset + i);
  }

  const entity: Entity = {
    id: id ?? `${type}_${nextEntityId++}`,
    type,
    vars,
    fixed: new Array(dof).fill(false),
  };

  return { entity, newOffset: offset + dof };
}

/** Reset the entity ID counter (for testing) */
export function resetEntityIdCounter(): void {
  nextEntityId = 1;
}

/** Get the (x, y) position of a point entity from q */
export function getPointPos(entity: Entity, q: Vec): [number, number] {
  return [q[entity.vars[0]], q[entity.vars[1]]];
}

/** Get line endpoints from q: [[x1,y1], [x2,y2]] */
export function getLineEndpoints(entity: Entity, q: Vec): [[number, number], [number, number]] {
  const v = entity.vars;
  return [[q[v[0]], q[v[1]]], [q[v[2]], q[v[3]]]];
}

/** Get circle center and radius from q */
export function getCircleParams(entity: Entity, q: Vec): { cx: number; cy: number; r: number } {
  const v = entity.vars;
  return { cx: q[v[0]], cy: q[v[1]], r: q[v[2]] };
}

/** Get arc params from q */
export function getArcParams(entity: Entity, q: Vec): {
  cx: number; cy: number; r: number; thetaStart: number; thetaEnd: number;
} {
  const v = entity.vars;
  return {
    cx: q[v[0]], cy: q[v[1]], r: q[v[2]],
    thetaStart: q[v[3]], thetaEnd: q[v[4]],
  };
}

/** Get ellipse params from q */
export function getEllipseParams(entity: Entity, q: Vec): {
  cx: number; cy: number; rx: number; ry: number; angle: number;
} {
  const v = entity.vars;
  return { cx: q[v[0]], cy: q[v[1]], rx: q[v[2]], ry: q[v[3]], angle: q[v[4]] };
}
