import { AgentRuntimeError } from '../core/errors.js';
import { allow, type Policy } from '../core/policy.js';
import type { WorkspaceAgentSchedule } from '../workspace-agents/types.js';

export interface ParsedSchedule {
  readonly expression: string;
  readonly timezone: string;
  next(after: Date): Date;
}

export interface ScheduledRunRef {
  readonly schedule_id: string;
  readonly scheduled_for: string;
  readonly started_at: string;
  readonly metadata: Readonly<Record<string, unknown>>;
}

export function parseSchedule(expression: string, timezone = 'UTC'): ParsedSchedule {
  validateTimezone(timezone);
  const interval = /^(?:every\s+)?(\d+)\s*(m|h|d)$/i.exec(expression.trim());
  if (interval !== null) {
    const amount = Number(interval[1]);
    const unit = interval[2]?.toLowerCase();
    if (amount < 1) throw scheduleError(expression);
    const multiplier = unit === 'm' ? 60_000 : unit === 'h' ? 3_600_000 : 86_400_000;
    return {
      expression,
      timezone,
      next: (after) => new Date(after.getTime() + amount * multiplier),
    };
  }
  const fields = expression.trim().split(/\s+/);
  if (fields.length !== 5) throw scheduleError(expression);
  const matchers = [
    cronField(fields[0]!, 0, 59),
    cronField(fields[1]!, 0, 23),
    cronField(fields[2]!, 1, 31),
    cronField(fields[3]!, 1, 12),
    cronField(fields[4]!, 0, 6),
  ];
  return {
    expression,
    timezone,
    next: (after) => {
      let candidate = new Date(Math.floor(after.getTime() / 60_000) * 60_000 + 60_000);
      const limit = candidate.getTime() + 366 * 24 * 60 * 60_000;
      while (candidate.getTime() <= limit) {
        const parts = zonedParts(candidate, timezone);
        if (matchers.every((allowed, index) => allowed.has(parts[index]!))) return candidate;
        candidate = new Date(candidate.getTime() + 60_000);
      }
      throw new AgentRuntimeError(
        `Cron schedule '${expression}' has no occurrence within one year.`,
        { code: 'schedule_no_occurrence' },
      );
    },
  };
}

export class ScheduleExecutor {
  private readonly last = new Map<string, string>();

  constructor(
    private readonly execute: (
      schedule: WorkspaceAgentSchedule,
      ref: ScheduledRunRef,
    ) => void | Promise<void>,
    private readonly policy?: Policy,
    private readonly now = () => new Date(),
  ) {}

  async runDue(
    schedules: readonly WorkspaceAgentSchedule[],
    since: Date,
  ): Promise<readonly ScheduledRunRef[]> {
    const now = this.now();
    const refs: ScheduledRunRef[] = [];
    for (const schedule of schedules) {
      if (schedule.enabled === false) continue;
      const parsed = parseSchedule(schedule.expression, schedule.timezone);
      let due = parsed.next(since);
      let latest: Date | undefined;
      while (due <= now) {
        latest = due;
        due = parsed.next(due);
      }
      if (latest === undefined || this.last.get(schedule.id) === latest.toISOString()) continue;
      const decision =
        (await this.policy?.check({
          checkpoint: 'before_scheduled_run',
          action: schedule.id,
          arguments: { scheduled_for: latest.toISOString(), input: schedule.input },
          metadata: {},
        })) ?? allow();
      if (decision.verdict !== 'allow') continue;
      const ref = {
        schedule_id: schedule.id,
        scheduled_for: latest.toISOString(),
        started_at: now.toISOString(),
        metadata: { collapsed_missed_windows: true },
      };
      await this.execute(schedule, ref);
      this.last.set(schedule.id, ref.scheduled_for);
      refs.push(ref);
    }
    return refs;
  }
}

function cronField(value: string, minimum: number, maximum: number): ReadonlySet<number> {
  const result = new Set<number>();
  for (const segment of value.split(',')) {
    const [range, stepText] = segment.split('/');
    const step = stepText === undefined ? 1 : Number(stepText);
    if (!Number.isInteger(step) || step < 1) throw scheduleError(value);
    const [start, end] =
      range === '*'
        ? [minimum, maximum]
        : range!.includes('-')
          ? range!.split('-').map(Number)
          : [Number(range), Number(range)];
    if (
      !Number.isInteger(start) ||
      !Number.isInteger(end) ||
      start! < minimum ||
      end! > maximum ||
      start! > end!
    )
      throw scheduleError(value);
    for (let current = start!; current <= end!; current += step) result.add(current);
  }
  return result;
}

function zonedParts(date: Date, timezone: string): readonly number[] {
  const values = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      minute: 'numeric',
      hour: 'numeric',
      day: 'numeric',
      month: 'numeric',
      weekday: 'short',
      hourCycle: 'h23',
    })
      .formatToParts(date)
      .map((part) => [part.type, part.value]),
  );
  const weekdays: Record<string, number> = {
    Sun: 0,
    Mon: 1,
    Tue: 2,
    Wed: 3,
    Thu: 4,
    Fri: 5,
    Sat: 6,
  };
  return [
    Number(values.minute),
    Number(values.hour),
    Number(values.day),
    Number(values.month),
    weekdays[values.weekday ?? ''] ?? -1,
  ];
}

function validateTimezone(timezone: string): void {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: timezone }).format();
  } catch (cause) {
    throw new AgentRuntimeError(`Unknown schedule timezone '${timezone}'.`, {
      code: 'invalid_schedule_timezone',
      cause,
    });
  }
}

function scheduleError(expression: string): AgentRuntimeError {
  return new AgentRuntimeError(`Invalid schedule expression '${expression}'.`, {
    code: 'invalid_schedule',
  });
}
