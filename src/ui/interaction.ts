import { SketchDocument } from '../sketch';
import { Renderer, RenderState, DrawingPreview } from './renderer';
import { hitTest, HitResult } from './hittest';
import { ConstraintType } from '../core/types';
import { Entity, getLineEndpoints } from '../core/entity';

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

interface PendingClick {
  wx: number;
  wy: number;
  entity?: Entity;
  hit?: HitResult;
}

/**
 * Handles all mouse/keyboard interaction with the sketch canvas.
 */
export class InteractionHandler {
  private doc: SketchDocument;
  private renderer: Renderer;
  private canvas: HTMLCanvasElement;

  tool: ToolMode = 'select';
  selectedEntities: Entity[] = [];
  private pendingClicks: PendingClick[] = [];

  /** When true, newly drawn entities are marked as construction geometry */
  constructionMode = false;

  /** Current mouse world position — used for drawing previews */
  private mouseWorld: [number, number] = [0, 0];

  /** Currently hovered hit (for highlight feedback in targeting modes) */
  private hoveredHit: HitResult | null = null;

  // Drag state
  private isDragging = false;
  private dragGrabVars: [number, number] | null = null;
  private dragEntityId: string | null = null;
  /** Whether we've already pushed an undo snapshot for the active drag */
  private pushedUndoForDrag = false;

  /** Active rigid line-body drag state (perpendicular translation) */
  private lineBodyDrag: {
    line: Entity;
    origP1: [number, number];
    origP2: [number, number];
    perpDir: [number, number];
    origCursor: [number, number];
  } | null = null;

  /** World position of the most recent click — used for "cycle" detection */
  private lastClickWorld: [number, number] | null = null;
  /** Entity id chosen on the most recent click (for cycling past it) */
  private lastClickPickedEntityId: string | null = null;

  // Pan state
  private isPanning = false;
  private panStartX = 0;
  private panStartY = 0;
  private panStartPanX = 0;
  private panStartPanY = 0;

  // Callbacks
  onStatusUpdate?: (state: string, dof: string, info: string) => void;
  onToolChange?: (tool: ToolMode) => void;
  onInfoPanelUpdate?: (selected: Entity[]) => void;

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
    this.canvas.addEventListener('mouseleave', () => {
      if (this.hoveredHit !== null) {
        this.hoveredHit = null;
        this.renderFrame();
      }
    });
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
    this.hoveredHit = null;
    this.onToolChange?.(tool);
    this.updateStatus();
    this.renderFrame();
  }

  /** Return to select mode once a drawing or constraint action completes. */
  private returnToSelect(): void {
    if (this.tool === 'select') return;
    this.setTool('select');
  }

  private getMouseWorld(e: MouseEvent): [number, number] {
    const rect = this.canvas.getBoundingClientRect();
    const sx = e.clientX - rect.left;
    const sy = e.clientY - rect.top;
    return this.renderer.screenToWorld(sx, sy);
  }

  private onMouseDown(e: MouseEvent): void {
    const [wx, wy] = this.getMouseWorld(e);
    this.mouseWorld = [wx, wy];

    // Right-click or middle-click: pan
    if (e.button === 1 || e.button === 2) {
      this.isPanning = true;
      this.panStartX = e.clientX;
      this.panStartY = e.clientY;
      this.panStartPanX = this.renderer.panX;
      this.panStartPanY = this.renderer.panY;
      return;
    }

    const threshold = 8 / this.renderer.zoom;
    const hits = hitTest(this.doc.entities, this.doc.q, wx, wy, threshold, threshold);

    switch (this.tool) {
      case 'select':
        this.handleSelectDown(hits);
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

  /** Toggle construction mode — newly drawn entities become construction while on */
  setConstructionMode(on: boolean): void {
    this.constructionMode = on;
    this.updateStatus();
  }

  /** Apply the current construction mode to a freshly created entity */
  private applyConstructionMode(entity: Entity): void {
    if (this.constructionMode) entity.construction = true;
  }

  private onMouseMove(e: MouseEvent): void {
    const [wx, wy] = this.getMouseWorld(e);
    this.mouseWorld = [wx, wy];

    if (this.isPanning) {
      this.renderer.panX = this.panStartPanX + (e.clientX - this.panStartX);
      this.renderer.panY = this.panStartPanY + (e.clientY - this.panStartY);
      this.renderFrame();
      return;
    }

    if (this.lineBodyDrag) {
      const st = this.lineBodyDrag;
      const cdx = wx - st.origCursor[0];
      const cdy = wy - st.origCursor[1];
      // Project the cursor delta onto the line's perpendicular direction
      // and translate both endpoints by that projected offset.
      const perp = cdx * st.perpDir[0] + cdy * st.perpDir[1];
      // Only push undo once we actually start moving (so a plain click
      // that doesn't drag doesn't create a no-op undo entry).
      if (!this.pushedUndoForDrag && Math.abs(perp) > 1e-6) {
        this.doc.pushUndo();
        this.pushedUndoForDrag = true;
      }
      const ox = perp * st.perpDir[0];
      const oy = perp * st.perpDir[1];
      this.doc.translateLineRigid(
        st.line,
        [st.origP1[0] + ox, st.origP1[1] + oy],
        [st.origP2[0] + ox, st.origP2[1] + oy]
      );
      this.renderFrame();
      return;
    }

    if (this.isDragging && this.dragGrabVars) {
      if (!this.pushedUndoForDrag) {
        this.doc.pushUndo();
        this.pushedUndoForDrag = true;
      }
      this.doc.dragStep(this.dragGrabVars, [wx, wy]);
      this.renderFrame();
      return;
    }

    // Update hover for any "targeting" tool (select, delete, or any
    // constraint tool). Drawing tools (point/line/circle/arc) rely on the
    // snap-target marker instead. The hover target is picked with the same
    // smart logic as click (prefer selected entity, cycle on repeat), so
    // the highlight always matches what a click would actually hit.
    const targeting = this.isTargetingTool(this.tool);
    const prevHoverKey = this.hoverKey(this.hoveredHit);
    if (targeting) {
      const threshold = 8 / this.renderer.zoom;
      const hits = hitTest(this.doc.entities, this.doc.q, wx, wy, threshold, threshold);
      this.hoveredHit = hits.length > 0 ? this.pickBestHit(hits) : null;
    } else {
      this.hoveredHit = null;
    }
    const hoverChanged = this.hoverKey(this.hoveredHit) !== prevHoverKey;

    // If in a drawing tool with pending clicks, repaint for preview
    if (this.pendingClicks.length > 0 &&
        (this.tool === 'line' || this.tool === 'circle' || this.tool === 'arc')) {
      this.renderFrame();
      return;
    }

    if (hoverChanged || targeting) {
      this.renderFrame();
    }
  }

  private hoverKey(h: HitResult | null): string {
    if (!h) return '';
    return `${h.entity.id}:${h.part}`;
  }

  /** Tools where hovering over an entity gives meaningful feedback */
  private isTargetingTool(tool: ToolMode): boolean {
    if (tool === 'select' || tool === 'delete') return true;
    if (tool === 'point' || tool === 'line' || tool === 'circle' || tool === 'arc') return false;
    if (tool === 'save' || tool === 'load') return false;
    return true; // any ConstraintType
  }

  private onMouseUp(_e: MouseEvent): void {
    if (this.isPanning) {
      this.isPanning = false;
      return;
    }

    if (this.lineBodyDrag) {
      this.lineBodyDrag = null;
      this.isDragging = false;
      this.dragEntityId = null;
      this.pushedUndoForDrag = false;
      this.doc.endDrag();
      this.renderFrame();
      return;
    }

    if (this.isDragging) {
      this.isDragging = false;
      this.doc.endDrag();
      this.dragGrabVars = null;
      this.dragEntityId = null;
      this.pushedUndoForDrag = false;
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
    // Skip key handling if the user is typing in an input/select elsewhere
    // (e.g. the info panel's editable value / id inputs).
    const tgt = e.target as HTMLElement | null;
    if (tgt && (tgt.tagName === 'INPUT' || tgt.tagName === 'SELECT' || tgt.tagName === 'TEXTAREA')) {
      // Still allow Escape to blur
      if (e.key === 'Escape') (tgt as HTMLElement).blur();
      return;
    }

    // Undo / redo
    const mod = e.metaKey || e.ctrlKey;
    if (mod && (e.key === 'z' || e.key === 'Z')) {
      e.preventDefault();
      if (this.isDragging) return;
      if (e.shiftKey) {
        if (this.doc.redo()) this.renderFrame();
      } else {
        if (this.doc.undo()) this.renderFrame();
      }
      return;
    }
    if (mod && (e.key === 'y' || e.key === 'Y')) {
      // Ctrl+Y = redo (Windows convention)
      e.preventDefault();
      if (this.isDragging) return;
      if (this.doc.redo()) this.renderFrame();
      return;
    }

    if (e.key === 'Escape') {
      this.setTool('select');
    } else if (e.key === 'Delete' || e.key === 'Backspace') {
      if (this.selectedEntities.length === 0) return;
      this.doc.pushUndo();
      for (const ent of this.selectedEntities) {
        this.doc.removeEntity(ent.id);
      }
      this.selectedEntities = [];
      this.doc.solve();
      this.renderFrame();
    } else if ((e.key === 'c' || e.key === 'C') && this.selectedEntities.length > 0) {
      this.doc.pushUndo();
      for (const ent of this.selectedEntities) {
        this.doc.toggleConstruction(ent.id);
      }
      this.renderFrame();
    }
  }

  // ─── Tool Handlers ─────────────────────────────────────────────

  private handleSelectDown(hits: HitResult[]): void {
    if (hits.length > 0) {
      const hit = this.pickBestHit(hits);
      this.selectedEntities = [hit.entity];
      this.lastClickWorld = [...this.mouseWorld] as [number, number];
      this.lastClickPickedEntityId = hit.entity.id;

      // Special case: grabbing the BODY of a line kicks off a rigid
      // perpendicular translation rather than a point-grab drag, so the
      // whole line slides sideways while keeping length/direction.
      if (hit.entity.type === 'line' && hit.part === 'body') {
        const [[x1, y1], [x2, y2]] = getLineEndpoints(hit.entity, this.doc.q);
        const dx = x2 - x1, dy = y2 - y1;
        const len = Math.hypot(dx, dy) || 1;
        this.lineBodyDrag = {
          line: hit.entity,
          origP1: [x1, y1],
          origP2: [x2, y2],
          perpDir: [-dy / len, dx / len],
          origCursor: [...this.mouseWorld] as [number, number],
        };
        this.isDragging = true;
        this.dragEntityId = hit.entity.id;
        this.updateStatus();
        this.renderFrame();
        return;
      }

      // Start dragging the specific sub-part (endpoint, center, etc.)
      this.isDragging = true;
      this.dragEntityId = hit.entity.id;

      if (hit.vars.length >= 2) {
        this.dragGrabVars = [hit.vars[0], hit.vars[1]];
      } else {
        this.isDragging = false;
      }

      if (this.isDragging && this.dragGrabVars) {
        // When dragging a line endpoint, temporarily pin the OTHER endpoint
        // so the line rotates/stretches around its anchor instead of
        // translating the whole line.
        const tempFixed = this.computeTempFixedForDrag(hit);
        this.doc.startDrag(this.dragGrabVars[0], this.dragGrabVars[1], tempFixed);
      }
    } else {
      this.selectedEntities = [];
    }
    this.updateStatus();
    this.renderFrame();
  }

  /**
   * When grabbing a specific sub-part of an entity, return the list of
   * variable indices to temporarily pin for the duration of the drag.
   *   - Line endpoint: pin the opposite endpoint.
   *   - Arc endpoint: pin the center and the opposite endpoint, so the
   *     dragged endpoint slides along the arc's circle (radius preserved).
   */
  private computeTempFixedForDrag(hit: HitResult): number[] {
    const e = hit.entity;
    if (e.type === 'line') {
      if (hit.part === 'p1') return [e.vars[2], e.vars[3]];
      if (hit.part === 'p2') return [e.vars[0], e.vars[1]];
    }
    if (e.type === 'arc') {
      // Pin center + the non-grabbed endpoint
      if (hit.part === 'p1') return [e.vars[0], e.vars[1], e.vars[7], e.vars[8]];
      if (hit.part === 'p2') return [e.vars[0], e.vars[1], e.vars[5], e.vars[6]];
    }
    return [];
  }

  /**
   * Choose the "best" hit from a sorted hit-test result list, applying
   * two smart heuristics to help disambiguate co-located endpoints:
   *
   *   1. **Cycle-on-repeat**: if the user clicks the same spot they
   *      just clicked (within a small threshold), rotate past the
   *      entity that was picked last time. This lets them cycle
   *      through stacked endpoints with repeated clicks.
   *
   *   2. **Prefer selected entity**: if there's no repeat-click but
   *      there IS a currently-selected entity, prefer a hit whose
   *      entity id matches the selection. So clicking a line body
   *      and then clicking one of its endpoints picks *that* line's
   *      endpoint over a coincident one from another line.
   *
   * Falls back to the first hit (which is already priority-sorted
   * endpoints > centers > bodies, then by distance) when neither
   * heuristic applies.
   */
  private pickBestHit(hits: HitResult[]): HitResult {
    if (hits.length <= 1) return hits[0];

    const CYCLE_RADIUS = 6 / this.renderer.zoom;
    const isRepeat =
      this.lastClickWorld !== null &&
      Math.hypot(
        this.mouseWorld[0] - this.lastClickWorld[0],
        this.mouseWorld[1] - this.lastClickWorld[1]
      ) < CYCLE_RADIUS;

    if (isRepeat && this.lastClickPickedEntityId) {
      // Deduplicate by entity id so we cycle through distinct entities
      // rather than sub-parts of the same one.
      const seen = new Set<string>();
      const unique: HitResult[] = [];
      for (const h of hits) {
        if (!seen.has(h.entity.id)) {
          seen.add(h.entity.id);
          unique.push(h);
        }
      }
      const currentIdx = unique.findIndex(h => h.entity.id === this.lastClickPickedEntityId);
      if (currentIdx >= 0 && unique.length > 1) {
        const nextIdx = (currentIdx + 1) % unique.length;
        return unique[nextIdx];
      }
    }

    // Prefer sub-parts of the currently-selected entity
    if (this.selectedEntities.length > 0) {
      const selId = this.selectedEntities[0].id;
      const preferred = hits.find(h => h.entity.id === selId);
      if (preferred) return preferred;
    }

    return hits[0];
  }

  private handleDelete(hits: HitResult[]): void {
    if (hits.length > 0) {
      this.doc.pushUndo();
      this.doc.removeEntity(hits[0].entity.id);
      this.doc.solve();
      this.returnToSelect();
    }
  }

  private handleAddPoint(wx: number, wy: number): void {
    this.doc.pushUndo();
    const p = this.doc.addEntity('point', [wx, wy]);
    this.applyConstructionMode(p);
    this.doc.solve();
    this.returnToSelect();
  }

  private handleAddLine(wx: number, wy: number, hits: HitResult[]): void {
    // Snap to existing points/endpoints if close
    const snap = this.pickSnap(hits);
    const px = snap?.pos[0] ?? wx;
    const py = snap?.pos[1] ?? wy;

    this.pendingClicks.push({ wx: px, wy: py, entity: hits[0]?.entity, hit: hits[0] });

    if (this.pendingClicks.length === 2) {
      const [p1, p2] = this.pendingClicks;
      this.doc.pushUndo();
      const line = this.doc.addEntity('line', [p1.wx, p1.wy, p2.wx, p2.wy]);
      this.applyConstructionMode(line);

      // Auto-coincident line endpoints with clicked existing points/line-endpoints
      this.autoCoincidentEndpoint(line, 0, p1.hit);
      this.autoCoincidentEndpoint(line, 1, p2.hit);

      this.pendingClicks = [];
      this.doc.solve();
      this.returnToSelect();
      return;
    }
    this.updateStatus();
    this.renderFrame();
  }

  /**
   * If a line endpoint was clicked over an existing point or line/arc
   * endpoint, emit a coincident constraint between the new line's endpoint
   * and that point. The constraint is tagged with sub-part labels so that
   * save/load and undo/redo preserve which specific endpoints are joined.
   * @param endpointIdx 0 for p1, 1 for p2
   */
  private autoCoincidentEndpoint(line: Entity, endpointIdx: 0 | 1, hit?: HitResult): void {
    if (!hit) return;
    const other = hit.entity;
    if (other.id === line.id) return;

    const lineSubPart = endpointIdx === 0 ? 'p1' : 'p2';
    const otherSubPart = this.hitToSubPart(hit);
    if (otherSubPart === null) return;

    this.doc.addConstraint(
      'coincident',
      [line.id, other.id],
      [],
      undefined,
      [lineSubPart, otherSubPart]
    );
  }

  /**
   * Convert a hit result into a sub-part label suitable for
   * addConstraint's subParts parameter, or null if the hit isn't on a
   * point-like sub-part (e.g. a line body).
   */
  private hitToSubPart(hit?: HitResult): string | null {
    if (!hit) return null;
    const e = hit.entity;
    if (e.type === 'point') return 'p1';
    if (e.type === 'line') {
      if (hit.part === 'p1') return 'p1';
      if (hit.part === 'p2') return 'p2';
      return null;
    }
    if (e.type === 'arc') {
      if (hit.part === 'center') return 'center';
      if (hit.part === 'p1') return 'p1';
      if (hit.part === 'p2') return 'p2';
      return null;
    }
    if (e.type === 'circle' || e.type === 'ellipse') {
      if (hit.part === 'center') return 'center';
      return null;
    }
    return null;
  }

  /** Return snap target position if the top hit is a point-like sub-part */
  private pickSnap(hits: HitResult[]): { pos: [number, number] } | null {
    for (const h of hits) {
      if (h.entity.type === 'point') {
        return { pos: [this.doc.q[h.entity.vars[0]], this.doc.q[h.entity.vars[1]]] };
      }
      if (h.entity.type === 'line') {
        if (h.part === 'p1') return { pos: [this.doc.q[h.entity.vars[0]], this.doc.q[h.entity.vars[1]]] };
        if (h.part === 'p2') return { pos: [this.doc.q[h.entity.vars[2]], this.doc.q[h.entity.vars[3]]] };
      }
      if (h.entity.type === 'arc') {
        if (h.part === 'p1') return { pos: [this.doc.q[h.entity.vars[5]], this.doc.q[h.entity.vars[6]]] };
        if (h.part === 'p2') return { pos: [this.doc.q[h.entity.vars[7]], this.doc.q[h.entity.vars[8]]] };
        if (h.part === 'center') return { pos: [this.doc.q[h.entity.vars[0]], this.doc.q[h.entity.vars[1]]] };
      }
      if (h.entity.type === 'circle' && h.part === 'center') {
        return { pos: [this.doc.q[h.entity.vars[0]], this.doc.q[h.entity.vars[1]]] };
      }
    }
    return null;
  }

  private handleAddCircle(wx: number, wy: number, hits: HitResult[]): void {
    const snap = this.pickSnap(hits);
    const px = snap?.pos[0] ?? wx;
    const py = snap?.pos[1] ?? wy;
    this.pendingClicks.push({ wx: px, wy: py, entity: hits[0]?.entity, hit: hits[0] });

    if (this.pendingClicks.length === 2) {
      const [center, edge] = this.pendingClicks;
      this.doc.pushUndo();
      const r = Math.hypot(edge.wx - center.wx, edge.wy - center.wy);
      const c = this.doc.addEntity('circle', [center.wx, center.wy, Math.max(r, 10)]);
      this.applyConstructionMode(c);
      this.pendingClicks = [];
      this.doc.solve();
      this.returnToSelect();
      return;
    }
    this.updateStatus();
    this.renderFrame();
  }

  private handleAddArc(wx: number, wy: number, hits: HitResult[]): void {
    const snap = this.pickSnap(hits);
    const px = snap?.pos[0] ?? wx;
    const py = snap?.pos[1] ?? wy;
    this.pendingClicks.push({ wx: px, wy: py, entity: hits[0]?.entity, hit: hits[0] });

    if (this.pendingClicks.length === 3) {
      const [center, start, end] = this.pendingClicks;
      this.doc.pushUndo();
      const r = Math.hypot(start.wx - center.wx, start.wy - center.wy);
      const thetaStart = Math.atan2(start.wy - center.wy, start.wx - center.wx);
      const thetaEnd = Math.atan2(end.wy - center.wy, end.wx - center.wx);
      const a = this.doc.addEntity('arc', [center.wx, center.wy, Math.max(r, 10), thetaStart, thetaEnd]);
      this.applyConstructionMode(a);

      // Auto-coincident the arc endpoints with any clicked existing
      // points or line/arc endpoints (mirroring line-drawing behavior).
      this.autoCoincidentArcEndpoint(a, 'p1', start.hit);
      this.autoCoincidentArcEndpoint(a, 'p2', end.hit);

      this.pendingClicks = [];
      this.doc.solve();
      this.returnToSelect();
      return;
    }
    this.updateStatus();
    this.renderFrame();
  }

  /** Coincident an arc's start/end endpoint with an existing entity's
   *  point sub-part, analogous to autoCoincidentEndpoint for lines. */
  private autoCoincidentArcEndpoint(arc: Entity, which: 'p1' | 'p2', hit?: HitResult): void {
    if (!hit) return;
    const other = hit.entity;
    if (other.id === arc.id) return;

    const otherSubPart = this.hitToSubPart(hit);
    if (otherSubPart === null) return;

    this.doc.addConstraint(
      'coincident',
      [arc.id, other.id],
      [],
      undefined,
      [which, otherSubPart]
    );
  }

  private handleConstraintClick(hits: HitResult[], wx: number, wy: number): void {
    if (hits.length === 0) return;

    const hit = this.pickBestHit(hits);
    this.pendingClicks.push({ wx, wy, entity: hit.entity, hit });

    const needed = this.getRequiredEntityCount(this.tool as ConstraintType);
    if (this.pendingClicks.length >= needed) {
      const entityIds = this.pendingClicks.map(c => c.entity!.id);

      // Build per-entity sub-part labels based on which specific sub-part
      // the user clicked. This is stored on the resulting constraint and
      // round-trips through serialisation and undo/redo.
      const subParts = this.pendingClicks.map(c => this.hitToSubPart(c.hit));

      // For dimensional constraints, prompt for value
      let params: number[] = [];
      if (this.isDimensionalConstraint(this.tool as ConstraintType)) {
        const defaultVal = this.getDefaultDimensionValue(this.tool as ConstraintType, this.pendingClicks);
        const input = prompt(`Enter value:`, String(Math.round(defaultVal * 100) / 100));
        if (input === null) {
          this.pendingClicks = [];
          this.updateStatus();
          this.renderFrame();
          return;
        }
        params = [parseFloat(input)];
      }

      this.doc.pushUndo();
      this.doc.addConstraint(this.tool as ConstraintType, entityIds, params, undefined, subParts);
      this.pendingClicks = [];
      this.doc.solve();
      this.returnToSelect();
      return;
    }
    this.updateStatus();
    this.renderFrame();
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

  private getDefaultDimensionValue(type: ConstraintType, clicks: PendingClick[]): number {
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
    const constrainedVars = this.computeConstrainedVars();
    const state: RenderState = {
      entities: this.doc.entities,
      constraints: this.doc.constraints,
      q: this.doc.q,
      dofState: this.doc.dofState,
      selectedEntityIds: new Set(this.selectedEntities.map(e => e.id)),
      underConstrainedIds: this.doc.underConstrainedIds,
      overConstrainedIds: this.doc.overConstrainedIds,
      draggingEntityId: this.dragEntityId,
      constrainedVars,
      drawingPreview: this.getDrawingPreview(),
      snapTarget: this.getSnapTarget(),
      hoveredEntityId: this.hoveredHit?.entity.id ?? null,
      hoveredPart: this.hoveredHit?.part ?? null,
    };
    this.renderer.render(state);
    this.updateStatus();
    this.onInfoPanelUpdate?.(this.selectedEntities);
  }

  /** Collect the set of variable indices referenced by at least one constraint */
  private computeConstrainedVars(): Set<number> {
    const result = new Set<number>();
    for (const c of this.doc.constraints) {
      for (const e of c.jacobianEntries(this.doc.q, 0)) {
        result.add(e.col);
      }
    }
    return result;
  }

  /** Build the drawing preview state based on pending clicks and current mouse */
  private getDrawingPreview(): DrawingPreview | null {
    if (this.pendingClicks.length === 0) return null;
    const [mx, my] = this.mouseWorld;

    if (this.tool === 'line' && this.pendingClicks.length === 1) {
      const p1 = this.pendingClicks[0];
      return { type: 'line', points: [[p1.wx, p1.wy], [mx, my]] };
    }

    if (this.tool === 'circle' && this.pendingClicks.length === 1) {
      const c = this.pendingClicks[0];
      return { type: 'circle', center: [c.wx, c.wy], radiusPoint: [mx, my] };
    }

    if (this.tool === 'arc') {
      if (this.pendingClicks.length === 1) {
        // Show a crosshair for start-of-radius
        const c = this.pendingClicks[0];
        return { type: 'arcRadius', center: [c.wx, c.wy], radiusPoint: [mx, my] };
      }
      if (this.pendingClicks.length === 2) {
        const c = this.pendingClicks[0];
        const s = this.pendingClicks[1];
        return { type: 'arc', center: [c.wx, c.wy], start: [s.wx, s.wy], end: [mx, my] };
      }
    }

    return null;
  }

  /** If current mouse is over a snap target (existing point/endpoint/center), return it */
  private getSnapTarget(): [number, number] | null {
    if (this.tool === 'select' || this.tool === 'delete') return null;
    const threshold = 8 / this.renderer.zoom;
    const hits = hitTest(this.doc.entities, this.doc.q, this.mouseWorld[0], this.mouseWorld[1], threshold, threshold);
    const snap = this.pickSnap(hits);
    return snap?.pos ?? null;
  }

  private updateStatus(): void {
    if (!this.onStatusUpdate) return;

    const cm = this.constructionMode ? '[CONSTRUCTION] ' : '';
    const stateStr = cm + this.doc.state.toUpperCase();
    const ms = this.doc.lastSolveMs;
    const msStr = ms < 1 ? `${ms.toFixed(2)}ms` : `${ms.toFixed(1)}ms`;
    const dofStr = `DOF: ${this.doc.dofCount} · solve ${msStr}`;
    let info = '';

    const have = this.pendingClicks.length;

    if (this.tool === 'line') {
      info = have === 0 ? 'Click first point' : 'Click second point';
    } else if (this.tool === 'circle') {
      info = have === 0 ? 'Click center' : 'Click radius point';
    } else if (this.tool === 'arc') {
      if (have === 0) info = 'Click center';
      else if (have === 1) info = 'Click start point';
      else info = 'Click end point';
    } else if (this.tool !== 'select' && this.tool !== 'delete' && this.tool !== 'point') {
      const needed = this.getRequiredEntityCount(this.tool as ConstraintType);
      if (have < needed) {
        info = `Select ${needed - have} more entit${needed - have === 1 ? 'y' : 'ies'}`;
      }
    } else if (this.selectedEntities.length > 0) {
      info = `Selected: ${this.selectedEntities.map(e => e.id).join(', ')}`;
    }

    this.onStatusUpdate(stateStr, dofStr, info);
  }
}
