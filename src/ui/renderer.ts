import { Entity, getPointPos, getLineEndpoints, getCircleParams, getArcParams, getEllipseParams } from '../core/entity';
import { BaseConstraint } from '../core/constraint';
import { DOFState, Vec } from '../core/types';

/** Colour scheme */
const COLORS = {
  background: '#1a1a2e',
  grid: '#252545',
  gridMajor: '#2a2a5a',
  entity: {
    default: '#c0c0d0',
    'under-constrained': '#5dade2',
    'fully-constrained': '#e0e0e0',
    'over-constrained': '#e94560',
  },
  /** Muted tone for construction / reference geometry */
  construction: '#7a6f9c',
  selected: '#00e5ff',
  dragging: '#ffd740',
  /** Colour for endpoints/centres that participate in any constraint */
  constrainedNode: '#4ecca3',
  constraintIcon: '#4ecca3',
  dimension: '#f0a030',
  preview: '#ffd740',
  snap: '#ffd740',
  /** Hover highlight for the entity currently under the cursor */
  hover: '#ff7e9c',
};

/** Constraint icon symbols */
const CONSTRAINT_SYMBOLS: Partial<Record<string, string>> = {
  horizontal: '═',
  vertical: '‖',
  fixed: '▽',
  coincident: '●',
  tangentLineCircle: '⌒',
  tangentCircleCircle: '⌒',
  equalLength: '=',
  equalRadius: '=',
  parallel: '//',
  perpendicular: '⊥',
  symmetric: '⋮',
  midpoint: '△',
  collinear: '≡',
  pointOnLine: '○',
  pointOnCircle: '○',
};

/** Preview shapes drawn while a drawing tool is between clicks */
export type DrawingPreview =
  | { type: 'line'; points: [[number, number], [number, number]] }
  | { type: 'circle'; center: [number, number]; radiusPoint: [number, number] }
  | { type: 'arcRadius'; center: [number, number]; radiusPoint: [number, number] }
  | { type: 'arc'; center: [number, number]; start: [number, number]; end: [number, number] };

export interface RenderState {
  entities: Entity[];
  constraints: BaseConstraint[];
  q: Vec;
  dofState: DOFState;
  selectedEntityIds: Set<string>;
  underConstrainedIds: Set<string>;
  overConstrainedIds: Set<string>;
  draggingEntityId: string | null;
  /** Variable indices that are referenced by at least one constraint */
  constrainedVars: Set<number>;
  /** Optional drawing preview (ghost shape following cursor) */
  drawingPreview: DrawingPreview | null;
  /** Optional snap target under the cursor */
  snapTarget: [number, number] | null;
  /** Entity ID currently hovered by the cursor (for targeting feedback) */
  hoveredEntityId: string | null;
  /** Which sub-part of the hovered entity ('body' | 'p1' | 'p2' | 'center') */
  hoveredPart: string | null;
}

/**
 * Canvas renderer for the sketch.
 */
export class Renderer {
  private ctx: CanvasRenderingContext2D;
  private width = 0;
  private height = 0;
  private dpr = 1;

  /** View transform: world = (screen - pan) / zoom */
  panX = 0;
  panY = 0;
  zoom = 1;

  constructor(private canvas: HTMLCanvasElement) {
    this.ctx = canvas.getContext('2d')!;
    this.resize();
  }

  resize(): void {
    this.dpr = window.devicePixelRatio || 1;
    const rect = this.canvas.parentElement!.getBoundingClientRect();
    this.width = rect.width;
    this.height = rect.height;
    this.canvas.width = this.width * this.dpr;
    this.canvas.height = this.height * this.dpr;
    this.canvas.style.width = `${this.width}px`;
    this.canvas.style.height = `${this.height}px`;
  }

  screenToWorld(sx: number, sy: number): [number, number] {
    return [
      (sx - this.panX) / this.zoom,
      (sy - this.panY) / this.zoom,
    ];
  }

  worldToScreen(wx: number, wy: number): [number, number] {
    return [
      wx * this.zoom + this.panX,
      wy * this.zoom + this.panY,
    ];
  }

  render(state: RenderState): void {
    const ctx = this.ctx;
    const dpr = this.dpr;

    ctx.save();
    ctx.scale(dpr, dpr);

    ctx.fillStyle = COLORS.background;
    ctx.fillRect(0, 0, this.width, this.height);

    this.drawGrid();

    // Apply view transform for world-space entities
    ctx.save();
    ctx.translate(this.panX, this.panY);
    ctx.scale(this.zoom, this.zoom);

    // Hover highlight: thick soft glow under the hovered entity body
    if (state.hoveredEntityId) {
      const entity = state.entities.find(e => e.id === state.hoveredEntityId);
      if (entity) this.drawHoverHighlight(entity, state);
    }

    // Entities (wireframe first)
    for (const entity of state.entities) {
      const color = this.pickEntityColor(entity, state);
      this.drawEntity(entity, state.q, color);
    }

    // Draw node markers for endpoints/centers with constraint awareness
    for (const entity of state.entities) {
      this.drawEntityNodes(entity, state);
    }

    // Hover node marker on top
    if (state.hoveredEntityId && state.hoveredPart) {
      const entity = state.entities.find(e => e.id === state.hoveredEntityId);
      if (entity) this.drawHoverNode(entity, state.hoveredPart, state.q);
    }

    // Drawing preview (ghost shape)
    if (state.drawingPreview) {
      this.drawPreview(state.drawingPreview);
    }

    // Snap highlight
    if (state.snapTarget) {
      this.drawSnapTarget(state.snapTarget);
    }

    ctx.restore();

    // Constraint icons (screen space)
    this.drawConstraintIcons(state);

    ctx.restore();
  }

  /** Draw a soft glow under the hovered entity's body so the user can see
   *  what they're about to click. */
  private drawHoverHighlight(entity: Entity, state: RenderState): void {
    const ctx = this.ctx;
    const q = state.q;
    ctx.strokeStyle = COLORS.hover;
    ctx.lineWidth = 6 / this.zoom;
    ctx.globalAlpha = 0.4;
    ctx.setLineDash([]);

    switch (entity.type) {
      case 'point': {
        const [x, y] = getPointPos(entity, q);
        ctx.beginPath();
        ctx.arc(x, y, 8 / this.zoom, 0, Math.PI * 2);
        ctx.stroke();
        break;
      }
      case 'line': {
        const [[x1, y1], [x2, y2]] = getLineEndpoints(entity, q);
        ctx.beginPath();
        ctx.moveTo(x1, y1);
        ctx.lineTo(x2, y2);
        ctx.stroke();
        break;
      }
      case 'circle': {
        const { cx, cy, r } = getCircleParams(entity, q);
        ctx.beginPath();
        ctx.arc(cx, cy, Math.abs(r), 0, Math.PI * 2);
        ctx.stroke();
        break;
      }
      case 'arc': {
        const { cx, cy, r, thetaStart, thetaEnd } = getArcParams(entity, q);
        ctx.beginPath();
        ctx.arc(cx, cy, Math.abs(r), thetaStart, thetaEnd);
        ctx.stroke();
        break;
      }
      case 'ellipse': {
        const { cx, cy, rx, ry, angle } = getEllipseParams(entity, q);
        ctx.beginPath();
        ctx.ellipse(cx, cy, Math.abs(rx), Math.abs(ry), angle, 0, Math.PI * 2);
        ctx.stroke();
        break;
      }
    }

    ctx.globalAlpha = 1;
  }

  /** Draw an emphasized marker over the specifically hovered sub-part */
  private drawHoverNode(entity: Entity, part: string, q: Vec): void {
    const ctx = this.ctx;
    let pos: [number, number] | null = null;

    if (entity.type === 'point') {
      pos = getPointPos(entity, q);
    } else if (entity.type === 'line') {
      if (part === 'p1') pos = [q[entity.vars[0]], q[entity.vars[1]]];
      else if (part === 'p2') pos = [q[entity.vars[2]], q[entity.vars[3]]];
    } else if (entity.type === 'arc') {
      if (part === 'center') pos = [q[entity.vars[0]], q[entity.vars[1]]];
      else if (part === 'p1') pos = [q[entity.vars[5]], q[entity.vars[6]]];
      else if (part === 'p2') pos = [q[entity.vars[7]], q[entity.vars[8]]];
    } else if (entity.type === 'circle' || entity.type === 'ellipse') {
      if (part === 'center') pos = [q[entity.vars[0]], q[entity.vars[1]]];
    }

    if (!pos) return;

    const r = 7 / this.zoom;
    ctx.strokeStyle = COLORS.hover;
    ctx.lineWidth = 2 / this.zoom;
    ctx.setLineDash([]);
    ctx.beginPath();
    ctx.arc(pos[0], pos[1], r, 0, Math.PI * 2);
    ctx.stroke();
  }

  private pickEntityColor(entity: Entity, state: RenderState): string {
    const isSelected = state.selectedEntityIds.has(entity.id);
    const isDragging = state.draggingEntityId === entity.id;
    const isUnder = state.underConstrainedIds.has(entity.id);
    const isOver = state.overConstrainedIds.has(entity.id);

    if (isDragging) return COLORS.dragging;
    if (isSelected) return COLORS.selected;
    if (isOver) return COLORS.entity['over-constrained'];
    if (entity.construction) return COLORS.construction;
    if (isUnder) return COLORS.entity['under-constrained'];
    return COLORS.entity['fully-constrained'];
  }

  private drawGrid(): void {
    const ctx = this.ctx;
    const step = 50 * this.zoom;
    const majorStep = step * 5;

    if (step < 5) return;

    const startX = this.panX % step;
    const startY = this.panY % step;

    ctx.strokeStyle = COLORS.grid;
    ctx.lineWidth = 0.5;
    ctx.beginPath();
    for (let x = startX; x < this.width; x += step) {
      ctx.moveTo(x, 0);
      ctx.lineTo(x, this.height);
    }
    for (let y = startY; y < this.height; y += step) {
      ctx.moveTo(0, y);
      ctx.lineTo(this.width, y);
    }
    ctx.stroke();

    const majorStartX = this.panX % majorStep;
    const majorStartY = this.panY % majorStep;
    ctx.strokeStyle = COLORS.gridMajor;
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let x = majorStartX; x < this.width; x += majorStep) {
      ctx.moveTo(x, 0);
      ctx.lineTo(x, this.height);
    }
    for (let y = majorStartY; y < this.height; y += majorStep) {
      ctx.moveTo(0, y);
      ctx.lineTo(this.width, y);
    }
    ctx.stroke();

    const [ox, oy] = this.worldToScreen(0, 0);
    ctx.strokeStyle = '#3a3a6a';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(ox, 0);
    ctx.lineTo(ox, this.height);
    ctx.moveTo(0, oy);
    ctx.lineTo(this.width, oy);
    ctx.stroke();
  }

  private drawEntity(entity: Entity, q: Vec, color: string): void {
    const ctx = this.ctx;
    const lineWidth = (entity.construction ? 1.2 : 2) / this.zoom;

    ctx.strokeStyle = color;
    ctx.lineWidth = lineWidth;
    if (entity.construction) {
      ctx.setLineDash([6 / this.zoom, 4 / this.zoom]);
    } else {
      ctx.setLineDash([]);
    }

    switch (entity.type) {
      case 'point': {
        // Point bodies are drawn as nodes in drawEntityNodes
        break;
      }
      case 'line': {
        const [[x1, y1], [x2, y2]] = getLineEndpoints(entity, q);
        ctx.beginPath();
        ctx.moveTo(x1, y1);
        ctx.lineTo(x2, y2);
        ctx.stroke();
        break;
      }
      case 'circle': {
        const { cx, cy, r } = getCircleParams(entity, q);
        ctx.beginPath();
        ctx.arc(cx, cy, Math.abs(r), 0, Math.PI * 2);
        ctx.stroke();
        break;
      }
      case 'arc': {
        const { cx, cy, r, thetaStart, thetaEnd } = getArcParams(entity, q);
        ctx.beginPath();
        ctx.arc(cx, cy, Math.abs(r), thetaStart, thetaEnd);
        ctx.stroke();
        break;
      }
      case 'ellipse': {
        const { cx, cy, rx, ry, angle } = getEllipseParams(entity, q);
        ctx.beginPath();
        ctx.ellipse(cx, cy, Math.abs(rx), Math.abs(ry), angle, 0, Math.PI * 2);
        ctx.stroke();
        break;
      }
    }

    ctx.setLineDash([]);
  }

  /**
   * Draw endpoint / centre markers for an entity with constraint-awareness.
   * A node whose x-var is in constrainedVars is drawn as a filled ring in the
   * constrained colour; otherwise as a filled dot in the entity colour.
   */
  private drawEntityNodes(entity: Entity, state: RenderState): void {
    const ctx = this.ctx;
    const q = state.q;
    const entityColor = this.pickEntityColor(entity, state);

    const drawNode = (wx: number, wy: number, xVar: number, selectable: boolean) => {
      const constrained = state.constrainedVars.has(xVar);
      const r = (selectable ? 5 : 3) / this.zoom;

      if (constrained) {
        // Outer ring + inner dot to indicate the node participates in a constraint
        ctx.strokeStyle = COLORS.constrainedNode;
        ctx.lineWidth = 2 / this.zoom;
        ctx.beginPath();
        ctx.arc(wx, wy, r, 0, Math.PI * 2);
        ctx.stroke();
        ctx.fillStyle = COLORS.constrainedNode;
        ctx.beginPath();
        ctx.arc(wx, wy, r * 0.45, 0, Math.PI * 2);
        ctx.fill();
      } else {
        ctx.fillStyle = entityColor;
        ctx.beginPath();
        ctx.arc(wx, wy, r, 0, Math.PI * 2);
        ctx.fill();
      }
    };

    switch (entity.type) {
      case 'point': {
        const [x, y] = getPointPos(entity, q);
        drawNode(x, y, entity.vars[0], true);
        break;
      }
      case 'line': {
        const [[x1, y1], [x2, y2]] = getLineEndpoints(entity, q);
        drawNode(x1, y1, entity.vars[0], true);
        drawNode(x2, y2, entity.vars[2], true);
        break;
      }
      case 'arc': {
        // Arcs expose 3 nodes: center + two selectable endpoints
        const v = entity.vars;
        drawNode(q[v[0]], q[v[1]], v[0], false);
        drawNode(q[v[5]], q[v[6]], v[5], true);
        drawNode(q[v[7]], q[v[8]], v[7], true);
        break;
      }
      case 'circle':
      case 'ellipse': {
        const v = entity.vars;
        drawNode(q[v[0]], q[v[1]], v[0], false);
        break;
      }
    }
  }

  private drawPreview(preview: DrawingPreview): void {
    const ctx = this.ctx;
    const lineWidth = 2 / this.zoom;

    ctx.strokeStyle = COLORS.preview;
    ctx.lineWidth = lineWidth;
    ctx.setLineDash([6 / this.zoom, 4 / this.zoom]);

    switch (preview.type) {
      case 'line': {
        const [[x1, y1], [x2, y2]] = preview.points;
        ctx.beginPath();
        ctx.moveTo(x1, y1);
        ctx.lineTo(x2, y2);
        ctx.stroke();
        break;
      }
      case 'circle': {
        const [cx, cy] = preview.center;
        const [ex, ey] = preview.radiusPoint;
        const r = Math.hypot(ex - cx, ey - cy);
        ctx.beginPath();
        ctx.arc(cx, cy, r, 0, Math.PI * 2);
        ctx.stroke();
        // Radius line
        ctx.beginPath();
        ctx.moveTo(cx, cy);
        ctx.lineTo(ex, ey);
        ctx.stroke();
        break;
      }
      case 'arcRadius': {
        const [cx, cy] = preview.center;
        const [ex, ey] = preview.radiusPoint;
        const r = Math.hypot(ex - cx, ey - cy);
        // Show the full circle as a hint for radius
        ctx.beginPath();
        ctx.arc(cx, cy, r, 0, Math.PI * 2);
        ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(cx, cy);
        ctx.lineTo(ex, ey);
        ctx.stroke();
        break;
      }
      case 'arc': {
        const [cx, cy] = preview.center;
        const [sx, sy] = preview.start;
        const [ex, ey] = preview.end;
        const r = Math.hypot(sx - cx, sy - cy);
        const tStart = Math.atan2(sy - cy, sx - cx);
        const tEnd = Math.atan2(ey - cy, ex - cx);
        ctx.beginPath();
        ctx.arc(cx, cy, r, tStart, tEnd);
        ctx.stroke();
        // Spoke lines to start/end
        ctx.beginPath();
        ctx.moveTo(cx, cy);
        ctx.lineTo(sx, sy);
        ctx.moveTo(cx, cy);
        ctx.lineTo(ex, ey);
        ctx.stroke();
        break;
      }
    }

    ctx.setLineDash([]);
  }

  private drawSnapTarget(target: [number, number]): void {
    const ctx = this.ctx;
    const r = 8 / this.zoom;
    ctx.strokeStyle = COLORS.snap;
    ctx.lineWidth = 1.5 / this.zoom;
    ctx.beginPath();
    ctx.arc(target[0], target[1], r, 0, Math.PI * 2);
    ctx.stroke();
    // Crosshair
    ctx.beginPath();
    ctx.moveTo(target[0] - r, target[1]);
    ctx.lineTo(target[0] + r, target[1]);
    ctx.moveTo(target[0], target[1] - r);
    ctx.lineTo(target[0], target[1] + r);
    ctx.stroke();
  }

  private drawConstraintIcons(state: RenderState): void {
    const ctx = this.ctx;
    ctx.font = '12px monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';

    // Bucket icon positions so overlapping icons stack vertically instead
    // of drawing on top of each other.
    const used = new Map<string, number>();

    for (const constraint of state.constraints) {
      const symbol = CONSTRAINT_SYMBOLS[constraint.type];
      if (!symbol) continue;

      const world = this.getConstraintIconPos(constraint, state);
      if (!world) continue;

      let [sx, sy] = this.worldToScreen(world[0], world[1]);

      // Stack duplicate positions
      const key = `${Math.round(sx / 4)}:${Math.round(sy / 4)}`;
      const stackIdx = used.get(key) ?? 0;
      used.set(key, stackIdx + 1);
      sy += stackIdx * 16;

      this.drawIconPill(sx, sy, symbol);
    }
  }

  /** Draw a constraint icon with a dark rounded background for readability */
  private drawIconPill(sx: number, sy: number, symbol: string): void {
    const ctx = this.ctx;
    const padX = 4;
    const padY = 2;
    const metrics = ctx.measureText(symbol);
    const textW = metrics.width;
    const textH = 12;
    const w = textW + padX * 2;
    const h = textH + padY * 2;

    const radius = 4;
    const x = sx - w / 2;
    const y = sy - h / 2;

    ctx.fillStyle = 'rgba(15, 20, 40, 0.85)';
    ctx.strokeStyle = COLORS.constraintIcon;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(x + radius, y);
    ctx.lineTo(x + w - radius, y);
    ctx.quadraticCurveTo(x + w, y, x + w, y + radius);
    ctx.lineTo(x + w, y + h - radius);
    ctx.quadraticCurveTo(x + w, y + h, x + w - radius, y + h);
    ctx.lineTo(x + radius, y + h);
    ctx.quadraticCurveTo(x, y + h, x, y + h - radius);
    ctx.lineTo(x, y + radius);
    ctx.quadraticCurveTo(x, y, x + radius, y);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();

    ctx.fillStyle = COLORS.constraintIcon;
    ctx.fillText(symbol, sx, sy);
  }

  /**
   * Compute a sensible world-space anchor for a constraint's icon.
   * Different constraint types favour different anchors:
   *   - horizontal/vertical/fixedLength/fixedAngle on a line: line midpoint
   *   - fixedRadius/concentric: near circle edge
   *   - coincident/midpoint/fixed: at the shared point
   *   - parallel/perpendicular/equalLength: midpoint of both line midpoints
   *   - tangent: midway between circle edge and line
   *   - point-on-*: at the point
   */
  private getConstraintIconPos(
    constraint: BaseConstraint,
    state: RenderState
  ): [number, number] | null {
    const q = state.q;
    const entities = constraint.entityIds
      .map(id => state.entities.find(e => e.id === id))
      .filter((e): e is Entity => !!e);
    if (entities.length === 0) return null;

    const type = constraint.type;
    const e0 = entities[0];
    const e1 = entities[1];

    if ((type === 'horizontal' || type === 'vertical' ||
         type === 'fixedLength' || type === 'fixedAngle') &&
        e0 && e0.type === 'line') {
      return this.lineMidpoint(e0, q);
    }

    if (type === 'coincident' || type === 'midpoint' || type === 'fixed') {
      // Use the first point-like entity / endpoint / center
      return this.getEntityCenter(e0, q);
    }

    if (type === 'fixedRadius' && e0 &&
        (e0.type === 'circle' || e0.type === 'arc')) {
      const cx = q[e0.vars[0]];
      const cy = q[e0.vars[1]];
      const r = Math.abs(q[e0.vars[2]]);
      // Place on the edge at 45° (up-right)
      const off = Math.SQRT1_2 * r;
      return [cx + off, cy - off];
    }

    if ((type === 'equalRadius' || type === 'concentric' ||
         type === 'tangentCircleCircle') && e0 && e1) {
      return this.midOf([this.getEntityCenter(e0, q), this.getEntityCenter(e1, q)]);
    }

    if ((type === 'parallel' || type === 'perpendicular' ||
         type === 'collinear' || type === 'equalLength' ||
         type === 'angleBetween') &&
        e0 && e0.type === 'line' && e1 && e1.type === 'line') {
      return this.midOf([this.lineMidpoint(e0, q), this.lineMidpoint(e1, q)]);
    }

    if (type === 'tangentLineCircle' && e0 && e1) {
      const line = e0.type === 'line' ? e0 : e1;
      const circ = e0.type === 'line' ? e1 : e0;
      if (line.type === 'line' && (circ.type === 'circle' || circ.type === 'arc')) {
        // Foot of perpendicular from centre onto line
        return this.footOnLine(circ, line, q);
      }
    }

    if ((type === 'pointOnLine' || type === 'pointOnCircle') && e0) {
      // First entity is the point (or point-like)
      return this.getEntityCenter(e0, q);
    }

    if ((type === 'horizontalDist' || type === 'verticalDist') && e0 && e1) {
      return this.midOf([this.getEntityCenter(e0, q), this.getEntityCenter(e1, q)]);
    }

    // Default: centroid of entity centres
    const avg = entities.reduce<[number, number]>(
      (acc, e) => {
        const p = this.getEntityCenter(e, q);
        return [acc[0] + p[0], acc[1] + p[1]];
      },
      [0, 0]
    );
    return [avg[0] / entities.length, avg[1] / entities.length];
  }

  private lineMidpoint(line: Entity, q: Vec): [number, number] {
    const v = line.vars;
    return [(q[v[0]] + q[v[2]]) / 2, (q[v[1]] + q[v[3]]) / 2];
  }

  private midOf(points: [number, number][]): [number, number] {
    const n = points.length;
    let x = 0, y = 0;
    for (const p of points) { x += p[0]; y += p[1]; }
    return [x / n, y / n];
  }

  private footOnLine(circle: Entity, line: Entity, q: Vec): [number, number] {
    const cx = q[circle.vars[0]], cy = q[circle.vars[1]];
    const x1 = q[line.vars[0]], y1 = q[line.vars[1]];
    const x2 = q[line.vars[2]], y2 = q[line.vars[3]];
    const dx = x2 - x1, dy = y2 - y1;
    const len2 = dx * dx + dy * dy;
    if (len2 < 1e-10) return [x1, y1];
    const t = ((cx - x1) * dx + (cy - y1) * dy) / len2;
    return [x1 + t * dx, y1 + t * dy];
  }

  private getEntityCenter(entity: Entity, q: Vec): [number, number] {
    switch (entity.type) {
      case 'point':
        return getPointPos(entity, q);
      case 'line': {
        const [[x1, y1], [x2, y2]] = getLineEndpoints(entity, q);
        return [(x1 + x2) / 2, (y1 + y2) / 2];
      }
      case 'circle':
      case 'arc':
      case 'ellipse': {
        const v = entity.vars;
        return [q[v[0]], q[v[1]]];
      }
    }
  }
}
