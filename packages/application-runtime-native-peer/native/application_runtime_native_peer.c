#ifndef _GNU_SOURCE
#define _GNU_SOURCE 1
#endif
#include "application_runtime_native_peer.h"

#include <stdlib.h>
#include <string.h>
#include <stdio.h>
#include <inttypes.h>

static uint64_t g_connection_seq = 1;
static zcc_listener_t *g_listener_head = NULL;
static zcc_connection_t *g_connection_head = NULL;

/* ------------------------------------------------------------------------- */
/* Error Helpers                                                             */
/* ------------------------------------------------------------------------- */

static napi_value zcc_create_error(napi_env env, const char *code, const char *message) {
  napi_value msg_val;
  napi_value err_val;
  napi_value code_val;

  if (napi_create_string_utf8(env, message ? message : code, NAPI_AUTO_LENGTH, &msg_val) != napi_ok ||
      napi_create_error(env, NULL, msg_val, &err_val) != napi_ok ||
      napi_create_string_utf8(env, code, NAPI_AUTO_LENGTH, &code_val) != napi_ok ||
      napi_set_named_property(env, err_val, "code", code_val) != napi_ok) {
    return NULL;
  }
  return err_val;
}

static void zcc_throw_error(napi_env env, const char *code, const char *message) {
  napi_value err = zcc_create_error(env, code, message);
  if (err != NULL) {
    (void)napi_throw(env, err);
  }
}

static void zcc_reject_deferred(napi_env env, napi_deferred deferred, const char *code, const char *message) {
  napi_value err = zcc_create_error(env, code, message);
  if (err != NULL) {
    (void)napi_reject_deferred(env, deferred, err);
  }
}

/* ------------------------------------------------------------------------- */
/* Type Unwrapping & Validation                                              */
/* ------------------------------------------------------------------------- */

static zcc_listener_t *zcc_unwrap_listener(napi_env env, napi_value val) {
  zcc_listener_t *listener = NULL;
  if (napi_unwrap(env, val, (void **)&listener) != napi_ok ||
      listener == NULL ||
      listener->magic != ZCC_PEER_MAGIC ||
      listener->kind != ZCC_OBJ_LISTENER) {
    return NULL;
  }
  return listener;
}

static zcc_connection_t *zcc_unwrap_connection(napi_env env, napi_value val) {
  zcc_connection_t *conn = NULL;
  if (napi_unwrap(env, val, (void **)&conn) != napi_ok ||
      conn == NULL ||
      conn->magic != ZCC_PEER_MAGIC ||
      conn->kind != ZCC_OBJ_CONNECTION) {
    return NULL;
  }
  return conn;
}

/* ------------------------------------------------------------------------- */
/* Finalizers & Forward Declarations                                         */
/* ------------------------------------------------------------------------- */

static void zcc_internal_close_connection(zcc_connection_t *conn);
static void zcc_internal_close_listener(zcc_listener_t *listener);

static void zcc_listener_finalize(napi_env env, void *data, void *hint) {
  (void)hint;
  zcc_listener_t *listener = (zcc_listener_t *)data;
  if (listener != NULL) {
    napi_handle_scope scope;
    if (napi_open_handle_scope(env, &scope) == napi_ok) {
      zcc_internal_close_listener(listener);
      napi_close_handle_scope(env, scope);
    } else {
      zcc_internal_close_listener(listener);
    }
  }
}

static void zcc_connection_finalize(napi_env env, void *data, void *hint) {
  (void)hint;
  zcc_connection_t *conn = (zcc_connection_t *)data;
  if (conn != NULL) {
    napi_handle_scope scope;
    if (napi_open_handle_scope(env, &scope) == napi_ok) {
      zcc_internal_close_connection(conn);
      napi_close_handle_scope(env, scope);
    } else {
      zcc_internal_close_connection(conn);
    }
  }
}

/* ------------------------------------------------------------------------- */
/* Lifecycle & Cleanup                                                       */
/* ------------------------------------------------------------------------- */

static void zcc_on_uv_handle_closed(uv_handle_t *handle) {
  (void)handle;
}

static void zcc_internal_close_connection(zcc_connection_t *conn) {
  if (conn == NULL || conn->is_closed) return;
  conn->is_closed = 1;

  if (conn->pending_read != NULL) {
    zcc_pending_read_t *pr = conn->pending_read;
    if (pr->timer_active) {
      uv_timer_stop(&pr->timer);
      uv_close((uv_handle_t *)&pr->timer, zcc_on_uv_handle_closed);
      pr->timer_active = 0;
    }
    if (pr->payload_buf != NULL) {
      free(pr->payload_buf);
      pr->payload_buf = NULL;
    }
    zcc_reject_deferred(conn->env, pr->deferred, "PEER_CONNECTION_CLOSED", "Connection closed during read");
    free(pr);
    conn->pending_read = NULL;
  }

  if (conn->pending_write != NULL) {
    zcc_pending_write_t *pw = conn->pending_write;
    if (pw->buffer != NULL) {
      free(pw->buffer);
      pw->buffer = NULL;
    }
    zcc_reject_deferred(conn->env, pw->deferred, "PEER_CONNECTION_CLOSED", "Connection closed during write");
    free(pw);
    conn->pending_write = NULL;
  }

  if (conn->poll_active) {
    uv_poll_stop(&conn->poll_handle);
    uv_close((uv_handle_t *)&conn->poll_handle, zcc_on_uv_handle_closed);
    conn->poll_active = 0;
  }

#if defined(__linux__)
  if (conn->fd >= 0) {
    close(conn->fd);
    conn->fd = -1;
  }
#endif

  if (conn->listener != NULL && conn->listener->connection_count > 0) {
    conn->listener->connection_count--;
  }
}

static void zcc_internal_close_listener(zcc_listener_t *listener) {
  if (listener == NULL || listener->is_closed) return;
  listener->is_closed = 1;

  while (listener->pending_accept_head != NULL) {
    zcc_pending_accept_t *next = listener->pending_accept_head->next;
    zcc_reject_deferred(listener->env, listener->pending_accept_head->deferred,
                        "PEER_CONNECTION_CLOSED", "Listener closed before accept");
    free(listener->pending_accept_head);
    listener->pending_accept_head = next;
  }
  listener->pending_accept_tail = NULL;

  if (listener->poll_active) {
    uv_poll_stop(&listener->poll_handle);
    uv_close((uv_handle_t *)&listener->poll_handle, zcc_on_uv_handle_closed);
    listener->poll_active = 0;
  }

#if defined(__linux__)
  if (listener->fd >= 0) {
    /* Close ONLY the adopted descriptor (FD 3). NEVER unlink pathname. */
    close(listener->fd);
    listener->fd = -1;
  }
#endif
}

/* ------------------------------------------------------------------------- */
/* Connection Object Builder                                                 */
/* ------------------------------------------------------------------------- */

static napi_value zcc_build_connection_handle(
  napi_env env,
  zcc_listener_t *listener,
  int client_fd,
  const zcc_peer_credentials_t *creds
) {
  zcc_connection_t *conn = (zcc_connection_t *)calloc(1, sizeof(zcc_connection_t));
  if (conn == NULL) {
#if defined(__linux__)
    close(client_fd);
#else
    (void)client_fd;
#endif
    return NULL;
  }

  conn->magic = ZCC_PEER_MAGIC;
  conn->kind = ZCC_OBJ_CONNECTION;
  conn->fd = client_fd;
  conn->is_closed = 0;
  conn->credentials = *creds;
  conn->loop = listener->loop;
  conn->env = env;
  conn->listener = listener;

  (void)snprintf(conn->connection_id, sizeof(conn->connection_id), "zcc-conn-%" PRIu64, g_connection_seq++);

  /* Add to global connection list */
  conn->next = g_connection_head;
  g_connection_head = conn;

  listener->connection_count++;

  napi_value js_conn;
  if (napi_create_object(env, &js_conn) != napi_ok) {
    zcc_internal_close_connection(conn);
    return NULL;
  }

  napi_value conn_id_val;
  if (napi_create_string_utf8(env, conn->connection_id, NAPI_AUTO_LENGTH, &conn_id_val) != napi_ok ||
      napi_set_named_property(env, js_conn, "connectionId", conn_id_val) != napi_ok) {
    zcc_internal_close_connection(conn);
    return NULL;
  }

  napi_value creds_obj;
  if (napi_create_object(env, &creds_obj) != napi_ok) {
    zcc_internal_close_connection(conn);
    return NULL;
  }

  napi_value pid_v, uid_v, gid_v;
  if (napi_create_int64(env, creds->pid, &pid_v) != napi_ok ||
      napi_create_uint32(env, creds->uid, &uid_v) != napi_ok ||
      napi_create_uint32(env, creds->gid, &gid_v) != napi_ok ||
      napi_set_named_property(env, creds_obj, "pid", pid_v) != napi_ok ||
      napi_set_named_property(env, creds_obj, "uid", uid_v) != napi_ok ||
      napi_set_named_property(env, creds_obj, "gid", gid_v) != napi_ok ||
      napi_object_freeze(env, creds_obj) != napi_ok ||
      napi_set_named_property(env, js_conn, "peerCredentials", creds_obj) != napi_ok) {
    zcc_internal_close_connection(conn);
    return NULL;
  }

  /* Wrap native pointer into JS object (no raw FD exposed) */
  if (napi_wrap(env, js_conn, conn, zcc_connection_finalize, NULL, NULL) != napi_ok ||
      napi_object_freeze(env, js_conn) != napi_ok) {
    zcc_internal_close_connection(conn);
    return NULL;
  }

  return js_conn;
}

/* ------------------------------------------------------------------------- */
/* Accept & SO_PEERCRED Processing                                           */
/* ------------------------------------------------------------------------- */

static int zcc_try_accept_peer(
  zcc_listener_t *listener,
  int *out_client_fd,
  zcc_peer_credentials_t *out_creds,
  const char **out_err_code
) {
#if defined(__linux__)
  *out_err_code = NULL;
  int client_fd = accept4(listener->fd, NULL, NULL, SOCK_CLOEXEC | SOCK_NONBLOCK);
  if (client_fd < 0) {
    if (errno == EAGAIN || errno == EWOULDBLOCK) {
      return 0; /* Need to poll */
    }
    *out_err_code = "PEER_CONNECTION_CLOSED";
    return -1;
  }

  /* Call getsockopt(SOL_SOCKET, SO_PEERCRED, ...) immediately after accept4() */
  struct ucred ucred;
  socklen_t ucred_len = sizeof(ucred);
  memset(&ucred, 0, sizeof(ucred));
  if (getsockopt(client_fd, SOL_SOCKET, SO_PEERCRED, &ucred, &ucred_len) != 0) {
    close(client_fd);
    *out_err_code = "PEER_UNAUTHORIZED";
    return -1;
  }

  /*
   * Approved Principal Matrix:
   * 1. Container Principal: UID 1000 / GID 1000
   * 2. Host Principal:      UID 21020 / GID 21020
   */
  int is_container = (ucred.uid == APPROVED_CONTAINER_UID && ucred.gid == APPROVED_CONTAINER_GID);
  int is_host = (ucred.uid == APPROVED_HOST_UID && ucred.gid == APPROVED_HOST_GID);

  if (!is_container && !is_host) {
    /* Reject all other effective identities immediately. Zero application bytes. */
    close(client_fd);
    *out_err_code = "PEER_UNAUTHORIZED";
    return -1;
  }

  out_creds->pid = (int64_t)ucred.pid;
  out_creds->uid = (uint32_t)ucred.uid;
  out_creds->gid = (uint32_t)ucred.gid;
  *out_client_fd = client_fd;
  return 1;
#else
  (void)listener;
  (void)out_client_fd;
  (void)out_creds;
  *out_err_code = "PEER_PLATFORM_UNSUPPORTED";
  return -1;
#endif
}

static void zcc_process_pending_accepts(zcc_listener_t *listener) {
  while (listener->pending_accept_head != NULL) {
    int client_fd = -1;
    zcc_peer_credentials_t creds;
    const char *err_code = NULL;

    int rc = zcc_try_accept_peer(listener, &client_fd, &creds, &err_code);
    if (rc == 0) {
      /* Socket is not readable right now, keep polling */
      break;
    }

    zcc_pending_accept_t *head = listener->pending_accept_head;
    listener->pending_accept_head = head->next;
    if (listener->pending_accept_head == NULL) {
      listener->pending_accept_tail = NULL;
    }

    if (rc < 0) {
      zcc_reject_deferred(listener->env, head->deferred,
                          err_code ? err_code : "PEER_UNAUTHORIZED",
                          "Connection acceptance rejected");
      free(head);
      continue;
    }

    napi_value js_conn = zcc_build_connection_handle(listener->env, listener, client_fd, &creds);
    if (js_conn == NULL) {
      zcc_reject_deferred(listener->env, head->deferred, "INTERNAL_ADAPTER_ERROR", "Failed to construct connection");
    } else {
      (void)napi_resolve_deferred(listener->env, head->deferred, js_conn);
    }
    free(head);
  }

  if (listener->pending_accept_head == NULL && listener->poll_active) {
    uv_poll_stop(&listener->poll_handle);
    listener->poll_active = 0;
  }
}

static void zcc_listener_poll_cb(uv_poll_t *handle, int status, int events) {
  (void)events;
  zcc_listener_t *listener = (zcc_listener_t *)handle->data;
  if (listener == NULL || listener->is_closed) return;

  napi_handle_scope scope;
  if (napi_open_handle_scope(listener->env, &scope) != napi_ok) return;

  if (status < 0) {
    /* Poll error */
    while (listener->pending_accept_head != NULL) {
      zcc_pending_accept_t *head = listener->pending_accept_head;
      listener->pending_accept_head = head->next;
      zcc_reject_deferred(listener->env, head->deferred, "PEER_CONNECTION_CLOSED", "Listener poll error");
      free(head);
    }
    listener->pending_accept_tail = NULL;
    uv_poll_stop(&listener->poll_handle);
    listener->poll_active = 0;
    napi_close_handle_scope(listener->env, scope);
    return;
  }

  zcc_process_pending_accepts(listener);
  napi_close_handle_scope(listener->env, scope);
}

/* ------------------------------------------------------------------------- */
/* Framing Read Operations                                                   */
/* ------------------------------------------------------------------------- */

static void zcc_read_timeout_cb(uv_timer_t *timer) {
  zcc_connection_t *conn = (zcc_connection_t *)timer->data;
  if (conn == NULL || conn->is_closed || conn->pending_read == NULL) return;

  napi_handle_scope scope;
  if (napi_open_handle_scope(conn->env, &scope) != napi_ok) return;

  zcc_pending_read_t *pr = conn->pending_read;
  conn->pending_read = NULL;

  if (conn->poll_active) {
    uv_poll_stop(&conn->poll_handle);
    conn->poll_active = 0;
  }

  uv_timer_stop(&pr->timer);
  uv_close((uv_handle_t *)&pr->timer, zcc_on_uv_handle_closed);
  pr->timer_active = 0;

  if (pr->payload_buf != NULL) {
    free(pr->payload_buf);
    pr->payload_buf = NULL;
  }

  /* Fail-closed: close descriptor on timeout */
#if defined(__linux__)
  if (conn->fd >= 0) {
    close(conn->fd);
    conn->fd = -1;
  }
#endif
  conn->is_closed = 1;

  zcc_reject_deferred(conn->env, pr->deferred, "REQUEST_DEADLINE_EXCEEDED", "Read request deadline exceeded");
  free(pr);
  napi_close_handle_scope(conn->env, scope);
}

static void zcc_connection_read_poll_cb(uv_poll_t *handle, int status, int events) {
  (void)events;
  zcc_connection_t *conn = (zcc_connection_t *)handle->data;
  if (conn == NULL || conn->is_closed || conn->pending_read == NULL) return;

  napi_handle_scope scope;
  if (napi_open_handle_scope(conn->env, &scope) != napi_ok) return;

  zcc_pending_read_t *pr = conn->pending_read;

  if (status < 0) {
    conn->pending_read = NULL;
    if (pr->timer_active) {
      uv_timer_stop(&pr->timer);
      uv_close((uv_handle_t *)&pr->timer, zcc_on_uv_handle_closed);
      pr->timer_active = 0;
    }
    uv_poll_stop(&conn->poll_handle);
    conn->poll_active = 0;
    if (pr->payload_buf) free(pr->payload_buf);
    zcc_internal_close_connection(conn);
    zcc_reject_deferred(conn->env, pr->deferred, "PEER_CONNECTION_CLOSED", "Connection error during read");
    free(pr);
    napi_close_handle_scope(conn->env, scope);
    return;
  }

#if defined(__linux__)
  /* 1. Read 4-byte header if not complete */
  while (pr->header_bytes_read < FRAME_HEADER_BYTES) {
    ssize_t n = read(conn->fd, pr->header_buf + pr->header_bytes_read,
                     FRAME_HEADER_BYTES - pr->header_bytes_read);
    if (n < 0) {
      if (errno == EAGAIN || errno == EWOULDBLOCK) {
        napi_close_handle_scope(conn->env, scope);
        return;
      }
      goto fail_read;
    }
    if (n == 0) goto fail_eof;
    pr->header_bytes_read += (size_t)n;
  }

  /* 2. Decode header */
  if (pr->expected_payload_len == 0 && pr->payload_buf == NULL) {
    uint32_t len = ((uint32_t)pr->header_buf[0] << 24) |
                   ((uint32_t)pr->header_buf[1] << 16) |
                   ((uint32_t)pr->header_buf[2] << 8)  |
                   ((uint32_t)pr->header_buf[3]);

    if (len == 0 || len > MAX_REQUEST_FRAME_BYTES) {
      /* Malformed frame or frame exceeds 64KB */
      conn->pending_read = NULL;
      if (pr->timer_active) {
        uv_timer_stop(&pr->timer);
        uv_close((uv_handle_t *)&pr->timer, zcc_on_uv_handle_closed);
        pr->timer_active = 0;
      }
      uv_poll_stop(&conn->poll_handle);
      conn->poll_active = 0;
      zcc_internal_close_connection(conn);
      zcc_reject_deferred(conn->env, pr->deferred, "MALFORMED_REQUEST", "Frame length invalid or exceeds 64KB");
      free(pr);
      napi_close_handle_scope(conn->env, scope);
      return;
    }

    pr->expected_payload_len = len;
    pr->payload_buf = (uint8_t *)malloc(len);
    if (pr->payload_buf == NULL) {
      conn->pending_read = NULL;
      if (pr->timer_active) {
        uv_timer_stop(&pr->timer);
        uv_close((uv_handle_t *)&pr->timer, zcc_on_uv_handle_closed);
        pr->timer_active = 0;
      }
      uv_poll_stop(&conn->poll_handle);
      conn->poll_active = 0;
      zcc_internal_close_connection(conn);
      zcc_reject_deferred(conn->env, pr->deferred, "INTERNAL_ADAPTER_ERROR", "Allocation failed");
      free(pr);
      napi_close_handle_scope(conn->env, scope);
      return;
    }
    pr->payload_bytes_read = 0;
  }

  /* 3. Read payload */
  while (pr->payload_bytes_read < pr->expected_payload_len) {
    ssize_t n = read(conn->fd, pr->payload_buf + pr->payload_bytes_read,
                     pr->expected_payload_len - pr->payload_bytes_read);
    if (n < 0) {
      if (errno == EAGAIN || errno == EWOULDBLOCK) {
        napi_close_handle_scope(conn->env, scope);
        return;
      }
      goto fail_read;
    }
    if (n == 0) goto fail_eof;
    pr->payload_bytes_read += (size_t)n;
  }

  /* 4. Complete payload received */
  conn->pending_read = NULL;
  if (pr->timer_active) {
    uv_timer_stop(&pr->timer);
    uv_close((uv_handle_t *)&pr->timer, zcc_on_uv_handle_closed);
    pr->timer_active = 0;
  }
  uv_poll_stop(&conn->poll_handle);
  conn->poll_active = 0;

  napi_value js_buf;
  void *dst = NULL;
  if (napi_create_buffer_copy(conn->env, pr->expected_payload_len, pr->payload_buf, &dst, &js_buf) != napi_ok) {
    zcc_internal_close_connection(conn);
    zcc_reject_deferred(conn->env, pr->deferred, "INTERNAL_ADAPTER_ERROR", "Failed to allocate Buffer copy");
  } else {
    (void)napi_resolve_deferred(conn->env, pr->deferred, js_buf);
  }

  free(pr->payload_buf);
  free(pr);
  napi_close_handle_scope(conn->env, scope);
  return;

fail_eof:
fail_read:
  conn->pending_read = NULL;
  if (pr->timer_active) {
    uv_timer_stop(&pr->timer);
    uv_close((uv_handle_t *)&pr->timer, zcc_on_uv_handle_closed);
    pr->timer_active = 0;
  }
  uv_poll_stop(&conn->poll_handle);
  conn->poll_active = 0;
  if (pr->payload_buf) free(pr->payload_buf);
  zcc_internal_close_connection(conn);
  zcc_reject_deferred(conn->env, pr->deferred, "PEER_CONNECTION_CLOSED", "Connection closed during frame read");
  free(pr);
  napi_close_handle_scope(conn->env, scope);
#else
  napi_close_handle_scope(conn->env, scope);
#endif
}

/* ------------------------------------------------------------------------- */
/* Framing Write Operations                                                  */
/* ------------------------------------------------------------------------- */

static void zcc_connection_write_poll_cb(uv_poll_t *handle, int status, int events) {
  (void)events;
  zcc_connection_t *conn = (zcc_connection_t *)handle->data;
  if (conn == NULL || conn->is_closed || conn->pending_write == NULL) return;

  napi_handle_scope scope;
  if (napi_open_handle_scope(conn->env, &scope) != napi_ok) return;

  zcc_pending_write_t *pw = conn->pending_write;

  if (status < 0) {
    conn->pending_write = NULL;
    uv_poll_stop(&conn->poll_handle);
    conn->poll_active = 0;
    if (pw->buffer) free(pw->buffer);
    zcc_internal_close_connection(conn);
    zcc_reject_deferred(conn->env, pw->deferred, "PEER_CONNECTION_CLOSED", "Connection error during write");
    free(pw);
    napi_close_handle_scope(conn->env, scope);
    return;
  }

#if defined(__linux__)
  while (pw->bytes_written < pw->total_bytes) {
    ssize_t n = write(conn->fd, pw->buffer + pw->bytes_written, pw->total_bytes - pw->bytes_written);
    if (n < 0) {
      if (errno == EAGAIN || errno == EWOULDBLOCK) {
        napi_close_handle_scope(conn->env, scope);
        return;
      }
      conn->pending_write = NULL;
      uv_poll_stop(&conn->poll_handle);
      conn->poll_active = 0;
      if (pw->buffer) free(pw->buffer);
      zcc_internal_close_connection(conn);
      zcc_reject_deferred(conn->env, pw->deferred, "PEER_CONNECTION_CLOSED", "Write failed");
      free(pw);
      napi_close_handle_scope(conn->env, scope);
      return;
    }
    pw->bytes_written += (size_t)n;
  }

  /* All bytes written! One-request-per-connection: close descriptor on completion */
  conn->pending_write = NULL;
  uv_poll_stop(&conn->poll_handle);
  conn->poll_active = 0;
  free(pw->buffer);

  napi_value undefined_val;
  (void)napi_get_undefined(conn->env, &undefined_val);
  (void)napi_resolve_deferred(conn->env, pw->deferred, undefined_val);
  free(pw);

  zcc_internal_close_connection(conn);
  napi_close_handle_scope(conn->env, scope);
#else
  napi_close_handle_scope(conn->env, scope);
#endif
}

/* ------------------------------------------------------------------------- */
/* JS Exported Functions                                                     */
/* ------------------------------------------------------------------------- */

/*
 * adoptSystemdListener(): NativeListenerHandle
 */
static napi_value zcc_js_adopt_systemd_listener(napi_env env, napi_callback_info info) {
  (void)info;

#if !defined(__linux__)
  zcc_throw_error(env, "PEER_PLATFORM_UNSUPPORTED", "Linux platform required for systemd socket adoption");
  return NULL;
#else
  /* 1. LISTEN_PID invariant */
  const char *listen_pid_str = getenv("LISTEN_PID");
  if (listen_pid_str == NULL || atoi(listen_pid_str) != (int)getpid()) {
    zcc_throw_error(env, "MISSING_SYSTEMD_SOCKET", "LISTEN_PID missing or mismatched");
    return NULL;
  }

  /* 2. LISTEN_FDS invariant */
  const char *listen_fds_str = getenv("LISTEN_FDS");
  if (listen_fds_str == NULL) {
    zcc_throw_error(env, "MISSING_SYSTEMD_SOCKET", "LISTEN_FDS missing");
    return NULL;
  }
  int listen_fds = atoi(listen_fds_str);
  if (listen_fds == 0) {
    zcc_throw_error(env, "MISSING_SYSTEMD_SOCKET", "LISTEN_FDS is 0");
    return NULL;
  }
  if (listen_fds > 1) {
    zcc_throw_error(env, "UNEXPECTED_SYSTEMD_DESCRIPTOR_TOPOLOGY", "LISTEN_FDS > 1");
    return NULL;
  }
  if (listen_fds != 1) {
    zcc_throw_error(env, "MISSING_SYSTEMD_SOCKET", "LISTEN_FDS is not 1");
    return NULL;
  }

  /* 3. Validate FD 3 is AF_UNIX and SOCK_STREAM */
  struct sockaddr_storage addr;
  socklen_t addr_len = sizeof(addr);
  memset(&addr, 0, sizeof(addr));
  if (getsockname(SD_LISTEN_FDS_START, (struct sockaddr *)&addr, &addr_len) != 0) {
    zcc_throw_error(env, "INVALID_SYSTEMD_SOCKET_TYPE", "getsockname failed on FD 3");
    return NULL;
  }
  if (addr.ss_family != AF_UNIX) {
    zcc_throw_error(env, "INVALID_SYSTEMD_SOCKET_TYPE", "FD 3 socket family is not AF_UNIX");
    return NULL;
  }

  int sock_type = 0;
  socklen_t opt_len = sizeof(sock_type);
  if (getsockopt(SD_LISTEN_FDS_START, SOL_SOCKET, SO_TYPE, &sock_type, &opt_len) != 0) {
    zcc_throw_error(env, "INVALID_SYSTEMD_SOCKET_TYPE", "getsockopt SO_TYPE failed on FD 3");
    return NULL;
  }
  if (sock_type != SOCK_STREAM) {
    zcc_throw_error(env, "INVALID_SYSTEMD_SOCKET_TYPE", "FD 3 socket type is not SOCK_STREAM");
    return NULL;
  }

  /* 4. Enforce descriptor flags (FD_CLOEXEC & O_NONBLOCK) */
  int flags = fcntl(SD_LISTEN_FDS_START, F_GETFD, 0);
  if (flags >= 0) {
    (void)fcntl(SD_LISTEN_FDS_START, F_SETFD, flags | FD_CLOEXEC);
  }
  int fl = fcntl(SD_LISTEN_FDS_START, F_GETFL, 0);
  if (fl >= 0) {
    (void)fcntl(SD_LISTEN_FDS_START, F_SETFL, fl | O_NONBLOCK);
  }

  /* 5. Get libuv loop */
  uv_loop_t *loop = NULL;
  if (napi_get_uv_event_loop(env, &loop) != napi_ok || loop == NULL) {
    zcc_throw_error(env, "INTERNAL_ADAPTER_ERROR", "Failed to acquire libuv event loop");
    return NULL;
  }

  /* 6. Allocate listener */
  zcc_listener_t *listener = (zcc_listener_t *)calloc(1, sizeof(zcc_listener_t));
  if (listener == NULL) {
    zcc_throw_error(env, "INTERNAL_ADAPTER_ERROR", "Memory allocation failed");
    return NULL;
  }

  listener->magic = ZCC_PEER_MAGIC;
  listener->kind = ZCC_OBJ_LISTENER;
  listener->fd = SD_LISTEN_FDS_START;
  listener->is_closed = 0;
  listener->connection_count = 0;
  listener->loop = loop;
  listener->env = env;

  if (uv_poll_init(loop, &listener->poll_handle, SD_LISTEN_FDS_START) != 0) {
    free(listener);
    zcc_throw_error(env, "INTERNAL_ADAPTER_ERROR", "Failed to init libuv poll on FD 3");
    return NULL;
  }
  listener->poll_handle.data = listener;

  listener->next = g_listener_head;
  g_listener_head = listener;

  /* 7. Wrap into JS NativeListenerHandle */
  napi_value js_listener;
  if (napi_create_object(env, &js_listener) != napi_ok) {
    zcc_internal_close_listener(listener);
    zcc_throw_error(env, "INTERNAL_ADAPTER_ERROR", "Failed to create JS listener object");
    return NULL;
  }

  napi_value zero_val;
  if (napi_create_uint32(env, 0, &zero_val) != napi_ok ||
      napi_set_named_property(env, js_listener, "connectionCount", zero_val) != napi_ok ||
      napi_wrap(env, js_listener, listener, zcc_listener_finalize, NULL, NULL) != napi_ok ||
      napi_object_freeze(env, js_listener) != napi_ok) {
    zcc_internal_close_listener(listener);
    zcc_throw_error(env, "INTERNAL_ADAPTER_ERROR", "Failed to finalize listener handle");
    return NULL;
  }

  return js_listener;
#endif
}

/*
 * acceptConnection(listener: NativeListenerHandle): Promise<NativeConnectionHandle>
 */
static napi_value zcc_js_accept_connection(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value args[1];
  if (napi_get_cb_info(env, info, &argc, args, NULL, NULL) != napi_ok || argc < 1) {
    napi_deferred deferred;
    napi_value promise;
    if (napi_create_promise(env, &deferred, &promise) == napi_ok) {
      zcc_reject_deferred(env, deferred, "PEER_CONNECTION_INVALID", "Missing listener argument");
      return promise;
    }
    return NULL;
  }

  zcc_listener_t *listener = zcc_unwrap_listener(env, args[0]);
  napi_deferred deferred;
  napi_value promise;
  if (napi_create_promise(env, &deferred, &promise) != napi_ok) {
    return NULL;
  }

  if (listener == NULL) {
    zcc_reject_deferred(env, deferred, "PEER_CONNECTION_INVALID", "Invalid listener handle");
    return promise;
  }
  if (listener->is_closed) {
    zcc_reject_deferred(env, deferred, "PEER_CONNECTION_CLOSED", "Listener is closed");
    return promise;
  }

  /* Attempt immediate non-blocking accept */
  int client_fd = -1;
  zcc_peer_credentials_t creds;
  const char *err_code = NULL;
  int rc = zcc_try_accept_peer(listener, &client_fd, &creds, &err_code);

  if (rc > 0) {
    /* Accepted and verified immediately */
    napi_value js_conn = zcc_build_connection_handle(env, listener, client_fd, &creds);
    if (js_conn == NULL) {
      zcc_reject_deferred(env, deferred, "INTERNAL_ADAPTER_ERROR", "Failed to build connection");
    } else {
      (void)napi_resolve_deferred(env, deferred, js_conn);
    }
    return promise;
  }

  if (rc < 0) {
    /* Rejected */
    zcc_reject_deferred(env, deferred, err_code ? err_code : "PEER_UNAUTHORIZED", "Peer connection rejected");
    return promise;
  }

  /* rc == 0: Needs to poll */
  zcc_pending_accept_t *pa = (zcc_pending_accept_t *)calloc(1, sizeof(zcc_pending_accept_t));
  if (pa == NULL) {
    zcc_reject_deferred(env, deferred, "INTERNAL_ADAPTER_ERROR", "Allocation failed");
    return promise;
  }
  pa->deferred = deferred;
  pa->next = NULL;

  if (listener->pending_accept_tail == NULL) {
    listener->pending_accept_head = pa;
    listener->pending_accept_tail = pa;
  } else {
    listener->pending_accept_tail->next = pa;
    listener->pending_accept_tail = pa;
  }

  if (!listener->poll_active) {
    if (uv_poll_start(&listener->poll_handle, UV_READABLE, zcc_listener_poll_cb) == 0) {
      listener->poll_active = 1;
    } else {
      listener->pending_accept_head = NULL;
      listener->pending_accept_tail = NULL;
      zcc_reject_deferred(env, deferred, "INTERNAL_ADAPTER_ERROR", "Failed to start poll on FD 3");
      free(pa);
    }
  }

  return promise;
}

/*
 * readRequestFrame(conn: NativeConnectionHandle, timeoutMs: number): Promise<Buffer>
 */
static napi_value zcc_js_read_request_frame(napi_env env, napi_callback_info info) {
  size_t argc = 2;
  napi_value args[2];
  napi_deferred deferred;
  napi_value promise;

  if (napi_create_promise(env, &deferred, &promise) != napi_ok) {
    return NULL;
  }

  if (napi_get_cb_info(env, info, &argc, args, NULL, NULL) != napi_ok || argc < 2) {
    zcc_reject_deferred(env, deferred, "PEER_CONNECTION_INVALID", "Missing arguments to readRequestFrame");
    return promise;
  }

  zcc_connection_t *conn = zcc_unwrap_connection(env, args[0]);
  if (conn == NULL) {
    zcc_reject_deferred(env, deferred, "PEER_CONNECTION_INVALID", "Invalid connection handle");
    return promise;
  }
  if (conn->is_closed) {
    zcc_reject_deferred(env, deferred, "PEER_CONNECTION_CLOSED", "Connection is closed");
    return promise;
  }
  if (conn->pending_read != NULL) {
    zcc_reject_deferred(env, deferred, "PEER_CONNECTION_INVALID", "Read already in progress");
    return promise;
  }

  int64_t timeout_ms = 5000;
  if (napi_get_value_int64(env, args[1], &timeout_ms) != napi_ok || timeout_ms <= 0) {
    timeout_ms = 5000;
  }

  zcc_pending_read_t *pr = (zcc_pending_read_t *)calloc(1, sizeof(zcc_pending_read_t));
  if (pr == NULL) {
    zcc_reject_deferred(env, deferred, "INTERNAL_ADAPTER_ERROR", "Allocation failed");
    return promise;
  }

  pr->deferred = deferred;
  pr->timeout_ms = (uint32_t)timeout_ms;
  conn->pending_read = pr;

  /* Initialize timeout timer */
  if (uv_timer_init(conn->loop, &pr->timer) != 0) {
    conn->pending_read = NULL;
    free(pr);
    zcc_reject_deferred(env, deferred, "INTERNAL_ADAPTER_ERROR", "Timer init failed");
    return promise;
  }
  pr->timer.data = conn;
  pr->timer_active = 1;
  uv_timer_start(&pr->timer, zcc_read_timeout_cb, (uint64_t)timeout_ms, 0);

  /* Initialize poll on connection */
  if (!conn->poll_active) {
    if (uv_poll_init(conn->loop, &conn->poll_handle, conn->fd) != 0) {
      uv_timer_stop(&pr->timer);
      uv_close((uv_handle_t *)&pr->timer, zcc_on_uv_handle_closed);
      conn->pending_read = NULL;
      free(pr);
      zcc_reject_deferred(env, deferred, "INTERNAL_ADAPTER_ERROR", "Poll init failed");
      return promise;
    }
    conn->poll_handle.data = conn;
  }

  if (uv_poll_start(&conn->poll_handle, UV_READABLE, zcc_connection_read_poll_cb) != 0) {
    uv_timer_stop(&pr->timer);
    uv_close((uv_handle_t *)&pr->timer, zcc_on_uv_handle_closed);
    conn->pending_read = NULL;
    free(pr);
    zcc_reject_deferred(env, deferred, "INTERNAL_ADAPTER_ERROR", "Poll start failed");
    return promise;
  }
  conn->poll_active = 1;

  /* Attempt immediate read */
  zcc_connection_read_poll_cb(&conn->poll_handle, 0, UV_READABLE);

  return promise;
}

/*
 * writeResponseFrame(conn: NativeConnectionHandle, payload: Buffer): Promise<void>
 */
static napi_value zcc_js_write_response_frame(napi_env env, napi_callback_info info) {
  size_t argc = 2;
  napi_value args[2];
  napi_deferred deferred;
  napi_value promise;

  if (napi_create_promise(env, &deferred, &promise) != napi_ok) {
    return NULL;
  }

  if (napi_get_cb_info(env, info, &argc, args, NULL, NULL) != napi_ok || argc < 2) {
    zcc_reject_deferred(env, deferred, "PEER_CONNECTION_INVALID", "Missing arguments to writeResponseFrame");
    return promise;
  }

  zcc_connection_t *conn = zcc_unwrap_connection(env, args[0]);
  if (conn == NULL) {
    zcc_reject_deferred(env, deferred, "PEER_CONNECTION_INVALID", "Invalid connection handle");
    return promise;
  }
  if (conn->is_closed) {
    zcc_reject_deferred(env, deferred, "PEER_CONNECTION_CLOSED", "Connection is closed");
    return promise;
  }
  if (conn->pending_write != NULL) {
    zcc_reject_deferred(env, deferred, "PEER_CONNECTION_INVALID", "Write already in progress");
    return promise;
  }

  bool is_buffer = false;
  if (napi_is_buffer(env, args[1], &is_buffer) != napi_ok || !is_buffer) {
    zcc_reject_deferred(env, deferred, "MALFORMED_REQUEST", "Payload must be a Buffer");
    return promise;
  }

  void *buf_data = NULL;
  size_t buf_len = 0;
  if (napi_get_buffer_info(env, args[1], &buf_data, &buf_len) != napi_ok) {
    zcc_reject_deferred(env, deferred, "MALFORMED_REQUEST", "Failed to read buffer info");
    return promise;
  }

  if (buf_len > MAX_RESPONSE_FRAME_BYTES) {
    zcc_reject_deferred(env, deferred, "MALFORMED_REQUEST", "Response payload exceeds 1MB limit");
    return promise;
  }

  /* Frame size: 4 bytes length header + payload */
  size_t total_len = buf_len + FRAME_HEADER_BYTES;
  uint8_t *frame_buf = (uint8_t *)malloc(total_len);
  if (frame_buf == NULL) {
    zcc_reject_deferred(env, deferred, "INTERNAL_ADAPTER_ERROR", "Allocation failed");
    return promise;
  }

  uint32_t len32 = (uint32_t)buf_len;
  frame_buf[0] = (uint8_t)((len32 >> 24) & 0xFF);
  frame_buf[1] = (uint8_t)((len32 >> 16) & 0xFF);
  frame_buf[2] = (uint8_t)((len32 >> 8) & 0xFF);
  frame_buf[3] = (uint8_t)(len32 & 0xFF);
  if (buf_len > 0 && buf_data != NULL) {
    memcpy(frame_buf + FRAME_HEADER_BYTES, buf_data, buf_len);
  }

  zcc_pending_write_t *pw = (zcc_pending_write_t *)calloc(1, sizeof(zcc_pending_write_t));
  if (pw == NULL) {
    free(frame_buf);
    zcc_reject_deferred(env, deferred, "INTERNAL_ADAPTER_ERROR", "Allocation failed");
    return promise;
  }
  pw->deferred = deferred;
  pw->buffer = frame_buf;
  pw->total_bytes = total_len;
  pw->bytes_written = 0;
  conn->pending_write = pw;

#if defined(__linux__)
  /* Non-blocking synchronous write attempt */
  while (pw->bytes_written < pw->total_bytes) {
    ssize_t n = write(conn->fd, pw->buffer + pw->bytes_written, pw->total_bytes - pw->bytes_written);
    if (n < 0) {
      if (errno == EAGAIN || errno == EWOULDBLOCK) break;
      conn->pending_write = NULL;
      free(pw->buffer);
      free(pw);
      zcc_internal_close_connection(conn);
      zcc_reject_deferred(env, deferred, "PEER_CONNECTION_CLOSED", "Write failed");
      return promise;
    }
    pw->bytes_written += (size_t)n;
  }

  if (pw->bytes_written == pw->total_bytes) {
    /* Write completed synchronously! One-request-per-connection: close descriptor */
    conn->pending_write = NULL;
    free(pw->buffer);
    free(pw);

    napi_value undefined_val;
    (void)napi_get_undefined(env, &undefined_val);
    (void)napi_resolve_deferred(env, deferred, undefined_val);

    zcc_internal_close_connection(conn);
    return promise;
  }

  /* Incomplete write, poll for UV_WRITABLE */
  if (!conn->poll_active) {
    if (uv_poll_init(conn->loop, &conn->poll_handle, conn->fd) != 0) {
      conn->pending_write = NULL;
      free(pw->buffer);
      free(pw);
      zcc_internal_close_connection(conn);
      zcc_reject_deferred(env, deferred, "INTERNAL_ADAPTER_ERROR", "Poll init failed");
      return promise;
    }
    conn->poll_handle.data = conn;
  }

  if (uv_poll_start(&conn->poll_handle, UV_WRITABLE, zcc_connection_write_poll_cb) != 0) {
    conn->pending_write = NULL;
    free(pw->buffer);
    free(pw);
    zcc_internal_close_connection(conn);
    zcc_reject_deferred(env, deferred, "INTERNAL_ADAPTER_ERROR", "Poll start failed");
    return promise;
  }
  conn->poll_active = 1;
#else
  free(pw->buffer);
  free(pw);
  conn->pending_write = NULL;
  zcc_reject_deferred(env, deferred, "PEER_PLATFORM_UNSUPPORTED", "Linux required");
#endif

  return promise;
}

/*
 * closeConnection(conn: NativeConnectionHandle): void
 */
static napi_value zcc_js_close_connection(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value args[1];
  if (napi_get_cb_info(env, info, &argc, args, NULL, NULL) == napi_ok && argc >= 1) {
    zcc_connection_t *conn = zcc_unwrap_connection(env, args[0]);
    if (conn != NULL) {
      zcc_internal_close_connection(conn);
    }
  }
  napi_value undefined_val;
  (void)napi_get_undefined(env, &undefined_val);
  return undefined_val;
}

/*
 * closeListener(listener: NativeListenerHandle): void
 */
static napi_value zcc_js_close_listener(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value args[1];
  if (napi_get_cb_info(env, info, &argc, args, NULL, NULL) == napi_ok && argc >= 1) {
    zcc_listener_t *listener = zcc_unwrap_listener(env, args[0]);
    if (listener != NULL) {
      zcc_internal_close_listener(listener);
    }
  }
  napi_value undefined_val;
  (void)napi_get_undefined(env, &undefined_val);
  return undefined_val;
}

/* ------------------------------------------------------------------------- */
/* Module Cleanup & Init                                                     */
/* ------------------------------------------------------------------------- */

static void zcc_env_cleanup_hook(void *arg) {
  (void)arg;
  zcc_connection_t *c = g_connection_head;
  while (c != NULL) {
    zcc_internal_close_connection(c);
    c = c->next;
  }
  zcc_listener_t *l = g_listener_head;
  while (l != NULL) {
    zcc_internal_close_listener(l);
    l = l->next;
  }
}

/* Node 22's NAPI_MODULE_INIT defines this exported ABI symbol without first
 * declaring its prototype. Keep -Wmissing-prototypes enabled for this
 * translation unit and provide the exact public Node-API declaration. */
NAPI_MODULE_EXPORT int32_t NODE_API_MODULE_GET_API_VERSION(void);

NAPI_MODULE_INIT() {
  uint32_t napi_version = 0;
  if (napi_get_version(env, &napi_version) != napi_ok || napi_version < 8) {
    zcc_throw_error(env, "PEER_PLATFORM_UNSUPPORTED", "N-API Version 8 or higher is required");
    return NULL;
  }

  (void)napi_add_env_cleanup_hook(env, zcc_env_cleanup_hook, NULL);

  napi_property_descriptor descriptors[] = {
    { "adoptSystemdListener", NULL, zcc_js_adopt_systemd_listener, NULL, NULL, NULL, napi_default | napi_enumerable, NULL },
    { "acceptConnection", NULL, zcc_js_accept_connection, NULL, NULL, NULL, napi_default | napi_enumerable, NULL },
    { "readRequestFrame", NULL, zcc_js_read_request_frame, NULL, NULL, NULL, napi_default | napi_enumerable, NULL },
    { "writeResponseFrame", NULL, zcc_js_write_response_frame, NULL, NULL, NULL, napi_default | napi_enumerable, NULL },
    { "closeConnection", NULL, zcc_js_close_connection, NULL, NULL, NULL, napi_default | napi_enumerable, NULL },
    { "closeListener", NULL, zcc_js_close_listener, NULL, NULL, NULL, napi_default | napi_enumerable, NULL }
  };

  if (napi_define_properties(env, exports, sizeof(descriptors) / sizeof(descriptors[0]), descriptors) != napi_ok) {
    return NULL;
  }

  return exports;
}
