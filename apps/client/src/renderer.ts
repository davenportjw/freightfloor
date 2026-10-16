import * as PIXI from 'pixi.js';
import {
  floorKind,
  guide,
  HUMAN,
  isHighway,
  KINDS,
  laneDir,
  STRATEGIES,
  type Order,
  type Vehicle,
  type World,
  type WorldMap,
} from '@warehouse/sim';

export interface AtlasFrameRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface AtlasManifest {
  version: number;
  tileSize: number;
  vehicleCellSize: number;
  strategyTintMap: Record<string, string>;
  vehicleTypeAliases: Record<string, string>;
  sprites: Record<string, AtlasFrameRect>;
  frames: Record<string, { frame: AtlasFrameRect }>;
}

export interface RenderVehicleOverlay {
  brainThinking?: boolean;
  brainError?: string | null;
  isBot?: boolean;
}

export interface WarehouseRendererOptions {
  canvas: HTMLCanvasElement;
  onSelectVehicle?: (vid: string) => void;
  onClickTile?: (tileX: number, tileY: number) => void;
}

const TILE_PX = 36; // Display pixels per tile at zoom = 1.0
const CHUNK_TILES = 16; // 16x16 tiles per cached floor chunk

export function headingToIndex16(angleRad: number): number {
  const twoPi = Math.PI * 2;
  const norm = ((angleRad % twoPi) + twoPi) % twoPi;
  return Math.round((norm / twoPi) * 16) % 16;
}

export function resolveVehicleSpriteKey(
  vType: string | undefined,
  strategy: string | undefined,
  human: boolean | undefined,
  loaded: boolean,
  angleRad: number,
  manifest?: AtlasManifest | null,
): string {
  const canonicalType =
    (vType && manifest?.vehicleTypeAliases?.[vType]) ||
    (vType === 'reach' || vType === 'counterbalance' || vType === 'turret'
      ? vType
      : 'counterbalance');
  const stratKey = human ? 'Human' : strategy || 'Steady';
  const tint =
    manifest?.strategyTintMap?.[stratKey] ||
    (stratKey === 'Sprinter'
      ? 'rose'
      : stratKey === 'Steady'
        ? 'indigo'
        : stratKey === 'Batcher'
          ? 'emerald'
          : stratKey === 'Opportunist'
            ? 'amber'
            : stratKey === 'Strategist'
              ? 'slate'
              : 'teal');
  const loadState = loaded ? 'loaded' : 'empty';
  const h = headingToIndex16(angleRad);
  return `vehicle_${canonicalType}_${tint}_${loadState}_h${h}`;
}

export class WarehouseRenderer {
  private readonly canvas: HTMLCanvasElement;
  private readonly onSelectVehicle?: (vid: string) => void;
  private readonly onClickTile?: (tileX: number, tileY: number) => void;

  private pixiApp: PIXI.Application | null = null;
  private rootContainer: PIXI.Container | null = null;
  private ctx2d: CanvasRenderingContext2D | null = null;

  private atlasImage: HTMLImageElement | null = null;
  private atlasManifest: AtlasManifest | null = null;
  private pixiTextures = new Map<string, PIXI.Texture>();

  // Offscreen 16x16 tile floor chunk cache, rebuilt only when map.tier changes
  private cachedFloorTier = -1;
  private floorChunks = new Map<string, HTMLCanvasElement>();

  // Camera state
  public camX = 25 * TILE_PX;
  public camY = 17 * TILE_PX;
  public zoom = 1.0;
  public followActive = true;
  public coneMode = false;

  private isDragging = false;
  private dragStartX = 0;
  private dragStartY = 0;
  private dragMoved = false;

  public modeLabel = 'Atlas 48px · Y-Sorted';

  constructor(opts: WarehouseRendererOptions) {
    this.canvas = opts.canvas;
    this.onSelectVehicle = opts.onSelectVehicle;
    this.onClickTile = opts.onClickTile;
    this.attachPointerListeners();
  }

  async init(): Promise<void> {
    await this.loadAtlasAssets();

    // Initialize 2D context for crisp hybrid/chunk rendering + PixiJS v8 texture registry when WebGL is present
    const ctx = this.canvas.getContext('2d');
    if (ctx) {
      this.ctx2d = ctx;
    }

    if (typeof window !== 'undefined' && this.atlasImage && this.atlasManifest) {
      try {
        const source = new PIXI.ImageSource({ resource: this.atlasImage });
        for (const [key, rect] of Object.entries(this.atlasManifest.sprites)) {
          const tex = new PIXI.Texture({
            source,
            frame: new PIXI.Rectangle(rect.x, rect.y, rect.w, rect.h),
          });
          this.pixiTextures.set(key, tex);
        }
        this.modeLabel = `Pixi v${PIXI.VERSION} Atlas · ${this.pixiTextures.size} frames`;
      } catch {
        this.modeLabel = 'Atlas 48px · Y-Sorted';
      }
    }

    this.resize();
  }

  private async loadAtlasAssets(): Promise<void> {
    if (typeof fetch === 'undefined') return;
    try {
      const res = await fetch('/assets/atlas.json');
      if (res.ok) {
        this.atlasManifest = (await res.json()) as AtlasManifest;
      }
    } catch {
      // Headless test environment without static server
    }

    if (typeof Image !== 'undefined') {
      await new Promise<void>((resolvePromise) => {
        const img = new Image();
        img.crossOrigin = 'anonymous';
        img.onload = () => {
          this.atlasImage = img;
          resolvePromise();
        };
        img.onerror = () => resolvePromise();
        img.src = '/assets/atlas.png';
      });
    }
  }

  public getLoadedTextureCount(): number {
    return this.pixiTextures.size || Object.keys(this.atlasManifest?.sprites ?? {}).length;
  }

  public resize(): void {
    const parent = this.canvas.parentElement;
    if (!parent) return;
    const dpr = typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1;
    const w = Math.max(320, parent.clientWidth);
    const h = Math.max(240, parent.clientHeight);
    if (this.canvas.width !== Math.floor(w * dpr) || this.canvas.height !== Math.floor(h * dpr)) {
      this.canvas.width = Math.floor(w * dpr);
      this.canvas.height = Math.floor(h * dpr);
    }
    if (this.pixiApp) {
      this.pixiApp.renderer.resize(w, h);
    }
  }

  public fitFloor(map: WorldMap): void {
    const parent = this.canvas.parentElement;
    const viewW = parent?.clientWidth || 900;
    const viewH = parent?.clientHeight || 650;
    const mapPxW = map.w * TILE_PX;
    const mapPxH = map.h * TILE_PX;
    const zx = (viewW - 48) / mapPxW;
    const zy = (viewH - 48) / mapPxH;
    this.zoom = Math.max(0.42, Math.min(1.8, Math.min(zx, zy)));
    this.camX = mapPxW / 2;
    this.camY = mapPxH / 2;
    this.followActive = false;
  }

  private attachPointerListeners(): void {
    this.canvas.addEventListener('mousedown', (ev) => {
      if (ev.button !== 0) return;
      this.isDragging = true;
      this.dragMoved = false;
      this.dragStartX = ev.clientX;
      this.dragStartY = ev.clientY;
    });

    window.addEventListener('mousemove', (ev) => {
      if (!this.isDragging) return;
      const dx = ev.clientX - this.dragStartX;
      const dy = ev.clientY - this.dragStartY;
      if (Math.hypot(dx, dy) > 4) {
        this.dragMoved = true;
        this.followActive = false;
      }
      this.camX -= dx / this.zoom;
      this.camY -= dy / this.zoom;
      this.dragStartX = ev.clientX;
      this.dragStartY = ev.clientY;
    });

    window.addEventListener('mouseup', (ev) => {
      if (!this.isDragging) return;
      this.isDragging = false;
      if (!this.dragMoved) {
        this.handleCanvasClick(ev.clientX, ev.clientY);
      }
    });

    this.canvas.addEventListener(
      'wheel',
      (ev) => {
        ev.preventDefault();
        const factor = ev.deltaY < 0 ? 1.12 : 0.89;
        this.zoom = Math.max(0.4, Math.min(2.4, this.zoom * factor));
      },
      { passive: false },
    );
  }

  private lastWorld: World | null = null;

  private screenToWorldTile(clientX: number, clientY: number): { x: number; y: number } {
    const rect = this.canvas.getBoundingClientRect();
    const sx = clientX - rect.left;
    const sy = clientY - rect.top;
    const worldPxX = (sx - rect.width / 2) / this.zoom + this.camX;
    const worldPxY = (sy - rect.height / 2) / this.zoom + this.camY;
    return {
      x: worldPxX / TILE_PX,
      y: worldPxY / TILE_PX,
    };
  }

  private handleCanvasClick(clientX: number, clientY: number): void {
    if (!this.lastWorld) return;
    const pt = this.screenToWorldTile(clientX, clientY);
    const tileX = Math.floor(pt.x);
    const tileY = Math.floor(pt.y);

    if (this.coneMode && this.onClickTile) {
      this.onClickTile(tileX, tileY);
      return;
    }

    // Check if user clicked on a vehicle
    let closest: Vehicle | null = null;
    let bestD = 0.85;
    for (const v of this.lastWorld.vehicles) {
      const d = Math.hypot(v.px - pt.x, v.py - pt.y);
      if (d < bestD) {
        bestD = d;
        closest = v;
      }
    }

    if (closest && this.onSelectVehicle) {
      this.onSelectVehicle(closest.id);
    } else if (this.onClickTile && this.coneMode) {
      this.onClickTile(tileX, tileY);
    }
  }

  private drawAtlasSprite(
    ctx: CanvasRenderingContext2D,
    spriteName: string,
    dx: number,
    dy: number,
    dw: number,
    dh: number,
  ): boolean {
    if (!this.atlasImage || !this.atlasManifest) return false;
    const rect = this.atlasManifest.sprites[spriteName];
    if (!rect) return false;
    ctx.drawImage(this.atlasImage, rect.x, rect.y, rect.w, rect.h, dx, dy, dw, dh);
    return true;
  }

  /**
   * Re-bakes 16x16 floor chunks only when facility tier changes.
   */
  private ensureFloorChunks(map: WorldMap): void {
    if (this.cachedFloorTier === map.tier && this.floorChunks.size > 0) return;
    this.cachedFloorTier = map.tier;
    this.floorChunks.clear();

    if (typeof document === 'undefined') return;

    const chunksX = Math.ceil(map.w / CHUNK_TILES);
    const chunksY = Math.ceil(map.h / CHUNK_TILES);

    for (let cy = 0; cy < chunksY; cy++) {
      for (let cx = 0; cx < chunksX; cx++) {
        const chunkCanvas = document.createElement('canvas');
        chunkCanvas.width = CHUNK_TILES * TILE_PX;
        chunkCanvas.height = CHUNK_TILES * TILE_PX;
        const cctx = chunkCanvas.getContext('2d');
        if (!cctx) continue;

        for (let ty = 0; ty < CHUNK_TILES; ty++) {
          const gy = cy * CHUNK_TILES + ty;
          if (gy >= map.h) continue;
          for (let tx = 0; tx < CHUNK_TILES; tx++) {
            const gx = cx * CHUNK_TILES + tx;
            if (gx >= map.w) continue;

            const px = tx * TILE_PX;
            const py = ty * TILE_PX;
            const isWall = gx === 0 || gy === 0 || gx === map.w - 1 || gy === map.h - 1;
            const fk = floorKind(map, gx, gy);
            const hwy = isHighway(map, gx, gy);

            let floorSprite = 'floor_main';
            if (isWall) floorSprite = 'wall';
            else if (hwy) floorSprite = 'floor_aisle';
            else if (fk === 'cold') floorSprite = 'floor_cold';
            else if (fk === 'haz') floorSprite = 'floor_hazmat';
            else if (fk === 'bulk') floorSprite = 'floor_bulk';
            else if (fk === 'ambient') floorSprite = 'floor_ambient';

            if (!this.drawAtlasSprite(cctx, floorSprite, px, py, TILE_PX, TILE_PX)) {
              cctx.fillStyle = isWall
                ? '#334155'
                : hwy
                  ? '#e5dec9'
                  : fk === 'cold'
                    ? '#e0f2fe'
                    : fk === 'haz'
                      ? '#fef3c7'
                      : '#ece7dc';
              cctx.fillRect(px, py, TILE_PX, TILE_PX);
              cctx.strokeStyle = 'rgba(148, 163, 184, 0.22)';
              cctx.strokeRect(px + 0.5, py + 0.5, TILE_PX - 1, TILE_PX - 1);
            }

            // Draw subtle directional lane arrows on highway & aisles
            const dir = laneDir(map, gx, gy);
            if (dir && (dir[0] !== 0 || dir[1] !== 0) && (gx + gy) % 3 === 0) {
              cctx.save();
              cctx.translate(px + TILE_PX / 2, py + TILE_PX / 2);
              cctx.rotate(Math.atan2(dir[1], dir[0]));
              cctx.fillStyle = 'rgba(100, 116, 139, 0.28)';
              cctx.beginPath();
              cctx.moveTo(5, 0);
              cctx.lineTo(-4, -3.5);
              cctx.lineTo(-4, 3.5);
              cctx.closePath();
              cctx.fill();
              cctx.restore();
            }
          }
        }

        this.floorChunks.set(`${cx},${cy}`, chunkCanvas);
      }
    }
  }

  public render(
    w: World,
    selectedVid: string | null,
    myVid: string | null,
    overlays: Map<string, RenderVehicleOverlay>,
  ): void {
    this.lastWorld = w;
    this.resize();
    const ctx = this.ctx2d;
    if (!ctx) return;

    this.ensureFloorChunks(w.map);

    const activeId = myVid || selectedVid;
    if (this.followActive && activeId) {
      const targetV = w.vehicles.find((v) => v.id === activeId);
      if (targetV) {
        this.camX += (targetV.px * TILE_PX - this.camX) * 0.18;
        this.camY += (targetV.py * TILE_PX - this.camY) * 0.18;
      }
    }

    const dpr = typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1;
    const viewW = this.canvas.width / dpr;
    const viewH = this.canvas.height / dpr;

    ctx.save();
    ctx.scale(dpr, dpr);
    ctx.fillStyle = '#e5e0d3';
    ctx.fillRect(0, 0, viewW, viewH);

    ctx.translate(viewW / 2, viewH / 2);
    ctx.scale(this.zoom, this.zoom);
    ctx.translate(-this.camX, -this.camY);

    // 1. Draw cached 16x16 floor chunks
    const chunksX = Math.ceil(w.map.w / CHUNK_TILES);
    const chunksY = Math.ceil(w.map.h / CHUNK_TILES);
    for (let cy = 0; cy < chunksY; cy++) {
      for (let cx = 0; cx < chunksX; cx++) {
        const chunk = this.floorChunks.get(`${cx},${cy}`);
        if (chunk) {
          ctx.drawImage(chunk, cx * CHUNK_TILES * TILE_PX, cy * CHUNK_TILES * TILE_PX);
        }
      }
    }

    // Zone labels
    for (const z of w.map.zones) {
      const kInfo = KINDS[z.kind] || KINDS.ambient;
      ctx.fillStyle = 'rgba(30, 41, 59, 0.55)';
      ctx.font = '600 10px Inter, sans-serif';
      ctx.fillText(
        `${kInfo.label.toUpperCase()} ZONE`,
        (z.x + 0.3) * TILE_PX,
        (z.y - 0.25) * TILE_PX,
      );
    }

    // Index open orders by rack slot (`rx,ry`)
    const rackOrders = new Map<string, Order>();
    for (const o of w.orders) {
      if (o.state === 'open' || o.state === 'claimed') {
        rackOrders.set(`${o.slot.rx},${o.slot.ry}`, o);
      }
    }

    // 2. Build Y-sorted draw list for racks, conveyors, bays, chargers, spills, cones, and vehicles
    interface DrawItem {
      sortY: number;
      draw: () => void;
    }
    const yItems: DrawItem[] = [];

    const convPhase = Math.floor((w.t * 8) % 4);
    for (const r of w.map.racks) {
      const x = r.x;
      const y = r.y;
      const px = x * TILE_PX;
      const py = y * TILE_PX;
      const ord = rackOrders.get(`${x},${y}`);
      const fk = r.kind || floorKind(w.map, x, y);
      let spriteName = ord
        ? ord.p0
          ? 'rack_stocked_p0'
          : ord.card
            ? 'rack_stocked_card'
            : `rack_stocked_${fk}`
        : `rack_empty_${fk}`;
      if (!this.atlasManifest?.sprites[spriteName]) {
        spriteName = ord ? 'rack_stocked' : 'rack_empty';
      }
      yItems.push({
        sortY: y + 0.1,
        draw: () => {
          if (!this.drawAtlasSprite(ctx, spriteName, px, py, TILE_PX, TILE_PX)) {
            ctx.fillStyle = ord ? '#1e3a8a' : '#334155';
            ctx.fillRect(px + 2, py + 2, TILE_PX - 4, TILE_PX - 4);
          }
          if (ord?.isTransfer || ord?.destSite) {
            ctx.strokeStyle = '#6366f1';
            ctx.lineWidth = 2;
            ctx.strokeRect(px + 3, py + 3, TILE_PX - 6, TILE_PX - 6);
          }
        },
      });
    }

    for (const c of w.map.conveyors) {
      const px = c.x * TILE_PX;
      const py = c.y * TILE_PX;
      const spriteName = `conveyor_f${convPhase}`;
      yItems.push({
        sortY: c.y + 0.05,
        draw: () => {
          if (!this.drawAtlasSprite(ctx, spriteName, px, py, TILE_PX, TILE_PX)) {
            ctx.fillStyle = '#475569';
            ctx.fillRect(px + 2, py + 5, TILE_PX - 4, TILE_PX - 10);
          }
        },
      });
    }

    // Outbound Bays & Transfer Bays (`→ NET`)
    for (const b of w.map.bays) {
      const bayState = w.bays.find((bs) => bs.id === b.id);
      const isTransfer = Boolean(b.isTransferBay || bayState?.isTransferBay);
      const isAway = bayState ? w.t < bayState.departUntil : false;

      for (const t of b.tiles) {
        const px = t.x * TILE_PX;
        const py = t.y * TILE_PX;
        yItems.push({
          sortY: t.y + 0.08,
          draw: () => {
            const sprite = isTransfer
              ? 'transfer_bay_net'
              : isAway
                ? 'bay_east'
                : 'trailer';
            if (!this.drawAtlasSprite(ctx, sprite, px, py, TILE_PX, TILE_PX)) {
              ctx.fillStyle = isTransfer ? '#312e81' : '#1e293b';
              ctx.fillRect(px + 2, py + 2, TILE_PX - 4, TILE_PX - 4);
            }
          },
        });
      }

      // Bay label & load counter
      yItems.push({
        sortY: b.y + 0.9,
        draw: () => {
          const lx = (b.dropX - 0.8) * TILE_PX;
          const ly = (b.y + 0.5) * TILE_PX;
          ctx.fillStyle = isTransfer ? '#312e81' : '#0f172a';
          ctx.font = 'bold 10px Inter, sans-serif';
          const loadStr = bayState ? `${bayState.load}/${bayState.cap}` : '';
          const tag = isTransfer ? `${b.id} → NET (${loadStr})` : `${b.id} (${loadStr})`;
          ctx.fillText(tag, lx, ly);
        },
      });
    }

    // Chargers
    w.map.chargers.forEach((c, idx) => {
      const busy = w.vehicles.some((v) => v.chargerIdx === idx || (v.humanCharging && v.tile.x === c.x && v.tile.y === c.y));
      const px = c.x * TILE_PX;
      const py = c.y * TILE_PX;
      yItems.push({
        sortY: c.y + 0.06,
        draw: () => {
          const sName = busy ? 'charger_busy' : 'charger';
          if (!this.drawAtlasSprite(ctx, sName, px, py, TILE_PX, TILE_PX)) {
            ctx.fillStyle = busy ? '#065f46' : '#0f172a';
            ctx.fillRect(px + 4, py + 4, TILE_PX - 8, TILE_PX - 8);
          }
        },
      });
    });

    // Spills / Hazards
    for (const h of w.spills) {
      const px = h.x * TILE_PX;
      const py = h.y * TILE_PX;
      yItems.push({
        sortY: h.y + 0.12,
        draw: () => {
          if (!this.drawAtlasSprite(ctx, 'spill', px, py, TILE_PX, TILE_PX)) {
            ctx.fillStyle = 'rgba(234, 179, 8, 0.75)';
            ctx.beginPath();
            ctx.arc(px + TILE_PX / 2, py + TILE_PX / 2, TILE_PX * 0.35, 0, Math.PI * 2);
            ctx.fill();
          }
        },
      });
    }

    // Cones
    for (const coneKey of w.cones) {
      const [cxStr, cyStr] = coneKey.split(',');
      const cx = Number(cxStr);
      const cy = Number(cyStr);
      if (!Number.isFinite(cx) || !Number.isFinite(cy)) continue;
      const px = cx * TILE_PX;
      const py = cy * TILE_PX;
      yItems.push({
        sortY: cy + 0.2,
        draw: () => {
          if (!this.drawAtlasSprite(ctx, 'cone', px, py, TILE_PX, TILE_PX)) {
            ctx.fillStyle = '#ea580c';
            ctx.beginPath();
            ctx.arc(px + TILE_PX / 2, py + TILE_PX / 2, 8, 0, Math.PI * 2);
            ctx.fill();
          }
        },
      });
    }

    // Guide ring & path beam for selected/driven vehicle
    const focusV =
      w.vehicles.find((v) => v.id === (myVid || selectedVid)) || w.vehicles[0];
    if (focusV) {
      // Draw planned AI path if available
      if (focusV.path && focusV.path.length > 0) {
        ctx.save();
        ctx.strokeStyle = 'rgba(13, 148, 136, 0.45)';
        ctx.lineWidth = 2.5;
        ctx.setLineDash([5, 4]);
        ctx.beginPath();
        ctx.moveTo(focusV.px * TILE_PX, focusV.py * TILE_PX);
        for (const pt of focusV.path) {
          ctx.lineTo((pt.x + 0.5) * TILE_PX, (pt.y + 0.5) * TILE_PX);
        }
        ctx.stroke();
        ctx.restore();
      }

      const g = guide(w, focusV);
      if (g && g.x != null && g.y != null) {
        const gx = (g.x + 0.5) * TILE_PX;
        const gy = (g.y + 0.5) * TILE_PX;
        const ringColor =
          g.kind === 'pick' ? '#d97706' : g.kind === 'drop' ? '#0d9488' : '#16a34a';
        ctx.save();
        ctx.strokeStyle = ringColor;
        ctx.lineWidth = 2.5;
        ctx.setLineDash([4, 3]);
        ctx.beginPath();
        ctx.moveTo(focusV.px * TILE_PX, focusV.py * TILE_PX);
        ctx.lineTo(gx, gy);
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.beginPath();
        ctx.arc(gx, gy, TILE_PX * 0.48, 0, Math.PI * 2);
        ctx.stroke();
        ctx.restore();
      }
    }

    // Vehicles (Y-sorted by py)
    for (const v of w.vehicles) {
      const ov = overlays.get(v.id);
      const brainError = v.brainError || ov?.brainError || null;
      const brainThinking =
        Boolean(ov?.brainThinking) ||
        w.pendingDecisions.some((req) => req.agentId === v.id);
      const isBot = Boolean(ov?.isBot);
      const isSelected = v.id === selectedVid || v.id === myVid;

      yItems.push({
        sortY: v.py + 0.5,
        draw: () => {
          const vx = v.px * TILE_PX;
          const vy = v.py * TILE_PX;
          const size = TILE_PX * 1.18;

          if (isSelected) {
            ctx.save();
            ctx.strokeStyle = v.id === myVid ? '#0d9488' : '#4f46e5';
            ctx.lineWidth = 2.2;
            ctx.beginPath();
            ctx.arc(vx, vy, TILE_PX * 0.52, 0, Math.PI * 2);
            ctx.stroke();
            ctx.restore();
          }

          if (brainError) {
            ctx.save();
            ctx.strokeStyle = '#e11d48';
            ctx.lineWidth = 2.5;
            ctx.beginPath();
            ctx.arc(vx, vy, TILE_PX * 0.56, 0, Math.PI * 2);
            ctx.stroke();
            ctx.restore();
          }

          const spriteKey = resolveVehicleSpriteKey(
            v.type,
            v.strategy,
            v.human,
            v.cargo.length > 0,
            v.angle,
            this.atlasManifest,
          );

          if (!this.drawAtlasSprite(ctx, spriteKey, vx - size / 2, vy - size / 2, size, size)) {
            const stratColor = v.human
              ? HUMAN.color
              : STRATEGIES[v.strategy]?.color || '#4f46e5';
            ctx.save();
            ctx.translate(vx, vy);
            ctx.rotate(v.angle);
            ctx.fillStyle = stratColor;
            ctx.fillRect(-11, -8, 22, 16);
            ctx.restore();
          }

          // Battery mini-bar below vehicle
          const bw = 24;
          const bh = 3.5;
          ctx.fillStyle = 'rgba(15, 23, 42, 0.65)';
          ctx.fillRect(vx - bw / 2, vy + 15, bw, bh);
          ctx.fillStyle =
            v.battery > 40 ? '#22c55e' : v.battery > 20 ? '#f59e0b' : '#ef4444';
          ctx.fillRect(
            vx - bw / 2,
            vy + 15,
            bw * Math.max(0, Math.min(1, v.battery / 100)),
            bh,
          );

          // Floating label above vehicle (ID / Driver + BOT / Thinking / Brain Error badge)
          ctx.font = 'bold 9.5px Inter, sans-serif';
          ctx.textAlign = 'center';
          const baseLabel = v.driver ? `${v.id} · ${v.driver}` : `${v.id}`;
          const fullLabel = isBot ? `${baseLabel} [BOT]` : baseLabel;
          ctx.fillStyle = '#0f172a';
          ctx.fillText(fullLabel, vx, vy - 17);

          if (brainError) {
            const errBadge = '! BRAIN ERR';
            ctx.fillStyle = '#be123c';
            ctx.fillRect(vx - 30, vy - 31, 60, 11);
            ctx.fillStyle = '#ffffff';
            ctx.font = 'bold 8.5px Inter, sans-serif';
            ctx.fillText(errBadge, vx, vy - 23);
          } else if (brainThinking) {
            ctx.fillStyle = '#4f46e5';
            ctx.fillRect(vx - 20, vy - 31, 40, 11);
            ctx.fillStyle = '#ffffff';
            ctx.font = 'bold 8.5px Inter, sans-serif';
            ctx.fillText('⋯ AI', vx, vy - 23);
          }
        },
      });
    }

    yItems.sort((a, b) => a.sortY - b.sortY);
    for (const item of yItems) {
      item.draw();
    }

    // Incident / Near-miss markers
    for (const m of w.markers) {
      if (m.until <= w.t) continue;
      const mx = (m.x + 0.5) * TILE_PX;
      const my = (m.y + 0.5) * TILE_PX;
      ctx.strokeStyle = m.kind === 'incident' ? '#e11d48' : '#f59e0b';
      ctx.lineWidth = 2.5;
      ctx.beginPath();
      ctx.arc(mx, my, TILE_PX * 0.45, 0, Math.PI * 2);
      ctx.stroke();
    }

    ctx.restore();
  }
}
