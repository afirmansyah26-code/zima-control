#ifndef APPLICATION_RUNTIME_NATIVE_PEER_H
#define APPLICATION_RUNTIME_NATIVE_PEER_H

#include <node_api.h>
#include <uv.h>
#include <stdint.h>
#include <stddef.h>

#if defined(__linux__)
#include <sys/socket.h>
#include <sys/un.h>
#include <sys/types.h>
#include <unistd.h>
#include <fcntl.h>
#include <errno.h>
#endif

#define SD_LISTEN_FDS_START 3
#define ZCC_PEER_MAGIC 0x5a434332U /* "ZCC2" */

#define MAX_REQUEST_FRAME_BYTES (64U * 1024U)     /* 65,536 bytes */
#define MAX_RESPONSE_FRAME_BYTES (1024U * 1024U)  /* 1,048,576 bytes */
#define FRAME_HEADER_BYTES 4U

#define APPROVED_CONTAINER_UID 1000U
#define APPROVED_CONTAINER_GID 1000U
#define APPROVED_HOST_UID 21020U
#define APPROVED_HOST_GID 21020U

typedef enum {
  ZCC_OBJ_LISTENER = 1,
  ZCC_OBJ_CONNECTION = 2
} zcc_obj_kind_t;

typedef struct {
  int64_t pid;
  uint32_t uid;
  uint32_t gid;
} zcc_peer_credentials_t;

typedef struct zcc_pending_accept {
  napi_deferred deferred;
  struct zcc_pending_accept *next;
} zcc_pending_accept_t;

typedef struct zcc_listener {
  uint32_t magic;
  zcc_obj_kind_t kind;
  int fd;
  int is_closed;
  uint32_t connection_count;
  uv_poll_t poll_handle;
  int poll_active;
  uv_loop_t *loop;
  napi_env env;
  zcc_pending_accept_t *pending_accept_head;
  zcc_pending_accept_t *pending_accept_tail;
  struct zcc_listener *next;
} zcc_listener_t;

typedef struct zcc_pending_read {
  struct zcc_connection *conn;
  napi_deferred deferred;
  uint32_t timeout_ms;
  uv_timer_t timer;
  int timer_active;
  uint8_t header_buf[4];
  size_t header_bytes_read;
  uint32_t expected_payload_len;
  uint8_t *payload_buf;
  size_t payload_bytes_read;
} zcc_pending_read_t;

typedef struct zcc_pending_write {
  napi_deferred deferred;
  uint8_t *buffer;
  size_t total_bytes;
  size_t bytes_written;
} zcc_pending_write_t;

typedef struct zcc_connection {
  uint32_t magic;
  zcc_obj_kind_t kind;
  int fd;
  int is_closed;
  char connection_id[64];
  zcc_peer_credentials_t credentials;
  uv_poll_t poll_handle;
  int poll_initialized;
  int poll_active;
  uv_loop_t *loop;
  napi_env env;
  zcc_listener_t *listener;
  zcc_pending_read_t *pending_read;
  zcc_pending_write_t *pending_write;
  struct zcc_connection *next;
} zcc_connection_t;

#endif /* APPLICATION_RUNTIME_NATIVE_PEER_H */
