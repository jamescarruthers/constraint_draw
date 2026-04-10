import { SketchDocument } from '../sketch';
import { Renderer, RenderState } from './renderer';
import { hitTest, HitResult } from './hittest';
import { ConstraintType, EntityType } from '../core/types';
import { Entity } from '../core/entity';

export type ToolMode =
  | 'select'
  | 'point'
  | 'line'
  | 'circle'
  | 'arc'
  | 'delete'
  | 'save'
  | 'load'
  | ConstraintType;

/**
 * Handles all mouse/keyboard interaction with the sketch canvas.
 */
export class InteractionHandler {
  private doc: SketchDocument;
  private renderer: Renderer;
  private canvas: HTMLCanvasElement;

  tool: ToolMode = 'select';
  selectedEntities: Entity[] = [];
  private pendingClicks: Array<{ wx: number; wy: number; entity?: Entity; hit?: HitResult }> = [];

  // Drag state
  private isDragging = false;
  private dragGrabVars: [number, number] | null = null;
  private dragEntityId: string | null = null;

  // Pan state
  private isPanning = false;
  private panStartX = 0;
  private panStartY = 0;
  private panStartPanX = 0;
  private panStartPanY = 0;

  // Callbacks
  onStatusUpdate?: (state: string, dof: string, info: string) => void;

  constructor(doc: SketchDocument, renderer: Renderer, canvas: HTMLCanvasElement) {
    this.doc = doc;
    this.renderer = renderer;
    this.canvas = canvas;
    this.setupEventListeners();
  }

  private setupEventListeners(): void {
    this.canvas.addEventListener('mousedown', e => this.onMouseDown(e));
    this.canvas.addEventListener('mousemove', e => this.onMouseMove(e));
    this.canvas.addEventListener('mouseup', e => this.onMouseUp(e));
    this.canvas.addEventListener('wheel', e => this.onWheel(e), { passive: false });
    this.canvas.addEventListener('contextmenu', e => e.preventDefault());
    window.addEventListener('keydown', e => this.onKeyDown(e));
    window.addEventListener('resize', () => {
      this.renderer.resize();
      this.renderFrame();
    });
  }

  setTool(tool: ToolMode): void {
    this.tool = tool;
    this.pendingClicks = [];
    this.selectedEntities = [];
    this.updateStatus();
    this.renderFrame();
  }

  private onMouseDown(e: MouseEvent): void {
    const rect = this.canvas.getBoundingClientRect();
    const sx = e.clientX - rect.left;
    const sy = e.clientY - rect.top;

    // Right-click or middle-click: pan
    if (e.button === 1 || e.button === 2) {
      this.isPanning = true;
      this.panStartX = e.clientX;
      this.panStartY = e.clientY;
      this.panStartPanX = this.renderer.panX;
      this.panStartPanY = this.renderer.panY;
      return;
    }

    const [wx, wy] = this.renderer.screenToWorld(sx, sy);
    const threshold = 8 / this.renderer.zoom;
    const hits = hitTest(this.doc.entities, this.doc.q, wx, wy, threshold, threshold);

    switch (this.tool) {
      case 'select':
        this.handleSelectDown(hits, wx, wy);
        break;
      case 'delete':
        this.handleDelete(hits);
        break;
      case 'point':
        this.handleAddPoint(wx, wy);
        break;
      case 'line':
        this.handleAddLine(wx, wy, hits);
        break;
      case 'circle':
        this.handleAddCircle(wx, wy, hits);
        break;
      case 'arc':
        this.handleAddArc(wx, wy, hits);
        break;
      default:
        // Constraint tools: need entity selection
        this.handleConstraintClick(hits, wx, wy);
        break;
    }
  }

  private onMouseMove(e: MouseEvent): void {
    if (this.isPanning) {
      this.renderer.panX = this.panStartPanX + (e.clientX - this.panStartX);
      this.renderer.panY = this.panStartPanY + (e.clientY - this.panStartY);
      this.renderFrame();
      return;
    }

    if (this.isDragging && this.dragGrabVars) {
      const rect = this.canvas.getBoundingClientRect();
      const sx = e.clientX - rect.left;
      const sy = e.clientY - rect.top;
      const [wx, wy] = this.renderer.screenToWorld(sx, sy);

      this.doc.dragStep(this.dragGrabVars, [wx, wy]);
      this.renderFrame();
    }
  }

  private onMouseUp(e: MouseEvent): void {
    if (this.isPanning) {
      this.isPanning = false;
      return;
    }

    if (this.isDragging) {
      this.isDragging = false;
      this.doc.endDrag();
      this.dragGrabVars = null;
      this.dragEntityId = null;
      this.renderFrame();
    }
  }

  private onWheel(e: WheelEvent): void {
    e.preventDefault();
    const rect = this.canvas.getBoundingClientRect();
    const sx = e.clientX - rect.left;
    const sy = e.clientY - rect.top;

    const factor = e.deltaY > 0 ? 0.9 : 1.1;
    const newZoom = this.renderer.zoom * factor;

    // Zoom toward mouse position
    this.renderer.panX = sx - (sx - this.renderer.panX) * (newZoom / this.renderer.zoom);
    this.renderer.panY = sy - (sy - this.renderer.panY) * (newZoom / this.renderer.zoom);
    this.renderer.zoom = newZoom;

    this.renderFrame();
  }

  private onKeyDown(e: KeyboardEvent): void {
    if (e.key === 'Escape') {
      this.setTool('select');
    } else if (e.key === 'Delete' || e.key === 'Backspace') {
      // Delete selected entities
      for (const ent of this.selectedEntities) {
        this.doc.removeEntity(ent.id);
      }
      this.selectedEntities = [];
      this.doc.solve();
      this.renderFrame();
    }
  }

  // ─── Tool Handlers ─────────────────────────────────────────────

  private handleSelectDown(hits: HitResult[], wx: number, wy: number): void {
    if (hits.length > 0) {
      const hit = hits[0];
      this.selectedEntities = [hit.entity];

      // Start dragging
      this.isDragging = true;
      this.dragEntityId = hit.entity.id;

      // Determine which variables to grab
      if (hit.vars.length >= 2) {
        this.dragGrabVars = [hit.vars[0], hit.vars[1]];
      } else {
        this.isDragging = false;
      }

      if (this.isDragging && this.dragGrabVars) {
        this.doc.startDrag(this.dragGrabVars[0], this.dragGrabVars[1]);
      }
    } else {
      this.selectedEntities = [];
      // Start panning with left click on empty space
      this.isPanning = true;
      this.panStartX = wx * this.renderer.zoom + this.renderer.panX;
      this.panStartY = wy * this.renderer.zoom + this.renderer.panY;
      // We need screen coords for pan
      const rect = this.canvas.getBoundingClientRect();
      this.panStartX = wx * this.renderer.zoom + this.renderer.panX;
      this.panStartY = wy * this.renderer.zoom + this.renderer.panY;
      // recalc properly
      this.isPanning = false; // disable this, use middle/right click pan instead
    }
    this.updateStatus();
    this.renderFrame();
  }

  private handleDelete(hits: HitResult[]): void {
    if (hits.length > 0) {
      this.doc.removeEntity(hits[0].entity.id);
      this.doc.solve();
      this.renderFrame();
    }
  }

  private handleAddPoint(wx: number, wy: number): void {
    this.doc.addEntity('point', [wx, wy]);
    this.doc.solve();
    this.renderFrame();
  }

  private handleAddLine(wx: number, wy: number, hits: HitResult[]): void {
    this.pendingClicks.push({ wx, wy, hit: hits[0] });

    if (this.pendingClicks.length === 2) {
      const [p1, p2] = this.pendingClicks;
      const line = this.doc.addEntity('line', [p1.wx, p1.wy, p2.wx, p2.wy]);

      // Auto-coincident if clicking on existing points
      if (p1.hit?.entity.type === 'point') {
        this.doc.addConstraint('coincident', [p1.hit.entity.id, line.id]);
      }
      if (p2.hit?.entity.type === 'point') {
        // Need to create a temp point for endpoint 2 of line
        // Actually, lines have their endpoints built in, so we skip auto-coincident for now
      }

      this.pendingClicks = [];
      this.doc.solve();
      this.renderFrame();
    }
    this.updateStatus();
  }

  private handleAddCircle(wx: number, wy: number, hits: HitResult[]): void {
    this.pendingClicks.push({ wx, wy, hit: hits[0] });

    if (this.pendingClicks.length === 2) {
      const [center, edge] = this.pendingClicks;
      const r = Math.hypot(edge.wx - center.wx, edge.wy - center.wy);
      this.doc.addEntity('circle', [center.wx, center.wy, Math.max(r, 10)]);
      this.pendingClicks = [];
      this.doc.solve();
      this.renderFrame();
    }
    this.updateStatus();
  }

  private handleAddArc(wx: number, wy: number, hits: HitResult[]): void {
    this.pendingClicks.push({ wx, wy, hit: hits[0] });

    if (this.pendingClicks.length === 3) {
      const [center, start, end] = this.pendingClicks;
      const r = Math.hypot(start.wx - center.wx, start.wy - center.wy);
      const thetaStart = Math.atan2(start.wy - center.wy, start.wx - center.wx);
      const thetaEnd = Math.atan2(end.wy - center.wy, end.wx - center.wx);
      this.doc.addEntity('arc', [center.wx, center.wy, Math.max(r, 10), thetaStart, thetaEnd]);
      this.pendingClicks = [];
      this.doc.solve();
      this.renderFrame();
    }
    this.updateStatus();
  }

  private handleConstraintClick(hits: HitResult[], wx: number, wy: number): void {
    if (hits.length === 0) return;

    const hit = hits[0];
    this.pendingClicks.push({ wx, wy, entity: hit.entity, hit });

    const needed = this.getRequiredEntityCount(this.tool as ConstraintType);
    if (this.pendingClicks.length >= needed) {
      const entityIds = this.pendingClicks.map(c => c.entity!.id);

      // For dimensional constraints, prompt for value
      let params: number[] = [];
      if (this.isDimensionalConstraint(this.tool as ConstraintType)) {
        const defaultVal = this.getDefaultDimensionValue(this.tool as ConstraintType, this.pendingClicks);
        const input = prompt(`Enter value:`, String(Math.round(defaultVal * 100) / 100));
        if (input === null) {
          this.pendingClicks = [];
          return;
        }
        params = [parseFloat(input)];
      }

      this.doc.addConstraint(this.tool as ConstraintType, entityIds, params);
      this.pendingClicks = [];
      this.doc.solve();
      this.renderFrame();
    }
    this.updateStatus();
  }

  private getRequiredEntityCount(type: ConstraintType): number {
    switch (type) {
      case 'fixed':
      case 'horizontal':
      case 'vertical':
      case 'fixedLength':
      case 'fixedAngle':
      case 'fixedRadius':
        return 1;
      case 'coincident':
      case 'parallel':
      case 'perpendicular':
      case 'collinear':
      case 'equalLength':
      case 'equalRadius':
      case 'concentric':
      case 'tangentLineCircle':
      case 'tangentCircleCircle':
      case 'pointOnLine':
      case 'pointOnCircle':
      case 'midpoint':
      case 'angleBetween':
      case 'horizontalDist':
      case 'verticalDist':
        return 2;
      case 'symmetric':
        return 3;
      default:
        return 1;
    }
  }

  private isDimensionalConstraint(type: ConstraintType): boolean {
    return ['fixedLength', 'fixedAngle', 'angleBetween', 'fixedRadius', 'horizontalDist', 'verticalDist'].includes(type);
  }

  private getDefaultDimensionValue(type: ConstraintType, clicks: typeof this.pendingClicks): number {
    switch (type) {
      case 'fixedLength': {
        const ent = clicks[0]?.entity;
        if (ent?.type === 'line') {
          const v = ent.vars;
          const dx = this.doc.q[v[2]] - this.doc.q[v[0]];
          const dy = this.doc.q[v[3]] - this.doc.q[v[1]];
          return Math.hypot(dx, dy);
        }
        return 100;
      }
      case 'fixedAngle': {
        const ent = clicks[0]?.entity;
        if (ent?.type === 'line') {
          const v = ent.vars;
          return Math.atan2(this.doc.q[v[3]] - this.doc.q[v[1]], this.doc.q[v[2]] - this.doc.q[v[0]]);
        }
        return 0;
      }
      case 'fixedRadius': {
        const ent = clicks[0]?.entity;
        if (ent && (ent.type === 'circle' || ent.type === 'arc')) {
          return this.doc.q[ent.vars[2]];
        }
        return 50;
      }
      case 'horizontalDist':
      case 'verticalDist':
        return 100;
      case 'angleBetween':
        return Math.PI / 2;
      default:
        return 0;
    }
  }

  // ─── Rendering ─────────────────────────────────────────────────

  renderFrame(): void {
    const state: RenderState = {
      entities: this.doc.entities,
      constraints: this.doc.constraints,
      q: this.doc.q,
      dofState: this.doc.dofState,
      selectedEntityIds: new Set(this.selectedEntities.map(e => e.id)),
      underConstrainedIds: this.doc.underConstrainedIds,
      overConstrainedIds: this.doc.overConstrainedIds,
      draggingEntityId: this.dragEntityId,
    };
    this.renderer.render(state);
    this.updateStatus();
  }

  private updateStatus(): void {
    if (!this.onStatusUpdate) return;

    const stateStr = this.doc.state.toUpperCase();
    const dofStr = `DOF: ${this.doc.dofCount}`;
    let info = '';

    if (this.tool !== 'select') {
      const needed = this.getRequiredEntityCount(this.tool as ConstraintType);
      const have = this.pendingClicks.length;
      if (this.tool === 'line' || this.tool === 'circle' || this.tool === 'arc') {
        info = `Click ${have}/${needed === 1 ? 1 : this.tool === 'arc' ? 3 : 2} points`;
      } else if (have < needed) {
        info = `Select ${needed - have} more entit${needed - have === 1 ? 'y' : 'ies'}`;
      }
    } else if (this.selectedEntities.length > 0) {
      info = `Selected: ${this.selectedEntities.map(e => e.id).join(', ')}`;
    }

    this.onStatusUpdate(stateStr, dofStr, info);
  }
}
