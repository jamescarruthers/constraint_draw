import { SketchDocument } from './sketch';
import { Renderer } from './ui/renderer';
import { InteractionHandler, ToolMode } from './ui/interaction';
import { sketchToSVG, svgToSketch } from './svgio';
import { renderInfoPanel } from './ui/infopanel';

function main(): void {
  const canvas = document.getElementById('sketch-canvas') as HTMLCanvasElement;
  if (!canvas) throw new Error('Canvas not found');

  const doc = new SketchDocument();
  const renderer = new Renderer(canvas);
  const handler = new InteractionHandler(doc, renderer, canvas);

  // Center the view
  renderer.panX = renderer['width'] / 2;
  renderer.panY = renderer['height'] / 2;

  // Status bar updates
  const stateEl = document.getElementById('status-state')!;
  const dofEl = document.getElementById('status-dof')!;
  const infoEl = document.getElementById('status-info')!;

  handler.onStatusUpdate = (state, dof, info) => {
    stateEl.textContent = state;
    dofEl.textContent = dof;
    dofEl.className = doc.dofState === 'fully-constrained'
      ? 'dof-ok'
      : doc.dofState === 'under-constrained'
        ? 'dof-under'
        : 'dof-over';
    infoEl.textContent = info;
  };

  // Info panel (right side)
  const infoPanelEl = document.getElementById('info-panel')!;
  handler.onInfoPanelUpdate = (selected) => {
    renderInfoPanel(infoPanelEl, doc, selected, {
      onDeleteConstraint: (id) => {
        doc.pushUndo();
        doc.removeConstraint(id);
        doc.solve();
        handler.renderFrame();
      },
      onEditConstraintValue: (id, value) => {
        doc.pushUndo();
        doc.updateConstraintParams(id, [value]);
        doc.solve();
        handler.renderFrame();
      },
      onReassignConstraint: (id, slot, newEntityId) => {
        doc.pushUndo();
        doc.reassignConstraintEntity(id, slot, newEntityId);
        doc.solve();
        handler.renderFrame();
      },
      onRenameEntity: (oldId, newId) => {
        doc.pushUndo();
        const ok = doc.renameEntity(oldId, newId);
        if (ok) handler.renderFrame();
        else doc.dropLastUndo();
        return ok;
      },
    });
  };

  // Toolbar buttons
  const buttons = document.querySelectorAll<HTMLButtonElement>('#toolbar button');

  const setActiveButton = (tool: ToolMode) => {
    buttons.forEach(b => {
      // Skip action buttons — only one tool button is "active" at a time.
      if (b.dataset.action) return;
      if (b.dataset.tool === tool) b.classList.add('active');
      else b.classList.remove('active');
    });
  };

  const updateConstructionBtn = () => {
    const btn = document.querySelector<HTMLButtonElement>('[data-action="constructionMode"]');
    if (!btn) return;
    btn.textContent = `Construction Mode: ${handler.constructionMode ? 'ON' : 'OFF'}`;
    btn.classList.toggle('active', handler.constructionMode);
  };

  // Keep toolbar in sync when handler auto-returns to select
  handler.onToolChange = (tool) => setActiveButton(tool);

  buttons.forEach(btn => {
    btn.addEventListener('click', () => {
      const action = btn.dataset.action;
      const tool = btn.dataset.tool as ToolMode | undefined;

      if (action === 'save') {
        saveSketch(doc);
        return;
      }
      if (action === 'load') {
        loadSketch(doc, handler);
        return;
      }
      if (action === 'constructionMode') {
        handler.setConstructionMode(!handler.constructionMode);
        updateConstructionBtn();
        handler.renderFrame();
        return;
      }

      if (!tool) return;
      setActiveButton(tool);
      handler.setTool(tool);
    });
  });

  // Create a demo sketch
  createDemoSketch(doc);
  doc.solve();
  handler.renderFrame();
  updateConstructionBtn();
}

function createDemoSketch(doc: SketchDocument): void {
  // Four lines forming a rough rectangle, with coincident constraints
  // joining their endpoints (showing the line-endpoint coincident fix).
  const l1 = doc.addEntity('line', [100, 100, 300, 100]);
  const l2 = doc.addEntity('line', [300, 100, 300, 200]);
  const l3 = doc.addEntity('line', [300, 200, 100, 200]);
  const l4 = doc.addEntity('line', [100, 200, 100, 100]);

  // Join corners: l1.p2 = l2.p1, l2.p2 = l3.p1, l3.p2 = l4.p1, l4.p2 = l1.p1
  const join = (a: typeof l1, aEnd: 'p1' | 'p2', b: typeof l1, bEnd: 'p1' | 'p2') => {
    const av: [number, number] = aEnd === 'p1'
      ? [a.vars[0], a.vars[1]]
      : [a.vars[2], a.vars[3]];
    const bv: [number, number] = bEnd === 'p1'
      ? [b.vars[0], b.vars[1]]
      : [b.vars[2], b.vars[3]];
    doc.addConstraint('coincident', [a.id, b.id], [], undefined, [av, bv]);
  };

  join(l1, 'p2', l2, 'p1');
  join(l2, 'p2', l3, 'p1');
  join(l3, 'p2', l4, 'p1');
  join(l4, 'p2', l1, 'p1');

  doc.addConstraint('horizontal', [l1.id]);
  doc.addConstraint('horizontal', [l3.id]);
  doc.addConstraint('vertical', [l2.id]);
  doc.addConstraint('vertical', [l4.id]);

  // A circle for fun
  doc.addEntity('circle', [200, 150, 40]);
}

function saveSketch(doc: SketchDocument): void {
  const svg = sketchToSVG(doc);
  const blob = new Blob([svg], { type: 'image/svg+xml' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'sketch.svg';
  a.click();
  URL.revokeObjectURL(url);
}

function loadSketch(doc: SketchDocument, handler: InteractionHandler): void {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = '.svg,image/svg+xml';
  input.addEventListener('change', () => {
    const file = input.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const newDoc = svgToSketch(reader.result as string);
        // Copy state into existing doc so the handler's reference stays valid
        doc.entities = newDoc.entities;
        doc.constraints = newDoc.constraints;
        doc.q = newDoc.q;
        doc.fixedVars = newDoc.fixedVars;
        doc.state = newDoc.state;
        doc.dofState = newDoc.dofState;
        doc.dofCount = newDoc.dofCount;
        doc.underConstrainedIds = newDoc.underConstrainedIds;
        doc.overConstrainedIds = newDoc.overConstrainedIds;
        doc.lastSolveMs = newDoc.lastSolveMs;
        handler.renderFrame();
      } catch (err) {
        alert('Failed to load sketch: ' + err);
      }
    };
    reader.readAsText(file);
  });
  input.click();
}

// Boot
main();
