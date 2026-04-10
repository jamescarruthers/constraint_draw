import { SketchDocument } from './sketch';
import { Renderer } from './ui/renderer';
import { InteractionHandler, ToolMode } from './ui/interaction';

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

  // Toolbar buttons
  const buttons = document.querySelectorAll<HTMLButtonElement>('#toolbar button');
  buttons.forEach(btn => {
    btn.addEventListener('click', () => {
      const tool = btn.dataset.tool as ToolMode;
      if (!tool) return;

      if (tool === 'save') {
        saveSketch(doc);
        return;
      }
      if (tool === 'load') {
        loadSketch(doc, renderer, handler);
        return;
      }

      // Update active button
      buttons.forEach(b => b.classList.remove('active'));
      btn.classList.add('active');

      handler.setTool(tool);
    });
  });

  // Create a demo sketch
  createDemoSketch(doc);
  doc.solve();
  handler.renderFrame();
}

function createDemoSketch(doc: SketchDocument): void {
  // Create a simple rectangle-like shape to demonstrate constraints
  const p1 = doc.addEntity('point', [100, 100]);
  const p2 = doc.addEntity('point', [300, 100]);
  const p3 = doc.addEntity('point', [300, 200]);
  const p4 = doc.addEntity('point', [100, 200]);

  const l1 = doc.addEntity('line', [100, 100, 300, 100]);
  const l2 = doc.addEntity('line', [300, 100, 300, 200]);
  const l3 = doc.addEntity('line', [300, 200, 100, 200]);
  const l4 = doc.addEntity('line', [100, 200, 100, 100]);

  // Coincident constraints to connect corners
  doc.addConstraint('coincident', [p1.id, l1.id]);   // p1 = l1.start
  doc.addConstraint('coincident', [p2.id, l2.id]);   // p2 = l2.start

  // Horizontal constraints
  doc.addConstraint('horizontal', [l1.id]);
  doc.addConstraint('horizontal', [l3.id]);

  // Vertical constraints
  doc.addConstraint('vertical', [l2.id]);
  doc.addConstraint('vertical', [l4.id]);

  // A circle for fun
  doc.addEntity('circle', [200, 150, 40]);
}

function saveSketch(doc: SketchDocument): void {
  const json = JSON.stringify(doc.toJSON(), null, 2);
  const blob = new Blob([json], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'sketch.json';
  a.click();
  URL.revokeObjectURL(url);
}

function loadSketch(
  doc: SketchDocument,
  renderer: Renderer,
  handler: InteractionHandler
): void {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = '.json';
  input.addEventListener('change', () => {
    const file = input.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const data = JSON.parse(reader.result as string);
        const newDoc = SketchDocument.fromJSON(data);
        // Copy state into existing doc
        doc.entities = newDoc.entities;
        doc.constraints = newDoc.constraints;
        doc.q = newDoc.q;
        doc.fixedVars = newDoc.fixedVars;
        doc.state = newDoc.state;
        doc.dofState = newDoc.dofState;
        doc.dofCount = newDoc.dofCount;
        doc.underConstrainedIds = newDoc.underConstrainedIds;
        doc.overConstrainedIds = newDoc.overConstrainedIds;
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
