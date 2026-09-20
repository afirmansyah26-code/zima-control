import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const read = (relative: string) =>
  readFile(fileURLToPath(new URL(relative, import.meta.url)), "utf8");

const packageRoot = fileURLToPath(new URL("../", import.meta.url));

const functionBody = (source: string, name: string) => {
  const declaration = new RegExp(`(?:static\\s+)?[A-Za-z_][A-Za-z0-9_ *]*\\b${name}\\s*\\([^;]*?\\)\\s*\\{`, "s").exec(source);
  assert.ok(declaration, `missing ${name}`);
  const brace = source.indexOf("{", declaration.index);
  let depth = 0;
  for (let index = brace; index < source.length; index += 1) {
    if (source[index] === "{") depth += 1;
    if (source[index] === "}") depth -= 1;
    if (depth === 0) return source.slice(brace, index + 1);
  }
  assert.fail(`unterminated ${name}`);
};

test("transport is one private pthread with epoll and eventfd command wakeup", async () => {
  const pump = await read("../native/runtime_peer_pump.c");
  const header = await read("../native/runtime_peer_internal.h");
  assert.match(pump, /pthread_create\(&runtime->io_thread, NULL, zcc_io_thread_main, runtime\)/);
  assert.equal((pump.match(/pthread_create\s*\(/g) ?? []).length, 1);
  assert.match(await read("../native/runtime_peer.c"), /zcc_environment_claimed != 0/);
  assert.match(pump, /epoll_create1\(EPOLL_CLOEXEC\)/);
  assert.match(pump, /epoll_wait\(runtime->epoll_fd/);
  assert.match(pump, /eventfd\(0U, EFD_CLOEXEC \| EFD_NONBLOCK\)/);
  assert.match(pump, /descriptor = runtime->control_fd/);
  assert.match(pump, /write\(descriptor, &signal, sizeof\(signal\)\)/);
  assert.match(pump, /read\(runtime->control_fd, &value, sizeof\(value\)\)/);
  assert.match(header, /ZCC_COMMAND_CAPACITY 64U/);
  assert.match(header, /ZCC_OUTSTANDING_CAPACITY 48U/);
  assert.match(pump, /runtime->queued_commands < ZCC_COMMAND_CAPACITY/);
  assert.match(pump, /runtime->outstanding_operations < ZCC_OUTSTANDING_CAPACITY/);
});

test("socket syscalls exist only in the I/O pump and forbidden transports are absent", async () => {
  const [bridge, pump, header] = await Promise.all([
    read("../native/runtime_peer.c"),
    read("../native/runtime_peer_pump.c"),
    read("../native/runtime_peer_internal.h")
  ]);
  const native = `${bridge}\n${pump}\n${header}`;
  for (const syscall of ["socket", "bind", "listen", "accept4", "connect", "getsockopt", "recv", "send", "close"]) {
    assert.match(pump, new RegExp(`\\b${syscall}\\s*\\(`));
    assert.doesNotMatch(bridge, new RegExp(`\\b${syscall}\\s*\\(`));
  }
  assert.doesNotMatch(native, /\bnapi_(?:create_|queue_|delete_)?async_work\b/);
  assert.doesNotMatch(native, /\bpoll\s*\(|\bselect\s*\(/);
  assert.doesNotMatch(native, /socket\._handle|\b_handle\b|\buv_[A-Za-z0-9_]*|\bv8::|<v8\.h>/);
  assert.doesNotMatch(native, /AF_INET6?|SOCK_RAW|IPPROTO_TCP/);
  assert.doesNotMatch(native, /\bdup(?:2|3)?\s*\(/);
  assert.doesNotMatch(native, /docker|spawn|system\s*\(|exec[vle]*\s*\(|getenv/i);
});

test("accept captures and validates SO_PEERCRED before allocating an opaque connection", async () => {
  const pump = await read("../native/runtime_peer_pump.c");
  const accept = functionBody(pump, "zcc_process_accept");
  const acceptedAt = accept.indexOf("accept4(");
  const validateAt = accept.indexOf("zcc_validate_connected_fd(accepted)");
  const credentialAt = accept.indexOf("zcc_capture_credentials(accepted");
  const allocationAt = accept.indexOf("zcc_create_native_object(");
  const exposureAt = accept.indexOf("operation->result_object = connection");
  assert.ok(acceptedAt < validateAt && validateAt < credentialAt);
  assert.ok(credentialAt < allocationAt && allocationAt < exposureAt);
  const credential = functionBody(pump, "zcc_capture_credentials");
  assert.match(credential, /getsockopt\(fd, SOL_SOCKET, SO_PEERCRED/);
  assert.match(credential, /credentials->pid < 0/);
});

test("generation registry and synchronous invalidation prevent stale handle reuse", async () => {
  const [bridge, pump, header] = await Promise.all([
    read("../native/runtime_peer.c"),
    read("../native/runtime_peer_pump.c"),
    read("../native/runtime_peer_internal.h")
  ]);
  assert.match(header, /uint64_t generation;/);
  assert.match(header, /uint64_t owner_generation;/);
  assert.match(pump, /runtime->next_generation == UINT64_MAX/);
  assert.match(pump, /object->generation = runtime->next_generation;/);
  assert.match(bridge, /owner->generation == operation->owner_generation/);
  assert.match(bridge, /zcc_registry_contains_locked\(owner->runtime, owner\)/);
  const requestClose = functionBody(pump, "zcc_request_close");
  assert.match(requestClose, /object->accepts_commands = 0/);
  assert.doesNotMatch(requestClose, /object->fd\s*=|close\s*\(|epoll_ctl\s*\(/);
  const close = functionBody(pump, "zcc_close_object_on_io");
  assert.ok(close.indexOf("object->fd = -1") < close.indexOf("close(descriptor)"));
  assert.ok(close.indexOf("object->state = ZCC_STATE_CLOSED") < close.indexOf("close(descriptor)"));
});

test("Promise completion crosses only the stable Node-API thread-safe boundary", async () => {
  const [bridge, pump] = await Promise.all([
    read("../native/runtime_peer.c"),
    read("../native/runtime_peer_pump.c")
  ]);
  assert.match(bridge, /napi_create_threadsafe_function\(/);
  assert.match(pump, /napi_call_threadsafe_function\(/);
  assert.match(bridge, /napi_add_env_cleanup_hook\(env, zcc_runtime_cleanup/);
  assert.match(pump, /pthread_join\(runtime->io_thread, NULL\)/);
  assert.doesNotMatch(pump, /napi_(?:create_object|wrap|resolve_deferred|reject_deferred)\s*\(/);
});

test("Authority and Issuer remain separate role-specific artifacts", async () => {
  const [binding, bridge, pump] = await Promise.all([
    read("../binding.gyp"),
    read("../native/runtime_peer.c"),
    read("../native/runtime_peer_pump.c")
  ]);
  assert.match(binding, /"target_name": "authority_peer"/);
  assert.match(binding, /"target_name": "issuer_peer"/);
  assert.match(binding, /ZCC_AUTHORITY_ARTIFACT=1/);
  assert.match(binding, /ZCC_ISSUER_ARTIFACT=1/);
  assert.equal((binding.match(/native\/runtime_peer_pump\.c/g) ?? []).length, 2);
  assert.equal((binding.match(/"-pthread"/g) ?? []).length, 4);
  assert.equal((binding.match(/"-U_FORTIFY_SOURCE", "-D_FORTIFY_SOURCE=3"/g) ?? []).length, 2);
  assert.equal((binding.match(/"-Werror"/g) ?? []).length, 2);
  assert.doesNotMatch(binding, /Wno-missing-prototypes/);
  assert.match(bridge, /NAPI_MODULE_EXPORT int32_t NODE_API_MODULE_GET_API_VERSION\(void\);/);
  assert.match(bridge, /#if defined\(ZCC_AUTHORITY_ARTIFACT\)/);
  assert.match(bridge, /"createAuthorityListener"/);
  assert.match(bridge, /"connectAuthority"/);
  assert.match(functionBody(pump, "zcc_process_create_listener"), /bind\(|listen\(/);
  assert.match(functionBody(pump, "zcc_process_connect"), /connect\(/);
  assert.match(pump, /#if defined\(ZCC_AUTHORITY_ARTIFACT\)\s+static void zcc_process_accept/s);
  assert.match(pump, /#if defined\(ZCC_ISSUER_ARTIFACT\)\s+static void zcc_process_connect/s);
});

test("Linux Node 22 strict build compiles both role-specific native artifacts", {
  skip: process.platform !== "linux" ? "HOST_NATIVE_BUILD_UNSUPPORTED" : false,
  timeout: 120_000
}, async () => {
  assert.equal(process.versions.node.split(".")[0], "22", "HOST_NATIVE_NODE_22_REQUIRED");
  const nodeGyp = fileURLToPath(new URL("../../../node_modules/node-gyp/bin/node-gyp.js", import.meta.url));
  const result = spawnSync(process.execPath, [nodeGyp, "rebuild"], {
    cwd: packageRoot,
    encoding: "utf8",
    maxBuffer: 4 * 1024 * 1024,
    timeout: 110_000
  });
  assert.equal(result.error, undefined, `HOST_NATIVE_BUILD_FAILED:${result.error?.message}`);
  assert.equal(result.status, 0, `HOST_NATIVE_BUILD_FAILED:${result.stderr}`);
  for (const artifact of ["authority_peer.node", "issuer_peer.node"]) {
    const path = fileURLToPath(new URL(`../build/Release/${artifact}`, import.meta.url));
    assert.ok((await stat(path)).size > 0, `HOST_NATIVE_ARTIFACT_MISSING:${artifact}`);
  }
});

test("public surface exposes no FD, pointer, generation, endpoint, or arbitrary path", async () => {
  const [bridge, header, types, authority, issuer] = await Promise.all([
    read("../native/runtime_peer.c"),
    read("../native/runtime_peer_internal.h"),
    read("types.ts"),
    read("authority.ts"),
    read("issuer.ts")
  ]);
  const facade = `${types}\n${authority}\n${issuer}`;
  assert.match(header, /#define ZCC_SOCKET_PATH "\/run\/authority-runtime-trust\/authority\.sock"/);
  assert.equal((header.match(/#define ZCC_SOCKET_PATH/g) ?? []).length, 1);
  assert.doesNotMatch(facade, /\bfd\b|pointer|generation|socket\._handle|net\.Socket|socketPath|endpoint/);
  assert.doesNotMatch(bridge, /"(?:fd|pointer|generation|socketPath|endpoint)"/);
  assert.match(bridge, /argc != 0U/);
});

test("framed I/O is partial-operation safe and backpressure aware", async () => {
  const pump = await read("../native/runtime_peer_pump.c");
  const header = await read("../native/runtime_peer_internal.h");
  assert.match(header, /unsigned char prefix\[4\]/);
  assert.match(header, /size_t prefix_offset;/);
  assert.match(header, /size_t offset;/);
  assert.match(pump, /errno == EAGAIN \|\| errno == EWOULDBLOCK/);
  assert.match(pump, /frame_length == 0U \|\| frame_length > ZCC_MAX_FRAME/);
  assert.match(pump, /EPOLLIN/);
  assert.match(pump, /EPOLLOUT/);
  assert.match(pump, /MSG_NOSIGNAL/);
});

test("syscall and malformed-state failures close or reject without fallback", async () => {
  const pump = await read("../native/runtime_peer_pump.c");
  const failConnect = functionBody(pump, "zcc_fail_connect");
  const createListener = functionBody(pump, "zcc_process_create_listener");
  const accept = functionBody(pump, "zcc_process_accept");
  const readBody = functionBody(pump, "zcc_process_read");
  assert.match(failConnect, /close\(operation->result_fd\)/);
  assert.match(createListener, /close\(descriptor\)/);
  assert.ok(accept.indexOf("close(accepted)") < accept.indexOf("PEER_CREDENTIAL_UNAVAILABLE"));
  assert.match(readBody, /zcc_close_object_on_io\(connection, "PEER_CONNECTION_(?:CLOSED|INVALID)"\)/);
  assert.doesNotMatch(pump, /fallback|retryPath|alternatePath/i);
});

test("environment shutdown wakes, joins, and lets the I/O thread close owned descriptors", async () => {
  const pump = await read("../native/runtime_peer_pump.c");
  const cleanup = functionBody(pump, "zcc_runtime_cleanup");
  const thread = functionBody(pump, "zcc_io_thread_main");
  assert.ok(cleanup.indexOf("runtime->stop_requested = 1") < cleanup.indexOf("zcc_wake(runtime)"));
  assert.ok(cleanup.indexOf("zcc_wake(runtime)") < cleanup.indexOf("pthread_join(runtime->io_thread, NULL)"));
  assert.match(thread, /zcc_close_all_for_shutdown\(runtime\)/);
  assert.match(thread, /close\(runtime->control_fd\)/);
  assert.match(thread, /close\(runtime->epoll_fd\)/);
});
