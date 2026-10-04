import test from "node:test";
import assert from "node:assert/strict";
import {
  parseCronSchedule,
  getNextCronOccurrence,
  getPreviousCronOccurrence,
  checkScheduleDue,
  BackupCronInvalidError,
} from "./cron-evaluator.js";

test("Cron Evaluator: parses standard 5-part cron syntax accurately", () => {
  const parsed = parseCronSchedule("0 2 * * *");
  assert.equal(parsed.minutes.size, 1);
  assert.ok(parsed.minutes.has(0));
  assert.equal(parsed.hours.size, 1);
  assert.ok(parsed.hours.has(2));
  assert.equal(parsed.daysOfMonth.size, 31);
  assert.equal(parsed.months.size, 12);
  assert.equal(parsed.daysOfWeek.size, 7);
  assert.equal(parsed.isDayOfMonthWildcard, true);
  assert.equal(parsed.isDayOfWeekWildcard, true);
});

test("Cron Evaluator: parses step and range expressions correctly", () => {
  const parsed = parseCronSchedule("*/15 2-4 * * 1-5");
  // minutes: 0, 15, 30, 45
  assert.deepEqual(Array.from(parsed.minutes).sort((a, b) => a - b), [0, 15, 30, 45]);
  // hours: 2, 3, 4
  assert.deepEqual(Array.from(parsed.hours).sort((a, b) => a - b), [2, 3, 4]);
  // days of week: 1, 2, 3, 4, 5
  assert.deepEqual(Array.from(parsed.daysOfWeek).sort((a, b) => a - b), [1, 2, 3, 4, 5]);
  assert.equal(parsed.isDayOfWeekWildcard, false);
});

test("Cron Evaluator: normalizes day-of-week 7 to 0 (Sunday)", () => {
  const parsed = parseCronSchedule("0 0 * * 7");
  assert.ok(parsed.daysOfWeek.has(0));
  assert.ok(!parsed.daysOfWeek.has(7));
});

test("Cron Evaluator: rejects invalid cron expressions", () => {
  assert.throws(() => parseCronSchedule("invalid"), BackupCronInvalidError);
  assert.throws(() => parseCronSchedule("* * * *"), BackupCronInvalidError);
  assert.throws(() => parseCronSchedule("60 * * * *"), BackupCronInvalidError);
  assert.throws(() => getNextCronOccurrence("bad cron"), BackupCronInvalidError);
});

test("Cron Evaluator: calculates deterministic next-run in UTC (Section 2, 3, 15)", () => {
  // Reference base date: 2026-10-04T12:30:00.000Z
  const baseDate = new Date("2026-10-04T12:30:00.000Z");

  // Every day at 02:00 UTC -> next is 2026-10-05T02:00:00.000Z
  const nextDaily = getNextCronOccurrence("0 2 * * *", baseDate);
  assert.equal(nextDaily.toISOString(), "2026-10-05T02:00:00.000Z");

  // Every 6 hours -> next is 2026-10-04T18:00:00.000Z
  const next6Hourly = getNextCronOccurrence("0 */6 * * *", baseDate);
  assert.equal(next6Hourly.toISOString(), "2026-10-04T18:00:00.000Z");

  // Every minute -> next is 2026-10-04T12:31:00.000Z
  const nextMinute = getNextCronOccurrence("* * * * *", baseDate);
  assert.equal(nextMinute.toISOString(), "2026-10-04T12:31:00.000Z");
});

test("Cron Evaluator: next-run calculation across month boundaries and leap years", () => {
  // 2024 is leap year: Feb 28 -> Feb 29
  const leapBase = new Date("2024-02-28T23:30:00.000Z");
  const leapNext = getNextCronOccurrence("0 0 * * *", leapBase);
  assert.equal(leapNext.toISOString(), "2024-02-29T00:00:00.000Z");

  // 2025 is NOT leap year: Feb 28 -> Mar 1
  const nonLeapBase = new Date("2025-02-28T23:30:00.000Z");
  const nonLeapNext = getNextCronOccurrence("0 0 * * *", nonLeapBase);
  assert.equal(nonLeapNext.toISOString(), "2025-03-01T00:00:00.000Z");

  // Year boundary: Dec 31 -> Jan 1
  const yearEnd = new Date("2026-12-31T23:45:00.000Z");
  const yearNext = getNextCronOccurrence("0 0 1 1 *", yearEnd);
  assert.equal(yearNext.toISOString(), "2027-01-01T00:00:00.000Z");
});

test("Cron Evaluator: calculates deterministic previous-run in UTC (Section 3)", () => {
  const baseDate = new Date("2026-10-04T12:30:00.000Z");

  // Previous 02:00 UTC -> today 2026-10-04T02:00:00.000Z
  const prevDaily = getPreviousCronOccurrence("0 2 * * *", baseDate);
  assert.equal(prevDaily.toISOString(), "2026-10-04T02:00:00.000Z");

  // Inclusive match: when baseDate is exactly 12:00:00.000Z on an hourly cron
  const exactHour = new Date("2026-10-04T12:00:00.000Z");
  const prevHourlyInclusive = getPreviousCronOccurrence("0 * * * *", exactHour, true);
  assert.equal(prevHourlyInclusive.toISOString(), "2026-10-04T12:00:00.000Z");

  // Exclusive match: strictly before 12:00:00.000Z
  const prevHourlyExclusive = getPreviousCronOccurrence("0 * * * *", exactHour, false);
  assert.equal(prevHourlyExclusive.toISOString(), "2026-10-04T11:00:00.000Z");
});

test("Cron Evaluator: checkScheduleDue evaluates due, future, and missed schedules (Section 4, 15)", () => {
  const cron = "0 2 * * *"; // Daily at 02:00 UTC

  // Scenario 1: First evaluation (never scheduled before) at 12:00 UTC
  // Most recent slot is 02:00 UTC today -> DUE!
  const now = new Date("2026-10-04T12:00:00.000Z");
  const res1 = checkScheduleDue(cron, null, now);
  assert.equal(res1.isDue, true);
  assert.equal(res1.dueSlot.toISOString(), "2026-10-04T02:00:00.000Z");
  assert.equal(res1.nextRun.toISOString(), "2026-10-05T02:00:00.000Z");

  // Scenario 2: Already scheduled for today's 02:00 UTC slot (e.g. at 02:00 or 02:01)
  // Last scheduled run was 2026-10-04T02:00:05.000Z
  const lastRunToday = new Date("2026-10-04T02:00:05.000Z");
  const res2 = checkScheduleDue(cron, lastRunToday, now);
  assert.equal(res2.isDue, false);
  assert.equal(res2.nextRun.toISOString(), "2026-10-05T02:00:00.000Z");

  // Scenario 3: Missed schedule (worker was down during 02:00 UTC, now is 05:00 UTC)
  // Last scheduled run was yesterday (2026-10-03T02:00:00.000Z)
  const lastRunYesterday = new Date("2026-10-03T02:00:00.000Z");
  const now5AM = new Date("2026-10-04T05:00:00.000Z");
  const res3 = checkScheduleDue(cron, lastRunYesterday, now5AM);
  assert.equal(res3.isDue, true);
  assert.equal(res3.dueSlot.toISOString(), "2026-10-04T02:00:00.000Z");

  // Scenario 4: Worker recovers and enqueues job at 05:00:01.
  // Next tick at 05:00:30 with lastRun = 05:00:01:
  const lastRunRecovery = new Date("2026-10-04T05:00:01.000Z");
  const now501 = new Date("2026-10-04T05:00:30.000Z");
  const res4 = checkScheduleDue(cron, lastRunRecovery, now501);
  assert.equal(res4.isDue, false); // DOES NOT CREATE BACKLOG DUPLICATES!
});

test("Cron Evaluator: strict UTC enforcement across timezone offsets (Section 2, 15)", () => {
  // Regardless of local host timezone, cron is strictly evaluated against UTC fields
  const cron = "0 14 * * *"; // 14:00 UTC
  const testTime = new Date("2026-10-04T13:59:59.000Z");
  const next = getNextCronOccurrence(cron, testTime);
  assert.equal(next.getUTCHours(), 14);
  assert.equal(next.getUTCMinutes(), 0);
  assert.equal(next.toISOString(), "2026-10-04T14:00:00.000Z");
});
