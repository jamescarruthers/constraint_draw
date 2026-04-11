import {
  Entity,
  getArcParams,
  getCircleParams,
  getEllipseParams,
  getLineEndpoints,
  getPointPos,
} from './core/entity';
import { SketchDocument } from './sketch';

/**
 * SVG file format for constraint_draw sketches.
 *
 * Sketches are exported as ordinary SVG files (viewable in any browser or
 * vector editor) with the full constraint data embedded in a <metadata>
 * element using a custom namespace. On load, we parse the metadata back
 * into a SketchDocument via its existing JSON round-trip format.
 */

const SVG_NS = 'http://www.w3.org/2000/svg';
const CD_NS = 'https://github.com/jamescarruthers/constraint_draw';

const STROKE_REGULAR = '#202040';
const STROKE_CONSTRUCTION = '#808080';
const POINT_COLOR = '#202040';

interface Bounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

/** Serialise a SketchDocument to a self-contained SVG string */
export function sketchToSVG(doc: SketchDocument): string {
  const bbox = computeBoundingBox(doc);
  const padding = 30;
  const minX = bbox.minX - padding;
  const minY = bbox.minY - padding;
  const width = (bbox.maxX - bbox.minX) + 2 * padding;
  const height = (bbox.maxY - bbox.minY) + 2 * padding;

  const parts: string[] = [];
  parts.push('<?xml version="1.0" encoding="UTF-8"?>');
  parts.push(
    `<svg xmlns="${SVG_NS}" xmlns:cd="${CD_NS}" ` +
      `viewBox="${fmt(minX)} ${fmt(minY)} ${fmt(width)} ${fmt(height)}" ` +
      `width="${fmt(width)}" height="${fmt(height)}">`
  );

  // Embed the full sketch document as JSON in a metadata element.
  // Using CDATA so JSON characters don't need escaping.
  const json = JSON.stringify(doc.toJSON());
  parts.push('  <metadata>');
  parts.push(`    <cd:sketch><![CDATA[${json.replace(/\]\]>/g, ']]]]><![CDATA[>')}]]></cd:sketch>`);
  parts.push('  </metadata>');

  parts.push('  <rect x="' + fmt(minX) + '" y="' + fmt(minY) +
             '" width="' + fmt(width) + '" height="' + fmt(height) +
             '" fill="white" stroke="none" />');

  parts.push('  <g id="entities" fill="none" stroke-linecap="round" stroke-linejoin="round">');
  for (const entity of doc.entities) {
    const svg = entityToSVG(entity, doc.q);
    if (svg) parts.push('    ' + svg);
  }
  parts.push('  </g>');

  parts.push('</svg>');
  return parts.join('\n');
}

function entityToSVG(entity: Entity, q: number[]): string | null {
  const stroke = entity.construction ? STROKE_CONSTRUCTION : STROKE_REGULAR;
  const strokeWidth = entity.construction ? 1 : 1.5;
  const dash = entity.construction ? ' stroke-dasharray="6,4"' : '';
  const common =
    `stroke="${stroke}" stroke-width="${strokeWidth}"${dash}` +
    ` data-entity-id="${escapeAttr(entity.id)}"` +
    ` data-entity-type="${entity.type}"` +
    ` data-construction="${entity.construction}"`;

  switch (entity.type) {
    case 'point': {
      const [x, y] = getPointPos(entity, q);
      return `<circle cx="${fmt(x)}" cy="${fmt(y)}" r="2.5" fill="${POINT_COLOR}" ${common} />`;
    }
    case 'line': {
      const [[x1, y1], [x2, y2]] = getLineEndpoints(entity, q);
      return `<line x1="${fmt(x1)}" y1="${fmt(y1)}" x2="${fmt(x2)}" y2="${fmt(y2)}" ${common} />`;
    }
    case 'circle': {
      const { cx, cy, r } = getCircleParams(entity, q);
      return `<circle cx="${fmt(cx)}" cy="${fmt(cy)}" r="${fmt(Math.abs(r))}" ${common} />`;
    }
    case 'arc': {
      const { cx, cy, r, thetaStart, thetaEnd } = getArcParams(entity, q);
      const ra = Math.abs(r);
      const sx = cx + ra * Math.cos(thetaStart);
      const sy = cy + ra * Math.sin(thetaStart);
      const ex = cx + ra * Math.cos(thetaEnd);
      const ey = cy + ra * Math.sin(thetaEnd);
      let delta = thetaEnd - thetaStart;
      while (delta < 0) delta += 2 * Math.PI;
      while (delta > 2 * Math.PI) delta -= 2 * Math.PI;
      const largeArc = delta > Math.PI ? 1 : 0;
      const sweep = 1;
      const d = `M ${fmt(sx)} ${fmt(sy)} A ${fmt(ra)} ${fmt(ra)} 0 ${largeArc} ${sweep} ${fmt(ex)} ${fmt(ey)}`;
      return `<path d="${d}" ${common} />`;
    }
    case 'ellipse': {
      const { cx, cy, rx, ry, angle } = getEllipseParams(entity, q);
      const deg = (angle * 180) / Math.PI;
      const transform = ` transform="rotate(${fmt(deg)} ${fmt(cx)} ${fmt(cy)})"`;
      return `<ellipse cx="${fmt(cx)}" cy="${fmt(cy)}" rx="${fmt(Math.abs(rx))}" ry="${fmt(Math.abs(ry))}" ${common}${transform} />`;
    }
  }
  return null;
}

function computeBoundingBox(doc: SketchDocument): Bounds {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;

  const expand = (x: number, y: number) => {
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  };

  for (const entity of doc.entities) {
    switch (entity.type) {
      case 'point': {
        const [x, y] = getPointPos(entity, doc.q);
        expand(x, y);
        break;
      }
      case 'line': {
        const [[x1, y1], [x2, y2]] = getLineEndpoints(entity, doc.q);
        expand(x1, y1);
        expand(x2, y2);
        break;
      }
      case 'circle':
      case 'arc': {
        const { cx, cy, r } = getCircleParams(entity, doc.q);
        const ra = Math.abs(r);
        expand(cx - ra, cy - ra);
        expand(cx + ra, cy + ra);
        break;
      }
      case 'ellipse': {
        const { cx, cy, rx, ry } = getEllipseParams(entity, doc.q);
        const rmax = Math.max(Math.abs(rx), Math.abs(ry));
        expand(cx - rmax, cy - rmax);
        expand(cx + rmax, cy + rmax);
        break;
      }
    }
  }

  if (!isFinite(minX)) {
    minX = 0; minY = 0; maxX = 400; maxY = 300;
  }
  return { minX, minY, maxX, maxY };
}

/** Parse an SVG string saved by sketchToSVG and reconstruct the SketchDocument */
export function svgToSketch(svgText: string): SketchDocument {
  const parser = new DOMParser();
  const doc = parser.parseFromString(svgText, 'image/svg+xml');

  const parseError = doc.querySelector('parsererror');
  if (parseError) throw new Error('Invalid SVG: ' + parseError.textContent);

  // Look for our custom <cd:sketch> metadata element first
  let sketchEl: Element | null = null;
  const byNS = doc.getElementsByTagNameNS(CD_NS, 'sketch');
  if (byNS.length > 0) sketchEl = byNS[0];
  if (!sketchEl) sketchEl = doc.querySelector('metadata > sketch, metadata > *');
  if (!sketchEl || !sketchEl.textContent) {
    throw new Error('No constraint_draw metadata found in SVG (was it saved by this tool?)');
  }

  const json = sketchEl.textContent.trim();
  let data: { entities: unknown[]; constraints: unknown[] };
  try {
    data = JSON.parse(json);
  } catch (err) {
    throw new Error('Failed to parse sketch metadata: ' + err);
  }

  return SketchDocument.fromJSON(data as { entities: any[]; constraints: any[] });
}

/** Format a number with limited precision */
function fmt(n: number): string {
  return Number.isFinite(n) ? Number(n.toFixed(3)).toString() : '0';
}

function escapeAttr(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}
