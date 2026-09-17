{
  "targets": [
    {
      "target_name": "authority_peer",
      "sources": ["native/runtime_peer.c", "native/runtime_peer_pump.c"],
      "defines": ["_GNU_SOURCE", "NAPI_VERSION=8", "ZCC_AUTHORITY_ARTIFACT=1"],
      "cflags": ["-std=c17", "-O2", "-pthread", "-fPIC", "-fvisibility=hidden", "-fstack-protector-strong", "-U_FORTIFY_SOURCE", "-D_FORTIFY_SOURCE=3", "-Wall", "-Wextra", "-Wpedantic", "-Werror", "-Wconversion", "-Wsign-conversion", "-Wformat=2", "-Wshadow", "-Wstrict-prototypes", "-Wmissing-prototypes"],
      "ldflags": ["-pthread", "-Wl,-z,relro,-z,now,-z,noexecstack,--as-needed"],
      "conditions": [["OS!='linux'", {"type": "none"}]]
    },
    {
      "target_name": "issuer_peer",
      "sources": ["native/runtime_peer.c", "native/runtime_peer_pump.c"],
      "defines": ["_GNU_SOURCE", "NAPI_VERSION=8", "ZCC_ISSUER_ARTIFACT=1"],
      "cflags": ["-std=c17", "-O2", "-pthread", "-fPIC", "-fvisibility=hidden", "-fstack-protector-strong", "-U_FORTIFY_SOURCE", "-D_FORTIFY_SOURCE=3", "-Wall", "-Wextra", "-Wpedantic", "-Werror", "-Wconversion", "-Wsign-conversion", "-Wformat=2", "-Wshadow", "-Wstrict-prototypes", "-Wmissing-prototypes"],
      "ldflags": ["-pthread", "-Wl,-z,relro,-z,now,-z,noexecstack,--as-needed"],
      "conditions": [["OS!='linux'", {"type": "none"}]]
    }
  ]
}
