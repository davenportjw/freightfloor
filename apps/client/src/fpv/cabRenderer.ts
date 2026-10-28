/**
 * Cab View: first-person WebGL renderer (three.js), lazy-loaded from main.ts only when the
 * player switches the camera into the cab, so iso-only players never download it.
 *
 * Visual parity: every 3D shape comes from the same scenery builders the iso renderer uses
 * (`drawRack`, `drawStruct`, `drawCargoItem`, `drawConveyorItem`, `rigParts`, `vehicleParts`)
 * through a recording painter, with the same site palettes. Heights convert iso-px → metres via
 * `liftGeometry`, the shared fork/rack geometry contract.
 */
import * as THREE from 'three';
import {
  guide as simGuide,
  isRackSlot,
  laneDir,
  RACK_LEVEL_FORK_TARGETS,
  RACK_LEVEL_LABELS,
  rackLiftWindows,
  type Vehicle,
  type World,
  type WorldMap,
} from '@warehouse/sim';
import type { GuideInfo, RenderOptions } from '../renderer.js';
import { arrowColor, BUBBLE_MS, CALLOUT_MS, calloutColor, guideUrgency, wrapBubbleText, type Callout, type RivalBubble } from '../render/fx.js';
import { forkHeightM, isoZ, ISO_PX_PER_M, liftWindowM, beamTopM, TILE_M } from '../render/liftGeometry.js';
import { PoseTracker, type Pose } from '../render/motion.js';
import { Painter } from '../render/painter.js';
import { drawCargoItem, drawConveyorItem, drawRack, drawStruct, getSiteVisuals, teamColor } from '../render/scenery.js';
import { dockParts, dockTruckFrame, rigParts, SimClock } from '../render/trucks.js';
import { vehicleParts } from '../render/vehicles.js';
import { watchDevicePixelRatio, watchElementSize } from '../render/dpr.js';
import { PrimRecorder, parseColor, type Prim } from './boxSink.js';
import {
  CAB_FOV,
  cabEye,
  damp,
  FORK_TIP_TILES,
  headTiltTarget,
  liftGradeAt,
  objectYaw,
  rackFace,
  REST_PITCH,
} from './cabMath.js';
import { resolveLiftTarget, type LiftTarget } from './liftTarget.js';

const M_PER_PX = 1 / ISO_PX_PER_M;
const FLOOR_PX_PER_TILE = 32;
const GRADE_COL = { perfect: '#34d399', clean: '#fbbf24', scrape: '#f87171' } as const;

/** Instanced batch of unit boxes or cylinders with per-instance colour. */
class Batch {
  mesh: THREE.InstancedMesh;
  private cap: number;
  private readonly m = new THREE.Matrix4();
  private readonly q = new THREE.Quaternion();
  private readonly p = new THREE.Vector3();
  private readonly s = new THREE.Vector3();
  private readonly c = new THREE.Color();
  private readonly up = new THREE.Vector3(0, 1, 0);

  constructor(
    private readonly scene: THREE.Scene,
    private readonly geo: THREE.BufferGeometry,
    private readonly mat: THREE.Material,
    cap: number,
    private readonly layer = 0,
  ) {
    this.cap = cap;
    this.mesh = this.make(cap);
  }

  private make(cap: number): THREE.InstancedMesh {
    const mesh = new THREE.InstancedMesh(this.geo, this.mat, cap);
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    mesh.count = 0;
    mesh.frustumCulled = false;
    mesh.layers.set(this.layer);
    // Allocate the colour attribute up front.
    mesh.setColorAt(0, this.c.set(1, 1, 1));
    this.scene.add(mesh);
    return mesh;
  }

  fill(prims: readonly Prim[]): void {
    if (prims.length > this.cap) {
      this.scene.remove(this.mesh);
      this.mesh.dispose();
      this.cap = Math.ceil(prims.length * 1.5);
      this.mesh = this.make(this.cap);
    }
    for (let i = 0; i < prims.length; i++) {
      const pr = prims[i];
      const hM = pr.h * M_PER_PX;
      this.p.set(pr.cx * TILE_M, pr.z0 * M_PER_PX + hM / 2, pr.cy * TILE_M);
      this.q.setFromAxisAngle(this.up, objectYaw(pr.a));
      this.s.set(pr.sx * TILE_M, hM, pr.sz * TILE_M);
      this.m.compose(this.p, this.q, this.s);
      this.mesh.setMatrixAt(i, this.m);
      this.mesh.setColorAt(i, this.c.setRGB(pr.r, pr.g, pr.b, THREE.SRGBColorSpace));
    }
    this.mesh.count = prims.length;
    this.mesh.instanceMatrix.needsUpdate = true;
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
  }

  dispose(): void {
    this.scene.remove(this.mesh);
    this.mesh.dispose();
  }
}

/** Flat floor decals (rings / discs) with per-instance colour. */
class FlatBatch {
  mesh: THREE.InstancedMesh;
  private readonly m = new THREE.Matrix4();
  private readonly c = new THREE.Color();
  private n = 0;

  constructor(scene: THREE.Scene, geo: THREE.BufferGeometry, opacity: number, cap = 512) {
    const mat = new THREE.MeshBasicMaterial({
      transparent: true,
      opacity,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -2,
      side: THREE.DoubleSide,
    });
    this.mesh = new THREE.InstancedMesh(geo, mat, cap);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.frustumCulled = false;
    this.mesh.setColorAt(0, this.c.set(1, 1, 1));
    this.mesh.count = 0;
    scene.add(this.mesh);
  }

  begin(): void {
    this.n = 0;
  }

  add(gx: number, gy: number, rTiles: number, css: string): void {
    if (this.n >= this.mesh.instanceMatrix.count) return;
    const [r, g, b] = parseColor(css);
    const s = rTiles * TILE_M;
    this.m.makeRotationX(-Math.PI / 2).premultiply(new THREE.Matrix4().makeScale(s, 1, s));
    this.m.setPosition(gx * TILE_M, 0.012, gy * TILE_M);
    this.mesh.setMatrixAt(this.n, this.m);
    this.mesh.setColorAt(this.n, this.c.setRGB(r, g, b, THREE.SRGBColorSpace));
    this.n++;
  }

  end(): void {
    this.mesh.count = this.n;
    this.mesh.instanceMatrix.needsUpdate = true;
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
  }
}

export interface CabRendererInit {
  /** Element the cab canvases are stacked into (the iso canvas's parent, `#stage`). */
  container: HTMLElement;
}

export class CabRenderer {
  private readonly gl: THREE.WebGLRenderer;
  private readonly glCanvas: HTMLCanvasElement;
  private readonly overlay: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private readonly pill: Painter;
  private readonly scene = new THREE.Scene();
  private readonly camera: THREE.PerspectiveCamera;
  private readonly forkCam: THREE.PerspectiveCamera;
  private readonly tracker = new PoseTracker();
  private readonly dockClock = new SimClock();
  private readonly rec = new PrimRecorder();
  private readonly meRec = new PrimRecorder();
  private readonly cleanup: Array<() => void> = [];

  private readonly boxGeo = new THREE.BoxGeometry(1, 1, 1);
  private readonly cylGeo = new THREE.CylinderGeometry(0.5, 0.5, 1, 14);
  private readonly opaqueMat = new THREE.MeshLambertMaterial({ color: 0xffffff });
  private readonly glassMat = new THREE.MeshLambertMaterial({ color: 0xffffff, transparent: true, opacity: 0.4, depthWrite: false });
  /** Fainter glass for my own chassis (the hood must not hide the forks). */
  private readonly faintMat = new THREE.MeshLambertMaterial({ color: 0xffffff, transparent: true, opacity: 0.2, depthWrite: false });

  private staticBox: Batch;
  private staticCyl: Batch;
  private dynBox: Batch;
  private dynCyl: Batch;
  private dynGlass: Batch;
  private meBox: Batch;
  private meCyl: Batch;
  private meGlass: Batch;
  private meFaint: Batch;
  private readonly rings: FlatBatch;
  private readonly discs: FlatBatch;

  private floor: THREE.Mesh | null = null;
  private readonly ground: THREE.Mesh;
  private readonly guideBeam: THREE.Mesh;
  private readonly laser: THREE.Mesh;
  private readonly laserFace: THREE.Mesh;
  private readonly slabClean: THREE.Mesh;
  private readonly slabPerfect: THREE.Mesh;

  private mapKey = '';
  private VW = 0;
  private VH = 0;
  private dpr = 1;
  private pitch = REST_PITCH;
  private lastMs = 0;
  private reducedMotion = false;
  private visible = false;
  private callouts: Array<Callout & { born: number }> = [];
  private bubbles: Array<RivalBubble & { born: number }> = [];
  private poses = new Map<string, Pose>();
  /** Free-look offsets (rad) from dragging the cab view; spring back to 0 on release. */
  private lookYaw = 0;
  private lookPitch = 0;
  private looking: { id: number; x: number; y: number } | null = null;

  constructor(o: CabRendererInit) {
    this.glCanvas = document.createElement('canvas');
    this.glCanvas.className = 'cab-canvas';
    this.glCanvas.setAttribute('aria-label', 'Cab view: first-person forklift camera.');
    this.overlay = document.createElement('canvas');
    this.overlay.className = 'cab-overlay';
    this.overlay.setAttribute('aria-hidden', 'true');
    o.container.appendChild(this.glCanvas);
    o.container.appendChild(this.overlay);
    const ctx = this.overlay.getContext('2d');
    if (!ctx) throw new Error('Cab view: Canvas2D overlay context unavailable');
    this.ctx = ctx;
    this.pill = new Painter(ctx, { x: 0, y: 0, zoom: 1 });

    // Throws a real error (caught by main.ts → falls back to iso with a notice) without WebGL.
    this.gl = new THREE.WebGLRenderer({ canvas: this.glCanvas, antialias: true, powerPreference: 'high-performance' });
    this.gl.outputColorSpace = THREE.SRGBColorSpace;
    this.gl.autoClear = false;

    this.camera = new THREE.PerspectiveCamera(CAB_FOV, 1, 0.05, 140);
    this.camera.rotation.order = 'YXZ';
    this.camera.layers.enable(1);
    this.forkCam = new THREE.PerspectiveCamera(55, 4 / 3, 0.05, 30);
    this.forkCam.rotation.order = 'YXZ';

    // Soft, near-flat lighting so faces read like the iso painter's top/left/right shading.
    this.scene.add(new THREE.HemisphereLight(0xffffff, 0x8a94a6, 2.1));
    const sun = new THREE.DirectionalLight(0xffffff, 1.1);
    sun.position.set(-0.6, 1, -0.35);
    this.scene.add(sun);

    this.staticBox = new Batch(this.scene, this.boxGeo, this.opaqueMat, 4096);
    this.staticCyl = new Batch(this.scene, this.cylGeo, this.opaqueMat, 1024);
    this.dynBox = new Batch(this.scene, this.boxGeo, this.opaqueMat, 2048);
    this.dynCyl = new Batch(this.scene, this.cylGeo, this.opaqueMat, 512);
    this.dynGlass = new Batch(this.scene, this.boxGeo, this.glassMat, 256);
    this.meBox = new Batch(this.scene, this.boxGeo, this.opaqueMat, 128, 1);
    this.meCyl = new Batch(this.scene, this.cylGeo, this.opaqueMat, 32, 1);
    this.meGlass = new Batch(this.scene, this.boxGeo, this.glassMat, 64, 1);
    this.meFaint = new Batch(this.scene, this.boxGeo, this.faintMat, 64, 1);
    this.rings = new FlatBatch(this.scene, new THREE.RingGeometry(0.82, 1, 40), 0.9);
    this.discs = new FlatBatch(this.scene, new THREE.CircleGeometry(1, 32), 0.55);

    this.ground = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshBasicMaterial({ color: 0xcbd5e1 }));
    this.ground.rotation.x = -Math.PI / 2;
    this.ground.position.y = -0.02;
    this.scene.add(this.ground);

    const beamMat = new THREE.MeshBasicMaterial({ transparent: true, opacity: 0.22, depthWrite: false });
    this.guideBeam = new THREE.Mesh(new THREE.CylinderGeometry(0.16, 0.16, 1, 16, 1, true), beamMat);
    this.scene.add(this.guideBeam);

    const glow = (opacity: number) =>
      new THREE.MeshBasicMaterial({ transparent: true, opacity, depthWrite: false, side: THREE.DoubleSide });
    this.laser = new THREE.Mesh(this.boxGeo, glow(0.85));
    this.laser.layers.set(1);
    this.laserFace = new THREE.Mesh(this.boxGeo, glow(0.95));
    this.slabClean = new THREE.Mesh(this.boxGeo, glow(0.16));
    this.slabPerfect = new THREE.Mesh(this.boxGeo, glow(0.32));
    (this.slabClean.material as THREE.MeshBasicMaterial).color.set('#f59e0b');
    (this.slabPerfect.material as THREE.MeshBasicMaterial).color.set('#10b981');
    for (const m of [this.laser, this.laserFace, this.slabClean, this.slabPerfect]) {
      m.visible = false;
      m.renderOrder = 5;
      this.scene.add(m);
    }

    if (typeof window !== 'undefined' && typeof window.matchMedia === 'function') {
      const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
      this.reducedMotion = mq.matches;
      const onMq = (e: MediaQueryListEvent) => {
        this.reducedMotion = e.matches;
      };
      mq.addEventListener('change', onMq);
      this.cleanup.push(() => mq.removeEventListener('change', onMq));
    }
    this.attachFreeLook();
    this.cleanup.push(watchElementSize(o.container, () => this.resize()));
    if (typeof window !== 'undefined') this.cleanup.push(watchDevicePixelRatio(window, () => this.resize()));
    this.resize();
    this.setVisible(false);
  }

  /** Drag (mouse / one finger) on the cab view to look around; releases spring back to the mast. */
  private attachFreeLook(): void {
    const c = this.glCanvas;
    const down = (e: PointerEvent) => {
      if (this.looking || (e.pointerType === 'mouse' && e.button !== 0)) return;
      this.looking = { id: e.pointerId, x: e.clientX, y: e.clientY };
      c.setPointerCapture?.(e.pointerId);
      c.style.cursor = 'grabbing';
    };
    const move = (e: PointerEvent) => {
      if (!this.looking || e.pointerId !== this.looking.id) return;
      const k = (Math.PI / 180) * (CAB_FOV / Math.max(1, this.VH)) * 1.2;
      this.lookYaw = Math.max(-1.9, Math.min(1.9, this.lookYaw - (e.clientX - this.looking.x) * k));
      this.lookPitch = Math.max(-0.7, Math.min(0.7, this.lookPitch - (e.clientY - this.looking.y) * k));
      this.looking.x = e.clientX;
      this.looking.y = e.clientY;
    };
    const up = (e: PointerEvent) => {
      if (!this.looking || e.pointerId !== this.looking.id) return;
      this.looking = null;
      c.style.cursor = '';
    };
    c.addEventListener('pointerdown', down);
    c.addEventListener('pointermove', move);
    c.addEventListener('pointerup', up);
    c.addEventListener('pointercancel', up);
    this.cleanup.push(() => {
      c.removeEventListener('pointerdown', down);
      c.removeEventListener('pointermove', move);
      c.removeEventListener('pointerup', up);
      c.removeEventListener('pointercancel', up);
    });
  }

  setVisible(on: boolean): void {
    this.visible = on;
    this.glCanvas.style.display = on ? 'block' : 'none';
    this.overlay.style.display = on ? 'block' : 'none';
    if (on) this.resize();
  }

  isVisible(): boolean {
    return this.visible;
  }

  /** Force a static-scene rebuild (map version changed). */
  onMapRebuilt(): void {
    this.mapKey = '';
  }

  pushCallout(c: Callout, nowMs: number): void {
    this.callouts.push({ ...c, born: nowMs });
    if (this.callouts.length > 4) this.callouts.shift();
  }

  pushBubble(b: RivalBubble, nowMs: number): void {
    this.bubbles = this.bubbles.filter((x) => x.vid !== b.vid);
    this.bubbles.push({ ...b, born: nowMs });
  }

  resize(): void {
    const parent = this.glCanvas.parentElement;
    const w = Math.max(1, parent?.clientWidth || window.innerWidth || 1);
    const h = Math.max(1, parent?.clientHeight || window.innerHeight || 1);
    this.VW = w;
    this.VH = h;
    // Cap DPR: the 3D pass is fill-rate bound on phones / Retina laptops.
    this.dpr = Math.min(1.5, window.devicePixelRatio || 1);
    this.gl.setPixelRatio(this.dpr);
    this.gl.setSize(w, h, false);
    this.glCanvas.style.width = `${w}px`;
    this.glCanvas.style.height = `${h}px`;
    const odpr = Math.min(2, window.devicePixelRatio || 1);
    this.overlay.width = Math.round(w * odpr);
    this.overlay.height = Math.round(h * odpr);
    this.overlay.style.width = `${w}px`;
    this.overlay.style.height = `${h}px`;
    this.ctx.setTransform(odpr, 0, 0, odpr, 0, 0);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  destroy(): void {
    for (const fn of this.cleanup.splice(0)) fn();
    for (const b of [this.staticBox, this.staticCyl, this.dynBox, this.dynCyl, this.dynGlass, this.meBox, this.meCyl, this.meGlass, this.meFaint]) b.dispose();
    this.floor?.geometry.dispose();
    this.gl.dispose();
    this.glCanvas.remove();
    this.overlay.remove();
  }

  // -------------------------------------------------------------------------------------------
  // Static scene
  // -------------------------------------------------------------------------------------------

  private rebuildStatic(world: World): void {
    const map = world.map;
    const vis = getSiteVisuals(world.siteId);
    this.scene.background = new THREE.Color(vis.bg);
    this.scene.fog = new THREE.Fog(new THREE.Color(vis.bg), 28, 95);
    (this.ground.material as THREE.MeshBasicMaterial).color.set(vis.bg);
    this.ground.scale.set(map.w * TILE_M * 6, map.h * TILE_M * 6, 1);
    this.ground.position.set((map.w * TILE_M) / 2, -0.02, (map.h * TILE_M) / 2);

    const rec = this.rec;
    rec.clear();
    for (const r of map.racks) drawRack(rec.asPainter(), r, world.siteId);
    for (const st of map.structs) drawStruct(rec.asPainter(), st);
    for (const c of map.conveyors) {
      rec.aaBox(c.x + 0.1, c.y, 0.8, 1, 0, 7, vis.conveyorBed);
      rec.aaBox(c.x + 0.2, c.y, 0.6, 1, 7, 1.5, vis.conveyorRail);
    }
    for (const dk of map.westDocks) for (const b of dockParts(0.95, dk.y + 0.5, -1)) rec.aaBox(b.x, b.y, b.w, b.d, b.z0, b.h, b.hex);
    for (const bay of map.bays) {
      if (bay.id === 'RET') continue;
      for (const b of dockParts(map.w - 0.95, bay.y + 0.5, 1)) rec.aaBox(b.x, b.y, b.w, b.d, b.z0, b.h, b.hex);
    }
    this.staticBox.fill(rec.prims.filter((p) => p.kind === 'box'));
    this.staticCyl.fill(rec.prims.filter((p) => p.kind === 'cyl'));

    if (this.floor) {
      this.scene.remove(this.floor);
      this.floor.geometry.dispose();
      const mat = this.floor.material as THREE.MeshBasicMaterial;
      mat.map?.dispose();
      mat.dispose();
    }
    const tex = new THREE.CanvasTexture(this.paintFloor(map, world.siteId));
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = this.gl.capabilities.getMaxAnisotropy();
    this.floor = new THREE.Mesh(
      new THREE.PlaneGeometry(map.w * TILE_M, map.h * TILE_M),
      new THREE.MeshBasicMaterial({ map: tex }),
    );
    this.floor.rotation.x = -Math.PI / 2;
    this.floor.position.set((map.w * TILE_M) / 2, 0, (map.h * TILE_M) / 2);
    this.scene.add(this.floor);
  }

  /** Top-down replica of the iso `drawFloor` static layers (same palette & markings). */
  private paintFloor(map: WorldMap, siteId: string | undefined): HTMLCanvasElement {
    const vis = getSiteVisuals(siteId);
    const W = map.w;
    const H = map.h;
    const S = Math.max(8, Math.min(FLOOR_PX_PER_TILE, Math.floor(4096 / Math.max(W, H))));
    const cv = document.createElement('canvas');
    cv.width = W * S;
    cv.height = H * S;
    const g = cv.getContext('2d')!;
    const rect = (x0: number, y0: number, x1: number, y1: number, col: string) => {
      g.fillStyle = col;
      g.fillRect(x0 * S, y0 * S, (x1 - x0) * S, (y1 - y0) * S);
    };
    rect(0, 0, W, H, vis.floorBorder);
    if (W > 2 && H > 2) {
      rect(1, 1, W - 1, H - 1, vis.kfloor.ambient);
      for (const a of map.areas) {
        const col = vis.kfloor[a.kind];
        if (col && col !== vis.kfloor.ambient) {
          rect(Math.max(1, a.x), Math.max(1, a.y), Math.min(W - 1, a.x + a.w), Math.min(H - 1, a.y + a.h), col);
        }
      }
      for (const h of map.hwyY) if (h >= 1 && h + 2 <= H - 1) rect(1, h, W - 1, h + 2, vis.hwyFill);
      rect(4, 1, 6, H - 1, vis.hwyFill);
      for (const hx of map.hwyX) if (hx >= 1 && hx + 1 <= W - 1) rect(hx, 1, hx + 1, H - 1, vis.hwyFill);
    }
    // grid
    g.strokeStyle = vis.gridStroke;
    g.lineWidth = 1;
    g.beginPath();
    for (let x = 0; x <= W; x++) {
      g.moveTo(x * S + 0.5, 0);
      g.lineTo(x * S + 0.5, H * S);
    }
    for (let y = 0; y <= H; y++) {
      g.moveTo(0, y * S + 0.5);
      g.lineTo(W * S, y * S + 0.5);
    }
    g.stroke();
    // one-way lane chevrons
    g.strokeStyle = 'rgba(71,85,105,0.55)';
    g.lineWidth = Math.max(1, S * 0.05);
    g.lineJoin = 'round';
    g.beginPath();
    for (let y = 1; y < H - 1; y++) {
      for (let x = 1; x < W - 1; x++) {
        if ((x + y) % 3) continue;
        const d = laneDir(map, x, y);
        if (!d) continue;
        const cx = x + 0.5;
        const cy = y + 0.5;
        const px = -d[1];
        const py = d[0];
        g.moveTo((cx - d[0] * 0.1 + px * 0.15) * S, (cy - d[1] * 0.1 + py * 0.15) * S);
        g.lineTo((cx + d[0] * 0.2) * S, (cy + d[1] * 0.2) * S);
        g.lineTo((cx - d[0] * 0.1 - px * 0.15) * S, (cy - d[1] * 0.1 - py * 0.15) * S);
      }
    }
    g.stroke();
    // dashed highway centre lines
    g.save();
    g.setLineDash([S * 0.25, S * 0.25]);
    g.strokeStyle = vis.hwyLaneDash;
    g.lineWidth = Math.max(1, S * 0.05);
    g.beginPath();
    for (const h of map.hwyY) {
      g.moveTo(1 * S, (h + 1) * S);
      g.lineTo((W - 1) * S, (h + 1) * S);
    }
    g.moveTo(5 * S, 1 * S);
    g.lineTo(5 * S, (H - 1) * S);
    g.stroke();
    // district outlines
    g.setLineDash([S * 0.22, S * 0.18]);
    g.lineWidth = Math.max(1.5, S * 0.07);
    for (const a of map.areas) {
      if (a.kind === 'office') continue;
      g.strokeStyle = vis.kout[a.kind];
      g.strokeRect(a.x * S, a.y * S, a.w * S, a.h * S);
    }
    g.restore();
    // bay pads + charger pads
    for (const b of map.bays) {
      const isRet = b.id === 'RET';
      const net = b.isTransferBay;
      for (const t of b.tiles) {
        g.fillStyle = isRet ? '#FEF3C7' : net ? '#C7D2FE' : '#BFD3F2';
        g.fillRect(t.x * S, t.y * S, S, S);
        g.strokeStyle = isRet ? '#D97706' : net ? '#6366F1' : '#3B82F6';
        g.lineWidth = 1.5;
        g.strokeRect(t.x * S + 1, t.y * S + 1, S - 2, S - 2);
      }
    }
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.font = `700 ${Math.round(S * 0.5)}px sans-serif`;
    for (const c of map.chargers) {
      g.fillStyle = '#BBF7D0';
      g.fillRect(c.x * S, c.y * S, S, S);
      g.strokeStyle = '#16A34A';
      g.lineWidth = 1.5;
      g.strokeRect(c.x * S + 1, c.y * S + 1, S - 2, S - 2);
      g.fillStyle = '#15803D';
      g.fillText('⚡', (c.x + 0.5) * S, (c.y + 0.5) * S);
    }
    return cv;
  }

  // -------------------------------------------------------------------------------------------
  // Per frame
  // -------------------------------------------------------------------------------------------

  render(world: World, opts: RenderOptions, nowMs: number): void {
    if (!this.visible) return;
    const dtMs = this.lastMs > 0 ? Math.max(1, Math.min(100, nowMs - this.lastMs)) : 16.67;
    this.lastMs = nowMs;
    const map = world.map;
    const key = `${world.siteId}:${map.w}x${map.h}:${map.racks.length}:${map.structs.length}`;
    if (key !== this.mapKey) {
      this.mapKey = key;
      this.rebuildStatic(world);
    }

    // Poses: same smoothing as the iso renderer (predicted pose for me, interpolation for rivals).
    this.tracker.update(world.t, nowMs, world.vehicles);
    const poses = new Map<string, Pose>();
    for (const v of world.vehicles) {
      let p: Pose | null;
      if (v.id === opts.myVid) {
        p = opts.myPose ?? (v.state === 'driven' ? { x: v.px, y: v.py, a: v.angle } : this.tracker.pose(v.id, nowMs));
      } else p = this.tracker.pose(v.id, nowMs);
      poses.set(v.id, p ?? { x: v.px, y: v.py, a: v.angle });
    }
    this.poses = poses;
    const me = opts.myVid ? world.vehicles.find((v) => v.id === opts.myVid) : undefined;
    if (!me) {
      // Cab view only makes sense while driving; main.ts switches back to iso, draw nothing.
      this.gl.clear();
      this.ctx.clearRect(0, 0, this.VW, this.VH);
      return;
    }
    const myPose = poses.get(me.id)!;
    const g: GuideInfo | null =
      opts.guide !== undefined ? opts.guide : (simGuide(world, me) as GuideInfo | null);
    const liftOn = Boolean(opts.rackLiftEnabled);
    const target = liftOn ? resolveLiftTarget(world, me, g, opts.rackLift) : null;
    const showLift = Boolean(target && (target.active || g?.inRange));

    this.buildDynamic(world, opts, me, nowMs);
    this.buildMe(me, myPose, world.siteId, nowMs);
    this.buildFloorMarks(world, g, nowMs);
    this.placeGuideBeam(g, world, me);
    this.placeLiftVisuals(me, myPose, target, showLift);

    // Camera.
    const eye = cabEye(myPose);
    const pocketM = target ? liftWindowM(target.level).centerM : null;
    const tilt = headTiltTarget({
      lifting: Boolean(target?.active),
      fork: me.fork ?? 0,
      pocketM,
      reducedMotion: this.reducedMotion,
    });
    this.pitch = this.reducedMotion ? tilt : damp(this.pitch, tilt, dtMs);
    if (!this.looking) {
      // Spring the free-look back to straight down the mast.
      this.lookYaw = this.reducedMotion ? 0 : damp(this.lookYaw, 0, dtMs, 260);
      this.lookPitch = this.reducedMotion ? 0 : damp(this.lookPitch, 0, dtMs, 260);
    }
    this.camera.position.set(eye.x, eye.y, eye.z);
    this.camera.rotation.set(
      Math.max(-1.2, Math.min(1.2, this.pitch + this.lookPitch)),
      eye.yaw + this.lookYaw,
      0,
    );
    this.camera.updateMatrixWorld();

    this.gl.setViewport(0, 0, this.VW, this.VH);
    this.gl.setScissorTest(false);
    this.gl.clear();
    this.gl.render(this.scene, this.camera);

    const pip = showLift && target && !this.reducedMotion ? this.pipRect() : null;
    if (pip && target) this.renderForkCam(me, myPose, pip);

    this.drawOverlay(world, opts, me, g, target, showLift, pip, nowMs);
  }

  private buildDynamic(world: World, opts: RenderOptions, me: Vehicle, nowMs: number): void {
    const rec = this.rec;
    rec.clear();
    rec.alphaMul = 1;
    const map = world.map;
    // Order pallets: on their shelf level when Lift Mode is on (always in the cab), else at the aisle.
    for (const o of world.orders) {
      if (o.state === 'picked' || o.state === 'done') continue;
      const s = o.slot;
      const elevated = Boolean(opts.rackLiftEnabled && isRackSlot(s));
      const level = (s.level ?? 0) as 0 | 1 | 2;
      const z0 = elevated ? isoZ(beamTopM(level)) : 0;
      const px = elevated ? s.rx * 0.65 + s.ax * 0.35 : s.ax;
      const py = elevated ? s.ry * 0.65 + s.ay * 0.35 : s.ay;
      drawCargoItem(rec.asPainter(), px, py, z0, o, world.siteId);
    }
    // Conveyor totes.
    const dockT = this.dockClock.update(world.t, nowMs);
    const NCV = map.conveyors.length;
    if (NCV) {
      for (let i = 0; i < 16; i++) {
        const p = (dockT * 0.6 + (i * NCV) / 16) % NCV;
        const c = map.conveyors[Math.floor(p)];
        if (!c) continue;
        const fy = p - Math.floor(p);
        drawConveyorItem(rec.asPainter(), c.x, c.y + fy * 0.6, 8.5, i, world.siteId);
      }
    }
    // Dock rigs (west receiving + east shipping).
    const blink = this.reducedMotion ? true : Math.floor(nowMs / 380) % 2 === 0;
    const rigs: Array<{ dockX: number; cy: number; dir: 1 | -1; kind: 'ship' | 'net' | 'receive'; fill: number; departUntil: number; doorPallets: number | null }> = [];
    const parkedT = 0;
    for (const dk of map.westDocks) {
      const waiting = world.orders.filter((o) => o.slot.rackId === dk.id && o.state !== 'picked' && o.state !== 'done').length;
      rigs.push({ dockX: 0.95, cy: dk.y + 0.5, dir: -1, kind: 'receive', fill: Math.min(1, waiting / 3), departUntil: parkedT, doorPallets: waiting > 0 ? waiting : null });
    }
    for (const bay of map.bays) {
      if (bay.id === 'RET') continue;
      const b = world.bays.find((s) => s.id === bay.id);
      const net = bay.isTransferBay || !!b?.isTransferBay;
      const fill = b && b.cap > 0 ? Math.max(0, Math.min(1, b.load / b.cap)) : 0;
      rigs.push({ dockX: map.w - 0.95, cy: bay.y + 0.5, dir: 1, kind: net ? 'net' : 'ship', fill, departUntil: b?.departUntil ?? 0, doorPallets: null });
    }
    for (const r of rigs) {
      const frame = r.dir < 0 ? dockTruckFrame(0, 0) : dockTruckFrame(dockT, r.departUntil);
      if (!frame.visible || frame.alpha <= 0.01) continue;
      rec.alphaMul = frame.alpha;
      for (const b of rigParts({
        dockX: r.dockX,
        cy: r.cy,
        dx: frame.dx,
        dir: r.dir,
        kind: r.kind,
        fill: r.fill,
        blink,
        gear: frame.gear,
        braking: frame.braking,
        chocked: frame.phase === 'docked',
        doorPallets: frame.phase === 'docked' ? r.doorPallets : null,
      })) {
        rec.aaBox(b.x, b.y, b.w, b.d, b.z0, b.h, b.hex);
      }
      rec.alphaMul = 1;
    }
    // Chargers.
    for (const c of map.chargers) {
      const busy = world.vehicles.some(
        (v) => (v.state === 'charging' || v.humanCharging) && Math.hypot(v.px - (c.x + 0.5), v.py - (c.y + 0.5)) < 0.9,
      );
      rec.aaBox(c.x + 0.3, c.y + 0.82, 0.4, 0.14, 0, 16, busy ? '#22C55E' : '#16A34A');
    }
    // Cones.
    for (const k of world.cones) {
      const [x, y] = k.split(',').map(Number);
      if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
      rec.aaBox(x + 0.25, y + 0.25, 0.5, 0.5, 0, 2, '#334155');
      rec.aaBox(x + 0.36, y + 0.36, 0.28, 0.28, 2, 9, '#F97316');
      rec.aaBox(x + 0.4, y + 0.4, 0.2, 0.2, 7, 2, '#FFFFFF');
    }
    // Rival vehicles.
    for (const v of world.vehicles) {
      if (v.id === me.id) continue;
      const p = this.poses.get(v.id);
      if (!p) continue;
      for (const q of vehicleParts(v, p, nowMs, world.siteId)) rec.oBox(q.cx, q.cy, q.len, q.wid, p.a, q.z0, q.h, q.hex);
    }
    const opaque = rec.prims.filter((p) => p.alpha >= 0.99);
    this.dynBox.fill(opaque.filter((p) => p.kind === 'box'));
    this.dynCyl.fill(opaque.filter((p) => p.kind === 'cyl'));
    this.dynGlass.fill(rec.prims.filter((p) => p.alpha < 0.99));
  }

  /**
   * My own truck, seen from the seat. Same parts as the iso model, re-classified for a cab:
   * - mast: the solid slab becomes two slim rails + a top crossbar (you look *between* them);
   * - forks + high-vis tips: solid (they are what you aim with);
   * - carriage backrest, carried cargo and the chassis: see-through, so neither the load nor the
   *   hood hides the forks / rack;
   * - overhead-guard posts / roof and the centre lift cylinder: dropped (at eye distance they
   *   filled half the screen).
   */
  private buildMe(me: Vehicle, p: Pose, siteId: string | undefined, nowMs: number): void {
    const rec = this.meRec;
    rec.clear();
    const bare = vehicleParts(me, p, nowMs, siteId, false);
    const full = vehicleParts(me, p, nowMs, siteId, true);
    const keyOf = (q: { cx: number; cy: number; z0: number; h: number; hex: string }) =>
      `${q.cx.toFixed(4)}|${q.cy.toFixed(4)}|${q.z0}|${q.h}|${q.hex}`;
    const bareKeys = new Set(bare.map(keyOf));
    const ca = Math.cos(p.a);
    const sa = Math.sin(p.a);
    const forkZ = isoZ(forkHeightM(me.fork ?? 0));
    for (const q of bare) {
      const hex = q.hex.toUpperCase();
      const isMast = q.z0 === 0 && q.h >= 30 && hex === '#334155';
      const isGuardPost = hex === '#334155' && q.z0 === 10 && q.h === 14;
      const isGuardRoof = hex === '#475569' && q.z0 === 24 && q.wid > 0.3;
      const isCylinder = hex === '#CBD5E1' && q.z0 === 2;
      const isBackrest = hex === '#1E293B' && q.h === 5.5;
      const isFork = Math.abs(q.z0 - forkZ) < 1e-6 && q.h === 2 && q.wid < 0.1;
      if (isGuardPost || isGuardRoof || isCylinder) continue;
      if (isMast) {
        const half = q.wid / 2 - 0.02;
        for (const sgn of [-1, 1]) {
          rec.oBox(q.cx - sa * half * sgn, q.cy + ca * half * sgn, 0.05, 0.025, p.a, 0, q.h, q.hex);
        }
        rec.oBox(q.cx, q.cy, 0.05, q.wid, p.a, q.h - 1.2, 1.2, q.hex);
        continue;
      }
      rec.alphaMul = isFork ? 1 : isBackrest ? 0.4 : 0.2;
      rec.oBox(q.cx, q.cy, q.len, q.wid, p.a, q.z0, q.h, q.hex);
      rec.alphaMul = 1;
    }
    rec.alphaMul = 0.4;
    for (const q of full) if (!bareKeys.has(keyOf(q))) rec.oBox(q.cx, q.cy, q.len, q.wid, p.a, q.z0, q.h, q.hex);
    rec.alphaMul = 1;
    const opaque = rec.prims.filter((x) => x.alpha >= 0.99);
    this.meBox.fill(opaque.filter((x) => x.kind === 'box'));
    this.meCyl.fill(opaque.filter((x) => x.kind === 'cyl'));
    this.meGlass.fill(rec.prims.filter((x) => x.alpha < 0.99 && x.alpha >= 0.3));
    this.meFaint.fill(rec.prims.filter((x) => x.alpha < 0.3));
  }

  private buildFloorMarks(world: World, g: GuideInfo | null, nowMs: number): void {
    this.rings.begin();
    this.discs.begin();
    for (const o of world.orders) {
      if (o.state === 'picked' || o.state === 'done') continue;
      const s = o.slot;
      const claimer = o.claimant ? world.vehicles.find((v) => v.id === o.claimant) : undefined;
      const col = claimer ? teamColor(claimer) : o.p0 ? '#F59E0B' : o.card ? '#7C3AED' : o.isTransfer || o.destSite ? '#6366F1' : '#64748B';
      this.rings.add(s.ax + 0.5, s.ay + 0.5, 0.38, col);
    }
    for (const h of world.hazards ?? world.spills ?? []) {
      const left = Math.max(0, Math.min(1, (h.until - world.t) / 30));
      this.discs.add(h.x + 0.5, h.y + 0.5, 0.42 + 0.08 * left, '#FACC15');
    }
    const mp = this.reducedMotion ? 0.5 : (Math.sin((nowMs / 150) * Math.PI * 2) + 1) / 2;
    for (const m of world.markers) {
      if (m.until <= world.t) continue;
      const inc = m.kind === 'incident';
      this.rings.add(m.x + 0.5, m.y + 0.5, 0.5 + 0.35 * mp * (inc ? 1 : 0.6), inc ? '#DC2626' : '#D97706');
    }
    if (g && g.x != null && g.y != null) {
      const pulse = this.reducedMotion ? 0.5 : (Math.sin((nowMs / 260) * Math.PI * 2) + 1) / 2;
      this.rings.add(g.x + 0.5, g.y + 0.5, g.inRange ? 0.75 : 0.55 + 0.15 * pulse, g.inRange ? '#16A34A' : '#2563EB');
    }
    this.rings.end();
    this.discs.end();
  }

  private guideColor(g: GuideInfo, world: World, me: Vehicle): string {
    const bayAt =
      g.kind === 'drop' ? (world.map.bays.find((bb) => bb.tiles.some((t) => t.x === g.x && t.y === g.y))?.id ?? null) : null;
    const urgency = guideUrgency(g, world.t, world.orders, me.cargo ?? [], bayAt);
    return g.inRange ? '#16A34A' : arrowColor(g.kind, urgency);
  }

  private placeGuideBeam(g: GuideInfo | null, world: World, me: Vehicle): void {
    if (!g || g.x == null || g.y == null) {
      this.guideBeam.visible = false;
      return;
    }
    // Up close the beam would wrap the camera in a coloured haze: only show it from a distance.
    const p = this.poses.get(me.id) ?? { x: me.px, y: me.py, a: me.angle };
    if (g.inRange || Math.hypot(g.x + 0.5 - p.x, g.y + 0.5 - p.y) < 2.2) {
      this.guideBeam.visible = false;
      return;
    }
    const h = 3.2;
    this.guideBeam.visible = true;
    this.guideBeam.scale.set(1, h, 1);
    this.guideBeam.position.set((g.x + 0.5) * TILE_M, h / 2, (g.y + 0.5) * TILE_M);
    (this.guideBeam.material as THREE.MeshBasicMaterial).color.set(this.guideColor(g, world, me));
  }

  private placeLiftVisuals(me: Vehicle, p: Pose, target: LiftTarget | null, show: boolean): void {
    const all = [this.laser, this.laserFace, this.slabClean, this.slabPerfect];
    if (!target || !show) {
      for (const m of all) m.visible = false;
      return;
    }
    const face = rackFace(target.slot);
    const win = liftWindowM(target.level, { forkLiftMul: target.forkLiftMul, district: target.district });
    const nwin = rackLiftWindows(target.level, { forkLiftMul: target.forkLiftMul, district: target.district });
    const fork = me.fork ?? 0;
    const grade = liftGradeAt(fork, nwin);
    const col = GRADE_COL[grade];
    const forkM = forkHeightM(fork);
    const yawFace = Math.atan2(face.ny, face.nx);
    // Slabs hug the rack face, 2 cm into the aisle: exactly the server's tolerance, in metres.
    const fx = (face.gx + face.nx * 0.02) * TILE_M;
    const fz = (face.gy + face.ny * 0.02) * TILE_M;
    const slab = (m: THREE.Mesh, halfM: number) => {
      m.visible = true;
      m.position.set(fx, win.centerM + 0.155, fz);
      m.rotation.set(0, objectYaw(yawFace), 0);
      m.scale.set(0.02, Math.max(0.01, halfM * 2), 0.9 * TILE_M);
    };
    slab(this.slabClean, win.cleanM);
    slab(this.slabPerfect, win.perfectM);
    // Fork laser: from the fork tips straight ahead, plus a bright line where it meets the face.
    const tipGX = p.x + Math.cos(p.a) * FORK_TIP_TILES;
    const tipGY = p.y + Math.sin(p.a) * FORK_TIP_TILES;
    const dist = Math.max(0.05, (face.gx - tipGX) * -face.nx + (face.gy - tipGY) * -face.ny);
    const reach = Math.min(2.2, dist) * TILE_M;
    this.laser.visible = true;
    this.laser.position.set(
      (tipGX + (Math.cos(p.a) * reach) / TILE_M / 2) * TILE_M,
      forkM + 0.155,
      (tipGY + (Math.sin(p.a) * reach) / TILE_M / 2) * TILE_M,
    );
    this.laser.rotation.set(0, objectYaw(p.a), 0);
    this.laser.scale.set(reach, 0.012, 0.012);
    (this.laser.material as THREE.MeshBasicMaterial).color.set(col);
    this.laserFace.visible = true;
    this.laserFace.position.set((face.gx + face.nx * 0.03) * TILE_M, forkM + 0.155, (face.gy + face.ny * 0.03) * TILE_M);
    this.laserFace.rotation.set(0, objectYaw(yawFace), 0);
    this.laserFace.scale.set(0.015, 0.03, 0.95 * TILE_M);
    (this.laserFace.material as THREE.MeshBasicMaterial).color.set(col);
  }

  private pipRect(): { x: number; y: number; w: number; h: number } {
    const compact = this.VW <= 680;
    const w = Math.round(Math.min(compact ? 0.42 : 0.24, 360 / this.VW) * this.VW);
    const h = Math.round((w * 3) / 4);
    // Top-right, clear of the objective bar; on phones keep above the touch controls.
    return { x: this.VW - w - 16, y: compact ? 96 : 104, w, h };
  }

  /** Picture-in-picture fork camera mounted on the carriage, looking straight at the shelf. */
  private renderForkCam(me: Vehicle, p: Pose, r: { x: number; y: number; w: number; h: number }): void {
    const gx = p.x + Math.cos(p.a) * 0.5;
    const gy = p.y + Math.sin(p.a) * 0.5;
    this.forkCam.position.set(gx * TILE_M, forkHeightM(me.fork ?? 0) + 0.155, gy * TILE_M);
    this.forkCam.rotation.set(0, -p.a - Math.PI / 2, 0);
    this.forkCam.aspect = r.w / r.h;
    this.forkCam.updateProjectionMatrix();
    this.forkCam.updateMatrixWorld();
    const yGl = this.VH - r.y - r.h;
    this.gl.setViewport(r.x, yGl, r.w, r.h);
    this.gl.setScissor(r.x, yGl, r.w, r.h);
    this.gl.setScissorTest(true);
    this.gl.clear();
    this.gl.render(this.scene, this.forkCam);
    this.gl.setScissorTest(false);
    this.gl.setViewport(0, 0, this.VW, this.VH);
  }

  // -------------------------------------------------------------------------------------------
  // 2D overlay (labels, gauge, fork-cam frame, flashes, callouts, bubbles)
  // -------------------------------------------------------------------------------------------

  private readonly v3 = new THREE.Vector3();

  /** Grid (gx, gy) at height zM metres → overlay CSS px; `null` when behind the camera. */
  worldToScreen(gx: number, gy: number, zM: number): [number, number] | null {
    this.v3.set(gx * TILE_M, zM, gy * TILE_M).project(this.camera);
    if (this.v3.z > 1 || this.v3.z < -1) return null;
    return [((this.v3.x + 1) / 2) * this.VW, ((1 - this.v3.y) / 2) * this.VH];
  }

  private drawOverlay(
    world: World,
    opts: RenderOptions,
    me: Vehicle,
    g: GuideInfo | null,
    target: LiftTarget | null,
    showLift: boolean,
    pip: { x: number; y: number; w: number; h: number } | null,
    nowMs: number,
  ): void {
    const ctx = this.ctx;
    const VW = this.VW;
    const VH = this.VH;
    ctx.clearRect(0, 0, VW, VH);

    // Guide label / off-screen chevron.
    if (g && g.x != null && g.y != null) {
      const col = this.guideColor(g, world, me);
      const label = this.guideLabel(world, me, g, target, opts);
      const s = this.worldToScreen(g.x + 0.5, g.y + 0.5, 3.4);
      const onScreen = s && s[0] > 40 && s[0] < VW - 40 && s[1] > 70 && s[1] < VH - 40;
      if (onScreen && s) {
        if (label) this.pill.pill(label, s[0], s[1], col);
      } else {
        this.drawEdgeChevron(me, g, col, label);
      }
    }

    // Rival callsigns + battery (Labels layer), like the zoomed-in iso view; nearby trucks only.
    if (opts.layers.labels) {
      const myP = this.poses.get(me.id);
      ctx.save();
      ctx.font = '700 11px Inter, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      for (const v of world.vehicles) {
        if (v.id === me.id) continue;
        const p = this.poses.get(v.id);
        if (!p || !myP || Math.hypot(p.x - myP.x, p.y - myP.y) > 14) continue;
        const s = this.worldToScreen(p.x, p.y, 5.6);
        if (!s || s[0] < 0 || s[0] > VW || s[1] < 0 || s[1] > VH) continue;
        ctx.lineWidth = 3;
        ctx.strokeStyle = 'rgba(255,255,255,0.9)';
        ctx.fillStyle = '#334155';
        ctx.strokeText(v.id, s[0], s[1]);
        ctx.fillText(v.id, s[0], s[1]);
        const bat = Math.max(0, Math.min(100, v.battery));
        ctx.fillStyle = 'rgba(15,23,42,0.18)';
        ctx.fillRect(s[0] - 13, s[1] + 7, 26, 4);
        ctx.fillStyle = bat < 20 ? '#DC2626' : bat < 40 ? '#D97706' : '#16A34A';
        ctx.fillRect(s[0] - 13, s[1] + 7, (26 * bat) / 100, 4);
      }
      ctx.restore();
    }

    // P0 stars over pallets in view.
    for (const o of world.orders) {
      if (!o.p0 || o.state === 'picked' || o.state === 'done') continue;
      const s = o.slot;
      const elevated = Boolean(opts.rackLiftEnabled && isRackSlot(s));
      const zM = (elevated ? beamTopM((s.level ?? 0) as 0 | 1 | 2) : 0) + 2.1;
      const px = elevated ? s.rx * 0.65 + s.ax * 0.35 : s.ax;
      const py = elevated ? s.ry * 0.65 + s.ay * 0.35 : s.ay;
      const pt = this.worldToScreen(px + 0.5, py + 0.5, zM);
      if (pt) this.pill.star(pt[0], pt[1], 8, '#FBBF24');
    }

    // Rack-lift: fork cam frame + docked gauge + prompts.
    if (showLift && target) {
      if (pip) this.drawPipFrame(pip, target, me);
      this.drawDockedGauge(target, me, Boolean(target.active));
      if (opts.rackLift?.isTwoTapConfirmPending()) this.pill.pill('TAP E AT SWEET SPOT', VW / 2, VH * 0.36, '#D97706');
    }
    const flash = opts.rackLift?.lastFlash(performance.now());
    if (flash) {
      const age = Math.max(0, performance.now() - flash.at);
      const col = flash.grade === 'perfect' ? '#16A34A' : flash.grade === 'clean' ? '#0284C7' : '#EA580C';
      this.pill.pill(flash.label, VW / 2, VH * 0.3 - Math.min(28, (age / 1350) * 26), col);
    }

    // Callouts float up from the lower centre (where your forks are).
    this.callouts = this.callouts.filter((c) => nowMs - c.born < CALLOUT_MS);
    this.callouts.forEach((c, i) => {
      const k = (nowMs - c.born) / CALLOUT_MS;
      ctx.save();
      ctx.globalAlpha = Math.max(0, 1 - k * k);
      this.pill.pill(c.text, VW / 2, VH * 0.58 - k * 40 - i * 26, calloutColor(c.tone));
      ctx.restore();
    });

    // Rival speech bubbles.
    this.bubbles = this.bubbles.filter((b) => nowMs - b.born < BUBBLE_MS);
    for (const b of this.bubbles) {
      const p = this.poses.get(b.vid);
      if (!p) continue;
      const s = this.worldToScreen(p.x, p.y, 4.2);
      if (!s) continue;
      const lines = wrapBubbleText(b.text);
      ctx.save();
      ctx.font = '600 12px sans-serif';
      const w = Math.max(...lines.map((l) => ctx.measureText(l).width)) + 16;
      const h = lines.length * 15 + 10;
      const x = Math.max(8, Math.min(VW - w - 8, s[0] - w / 2));
      const y = Math.max(8, s[1] - h);
      ctx.fillStyle = 'rgba(255,255,255,0.95)';
      ctx.strokeStyle = '#334155';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.roundRect(x, y, w, h, 8);
      ctx.fill();
      ctx.stroke();
      ctx.fillStyle = '#0F172A';
      ctx.textBaseline = 'top';
      lines.forEach((l, i) => ctx.fillText(l, x + 8, y + 6 + i * 15));
      ctx.restore();
    }
  }

  private guideLabel(world: World, me: Vehicle, g: GuideInfo, target: LiftTarget | null, opts: RenderOptions): string {
    const tier = target ? ` · ${RACK_LEVEL_LABELS[target.level]}` : '';
    if (g.kind === 'pick') {
      const id = g.order?.id;
      const what = id != null ? `#${id}` : '';
      if (target && g.inRange && opts.rackLiftEnabled) return `Hold E · Lift ${what}${tier}`.trim();
      return (g.inRange ? `E · Pick up ${what}` : id != null ? `Pick #${id}` : 'Pick').trim() + (target ? tier : '');
    }
    if (g.kind === 'drop' && g.stow) {
      const rack = g.order?.putaway?.rackId ?? me.cargo?.[0]?.putaway?.rackId ?? 'rack';
      if (target && g.inRange && opts.rackLiftEnabled) return `Hold E · Stow ${rack}${tier}`;
      return (g.inRange ? `E · Stow at ${rack}` : `Stow ${rack}`) + (target ? tier : '');
    }
    if (g.kind === 'drop') {
      const bay = g.order?.bay ?? world.map.bays.find((bb) => bb.tiles.some((t) => t.x === g.x && t.y === g.y))?.id;
      return g.inRange ? (bay ? `E · Drop at Bay ${bay}` : 'E · Drop') : bay ? `Bay ${bay}` : 'Bay';
    }
    if (g.kind === 'charge') return g.inRange ? 'E · Charge' : 'Charger';
    return g.inRange ? 'Press E' : '';
  }

  /** Target behind / beside you: chevron on the screen edge pointing the way to turn. */
  private drawEdgeChevron(me: Vehicle, g: GuideInfo, col: string, label: string): void {
    const p = this.poses.get(me.id) ?? { x: me.px, y: me.py, a: me.angle };
    const bearing = Math.atan2((g.y ?? 0) + 0.5 - p.y, (g.x ?? 0) + 0.5 - p.x);
    let rel = bearing - p.a;
    rel = Math.atan2(Math.sin(rel), Math.cos(rel)); // −π..π, + = to the right (y-down grid)
    const ctx = this.ctx;
    const cx = this.VW / 2;
    const cy = this.VH * 0.42;
    const r = Math.min(this.VW, this.VH) * 0.36;
    const x = cx + Math.sin(rel) * r;
    const y = cy - Math.cos(rel) * r * 0.6;
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(rel);
    ctx.fillStyle = col;
    ctx.strokeStyle = 'rgba(15,23,42,0.6)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(0, -16);
    ctx.lineTo(13, 10);
    ctx.lineTo(0, 4);
    ctx.lineTo(-13, 10);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    ctx.restore();
    if (label) this.pill.pill(label, Math.max(80, Math.min(this.VW - 80, x)), Math.max(90, Math.min(this.VH - 120, y + 30)), col);
  }

  private drawPipFrame(r: { x: number; y: number; w: number; h: number }, target: LiftTarget, me: Vehicle): void {
    const ctx = this.ctx;
    const nwin = rackLiftWindows(target.level, { forkLiftMul: target.forkLiftMul, district: target.district });
    const grade = liftGradeAt(me.fork ?? 0, nwin);
    ctx.save();
    ctx.strokeStyle = GRADE_COL[grade];
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.roundRect(r.x - 1.5, r.y - 1.5, r.w + 3, r.h + 3, 6);
    ctx.stroke();
    // Crosshair: the fork cam rides the carriage, so dead-centre = where the blades go.
    ctx.strokeStyle = 'rgba(248,250,252,0.85)';
    ctx.lineWidth = 1.25;
    const cx = r.x + r.w / 2;
    const cy = r.y + r.h / 2;
    ctx.beginPath();
    ctx.moveTo(cx - 18, cy);
    ctx.lineTo(cx - 5, cy);
    ctx.moveTo(cx + 5, cy);
    ctx.lineTo(cx + 18, cy);
    ctx.moveTo(cx, cy - 12);
    ctx.lineTo(cx, cy - 4);
    ctx.moveTo(cx, cy + 4);
    ctx.lineTo(cx, cy + 12);
    ctx.stroke();
    ctx.fillStyle = 'rgba(15,20,28,0.85)';
    ctx.fillRect(r.x, r.y, r.w, 18);
    ctx.font = '700 10px "JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, monospace';
    ctx.fillStyle = '#e2e8f0';
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'left';
    ctx.fillText(`FORK CAM · TARGET L${target.level + 1}`, r.x + 6, r.y + 9);
    ctx.restore();
  }

  /** Compact mast gauge docked at the right edge, drawn from the server's grading windows. */
  private drawDockedGauge(target: LiftTarget, me: Vehicle, active: boolean): void {
    const ctx = this.ctx;
    const nwin = rackLiftWindows(target.level, { forkLiftMul: target.forkLiftMul, district: target.district });
    const fork = Math.max(0, Math.min(1, me.fork ?? 0));
    const grade = liftGradeAt(fork, nwin);
    const compact = this.VW <= 680;
    const trackH = compact ? 150 : 180;
    const trackW = 18;
    const cardW = trackW + 44;
    const cardH = trackH + 30;
    const x = this.VW - cardW - 16;
    const y = Math.max(compact ? 96 : 104, Math.min(this.VH - cardH - (compact ? 170 : 72), this.VH * 0.5 - cardH / 2 + 60));
    const tx = x + 8;
    const ty = y + 22;
    const yOf = (f: number) => ty + (1 - Math.max(0, Math.min(1, f))) * trackH;
    ctx.save();
    ctx.fillStyle = 'rgba(15,20,28,0.92)';
    ctx.strokeStyle = active ? GRADE_COL[grade] : '#64748b';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.roundRect(x, y, cardW, cardH, 8);
    ctx.fill();
    ctx.stroke();
    ctx.font = '700 9.5px "JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = active ? '#6ee7b7' : '#e2e8f0';
    ctx.fillText(`LIFT L${target.level + 1}`, x + cardW / 2, y + 11);
    ctx.fillStyle = 'rgba(9,13,20,0.96)';
    ctx.fillRect(tx, ty, trackW, trackH);
    const band = (half: number, fill: string) => {
      const top = yOf(nwin.targetFork + half);
      const bot = yOf(nwin.targetFork - half);
      ctx.fillStyle = fill;
      ctx.fillRect(tx + 1.5, top, trackW - 3, Math.max(3, bot - top));
    };
    band(nwin.cleanWindow, 'rgba(245,158,11,0.42)');
    band(nwin.perfectWindow, 'rgba(16,185,129,0.88)');
    ctx.font = '700 11px "JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, monospace';
    ctx.textAlign = 'left';
    const levels = target.district === 'fast' ? 2 : 3;
    for (let l = 0; l < levels; l++) {
      const ly = yOf(RACK_LEVEL_FORK_TARGETS[l]);
      ctx.fillStyle = l === target.level ? '#6ee7b7' : '#94a3b8';
      ctx.fillText(`L${l + 1}`, tx + trackW + 6, ly);
    }
    const cy = yOf(fork);
    ctx.fillStyle = '#f8fafc';
    ctx.strokeStyle = GRADE_COL[grade];
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.roundRect(tx - 4, cy - 3, trackW + 8, 6, 2.5);
    ctx.fill();
    ctx.stroke();
    ctx.restore();
  }
}
