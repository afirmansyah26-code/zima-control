import { randomBytes, scrypt, timingSafeEqual } from "node:crypto";

const SCRYPT_COST = 32_768;
const SCRYPT_BLOCK_SIZE = 8;
const SCRYPT_PARALLELIZATION = 1;
const KEY_LENGTH = 32;
const SALT_LENGTH = 16;
const MAX_MEMORY = 64 * 1024 * 1024;

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(SALT_LENGTH);
  const derived = await deriveKey(password, salt);
  return [
    "scrypt",
    String(SCRYPT_COST),
    String(SCRYPT_BLOCK_SIZE),
    String(SCRYPT_PARALLELIZATION),
    salt.toString("base64url"),
    derived.toString("base64url"),
  ].join("$");
}

export async function verifyPassword(password: string, encodedHash: string): Promise<boolean> {
  const parsed = parseEncodedHash(encodedHash);
  if (!parsed) {
    return false;
  }
  try {
    const derived = await deriveKey(password, parsed.salt);
    return timingSafeEqual(derived, parsed.expected);
  } catch {
    return false;
  }
}

export function isAcceptablePassword(password: unknown): password is string {
  if (typeof password !== "string") {
    return false;
  }
  const bytes = Buffer.byteLength(password, "utf8");
  return bytes >= 12 && bytes <= 1024;
}

interface ParsedHash {
  salt: Buffer;
  expected: Buffer;
}

function parseEncodedHash(encodedHash: string): ParsedHash | null {
  const parts = encodedHash.split("$");
  if (parts.length !== 6) {
    return null;
  }
  if (
    parts[0] !== "scrypt"
    || parts[1] !== String(SCRYPT_COST)
    || parts[2] !== String(SCRYPT_BLOCK_SIZE)
    || parts[3] !== String(SCRYPT_PARALLELIZATION)
  ) {
    return null;
  }
  try {
    const salt = Buffer.from(parts[4] ?? "", "base64url");
    const expected = Buffer.from(parts[5] ?? "", "base64url");
    if (salt.length !== SALT_LENGTH || expected.length !== KEY_LENGTH) {
      return null;
    }
    return { salt, expected };
  } catch {
    return null;
  }
}

function deriveKey(password: string, salt: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(
      password,
      salt,
      KEY_LENGTH,
      {
        N: SCRYPT_COST,
        r: SCRYPT_BLOCK_SIZE,
        p: SCRYPT_PARALLELIZATION,
        maxmem: MAX_MEMORY,
      },
      (error, derived) => error ? reject(error) : resolve(derived),
    );
  });
}
