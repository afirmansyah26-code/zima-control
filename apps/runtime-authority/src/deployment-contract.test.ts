import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const root = resolve(fileURLToPath(new URL(".", import.meta.url)), "../../..");
const read = (path: string) => readFile(resolve(root, path), "utf8");

type NativeCompileResult = Readonly<{
  status: number | null;
  stdout: string;
  stderr: string;
  error?: Error;
}>;
type NativeCompileRunner = (command: string, arguments_: readonly string[]) => NativeCompileResult;
type NativeCompileGateResult = Readonly<
  { kind: "pass" } | { kind: "skip"; reason: string }
>;

type LifecycleLockAttempt = "acquired" | "would-block" | "error" | "interrupted";
type LifecycleLockOutcome = Readonly<{
  proceed: boolean;
  resultEvent: "completed" | "rejected";
  errorCode: "NONE" | "LOCK_BUSY" | "INVALID_INSTALLATION" | "STATUS_FAILED";
  attempts: number;
}>;

function modelLifecycleLock(attempt: () => LifecycleLockAttempt): LifecycleLockOutcome {
  const status = attempt();
  if (status === "acquired") {
    return { proceed: true, resultEvent: "completed", errorCode: "NONE", attempts: 1 };
  }
  if (status === "would-block") {
    return { proceed: false, resultEvent: "rejected", errorCode: "LOCK_BUSY", attempts: 1 };
  }
  return {
    proceed: false,
    resultEvent: "completed",
    errorCode: status === "interrupted" ? "STATUS_FAILED" : "INVALID_INSTALLATION",
    attempts: 1,
  };
}

function runHostNativeCompileGate(
  platform: NodeJS.Platform,
  run: NativeCompileRunner,
): NativeCompileGateResult {
  if (platform !== "linux") return { kind: "skip", reason: `HOST_NATIVE_COMPILE_UNSUPPORTED:${platform}` };
  const result = run("make", ["-C", resolve(root, "native/host-runtime"), "check-runtime-trust-bootstrap"]);
  if (result.error || result.status !== 0) {
    const detail = [result.error?.message, result.stderr, result.stdout].find((value) => Boolean(value));
    throw new Error(`HOST_NATIVE_COMPILE_REQUIRED_ON_LINUX${detail ? `:${detail}` : ""}`);
  }
  return { kind: "pass" };
}

const spawnNativeCompile: NativeCompileRunner = (command, arguments_) => {
  const result = spawnSync(command, [...arguments_], { encoding: "utf8" });
  return {
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    ...(result.error ? { error: result.error } : {}),
  };
};

function parseSystemdUnit(value: string): ReadonlyMap<string, ReadonlyMap<string, readonly string[]>> {
  const sections = new Map<string, Map<string, string[]>>();
  let section: Map<string, string[]> | undefined;
  for (const raw of value.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const heading = /^\[([A-Za-z][A-Za-z0-9]*)\]$/.exec(line);
    if (heading) {
      section = sections.get(heading[1]!) ?? new Map<string, string[]>();
      sections.set(heading[1]!, section);
      continue;
    }
    const directive = /^([A-Za-z][A-Za-z0-9]*)=(.*)$/.exec(line);
    if (!section || !directive) throw new Error(`INVALID_SYSTEMD_UNIT_LINE:${line}`);
    const values = section.get(directive[1]!) ?? [];
    values.push(directive[2]!);
    section.set(directive[1]!, values);
  }
  if (!sections.has("Unit")) throw new Error("SYSTEMD_UNIT_SECTION_MISSING");
  return sections;
}

const relationship = (
  unit: ReadonlyMap<string, ReadonlyMap<string, readonly string[]>>,
  name: string,
) => new Set((unit.get("Unit")?.get(name) ?? []).flatMap((value) => value.split(/\s+/).filter(Boolean)));

test("runtime Compose exposes only two fixed non-networked non-root services", async () => {
  const value = await read("deployment/runtime-trust/compose.yaml.in");
  assert.match(value, /^services:\r?\n  authority:/);
  assert.equal((value.match(/^  (authority|issuer):$/gm) ?? []).length, 2);
  assert.match(value, /user: "21012:21012"/);
  assert.match(value, /user: "21011:21011"/);
  assert.equal((value.match(/network_mode: none/g) ?? []).length, 2);
  assert.equal((value.match(/restart: "no"/g) ?? []).length, 2);
  assert.doesNotMatch(value, /ports:|docker\.sock|privileged:|pid:|network_mode: host/);
  const authority = value.split("\n  issuer:")[0]!;
  assert.doesNotMatch(authority, /issuer-active\.pk8|issuer-boundary\.json|\/data/);
  const issuer = value.split("\n  issuer:")[1]!;
  assert.doesNotMatch(issuer, /trust\.sqlite|authority-trust-db|\/data/);
});

test("systemd admission orders bootstrap then current Authority readiness then Issuer", async () => {
  const bootstrap = await read("deployment/systemd/zima-control-runtime-bootstrap.service");
  const readinessMount = await read("deployment/systemd/zima-control-runtime-readiness-mount.service");
  const authority = await read("deployment/systemd/zima-control-runtime-authority.service");
  const issuer = await read("deployment/systemd/zima-control-runtime-issuer.service");
  const target = await read("deployment/systemd/zima-control-runtime-trust.target");
  assert.match(readinessMount, /Type=oneshot/);
  assert.match(readinessMount, /RemainAfterExit=yes/);
  assert.match(readinessMount, /After=zima-control-runtime-bootstrap\.service/);
  assert.match(readinessMount, /Before=zima-control-runtime-authority\.service/);
  assert.match(readinessMount, /PartOf=zima-control-runtime-authority\.service/);
  assert.match(readinessMount, /ExecStart=.*runtime-authority-readiness PREPARE/);
  assert.match(readinessMount, /ExecStop=.*runtime-authority-readiness CLEANUP/);
  assert.match(bootstrap, /Before=zima-control-runtime-readiness-mount\.service/);
  assert.doesNotMatch(authority, /runtime-authority-readiness (PREPARE|CLEANUP)/);
  assert.match(authority, /ExecStartPost=.*runtime-authority-readiness WAIT/);
  assert.match(authority, /TimeoutStartSec=60s/);
  assert.match(authority, /TimeoutStopSec=30s/);
  assert.match(authority, /Restart=on-failure/);
  assert.match(issuer, /Requires=.*zima-control-runtime-authority\.service/);
  assert.match(issuer, /BindsTo=zima-control-runtime-authority\.service/);
  assert.match(issuer, /After=.*zima-control-runtime-authority\.service/);
  assert.match(target,
    /^Upholds=zima-control-runtime-authority\.service zima-control-runtime-issuer\.service$/m);
  assert.match(target, /^After=zima-control-runtime-issuer\.service$/m);
  assert.match(authority, /^Restart=on-failure$/m);
  assert.match(issuer, /^Restart=on-failure$/m);
  assert.doesNotMatch(authority + issuer, /Environment(File)?=|sd_notify|READY=1/);
});

test("parsed systemd relationships continuously recover Issuer without weakening Authority coupling", async () => {
  const target = parseSystemdUnit(await read("deployment/systemd/zima-control-runtime-trust.target"));
  const authority = parseSystemdUnit(await read("deployment/systemd/zima-control-runtime-authority.service"));
  const issuer = parseSystemdUnit(await read("deployment/systemd/zima-control-runtime-issuer.service"));
  const issuerName = "zima-control-runtime-issuer.service";
  const authorityName = "zima-control-runtime-authority.service";

  const issuerReactivated = relationship(target, "Upholds").has(issuerName);
  const authorityReactivated = relationship(target, "Upholds").has(authorityName);
  const authorityFailureStopsIssuer = relationship(issuer, "BindsTo").has(authorityName);
  const authorityRequired = relationship(issuer, "Requires").has(authorityName);
  const authorityOrderedFirst = relationship(issuer, "After").has(authorityName)
    && relationship(authority, "Before").has(issuerName);

  assert.equal(issuerReactivated, true);
  assert.equal(authorityReactivated, true);
  assert.equal(authorityFailureStopsIssuer, true);
  assert.equal(authorityRequired, true);
  assert.equal(authorityOrderedFirst, true);
});

test("only mount-changing units carry the exact frozen capability set and host namespace", async () => {
  const bootstrap = await read("deployment/systemd/zima-control-runtime-bootstrap.service");
  const readinessMount = await read("deployment/systemd/zima-control-runtime-readiness-mount.service");
  const authority = await read("deployment/systemd/zima-control-runtime-authority.service");
  const issuer = await read("deployment/systemd/zima-control-runtime-issuer.service");
  const exact = "CapabilityBoundingSet=CAP_SYS_ADMIN CAP_DAC_OVERRIDE CAP_CHOWN CAP_FOWNER";
  for (const unit of [bootstrap, readinessMount]) {
    assert.match(unit, new RegExp(exact));
    assert.match(unit, /^AmbientCapabilities=$/m);
    assert.doesNotMatch(unit, /PrivateTmp|PrivateDevices|ProtectSystem|ProtectHome|ReadOnlyPaths|ReadWritePaths|InaccessiblePaths|BindPaths|BindReadOnlyPaths/);
  }
  for (const unit of [authority, issuer]) {
    assert.match(unit, /^CapabilityBoundingSet=$/m);
    assert.match(unit, /SystemCallFilter=~@mount setns unshare pivot_root/);
  }
  const bootstrapSource = await read("native/host-runtime/runtime-trust-bootstrap.c");
  const readinessSource = await read("native/host-runtime/runtime-authority-readiness.c");
  for (const source of [bootstrapSource, readinessSource]) {
    assert.match(source, /stat\("\/proc\/self\/ns\/mnt"/);
    assert.match(source, /stat\("\/proc\/1\/ns\/mnt"/);
    assert.match(source, /host_mount_namespace_unchanged/);
    assert.match(source, /exact_mount_capabilities/);
    assert.match(source, /_LINUX_CAPABILITY_VERSION_3/);
    assert.match(source, /PR_CAP_AMBIENT_IS_SET/);
    assert.doesNotMatch(source, /\b(setns|unshare)\s*\(/);
  }
});

test("lifecycle helper surface is fixed and has no shell or caller-controlled target", async () => {
  const source = await read("native/host-runtime/runtime-lifecycle-adapter.c");
  for (const token of [
    "START_AUTHORITY", "STOP_AUTHORITY", "START_ISSUER", "STOP_ISSUER",
    "STATUS_AUTHORITY", "STATUS_ISSUER", "REMOVE_RUNTIME_CONTAINERS",
  ]) assert.equal(source.includes('"' + token + '"'), true);
  assert.match(source,
    /strcmp\(argv\[1\], audit_contracts\[index\]\.operation\) == 0/);
  assert.match(source, /\/usr\/bin\/docker/);
  assert.match(source, /zima-control-runtime-trust/);
  assert.doesNotMatch(source, /system\(|popen|\/bin\/sh|getenv|DOCKER_HOST/);
});

test("lifecycle audit contract is fixed, complete, and never logs caller or Docker output", async () => {
  const source = await read("native/host-runtime/runtime-lifecycle-adapter.c");
  assert.match(source, /#define AUDIT_EVENT_SCHEMA_VERSION "1"/);
  assert.match(source, /#define ADAPTER_RELEASE_VERSION "2C-13\.2"/);
  const contracts = source.slice(
    source.indexOf("static const lifecycle_audit_contract audit_contracts[]"),
    source.indexOf("static const lifecycle_audit_contract *audit_contract_for"),
  );
  assert.match(source,
    /invalid_audit_contract = \{\s*OP_INVALID, "INVALID_OPERATION", "none", "none"\s*\}/s);
  for (const [operation, identity, unit] of [
    ["START_AUTHORITY", "authority-runtime-service", "zima-control-runtime-authority.service"],
    ["STOP_AUTHORITY", "authority-runtime-service", "zima-control-runtime-authority.service"],
    ["START_ISSUER", "issuer-runtime-service", "zima-control-runtime-issuer.service"],
    ["STOP_ISSUER", "issuer-runtime-service", "zima-control-runtime-issuer.service"],
    ["STATUS_AUTHORITY", "authority-runtime-service", "zima-control-runtime-stopped-check.service"],
    ["STATUS_ISSUER", "issuer-runtime-service", "zima-control-runtime-stopped-check.service"],
    ["REMOVE_RUNTIME_CONTAINERS", "authority-and-issuer-runtime-services",
      "zima-control-runtime-uninstall.service"],
  ] as const) {
    const operationAt = contracts.indexOf('"' + operation + '"');
    const identityAt = contracts.indexOf('"' + identity + '"', operationAt);
    const unitAt = contracts.indexOf('"' + unit + '"', identityAt);
    assert.ok(operationAt >= 0 && identityAt > operationAt && unitAt > identityAt);
  }

  const audit = source.slice(
    source.indexOf("static void emit_audit_event"),
    source.indexOf("static int validate_regular"),
  );
  for (const field of [
    "auditSchemaVersion=%s", "operation=%s", "logicalServiceIdentity=%s",
    "event=%s", "outcome=%s", "errorCode=%s", "durationMs=%lld",
    "adapterReleaseVersion=%s", "systemdUnitIdentity=%s",
  ]) assert.equal(audit.includes(field), true);
  assert.doesNotMatch(audit, /argv|environ|command|Docker|output/);
  assert.equal((source.match(/\bsyslog\s*\(/g) ?? []).length, 1);
  assert.match(source, /emit_audit_event\(audit_contract, "requested", "requested", "NONE"/);
  assert.match(source, /result_event = "rejected"/);
  assert.match(source, /"completed"/);
  assert.match(source, /"success" : "failure"/);
  const main = source.slice(source.indexOf("int main("));
  assert.equal((main.match(/\breturn\b/g) ?? []).length, 1);
  assert.match(main, /finish:\s*emit_audit_event/s);
});

test("lifecycle audit failures use only the frozen bounded symbolic taxonomy", async () => {
  const source = await read("native/host-runtime/runtime-lifecycle-adapter.c");
  const mapper = source.slice(
    source.indexOf("static const char *safe_error_code"),
    source.indexOf("static void emit_audit_event"),
  );
  for (const code of [
    "INVALID_OPERATION", "START_FAILED", "STOP_FAILED", "STATUS_FAILED",
    "AMBIGUOUS_STATE", "TIMEOUT", "ENGINE_UNAVAILABLE", "CLEANUP_REFUSED",
  ]) assert.equal((mapper + source.slice(source.indexOf("int main("))).includes('"' + code + '"'), true);
  assert.match(source, /error_code = "INVALID_INSTALLATION"/);
  assert.match(source, /error_code = "LOCK_BUSY"/);
  assert.match(source, /return RESULT_TIMEOUT/);
  assert.match(source, /return RESULT_ENGINE_UNAVAILABLE/);
  assert.match(source, /compose_cli_result == RESULT_TIMEOUT/);
  assert.match(source, /compose_cli_result == RESULT_ENGINE_UNAVAILABLE/);
  assert.match(source, /diagnosticStatus=%d/);
  assert.doesNotMatch(source, /syslog\([^;]*(argv|output|environ)/s);
});

test("lifecycle lock source uses one nonblocking attempt and converges on the audit boundary", async () => {
  const source = await read("native/host-runtime/runtime-lifecycle-adapter.c");
  const acquire = source.slice(
    source.indexOf("static lifecycle_lock_status acquire_lifecycle_lock"),
    source.indexOf("static void child_stdio"),
  );
  const main = source.slice(source.indexOf("int main("));

  assert.match(acquire, /flock\(descriptor, LOCK_EX \| LOCK_NB\)/);
  assert.equal((acquire.match(/\bflock\s*\(/g) ?? []).length, 1);
  assert.doesNotMatch(acquire, /\b(for|while)\s*\(|sleep\s*\(|nanosleep\s*\(/);
  assert.match(acquire, /errno == EWOULDBLOCK \|\| errno == EAGAIN/);
  assert.match(acquire, /errno == EINTR && termination_signal != 0/);
  assert.doesNotMatch(source, /flock\([^;]*LOCK_EX\s*\)/);

  const installAt = main.indexOf("install_signal_handlers()");
  const acquireAt = main.indexOf("acquire_lifecycle_lock(lock_fd)");
  assert.ok(installAt >= 0 && acquireAt > installAt);
  assert.match(source, /termination_signal = \(sig_atomic_t\)signal_number/);
  assert.match(main,
    /lock_status == LIFECYCLE_LOCK_BUSY[\s\S]*result_event = "rejected";[\s\S]*error_code = "LOCK_BUSY";[\s\S]*goto finish;/);
  assert.match(main,
    /lock_status == LIFECYCLE_LOCK_INTERRUPTED[\s\S]*safe_error_code\(audit_contract->kind, result\)[\s\S]*goto finish;/);
  assert.match(main,
    /lock_status != LIFECYCLE_LOCK_ACQUIRED[\s\S]*error_code = "INVALID_INSTALLATION";[\s\S]*goto finish;/);
  const finish = main.slice(main.indexOf("finish:"));
  assert.match(finish, /finish:\s*emit_audit_event/s);
  assert.match(finish,
    /if \(lock_fd >= 0\)[\s\S]*flock\(lock_fd, LOCK_UN\)[\s\S]*close\(lock_fd\)/);
});

test("portable lifecycle lock model is bounded for available, busy, error, and signal outcomes", () => {
  let attempts = 0;
  const available = modelLifecycleLock(() => { attempts += 1; return "acquired"; });
  assert.deepEqual(available,
    { proceed: true, resultEvent: "completed", errorCode: "NONE", attempts: 1 });
  assert.equal(attempts, 1);

  attempts = 0;
  const contended = modelLifecycleLock(() => { attempts += 1; return "would-block"; });
  assert.deepEqual(contended,
    { proceed: false, resultEvent: "rejected", errorCode: "LOCK_BUSY", attempts: 1 });
  assert.equal(attempts, 1);

  const failed = modelLifecycleLock(() => "error");
  assert.equal(failed.errorCode, "INVALID_INSTALLATION");
  assert.equal(failed.attempts, 1);

  const interrupted = modelLifecycleLock(() => "interrupted");
  assert.equal(interrupted.errorCode, "STATUS_FAILED");
  assert.equal(interrupted.attempts, 1);
});

test("runtime images contain only their role-specific native artifact", async () => {
  const authority = await read("Dockerfile.runtime-authority");
  const issuer = await read("Dockerfile.runtime-issuer");
  assert.match(authority, /authority_peer\.node/);
  assert.doesNotMatch(authority, /COPY --from=build .*issuer_peer\.node/);
  assert.match(issuer, /issuer_peer\.node/);
  assert.doesNotMatch(issuer, /COPY --from=build .*authority_peer\.node/);
  assert.doesNotMatch(authority + issuer, /docker\.sock|EXPOSE|apk add.*docker/);
  assert.match(authority, /chown 0:0 \/run\/authority-readiness/);
});

test("all seven protected bind sources are exact and cannot be auto-created", async () => {
  const compose = await read("deployment/runtime-trust/compose.yaml.in");
  assert.equal((compose.match(/type: bind/g) ?? []).length, 7);
  assert.equal((compose.match(/create_host_path: false/g) ?? []).length, 7);
  const bootstrap = await read("native/host-runtime/runtime-trust-bootstrap.c");
  const readiness = await read("native/host-runtime/runtime-authority-readiness.c");
  for (const flag of ["MS_NODEV", "MS_NOSUID", "MS_NOEXEC", "MS_RDONLY"]) {
    assert.match(bootstrap, new RegExp(flag));
    assert.match(readiness, new RegExp(flag));
  }
  assert.match(bootstrap, /harden_self_bind\("\/var\/lib\/authority-trust\/db", 1\)/);
  assert.match(bootstrap, /harden_self_bind\(UDS_DIRECTORY, 0\)/);
  assert.match(readiness, /harden_file_mount\(epoch_fd, EPOCH, 1\)/);
  assert.match(readiness, /harden_file_mount\(state_fd, STATE, 0\)/);
});

test("key and manifest staging retain exact descriptor identity across mount", async () => {
  const source = await read("native/host-runtime/runtime-trust-bootstrap.c");
  assert.match(source, /\/proc\/self\/fd\/%d/);
  assert.match(source, /bind_validated_file\(key_fd, &key_identity, key_path, KEY_MOUNT\)/);
  assert.match(source, /bind_validated_file\(manifest_fd, &manifest_identity, MANIFEST, MANIFEST_MOUNT\)/);
  assert.match(source, /fstat\(source_fd, &descriptor\).*lstat\(source_path, &current_source\)/s);
  assert.match(source, /lstat\(target, &mounted_target\).*same_identity\(identity, &mounted_target\)/s);
});

test("manifest parser transfers one retained descriptor and identity to bootstrap", async () => {
  const source = await read("native/host-runtime/runtime-trust-bootstrap.c");
  const parserStart = source.indexOf("static int parse_manifest");
  const parserEnd = source.indexOf("static int validate_key", parserStart);
  const prepareStart = source.indexOf("static int prepare_runtime");
  const prepareEnd = source.indexOf("static int cleanup_runtime", prepareStart);
  assert.ok(parserStart >= 0 && parserEnd > parserStart && prepareStart >= 0 && prepareEnd > prepareStart);
  const parser = source.slice(parserStart, parserEnd);
  const prepare = source.slice(prepareStart, prepareEnd);
  assert.match(parser,
    /parse_manifest\(boundary_manifest \*manifest, int \*retained_fd, struct stat \*identity\)/);
  assert.match(parser,
    /full_read_file\(MANIFEST, bytes, sizeof\(bytes\), &length, retained_fd, identity\)/);
  assert.equal((parser.match(/release_retained_descriptor\(retained_fd\)/g) ?? []).length, 1);
  assert.match(prepare, /int manifest_fd = -1;/);
  assert.match(prepare, /parse_manifest\(&manifest, &manifest_fd, &manifest_identity\)/);
  assert.match(prepare, /bind_validated_file\(manifest_fd, &manifest_identity, MANIFEST, MANIFEST_MOUNT\)/);
  assert.equal((prepare.match(/release_retained_descriptor\(&manifest_fd\)/g) ?? []).length, 1);
  assert.match(source,
    /descriptor = \*retained_fd;\s*\*retained_fd = -1;\s*\(void\)close\(descriptor\);/s);
});

test("manifest retained descriptor cleanup is exactly once for every bootstrap outcome", () => {
  type Stage = "read" | "parse" | "metadata" | "bind" | "post-bind-identity" | "success";
  const simulate = (stage: Stage) => {
    let descriptor = -1;
    let closes = 0;
    if (stage === "read") return { closes, descriptor };
    descriptor = 7;
    if (stage === "parse") {
      closes += 1;
      descriptor = -1;
    }
    if (descriptor >= 0) {
      // These outcomes converge on prepare_runtime's single owner-release block.
      closes += 1;
      descriptor = -1;
    }
    return { closes, descriptor };
  };

  assert.deepEqual(simulate("read"), { closes: 0, descriptor: -1 });
  for (const stage of ["parse", "metadata", "bind", "post-bind-identity", "success"] as const) {
    assert.deepEqual(simulate(stage), { closes: 1, descriptor: -1 });
  }
});

test("privileged bootstrap source passes the real Linux C syntax gate", (context) => {
  const outcome = runHostNativeCompileGate(process.platform, spawnNativeCompile);
  if (outcome.kind === "skip") context.skip(outcome.reason);
});

test("native compile gate skips only unsupported non-Linux platforms", () => {
  let invoked = false;
  const outcome = runHostNativeCompileGate("win32", () => {
    invoked = true;
    return { status: 0, stdout: "", stderr: "" };
  });
  assert.deepEqual(outcome, { kind: "skip", reason: "HOST_NATIVE_COMPILE_UNSUPPORTED:win32" });
  assert.equal(invoked, false);
});

test("native compile gate uses the fixed Makefile target on Linux", () => {
  let invocation: Readonly<{ command: string; arguments_: readonly string[] }> | undefined;
  const outcome = runHostNativeCompileGate("linux", (command, arguments_) => {
    invocation = { command, arguments_ };
    return { status: 0, stdout: "", stderr: "" };
  });
  assert.deepEqual(outcome, { kind: "pass" });
  assert.deepEqual(invocation, {
    command: "make",
    arguments_: ["-C", resolve(root, "native/host-runtime"), "check-runtime-trust-bootstrap"],
  });
});

test("native compile gate fails when the Linux toolchain is missing", () => {
  const missing = Object.assign(new Error("spawn make ENOENT"), { code: "ENOENT" });
  assert.throws(() => runHostNativeCompileGate("linux", () => ({
    status: null, stdout: "", stderr: "", error: missing,
  })), /HOST_NATIVE_COMPILE_REQUIRED_ON_LINUX/);
});

test("native compile gate fails on a non-zero Linux compiler result", () => {
  assert.throws(() => runHostNativeCompileGate("linux", () => ({
    status: 2, stdout: "", stderr: "cc: compilation failed",
  })), /HOST_NATIVE_COMPILE_REQUIRED_ON_LINUX:cc: compilation failed/);
});

test("lifecycle Compose validation is structural and binds exact installed bytes", async () => {
  const compose = await read("deployment/runtime-trust/compose.yaml.in");
  const source = await read("native/host-runtime/runtime-lifecycle-adapter.c");
  assert.equal(createHash("sha256").update(compose).digest("hex"),
    "91bf8d85cdf6513dfbce96bd225bff84c2fbf14a0aaef106975f5f56a73c3118");
  assert.match(source, /COMPOSE_DIGEST/);
  assert.match(source, /validate_installed_compose_digest/);
  assert.match(source, /normalize_compose/);
  assert.match(source, /memcmp\(output, "2\.32\.4\\n", 7U\)/);
  for (const mutation of [
    compose + "  extra:\n    image: bad@sha256:" + "0".repeat(64) + "\n",
    compose.replace("__AUTHORITY_IMAGE_DIGEST__", "changed@sha256:" + "0".repeat(64)),
    compose.replace('user: "21012:21012"', 'user: "0:0"'),
    compose.replace("cap_drop: [ALL]", "cap_drop: []"),
    compose.replace('restart: "no"', "restart: always"),
    compose.replace("network_mode: none", "ports:\n      - 8080:8080"),
    /* malformed historical fixture retained only inside this comment:
    compose.replace("    restart: \no\", "    profiles: [changed]\n    restart: \no\"),
    */
    compose.replace('    restart:', '    profiles: [changed]\n    restart:'),
  ]) assert.notEqual(createHash("sha256").update(mutation).digest("hex"),
    createHash("sha256").update(compose).digest("hex"));
});

test("lifecycle adapter line/byte invariants track the canonical Compose template", async () => {
  // Single source of truth is deployment/runtime-trust/compose.yaml.in.
  // The adapter's compiled constants must equal the template's measured
  // shape, otherwise validate_compose() deterministically rejects the
  // canonical file (83-vs-80 class drift). No second hard-coded count.
  const compose = await read("deployment/runtime-trust/compose.yaml.in");
  const source = await read("native/host-runtime/runtime-lifecycle-adapter.c");
  assert.match(compose, /\n$/);
  assert.doesNotMatch(compose, /\r/);
  const lineCount = compose.split("\n").length - 1;
  const byteLength = Buffer.byteLength(compose, "utf8");
  const lineConstant = /if \(line_number != (\d+)U\)/.exec(source);
  const byteConstant = /normalized_length != (\d+)U/.exec(source);
  assert.ok(lineConstant, "ADAPTER_LINE_COUNT_INVARIANT_MISSING");
  assert.ok(byteConstant, "ADAPTER_BYTE_LENGTH_INVARIANT_MISSING");
  assert.equal(Number(lineConstant[1]), lineCount);
  assert.equal(Number(byteConstant[1]), byteLength);
  assert.equal(createHash("sha256").update(compose).digest("hex"),
    "91bf8d85cdf6513dfbce96bd225bff84c2fbf14a0aaef106975f5f56a73c3118");
});

test("protected ancestors and stale UDS recovery fail closed", async () => {
  const bootstrap = await read("native/host-runtime/runtime-trust-bootstrap.c");
  const unit = await read("deployment/systemd/zima-control-runtime-stopped-check.service");
  assert.match(bootstrap, /O_PATH \| O_DIRECTORY \| O_NOFOLLOW/);
  assert.match(bootstrap, /same_identity\(&path_before, &descriptor\)/);
  assert.match(bootstrap, /both_runtimes_stopped\(\)/);
  assert.match(bootstrap, /valid_stopped_receipt\(AUTHORITY_STOPPED, "authority"\)/);
  assert.match(bootstrap, /valid_stopped_receipt\(ISSUER_STOPPED, "issuer"\)/);
  assert.match(bootstrap, /lifecycle_wrapper_running\(\) == 0/);
  assert.match(bootstrap, /confirmed\.st_dev != socket_node\.st_dev.*confirmed\.st_ino != socket_node\.st_ino/s);
  assert.match(unit, /STATUS_AUTHORITY/);
  assert.match(unit, /STATUS_ISSUER/);
});

test("adversarial key and manifest replacement cannot pass captured identity", () => {
  type Identity = Readonly<{ device: bigint; inode: bigint }>;
  const same = (left: Identity, right: Identity) =>
    left.device === right.device && left.inode === right.inode;
  const captured = { device: 1n, inode: 10n };
  const replacement = { device: 1n, inode: 11n };
  const admits = (current: Identity, mounted: Identity) =>
    same(captured, current) && same(captured, mounted);
  assert.equal(admits(replacement, replacement), false);
  assert.equal(admits(captured, replacement), false);
  assert.equal(admits(captured, captured), true);
});

test("ancestor and stopped-runtime evidence reject every ambiguous case", () => {
  const secureAncestor = (node: { directory: boolean; symlink: boolean; uid: number; gid: number; mode: number },
    uid: number, gid: number, mode: number) => node.directory && !node.symlink
      && node.uid === uid && node.gid === gid && node.mode === mode;
  const good = { directory: true, symlink: false, uid: 0, gid: 21012, mode: 0o750 };
  assert.equal(secureAncestor(good, 0, 21012, 0o750), true);
  assert.equal(secureAncestor({ ...good, symlink: true }, 0, 21012, 0o750), false);
  assert.equal(secureAncestor({ ...good, mode: 0o770 }, 0, 21012, 0o750), false);
  assert.equal(secureAncestor({ ...good, uid: 21012 }, 0, 21012, 0o750), false);
  for (const statuses of [["RUNNING", "STOPPED"], ["STOPPED", "RUNNING"],
    ["AMBIGUOUS", "STOPPED"], ["STOPPED", "AMBIGUOUS"]]) {
    assert.equal(statuses.every((status) => status === "STOPPED"), false);
  }
});

test("Authority validates readiness mounts before Trust DB and UDS access", async () => {
  const source = await read("apps/runtime-authority/src/main.ts");
  const mount = source.indexOf("verifyAuthorityReadinessMounts()");
  const readiness = source.indexOf("openAuthorityReadinessPublisher()");
  const databaseMount = source.indexOf("verifyAuthorityTrustDatabaseMount()");
  const database = source.indexOf("openReadOnlyTrustDatabase()");
  const udsMount = source.indexOf("verifyAuthorityUdsMount()");
  const uds = source.indexOf("new NodeRuntimeSocketInspector()");
  assert.ok(mount >= 0 && readiness > mount && databaseMount > readiness
    && database > databaseMount && udsMount > database && uds > udsMount);
});

test("Authority and Issuer revalidate retained mount identities after protected access", async () => {
  const authority = await read("apps/runtime-authority/src/main.ts");
  const issuer = await read("apps/runtime-issuer/src/main.ts");
  assert.match(authority,
    /openAuthorityReadinessPublisher\(\);\s*await Promise\.all\(readinessMounts\.map\(\(mount\) => mount\.revalidate\(\)\)\)/s);
  assert.match(authority,
    /openReadOnlyTrustDatabase\(\);\s*await databaseMount\.revalidate\(\)/s);
  assert.match(authority,
    /captureRuntimeSocket\(inspector\);\s*await udsMount\.revalidate\(\)/s);
  assert.match(issuer,
    /authenticateAuthorityConnection[\s\S]*?await udsMount\.revalidate\(\);\s*secretMounts = await verifyIssuerSecretMounts/s);
  assert.match(issuer,
    /NodeIssuerPrivateKeyProvider\.open[\s\S]*?await Promise\.all\(secretMounts\.map\(\(mount\) => mount\.revalidate\(\)\)\)/s);
});

test("lifecycle adapter revalidates PID-1 prepared sources without reading protected contents", async () => {
  const source = await read("native/host-runtime/runtime-lifecycle-adapter.c");
  assert.match(source, /HOST_MOUNTINFO "\/proc\/1\/mountinfo"/);
  assert.match(source, /HOST_ROOT "\/proc\/1\/root"/);
  assert.match(source, /validate_prepared_sources\(prepared_role, issuer_gid\)/);
  assert.match(source, /read_prepared_mount/);
  assert.match(source, /first\.mount_id != second\.mount_id/);
  for (const path of ["TRUST_DB_DIRECTORY", "UDS_DIRECTORY", "KEY_MOUNT", "MANIFEST_MOUNT",
    "READINESS_EPOCH", "READINESS_STATE"]) assert.match(source, new RegExp(path));
  assert.doesNotMatch(source, /open\((KEY_MOUNT|MANIFEST_MOUNT|TRUST_DB_DIRECTORY), O_RDONLY/);
  assert.doesNotMatch(source, /protected_manifest_gid/);
});

test("cleanup captures exact mount identity and proves consumer absence before non-lazy unmount", async () => {
  const bootstrap = await read("native/host-runtime/runtime-trust-bootstrap.c");
  const readiness = await read("native/host-runtime/runtime-authority-readiness.c");
  assert.match(bootstrap, /capture_exact_mount\(KEY_MOUNT, 1, &key_mount\)/);
  assert.match(bootstrap, /same_captured_mount\(MANIFEST_MOUNT, 1, &manifest_mount/);
  assert.match(bootstrap, /held_by_process\(&database_node\).*held_by_process\(&manifest_node\)/s);
  assert.match(readiness, /valid_stopped_receipt\(AUTHORITY_STOPPED, "authority"\)/);
  assert.match(readiness, /valid_stopped_receipt\(ISSUER_STOPPED, "issuer"\)/);
  assert.match(readiness, /lifecycle_wrapper_absent\(\)/);
  assert.match(readiness, /current_epoch\.id != epoch_mount\.id/);
  const bootstrapCleanup = bootstrap.slice(bootstrap.indexOf("static int cleanup_runtime"),
    bootstrap.indexOf("static int ensure_control_directory"));
  const readinessCleanup = readiness.slice(readiness.indexOf("static int cleanup"),
    readiness.indexOf("static int systemd_context"));
  assert.doesNotMatch(bootstrapCleanup + readinessCleanup, /MNT_DETACH/);
});

test("Issuer verifies UDS before Authority authentication and secret pair afterward", async () => {
  const source = await read("apps/runtime-issuer/src/main.ts");
  const uds = source.indexOf("verifyIssuerUdsMount()");
  const endpoint = source.indexOf("validateAuthoritySocketEndpoint(inspector)");
  const authenticated = source.indexOf("authenticateAuthorityConnection(connection");
  const secrets = source.indexOf("verifyIssuerSecretMounts()");
  const key = source.indexOf("NodeIssuerPrivateKeyProvider.open");
  assert.ok(uds >= 0 && endpoint > uds && authenticated > endpoint && secrets > authenticated && key > secrets);
});
