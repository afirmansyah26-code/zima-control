#include "runtime_peer_internal.h"

#include <errno.h>
#include <fcntl.h>
#include <limits.h>
#include <stdlib.h>
#include <string.h>
#include <sys/epoll.h>
#include <sys/eventfd.h>
#include <sys/stat.h>
#include <sys/un.h>
#include <time.h>
#include <unistd.h>

#define ZCC_EPOLL_BATCH 32

static void *zcc_io_thread_main(void *data);
static void zcc_close_object_on_io(zcc_native_object *object, const char *code);
static void zcc_update_interest(zcc_native_object *object);
static int zcc_should_stop(zcc_runtime *runtime);

void zcc_set_code(zcc_operation *operation, const char *code) {
  size_t length;
  if (operation == NULL || operation->code[0] != 0) return;
  length = strlen(code);
  if (length >= sizeof(operation->code)) length = sizeof(operation->code) - 1U;
  memcpy(operation->code, code, length);
  operation->code[length] = 0;
}

static int64_t zcc_monotonic_ns(void) {
  struct timespec now;
  if (clock_gettime(CLOCK_MONOTONIC, &now) != 0) return -1;
  return ((int64_t)now.tv_sec * INT64_C(1000000000)) + (int64_t)now.tv_nsec;
}

static void zcc_wake(zcc_runtime *runtime) {
  uint64_t signal = 1U;
  ssize_t result;
  int descriptor;
  (void)pthread_mutex_lock(&runtime->mutex);
  descriptor = runtime->control_fd;
  if (descriptor < 0) {
    runtime->stop_requested = 1;
    (void)pthread_mutex_unlock(&runtime->mutex);
    return;
  }
  do {
    result = write(descriptor, &signal, sizeof(signal));
  } while (result < 0 && errno == EINTR);
  if (result < 0 && errno != EAGAIN) runtime->stop_requested = 1;
  (void)pthread_mutex_unlock(&runtime->mutex);
}

int zcc_enqueue(zcc_runtime *runtime, zcc_operation *operation) {
  int accepted = 0;
  operation->command_next = NULL;
  (void)pthread_mutex_lock(&runtime->mutex);
  if (runtime->initialized != 0
      && runtime->stop_requested == 0
      && runtime->queued_commands < ZCC_COMMAND_CAPACITY
      && (operation->has_promise == 0
        || runtime->outstanding_operations < ZCC_OUTSTANDING_CAPACITY)) {
    if (runtime->command_tail == NULL) runtime->command_head = operation;
    else runtime->command_tail->command_next = operation;
    runtime->command_tail = operation;
    runtime->queued_commands += 1U;
    if (operation->has_promise != 0) runtime->outstanding_operations += 1U;
    accepted = 1;
  }
  (void)pthread_mutex_unlock(&runtime->mutex);
  if (accepted != 0) zcc_wake(runtime);
  return accepted;
}

static void zcc_queue_completion(zcc_operation *operation) {
  napi_status status;
  if (operation->has_promise == 0) {
    free(operation);
    return;
  }
  if (operation->completion_queued != 0) return;
  operation->completion_queued = 1;
  status = napi_call_threadsafe_function(
    operation->runtime->completion_tsfn,
    operation,
    napi_tsfn_blocking
  );
  if (status != napi_ok) {
    (void)pthread_mutex_lock(&operation->runtime->mutex);
    operation->runtime->stop_requested = 1;
    (void)pthread_mutex_unlock(&operation->runtime->mutex);
  }
}

static void zcc_finish_operation(zcc_operation *operation, const char *code) {
  if (operation == NULL || operation->completed != 0) return;
  if (operation->owner != NULL) {
    zcc_native_object *owner = operation->owner;
    (void)pthread_mutex_lock(&operation->runtime->mutex);
    if (operation->kind == ZCC_COMMAND_ACCEPT && owner->pending_accept == operation) {
      owner->pending_accept = NULL;
    } else if (operation->kind == ZCC_COMMAND_READ && owner->pending_read == operation) {
      owner->pending_read = NULL;
    } else if (operation->kind == ZCC_COMMAND_WRITE && owner->pending_write == operation) {
      owner->pending_write = NULL;
    }
    (void)pthread_mutex_unlock(&operation->runtime->mutex);
  }
  if (code != NULL) zcc_set_code(operation, code);
  operation->completed = 1;
  zcc_queue_completion(operation);
}

static int zcc_registry_contains_locked(
  const zcc_runtime *runtime,
  const zcc_native_object *object,
  uint64_t generation
) {
  const zcc_native_object *cursor;
  for (cursor = runtime->registry_head; cursor != NULL; cursor = cursor->registry_next) {
    if (cursor == object && cursor->generation == generation) return 1;
  }
  return 0;
}

static void zcc_unregister_locked(zcc_runtime *runtime, zcc_native_object *object) {
  zcc_native_object **cursor = &runtime->registry_head;
  while (*cursor != NULL && *cursor != object) cursor = &(*cursor)->registry_next;
  if (*cursor != object) return;
  *cursor = object->registry_next;
  object->registry_next = NULL;
  if (object->kind == ZCC_OBJECT_CONNECTION && runtime->live_connections > 0U) {
    runtime->live_connections -= 1U;
  }
}

static zcc_native_object *zcc_create_native_object(
  zcc_runtime *runtime,
  zcc_object_kind kind,
  int fd,
  const struct ucred *credentials
) {
  zcc_native_object *object = calloc(1U, sizeof(*object));
  if (object == NULL) return NULL;
  (void)pthread_mutex_lock(&runtime->mutex);
  if (runtime->stop_requested != 0
      || (kind == ZCC_OBJECT_CONNECTION && runtime->live_connections >= ZCC_MAX_CONNECTIONS)) {
    (void)pthread_mutex_unlock(&runtime->mutex);
    free(object);
    return NULL;
  }
  if (runtime->next_generation == UINT64_MAX) {
    runtime->stop_requested = 1;
    (void)pthread_mutex_unlock(&runtime->mutex);
    free(object);
    return NULL;
  }
  object->target.kind = ZCC_TARGET_OBJECT;
  object->magic = ZCC_MAGIC;
  object->kind = kind;
  object->state = ZCC_STATE_OPEN;
  object->env = runtime->env;
  object->runtime = runtime;
  object->fd = fd;
  object->generation = runtime->next_generation;
  runtime->next_generation += 1U;
  object->accepts_commands = 1;
  if (credentials != NULL) object->credentials = *credentials;
  object->registry_next = runtime->registry_head;
  runtime->registry_head = object;
  if (kind == ZCC_OBJECT_CONNECTION) runtime->live_connections += 1U;
  (void)pthread_mutex_unlock(&runtime->mutex);
  return object;
}

static int zcc_validate_connected_fd(int fd) {
  int flags;
  int type = 0;
  socklen_t type_length = (socklen_t)sizeof(type);
  struct sockaddr_un local;
  struct sockaddr_un peer;
  socklen_t local_length = (socklen_t)sizeof(local);
  socklen_t peer_length = (socklen_t)sizeof(peer);
  memset(&local, 0, sizeof(local));
  memset(&peer, 0, sizeof(peer));
  flags = fcntl(fd, F_GETFD);
  if (flags < 0 || (flags & FD_CLOEXEC) == 0) return -1;
  if (getsockopt(fd, SOL_SOCKET, SO_TYPE, &type, &type_length) != 0
      || type_length != (socklen_t)sizeof(type) || type != SOCK_STREAM) return -1;
  if (getsockname(fd, (struct sockaddr *)&local, &local_length) != 0
      || getpeername(fd, (struct sockaddr *)&peer, &peer_length) != 0
      || local.sun_family != AF_UNIX || peer.sun_family != AF_UNIX) return -1;
  return 0;
}

static int zcc_capture_credentials(int fd, struct ucred *credentials) {
  int attempt;
  socklen_t length = (socklen_t)sizeof(*credentials);
  memset(credentials, 0, sizeof(*credentials));
  for (attempt = 0; attempt < 3; attempt += 1) {
    if (getsockopt(fd, SOL_SOCKET, SO_PEERCRED, credentials, &length) == 0) break;
    if (errno != EINTR) return -1;
  }
  if (attempt == 3 || length != (socklen_t)sizeof(*credentials) || credentials->pid < 0) {
    return -1;
  }
  return 0;
}

static uint32_t zcc_interest(const zcc_native_object *object) {
  uint32_t events = EPOLLERR | EPOLLHUP | EPOLLRDHUP | EPOLLONESHOT;
  if (object->state != ZCC_STATE_OPEN) return 0U;
  if (object->kind == ZCC_OBJECT_LISTENER) {
    return object->pending_accept != NULL && object->pending_accept->completed == 0
      ? events | EPOLLIN : 0U;
  }
  if (object->pending_read != NULL && object->pending_read->completed == 0) events |= EPOLLIN;
  if (object->pending_write != NULL && object->pending_write->completed == 0) events |= EPOLLOUT;
  return events == (EPOLLERR | EPOLLHUP | EPOLLRDHUP | EPOLLONESHOT) ? 0U : events;
}

static void zcc_update_interest(zcc_native_object *object) {
  struct epoll_event event;
  uint32_t interest = zcc_interest(object);
  int operation;
  memset(&event, 0, sizeof(event));
  if (interest == 0U) {
    if (object->epoll_registered != 0) {
      (void)epoll_ctl(object->runtime->epoll_fd, EPOLL_CTL_DEL, object->fd, NULL);
      object->epoll_registered = 0;
    }
    return;
  }
  event.events = interest;
  event.data.ptr = &object->target;
  operation = object->epoll_registered != 0 ? EPOLL_CTL_MOD : EPOLL_CTL_ADD;
  if (epoll_ctl(object->runtime->epoll_fd, operation, object->fd, &event) != 0) {
    zcc_close_object_on_io(object, "PEER_CONNECTION_INVALID");
    return;
  }
  object->epoll_registered = 1;
}

static void zcc_close_object_on_io(zcc_native_object *object, const char *code) {
  zcc_runtime *runtime = object->runtime;
  int descriptor = -1;
  zcc_operation *accept_operation;
  zcc_operation *read_operation;
  zcc_operation *write_operation;
  int free_after_close;

  (void)pthread_mutex_lock(&runtime->mutex);
  if (object->state != ZCC_STATE_CLOSED) {
    object->accepts_commands = 0;
    object->state = ZCC_STATE_CLOSING;
    zcc_unregister_locked(runtime, object);
  }
  accept_operation = object->pending_accept;
  read_operation = object->pending_read;
  write_operation = object->pending_write;
  if (object->epoll_registered != 0) {
    (void)epoll_ctl(runtime->epoll_fd, EPOLL_CTL_DEL, object->fd, NULL);
    object->epoll_registered = 0;
  }
  descriptor = object->fd;
  object->fd = -1;
  object->state = ZCC_STATE_CLOSED;
  free_after_close = object->finalized;
  (void)pthread_mutex_unlock(&runtime->mutex);

  if (descriptor >= 0) {
    (void)shutdown(descriptor, SHUT_RDWR);
    (void)close(descriptor);
  }
  if (accept_operation != NULL) zcc_finish_operation(accept_operation, code);
  if (read_operation != NULL) zcc_finish_operation(read_operation, code);
  if (write_operation != NULL) zcc_finish_operation(write_operation, code);
  if (free_after_close != 0
      && accept_operation == NULL && read_operation == NULL && write_operation == NULL) {
    object->magic = 0U;
    free(object);
  }
}

#if defined(ZCC_ISSUER_ARTIFACT)
static void zcc_fail_connect(zcc_operation *operation, const char *code) {
  zcc_runtime *runtime = operation->runtime;
  if (operation->result_fd >= 0) {
    (void)epoll_ctl(runtime->epoll_fd, EPOLL_CTL_DEL, operation->result_fd, NULL);
    (void)close(operation->result_fd);
    operation->result_fd = -1;
  }
  (void)pthread_mutex_lock(&runtime->mutex);
  if (runtime->pending_connect == operation) runtime->pending_connect = NULL;
  (void)pthread_mutex_unlock(&runtime->mutex);
  zcc_finish_operation(operation, code);
}

static void zcc_complete_connection_fd(zcc_operation *operation) {
  zcc_runtime *runtime = operation->runtime;
  zcc_native_object *object;
  if (zcc_validate_connected_fd(operation->result_fd) != 0) {
    zcc_fail_connect(operation, "PEER_CONNECTION_INVALID");
    return;
  }
  if (zcc_capture_credentials(operation->result_fd, &operation->credentials) != 0) {
    zcc_fail_connect(operation, "PEER_CREDENTIAL_UNAVAILABLE");
    return;
  }
  object = zcc_create_native_object(
    runtime,
    ZCC_OBJECT_CONNECTION,
    operation->result_fd,
    &operation->credentials
  );
  if (object == NULL) {
    zcc_fail_connect(operation, "PEER_CONNECTION_INVALID");
    return;
  }
  operation->result_object = object;
  operation->result_fd = -1;
  (void)pthread_mutex_lock(&runtime->mutex);
  if (runtime->pending_connect == operation) runtime->pending_connect = NULL;
  (void)pthread_mutex_unlock(&runtime->mutex);
  zcc_finish_operation(operation, NULL);
}
#endif

#if defined(ZCC_AUTHORITY_ARTIFACT)
static void zcc_process_create_listener(zcc_operation *operation) {
  int descriptor;
  int one = 1;
  struct sockaddr_un address;
  zcc_native_object *listener;
  descriptor = socket(AF_UNIX, SOCK_STREAM | SOCK_NONBLOCK | SOCK_CLOEXEC, 0);
  if (descriptor < 0) {
    zcc_finish_operation(operation, "PEER_CONNECTION_INVALID");
    return;
  }
  memset(&address, 0, sizeof(address));
  address.sun_family = AF_UNIX;
  memcpy(address.sun_path, ZCC_SOCKET_PATH, sizeof(ZCC_SOCKET_PATH));
  if (setsockopt(descriptor, SOL_SOCKET, SO_PASSCRED, &one, (socklen_t)sizeof(one)) != 0
      || bind(descriptor, (const struct sockaddr *)&address, (socklen_t)sizeof(address)) != 0
      || chmod(ZCC_SOCKET_PATH, (mode_t)0660) != 0
      || listen(descriptor, ZCC_BACKLOG) != 0) {
    (void)close(descriptor);
    zcc_finish_operation(operation, "PEER_CONNECTION_INVALID");
    return;
  }
  listener = zcc_create_native_object(operation->runtime, ZCC_OBJECT_LISTENER, descriptor, NULL);
  if (listener == NULL) {
    (void)close(descriptor);
    zcc_finish_operation(operation, "PEER_CONNECTION_INVALID");
    return;
  }
  operation->result_object = listener;
  zcc_finish_operation(operation, NULL);
}
#endif

#if defined(ZCC_ISSUER_ARTIFACT)
static void zcc_process_connect(zcc_operation *operation) {
  zcc_runtime *runtime = operation->runtime;
  struct sockaddr_un address;
  struct epoll_event event;
  int result;
  (void)pthread_mutex_lock(&runtime->mutex);
  if (runtime->pending_connect != NULL) {
    (void)pthread_mutex_unlock(&runtime->mutex);
    zcc_finish_operation(operation, "PEER_CONNECTION_INVALID");
    return;
  }
  runtime->pending_connect = operation;
  (void)pthread_mutex_unlock(&runtime->mutex);
  operation->result_fd = socket(AF_UNIX, SOCK_STREAM | SOCK_NONBLOCK | SOCK_CLOEXEC, 0);
  if (operation->result_fd < 0) {
    zcc_fail_connect(operation, "PEER_CONNECTION_INVALID");
    return;
  }
  memset(&address, 0, sizeof(address));
  address.sun_family = AF_UNIX;
  memcpy(address.sun_path, ZCC_SOCKET_PATH, sizeof(ZCC_SOCKET_PATH));
  result = connect(
    operation->result_fd,
    (const struct sockaddr *)&address,
    (socklen_t)sizeof(address)
  );
  if (result == 0) {
    zcc_complete_connection_fd(operation);
    return;
  }
  if (errno != EINPROGRESS) {
    zcc_fail_connect(operation, "PEER_CONNECTION_INVALID");
    return;
  }
  operation->target.kind = ZCC_TARGET_CONNECT;
  operation->deadline_ns = zcc_monotonic_ns();
  if (operation->deadline_ns < 0) {
    zcc_fail_connect(operation, "PEER_CONNECTION_INVALID");
    return;
  }
  operation->deadline_ns += (int64_t)ZCC_CONNECT_TIMEOUT_MS * INT64_C(1000000);
  memset(&event, 0, sizeof(event));
  event.events = EPOLLOUT | EPOLLERR | EPOLLHUP | EPOLLRDHUP | EPOLLONESHOT;
  event.data.ptr = &operation->target;
  if (epoll_ctl(runtime->epoll_fd, EPOLL_CTL_ADD, operation->result_fd, &event) != 0) {
    zcc_fail_connect(operation, "PEER_CONNECTION_INVALID");
  }
}

static void zcc_process_connect_event(zcc_operation *operation) {
  int socket_error = 0;
  socklen_t error_length = (socklen_t)sizeof(socket_error);
  if (getsockopt(
        operation->result_fd,
        SOL_SOCKET,
        SO_ERROR,
        &socket_error,
        &error_length
      ) != 0 || error_length != (socklen_t)sizeof(socket_error) || socket_error != 0) {
    zcc_fail_connect(operation, "PEER_CONNECTION_INVALID");
    return;
  }
  (void)epoll_ctl(operation->runtime->epoll_fd, EPOLL_CTL_DEL, operation->result_fd, NULL);
  zcc_complete_connection_fd(operation);
}
#endif

#if defined(ZCC_AUTHORITY_ARTIFACT)
static void zcc_process_accept(zcc_native_object *listener) {
  zcc_operation *operation = listener->pending_accept;
  int accepted;
  int attempt;
  zcc_native_object *connection;
  if (operation == NULL || operation->completed != 0) return;
  while (listener->state == ZCC_STATE_OPEN && operation->completed == 0) {
    accepted = -1;
    for (attempt = 0; attempt < 3; attempt += 1) {
      accepted = accept4(listener->fd, NULL, NULL, SOCK_NONBLOCK | SOCK_CLOEXEC);
      if (accepted >= 0 || errno != EINTR) break;
    }
    if (accepted < 0) {
      if (errno == EAGAIN || errno == EWOULDBLOCK || errno == ECONNABORTED) return;
      zcc_close_object_on_io(listener, "PEER_CONNECTION_CLOSED");
      return;
    }
    if (zcc_validate_connected_fd(accepted) != 0) {
      (void)close(accepted);
      continue;
    }
    if (zcc_capture_credentials(accepted, &operation->credentials) != 0) {
      (void)close(accepted);
      continue;
    }
    connection = zcc_create_native_object(
      listener->runtime,
      ZCC_OBJECT_CONNECTION,
      accepted,
      &operation->credentials
    );
    if (connection == NULL) {
      (void)close(accepted);
      if (zcc_should_stop(listener->runtime) != 0) return;
      continue;
    }
    operation->result_object = connection;
    zcc_finish_operation(operation, NULL);
    return;
  }
}
#endif

static int zcc_receive_part(int descriptor, unsigned char *bytes, size_t size, size_t *offset) {
  while (*offset < size) {
    ssize_t count = recv(descriptor, bytes + *offset, size - *offset, 0);
    if (count > 0) {
      *offset += (size_t)count;
      continue;
    }
    if (count == 0) return -1;
    if (errno == EINTR) continue;
    if (errno == EAGAIN || errno == EWOULDBLOCK) return 0;
    return -1;
  }
  return 1;
}

static void zcc_process_read(zcc_native_object *connection) {
  zcc_operation *operation = connection->pending_read;
  int result;
  uint32_t frame_length;
  if (operation == NULL || operation->completed != 0) return;
  if (operation->prefix_offset < sizeof(operation->prefix)) {
    result = zcc_receive_part(
      connection->fd,
      operation->prefix,
      sizeof(operation->prefix),
      &operation->prefix_offset
    );
    if (result < 0) {
      zcc_close_object_on_io(connection, "PEER_CONNECTION_CLOSED");
      return;
    }
    if (result == 0) return;
    frame_length = ((uint32_t)operation->prefix[0] << 24U)
      | ((uint32_t)operation->prefix[1] << 16U)
      | ((uint32_t)operation->prefix[2] << 8U)
      | (uint32_t)operation->prefix[3];
    if (frame_length == 0U || frame_length > ZCC_MAX_FRAME) {
      zcc_close_object_on_io(connection, "PEER_CONNECTION_INVALID");
      return;
    }
    operation->bytes = malloc((size_t)frame_length);
    if (operation->bytes == NULL) {
      zcc_close_object_on_io(connection, "PEER_CONNECTION_INVALID");
      return;
    }
    operation->length = (size_t)frame_length;
    operation->offset = 0U;
  }
  result = zcc_receive_part(
    connection->fd,
    operation->bytes,
    operation->length,
    &operation->offset
  );
  if (result < 0) {
    zcc_close_object_on_io(connection, "PEER_CONNECTION_CLOSED");
    return;
  }
  if (result > 0) zcc_finish_operation(operation, NULL);
}

static void zcc_process_write(zcc_native_object *connection) {
  zcc_operation *operation = connection->pending_write;
  if (operation == NULL || operation->completed != 0) return;
  while (operation->offset < operation->length) {
    ssize_t count = send(
      connection->fd,
      operation->bytes + operation->offset,
      operation->length - operation->offset,
      MSG_NOSIGNAL
    );
    if (count > 0) {
      operation->offset += (size_t)count;
      continue;
    }
    if (count < 0 && errno == EINTR) continue;
    if (count < 0 && (errno == EAGAIN || errno == EWOULDBLOCK)) return;
    zcc_close_object_on_io(connection, "PEER_CONNECTION_CLOSED");
    return;
  }
  zcc_finish_operation(operation, NULL);
}

static void zcc_process_object_event(zcc_native_object *object, uint32_t events) {
  if (object->state != ZCC_STATE_OPEN || object->fd < 0) return;
  if (object->kind == ZCC_OBJECT_LISTENER) {
#if defined(ZCC_AUTHORITY_ARTIFACT)
    if ((events & EPOLLIN) != 0U) zcc_process_accept(object);
    if ((events & (EPOLLERR | EPOLLHUP | EPOLLRDHUP)) != 0U
        && object->pending_accept != NULL && object->pending_accept->completed == 0) {
      zcc_close_object_on_io(object, "PEER_CONNECTION_CLOSED");
      return;
    }
#else
    zcc_close_object_on_io(object, "PEER_CONNECTION_INVALID");
    return;
#endif
  } else {
    if ((events & EPOLLIN) != 0U) zcc_process_read(object);
    if (object->state == ZCC_STATE_OPEN && (events & EPOLLOUT) != 0U) zcc_process_write(object);
    if (object->state == ZCC_STATE_OPEN
        && (events & (EPOLLERR | EPOLLHUP | EPOLLRDHUP)) != 0U) {
      zcc_close_object_on_io(object, "PEER_CONNECTION_CLOSED");
      return;
    }
  }
  if (object->state == ZCC_STATE_OPEN) zcc_update_interest(object);
}

static int zcc_operation_owner_is_live(zcc_operation *operation) {
  zcc_native_object *owner = operation->owner;
  zcc_runtime *runtime = operation->runtime;
  int valid;
  (void)pthread_mutex_lock(&runtime->mutex);
  valid = owner != NULL
    && owner->state == ZCC_STATE_OPEN
    && owner->accepts_commands != 0
    && owner->generation == operation->owner_generation
    && zcc_registry_contains_locked(runtime, owner, operation->owner_generation) != 0;
  (void)pthread_mutex_unlock(&runtime->mutex);
  return valid;
}

static void zcc_process_command(zcc_operation *operation) {
  zcc_native_object *owner = operation->owner;
#if defined(ZCC_AUTHORITY_ARTIFACT)
  if (operation->kind == ZCC_COMMAND_CREATE_LISTENER) {
    zcc_process_create_listener(operation);
    return;
  }
#else
  if (operation->kind == ZCC_COMMAND_CONNECT) {
    zcc_process_connect(operation);
    return;
  }
#endif
  if (operation->kind == ZCC_COMMAND_CLOSE) {
    zcc_close_object_on_io(owner, "PEER_CONNECTION_CLOSED");
    free(operation);
    return;
  }
  if (zcc_operation_owner_is_live(operation) == 0) {
    zcc_finish_operation(operation, "PEER_CONNECTION_CLOSED");
    return;
  }
  zcc_update_interest(owner);
}

static void zcc_drain_control(zcc_runtime *runtime) {
  uint64_t value;
  ssize_t result;
  do {
    result = read(runtime->control_fd, &value, sizeof(value));
  } while (result > 0 || (result < 0 && errno == EINTR));
}

static void zcc_drain_commands(zcc_runtime *runtime) {
  zcc_operation *head;
  zcc_operation *next;
  (void)pthread_mutex_lock(&runtime->mutex);
  head = runtime->command_head;
  runtime->command_head = NULL;
  runtime->command_tail = NULL;
  runtime->queued_commands = 0U;
  (void)pthread_mutex_unlock(&runtime->mutex);
  while (head != NULL) {
    next = head->command_next;
    head->command_next = NULL;
    zcc_process_command(head);
    head = next;
  }
}

static int zcc_wait_timeout(zcc_runtime *runtime) {
  zcc_operation *connect_operation;
  int64_t now;
  int64_t remaining;
  int timeout;
  (void)pthread_mutex_lock(&runtime->mutex);
  connect_operation = runtime->pending_connect;
  (void)pthread_mutex_unlock(&runtime->mutex);
  if (connect_operation == NULL || connect_operation->completed != 0) return -1;
  now = zcc_monotonic_ns();
  if (now < 0 || now >= connect_operation->deadline_ns) return 0;
  remaining = connect_operation->deadline_ns - now;
  remaining = (remaining + INT64_C(999999)) / INT64_C(1000000);
  if (remaining > (int64_t)INT_MAX) return INT_MAX;
  timeout = (int)remaining;
  return timeout > 0 ? timeout : 1;
}

static void zcc_expire_connect(zcc_runtime *runtime) {
#if defined(ZCC_ISSUER_ARTIFACT)
  zcc_operation *connect_operation;
  int64_t now;
  (void)pthread_mutex_lock(&runtime->mutex);
  connect_operation = runtime->pending_connect;
  (void)pthread_mutex_unlock(&runtime->mutex);
  if (connect_operation == NULL || connect_operation->completed != 0) return;
  now = zcc_monotonic_ns();
  if (now < 0 || now >= connect_operation->deadline_ns) {
    zcc_fail_connect(connect_operation, "PEER_CONNECTION_INVALID");
  }
#else
  (void)runtime;
#endif
}

static int zcc_should_stop(zcc_runtime *runtime) {
  int result;
  (void)pthread_mutex_lock(&runtime->mutex);
  result = runtime->stop_requested;
  (void)pthread_mutex_unlock(&runtime->mutex);
  return result;
}

static void zcc_close_all_for_shutdown(zcc_runtime *runtime) {
  zcc_native_object *cursor;
  zcc_native_object *next;
  zcc_operation *connect_operation;
  zcc_operation *command;
  zcc_operation *command_next;

  (void)pthread_mutex_lock(&runtime->mutex);
  cursor = runtime->registry_head;
  runtime->registry_head = NULL;
  runtime->live_connections = 0U;
  connect_operation = runtime->pending_connect;
  runtime->pending_connect = NULL;
  command = runtime->command_head;
  runtime->command_head = NULL;
  runtime->command_tail = NULL;
  runtime->queued_commands = 0U;
  for (next = cursor; next != NULL; next = next->registry_next) {
    int descriptor = next->fd;
    next->cleanup_owned = 1;
    next->accepts_commands = 0;
    next->state = ZCC_STATE_CLOSED;
    next->fd = -1;
    next->epoll_registered = 0;
    if (descriptor >= 0) {
      (void)shutdown(descriptor, SHUT_RDWR);
      (void)close(descriptor);
    }
  }
  (void)pthread_mutex_unlock(&runtime->mutex);

  while (command != NULL) {
    command_next = command->command_next;
    if (command->kind == ZCC_COMMAND_CLOSE) free(command);
    else zcc_finish_operation(command, "PEER_CONNECTION_INVALID");
    command = command_next;
  }
  if (connect_operation != NULL && connect_operation->result_fd >= 0) {
    (void)close(connect_operation->result_fd);
    connect_operation->result_fd = -1;
  }
  if (connect_operation != NULL) {
    zcc_finish_operation(connect_operation, "PEER_CONNECTION_INVALID");
  }

  while (cursor != NULL) {
    int free_after_cleanup;
    next = cursor->registry_next;
    cursor->registry_next = NULL;
    if (cursor->pending_accept != NULL) {
      zcc_finish_operation(cursor->pending_accept, "PEER_CONNECTION_CLOSED");
    }
    if (cursor->pending_read != NULL) {
      zcc_finish_operation(cursor->pending_read, "PEER_CONNECTION_CLOSED");
    }
    if (cursor->pending_write != NULL) {
      zcc_finish_operation(cursor->pending_write, "PEER_CONNECTION_CLOSED");
    }
    (void)pthread_mutex_lock(&runtime->mutex);
    cursor->cleanup_owned = 0;
    free_after_cleanup = cursor->finalized != 0
      && cursor->pending_accept == NULL
      && cursor->pending_read == NULL
      && cursor->pending_write == NULL;
    (void)pthread_mutex_unlock(&runtime->mutex);
    if (free_after_cleanup != 0) {
      cursor->magic = 0U;
      free(cursor);
    }
    cursor = next;
  }
}

static void *zcc_io_thread_main(void *data) {
  zcc_runtime *runtime = (zcc_runtime *)data;
  struct epoll_event events[ZCC_EPOLL_BATCH];
  while (zcc_should_stop(runtime) == 0) {
    int count;
    int index;
    int timeout = zcc_wait_timeout(runtime);
    do {
      count = epoll_wait(runtime->epoll_fd, events, ZCC_EPOLL_BATCH, timeout);
    } while (count < 0 && errno == EINTR);
    if (count < 0) {
      (void)pthread_mutex_lock(&runtime->mutex);
      runtime->stop_requested = 1;
      (void)pthread_mutex_unlock(&runtime->mutex);
      break;
    }
    for (index = 0; index < count; index += 1) {
      zcc_event_target *target = (zcc_event_target *)events[index].data.ptr;
      if (target == NULL) continue;
      if (target->kind == ZCC_TARGET_CONTROL) {
        zcc_drain_control(runtime);
        if (zcc_should_stop(runtime) == 0) zcc_drain_commands(runtime);
      } else if (target->kind == ZCC_TARGET_CONNECT) {
#if defined(ZCC_ISSUER_ARTIFACT)
        zcc_process_connect_event((zcc_operation *)target);
#else
        (void)pthread_mutex_lock(&runtime->mutex);
        runtime->stop_requested = 1;
        (void)pthread_mutex_unlock(&runtime->mutex);
#endif
      } else if (target->kind == ZCC_TARGET_OBJECT) {
        zcc_process_object_event((zcc_native_object *)target, events[index].events);
      }
      if (zcc_should_stop(runtime) != 0) break;
    }
    zcc_expire_connect(runtime);
  }
  zcc_close_all_for_shutdown(runtime);
  (void)pthread_mutex_lock(&runtime->mutex);
  if (runtime->control_fd >= 0) {
    (void)close(runtime->control_fd);
    runtime->control_fd = -1;
  }
  if (runtime->epoll_fd >= 0) {
    (void)close(runtime->epoll_fd);
    runtime->epoll_fd = -1;
  }
  runtime->thread_exited = 1;
  (void)pthread_mutex_unlock(&runtime->mutex);
  return NULL;
}

int zcc_runtime_start(zcc_runtime *runtime) {
  struct epoll_event event;
  memset(runtime, 0, sizeof(*runtime));
  runtime->epoll_fd = -1;
  runtime->control_fd = -1;
  runtime->next_generation = 1U;
  runtime->control_target.kind = ZCC_TARGET_CONTROL;
  if (pthread_mutex_init(&runtime->mutex, NULL) != 0) return -1;
  runtime->epoll_fd = epoll_create1(EPOLL_CLOEXEC);
  if (runtime->epoll_fd < 0) goto failure;
  runtime->control_fd = eventfd(0U, EFD_CLOEXEC | EFD_NONBLOCK);
  if (runtime->control_fd < 0) goto failure;
  memset(&event, 0, sizeof(event));
  event.events = EPOLLIN;
  event.data.ptr = &runtime->control_target;
  if (epoll_ctl(runtime->epoll_fd, EPOLL_CTL_ADD, runtime->control_fd, &event) != 0) {
    goto failure;
  }
  runtime->initialized = 1;
  if (pthread_create(&runtime->io_thread, NULL, zcc_io_thread_main, runtime) != 0) {
    runtime->initialized = 0;
    goto failure;
  }
  runtime->thread_started = 1;
  return 0;

failure:
  if (runtime->control_fd >= 0) (void)close(runtime->control_fd);
  if (runtime->epoll_fd >= 0) (void)close(runtime->epoll_fd);
  runtime->control_fd = -1;
  runtime->epoll_fd = -1;
  (void)pthread_mutex_destroy(&runtime->mutex);
  return -1;
}

void zcc_request_close(zcc_native_object *object, int finalized) {
  zcc_runtime *runtime;
  zcc_operation *operation;
  int should_enqueue = 0;
  int should_free = 0;
  int wake_for_stop = 0;
  if (object == NULL || object->magic != ZCC_MAGIC) return;
  runtime = object->runtime;
  if (runtime->initialized == 0) {
    object->magic = 0U;
    free(object);
    return;
  }
  operation = calloc(1U, sizeof(*operation));
  (void)pthread_mutex_lock(&runtime->mutex);
  if (finalized != 0) object->finalized = 1;
  if (object->state == ZCC_STATE_CLOSED || runtime->initialized == 0) {
    should_free = object->finalized && object->cleanup_owned == 0;
  } else if (object->accepts_commands != 0) {
    object->accepts_commands = 0;
    if (operation != NULL) {
      operation->target.kind = ZCC_TARGET_CONTROL;
      operation->kind = ZCC_COMMAND_CLOSE;
      operation->runtime = runtime;
      operation->owner = object;
      operation->owner_generation = object->generation;
      should_enqueue = 1;
    } else {
      runtime->stop_requested = 1;
      wake_for_stop = 1;
    }
  }
  (void)pthread_mutex_unlock(&runtime->mutex);
  if (should_free != 0) {
    free(operation);
    object->magic = 0U;
    free(object);
    return;
  }
  if (should_enqueue != 0) {
    if (zcc_enqueue(runtime, operation) == 0) {
      free(operation);
      (void)pthread_mutex_lock(&runtime->mutex);
      runtime->stop_requested = 1;
      (void)pthread_mutex_unlock(&runtime->mutex);
      zcc_wake(runtime);
    }
  } else {
    free(operation);
    if (wake_for_stop != 0) zcc_wake(runtime);
  }
}

void zcc_runtime_cleanup(void *data) {
  zcc_runtime *runtime = (zcc_runtime *)data;
  if (runtime == NULL || runtime->initialized == 0) return;
  (void)pthread_mutex_lock(&runtime->mutex);
  runtime->stop_requested = 1;
  (void)pthread_mutex_unlock(&runtime->mutex);
  zcc_wake(runtime);
  if (runtime->thread_started != 0) {
    (void)pthread_join(runtime->io_thread, NULL);
    runtime->thread_started = 0;
  }
  if (runtime->completion_tsfn != NULL) {
    (void)napi_release_threadsafe_function(runtime->completion_tsfn, napi_tsfn_abort);
    runtime->completion_tsfn = NULL;
  }
  runtime->initialized = 0;
  (void)pthread_mutex_destroy(&runtime->mutex);
}
