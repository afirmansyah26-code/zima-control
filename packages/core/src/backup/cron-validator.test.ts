import test from "node:test";
import assert from "node:assert/strict";
import { validateCronExpression } from "./cron-validator.js";

test("validateCronExpression: accepts valid standard 5-part cron expressions", () => {
  assert.equal(validateCronExpression("0 2 * * *"), true);
  assert.equal(validateCronExpression("*/15 * * * *"), true);
  assert.equal(validateCronExpression("0 0 1 1 *"), true);
  assert.equal(validateCronExpression("30 4 1,15 * 1-5"), true);
  assert.equal(validateCronExpression("59 23 31 12 7"), true);
  assert.equal(validateCronExpression("0 0 * * 0"), true);
  assert.equal(validateCronExpression("10-20/2 * * * *"), true);
});

test("validateCronExpression: rejects invalid formats, bad bounds, and malformed strings", () => {
  // Wrong number of parts
  assert.equal(validateCronExpression(""), false);
  assert.equal(validateCronExpression("0 2 * *"), false); // 4 parts
  assert.equal(validateCronExpression("0 2 * * * *"), false); // 6 parts
  assert.equal(validateCronExpression(null), false);
  assert.equal(validateCronExpression(undefined), false);

  // Out of range
  assert.equal(validateCronExpression("60 * * * *"), false); // minute > 59
  assert.equal(validateCronExpression("* 24 * * *"), false); // hour > 23
  assert.equal(validateCronExpression("* * 32 * *"), false); // day > 31
  assert.equal(validateCronExpression("* * 0 * *"), false); // day < 1
  assert.equal(validateCronExpression("* * * 13 *"), false); // month > 12
  assert.equal(validateCronExpression("* * * 0 *"), false); // month < 1
  assert.equal(validateCronExpression("* * * * 8"), false); // dow > 7

  // Inverted ranges or invalid steps
  assert.equal(validateCronExpression("20-10 * * * *"), false); // start > end
  assert.equal(validateCronExpression("*/0 * * * *"), false); // step 0
  assert.equal(validateCronExpression("*-* * * * *"), false);
  assert.equal(validateCronExpression("foo bar baz qux quux"), false);
  assert.equal(validateCronExpression("0 2 * * *; rm -rf /"), false); // command injection attempt
  assert.equal(validateCronExpression("0 2 * * *\n0 3 * * *"), false); // newline injection attempt
});
