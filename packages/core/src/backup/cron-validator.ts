/**
 * Zima Control Center — Cron Expression Validator
 *
 * Validates standard 5-part cron syntax:
 *   [minute] [hour] [day-of-month] [month] [day-of-week]
 *
 * Rules:
 * - Exactly 5 whitespace-separated fields.
 * - Allowed tokens per field: numbers, asterisks, step expressions, ranges, and comma lists.
 * - Field bounds:
 *   - minute: 0 - 59
 *   - hour: 0 - 23
 *   - day-of-month: 1 - 31
 *   - month: 1 - 12
 *   - day-of-week: 0 - 7 (both 0 and 7 represent Sunday)
 *
 * Reference: docs/ZCC-BACKUP-FOUNDATION-PRD.md
 */

const FIELD_BOUNDS = [
  { name: "minute", min: 0, max: 59 },
  { name: "hour", min: 0, max: 23 },
  { name: "dayOfMonth", min: 1, max: 31 },
  { name: "month", min: 1, max: 12 },
  { name: "dayOfWeek", min: 0, max: 7 },
] as const;

export function validateCronExpression(rawExpression: unknown): boolean {
  if (typeof rawExpression !== "string") {
    return false;
  }

  const trimmed = rawExpression.trim();
  if (trimmed.length === 0) {
    return false;
  }

  // Reject control characters or newlines
  if (/[\u0000-\u001f\u007f]/.test(trimmed)) {
    return false;
  }

  const fields = trimmed.split(/\s+/);
  if (fields.length !== 5) {
    return false;
  }

  for (let i = 0; i < 5; i++) {
    const field = fields[i];
    const bounds = FIELD_BOUNDS[i];
    if (!validateCronField(field, bounds.min, bounds.max)) {
      return false;
    }
  }

  return true;
}

function validateCronField(field: string, min: number, max: number): boolean {
  if (field === "*") {
    return true;
  }

  // Comma-separated list
  const subparts = field.split(",");
  if (subparts.length === 0 || subparts.some((s) => s.length === 0)) {
    return false;
  }

  for (const part of subparts) {
    if (!validateCronAtom(part, min, max)) {
      return false;
    }
  }

  return true;
}

function validateCronAtom(atom: string, min: number, max: number): boolean {
  // Step syntax: '*/n' or 'a-b/n'
  if (atom.includes("/")) {
    const [rangePart, stepPart] = atom.split("/");
    if (!rangePart || !stepPart) return false;

    const step = Number(stepPart);
    if (!Number.isInteger(step) || step <= 0 || step > max) {
      return false;
    }

    if (rangePart === "*") {
      return true;
    }

    return validateRange(rangePart, min, max);
  }

  // Range syntax: 'a-b'
  if (atom.includes("-")) {
    return validateRange(atom, min, max);
  }

  // Single number
  if (/^\d+$/.test(atom)) {
    const num = Number(atom);
    return Number.isInteger(num) && num >= min && num <= max;
  }

  return false;
}

function validateRange(rangeStr: string, min: number, max: number): boolean {
  const parts = rangeStr.split("-");
  if (parts.length !== 2) return false;

  const [startStr, endStr] = parts;
  if (!/^\d+$/.test(startStr) || !/^\d+$/.test(endStr)) {
    return false;
  }

  const start = Number(startStr);
  const end = Number(endStr);

  return (
    Number.isInteger(start) &&
    Number.isInteger(end) &&
    start >= min &&
    start <= max &&
    end >= min &&
    end <= max &&
    start <= end
  );
}
