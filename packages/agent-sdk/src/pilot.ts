import type { FloorObservation, FreightFloorAgentClient } from './client.js';
import { computeSteeringControls } from './steering.js';

export type AgentDecision =
  | {
      action: 'driveTo';
      x: number;
      y: number;
      boost?: boolean;
      interactWhenClose?: boolean;
      reason?: string;
    }
  | {
      action: 'deliverOrder';
      orderId?: number;
      pickupX: number;
      pickupY: number;
      dropX: number;
      dropY: number;
      boost?: boolean;
      reason?: string;
    }
  | {
      action: 'keepCards';
      cardIds: string[];
      reason?: string;
    }
  | {
      action: 'idle';
      reason?: string;
    };

export interface PilotLoopOptions {
  /** Async strategy callback (call your own LLM, RL model, or heuristic here). */
  decide: (obs: FloorObservation) => Promise<AgentDecision> | AgentDecision;
  /** How often `decide()` is invoked in ms (default 1000ms = 1 Hz). */
  decisionIntervalMs?: number;
  /** Local steering tick interval in ms (default 100ms = 10 Hz). */
  steeringIntervalMs?: number;
  /** Optional error callback if `decide()` throws. */
  onDecisionError?: (err: unknown) => void;
}

/**
 * Local 10 Hz steering harness paired with a low-frequency (e.g. 1 Hz) async `decide()` callback.
 * Keeps real-time forklift steering smooth on the user's machine while their LLM thinks at its own pace.
 */
export class PilotLoop {
  private steerTimer: ReturnType<typeof setInterval> | null = null;
  private decideTimer: ReturnType<typeof setInterval> | null = null;
  private deciding = false;
  private currentDecision: AgentDecision | null = null;
  private stuckTicks = 0;
  private lastInteractAtMs = 0;

  constructor(
    private readonly client: FreightFloorAgentClient,
    private readonly opts: PilotLoopOptions,
  ) {}

  start(): void {
    if (this.steerTimer || this.decideTimer) return;
    const steerMs = Math.max(50, this.opts.steeringIntervalMs ?? 100);
    const decideMs = Math.max(200, this.opts.decisionIntervalMs ?? 1_000);

    const runDecision = async () => {
      if (this.deciding || !this.client.isConnected) return;
      const obs = this.client.getObservation();
      if (!obs || !obs.self) return;
      this.deciding = true;
      try {
        const decision = await this.opts.decide(obs);
        this.currentDecision = decision;
        if (decision.action === 'keepCards' && decision.cardIds.length > 0) {
          this.client.keepCards(decision.cardIds);
        } else if (
          decision.action === 'deliverOrder' &&
          typeof decision.orderId === 'number' &&
          obs.self?.fareOfferOrderIds?.includes(decision.orderId)
        ) {
          this.client.chooseOrder(decision.orderId);
        }
      } catch (err) {
        this.opts.onDecisionError?.(err);
      } finally {
        this.deciding = false;
      }
    };

    void runDecision();
    this.decideTimer = setInterval(() => {
      void runDecision();
    }, decideMs);

    this.steerTimer = setInterval(() => {
      this.steerStep();
    }, steerMs);
  }

  stop(): void {
    if (this.steerTimer) {
      clearInterval(this.steerTimer);
      this.steerTimer = null;
    }
    if (this.decideTimer) {
      clearInterval(this.decideTimer);
      this.decideTimer = null;
    }
  }

  private steerStep(): void {
    if (!this.client.isConnected) return;
    const obs = this.client.getObservation();
    if (!obs?.self) return;
    const self = obs.self;
    const decision = this.currentDecision;

    if (!decision || decision.action === 'idle' || decision.action === 'keepCards') {
      this.client.sendInput({ up: false, down: false, left: false, right: false });
      return;
    }

    let targetX: number;
    let targetY: number;
    let shouldInteract = true;
    const boost = Boolean(decision.boost);

    if (decision.action === 'driveTo') {
      targetX = decision.x;
      targetY = decision.y;
      shouldInteract = decision.interactWhenClose !== false;
    } else {
      // deliverOrder: head to drop bay when carrying cargo, otherwise pickup coordinates
      if (self.cargoCount > 0) {
        targetX = self.guide?.kind === 'drop' && typeof self.guide.x === 'number'
          ? self.guide.x
          : decision.dropX;
        targetY = self.guide?.kind === 'drop' && typeof self.guide.y === 'number'
          ? self.guide.y
          : decision.dropY;
      } else {
        targetX = decision.pickupX;
        targetY = decision.pickupY;
      }
    }

    const { controls, distance, nextStuckTicks } = computeSteeringControls({
      vx: self.x,
      vy: self.y,
      angle: self.angle,
      speedNow: self.speedNow,
      targetX,
      targetY,
      stuckTicks: this.stuckTicks,
      obstacles: obs.otherVehicles,
    });
    this.stuckTicks = nextStuckTicks;

    this.client.sendInput({
      ...controls,
      boost: boost && (controls.up || typeof controls.moveAngle === 'number') && self.battery > 25,
    });

    // Only interact when actually at the intended target (never on a stale inRange right after pickup)
    // and debounce so one arrival cannot double-toggle pickup + drop.
    const nowMs = Date.now();
    if (shouldInteract && distance <= 1.85 && nowMs - this.lastInteractAtMs >= 600) {
      this.lastInteractAtMs = nowMs;
      this.client.interact();
    }
  }
}
