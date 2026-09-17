#ifndef ZCC_RUNTIME_PEER_INTERNAL_H
#define ZCC_RUNTIME_PEER_INTERNAL_H

#ifndef _GNU_SOURCE
#define _GNU_SOURCE
#endif

#include <node_api.h>
#include <pthread.h>
#include <stdint.h>
#include <stddef.h>
#include <sys/socket.h>

#if defined(ZCC_AUTHORITY_ARTIFACT) == defined(ZCC_ISSUER_ARTIFACT)
#error "exactly one runtime peer artifact role must be selected"
#endif

#define ZCC_SOCKET_PATH "/run/authority-runtime-trust/authority.sock"
#define ZCC_MAX_FRAME 16384U
#define ZCC_BACKLOG 16
#define ZCC_MAGIC 0x5a434350U
#define ZCC_CONNECT_TIMEOUT_MS 5000
#define ZCC_COMMAND_CAPACITY 64U
#define ZCC_COMPLETION_CAPACITY 128U
#define ZCC_OUTSTANDING_CAPACITY 48U

#if defined(ZCC_AUTHORITY_ARTIFACT)
#define ZCC_MAX_CONNECTIONS 16U
#else
#define ZCC_MAX_CONNECTIONS 1U
#endif

typedef enum {
  ZCC_TARGET_CONTROL = 1,
  ZCC_TARGET_OBJECT = 2,
  ZCC_TARGET_CONNECT = 3
} zcc_target_kind;

typedef enum {
  ZCC_OBJECT_LISTENER = 1,
  ZCC_OBJECT_CONNECTION = 2
} zcc_object_kind;

typedef enum {
  ZCC_STATE_OPEN = 1,
  ZCC_STATE_CLOSING = 2,
  ZCC_STATE_CLOSED = 3
} zcc_object_state;

typedef enum {
  ZCC_COMMAND_CREATE_LISTENER = 1,
  ZCC_COMMAND_ACCEPT = 2,
  ZCC_COMMAND_CONNECT = 3,
  ZCC_COMMAND_READ = 4,
  ZCC_COMMAND_WRITE = 5,
  ZCC_COMMAND_CLOSE = 6
} zcc_command_kind;

typedef struct zcc_event_target {
  zcc_target_kind kind;
} zcc_event_target;

typedef struct zcc_runtime zcc_runtime;
typedef struct zcc_native_object zcc_native_object;
typedef struct zcc_operation zcc_operation;

struct zcc_operation {
  zcc_event_target target;
  zcc_command_kind kind;
  zcc_runtime *runtime;
  zcc_native_object *owner;
  uint64_t owner_generation;
  napi_deferred deferred;
  napi_ref owner_ref;
  int has_promise;
  int completed;
  int completion_queued;
  int result_fd;
  struct ucred credentials;
  unsigned char prefix[4];
  size_t prefix_offset;
  unsigned char *bytes;
  size_t length;
  size_t offset;
  int64_t deadline_ns;
  char code[40];
  zcc_native_object *result_object;
  zcc_operation *command_next;
};

struct zcc_native_object {
  zcc_event_target target;
  uint32_t magic;
  zcc_object_kind kind;
  zcc_object_state state;
  napi_env env;
  zcc_runtime *runtime;
  int fd;
  uint64_t generation;
  int accepts_commands;
  int epoll_registered;
  int finalized;
  int cleanup_owned;
  struct ucred credentials;
  int accept_admitted;
  int read_admitted;
  int write_admitted;
  zcc_operation *pending_accept;
  zcc_operation *pending_read;
  zcc_operation *pending_write;
  zcc_native_object *registry_next;
};

struct zcc_runtime {
  napi_env env;
  pthread_mutex_t mutex;
  pthread_t io_thread;
  zcc_event_target control_target;
  int epoll_fd;
  int control_fd;
  int initialized;
  int thread_started;
  int stop_requested;
  int thread_exited;
  uint64_t next_generation;
  unsigned int live_connections;
  zcc_native_object *registry_head;
  zcc_operation *command_head;
  zcc_operation *command_tail;
  unsigned int queued_commands;
  unsigned int outstanding_operations;
  zcc_operation *pending_connect;
  napi_threadsafe_function completion_tsfn;
};

extern zcc_runtime zcc_process_runtime;

void zcc_set_code(zcc_operation *operation, const char *code);
int zcc_runtime_start(zcc_runtime *runtime);
void zcc_runtime_cleanup(void *data);
int zcc_enqueue(zcc_runtime *runtime, zcc_operation *operation);
void zcc_request_close(zcc_native_object *object, int finalized);
void zcc_complete_on_js(napi_env env, napi_value callback, void *context, void *data);

#endif
