import { randomBytes } from "node:crypto";
import type { RuntimeMonotonicClock, RuntimeRandomSource } from "./types.js";

export const systemMonotonicClock: RuntimeMonotonicClock = Object.freeze({ nowNs: () => process.hrtime.bigint() });
export const systemRuntimeRandomSource: RuntimeRandomSource = Object.freeze({ bytes: (length: number) => randomBytes(length) });
