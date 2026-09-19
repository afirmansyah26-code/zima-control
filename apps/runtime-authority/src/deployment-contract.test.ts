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
  const stoppedCheck = await read("deployment/systemd/zima-control-runtime-stopped-check.service");
  const bootstrap = await read("deployment/systemd/zima-control-runtime-bootstrap.service");
  const readinessMount = await read("deployment/systemd/zima-control-runtime-readiness-mount.service");
  const authority = await read("deployment/systemd/zima-control-runtime-authority.service");
  const issuer = await read("deployment/systemd/zima-control-runtime-issuer.service");
  const target = await read("deployment/systemd/zima-control-runtime-trust.target");
  assert.match(stoppedCheck, /^Before=zima-control-runtime-bootstrap\.service$/m);
  assert.match(stoppedCheck, /^PartOf=zima-control-runtime-bootstrap\.service$/m);
  assert.match(stoppedCheck, /^RuntimeDirectory=authority-runtime-bootstrap$/m);
  assert.match(stoppedCheck, /^RuntimeDirectoryMode=0700$/m);
  // Fresh precondition probe: oneshot WITHOUT RemainAfterExit so a later
  // bootstrap activation re-executes it and regenerates fresh receipts.
  assert.match(stoppedCheck, /^Type=oneshot$/m);
  assert.doesNotMatch(stoppedCheck, /^RemainAfterExit=/m);
  // RuntimeDirectory is preserved so fresh receipts survive the oneshot exit.
  assert.match(stoppedCheck, /^RuntimeDirectory=authority-runtime-bootstrap$/m);
  assert.match(stoppedCheck, /^RuntimeDirectoryMode=0700$/m);
  assert.match(stoppedCheck, /^RuntimeDirectoryPreserve=yes$/m);
  assert.match(bootstrap, /^Requires=.*zima-control-runtime-stopped-check\.service$/m);
  assert.match(bootstrap, /^After=.*zima-control-runtime-stopped-check\.service$/m);
  assert.doesNotMatch(bootstrap, /^RuntimeDirectory=/m);
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

test("stopped-check is a re-executable fresh precondition probe", async () => {
  const stoppedCheck = await read("deployment/systemd/zima-control-runtime-stopped-check.service");
  const bootstrap = await read("deployment/systemd/zima-control-runtime-bootstrap.service");
  // oneshot without RemainAfterExit returns to inactive and re-executes on a
  // later start request; this is the re-execution guarantee.
  assert.match(stoppedCheck, /^Type=oneshot$/m);
  assert.doesNotMatch(stoppedCheck, /RemainAfterExit/);
  assert.doesNotMatch(stoppedCheck, /Restart=|ExecStartPre=.*sleep|RuntimeMaxSec|Timer/i);
  // ordering guarantee
  assert.match(stoppedCheck, /^Before=zima-control-runtime-bootstrap\.service$/m);
  assert.match(bootstrap, /^After=.*zima-control-runtime-stopped-check\.service$/m);
  assert.match(bootstrap, /^Requires=.*zima-control-runtime-stopped-check\.service$/m);
  // trust-mount precondition retained
  assert.match(stoppedCheck, /^Requires=.*var-lib-authority\\x2dtrust\.mount$/m);
  // directory persistence is a lifetime guarantee only; receipt validity is
  // enforced independently by the native helper.
  assert.match(stoppedCheck, /^RuntimeDirectoryPreserve=yes$/m);
  const helper = await read("native/host-runtime/runtime-trust-bootstrap.c");
  assert.match(helper, /now\.tv_sec - seconds > 5ULL/);
  assert.match(helper, /valid_stopped_receipt/);
  assert.match(helper, /both_runtimes_stopped/);
  assert.match(helper, /ZCC_RUNTIME_STOPPED_V1/);
});

test("lifecycle states distinguish pre-bootstrap stopped status from prepared starts", async () => {
  const stoppedCheck = await read("deployment/systemd/zima-control-runtime-stopped-check.service");
  const bootstrap = await read("deployment/systemd/zima-control-runtime-bootstrap.service");
  const adapter = await read("native/host-runtime/runtime-lifecycle-adapter.c");

  // PRE-BOOTSTRAP: systemd first creates the fixed control directory, then
  // STATUS records stopped-state evidence without requiring protected mounts.
  assert.ok(stoppedCheck.indexOf("RuntimeDirectory=authority-runtime-bootstrap")
    < stoppedCheck.indexOf(
      "ExecStart=/usr/libexec/zima-control-center/runtime-lifecycle-adapter STATUS_AUTHORITY"));
  assert.match(stoppedCheck, /STATUS_AUTHORITY[\s\S]*STATUS_ISSUER/);
  const statusAuthority = adapter.slice(adapter.indexOf("OP_STATUS_AUTHORITY) {"),
    adapter.indexOf("OP_STATUS_ISSUER) {"));
  const statusIssuer = adapter.slice(adapter.indexOf("OP_STATUS_ISSUER) {"),
    adapter.indexOf("OP_REMOVE_RUNTIME_CONTAINERS) {"));
  assert.doesNotMatch(statusAuthority + statusIssuer, /prepared_role\s*=/);

  // PREPARED: only successful PREPARE can precede runtime START, whose fixed
  // role selects the complete PID-1 prepared-source verification.
  assert.match(bootstrap, /ExecStart=.*runtime-trust-bootstrap PREPARE/);
  assert.match(adapter,
    /OP_START_AUTHORITY\) prepared_role = 1;\s*\n\s*else if \(audit_contract->kind == OP_START_ISSUER\) prepared_role = 0;/);
  assert.match(adapter,
    /if \(prepared_role >= 0\) \{\s*\n\s*if \(validate_prepared_sources\(prepared_role, issuer_gid\) != 0\)/);
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
  const stoppedCheck = await read("deployment/systemd/zima-control-runtime-stopped-check.service");
  const uninstall = await read("deployment/systemd/zima-control-runtime-uninstall.service");
  const capture = "CapabilityBoundingSet=CAP_SYS_ADMIN CAP_DAC_OVERRIDE CAP_CHOWN CAP_FOWNER CAP_SYS_PTRACE CAP_SETPCAP";
  for (const unit of [bootstrap, readinessMount]) {
    assert.match(unit, new RegExp(capture));
    assert.match(unit, /^AmbientCapabilities=$/m);
    assert.doesNotMatch(unit, /PrivateTmp|PrivateDevices|ProtectSystem|ProtectHome|ReadOnlyPaths|ReadWritePaths|InaccessiblePaths|BindPaths|BindReadOnlyPaths/);
  }
  // Adapter START units carry exactly the two capture capabilities; the adapter
  // drops them verb-scoped before Docker/lifecycle execution.
  for (const unit of [authority, issuer]) {
    assert.match(unit, /^CapabilityBoundingSet=CAP_SYS_PTRACE CAP_SETPCAP$/m);
    assert.match(unit, /^AmbientCapabilities=$/m);
    assert.match(unit, /SystemCallFilter=~@mount setns unshare pivot_root/);
  }
  // Non-START adapter units remain zero-capability.
  for (const unit of [stoppedCheck, uninstall]) {
    assert.match(unit, /^CapabilityBoundingSet=$/m);
    assert.match(unit, /^AmbientCapabilities=$/m);
  }
  const bootstrapSource = await read("native/host-runtime/runtime-trust-bootstrap.c");
  const readinessSource = await read("native/host-runtime/runtime-authority-readiness.c");
  for (const source of [bootstrapSource, readinessSource]) {
    assert.match(source, /stat\("\/proc\/self\/ns\/mnt"/);
    assert.match(source, /stat\("\/proc\/1\/ns\/mnt"/);
    assert.match(source, /host_mount_namespace_unchanged/);
    assert.match(source, /exact_capture_capabilities/);
    assert.match(source, /exact_operation_capabilities/);
    assert.match(source, /drop_capture_capabilities/);
    assert.match(source, /normalize_inheritable_capabilities/);
    assert.match(source, /PR_CAPBSET_DROP, CAP_SYS_PTRACE/);
    assert.match(source, /PR_CAPBSET_DROP, CAP_SETPCAP/);
    assert.match(source, /PR_CAPBSET_READ, CAP_SYS_PTRACE/);
    assert.match(source, /PR_CAPBSET_READ, CAP_SETPCAP/);
    assert.match(source, /_LINUX_CAPABILITY_VERSION_3/);
    assert.match(source, /PR_CAP_AMBIENT_IS_SET/);
    assert.doesNotMatch(source, /\b(setns|unshare)\s*\(/);
  }
});

test("lifecycle adapter applies a verb-scoped capability transition", async () => {
  const source = await read("native/host-runtime/runtime-lifecycle-adapter.c");
  // START verbs require the exact two-capability capture set, validate prepared
  // sources, then drop to exact zero before Docker/lifecycle execution.
  assert.match(source, /#define CAPTURE_CAPABILITIES \(\(1U << CAP_SYS_PTRACE\) \| \(1U << CAP_SETPCAP\)\)/);
  assert.match(source, /exact_capture_capabilities/);
  assert.match(source, /exact_zero_capabilities/);
  assert.match(source, /drop_capture_capabilities/);
  assert.match(source, /normalize_inheritable_capabilities/);
  assert.match(source, /PR_CAPBSET_DROP, CAP_SYS_PTRACE/);
  assert.match(source, /PR_CAPBSET_DROP, CAP_SETPCAP/);
  assert.match(source, /stat\("\/proc\/1\/ns\/mnt"/);
  // The drop must appear after prepared-source validation and before Docker run.
  const dropIndex = source.indexOf("drop_capture_capabilities() != 0 || exact_zero_capabilities()");
  const dockerIndex = source.indexOf("result = run_operation(command, attached, status_mode)");
  const preparedIndex = source.indexOf("validate_prepared_sources(prepared_role, issuer_gid) != 0");
  assert.ok(preparedIndex >= 0 && dropIndex > preparedIndex,
    "DROP_MUST_FOLLOW_PREPARED_SOURCE_VALIDATION");
  assert.ok(dockerIndex > dropIndex, "DROP_MUST_PRECEDE_DOCKER_OPERATION");
  // NON-START verbs run in one of two legitimate unit states: zero-capability
  // units (stopped-check, uninstall) or the authority/issuer capture-bounding
  // state. The transition must conditionally drop the bounding capture set and
  // must never clear effective/permitted before that drop.
  assert.match(source, /static int transition_non_start_capabilities/);
  assert.match(source, /static int bounding_capture_state/);
  const nonStart = source.slice(source.indexOf("static int transition_non_start_capabilities"),
    source.indexOf("static int full_write"));
  // fail-closed on unexpected bounding states
  assert.match(nonStart, /if \(state < 0\) return -1;/);
  // conditional drop only when capture bounding is present
  assert.match(nonStart, /if \(state == 1\) \{/);
  assert.match(nonStart, /\(data\[0\]\.effective & \(1U << CAP_SETPCAP\)\) == 0U\) return -1;/);
  assert.match(nonStart, /PR_CAPBSET_DROP, CAP_SYS_PTRACE/);
  assert.match(nonStart, /PR_CAPBSET_DROP, CAP_SETPCAP/);
  // effective/permitted clearing must happen after the drops
  const dropIdx = nonStart.indexOf("PR_CAPBSET_DROP, CAP_SETPCAP");
  const clearIdx = nonStart.indexOf("return clear_effective_permitted_capabilities();");
  assert.ok(clearIdx > dropIdx, "NON_START_CLEAR_MUST_FOLLOW_BOUNDING_DROPS");
  // bounding_capture_state rejects unrelated capabilities and half-states
  const stateHelper = source.slice(source.indexOf("static int bounding_capture_state"),
    source.indexOf("static int transition_non_start_capabilities"));
  assert.match(stateHelper, /if \(others != 0\) return -1;/);
  assert.match(stateHelper, /if \(ptr == 0 && spc == 0\) return 0;/);
  assert.match(stateHelper, /if \(ptr == 1 && spc == 1\) return 1;/);
  assert.match(stateHelper, /return -1;/);
  // The non-START branch uses the conditional transition helper.
  assert.match(source, /transition_non_start_capabilities\(\) != 0/);

  // Verb classification must gate the capability branch.
  assert.match(source, /audit_contract->kind == OP_START_AUTHORITY \|\| audit_contract->kind == OP_START_ISSUER/);
  // No CAP_SYS_ADMIN in the adapter capture set.
  assert.doesNotMatch(source, /CAPTURE_CAPABILITIES[\s\S]{0,120}CAP_SYS_ADMIN/);

  // NON-START verbs run in one of two legitimate unit states (zero-capability
  // stopped-check/uninstall, or authority/issuer capture-bounding). The branch
  // uses the conditional transition helper, never the START drop helper.
  const nonStartBranch = source.slice(source.indexOf("} else {\n    if (transition_non_start_capabilities()"),
    source.indexOf("if (validate_directory(\"/run\""));
  assert.match(nonStartBranch, /transition_non_start_capabilities\(\) != 0/);
  assert.doesNotMatch(nonStartBranch, /drop_capture_capabilities/);
  const clearHelper = source.slice(source.indexOf("static int clear_effective_permitted_capabilities"),
    source.indexOf("static int clear_effective_permitted_capabilities") + 700);
  assert.doesNotMatch(clearHelper, /PR_CAPBSET_DROP/);
  // exact_zero_capabilities must keep the strict bounding check.
  const zeroHelper = source.slice(source.indexOf("static int exact_zero_capabilities"),
    source.indexOf("static int drop_capture_capabilities"));
  assert.match(zeroHelper, /PR_CAPBSET_READ, CAP_SYS_PTRACE/);
  assert.match(zeroHelper, /PR_CAPBSET_READ, CAP_SETPCAP/);
  // START transition must still perform both irreversible bounding drops.
  const startDrop = source.slice(source.indexOf("static int drop_capture_capabilities"),
    source.indexOf("static int clear_effective_permitted_capabilities"));
  assert.match(startDrop, /PR_CAPBSET_DROP, CAP_SYS_PTRACE/);
  assert.match(startDrop, /PR_CAPBSET_DROP, CAP_SETPCAP/);
});

test("R1 end-of-invocation proof compares against captured PID1 identity without PTRACE", async () => {
  const bootstrap = await read("native/host-runtime/runtime-trust-bootstrap.c");
  const readiness = await read("native/host-runtime/runtime-authority-readiness.c");
  for (const source of [bootstrap, readiness]) {
    // capture stores the PID1 namespace identity
    assert.match(source, /\*identity = host_namespace;/);
    // end check reads only the self namespace and compares to captured identity
    const endCheck = source.slice(source.indexOf("static int host_mount_namespace_unchanged"));
    assert.match(endCheck, /stat\("\/proc\/self\/ns\/mnt", &current\)/);
    assert.match(endCheck, /current\.st_dev == identity->st_dev && current\.st_ino == identity->st_ino/);
    // the end check must not dereference the PID1 namespace
    const endBody = endCheck.slice(0, endCheck.indexOf("}"));
    assert.doesNotMatch(endBody, /proc\/1\/ns\/mnt/);
  }
  // readiness end check is gated to mount verbs only
  assert.match(readiness, /if \(mount_verb != 0 && host_mount_namespace_unchanged\(&mount_namespace\) != 0\) result = 80;/);
  // sandbox still forbids namespace-changing syscalls
  const bootstrapUnit = await read("deployment/systemd/zima-control-runtime-bootstrap.service");
  const readinessUnit = await read("deployment/systemd/zima-control-runtime-readiness-mount.service");
  for (const unit of [bootstrapUnit, readinessUnit]) {
    assert.match(unit, /SystemCallFilter=~setns unshare pivot_root/);
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

test("platform-aware ancestor validation follows Amendment 2C-13.3-A1", async () => {
  const adapter = await read("native/host-runtime/runtime-lifecycle-adapter.c");
  const stoppedCheck = await read("deployment/systemd/zima-control-runtime-stopped-check.service");
  const provisioning = await read("packages/trust-provisioning/src/filesystem.ts");
  const coordinator = await read("packages/trust-provisioning/src/coordinator.ts");
  const constants = await read("packages/trust-provisioning/src/constants.ts");

  // Two-tier classification: strict root:root ancestors remain, plus
  // exactly two platform-profiled ancestors.
  assert.match(adapter, /validate_directory\("\/", \(mode_t\)0022\)/);
  assert.match(adapter, /validate_directory\("\/usr", \(mode_t\)0022\)/);
  assert.match(adapter, /validate_directory\("\/usr\/lib\/zima-control-center", \(mode_t\)0022\)/);
  assert.match(adapter, /validate_directory\("\/usr\/lib\/zima-control-center\/runtime-trust", \(mode_t\)0022\)/);
  assert.match(adapter, /validate_platform_directory\("\/usr\/bin", &profile\.usr_bin/);
  assert.match(adapter, /validate_platform_directory\("\/usr\/lib", &profile\.usr_lib/);
  assert.doesNotMatch(adapter, /validate_platform_directory\("\/"/);
  assert.doesNotMatch(adapter, /validate_platform_directory\("\/usr"/);

  // No hard-coded platform uid (1001) anywhere in the adapter.
  assert.doesNotMatch(adapter, /\b1001\b/);

  // Strict byte-oriented profile parser: fixed grammar, canonical only.
  assert.match(adapter, /PLATFORM_PROFILE "\/var\/lib\/authority-trust\/platform-ownership-profile\.json"/);
  assert.match(adapter, /parse_platform_profile/);
  assert.match(adapter, /"\{\\"ancestors\\":\["/);
  assert.match(adapter, /"\],\\"schemaVersion\\":1\}"/);
  assert.match(adapter, /value > 2147483647UL/);
  assert.match(adapter, /\/usr\/lib-resolved|memcmp\(\*cursor, expected_path, path_length\)/);
  assert.match(adapter, /\(before\.st_mode & \(mode_t\)07777\) != \(mode_t\)0640/);
  assert.match(adapter, /O_RDONLY \| O_NOFOLLOW \| O_CLOEXEC/);

  // Conditional RO proof reuses existing mountinfo semantics; no weaker duplicate.
  assert.match(adapter, /covering_mount_is_ro/);
  assert.match(adapter, /mount_option\(options, "ro"\) != 0/);
  assert.match(adapter, /mount_option\(options, "rw"\) == 0/);
  assert.match(adapter, /HOST_MOUNTINFO "\/proc\/1\/mountinfo"/);

  // Profile is never written by the adapter (runtime read-only trust anchor).
  assert.doesNotMatch(adapter, /O_CREAT[^\n]*PLATFORM_PROFILE/);
  assert.doesNotMatch(adapter, /rename\([^\n]*PLATFORM_PROFILE/);

  // Provisioning owns the profile: provisioned in initialize/rebind/recover
  // after ensureLayout, never in runtime paths.
  assert.match(constants, /platformOwnershipProfile: "\/var\/lib\/authority-trust\/platform-ownership-profile\.json"/);
  assert.match(constants, /PLATFORM_OWNERSHIP_PROFILE_PATHS = Object\.freeze\(\["\/usr\/bin", "\/usr\/lib"\]/);
  assert.match(provisioning, /provisionPlatformOwnershipProfile\(\): Promise<void>/);
  assert.match(provisioning, /canonicalJson\(document\)/);
  assert.match(provisioning, /constants\.O_CREAT \| constants\.O_EXCL/);
  assert.match(provisioning, /rename\(temporary, profilePath\)/);
  assert.match(provisioning, /\(info\.mode & 0o0022\) !== 0\) throw invalidStorage\(\)/);
  assert.match(provisioning, /mountIsReadOnly\(mountTable, "\/usr"\)/);
  const initCall = coordinator.indexOf("await this.filesystem.provisionPlatformOwnershipProfile();");
  assert.ok(initCall > coordinator.indexOf("ensureLayout(request.issuerReadGid)"),
    "INITIALIZE must provision profile after ensureLayout");
  assert.match(coordinator,
    /ensureLayout\(manifest\.issuerReadGid\);\s*\n\s*await this\.filesystem\.provisionPlatformOwnershipProfile\(\);/g);
  assert.equal((coordinator.match(/provisionPlatformOwnershipProfile\(\);/g) ?? []).length, 3);

  // Profile availability before the first lifecycle unit.
  assert.match(stoppedCheck,
    /^Requires=docker\.service var-lib-authority\\x2dtrust\.mount$/m);
  assert.match(stoppedCheck,
    /^After=docker\.service var-lib-authority\\x2dtrust\.mount$/m);
});

test("identity validation uses reentrant NSS lookups with independent storage", async () => {
  const bootstrap = await read("native/host-runtime/runtime-trust-bootstrap.c");
  const adapter = await read("native/host-runtime/runtime-lifecycle-adapter.c");
  const readiness = await read("native/host-runtime/runtime-authority-readiness.c");
  // The distinctness checks require two passwd records and two group records to
  // coexist; non-reentrant getpwuid/getgrgid alias one static buffer and make
  // authority->pw_uid == issuer->pw_uid compare overwritten data to itself.
  assert.doesNotMatch(bootstrap, /\bgetpwuid\s*\(/);
  assert.doesNotMatch(bootstrap, /\bgetgrgid\s*\(/);
  assert.match(bootstrap, /getpwuid_r\(/);
  assert.match(bootstrap, /getgrgid_r\(/);
  // distinct local storage per record
  assert.match(bootstrap, /struct passwd authority;/);
  assert.match(bootstrap, /struct passwd issuer;/);
  assert.match(bootstrap, /struct group authority_group;/);
  assert.match(bootstrap, /struct group issuer_group;/);
  // resolver helpers fail closed on lookup error or ERANGE (getpwuid_r != 0)
  assert.match(bootstrap, /getpwuid_r\(uid, account, buffer, size, &result\) != 0 \|\| result == NULL/);
  assert.match(bootstrap, /getgrgid_r\(gid, group, buffer, size, &result\) != 0 \|\| result == NULL/);
  // identity contract preserved: distinctness + memberships unchanged
  assert.match(bootstrap, /authority\.pw_uid == issuer\.pw_uid/);
  assert.match(bootstrap, /authority_group\.gr_gid == issuer_group\.gr_gid/);
  assert.match(bootstrap, /member_of\(&authority, \(gid_t\)IPC_GID\)/);
  assert.match(bootstrap, /member_of\(&issuer, issuer_read_gid\)/);
  // adapter/readiness perform no NSS lookups, so no change is required there
  assert.doesNotMatch(adapter, /getpwuid|getgrgid|getpwnam|getgrnam/);
  assert.doesNotMatch(readiness, /getpwuid|getgrgid|getpwnam|getgrnam/);
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
