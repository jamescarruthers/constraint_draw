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
import { ConstraintType, EntityType, Vec } from '../core/types';
import { SketchDocument } from '../sketch';

/**
 * Right-side Info panel renderer.
 * Shows details for selected entities (coordinates, lengths, radii, angles)
 * and the constraints that touch each sub-part of the entity, grouped by
 * endpoint / center / body. When nothing is selected, shows a short
 * sketch summary instead.
 *
 * Supports inline editing of:
 *   - Entity ids (rename)
 *   - Dimensional constraint values (length, angle, radius, distances)
 *   - The "other entity" slot of relational constraints via a dropdown
 *
 * While an input or select inside the panel has focus, the panel refuses
 * to rebuild so the user's edit isn't destroyed by drag/solve updates.
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

/** Constraint types whose single parameter is an angle in radians */
const ANGULAR_DIM_TYPES: ConstraintType[] = ['fixedAngle', 'angleBetween'];

/** Constraint types that have a user-editable scalar dimension */
const DIMENSIONAL_TYPES: ConstraintType[] = [
  'fixedLength',
  'fixedAngle',
  'angleBetween',
  'fixedRadius',
  'horizontalDist',
  'verticalDist',
];

/** A named slot on an entity that constraints can attach to */
interface SubPart {
  label: string;
  varIndices: number[];
  isLeaf: boolean;
}

export interface InfoPanelCallbacks {
  onDeleteConstraint: (constraintId: string) => void;
  onEditConstraintValue: (constraintId: string, rawValue: number) => void;
  onReassignConstraint: (
    constraintId: string,
    slotIndex: number,
    newEntityId: string
  ) => void;
  onRenameEntity: (oldId: string, newId: string) => boolean;
}

export function renderInfoPanel(
  container: HTMLElement,
  doc: SketchDocument,
  selected: Entity[],
  callbacks: InfoPanelCallbacks
): void {
  // While the user is editing a value inside the panel, don't destroy
  // the input. Skip the rebuild until focus leaves.
  const active = document.activeElement;
  if (
    active &&
    container.contains(active) &&
    (active instanceof HTMLInputElement || active instanceof HTMLSelectElement)
  ) {
    return;
  }

  if (selected.length === 0) {
    container.innerHTML = renderSummary(doc);
    return;
  }

  const parts: string[] = ['<h2>Info</h2>'];
  for (const entity of selected) {
    parts.push(renderEntityCard(entity, doc));
  }
  container.innerHTML = parts.join('');

  wireUpEntityRenames(container, doc, callbacks);
  wireUpConstraintDeletes(container, callbacks);
  wireUpConstraintEdits(container, callbacks);
  wireUpConstraintReassignments(container, callbacks);
}

function renderSummary(doc: SketchDocument): string {
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

  // Header: type badge + editable id + construction badge
  parts.push('<div class="entity-header">');
  parts.push(`<span class="entity-type">${entity.type}</span>`);
  parts.push(
    `<input type="text" class="entity-id-input" value="${escapeAttr(entity.id)}" ` +
      `data-old-id="${escapeAttr(entity.id)}" spellcheck="false" />`
  );
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

    const entries = c.jacobianEntries(doc.q, 0);
    const touchedVars = new Set(entries.map(e => e.col));

    const leaves = subParts.filter(sp => sp.isLeaf);
    const touchedLeaves = leaves.filter(sp =>
      sp.varIndices.some(v => touchedVars.has(v))
    );

    let targetLabel: string;
    if (touchedLeaves.length === 1) {
      targetLabel = touchedLeaves[0].label;
    } else {
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
      parts.push(renderConstraintLine(c, entity, doc));
    }
  }
  if (!hasAny) {
    parts.push('<div class="no-constraints">No constraints</div>');
  }
  return parts.join('');
}

function renderConstraintLine(
  c: BaseConstraint,
  entity: Entity,
  doc: SketchDocument
): string {
  const parts: string[] = ['<div class="constraint-line">'];
  const label = CONSTRAINT_LABELS[c.type] ?? c.type;

  if (isDimensional(c.type)) {
    // Editable dimensional: label + input + unit + delete
    const isAngle = isAngular(c.type);
    const rawValue = c.params[0] ?? 0;
    const displayValue = isAngle
      ? ((rawValue * 180) / Math.PI).toFixed(2)
      : rawValue.toFixed(2);
    const step = isAngle ? '0.1' : '0.01';
    parts.push(`<span class="constraint-label">${escapeHtml(label)}</span>`);
    parts.push(
      `<input type="number" class="constraint-value-input" ` +
        `value="${displayValue}" step="${step}" ` +
        `data-constraint-id="${escapeAttr(c.id)}" ` +
        `data-is-angle="${isAngle}" />`
    );
    if (isAngle) parts.push('<span class="constraint-value-unit">°</span>');
  } else {
    // Non-dimensional: plain label, possibly followed by a reassignment dropdown
    const others = c.entityIds
      .map((eid, idx) => ({ eid, idx }))
      .filter(x => x.eid !== entity.id);

    if (others.length === 1 && supportsReassignment(c.type)) {
      // Relational with a single "other" slot → dropdown
      const { eid: otherId, idx: otherIdx } = others[0];
      const compatible = getCompatibleEntityTypes(c.type, otherIdx);
      const candidates = doc.entities.filter(
        e => e.id !== entity.id && compatible.includes(e.type)
      );
      parts.push(`<span class="constraint-label">${escapeHtml(label)} with</span>`);
      parts.push(
        `<select class="constraint-reassign" ` +
          `data-constraint-id="${escapeAttr(c.id)}" ` +
          `data-slot-index="${otherIdx}">`
      );
      // Include current selection even if it doesn't match the filter
      const ensured = candidates.some(e => e.id === otherId)
        ? candidates
        : candidates.concat(doc.entities.filter(e => e.id === otherId));
      for (const cand of ensured) {
        const sel = cand.id === otherId ? ' selected' : '';
        parts.push(`<option value="${escapeAttr(cand.id)}"${sel}>${escapeHtml(cand.id)}</option>`);
      }
      parts.push('</select>');
    } else {
      // Plain description with any "with <others>" list
      parts.push(
        `<span class="constraint-desc">${escapeHtml(describePlain(c, entity, doc.entities))}</span>`
      );
    }
  }

  parts.push(
    `<button class="constraint-delete" data-constraint-id="${escapeAttr(c.id)}" title="Remove constraint">×</button>`
  );
  parts.push('</div>');
  return parts.join('');
}

function describePlain(
  c: BaseConstraint,
  entity: Entity,
  allEntities: Entity[]
): string {
  const label = CONSTRAINT_LABELS[c.type] ?? c.type;
  const others = c.entityIds.filter(id => id !== entity.id);
  if (others.length === 0) return label;
  const names = others
    .map(id => allEntities.find(x => x.id === id)?.id ?? '?')
    .join(', ');
  return `${label} with ${names}`;
}

function isDimensional(type: ConstraintType): boolean {
  return DIMENSIONAL_TYPES.includes(type);
}

function isAngular(type: ConstraintType): boolean {
  return ANGULAR_DIM_TYPES.includes(type);
}

function supportsReassignment(type: ConstraintType): boolean {
  return [
    'coincident',
    'parallel',
    'perpendicular',
    'collinear',
    'equalLength',
    'equalRadius',
    'concentric',
    'tangentLineCircle',
    'tangentCircleCircle',
    'pointOnLine',
    'pointOnCircle',
    'midpoint',
  ].includes(type);
}

function getCompatibleEntityTypes(
  type: ConstraintType,
  slotIdx: number
): EntityType[] {
  switch (type) {
    case 'coincident':
      return ['point', 'line', 'circle', 'arc'];
    case 'parallel':
    case 'perpendicular':
    case 'collinear':
    case 'equalLength':
      return ['line'];
    case 'equalRadius':
    case 'concentric':
    case 'tangentCircleCircle':
      return ['circle', 'arc'];
    case 'tangentLineCircle':
      return slotIdx === 0 ? ['line'] : ['circle', 'arc'];
    case 'pointOnLine':
    case 'midpoint':
      return slotIdx === 0 ? ['point', 'line', 'arc'] : ['line'];
    case 'pointOnCircle':
      return slotIdx === 0 ? ['point', 'line', 'arc'] : ['circle', 'arc'];
    default:
      return [];
  }
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
      return [{ label: 'Point', varIndices: [v[0], v[1]], isLeaf: true }];
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

// ─── Event wiring ─────────────────────────────────────────────

function wireUpEntityRenames(
  container: HTMLElement,
  doc: SketchDocument,
  callbacks: InfoPanelCallbacks
): void {
  container.querySelectorAll<HTMLInputElement>('.entity-id-input').forEach(input => {
    const commit = () => {
      const oldId = input.dataset.oldId ?? '';
      const newId = input.value.trim();
      if (!newId || newId === oldId) {
        input.value = oldId;
        input.classList.remove('invalid');
        return;
      }
      const ok = callbacks.onRenameEntity(oldId, newId);
      if (!ok) {
        input.classList.add('invalid');
        input.value = oldId;
        setTimeout(() => input.classList.remove('invalid'), 800);
      }
    };

    input.addEventListener('keydown', e => {
      if (e.key === 'Enter') {
        e.preventDefault();
        input.blur();
      } else if (e.key === 'Escape') {
        input.value = input.dataset.oldId ?? '';
        input.blur();
      }
    });
    input.addEventListener('blur', commit);
  });
}

function wireUpConstraintDeletes(
  container: HTMLElement,
  callbacks: InfoPanelCallbacks
): void {
  container.querySelectorAll<HTMLButtonElement>('.constraint-delete').forEach(btn => {
    btn.addEventListener('click', e => {
      e.stopPropagation();
      const id = btn.dataset.constraintId;
      if (id) callbacks.onDeleteConstraint(id);
    });
  });
}

function wireUpConstraintEdits(
  container: HTMLElement,
  callbacks: InfoPanelCallbacks
): void {
  container.querySelectorAll<HTMLInputElement>('.constraint-value-input').forEach(input => {
    const commit = () => {
      const id = input.dataset.constraintId;
      if (!id) return;
      const raw = parseFloat(input.value);
      if (!Number.isFinite(raw)) return;
      const isAngle = input.dataset.isAngle === 'true';
      const value = isAngle ? (raw * Math.PI) / 180 : raw;
      callbacks.onEditConstraintValue(id, value);
    };

    input.addEventListener('keydown', e => {
      if (e.key === 'Enter') {
        e.preventDefault();
        input.blur();
      } else if (e.key === 'Escape') {
        input.blur();
      }
    });
    input.addEventListener('change', commit);
    input.addEventListener('blur', commit);
  });
}

function wireUpConstraintReassignments(
  container: HTMLElement,
  callbacks: InfoPanelCallbacks
): void {
  container.querySelectorAll<HTMLSelectElement>('.constraint-reassign').forEach(sel => {
    sel.addEventListener('change', () => {
      const id = sel.dataset.constraintId;
      const slot = sel.dataset.slotIndex;
      if (!id || slot == null) return;
      callbacks.onReassignConstraint(id, parseInt(slot, 10), sel.value);
    });
  });
}

// ─── Formatting helpers ───────────────────────────────────────

function f(n: number, digits = 2): string {
  if (!Number.isFinite(n)) return '—';
  return n.toFixed(digits);
}

function deg(rad: number): string {
  if (!Number.isFinite(rad)) return '—';
  let d = (rad * 180) / Math.PI;
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

function escapeAttr(s: string): string {
  return escapeHtml(s);
}
