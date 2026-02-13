import type { SchedulerMode } from "./types";

export interface SchedulerConfig {
  localBusinessHoursStart: number;
  localBusinessHoursEnd: number;
  businessDays: number[];
}

export interface SchedulerContext {
  now: Date;
  hasQueuedWork: boolean;
  hasActiveIncident: boolean;
  config?: Partial<SchedulerConfig>;
}

const DEFAULT_CONFIG: SchedulerConfig = {
  localBusinessHoursStart: 8,
  localBusinessHoursEnd: 18,
  businessDays: [1, 2, 3, 4, 5],
};

const asMs = (value: string | undefined, fallback: number): number => {
  const parsed = Number(value ?? "");
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.max(1_000, Math.min(120_000, parsed));
};

const INTERVALS_MS: Record<SchedulerMode, number> = {
  active: asMs(process.env.WORKER_HEARTBEAT_ACTIVE_MS, 2_000),
  idle: asMs(process.env.WORKER_HEARTBEAT_IDLE_MS, 5_000),
  "off-hours": asMs(process.env.WORKER_HEARTBEAT_OFF_HOURS_MS, 5_000),
};

export function isOffHours(now: Date, rawConfig?: Partial<SchedulerConfig>): boolean {
  const config = { ...DEFAULT_CONFIG, ...rawConfig };
  const day = now.getDay();
  if (!config.businessDays.includes(day)) {
    return true;
  }

  const hour = now.getHours();
  return hour < config.localBusinessHoursStart || hour >= config.localBusinessHoursEnd;
}

export function selectSchedulerMode(context: SchedulerContext): SchedulerMode {
  if (context.hasQueuedWork || context.hasActiveIncident) {
    return "active";
  }
  if (isOffHours(context.now, context.config)) {
    return "off-hours";
  }
  return "idle";
}

export function schedulerIntervalMs(mode: SchedulerMode): number {
  return INTERVALS_MS[mode];
}
