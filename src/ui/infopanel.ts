import {
  Entity,
  getArcEndpoints,
  getArcParams,
  getCircleParams,
  getEllipseParams,
  getLineEndpoints,
  getPointPos,
} from '../core/entity';
import { BaseConstraint } from '../core/constraint';
import { ConstraintType, Vec } from '../core/types';
import { SketchDocument } from '../sketch';

/**
 * Right-side Info panel renderer.
 * Shows details for selected entities (coordinates, lengths, radii, angles)
 * and the constraints that touch each sub-part of the entity, grouped by
 * endpoint / center / body. When nothing is selected, shows a short
 * sketch summary instead.
 */

/** Human-readable label for each constraint type */
const CONSTRAINT_LABELS: Partial<Record<ConstraintType, string>> = {
  coincident: 'Coincident',
  fixed: 'Fixed',
  pointOnLine: 'Point on line',
  pointOnCircle: 'Point on circle',
  pointOnArc: 'Point on arc',
  pointOnEllipse: 'Point on ellipse',
  midpoint: 'Midpoint',
  horizontal: 'Horizontal',
  vertical: 'Vertical',
  parallel: 'Parallel',
  perpendicular: 'Perpendicular',
  collinear: 'Collinear',
  equalLength: 'Equal length',
  fixedLength: 'Length',
  fixedAngle: 'Angle',
  angleBetween: 'Angle between',
  symmetric: 'Symmetric',
  equalRadius: 'Equal radius',
  fixedRadius: 'Radius',
  concentric: 'Concentric',
  tangentLineCircle: 'Tangent',
  tangentCircleCircle: 'Tangent',
  horizontalDist: 'Horizontal dist',
  verticalDist: 'Vertical dist',
};

/** A named slot on an entity that constraints can attach to */
interface SubPart {
  /** Display label, e.g. "Endpoint 1" */
  label: string;
  /** Variable indices owned by this sub-part */
  varIndices: number[];
  /** Leaf sub-parts are endpoints/centers; non-leaf is the whole-entity bucket */
  isLeaf: boolean;
}

export interface InfoPanelCallbacks {
  onDeleteConstraint: (constraintId: string) => void;
}

export function renderInfoPanel(
  container: HTMLElement,
  doc: SketchDocument,
  selected: Entity[],
  callbacks: InfoPanelCallbacks
): void {
  if (selected.length === 0) {
    container.innerHTML = renderSummary(doc);
    return;
  }

  const parts: string[] = ['<h2>Info</h2>'];
  for (const entity of selected) {
    parts.push(renderEntityCard(entity, doc));
  }
  container.innerHTML = parts.join('');

  // Wire up the delete buttons once the DOM is in place
  container.querySelectorAll<HTMLButtonElement>('.constraint-delete').forEach(btn => {
    btn.addEventListener('click', e => {
      e.stopPropagation();
      const id = btn.dataset.constraintId;
      if (id) callbacks.onDeleteConstraint(id);
    });
  });
}

function renderSummary(doc: SketchDocument): string {
  // Count constraints excluding internal coupling constraints
  const visibleConstraintCount = doc.constraints.filter(
    c => c.type !== 'arcEndpointCoupling'
  ).length;

  return `
    <h2>Info</h2>
    <p class="empty">Select an entity to see details</p>
    <h3>Sketch</h3>
    <div class="summary-line">entities = ${doc.entities.length}</div>
    <div class="summary-line">constraints = ${visibleConstraintCount}</div>
    <div class="summary-line">DOF = ${doc.dofCount}</div>
    <div class="summary-line">state = ${doc.state}</div>
  `;
}

function renderEntityCard(entity: Entity, doc: SketchDocument): string {
  const parts: string[] = [];
  parts.push('<div class="entity-card">');

  // Header: type badge + id + construction badge
  parts.push('<div class="entity-header">');
  parts.push(`<span class="entity-type">${entity.type}</span>`);
  parts.push(`<span class="entity-id">${escapeHtml(entity.id)}</span>`);
  if (entity.construction) {
    parts.push('<span class="entity-construction">CONSTRUCTION</span>');
  }
  parts.push('</div>');

  // Details block
  parts.push('<div class="entity-details">');
  for (const line of getEntityDetails(entity, doc.q)) {
    parts.push(`<div class="detail-line">${escapeHtml(line)}</div>`);
  }
  parts.push('</div>');

  // Constraints grouped by sub-part
  parts.push('<div class="entity-constraints">');
  parts.push(renderEntityConstraints(entity, doc));
  parts.push('</div>');

  parts.push('</div>');
  return parts.join('');
}

function renderEntityConstraints(entity: Entity, doc: SketchDocument): string {
  const subParts = getEntitySubParts(entity);

  // Bucket constraints into groups by sub-part
  const buckets = new Map<string, BaseConstraint[]>();
  for (const sp of subParts) buckets.set(sp.label, []);

  for (const c of doc.constraints) {
    if (c.type === 'arcEndpointCoupling') continue;
    if (!c.entityIds.includes(entity.id)) continue;

    // Figure out which of this entity's leaf sub-parts the constraint touches
    const entries = c.jacobianEntries(doc.q, 0);
    const touchedVars = new Set(entries.map(e => e.col));

    const leaves = subParts.filter(sp => sp.isLeaf);
    const touchedLeaves = leaves.filter(sp =>
      sp.varIndices.some(v => touchedVars.has(v))
    );

    let targetLabel: string;
    if (touchedLeaves.length === 1) {
      // Exactly one leaf: constraint belongs to that sub-part
      targetLabel = touchedLeaves[0].label;
    } else {
      // Multi-leaf (e.g., horizontal touches both line endpoints) — goes under
      // the whole-entity bucket
      const whole = subParts.find(sp => !sp.isLeaf);
      targetLabel = whole?.label ?? subParts[0].label;
    }
    buckets.get(targetLabel)!.push(c);
  }

  const parts: string[] = [];
  let hasAny = false;
  for (const sp of subParts) {
    const constraints = buckets.get(sp.label)!;
    if (constraints.length === 0) continue;
    hasAny = true;
    parts.push(`<div class="group-label">${escapeHtml(sp.label)}</div>`);
    for (const c of constraints) {
      const desc = describeConstraint(c, entity, doc.entities);
      parts.push('<div class="constraint-line">');
      parts.push(`<span class="constraint-desc">${escapeHtml(desc)}</span>`);
      parts.push(
        `<button class="constraint-delete" data-constraint-id="${escapeHtml(c.id)}" title="Remove constraint">×</button>`
      );
      parts.push('</div>');
    }
  }
  if (!hasAny) {
    parts.push('<div class="no-constraints">No constraints</div>');
  }
  return parts.join('');
}

function describeConstraint(
  c: BaseConstraint,
  entity: Entity,
  allEntities: Entity[]
): string {
  const label = CONSTRAINT_LABELS[c.type] ?? c.type;
  const others = c.entityIds.filter(id => id !== entity.id);

  // Dimensional constraints show their parameter value
  if (c.params.length > 0) {
    const val = c.params[0];
    if (c.type === 'fixedAngle' || c.type === 'angleBetween') {
      return `${label} = ${deg(val)}`;
    }
    return `${label} = ${f(val)}`;
  }

  if (others.length > 0) {
    const names = others
      .map(id => allEntities.find(x => x.id === id)?.id ?? '?')
      .join(', ');
    return `${label} with ${names}`;
  }

  return label;
}

function getEntityDetails(entity: Entity, q: Vec): string[] {
  switch (entity.type) {
    case 'point': {
      const [x, y] = getPointPos(entity, q);
      return [`x = ${f(x)}`, `y = ${f(y)}`];
    }
    case 'line': {
      const [[x1, y1], [x2, y2]] = getLineEndpoints(entity, q);
      const dx = x2 - x1, dy = y2 - y1;
      return [
        `p1 = (${f(x1)}, ${f(y1)})`,
        `p2 = (${f(x2)}, ${f(y2)})`,
        `length = ${f(Math.hypot(dx, dy))}`,
        `angle = ${deg(Math.atan2(dy, dx))}`,
      ];
    }
    case 'circle': {
      const { cx, cy, r } = getCircleParams(entity, q);
      const ra = Math.abs(r);
      return [
        `center = (${f(cx)}, ${f(cy)})`,
        `radius = ${f(ra)}`,
        `diameter = ${f(ra * 2)}`,
      ];
    }
    case 'arc': {
      const { cx, cy, r, thetaStart, thetaEnd } = getArcParams(entity, q);
      const { start, end } = getArcEndpoints(entity, q);
      return [
        `center = (${f(cx)}, ${f(cy)})`,
        `radius = ${f(Math.abs(r))}`,
        `θ start = ${deg(thetaStart)}`,
        `θ end = ${deg(thetaEnd)}`,
        `start = (${f(start[0])}, ${f(start[1])})`,
        `end = (${f(end[0])}, ${f(end[1])})`,
      ];
    }
    case 'ellipse': {
      const { cx, cy, rx, ry, angle } = getEllipseParams(entity, q);
      return [
        `center = (${f(cx)}, ${f(cy)})`,
        `rx = ${f(Math.abs(rx))}`,
        `ry = ${f(Math.abs(ry))}`,
        `rotation = ${deg(angle)}`,
      ];
    }
  }
}

function getEntitySubParts(entity: Entity): SubPart[] {
  const v = entity.vars;
  switch (entity.type) {
    case 'point':
      return [
        { label: 'Point', varIndices: [v[0], v[1]], isLeaf: true },
      ];
    case 'line':
      return [
        { label: 'Endpoint 1', varIndices: [v[0], v[1]], isLeaf: true },
        { label: 'Endpoint 2', varIndices: [v[2], v[3]], isLeaf: true },
        { label: 'Line', varIndices: v.slice(0, 4), isLeaf: false },
      ];
    case 'circle':
      return [
        { label: 'Center', varIndices: [v[0], v[1]], isLeaf: true },
        { label: 'Circle', varIndices: v.slice(0, 3), isLeaf: false },
      ];
    case 'arc':
      return [
        { label: 'Center', varIndices: [v[0], v[1]], isLeaf: true },
        { label: 'Start point', varIndices: [v[5], v[6]], isLeaf: true },
        { label: 'End point', varIndices: [v[7], v[8]], isLeaf: true },
        { label: 'Arc', varIndices: [...v], isLeaf: false },
      ];
    case 'ellipse':
      return [
        { label: 'Center', varIndices: [v[0], v[1]], isLeaf: true },
        { label: 'Ellipse', varIndices: [...v], isLeaf: false },
      ];
  }
}

function f(n: number, digits = 2): string {
  if (!Number.isFinite(n)) return '—';
  return n.toFixed(digits);
}

function deg(rad: number): string {
  if (!Number.isFinite(rad)) return '—';
  let d = (rad * 180) / Math.PI;
  // Normalize to [-180, 180] for readability
  while (d > 180) d -= 360;
  while (d < -180) d += 360;
  return `${d.toFixed(1)}°`;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
