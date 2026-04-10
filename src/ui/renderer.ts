import { Entity, getPointPos, getLineEndpoints, getCircleParams, getArcParams, getEllipseParams } from '../core/entity';
import { BaseConstraint } from '../core/constraint';
import { DOFState, Vec } from '../core/types';

/** Colour scheme for DOF states */
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
  point: {
    default: '#c0c0d0',
    'under-constrained': '#5dade2',
    'fully-constrained': '#e0e0e0',
    'over-constrained': '#e94560',
  },
  selected: '#00e5ff',
  dragging: '#ffd740',
  constraint: '#4ecca3',
  constraintIcon: '#4ecca3',
  dimension: '#f0a030',
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

export interface RenderState {
  entities: Entity[];
  constraints: BaseConstraint[];
  q: Vec;
  dofState: DOFState;
  selectedEntityIds: Set<string>;
  underConstrainedIds: Set<string>;
  overConstrainedIds: Set<string>;
  draggingEntityId: string | null;
}

/**
 * Canvas renderer for the sketch.
 * Handles pan/zoom, entity drawing, constraint icons, and DOF coloring.
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

  /** Convert screen coords to world coords */
  screenToWorld(sx: number, sy: number): [number, number] {
    return [
      (sx - this.panX) / this.zoom,
      (sy - this.panY) / this.zoom,
    ];
  }

  /** Convert world coords to screen coords */
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

    // Clear
    ctx.fillStyle = COLORS.background;
    ctx.fillRect(0, 0, this.width, this.height);

    // Draw grid
    this.drawGrid();

    // Apply view transform
    ctx.save();
    ctx.translate(this.panX, this.panY);
    ctx.scale(this.zoom, this.zoom);

    // Draw entities
    for (const entity of state.entities) {
      const isSelected = state.selectedEntityIds.has(entity.id);
      const isDragging = state.draggingEntityId === entity.id;
      const isUnder = state.underConstrainedIds.has(entity.id);
      const isOver = state.overConstrainedIds.has(entity.id);

      let color: string;
      if (isDragging) color = COLORS.dragging;
      else if (isSelected) color = COLORS.selected;
      else if (isOver) color = COLORS.entity['over-constrained'];
      else if (isUnder) color = COLORS.entity['under-constrained'];
      else color = COLORS.entity['fully-constrained'];

      this.drawEntity(entity, state.q, color);
    }

    ctx.restore();

    // Draw constraint icons (screen space, fixed pixel size)
    this.drawConstraintIcons(state);

    ctx.restore();
  }

  private drawGrid(): void {
    const ctx = this.ctx;
    const step = 50 * this.zoom;
    const majorStep = step * 5;

    if (step < 5) return; // too zoomed out

    const startX = this.panX % step;
    const startY = this.panY % step;

    // Minor grid
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

    // Major grid
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

    // Origin axes
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
    const lineWidth = 2 / this.zoom;

    switch (entity.type) {
      case 'point': {
        const [x, y] = getPointPos(entity, q);
        const r = 4 / this.zoom;
        ctx.fillStyle = color;
        ctx.beginPath();
        ctx.arc(x, y, r, 0, Math.PI * 2);
        ctx.fill();
        break;
      }
      case 'line': {
        const [[x1, y1], [x2, y2]] = getLineEndpoints(entity, q);
        ctx.strokeStyle = color;
        ctx.lineWidth = lineWidth;
        ctx.beginPath();
        ctx.moveTo(x1, y1);
        ctx.lineTo(x2, y2);
        ctx.stroke();
        // Draw endpoint dots
        const r = 3 / this.zoom;
        ctx.fillStyle = color;
        ctx.beginPath();
        ctx.arc(x1, y1, r, 0, Math.PI * 2);
        ctx.fill();
        ctx.beginPath();
        ctx.arc(x2, y2, r, 0, Math.PI * 2);
        ctx.fill();
        break;
      }
      case 'circle': {
        const { cx, cy, r } = getCircleParams(entity, q);
        ctx.strokeStyle = color;
        ctx.lineWidth = lineWidth;
        ctx.beginPath();
        ctx.arc(cx, cy, Math.abs(r), 0, Math.PI * 2);
        ctx.stroke();
        // Centre dot
        const dotR = 2 / this.zoom;
        ctx.fillStyle = color;
        ctx.beginPath();
        ctx.arc(cx, cy, dotR, 0, Math.PI * 2);
        ctx.fill();
        break;
      }
      case 'arc': {
        const { cx, cy, r, thetaStart, thetaEnd } = getArcParams(entity, q);
        ctx.strokeStyle = color;
        ctx.lineWidth = lineWidth;
        ctx.beginPath();
        ctx.arc(cx, cy, Math.abs(r), thetaStart, thetaEnd);
        ctx.stroke();
        // Centre dot
        const dotR = 2 / this.zoom;
        ctx.fillStyle = color;
        ctx.beginPath();
        ctx.arc(cx, cy, dotR, 0, Math.PI * 2);
        ctx.fill();
        break;
      }
      case 'ellipse': {
        const { cx, cy, rx, ry, angle } = getEllipseParams(entity, q);
        ctx.strokeStyle = color;
        ctx.lineWidth = lineWidth;
        ctx.beginPath();
        ctx.ellipse(cx, cy, Math.abs(rx), Math.abs(ry), angle, 0, Math.PI * 2);
        ctx.stroke();
        // Centre dot
        const dotR = 2 / this.zoom;
        ctx.fillStyle = color;
        ctx.beginPath();
        ctx.arc(cx, cy, dotR, 0, Math.PI * 2);
        ctx.fill();
        break;
      }
    }
  }

  private drawConstraintIcons(state: RenderState): void {
    const ctx = this.ctx;
    ctx.font = '12px monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';

    for (const constraint of state.constraints) {
      const symbol = CONSTRAINT_SYMBOLS[constraint.type];
      if (!symbol) continue;

      // Find constraint position: average of involved entity centres
      const positions: [number, number][] = [];
      for (const eid of constraint.entityIds) {
        const entity = state.entities.find(e => e.id === eid);
        if (!entity) continue;
        const pos = this.getEntityCenter(entity, state.q);
        positions.push(pos);
      }
      if (positions.length === 0) continue;

      const avgX = positions.reduce((s, p) => s + p[0], 0) / positions.length;
      const avgY = positions.reduce((s, p) => s + p[1], 0) / positions.length;
      const [sx, sy] = this.worldToScreen(avgX, avgY);

      // Offset slightly
      const offset = 15;
      ctx.fillStyle = COLORS.constraintIcon;
      ctx.fillText(symbol, sx + offset, sy - offset);
    }
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
      case 'arc': {
        const v = entity.vars;
        return [q[v[0]], q[v[1]]];
      }
      case 'ellipse': {
        const v = entity.vars;
        return [q[v[0]], q[v[1]]];
      }
    }
  }
}
