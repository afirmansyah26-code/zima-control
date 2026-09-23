{
  "targets": [
    {
      "target_name": "application_runtime_native_peer",
      "sources": ["native/application_runtime_native_peer.c"],
      "defines": ["_GNU_SOURCE", "NAPI_VERSION=8"],
      "cflags": [
        "-std=c17",
        "-O2",
        "-pthread",
        "-fPIC",
        "-fvisibility=hidden",
        "-fstack-protector-strong",
        "-U_FORTIFY_SOURCE",
        "-D_FORTIFY_SOURCE=3",
        "-Wall",
        "-Wextra",
        "-Wpedantic",
        "-Werror",
        "-Wconversion",
        "-Wsign-conversion",
        "-Wformat=2",
        "-Wshadow",
        "-Wstrict-prototypes",
        "-Wmissing-prototypes"
      ],
      "ldflags": ["-pthread", "-Wl,-z,relro,-z,now,-z,noexecstack,--as-needed"],
      "conditions": [["OS!='linux'", {"type": "none"}]]
    }
  ]
}
