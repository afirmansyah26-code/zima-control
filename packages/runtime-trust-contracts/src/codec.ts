import {
  ED25519_SIGNATURE_BYTES,
  RUNTIME_TRUST_MAGIC_TEXT,
  RUNTIME_TRUST_MAX_FRAME_BYTES,
  RUNTIME_TRUST_NONCE_BYTES,
  RUNTIME_TRUST_PROTOCOL_VERSION,
  RUNTIME_TRUST_PURPOSE,
  runtimeTrustMessageTypes,
} from "./constants.js";
import { runtimeTrustError } from "./errors.js";
import type {
  RuntimeTrustAdmitted,
  RuntimeTrustChallenge,
  RuntimeTrustErrorEnvelope,
  RuntimeTrustHello,
  RuntimeTrustResponse,
} from "./types.js";
import {
  assertBoundaryIdentifier,
  assertCanonicalUuid,
  assertFingerprint,
  assertRuntimeId,
  assertSafeInteger,
} from "./validation.js";

const MAGIC = Buffer.from(RUNTIME_TRUST_MAGIC_TEXT, "ascii");
const HEADER_BYTES = MAGIC.length + 3;
const utf8 = new TextDecoder("utf-8", { fatal: true });

class Writer {
  private readonly chunks: Buffer[] = [];
  private size = 0;

  public raw(value: Buffer): void {
    this.size += value.length;
    if (this.size > RUNTIME_TRUST_MAX_FRAME_BYTES) throw runtimeTrustError("MALFORMED_ENVELOPE");
    this.chunks.push(Buffer.from(value));
  }

  public string(value: string, validate: (value: string) => void): void {
    if (typeof value !== "string") throw runtimeTrustError("MALFORMED_ENVELOPE");
    validate(value);
    const bytes = Buffer.from(value, "utf8");
    if (bytes.length === 0 || bytes.length > 0xffff || bytes.toString("utf8") !== value) throw runtimeTrustError("MALFORMED_ENVELOPE");
    const prefix = Buffer.allocUnsafe(2);
    prefix.writeUInt16BE(bytes.length);
    this.raw(prefix);
    this.raw(bytes);
  }

  public u64(value: number, positive = false): void {
    assertSafeInteger(value, positive);
    const bytes = Buffer.allocUnsafe(8);
    bytes.writeBigUInt64BE(BigInt(value));
    this.raw(bytes);
  }

  public finish(): Buffer {
    const result = Buffer.concat(this.chunks, this.size);
    if (result.length < 1 || result.length > RUNTIME_TRUST_MAX_FRAME_BYTES) throw runtimeTrustError("MALFORMED_ENVELOPE");
    return result;
  }
}

class Reader {
  private offset = 0;

  public constructor(private readonly input: Buffer) {
    if (input.length < HEADER_BYTES || input.length > RUNTIME_TRUST_MAX_FRAME_BYTES) throw runtimeTrustError("MALFORMED_ENVELOPE");
  }

  public raw(length: number): Buffer {
    if (!Number.isSafeInteger(length) || length < 0 || this.offset + length > this.input.length) throw runtimeTrustError("MALFORMED_ENVELOPE");
    const value = Buffer.from(this.input.subarray(this.offset, this.offset + length));
    this.offset += length;
    return value;
  }

  public string(validate: (value: string) => void): string {
    const length = this.raw(2).readUInt16BE(0);
    if (length === 0) throw runtimeTrustError("MALFORMED_ENVELOPE");
    let value: string;
    try { value = utf8.decode(this.raw(length)); }
    catch { throw runtimeTrustError("MALFORMED_ENVELOPE"); }
    if (Buffer.from(value, "utf8").length !== length) throw runtimeTrustError("MALFORMED_ENVELOPE");
    validate(value);
    return value;
  }

  public u64(positive = false): number {
    const value = this.raw(8).readBigUInt64BE(0);
    if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw runtimeTrustError("MALFORMED_ENVELOPE");
    const number = Number(value);
    assertSafeInteger(number, positive);
    return number;
  }

  public done(): void {
    if (this.offset !== this.input.length) throw runtimeTrustError("MALFORMED_ENVELOPE");
  }
}

function writeHeader(writer: Writer, messageType: number): void {
  writer.raw(MAGIC);
  writer.raw(Buffer.from([messageType]));
  const version = Buffer.allocUnsafe(2);
  version.writeUInt16BE(RUNTIME_TRUST_PROTOCOL_VERSION);
  writer.raw(version);
}

function assertProtocolVersion(value: unknown): void {
  if (value !== RUNTIME_TRUST_PROTOCOL_VERSION) throw runtimeTrustError("UNSUPPORTED_PROTOCOL");
}

function readHeader(reader: Reader, expectedType: number): void {
  if (!reader.raw(MAGIC.length).equals(MAGIC)) throw runtimeTrustError("UNSUPPORTED_PROTOCOL");
  if (reader.raw(1)[0] !== expectedType) throw runtimeTrustError("MALFORMED_ENVELOPE");
  if (reader.raw(2).readUInt16BE(0) !== RUNTIME_TRUST_PROTOCOL_VERSION) throw runtimeTrustError("UNSUPPORTED_PROTOCOL");
}

function exactPurpose(value: string): void {
  if (value !== RUNTIME_TRUST_PURPOSE) throw runtimeTrustError("UNSUPPORTED_PROTOCOL");
}

function surfaceCode(value: string): void {
  if (!["UNSUPPORTED_PROTOCOL", "EXPIRED", "SESSION_INVALIDATED", "RETRY_LATER", "ADMISSION_DENIED"].includes(value)) {
    throw runtimeTrustError("MALFORMED_ENVELOPE");
  }
}

function writeBinding(writer: Writer, value: Pick<RuntimeTrustChallenge, "authorityId" | "issuerId" | "serviceBoundaryId" | "bindingEpoch">): void {
  writer.string(value.authorityId, assertCanonicalUuid);
  writer.string(value.issuerId, assertCanonicalUuid);
  writer.string(value.serviceBoundaryId, assertBoundaryIdentifier);
  writer.string(value.bindingEpoch, assertBoundaryIdentifier);
}

function readBinding(reader: Reader): Pick<RuntimeTrustChallenge, "authorityId" | "issuerId" | "serviceBoundaryId" | "bindingEpoch"> {
  return {
    authorityId: reader.string(assertCanonicalUuid),
    issuerId: reader.string(assertCanonicalUuid),
    serviceBoundaryId: reader.string(assertBoundaryIdentifier),
    bindingEpoch: reader.string(assertBoundaryIdentifier),
  };
}

function immutable<T extends object>(value: T): Readonly<T> {
  return Object.freeze(value);
}

export function encodeRuntimeTrustHello(value: RuntimeTrustHello): Buffer {
  assertProtocolVersion(value.protocolVersion);
  const writer = new Writer();
  writeHeader(writer, runtimeTrustMessageTypes.HELLO);
  writer.string(value.purpose, exactPurpose);
  writeBinding(writer, value);
  writer.string(value.publicKeyFingerprint, assertFingerprint);
  writer.string(value.runtimeInstanceId, (item) => assertRuntimeId(item, "ri1"));
  return writer.finish();
}

export function decodeRuntimeTrustHello(payload: Buffer): RuntimeTrustHello {
  const reader = new Reader(payload);
  readHeader(reader, runtimeTrustMessageTypes.HELLO);
  const purpose = reader.string(exactPurpose) as typeof RUNTIME_TRUST_PURPOSE;
  const binding = readBinding(reader);
  const publicKeyFingerprint = reader.string(assertFingerprint);
  const runtimeInstanceId = reader.string((item) => assertRuntimeId(item, "ri1"));
  reader.done();
  return immutable({ protocolVersion: 1, purpose, ...binding, publicKeyFingerprint, runtimeInstanceId });
}

export function encodeRuntimeTrustChallenge(value: RuntimeTrustChallenge): Buffer {
  assertProtocolVersion(value.protocolVersion);
  const writer = new Writer();
  writeHeader(writer, runtimeTrustMessageTypes.CHALLENGE);
  writer.string(value.purpose, exactPurpose);
  writeBinding(writer, value);
  writer.u64(value.keyVersion, true);
  writer.string(value.publicKeyFingerprint, assertFingerprint);
  writer.u64(value.stateVersion);
  writer.string(value.runtimeInstanceId, (item) => assertRuntimeId(item, "ri1"));
  writer.string(value.challengeId, (item) => assertRuntimeId(item, "ch1"));
  if (value.nonce.length !== RUNTIME_TRUST_NONCE_BYTES) throw runtimeTrustError("MALFORMED_ENVELOPE");
  writer.raw(value.nonce);
  return writer.finish();
}

export function decodeRuntimeTrustChallenge(payload: Buffer): RuntimeTrustChallenge {
  const reader = new Reader(payload);
  readHeader(reader, runtimeTrustMessageTypes.CHALLENGE);
  const purpose = reader.string(exactPurpose) as typeof RUNTIME_TRUST_PURPOSE;
  const binding = readBinding(reader);
  const keyVersion = reader.u64(true);
  const publicKeyFingerprint = reader.string(assertFingerprint);
  const stateVersion = reader.u64();
  const runtimeInstanceId = reader.string((item) => assertRuntimeId(item, "ri1"));
  const challengeId = reader.string((item) => assertRuntimeId(item, "ch1"));
  const nonce = reader.raw(RUNTIME_TRUST_NONCE_BYTES);
  reader.done();
  return immutable({ protocolVersion: 1, purpose, ...binding, keyVersion, publicKeyFingerprint, stateVersion, runtimeInstanceId, challengeId, nonce });
}

export function encodeRuntimeTrustResponse(value: RuntimeTrustResponse): Buffer {
  assertProtocolVersion(value.protocolVersion);
  const writer = new Writer();
  writeHeader(writer, runtimeTrustMessageTypes.RESPONSE);
  writer.string(value.challengeId, (item) => assertRuntimeId(item, "ch1"));
  writer.string(value.runtimeInstanceId, (item) => assertRuntimeId(item, "ri1"));
  if (value.signature.length !== ED25519_SIGNATURE_BYTES) throw runtimeTrustError("MALFORMED_ENVELOPE");
  writer.raw(value.signature);
  return writer.finish();
}

export function decodeRuntimeTrustResponse(payload: Buffer): RuntimeTrustResponse {
  const reader = new Reader(payload);
  readHeader(reader, runtimeTrustMessageTypes.RESPONSE);
  const challengeId = reader.string((item) => assertRuntimeId(item, "ch1"));
  const runtimeInstanceId = reader.string((item) => assertRuntimeId(item, "ri1"));
  const signature = reader.raw(ED25519_SIGNATURE_BYTES);
  reader.done();
  return immutable({ protocolVersion: 1, challengeId, runtimeInstanceId, signature });
}

export function encodeRuntimeTrustAdmitted(value: RuntimeTrustAdmitted): Buffer {
  assertProtocolVersion(value.protocolVersion);
  const writer = new Writer();
  writeHeader(writer, runtimeTrustMessageTypes.ADMITTED);
  writer.string(value.sessionId, (item) => assertRuntimeId(item, "rs1"));
  writer.string(value.runtimeInstanceId, (item) => assertRuntimeId(item, "ri1"));
  writer.u64(value.keyVersion, true);
  writer.string(value.bindingEpoch, assertBoundaryIdentifier);
  writer.u64(value.stateVersion);
  return writer.finish();
}

export function decodeRuntimeTrustAdmitted(payload: Buffer): RuntimeTrustAdmitted {
  const reader = new Reader(payload);
  readHeader(reader, runtimeTrustMessageTypes.ADMITTED);
  const sessionId = reader.string((item) => assertRuntimeId(item, "rs1"));
  const runtimeInstanceId = reader.string((item) => assertRuntimeId(item, "ri1"));
  const keyVersion = reader.u64(true);
  const bindingEpoch = reader.string(assertBoundaryIdentifier);
  const stateVersion = reader.u64();
  reader.done();
  return immutable({ protocolVersion: 1, sessionId, runtimeInstanceId, keyVersion, bindingEpoch, stateVersion });
}

export function encodeRuntimeTrustError(value: RuntimeTrustErrorEnvelope): Buffer {
  assertProtocolVersion(value.protocolVersion);
  const writer = new Writer();
  writeHeader(writer, runtimeTrustMessageTypes.ERROR);
  writer.string(value.code, surfaceCode);
  return writer.finish();
}

export function decodeRuntimeTrustError(payload: Buffer): RuntimeTrustErrorEnvelope {
  const reader = new Reader(payload);
  readHeader(reader, runtimeTrustMessageTypes.ERROR);
  const code = reader.string(surfaceCode) as RuntimeTrustErrorEnvelope["code"];
  reader.done();
  return immutable({ protocolVersion: 1, code });
}

export function encodeRuntimeTrustFrame(payload: Buffer): Buffer {
  if (payload.length < 1 || payload.length > RUNTIME_TRUST_MAX_FRAME_BYTES) throw runtimeTrustError("MALFORMED_ENVELOPE");
  const prefix = Buffer.allocUnsafe(4);
  prefix.writeUInt32BE(payload.length);
  return Buffer.concat([prefix, payload]);
}

export function decodeRuntimeTrustFrame(frame: Buffer): Buffer {
  if (frame.length < 5 || frame.length > RUNTIME_TRUST_MAX_FRAME_BYTES + 4) throw runtimeTrustError("MALFORMED_ENVELOPE");
  const length = frame.readUInt32BE(0);
  if (length < 1 || length > RUNTIME_TRUST_MAX_FRAME_BYTES || frame.length !== length + 4) throw runtimeTrustError("MALFORMED_ENVELOPE");
  return Buffer.from(frame.subarray(4));
}

export class RuntimeTrustFrameAccumulator {
  private buffered = Buffer.alloc(0);

  public push(chunk: Buffer): Buffer | null {
    if (chunk.length === 0 || this.buffered.length + chunk.length > RUNTIME_TRUST_MAX_FRAME_BYTES + 4) {
      throw runtimeTrustError("MALFORMED_ENVELOPE");
    }
    this.buffered = Buffer.concat([this.buffered, chunk]);
    if (this.buffered.length < 4) return null;
    const length = this.buffered.readUInt32BE(0);
    if (length < 1 || length > RUNTIME_TRUST_MAX_FRAME_BYTES) throw runtimeTrustError("MALFORMED_ENVELOPE");
    if (this.buffered.length < length + 4) return null;
    if (this.buffered.length !== length + 4) throw runtimeTrustError("MALFORMED_ENVELOPE");
    const payload = Buffer.from(this.buffered.subarray(4));
    this.buffered = Buffer.alloc(0);
    return payload;
  }

  public end(): void {
    if (this.buffered.length !== 0) throw runtimeTrustError("MALFORMED_ENVELOPE");
  }
}
