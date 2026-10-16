/**
 * Pure 2:1 isometric projection + camera math, ported from the mock's
 * `<script id="render">` block (TW=64, TH=32). No DOM access: safe for node tests.
 *
 * Camera convention (same as the mock): `cam.x/cam.y` is the screen position (CSS px)
 * of grid origin (0,0,z=0); `cam.zoom` scales the iso plane.
 */

export const TW = 64;
export const TH = 32;
export const ZOOM_MIN = 0.12;
export const ZOOM_MAX = 3.2;

export interface Camera {
  x: number;
  y: number;
  zoom: number;
}

export const clampZoom = (z: number): number => Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, z));

/** Screen X of grid point (gx, gy). */
export const screenX = (cam: Camera, gx: number, gy: number): number =>
  cam.x + (((gx - gy) * TW) / 2) * cam.zoom;

/** Screen Y of grid point (gx, gy) raised by z iso-pixels. */
export const screenY = (cam: Camera, gx: number, gy: number, z = 0): number =>
  cam.y + (((gx + gy) * TH) / 2 - z) * cam.zoom;

/** Project grid (gx, gy, z) to screen [sx, sy]. */
export function project(cam: Camera, gx: number, gy: number, z = 0): [number, number] {
  return [screenX(cam, gx, gy), screenY(cam, gx, gy, z)];
}

/** Inverse of `project` on the floor plane (z = 0). Returns fractional tile coords. */
export function unproject(cam: Camera, sx: number, sy: number): { x: number; y: number } {
  const ix = (sx - cam.x) / cam.zoom;
  const iy = (sy - cam.y) / cam.zoom;
  return { x: iy / TH + ix / TW, y: iy / TH - ix / TW };
}

/** Unscaled iso-pixel bounding box of a mapW x mapH floor (plus 60px headroom, as in the mock). */
export function isoBounds(mapW: number, mapH: number): { w: number; h: number } {
  return { w: ((mapW + mapH) * TW) / 2, h: ((mapW + mapH) * TH) / 2 + 60 };
}

/**
 * Fit the whole map into a viewW x viewH viewport (mock `fitCamera`): leaves 60px
 * horizontal and 150px vertical margin for floating HUDs, nudged 24px down.
 */
export function fitCamera(mapW: number, mapH: number, viewW: number, viewH: number): Camera {
  const b = isoBounds(mapW, mapH);
  const zoom = Math.max(ZOOM_MIN, Math.min((viewW - 60) / b.w, (viewH - 150) / b.h));
  const ixc = ((mapW - mapH) * TW) / 4;
  const iyc = ((mapW + mapH) * TH) / 4 - 8;
  return { x: viewW / 2 - ixc * zoom, y: viewH / 2 - iyc * zoom + 24, zoom };
}

/** Zoom by factor k keeping the screen point (mx, my) fixed (clamped to 0.12-3.2). */
export function zoomAt(cam: Camera, mx: number, my: number, k: number): Camera {
  const nz = clampZoom(cam.zoom * k);
  const r = nz / cam.zoom;
  return { x: mx - (mx - cam.x) * r, y: my - (my - cam.y) * r, zoom: nz };
}

/** Camera position that centres grid point (gx, gy) in the viewport at the current zoom. */
export function centreOn(
  cam: Camera,
  gx: number,
  gy: number,
  viewW: number,
  viewH: number,
): { x: number; y: number } {
  return {
    x: viewW / 2 - (((gx - gy) * TW) / 2) * cam.zoom,
    y: viewH / 2 - (((gx + gy) * TH) / 2) * cam.zoom,
  };
}
