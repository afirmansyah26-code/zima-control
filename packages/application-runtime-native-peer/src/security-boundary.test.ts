/**
 * @file security-boundary.test.ts
 * AST / static analysis and source inspection test suite for
 * @zima-control-center/application-runtime-native-peer.
 * Proves absence of forbidden APIs, proper systemd FD adoption, SO_PEERCRED enforcement,
 * and zero exposure of raw integer file descriptors.
 */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const readRelative = (relative: string) =>
  readFile(fileURLToPath(new URL(relative, import.meta.url)), "utf8");

test("static review: no filesystem pathname unlink syscall anywhere in native or ts source", async () => {
  const [cSource, hSource, tsTypes, tsLoad, tsPortable, tsIndex] = await Promise.all([
    readRelative("../native/application_runtime_native_peer.c"),
    readRelative("../native/application_runtime_native_peer.h"),
    readRelative("types.ts"),
    readRelative("load.ts"),
    readRelative("portable.ts"),
    readRelative("index.ts"),
  ]);

  const allCode = `${cSource}\n${hSource}\n${tsTypes}\n${tsLoad}\n${tsPortable}\n${tsIndex}`;

  // Must never call unlink, unlinkat, or fs.unlink
  assert.doesNotMatch(allCode, /\bunlink\s*\(/, "unlink() syscall is strictly prohibited");
  assert.doesNotMatch(allCode, /\bunlinkat\s*\(/, "unlinkat() syscall is strictly prohibited");
  assert.doesNotMatch(allCode, /\bfs\.unlink\b/, "fs.unlink is strictly prohibited");
  assert.doesNotMatch(allCode, /\brmdir\s*\(/, "rmdir is strictly prohibited");
});

test("static review: no bind syscall in native C code (systemd is sole socket binder)", async () => {
  const cSource = await readRelative("../native/application_runtime_native_peer.c");
  assert.doesNotMatch(cSource, /\bbind\s*\(/, "bind() syscall is strictly prohibited; daemon only adopts FD 3");
});

test("static review: no arbitrary socket creation syscall in native C code", async () => {
  const cSource = await readRelative("../native/application_runtime_native_peer.c");
  assert.doesNotMatch(cSource, /\bsocket\s*\(/, "socket() creation syscall is prohibited; daemon must adopt systemd FD 3");
});

test("static review: no connect syscall in native C code (adapter daemon only accepts)", async () => {
  const cSource = await readRelative("../native/application_runtime_native_peer.c");
  assert.doesNotMatch(cSource, /\bconnect\s*\(/, "connect() syscall is prohibited in adapter daemon");
});

test("static review: listener adoption validates FD 3 and systemd environment invariants", async () => {
  const cSource = await readRelative("../native/application_runtime_native_peer.c");
  const hSource = await readRelative("../native/application_runtime_native_peer.h");

  // Expected FD = 3
  assert.match(hSource, /#define\s+SD_LISTEN_FDS_START\s+3\b/);

  // Checks LISTEN_PID
  assert.match(cSource, /getenv\("LISTEN_PID"\)/);
  assert.match(cSource, /getpid\(\)/);
  assert.match(cSource, /"MISSING_SYSTEMD_SOCKET"/);

  // Checks LISTEN_FDS
  assert.match(cSource, /getenv\("LISTEN_FDS"\)/);
  assert.match(cSource, /"UNEXPECTED_SYSTEMD_DESCRIPTOR_TOPOLOGY"/);

  // Validates AF_UNIX and SOCK_STREAM
  assert.match(cSource, /getsockname\s*\(\s*SD_LISTEN_FDS_START/);
  assert.match(cSource, /AF_UNIX/);
  assert.match(cSource, /getsockopt\s*\(\s*SD_LISTEN_FDS_START,\s*SOL_SOCKET,\s*SO_TYPE/);
  assert.match(cSource, /SOCK_STREAM/);
  assert.match(cSource, /"INVALID_SYSTEMD_SOCKET_TYPE"/);

  // Enforces FD_CLOEXEC and O_NONBLOCK
  assert.match(cSource, /FD_CLOEXEC/);
  assert.match(cSource, /O_NONBLOCK/);
});

test("static review: SO_PEERCRED is called immediately after accept4 before allocating handle", async () => {
  const cSource = await readRelative("../native/application_runtime_native_peer.c");

  const acceptIdx = cSource.indexOf("accept4(");
  const peercredIdx = cSource.indexOf("getsockopt(client_fd, SOL_SOCKET, SO_PEERCRED");
  const handleCallIdx = cSource.indexOf("zcc_build_connection_handle(", peercredIdx);

  assert.ok(acceptIdx !== -1, "accept4 must be present");
  assert.ok(peercredIdx !== -1, "getsockopt SO_PEERCRED must be present");
  assert.ok(handleCallIdx !== -1, "handle creation must be called after peercred check");

  assert.ok(
    acceptIdx < peercredIdx,
    "accept4() must precede getsockopt(SO_PEERCRED)"
  );
  assert.ok(
    peercredIdx < handleCallIdx,
    "getsockopt(SO_PEERCRED) must precede connection handle allocation"
  );
});

test("static review: approved principal matrix enforces UID 1000/GID 1000 and UID 21020/GID 21020", async () => {
  const [cSource, hSource, tsTypes] = await Promise.all([
    readRelative("../native/application_runtime_native_peer.c"),
    readRelative("../native/application_runtime_native_peer.h"),
    readRelative("types.ts"),
  ]);

  // C header definitions
  assert.match(hSource, /#define\s+APPROVED_CONTAINER_UID\s+1000U/);
  assert.match(hSource, /#define\s+APPROVED_CONTAINER_GID\s+1000U/);
  assert.match(hSource, /#define\s+APPROVED_HOST_UID\s+21020U/);
  assert.match(hSource, /#define\s+APPROVED_HOST_GID\s+21020U/);

  // C source checks
  assert.match(cSource, /ucred\.uid\s*==\s*APPROVED_CONTAINER_UID\s*&&\s*ucred\.gid\s*==\s*APPROVED_CONTAINER_GID/);
  assert.match(cSource, /ucred\.uid\s*==\s*APPROVED_HOST_UID\s*&&\s*ucred\.gid\s*==\s*APPROVED_HOST_GID/);
  assert.match(cSource, /"PEER_UNAUTHORIZED"/);

  // TS definitions
  assert.match(tsTypes, /APPROVED_CONTAINER_PEER_UID\s*=\s*1000/);
  assert.match(tsTypes, /APPROVED_CONTAINER_PEER_GID\s*=\s*1000/);
  assert.match(tsTypes, /APPROVED_HOST_PEER_UID\s*=\s*21020/);
  assert.match(tsTypes, /APPROVED_HOST_PEER_GID\s*=\s*21020/);
});

test("static review: zero exposure of raw integer file descriptors to JS/TS", async () => {
  const [cSource, tsTypes] = await Promise.all([
    readRelative("../native/application_runtime_native_peer.c"),
    readRelative("types.ts"),
  ]);

  // Interface property declarations must not expose fd, socketPath, or pathname
  assert.doesNotMatch(tsTypes, /\b(?:readonly\s+)?(?:fd|rawFd|socketPath|pathname)\s*[:?]/);

  // C code must not set "fd", "rawFd", "socketPath", or "pathname" property on JS objects
  assert.doesNotMatch(cSource, /napi_set_named_property\([^,]+,\s*[^,]+,\s*"(?:fd|rawFd|socketPath|pathname)"/);
});

test("static review: zero reliance on Node internal APIs or forbidden trust packages", async () => {
  const [cSource, tsFiles, pkgJson] = await Promise.all([
    readRelative("../native/application_runtime_native_peer.c"),
    Promise.all([
      readRelative("types.ts"),
      readRelative("load.ts"),
      readRelative("portable.ts"),
      readRelative("index.ts"),
    ]).then((files) => files.join("\n")),
    readRelative("../package.json"),
  ]);

  const allCode = `${cSource}\n${tsFiles}`;

  // No Node internal APIs
  assert.doesNotMatch(allCode, /socket\._handle/);
  assert.doesNotMatch(allCode, /\b_handle\b/);
  assert.doesNotMatch(allCode, /process\.binding/);
  assert.doesNotMatch(allCode, /internal\//);

  // No forbidden trust dependencies
  assert.doesNotMatch(allCode, /runtime-trust-linux-peer/);
  assert.doesNotMatch(allCode, /runtime-trust-authority/);
  assert.doesNotMatch(allCode, /runtime-trust-issuer/);
  assert.doesNotMatch(allCode, /runtime-trust-contracts/);
  assert.doesNotMatch(allCode, /trust-prisma-client/);
  assert.doesNotMatch(allCode, /trust-persistence/);

  // Package dependencies check
  const pkg = JSON.parse(pkgJson);
  const deps = Object.keys(pkg.dependencies ?? {});
  const devDeps = Object.keys(pkg.devDependencies ?? {});
  const allDeps = [...deps, ...devDeps];

  for (const dep of allDeps) {
    assert.equal(
      dep.includes("trust"),
      false,
      `Package must not depend on trust package: ${dep}`
    );
  }
});

test("static review: N-API Version 8 contract is declared and enforced", async () => {
  const [cSource, bindingGyp] = await Promise.all([
    readRelative("../native/application_runtime_native_peer.c"),
    readRelative("../binding.gyp"),
  ]);

  assert.match(bindingGyp, /"NAPI_VERSION=8"/);
  assert.match(cSource, /napi_get_version/);
  assert.match(cSource, /napi_version\s*<\s*8/);
  assert.match(cSource, /"PEER_PLATFORM_UNSUPPORTED"/);
});
