/**
 * Inline SVG forklift used wherever the UI means "Drive" (Unicode has no forklift emoji, and 🚜 reads
 * as a farm tractor). Side view: yellow body, overhead guard, mast + forks. Sized in `em` so it
 * scales with the surrounding text (34px in the How to Play step, button font size elsewhere).
 */
const SVG_NS = 'http://www.w3.org/2000/svg';

const SHAPES: ReadonlyArray<readonly [string, Readonly<Record<string, string>>]> = [
  // Mast, carriage, forks
  ['rect', { x: '47', y: '6', width: '4', height: '46', rx: '1', fill: '#4b5563' }],
  ['rect', { x: '50', y: '30', width: '3', height: '20', fill: '#374151' }],
  ['rect', { x: '50', y: '47', width: '13', height: '3.5', rx: '1', fill: '#374151' }],
  // Overhead guard
  ['rect', { x: '13', y: '11', width: '27', height: '3.5', rx: '1.5', fill: '#374151' }],
  ['rect', { x: '14', y: '11', width: '3', height: '21', fill: '#374151' }],
  ['rect', { x: '36', y: '11', width: '3', height: '21', fill: '#374151' }],
  // Seat
  ['rect', { x: '19', y: '24', width: '7', height: '8', rx: '2', fill: '#1f2937' }],
  // Body + counterweight
  ['path', { d: 'M6 34 Q6 30 10 30 H46 V50 H10 Q6 50 6 46 Z', fill: '#facc15', stroke: '#a16207', 'stroke-width': '1.5' }],
  ['rect', { x: '6', y: '36', width: '6', height: '10', rx: '2', fill: '#eab308' }],
  // Wheels
  ['circle', { cx: '17', cy: '51', r: '7.5', fill: '#111827' }],
  ['circle', { cx: '17', cy: '51', r: '3', fill: '#9ca3af' }],
  ['circle', { cx: '39', cy: '52', r: '6.5', fill: '#111827' }],
  ['circle', { cx: '39', cy: '52', r: '2.5', fill: '#9ca3af' }],
];

const mk = (tag: string): Element =>
  typeof document.createElementNS === 'function' ? document.createElementNS(SVG_NS, tag) : document.createElement(tag);

/** Decorative (aria-hidden) forklift `<svg>`; `size` is any CSS length (default `1.15em`). */
export function forkliftIcon(size = '1.15em'): Element {
  const svg = mk('svg');
  svg.setAttribute('class', 'forklift-icon');
  svg.setAttribute('viewBox', '0 0 64 64');
  svg.setAttribute('width', size);
  svg.setAttribute('height', size);
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  for (const [tag, attrs] of SHAPES) {
    const node = mk(tag);
    for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
    svg.append(node);
  }
  return svg;
}
