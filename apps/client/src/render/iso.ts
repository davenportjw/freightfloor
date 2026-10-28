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

export type DriveCameraMode = 'fixed' | 'headingUp';

/**
 * In 2:1 isometric projection (`screenX ~ rx - ry`, `screenY ~ rx + ry`), the screen-up vector
 * (`dx = 0, dy < 0`) corresponds to rotated world direction `rx = ry < 0`, i.e. `-3π/4` radians.
 * Rotating the world floor plane by `HEADING_UP_ISO_OFFSET - vehicleAngle` keeps the forklift
 * heading pointing straight up (`-sy`) on screen while the board rotates beneath it.
 */
export const HEADING_UP_ISO_OFFSET = (-3 * Math.PI) / 4;

export interface Camera {
  x: number;
  y: number;
  zoom: number;
  /** Optional world-plane rotation in radians (0 = standard fixed isometric aspect). */
  rot?: number;
}

export const clampZoom = (z: number): number => Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, z));

/** Rotate grid coordinates `(gx, gy)` by `rot` radians around the world origin `(0, 0)`. */
export function rotateGrid(gx: number, gy: number, rot = 0): [number, number] {
  if (!rot) return [gx, gy];
  const c = Math.cos(rot);
  const s = Math.sin(rot);
  return [gx * c - gy * s, gx * s + gy * c];
}

/** Isometric painter depth (`rx + ry`) at camera rotation `rot`. */
export function isoDepth(gx: number, gy: number, rot = 0): number {
  if (!rot) return gx + gy;
  const [rx, ry] = rotateGrid(gx, gy, rot);
  return rx + ry;
}

/** Board rotation angle (`cam.rot`) that aligns a vehicle with world `angle` straight up on screen. */
export function headingUpRotation(vehicleAngle: number): number {
  return HEADING_UP_ISO_OFFSET - vehicleAngle;
}

/** Screen X of grid point (gx, gy). */
export const screenX = (cam: Camera, gx: number, gy: number): number => {
  const [rx, ry] = rotateGrid(gx, gy, cam.rot ?? 0);
  return cam.x + (((rx - ry) * TW) / 2) * cam.zoom;
};

/** Screen Y of grid point (gx, gy) raised by z iso-pixels. */
export const screenY = (cam: Camera, gx: number, gy: number, z = 0): number => {
  const [rx, ry] = rotateGrid(gx, gy, cam.rot ?? 0);
  return cam.y + (((rx + ry) * TH) / 2 - z) * cam.zoom;
};

/** Project grid (gx, gy, z) to screen [sx, sy]. */
export function project(cam: Camera, gx: number, gy: number, z = 0): [number, number] {
  const [rx, ry] = rotateGrid(gx, gy, cam.rot ?? 0);
  return [
    cam.x + (((rx - ry) * TW) / 2) * cam.zoom,
    cam.y + (((rx + ry) * TH) / 2 - z) * cam.zoom,
  ];
}

/** Inverse of `project` on the floor plane (z = 0). Returns fractional tile coords. */
export function unproject(cam: Camera, sx: number, sy: number): { x: number; y: number } {
  const ix = (sx - cam.x) / cam.zoom;
  const iy = (sy - cam.y) / cam.zoom;
  const rx = iy / TH + ix / TW;
  const ry = iy / TH - ix / TW;
  const rot = cam.rot ?? 0;
  if (!rot) return { x: rx, y: ry };
  const c = Math.cos(rot);
  const s = Math.sin(rot);
  return { x: rx * c + ry * s, y: -rx * s + ry * c };
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
  const next: Camera = { x: mx - (mx - cam.x) * r, y: my - (my - cam.y) * r, zoom: nz };
  if (cam.rot !== undefined) next.rot = cam.rot;
  return next;
}

/** Camera position that centres grid point (gx, gy) in the viewport at the current zoom. */
export function centreOn(
  cam: Camera,
  gx: number,
  gy: number,
  viewW: number,
  viewH: number,
): { x: number; y: number } {
  return anchorOn(cam, gx, gy, viewW / 2, viewH / 2);
}

/**
 * Vertical screen anchor (fraction of viewport height) for the driven forklift in
 * `'headingUp'` camera mode. The forklift sits in the lower quarter of the screen so the
 * view shows mostly what is ahead of it rather than behind it.
 */
export const HEADING_UP_ANCHOR_Y = 0.78;

/** Camera position that places grid point (gx, gy) at screen point (sx, sy) at the current zoom. */
export function anchorOn(
  cam: Camera,
  gx: number,
  gy: number,
  sx: number,
  sy: number,
): { x: number; y: number } {
  const [rx, ry] = rotateGrid(gx, gy, cam.rot ?? 0);
  return {
    x: sx - (((rx - ry) * TW) / 2) * cam.zoom,
    y: sy - (((rx + ry) * TH) / 2) * cam.zoom,
  };
}
