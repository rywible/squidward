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

const INTERVALS_MS: Record<SchedulerMode, number> = {
  active: 60_000,
  idle: 10 * 60_000,
  "off-hours": 30 * 60_000,
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
