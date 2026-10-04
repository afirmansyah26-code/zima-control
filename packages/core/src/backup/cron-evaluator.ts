/**
 * Zima Control Center — Cron Expression Evaluator & Schedule Engine
 *
 * Implements deterministic schedule evaluation, next-run, and previous-run
 * calculations against standard 5-part cron syntax:
 *   [minute] [hour] [day-of-month] [month] [day-of-week]
 *
 * Authoritative Timezone: UTC.
 * All computations use UTC methods (Date.getUTC*).
 *
 * Reference: docs/ZCC-BACKUP-FOUNDATION-PRD.md & docs/ZCC-SCHEDULER-AND-RETENTION.md
 */

import { BackupDomainError } from "./contracts.js";
import { validateCronExpression } from "./cron-validator.js";

export class BackupCronInvalidError extends BackupDomainError {
  constructor(expression: unknown) {
    super(`Invalid cron expression: '${String(expression)}'`, "CRON_EXPRESSION_INVALID");
    this.name = "BackupCronInvalidError";
  }
}

export interface ParsedCronSchedule {
  readonly minutes: Set<number>;
  readonly hours: Set<number>;
  readonly daysOfMonth: Set<number>;
  readonly months: Set<number>;
  readonly daysOfWeek: Set<number>;
  readonly isDayOfMonthWildcard: boolean;
  readonly isDayOfWeekWildcard: boolean;
}

/**
 * Parses a validated 5-part cron expression into discrete sets of allowed values.
 */
export function parseCronSchedule(expression: string): ParsedCronSchedule {
  if (!validateCronExpression(expression)) {
    throw new BackupCronInvalidError(expression);
  }

  const fields = expression.trim().split(/\s+/);
  const [minField, hourField, domField, monthField, dowField] = fields;

  const minutes = parseCronField(minField, 0, 59);
  const hours = parseCronField(hourField, 0, 23);
  const daysOfMonth = parseCronField(domField, 1, 31);
  const months = parseCronField(monthField, 1, 12);
  const daysOfWeek = parseCronField(dowField, 0, 7, true);

  return {
    minutes,
    hours,
    daysOfMonth,
    months,
    daysOfWeek,
    isDayOfMonthWildcard: domField === "*",
    isDayOfWeekWildcard: dowField === "*",
  };
}

function parseCronField(
  field: string,
  min: number,
  max: number,
  isDayOfWeek = false,
): Set<number> {
  const result = new Set<number>();
  const subparts = field.split(",");

  for (const part of subparts) {
    if (part.includes("/")) {
      const [rangePart, stepPart] = part.split("/");
      const step = parseInt(stepPart, 10);
      let start = min;
      let end = max;
      if (rangePart !== "*") {
        const [rStart, rEnd] = rangePart.split("-").map(Number);
        start = rStart;
        end = rEnd !== undefined ? rEnd : max;
      }
      for (let i = start; i <= end; i += step) {
        result.add(isDayOfWeek && i === 7 ? 0 : i);
      }
    } else if (part.includes("-")) {
      const [start, end] = part.split("-").map(Number);
      for (let i = start; i <= end; i++) {
        result.add(isDayOfWeek && i === 7 ? 0 : i);
      }
    } else if (part === "*") {
      for (let i = min; i <= max; i++) {
        result.add(isDayOfWeek && i === 7 ? 0 : i);
      }
    } else {
      const val = Number(part);
      result.add(isDayOfWeek && val === 7 ? 0 : val);
    }
  }

  return result;
}

/**
 * Standard POSIX cron day matching:
 * - If DOM and DOW are both wildcard: matches every day.
 * - If DOM is restricted and DOW is wildcard: DOM must match.
 * - If DOM is wildcard and DOW is restricted: DOW must match.
 * - If both are restricted: DOM matches OR DOW matches (union).
 */
function matchesDay(
  parsed: ParsedCronSchedule,
  dayOfMonth: number,
  dayOfWeek: number,
): boolean {
  if (parsed.isDayOfMonthWildcard && parsed.isDayOfWeekWildcard) {
    return true;
  }
  if (!parsed.isDayOfMonthWildcard && parsed.isDayOfWeekWildcard) {
    return parsed.daysOfMonth.has(dayOfMonth);
  }
  if (parsed.isDayOfMonthWildcard && !parsed.isDayOfWeekWildcard) {
    return parsed.daysOfWeek.has(dayOfWeek);
  }
  return parsed.daysOfMonth.has(dayOfMonth) || parsed.daysOfWeek.has(dayOfWeek);
}

function daysInMonth(year: number, month1Indexed: number): number {
  return new Date(Date.UTC(year, month1Indexed, 0)).getUTCDate();
}

/**
 * Calculates the next deterministic scheduled occurrence strictly AFTER fromDate in UTC.
 * @param expression Valid standard 5-part cron expression.
 * @param fromDate Starting timestamp (defaults to Date.now()).
 * @returns Date in UTC at :00 seconds and :000 milliseconds.
 */
export function getNextCronOccurrence(
  expression: string,
  fromDate: Date = new Date(),
): Date {
  const parsed = parseCronSchedule(expression);

  // Advance by 1 minute and truncate seconds/millis to find next strict occurrence
  let cursor = new Date(
    Date.UTC(
      fromDate.getUTCFullYear(),
      fromDate.getUTCMonth(),
      fromDate.getUTCDate(),
      fromDate.getUTCHours(),
      fromDate.getUTCMinutes() + 1,
      0,
      0,
    ),
  );

  // Maximum search horizon: 5 years (approx 2,628,000 minutes) to avoid infinite loops on impossible constraints
  const maxHorizonMs = cursor.getTime() + 5 * 366 * 86_400_000;

  while (cursor.getTime() <= maxHorizonMs) {
    const year = cursor.getUTCFullYear();
    const month = cursor.getUTCMonth() + 1; // 1-12

    if (!parsed.months.has(month)) {
      // Fast-forward to 1st of next month at 00:00 UTC
      cursor = new Date(Date.UTC(year, month, 1, 0, 0, 0, 0));
      continue;
    }

    const maxDays = daysInMonth(year, month);
    const dayOfMonth = cursor.getUTCDate();
    const dayOfWeek = cursor.getUTCDay(); // 0-6

    if (dayOfMonth > maxDays || !matchesDay(parsed, dayOfMonth, dayOfWeek)) {
      // Fast-forward to start of next day at 00:00 UTC
      cursor = new Date(Date.UTC(year, month - 1, dayOfMonth + 1, 0, 0, 0, 0));
      continue;
    }

    const hour = cursor.getUTCHours();
    if (!parsed.hours.has(hour)) {
      // Fast-forward to start of next hour at :00 UTC
      cursor = new Date(Date.UTC(year, month - 1, dayOfMonth, hour + 1, 0, 0, 0));
      continue;
    }

    const minute = cursor.getUTCMinutes();
    if (!parsed.minutes.has(minute)) {
      // Advance 1 minute
      cursor = new Date(cursor.getTime() + 60_000);
      continue;
    }

    return cursor;
  }

  throw new BackupCronInvalidError(
    `No matching cron occurrence found within 5-year horizon for expression: '${expression}'`,
  );
}

/**
 * Calculates the most recent scheduled occurrence BEFORE or EQUAL to fromDate in UTC.
 * @param expression Valid standard 5-part cron expression.
 * @param fromDate Starting timestamp (defaults to Date.now()).
 * @param inclusive If true and fromDate matches a scheduled slot (:00s), returns fromDate. If false, strictly before.
 * @returns Date in UTC at :00 seconds and :000 milliseconds.
 */
export function getPreviousCronOccurrence(
  expression: string,
  fromDate: Date = new Date(),
  inclusive = true,
): Date {
  const parsed = parseCronSchedule(expression);

  let cursor = new Date(
    Date.UTC(
      fromDate.getUTCFullYear(),
      fromDate.getUTCMonth(),
      fromDate.getUTCDate(),
      fromDate.getUTCHours(),
      fromDate.getUTCMinutes(),
      0,
      0,
    ),
  );

  if (!inclusive) {
    cursor = new Date(cursor.getTime() - 60_000);
  }

  // Maximum search horizon: 5 years backward
  const minHorizonMs = cursor.getTime() - 5 * 366 * 86_400_000;

  while (cursor.getTime() >= minHorizonMs) {
    const year = cursor.getUTCFullYear();
    const month = cursor.getUTCMonth() + 1; // 1-12

    if (!parsed.months.has(month)) {
      // Step back to last minute of previous month: Year, Month-1, 0 is last day of prev month
      // month - 1 in Date.UTC is month - 2 in 0-indexed, so Date.UTC(year, month - 1, 0, 23, 59, 0, 0)
      cursor = new Date(Date.UTC(year, month - 1, 0, 23, 59, 0, 0));
      continue;
    }

    const dayOfMonth = cursor.getUTCDate();
    const dayOfWeek = cursor.getUTCDay(); // 0-6

    if (!matchesDay(parsed, dayOfMonth, dayOfWeek)) {
      // Step back to 23:59 of previous day
      cursor = new Date(Date.UTC(year, month - 1, dayOfMonth - 1, 23, 59, 0, 0));
      continue;
    }

    const hour = cursor.getUTCHours();
    if (!parsed.hours.has(hour)) {
      // Step back to :59 of previous hour
      cursor = new Date(Date.UTC(year, month - 1, dayOfMonth, hour - 1, 59, 0, 0));
      continue;
    }

    const minute = cursor.getUTCMinutes();
    if (!parsed.minutes.has(minute)) {
      cursor = new Date(cursor.getTime() - 60_000);
      continue;
    }

    return cursor;
  }

  throw new BackupCronInvalidError(
    `No matching cron occurrence found within 5-year backward horizon for expression: '${expression}'`,
  );
}

/**
 * Checks if a scheduled backup is due right now.
 *
 * A schedule is due if:
 * 1. The most recent schedule slot S_prev <= now.
 * 2. S_prev > lastScheduleTimestamp (meaning S_prev has not been triggered or covered yet).
 */
export function checkScheduleDue(
  expression: string,
  lastScheduleTimestamp: Date | null,
  now: Date = new Date(),
): { isDue: boolean; dueSlot: Date; nextRun: Date } {
  const dueSlot = getPreviousCronOccurrence(expression, now, true);
  const nextRun = getNextCronOccurrence(expression, now);

  if (!lastScheduleTimestamp) {
    // If never scheduled, it is due for the most recent slot
    return { isDue: true, dueSlot, nextRun };
  }

  const isDue = dueSlot.getTime() > lastScheduleTimestamp.getTime();
  return { isDue, dueSlot, nextRun };
}
