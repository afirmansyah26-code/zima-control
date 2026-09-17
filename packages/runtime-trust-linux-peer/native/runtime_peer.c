#include "runtime_peer_internal.h"

#include <stdlib.h>
#include <string.h>

zcc_runtime zcc_process_runtime;
static pthread_mutex_t zcc_initialize_mutex = PTHREAD_MUTEX_INITIALIZER;
static int zcc_environment_claimed = 0;

#if defined(ZCC_AUTHORITY_ARTIFACT)
static napi_value zcc_js_create_listener(napi_env env, napi_callback_info info);
static napi_value zcc_js_accept(napi_env env, napi_callback_info info);
#else
static napi_value zcc_js_connect(napi_env env, napi_callback_info info);
#endif
static napi_value zcc_js_credentials(napi_env env, napi_callback_info info);
static napi_value zcc_js_read(napi_env env, napi_callback_info info);
static napi_value zcc_js_write(napi_env env, napi_callback_info info);
static napi_value zcc_js_close_connection(napi_env env, napi_callback_info info);
#if defined(ZCC_AUTHORITY_ARTIFACT)
static napi_value zcc_js_close_listener(napi_env env, napi_callback_info info);
#endif
static napi_value zcc_initialize(napi_env env, napi_value exports);

static napi_value zcc_coded_error(napi_env env, const char *code) {
  napi_value message;
  napi_value error;
  napi_value code_value;
  if (napi_create_string_utf8(env, code, NAPI_AUTO_LENGTH, &message) != napi_ok
      || napi_create_error(env, NULL, message, &error) != napi_ok
      || napi_create_string_utf8(env, code, NAPI_AUTO_LENGTH, &code_value) != napi_ok
      || napi_set_named_property(env, error, "code", code_value) != napi_ok) {
    return NULL;
  }
  return error;
}

static napi_value zcc_rejected(napi_env env, const char *code) {
  napi_deferred deferred;
  napi_value promise;
  napi_value error;
  if (napi_create_promise(env, &deferred, &promise) != napi_ok) return NULL;
  error = zcc_coded_error(env, code);
  if (error == NULL || napi_reject_deferred(env, deferred, error) != napi_ok) return NULL;
  return promise;
}

static napi_value zcc_reject_created_operation(
  napi_env env,
  zcc_operation *operation,
  napi_value promise,
  const char *code
) {
  napi_value error = zcc_coded_error(env, code);
  if (error != NULL) (void)napi_reject_deferred(env, operation->deferred, error);
  free(operation->bytes);
  free(operation);
  return promise;
}

static void zcc_throw(napi_env env, const char *code) {
  napi_value error = zcc_coded_error(env, code);
  if (error != NULL) (void)napi_throw(env, error);
}

static int zcc_registry_contains_locked(
  const zcc_runtime *runtime,
  const zcc_native_object *object
) {
  const zcc_native_object *cursor;
  for (cursor = runtime->registry_head; cursor != NULL; cursor = cursor->registry_next) {
    if (cursor == object && cursor->generation == object->generation) return 1;
  }
  return 0;
}

static zcc_native_object *zcc_unwrap_branded(
  napi_env env,
  napi_value value,
  zcc_object_kind expected
) {
  zcc_native_object *object = NULL;
  if (napi_unwrap(env, value, (void **)&object) != napi_ok
      || object == NULL
      || object->magic != ZCC_MAGIC
      || object->kind != expected
      || object->env != env
      || object->runtime != &zcc_process_runtime) {
    return NULL;
  }
  return object;
}

static zcc_native_object *zcc_unwrap_live(
  napi_env env,
  napi_value value,
  zcc_object_kind expected
) {
  zcc_native_object *object = zcc_unwrap_branded(env, value, expected);
  int valid;
  if (object == NULL) return NULL;
  (void)pthread_mutex_lock(&object->runtime->mutex);
  valid = object->state == ZCC_STATE_OPEN
    && object->accepts_commands != 0
    && zcc_registry_contains_locked(object->runtime, object) != 0;
  (void)pthread_mutex_unlock(&object->runtime->mutex);
  return valid != 0 ? object : NULL;
}

static void zcc_object_finalize(napi_env env, void *data, void *hint) {
  zcc_native_object *object = (zcc_native_object *)data;
  (void)env;
  (void)hint;
  zcc_request_close(object, 1);
}

static napi_value zcc_wrap_object(napi_env env, zcc_native_object *object) {
  napi_value result;
  if (napi_create_object(env, &result) != napi_ok) {
    zcc_request_close(object, 1);
    return NULL;
  }
  if (napi_wrap(env, result, object, zcc_object_finalize, NULL, NULL) != napi_ok) {
    zcc_request_close(object, 1);
    return NULL;
  }
  if (napi_object_freeze(env, result) != napi_ok) {
    zcc_request_close(object, 0);
    return NULL;
  }
  return result;
}

static zcc_operation *zcc_new_operation(
  napi_env env,
  zcc_command_kind kind,
  napi_value *promise
) {
  zcc_operation *operation = calloc(1U, sizeof(*operation));
  if (operation == NULL) return NULL;
  operation->target.kind = ZCC_TARGET_CONTROL;
  operation->kind = kind;
  operation->runtime = &zcc_process_runtime;
  operation->result_fd = -1;
  operation->has_promise = 1;
  if (napi_create_promise(env, &operation->deferred, promise) != napi_ok) {
    free(operation);
    return NULL;
  }
  return operation;
}

static void zcc_clear_owner_slot_locked(zcc_operation *operation) {
  zcc_native_object *owner = operation->owner;
  if (owner == NULL) return;
  if (operation->kind == ZCC_COMMAND_ACCEPT) {
    owner->accept_admitted = 0;
    if (owner->pending_accept == operation) owner->pending_accept = NULL;
  } else if (operation->kind == ZCC_COMMAND_READ) {
    owner->read_admitted = 0;
    if (owner->pending_read == operation) owner->pending_read = NULL;
  } else if (operation->kind == ZCC_COMMAND_WRITE) {
    owner->write_admitted = 0;
    if (owner->pending_write == operation) owner->pending_write = NULL;
  }
}

static void zcc_release_operation(napi_env env, zcc_operation *operation) {
  if (operation->owner_ref != NULL) (void)napi_delete_reference(env, operation->owner_ref);
  free(operation->bytes);
  free(operation);
}

void zcc_complete_on_js(napi_env env, napi_value callback, void *context, void *data) {
  zcc_operation *operation = (zcc_operation *)data;
  zcc_runtime *runtime = (zcc_runtime *)context;
  napi_value result = NULL;
  napi_value error;
  int owner_invalid = 0;
  (void)callback;
  if (operation == NULL || runtime == NULL) return;
  if (env == NULL) {
    if (operation->result_object != NULL) {
      operation->result_object->magic = 0U;
      free(operation->result_object);
    }
    free(operation->bytes);
    free(operation);
    return;
  }

  (void)pthread_mutex_lock(&runtime->mutex);
  if (runtime->outstanding_operations > 0U) runtime->outstanding_operations -= 1U;
  if (operation->owner != NULL) {
    if ((operation->kind == ZCC_COMMAND_READ || operation->kind == ZCC_COMMAND_WRITE)
        && (operation->owner->state != ZCC_STATE_OPEN
          || operation->owner->accepts_commands == 0
          || operation->owner->generation != operation->owner_generation)) {
      owner_invalid = 1;
    }
    zcc_clear_owner_slot_locked(operation);
  }
  (void)pthread_mutex_unlock(&runtime->mutex);

  if (owner_invalid != 0 && operation->code[0] == 0) {
    zcc_set_code(operation, "PEER_CONNECTION_CLOSED");
  }
  if (operation->code[0] != 0) {
    error = zcc_coded_error(env, operation->code);
    if (error != NULL) (void)napi_reject_deferred(env, operation->deferred, error);
    zcc_release_operation(env, operation);
    return;
  }

  if (operation->kind == ZCC_COMMAND_CREATE_LISTENER
      || operation->kind == ZCC_COMMAND_ACCEPT
      || operation->kind == ZCC_COMMAND_CONNECT) {
    result = zcc_wrap_object(env, operation->result_object);
    if (result == NULL) {
      error = zcc_coded_error(env, "PEER_CONNECTION_INVALID");
      if (error != NULL) (void)napi_reject_deferred(env, operation->deferred, error);
    } else {
      (void)napi_resolve_deferred(env, operation->deferred, result);
    }
  } else if (operation->kind == ZCC_COMMAND_READ) {
    void *destination = NULL;
    if (napi_create_buffer_copy(
          env,
          operation->length,
          operation->bytes,
          &destination,
          &result
        ) != napi_ok) {
      zcc_request_close(operation->owner, 0);
      error = zcc_coded_error(env, "PEER_CONNECTION_INVALID");
      if (error != NULL) (void)napi_reject_deferred(env, operation->deferred, error);
    } else {
      (void)napi_resolve_deferred(env, operation->deferred, result);
    }
  } else {
    if (napi_get_undefined(env, &result) == napi_ok) {
      (void)napi_resolve_deferred(env, operation->deferred, result);
    }
  }
  zcc_release_operation(env, operation);
}

static napi_value zcc_submit_unowned(napi_env env, zcc_command_kind kind) {
  zcc_operation *operation;
  napi_value promise;
  operation = zcc_new_operation(env, kind, &promise);
  if (operation == NULL) return zcc_rejected(env, "PEER_CONNECTION_INVALID");
  if (zcc_enqueue(&zcc_process_runtime, operation) == 0) {
    return zcc_reject_created_operation(
      env,
      operation,
      promise,
      "PEER_CONNECTION_INVALID"
    );
  }
  return promise;
}

static napi_value zcc_submit_owned(
  napi_env env,
  napi_value owner_value,
  zcc_native_object *owner,
  zcc_command_kind kind,
  unsigned char *bytes,
  size_t length
) {
  zcc_operation *operation;
  napi_value promise;
  int valid = 0;
  int closed = 0;
  operation = zcc_new_operation(env, kind, &promise);
  if (operation == NULL) {
    free(bytes);
    return zcc_rejected(env, "PEER_CONNECTION_INVALID");
  }
  operation->owner = owner;
  operation->owner_generation = owner->generation;
  operation->bytes = bytes;
  operation->length = length;
  if (napi_create_reference(env, owner_value, 1U, &operation->owner_ref) != napi_ok) {
    return zcc_reject_created_operation(
      env,
      operation,
      promise,
      "PEER_CONNECTION_INVALID"
    );
  }

  (void)pthread_mutex_lock(&owner->runtime->mutex);
  if (owner->state == ZCC_STATE_OPEN
      && owner->accepts_commands != 0
      && owner->generation == operation->owner_generation
      && zcc_registry_contains_locked(owner->runtime, owner) != 0) {
    if (kind == ZCC_COMMAND_ACCEPT && owner->accept_admitted == 0) {
      owner->accept_admitted = 1;
      owner->pending_accept = operation;
      valid = 1;
    } else if (kind == ZCC_COMMAND_READ && owner->read_admitted == 0) {
      owner->read_admitted = 1;
      owner->pending_read = operation;
      valid = 1;
    } else if (kind == ZCC_COMMAND_WRITE && owner->write_admitted == 0) {
      owner->write_admitted = 1;
      owner->pending_write = operation;
      valid = 1;
    }
  }
  (void)pthread_mutex_unlock(&owner->runtime->mutex);

  if (valid == 0 || zcc_enqueue(owner->runtime, operation) == 0) {
    (void)pthread_mutex_lock(&owner->runtime->mutex);
    zcc_clear_owner_slot_locked(operation);
    closed = owner->accepts_commands == 0;
    (void)pthread_mutex_unlock(&owner->runtime->mutex);
    (void)napi_delete_reference(env, operation->owner_ref);
    operation->owner_ref = NULL;
    return zcc_reject_created_operation(
      env,
      operation,
      promise,
      closed != 0 ? "PEER_CONNECTION_CLOSED" : "PEER_CONNECTION_INVALID"
    );
  }
  return promise;
}

#if defined(ZCC_AUTHORITY_ARTIFACT)
static napi_value zcc_js_create_listener(napi_env env, napi_callback_info info) {
  size_t argc = 0U;
  if (napi_get_cb_info(env, info, &argc, NULL, NULL, NULL) != napi_ok || argc != 0U) {
    return zcc_rejected(env, "PEER_CONNECTION_INVALID");
  }
  return zcc_submit_unowned(env, ZCC_COMMAND_CREATE_LISTENER);
}

static napi_value zcc_js_accept(napi_env env, napi_callback_info info) {
  size_t argc = 1U;
  napi_value arguments[1];
  zcc_native_object *listener;
  if (napi_get_cb_info(env, info, &argc, arguments, NULL, NULL) != napi_ok || argc != 1U) {
    return zcc_rejected(env, "PEER_CONNECTION_INVALID");
  }
  listener = zcc_unwrap_branded(env, arguments[0], ZCC_OBJECT_LISTENER);
  if (listener == NULL) return zcc_rejected(env, "PEER_CONNECTION_INVALID");
  listener = zcc_unwrap_live(env, arguments[0], ZCC_OBJECT_LISTENER);
  if (listener == NULL) return zcc_rejected(env, "PEER_CONNECTION_CLOSED");
  return zcc_submit_owned(
    env,
    arguments[0],
    listener,
    ZCC_COMMAND_ACCEPT,
    NULL,
    0U
  );
}
#else
static napi_value zcc_js_connect(napi_env env, napi_callback_info info) {
  size_t argc = 0U;
  if (napi_get_cb_info(env, info, &argc, NULL, NULL, NULL) != napi_ok || argc != 0U) {
    return zcc_rejected(env, "PEER_CONNECTION_INVALID");
  }
  return zcc_submit_unowned(env, ZCC_COMMAND_CONNECT);
}
#endif

static napi_value zcc_js_credentials(napi_env env, napi_callback_info info) {
  size_t argc = 1U;
  napi_value arguments[1];
  napi_value result;
  napi_value value;
  zcc_native_object *connection;
  struct ucred credentials;
  napi_property_descriptor properties[] = {
    { "pid", NULL, NULL, NULL, NULL, NULL, napi_enumerable, NULL },
    { "uid", NULL, NULL, NULL, NULL, NULL, napi_enumerable, NULL },
    { "gid", NULL, NULL, NULL, NULL, NULL, napi_enumerable, NULL }
  };
  if (napi_get_cb_info(env, info, &argc, arguments, NULL, NULL) != napi_ok || argc != 1U) {
    zcc_throw(env, "PEER_CONNECTION_INVALID");
    return NULL;
  }
  connection = zcc_unwrap_branded(env, arguments[0], ZCC_OBJECT_CONNECTION);
  if (connection == NULL) {
    zcc_throw(env, "PEER_CONNECTION_INVALID");
    return NULL;
  }
  connection = zcc_unwrap_live(env, arguments[0], ZCC_OBJECT_CONNECTION);
  if (connection == NULL) {
    zcc_throw(env, "PEER_CONNECTION_CLOSED");
    return NULL;
  }
  (void)pthread_mutex_lock(&connection->runtime->mutex);
  credentials = connection->credentials;
  (void)pthread_mutex_unlock(&connection->runtime->mutex);
  if (napi_create_int64(env, (int64_t)credentials.pid, &value) != napi_ok) return NULL;
  properties[0].value = value;
  if (napi_create_uint32(env, (uint32_t)credentials.uid, &value) != napi_ok) return NULL;
  properties[1].value = value;
  if (napi_create_uint32(env, (uint32_t)credentials.gid, &value) != napi_ok) return NULL;
  properties[2].value = value;
  if (napi_create_object(env, &result) != napi_ok
      || napi_define_properties(
        env,
        result,
        sizeof(properties) / sizeof(properties[0]),
        properties
      ) != napi_ok
      || napi_object_freeze(env, result) != napi_ok) {
    return NULL;
  }
  return result;
}

static napi_value zcc_js_read(napi_env env, napi_callback_info info) {
  size_t argc = 1U;
  napi_value arguments[1];
  zcc_native_object *connection;
  if (napi_get_cb_info(env, info, &argc, arguments, NULL, NULL) != napi_ok || argc != 1U) {
    return zcc_rejected(env, "PEER_CONNECTION_INVALID");
  }
  connection = zcc_unwrap_branded(env, arguments[0], ZCC_OBJECT_CONNECTION);
  if (connection == NULL) return zcc_rejected(env, "PEER_CONNECTION_INVALID");
  connection = zcc_unwrap_live(env, arguments[0], ZCC_OBJECT_CONNECTION);
  if (connection == NULL) return zcc_rejected(env, "PEER_CONNECTION_CLOSED");
  return zcc_submit_owned(env, arguments[0], connection, ZCC_COMMAND_READ, NULL, 0U);
}

static napi_value zcc_js_write(napi_env env, napi_callback_info info) {
  size_t argc = 2U;
  napi_value arguments[2];
  zcc_native_object *connection;
  napi_typedarray_type array_type;
  size_t element_count;
  void *data;
  napi_value backing;
  size_t byte_offset;
  unsigned char *frame;
  uint32_t length;
  if (napi_get_cb_info(env, info, &argc, arguments, NULL, NULL) != napi_ok || argc != 2U) {
    return zcc_rejected(env, "PEER_CONNECTION_INVALID");
  }
  connection = zcc_unwrap_branded(env, arguments[0], ZCC_OBJECT_CONNECTION);
  if (connection == NULL) return zcc_rejected(env, "PEER_CONNECTION_INVALID");
  connection = zcc_unwrap_live(env, arguments[0], ZCC_OBJECT_CONNECTION);
  if (connection == NULL) return zcc_rejected(env, "PEER_CONNECTION_CLOSED");
  if (napi_get_typedarray_info(
        env,
        arguments[1],
        &array_type,
        &element_count,
        &data,
        &backing,
        &byte_offset
      ) != napi_ok
      || array_type != napi_uint8_array
      || element_count == 0U
      || element_count > ZCC_MAX_FRAME) {
    return zcc_rejected(env, "PEER_CONNECTION_INVALID");
  }
  (void)backing;
  (void)byte_offset;
  frame = malloc(element_count + 4U);
  if (frame == NULL) return zcc_rejected(env, "PEER_CONNECTION_INVALID");
  length = (uint32_t)element_count;
  frame[0] = (unsigned char)((length >> 24U) & 0xffU);
  frame[1] = (unsigned char)((length >> 16U) & 0xffU);
  frame[2] = (unsigned char)((length >> 8U) & 0xffU);
  frame[3] = (unsigned char)(length & 0xffU);
  memcpy(frame + 4U, data, element_count);
  return zcc_submit_owned(
    env,
    arguments[0],
    connection,
    ZCC_COMMAND_WRITE,
    frame,
    element_count + 4U
  );
}

static napi_value zcc_close_value(
  napi_env env,
  napi_callback_info info,
  zcc_object_kind expected
) {
  size_t argc = 1U;
  napi_value arguments[1];
  napi_value undefined_value;
  zcc_native_object *object;
  if (napi_get_cb_info(env, info, &argc, arguments, NULL, NULL) != napi_ok || argc != 1U) {
    zcc_throw(env, "PEER_CONNECTION_INVALID");
    return NULL;
  }
  object = zcc_unwrap_branded(env, arguments[0], expected);
  if (object == NULL) {
    zcc_throw(env, "PEER_CONNECTION_INVALID");
    return NULL;
  }
  zcc_request_close(object, 0);
  if (napi_get_undefined(env, &undefined_value) != napi_ok) return NULL;
  return undefined_value;
}

static napi_value zcc_js_close_connection(napi_env env, napi_callback_info info) {
  return zcc_close_value(env, info, ZCC_OBJECT_CONNECTION);
}

#if defined(ZCC_AUTHORITY_ARTIFACT)
static napi_value zcc_js_close_listener(napi_env env, napi_callback_info info) {
  return zcc_close_value(env, info, ZCC_OBJECT_LISTENER);
}
#endif

static napi_value zcc_completion_noop(napi_env env, napi_callback_info info) {
  napi_value undefined_value;
  (void)info;
  if (napi_get_undefined(env, &undefined_value) != napi_ok) return NULL;
  return undefined_value;
}

static napi_value zcc_initialize(napi_env env, napi_value exports) {
  uint32_t napi_version = 0U;
  napi_value callback;
  napi_value resource_name;
#if defined(ZCC_AUTHORITY_ARTIFACT)
  napi_property_descriptor descriptors[] = {
    { "createAuthorityListener", NULL, zcc_js_create_listener, NULL, NULL, NULL, napi_default, NULL },
    { "acceptAuthorityConnection", NULL, zcc_js_accept, NULL, NULL, NULL, napi_default, NULL },
    { "getPeerCredentials", NULL, zcc_js_credentials, NULL, NULL, NULL, napi_default, NULL },
    { "readRuntimeFrame", NULL, zcc_js_read, NULL, NULL, NULL, napi_default, NULL },
    { "writeRuntimeFrame", NULL, zcc_js_write, NULL, NULL, NULL, napi_default, NULL },
    { "closeRuntimeConnection", NULL, zcc_js_close_connection, NULL, NULL, NULL, napi_default, NULL },
    { "closeAuthorityListener", NULL, zcc_js_close_listener, NULL, NULL, NULL, napi_default, NULL }
  };
#else
  napi_property_descriptor descriptors[] = {
    { "connectAuthority", NULL, zcc_js_connect, NULL, NULL, NULL, napi_default, NULL },
    { "getPeerCredentials", NULL, zcc_js_credentials, NULL, NULL, NULL, napi_default, NULL },
    { "readRuntimeFrame", NULL, zcc_js_read, NULL, NULL, NULL, napi_default, NULL },
    { "writeRuntimeFrame", NULL, zcc_js_write, NULL, NULL, NULL, napi_default, NULL },
    { "closeRuntimeConnection", NULL, zcc_js_close_connection, NULL, NULL, NULL, napi_default, NULL }
  };
#endif
  if (napi_get_version(env, &napi_version) != napi_ok || napi_version < 8U) {
    zcc_throw(env, "PEER_PLATFORM_UNSUPPORTED");
    return NULL;
  }
  (void)pthread_mutex_lock(&zcc_initialize_mutex);
  if (zcc_environment_claimed != 0) {
    (void)pthread_mutex_unlock(&zcc_initialize_mutex);
    zcc_throw(env, "PEER_CONNECTION_INVALID");
    return NULL;
  }
  zcc_environment_claimed = 1;
  (void)pthread_mutex_unlock(&zcc_initialize_mutex);
  if (zcc_runtime_start(&zcc_process_runtime) != 0) {
    zcc_throw(env, "PEER_PLATFORM_UNSUPPORTED");
    return NULL;
  }
  zcc_process_runtime.env = env;
  if (napi_create_function(
        env,
        "zccTransportCompletion",
        NAPI_AUTO_LENGTH,
        zcc_completion_noop,
        NULL,
        &callback
      ) != napi_ok
      || napi_create_string_utf8(
        env,
        "zccRuntimePeerCompletionQueue",
        NAPI_AUTO_LENGTH,
        &resource_name
      ) != napi_ok
      || napi_create_threadsafe_function(
        env,
        callback,
        NULL,
        resource_name,
        ZCC_COMPLETION_CAPACITY,
        1U,
        NULL,
        NULL,
        &zcc_process_runtime,
        zcc_complete_on_js,
        &zcc_process_runtime.completion_tsfn
      ) != napi_ok
      || napi_add_env_cleanup_hook(env, zcc_runtime_cleanup, &zcc_process_runtime) != napi_ok) {
    zcc_runtime_cleanup(&zcc_process_runtime);
    zcc_throw(env, "PEER_PLATFORM_UNSUPPORTED");
    return NULL;
  }
  if (napi_define_properties(
        env,
        exports,
        sizeof(descriptors) / sizeof(descriptors[0]),
        descriptors
      ) != napi_ok
      || napi_object_freeze(env, exports) != napi_ok) {
    zcc_throw(env, "PEER_PLATFORM_UNSUPPORTED");
    return NULL;
  }
  return exports;
}

NAPI_MODULE(NODE_GYP_MODULE_NAME, zcc_initialize)
