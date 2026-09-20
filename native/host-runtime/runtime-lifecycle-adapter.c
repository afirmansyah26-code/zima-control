#ifndef _GNU_SOURCE
#define _GNU_SOURCE
#endif
#include <errno.h>
#include <fcntl.h>
#include <limits.h>
#include <linux/capability.h>
#include <openssl/crypto.h>
#include <openssl/sha.h>
#include <signal.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/file.h>
#include <sys/prctl.h>
#include <sys/stat.h>
#include <sys/sysmacros.h>
#include <sys/syscall.h>
#include <sys/types.h>
#include <sys/wait.h>
#include <syslog.h>
#include <time.h>
#include <unistd.h>

#define DOCKER "/usr/bin/docker"
#define COMPOSE "/usr/lib/zima-control-center/runtime-trust/compose.yaml"
#define COMPOSE_DIGEST "/usr/lib/zima-control-center/runtime-trust/compose.yaml.sha256"
#define LOCK "/run/authority-runtime-bootstrap/supervisor.lock"
#define PROJECT "zima-control-runtime-trust"
#define STATUS_NOT_RUNNING 3
#define STATUS_AMBIGUOUS 4
#define RESULT_OPERATION_FAILED 70
#define RESULT_TIMEOUT 75
#define RESULT_ENGINE_UNAVAILABLE 76
#define RESULT_STATUS_FAILED 77
#define OPERATION_TIMEOUT_SECONDS 30L
#define AUDIT_EVENT_SCHEMA_VERSION "1"
#define ADAPTER_RELEASE_VERSION "2C-13.2"
#define AUTHORITY_STOPPED "/run/authority-runtime-bootstrap/authority-stopped"
#define ISSUER_STOPPED "/run/authority-runtime-bootstrap/issuer-stopped"
#define RECEIPT_TEMP "/run/authority-runtime-bootstrap/.stopped.tmp"
#define HOST_ROOT "/proc/1/root"
#define HOST_MOUNTINFO "/proc/1/mountinfo"
#define TRUST_DB_DIRECTORY "/var/lib/authority-trust/db"
#define PLATFORM_PROFILE "/var/lib/authority-trust/platform-ownership-profile.json"
#define PLATFORM_PROFILE_MAX 512
#define UDS_DIRECTORY "/run/authority-runtime-trust"
#define KEY_MOUNT "/run/authority-runtime-bootstrap/issuer-active.pk8"
#define MANIFEST_MOUNT "/run/authority-runtime-bootstrap/issuer-boundary.json"
#define READINESS_EPOCH "/run/authority-runtime-bootstrap/authority-readiness-epoch"
#define READINESS_STATE "/run/authority-runtime-bootstrap/authority-readiness-state"
#define AUTHORITY_UID 21012U
#define IPC_GID 21013U

static const unsigned char compose_contract_digest[SHA256_DIGEST_LENGTH] = {
  0x91U,0xbfU,0x8dU,0x85U,0xcdU,0xf6U,0x51U,0x3dU,0xfbU,0xceU,0x96U,0xbdU,0x22U,0x5bU,0xffU,0x84U,
  0xc2U,0xfbU,0xf1U,0x4aU,0x0aU,0xaeU,0xf1U,0x06U,0x97U,0x5fU,0x5fU,0x56U,0xa7U,0x3cU,0x31U,0x18U
};

extern char **environ;
static volatile sig_atomic_t child_process = -1;
static volatile sig_atomic_t termination_signal = 0;

typedef enum lifecycle_lock_status {
  LIFECYCLE_LOCK_ACQUIRED = 0,
  LIFECYCLE_LOCK_BUSY,
  LIFECYCLE_LOCK_FAILED,
  LIFECYCLE_LOCK_INTERRUPTED
} lifecycle_lock_status;

typedef enum lifecycle_operation {
  OP_INVALID = 0,
  OP_START_AUTHORITY,
  OP_STOP_AUTHORITY,
  OP_START_ISSUER,
  OP_STOP_ISSUER,
  OP_STATUS_AUTHORITY,
  OP_STATUS_ISSUER,
  OP_REMOVE_RUNTIME_CONTAINERS
} lifecycle_operation;

typedef struct lifecycle_audit_contract {
  lifecycle_operation kind;
  const char *operation;
  const char *logical_service_identity;
  const char *systemd_unit_identity;
} lifecycle_audit_contract;

static const lifecycle_audit_contract invalid_audit_contract = {
  OP_INVALID, "INVALID_OPERATION", "none", "none"
};

static const lifecycle_audit_contract audit_contracts[] = {
  { OP_START_AUTHORITY, "START_AUTHORITY", "authority-runtime-service",
    "zima-control-runtime-authority.service" },
  { OP_STOP_AUTHORITY, "STOP_AUTHORITY", "authority-runtime-service",
    "zima-control-runtime-authority.service" },
  { OP_START_ISSUER, "START_ISSUER", "issuer-runtime-service",
    "zima-control-runtime-issuer.service" },
  { OP_STOP_ISSUER, "STOP_ISSUER", "issuer-runtime-service",
    "zima-control-runtime-issuer.service" },
  { OP_STATUS_AUTHORITY, "STATUS_AUTHORITY", "authority-runtime-service",
    "zima-control-runtime-stopped-check.service" },
  { OP_STATUS_ISSUER, "STATUS_ISSUER", "issuer-runtime-service",
    "zima-control-runtime-stopped-check.service" },
  { OP_REMOVE_RUNTIME_CONTAINERS, "REMOVE_RUNTIME_CONTAINERS",
    "authority-and-issuer-runtime-services", "zima-control-runtime-uninstall.service" }
};

static const lifecycle_audit_contract *audit_contract_for(int argc, char **argv) {
  size_t index;
  if (argc != 2) return &invalid_audit_contract;
  for (index = 0U; index < sizeof(audit_contracts) / sizeof(audit_contracts[0]); index += 1U) {
    if (strcmp(argv[1], audit_contracts[index].operation) == 0) return &audit_contracts[index];
  }
  return &invalid_audit_contract;
}

static const char *safe_error_code(lifecycle_operation operation, int result) {
  if (result == 0 || result == STATUS_NOT_RUNNING) return "NONE";
  if (result == RESULT_TIMEOUT) return "TIMEOUT";
  if (result == RESULT_ENGINE_UNAVAILABLE) return "ENGINE_UNAVAILABLE";
  if (result == STATUS_AMBIGUOUS) return "AMBIGUOUS_STATE";
  switch (operation) {
    case OP_START_AUTHORITY:
    case OP_START_ISSUER:
      return "START_FAILED";
    case OP_STOP_AUTHORITY:
    case OP_STOP_ISSUER:
      return "STOP_FAILED";
    case OP_STATUS_AUTHORITY:
    case OP_STATUS_ISSUER:
      return "STATUS_FAILED";
    case OP_REMOVE_RUNTIME_CONTAINERS:
      return "CLEANUP_REFUSED";
    default:
      return "INVALID_OPERATION";
  }
}

static void emit_audit_event(const lifecycle_audit_contract *contract,
                             const char *event, const char *outcome,
                             const char *error_code, long long duration_ms,
                             int diagnostic_status) {
  if (duration_ms < 0LL) duration_ms = 0LL;
  if (duration_ms > 3600000LL) duration_ms = 3600000LL;
  syslog(strcmp(outcome, "failure") == 0 ? LOG_ERR : LOG_INFO,
    "auditSchemaVersion=%s component=lifecycle-adapter operation=%s "
    "logicalServiceIdentity=%s event=%s outcome=%s errorCode=%s durationMs=%lld "
    "adapterReleaseVersion=%s systemdUnitIdentity=%s diagnosticStatus=%d",
    AUDIT_EVENT_SCHEMA_VERSION, contract->operation, contract->logical_service_identity,
    event, outcome, error_code, duration_ms, ADAPTER_RELEASE_VERSION,
    contract->systemd_unit_identity, diagnostic_status);
}

static int validate_regular(const char *path, mode_t forbidden, int executable) {
  int fd;
  struct stat before;
  struct stat descriptor;
  struct stat after;
  if (lstat(path, &before) != 0 || !S_ISREG(before.st_mode) || S_ISLNK(before.st_mode)
      || before.st_uid != 0U || before.st_gid != 0U || before.st_nlink != (nlink_t)1
      || (before.st_mode & forbidden) != 0U) return -1;
  if (executable != 0 && (before.st_mode & S_IXUSR) == 0U) return -1;
  fd = open(path, O_RDONLY | O_NOFOLLOW | O_CLOEXEC);
  if (fd < 0 || fstat(fd, &descriptor) != 0 || lstat(path, &after) != 0
      || before.st_dev != descriptor.st_dev || before.st_ino != descriptor.st_ino
      || descriptor.st_dev != after.st_dev || descriptor.st_ino != after.st_ino) {
    if (fd >= 0) { (void)close(fd); }
    return -1;
  }
  (void)close(fd);
  return 0;
}

static int validate_directory_with_owner(const char *path, uid_t uid, gid_t gid, mode_t forbidden) {
  int fd;
  struct stat before;
  struct stat descriptor;
  struct stat after;
  if (lstat(path, &before) != 0 || !S_ISDIR(before.st_mode) || S_ISLNK(before.st_mode)
      || before.st_uid != uid || before.st_gid != gid || (before.st_mode & forbidden) != 0U) return -1;
  fd = open(path, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
  if (fd < 0 || fstat(fd, &descriptor) != 0 || lstat(path, &after) != 0
      || before.st_dev != descriptor.st_dev || before.st_ino != descriptor.st_ino
      || descriptor.st_dev != after.st_dev || descriptor.st_ino != after.st_ino) {
    if (fd >= 0) { (void)close(fd); }
    return -1;
  }
  (void)close(fd);
  return 0;
}

static int validate_directory(const char *path, mode_t forbidden) {
  return validate_directory_with_owner(path, 0U, 0U, forbidden);
}

static int take_literal(const char **cursor, const char *end, const char *literal) {
  size_t length = strlen(literal);
  if ((size_t)(end - *cursor) < length || memcmp(*cursor, literal, length) != 0) return -1;
  *cursor += length;
  return 0;
}

static int validate_installed_ancestors(void) {
  return validate_directory("/", (mode_t)0022) == 0
    && validate_directory("/usr", (mode_t)0022) == 0
    && validate_directory("/usr/lib/zima-control-center", (mode_t)0022) == 0
    && validate_directory("/usr/lib/zima-control-center/runtime-trust", (mode_t)0022) == 0 ? 0 : -1;
}

/* ---- Amendment 2C-13.3-A1: platform ownership profile ---- */

typedef struct {
  unsigned int uid;
  unsigned int gid;
} platform_owner;

typedef struct {
  platform_owner usr_bin;
  platform_owner usr_lib;
  int usr_bin_non_root;
  int usr_lib_non_root;
} platform_profile;

static int parse_platform_uint(const char **cursor, const char *end,
                               unsigned int *output) {
  const char *start = *cursor;
  unsigned long value = 0UL;
  if (*cursor >= end) return -1;
  if (**cursor == '0') {
    *cursor += 1;
    if (*cursor < end && **cursor >= '0' && **cursor <= '9') return -1;
    *output = 0U;
    return 0;
  }
  if (**cursor < '1' || **cursor > '9') return -1;
  while (*cursor < end && **cursor >= '0' && **cursor <= '9') {
    value = value * 10UL + (unsigned long)(**cursor - '0');
    if (value > 2147483647UL) return -1;
    *cursor += 1;
  }
  if (*cursor == start) return -1;
  *output = (unsigned int)value;
  return 0;
}

static int parse_platform_entry(const char **cursor, const char *end,
                                const char *expected_path,
                                platform_owner *owner) {
  if (take_literal(cursor, end, "{\"gid\":") != 0) return -1;
  if (parse_platform_uint(cursor, end, &owner->gid) != 0) return -1;
  if (take_literal(cursor, end, ",\"path\":\"") != 0) return -1;
  {
    size_t path_length = strlen(expected_path);
    if ((size_t)(end - *cursor) < path_length + 1U) return -1;
    if (memcmp(*cursor, expected_path, path_length) != 0) return -1;
    if ((*cursor)[path_length] != '"') return -1;
    *cursor += path_length + 1U;
  }
  if (take_literal(cursor, end, ",\"uid\":") != 0) return -1;
  if (parse_platform_uint(cursor, end, &owner->uid) != 0) return -1;
  if (take_literal(cursor, end, "}") != 0) return -1;
  return 0;
}

static int parse_platform_profile(const char *bytes, size_t length,
                                  platform_profile *profile) {
  const char *cursor = bytes;
  const char *end = bytes + length;
  platform_owner usr_bin;
  platform_owner usr_lib;
  if (take_literal(&cursor, end, "{\"ancestors\":[") != 0) return -1;
  if (parse_platform_entry(&cursor, end, "/usr/bin", &usr_bin) != 0) return -1;
  if (take_literal(&cursor, end, ",") != 0) return -1;
  if (parse_platform_entry(&cursor, end, "/usr/lib", &usr_lib) != 0) return -1;
  if (take_literal(&cursor, end, "],\"schemaVersion\":1}") != 0) return -1;
  if (cursor != end) return -1;
  profile->usr_bin = usr_bin;
  profile->usr_lib = usr_lib;
  profile->usr_bin_non_root = (usr_bin.uid != 0U || usr_bin.gid != 0U);
  profile->usr_lib_non_root = (usr_lib.uid != 0U || usr_lib.gid != 0U);
  return 0;
}

static int load_platform_profile(platform_profile *profile) {
  int fd;
  struct stat before;
  struct stat descriptor;
  struct stat after;
  char bytes[PLATFORM_PROFILE_MAX];
  ssize_t length;
  fd = open(PLATFORM_PROFILE, O_RDONLY | O_NOFOLLOW | O_CLOEXEC);
  if (fd < 0) return -1;
  if (fstat(fd, &before) != 0 || lstat(PLATFORM_PROFILE, &after) != 0) {
    (void)close(fd); return -1;
  }
  if (!S_ISREG(before.st_mode) || before.st_uid != 0U || before.st_gid != 0U
      || before.st_nlink != (nlink_t)1
      || (before.st_mode & (mode_t)07777) != (mode_t)0640
      || before.st_dev != after.st_dev || before.st_ino != after.st_ino) {
    (void)close(fd); return -1;
  }
  length = read(fd, bytes, sizeof(bytes));
  if (fstat(fd, &descriptor) != 0 || lstat(PLATFORM_PROFILE, &after) != 0
      || before.st_dev != descriptor.st_dev || before.st_ino != descriptor.st_ino
      || descriptor.st_dev != after.st_dev || descriptor.st_ino != after.st_ino) {
    (void)close(fd); return -1;
  }
  (void)close(fd);
  if (length <= 0 || length >= (ssize_t)sizeof(bytes)) return -1;
  return parse_platform_profile(bytes, (size_t)length, profile);
}

static int mount_option(const char *options, const char *expected);

static int covering_mount_is_ro(const char *path) {
  FILE *file = fopen(HOST_MOUNTINFO, "re");
  char line[4096];
  size_t best_length = 0U;
  int best_ro = -1;
  int best_count = 0;
  int malformed = 0;
  if (file == NULL) return -1;
  while (fgets(line, (int)sizeof(line), file) != NULL) {
    unsigned long mount_id;
    unsigned int device_major;
    unsigned int device_minor;
    char mount_point[PATH_MAX];
    char options[1024];
    size_t mount_point_length;
    if (strchr(line, '\n') == NULL && feof(file) == 0) { malformed = 1; break; }
    if (sscanf(line, "%lu %*s %u:%u %*s %4095s %1023s",
        &mount_id, &device_major, &device_minor, mount_point, options) == 5
        && mount_id > 0UL) {
      mount_point_length = strlen(mount_point);
      if (mount_point_length <= strlen(path)
          && strncmp(mount_point, path, mount_point_length) == 0) {
        if (mount_point_length > best_length) {
          best_length = mount_point_length;
          best_ro = (mount_option(options, "ro") != 0
            && mount_option(options, "rw") == 0) ? 1 : 0;
          best_count = 1;
        } else if (mount_point_length == best_length) {
          best_count += 1;
        }
      }
    }
  }
  if (ferror(file) != 0) malformed = 1;
  (void)fclose(file);
  if (malformed != 0 || best_count != 1 || best_ro != 1) return -1;
  return 0;
}

static int validate_platform_directory(const char *path, const platform_owner *owner,
                                       int non_root) {
  int fd;
  struct stat before;
  struct stat descriptor;
  struct stat after;
  if (lstat(path, &before) != 0 || !S_ISDIR(before.st_mode) || S_ISLNK(before.st_mode)
      || before.st_uid != (uid_t)owner->uid || before.st_gid != (gid_t)owner->gid
      || (before.st_mode & (mode_t)0022) != 0U) return -1;
  if (non_root != 0 && covering_mount_is_ro(path) != 0) return -1;
  fd = open(path, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
  if (fd < 0 || fstat(fd, &descriptor) != 0 || lstat(path, &after) != 0
      || before.st_dev != descriptor.st_dev || before.st_ino != descriptor.st_ino
      || descriptor.st_dev != after.st_dev || descriptor.st_ino != after.st_ino) {
    if (fd >= 0) { (void)close(fd); }
    return -1;
  }
  (void)close(fd);
  return 0;
}

static int validate_platform_ancestors(void) {
  platform_profile profile;
  if (load_platform_profile(&profile) != 0) return -1;
  if (validate_platform_directory("/usr/bin", &profile.usr_bin,
        profile.usr_bin_non_root) != 0) return -1;
  if (validate_platform_directory("/usr/lib", &profile.usr_lib,
        profile.usr_lib_non_root) != 0) return -1;
  return 0;
}

/* ---- Amendment 2C-13.3-A1 / protected-mount capability contract ---- */

#define CAPTURE_CAPABILITIES ((1U << CAP_SYS_PTRACE) | (1U << CAP_SETPCAP))

static int ambient_capabilities_absent(void) {
  int capability;
  for (capability = 0; capability <= CAP_LAST_CAP; capability += 1) {
    if (prctl(PR_CAP_AMBIENT, PR_CAP_AMBIENT_IS_SET, capability, 0L, 0L) != 0) return -1;
  }
  return 0;
}

static int normalize_inheritable_capabilities(void) {
  struct __user_cap_header_struct header;
  struct __user_cap_data_struct data[2];
  memset(&header, 0, sizeof(header));
  memset(data, 0, sizeof(data));
  header.version = _LINUX_CAPABILITY_VERSION_3;
  if (syscall(SYS_capget, &header, data) != 0) return -1;
  data[0].inheritable = 0U;
  data[1].inheritable = 0U;
  if (syscall(SYS_capset, &header, data) != 0) return -1;
  return 0;
}

static int exact_capture_capabilities(void) {
  struct __user_cap_header_struct header;
  struct __user_cap_data_struct data[2];
  memset(&header, 0, sizeof(header));
  memset(data, 0, sizeof(data));
  header.version = _LINUX_CAPABILITY_VERSION_3;
  if (syscall(SYS_capget, &header, data) != 0
      || data[0].effective != CAPTURE_CAPABILITIES || data[0].permitted != CAPTURE_CAPABILITIES
      || data[0].inheritable != 0U || data[1].effective != 0U
      || data[1].permitted != 0U || data[1].inheritable != 0U) return -1;
  return ambient_capabilities_absent();
}

static int exact_zero_capabilities(void) {
  struct __user_cap_header_struct header;
  struct __user_cap_data_struct data[2];
  memset(&header, 0, sizeof(header));
  memset(data, 0, sizeof(data));
  header.version = _LINUX_CAPABILITY_VERSION_3;
  if (syscall(SYS_capget, &header, data) != 0
      || data[0].effective != 0U || data[0].permitted != 0U || data[0].inheritable != 0U
      || data[1].effective != 0U || data[1].permitted != 0U || data[1].inheritable != 0U) return -1;
  if (prctl(PR_CAPBSET_READ, CAP_SYS_PTRACE, 0L, 0L, 0L) != 0) return -1;
  if (prctl(PR_CAPBSET_READ, CAP_SETPCAP, 0L, 0L, 0L) != 0) return -1;
  return ambient_capabilities_absent();
}

static int drop_capture_capabilities(void) {
  struct __user_cap_header_struct header;
  struct __user_cap_data_struct data[2];
  if (prctl(PR_CAPBSET_DROP, CAP_SYS_PTRACE, 0L, 0L, 0L) != 0) return -1;
  if (prctl(PR_CAPBSET_DROP, CAP_SETPCAP, 0L, 0L, 0L) != 0) return -1;
  memset(&header, 0, sizeof(header));
  memset(data, 0, sizeof(data));
  header.version = _LINUX_CAPABILITY_VERSION_3;
  if (syscall(SYS_capget, &header, data) != 0) return -1;
  data[0].effective = 0U; data[0].permitted = 0U; data[0].inheritable = 0U;
  data[1].effective = 0U; data[1].permitted = 0U; data[1].inheritable = 0U;
  if (syscall(SYS_capset, &header, data) != 0) return -1;
  return 0;
}

static int clear_effective_permitted_capabilities(void) {
  struct __user_cap_header_struct header;
  struct __user_cap_data_struct data[2];
  memset(&header, 0, sizeof(header));
  memset(data, 0, sizeof(data));
  header.version = _LINUX_CAPABILITY_VERSION_3;
  if (syscall(SYS_capget, &header, data) != 0) return -1;
  data[0].effective = 0U; data[0].permitted = 0U; data[0].inheritable = 0U;
  data[1].effective = 0U; data[1].permitted = 0U; data[1].inheritable = 0U;
  if (syscall(SYS_capset, &header, data) != 0) return -1;
  return 0;
}

/* Returns 0 when the bounding set is empty, 1 when it is exactly
 * {CAP_SYS_PTRACE, CAP_SETPCAP}, and -1 for any other state. */
static int bounding_capture_state(void) {
  int capability;
  int ptr = -1;
  int spc = -1;
  int others = 0;
  for (capability = 0; capability <= CAP_LAST_CAP; capability += 1) {
    int present = prctl(PR_CAPBSET_READ, capability, 0L, 0L, 0L);
    if (present < 0) return -1;
    if (capability == CAP_SYS_PTRACE) { ptr = present; continue; }
    if (capability == CAP_SETPCAP) { spc = present; continue; }
    if (present != 0) others += 1;
  }
  if (others != 0) return -1;
  if (ptr == 0 && spc == 0) return 0;
  if (ptr == 1 && spc == 1) return 1;
  return -1;
}

static int transition_non_start_capabilities(void) {
  struct __user_cap_header_struct header;
  struct __user_cap_data_struct data[2];
  int state;
  if (normalize_inheritable_capabilities() != 0) return -1;
  state = bounding_capture_state();
  if (state < 0) return -1;
  if (state == 1) {
    memset(&header, 0, sizeof(header));
    memset(data, 0, sizeof(data));
    header.version = _LINUX_CAPABILITY_VERSION_3;
    if (syscall(SYS_capget, &header, data) != 0) return -1;
    if ((data[0].effective & (1U << CAP_SETPCAP)) == 0U) return -1;
    if (prctl(PR_CAPBSET_DROP, CAP_SYS_PTRACE, 0L, 0L, 0L) != 0) return -1;
    if (prctl(PR_CAPBSET_DROP, CAP_SETPCAP, 0L, 0L, 0L) != 0) return -1;
  }
  return clear_effective_permitted_capabilities();
}

static int full_write(int fd, const char *bytes, size_t length) {
  size_t offset = 0U;
  while (offset < length) {
    ssize_t count = write(fd, bytes + offset, length - offset);
    if (count < 0 && errno == EINTR) continue;
    if (count <= 0) return -1;
    offset += (size_t)count;
  }
  return 0;
}

static int write_stopped_receipt(const char *path, const char *service) {
  int boot_fd = -1;
  int receipt_fd = -1;
  int directory_fd = -1;
  char boot[38];
  char record[160];
  ssize_t boot_length;
  int record_length;
  struct timespec now;
  (void)unlink(RECEIPT_TEMP);
  boot_fd = open("/proc/sys/kernel/random/boot_id", O_RDONLY | O_NOFOLLOW | O_CLOEXEC);
  if (boot_fd < 0) goto fail;
  do { boot_length = read(boot_fd, boot, sizeof(boot)); } while (boot_length < 0 && errno == EINTR);
  (void)close(boot_fd); boot_fd = -1;
  if (boot_length != 37 || boot[36] != '\n' || clock_gettime(CLOCK_BOOTTIME, &now) != 0) goto fail;
  boot[36] = '\0';
  record_length = snprintf(record, sizeof(record),
    "ZCC_RUNTIME_STOPPED_V1\nservice=%s\nbootId=%s\nmonotonicSeconds=%lld\n",
    service, boot, (long long)now.tv_sec);
  if (record_length <= 0 || (size_t)record_length >= sizeof(record)) goto fail;
  receipt_fd = open(RECEIPT_TEMP, O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC | O_WRONLY, (mode_t)0600);
  if (receipt_fd < 0 || fchown(receipt_fd, 0U, 0U) != 0 || fchmod(receipt_fd, (mode_t)0600) != 0
      || full_write(receipt_fd, record, (size_t)record_length) != 0 || fdatasync(receipt_fd) != 0) goto fail;
  (void)close(receipt_fd); receipt_fd = -1;
  if (rename(RECEIPT_TEMP, path) != 0) goto fail;
  directory_fd = open("/run/authority-runtime-bootstrap", O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
  if (directory_fd < 0 || fsync(directory_fd) != 0) goto fail;
  (void)close(directory_fd);
  return 0;
fail:
  if (directory_fd >= 0) (void)close(directory_fd);
  if (receipt_fd >= 0) (void)close(receipt_fd);
  if (boot_fd >= 0) (void)close(boot_fd);
  (void)unlink(RECEIPT_TEMP);
  return -1;
}

static int valid_image_digest(const char *value, size_t length) {
  size_t marker;
  size_t index;
  if (length < 73U) return 0;
  marker = length - 72U;
  if (marker == 0U || memcmp(value + marker, "@sha256:", 8U) != 0) return 0;
  for (index = 0U; index < marker; index += 1U) {
    unsigned char item = (unsigned char)value[index];
    if (!((item >= 'A' && item <= 'Z') || (item >= 'a' && item <= 'z')
        || (item >= '0' && item <= '9') || item == '.' || item == '/' || item == '_'
        || item == '-' || item == ':')) return 0;
  }
  for (index = marker + 8U; index < length; index += 1U) {
    if (!((value[index] >= '0' && value[index] <= '9')
        || (value[index] >= 'a' && value[index] <= 'f'))) return 0;
  }
  return 1;
}

static int append_bytes(char *output, size_t capacity, size_t *used,
                        const char *bytes, size_t length) {
  if (*used + length > capacity) return -1;
  memcpy(output + *used, bytes, length); *used += length;
  return 0;
}

static int compose_issuer_gid(const char *input, size_t input_length,
                              char output[11], gid_t *gid) {
  const char *cursor = input;
  const char *end = input + input_length;
  unsigned int line_number = 1U;
  size_t gid_length = 0U;
  char *gid_end;
  unsigned long expected_group;
  while (line_number < 49U && cursor < end) {
    const char *newline = memchr(cursor, '\n', (size_t)(end - cursor));
    if (newline == NULL) return -1;
    cursor = newline + 1;
    line_number += 1U;
  }
  if ((size_t)(end - cursor) < 12U || memcmp(cursor, "      - \"", 9U) != 0) return -1;
  cursor += 9U;
  while (cursor < end && *cursor >= '0' && *cursor <= '9' && gid_length < 10U) {
    output[gid_length++] = *cursor++;
  }
  output[gid_length] = '\0';
  if (gid_length == 0U || (gid_length > 1U && output[0] == '0')
      || cursor + 2 > end || cursor[0] != '"' || cursor[1] != '\n') return -1;
  errno = 0;
  expected_group = strtoul(output, &gid_end, 10);
  if (errno != 0 || *gid_end != '\0' || expected_group > (unsigned long)UINT_MAX
      || expected_group == 0UL || expected_group == 21011UL
      || expected_group == 21012UL || expected_group == 21013UL) return -1;
  *gid = (gid_t)expected_group;
  return 0;
}

static int normalized_replacement(const char *line, size_t length, unsigned int number,
                                  const char *expected_gid, const char **replacement) {
  *replacement = NULL;
  if (number == 3U || number == 45U) {
    if (length <= 12U || memcmp(line, "    image: ", 11U) != 0
        || valid_image_digest(line + 11U, length - 12U) == 0) return -1;
    *replacement = number == 3U ? "    image: __AUTHORITY_IMAGE_DIGEST__\n"
      : "    image: __ISSUER_IMAGE_DIGEST__\n";
  } else if (number == 49U) {
    static const char gid_replacement[] = {
      ' ', ' ', ' ', ' ', ' ', ' ', '-', ' ', 34,
      '_', '_', 'I', 'S', 'S', 'U', 'E', 'R', '_', 'R', 'E', 'A', 'D', '_', 'G', 'I', 'D', '_', '_', 34, 10, 0
    };
    size_t gid_length = strlen(expected_gid);
    if (length != gid_length + 11U || memcmp(line, "      - ", 8U) != 0
        || line[8] != (char)34 || memcmp(line + 9U, expected_gid, gid_length) != 0
        || line[9U + gid_length] != (char)34 || line[10U + gid_length] != '\n') return -1;
    *replacement = gid_replacement;
  }
  return 0;
}

static int normalize_compose(const char *input, size_t input_length,
                             const char *expected_gid, char output[4097], size_t *output_length) {
  const char *cursor = input;
  const char *end = input + input_length;
  size_t used = 0U;
  unsigned int line_number = 0U;
  while (cursor < end) {
    const char *newline = memchr(cursor, '\n', (size_t)(end - cursor));
    const char *replacement;
    size_t line_length;
    if (newline == NULL) return -1;
    line_number += 1U;
    line_length = (size_t)(newline - cursor) + 1U;
    if (normalized_replacement(cursor, line_length, line_number, expected_gid, &replacement) != 0) return -1;
    if (replacement != NULL) {
      if (append_bytes(output, 4096U, &used, replacement, strlen(replacement)) != 0) return -1;
    } else if (append_bytes(output, 4096U, &used, cursor, line_length) != 0) return -1;
    cursor += line_length;
  }
  if (line_number != 80U) return -1;
  *output_length = used;
  return 0;
}

static int validate_installed_compose_digest(const char *compose, size_t compose_length) {
  int fd;
  char expected[66];
  char actual[65];
  unsigned char digest[SHA256_DIGEST_LENGTH];
  ssize_t length;
  size_t index;
  struct stat before;
  struct stat after;
  struct stat path_after;
  fd = open(COMPOSE_DIGEST, O_RDONLY | O_NOFOLLOW | O_CLOEXEC);
  if (fd < 0 || fstat(fd, &before) != 0) { if (fd >= 0) (void)close(fd); return -1; }
  length = read(fd, expected, sizeof(expected));
  if (fstat(fd, &after) != 0 || lstat(COMPOSE_DIGEST, &path_after) != 0) { (void)close(fd); return -1; }
  (void)close(fd);
  if (length != 65 || expected[64] != '\n' || before.st_dev != after.st_dev
      || before.st_ino != after.st_ino || after.st_dev != path_after.st_dev
      || after.st_ino != path_after.st_ino
      || SHA256((const unsigned char *)compose, compose_length, digest) == NULL) return -1;
  for (index = 0U; index < sizeof(digest); index += 1U) {
    (void)snprintf(actual + index * 2U, 3U, "%02x", digest[index]);
  }
  actual[64] = '\0';
  return CRYPTO_memcmp(actual, expected, 64U) == 0 ? 0 : -1;
}

static int validate_compose(gid_t *issuer_gid) {
  int fd;
  char bytes[4097];
  char normalized[4097];
  char expected_gid[11];
  unsigned char digest[SHA256_DIGEST_LENGTH];
  ssize_t length;
  size_t normalized_length;
  struct stat before;
  struct stat after;
  struct stat path_after;
  if (validate_regular(COMPOSE, (mode_t)0022, 0) != 0
      || validate_regular(COMPOSE_DIGEST, (mode_t)0022, 0) != 0
      || lstat(COMPOSE, &path_after) != 0 || (path_after.st_mode & (mode_t)07777) != (mode_t)0644
      || lstat(COMPOSE_DIGEST, &path_after) != 0
      || (path_after.st_mode & (mode_t)07777) != (mode_t)0644) return -1;
  fd = open(COMPOSE, O_RDONLY | O_NOFOLLOW | O_CLOEXEC);
  if (fd < 0 || fstat(fd, &before) != 0) { if (fd >= 0) (void)close(fd); return -1; }
  length = read(fd, bytes, sizeof(bytes) - 1U);
  if (fstat(fd, &after) != 0 || lstat(COMPOSE, &path_after) != 0) { (void)close(fd); return -1; }
  (void)close(fd);
  if (length <= 0 || length >= (ssize_t)(sizeof(bytes) - 1U)
      || before.st_dev != after.st_dev || before.st_ino != after.st_ino
      || after.st_dev != path_after.st_dev || after.st_ino != path_after.st_ino
      || validate_installed_compose_digest(bytes, (size_t)length) != 0
      || compose_issuer_gid(bytes, (size_t)length, expected_gid, issuer_gid) != 0
      || normalize_compose(bytes, (size_t)length, expected_gid, normalized, &normalized_length) != 0
      || normalized_length != 2344U
      || SHA256((const unsigned char *)normalized, normalized_length, digest) == NULL
      || CRYPTO_memcmp(digest, compose_contract_digest, sizeof(digest)) != 0) return -1;
  return 0;
}

typedef struct {
  unsigned long mount_id;
  unsigned int device_major;
  unsigned int device_minor;
} prepared_mount_identity;

static int mount_option(const char *options, const char *expected) {
  const char *cursor = options;
  size_t expected_length = strlen(expected);
  while (cursor != NULL && *cursor != '\0') {
    const char *end = strchr(cursor, ',');
    size_t length = end == NULL ? strlen(cursor) : (size_t)(end - cursor);
    if (length == expected_length && memcmp(cursor, expected, length) == 0) return 1;
    cursor = end == NULL ? NULL : end + 1;
  }
  return 0;
}

static int host_path(const char *path, char output[PATH_MAX]) {
  int length = snprintf(output, PATH_MAX, "%s%s", HOST_ROOT, path);
  return length > 0 && length < PATH_MAX ? 0 : -1;
}

static int read_prepared_mount(const char *path, int read_only,
                               prepared_mount_identity *identity) {
  FILE *file = fopen(HOST_MOUNTINFO, "re");
  char line[4096];
  int matches = 0;
  int valid = 0;
  prepared_mount_identity candidate = { 0UL, 0U, 0U };
  if (file == NULL) return -1;
  while (fgets(line, (int)sizeof(line), file) != NULL) {
    unsigned long mount_id;
    unsigned int device_major;
    unsigned int device_minor;
    char mount_point[PATH_MAX];
    char options[1024];
    if (strchr(line, '\n') == NULL && feof(file) == 0) { matches = -1; break; }
    if (sscanf(line, "%lu %*s %u:%u %*s %4095s %1023s",
        &mount_id, &device_major, &device_minor, mount_point, options) == 5
        && strcmp(mount_point, path) == 0) {
      matches += 1;
      candidate.mount_id = mount_id;
      candidate.device_major = device_major;
      candidate.device_minor = device_minor;
      valid = mount_id > 0UL
        && mount_option(options, read_only != 0 ? "ro" : "rw")
        && !mount_option(options, read_only != 0 ? "rw" : "ro")
        && mount_option(options, "nodev") && !mount_option(options, "dev")
        && mount_option(options, "nosuid") && !mount_option(options, "suid")
        && mount_option(options, "noexec") && !mount_option(options, "exec");
    }
  }
  if (ferror(file) != 0) matches = -1;
  (void)fclose(file);
  if (matches != 1 || valid == 0) return -1;
  *identity = candidate;
  return 0;
}

static int validate_host_ancestor(const char *path, uid_t uid, gid_t gid,
                                  mode_t mode, int exact) {
  char resolved[PATH_MAX];
  int fd;
  struct stat before;
  struct stat descriptor;
  struct stat after;
  if (host_path(path, resolved) != 0 || lstat(resolved, &before) != 0
      || !S_ISDIR(before.st_mode) || S_ISLNK(before.st_mode) || before.st_uid != uid
      || (exact != 0 && (before.st_gid != gid || (before.st_mode & (mode_t)07777) != mode))
      || (exact == 0 && (before.st_mode & (mode_t)0022) != 0)) return -1;
  fd = open(resolved, O_PATH | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
  if (fd < 0 || fstat(fd, &descriptor) != 0 || lstat(resolved, &after) != 0
      || before.st_dev != descriptor.st_dev || before.st_ino != descriptor.st_ino
      || descriptor.st_dev != after.st_dev || descriptor.st_ino != after.st_ino) {
    if (fd >= 0) (void)close(fd);
    return -1;
  }
  (void)close(fd);
  return 0;
}

static int validate_prepared_mount(const char *path, mode_t kind, uid_t uid, gid_t gid,
                                   mode_t mode, int one_link, int read_only) {
  char resolved[PATH_MAX];
  int fd;
  struct stat before;
  struct stat descriptor;
  struct stat after;
  prepared_mount_identity first;
  prepared_mount_identity second;
  if (host_path(path, resolved) != 0 || lstat(resolved, &before) != 0
      || (before.st_mode & S_IFMT) != kind || S_ISLNK(before.st_mode)
      || before.st_uid != uid || before.st_gid != gid
      || (before.st_mode & (mode_t)07777) != mode
      || (one_link != 0 && before.st_nlink != (nlink_t)1)
      || read_prepared_mount(path, read_only, &first) != 0
      || first.device_major != (unsigned int)major(before.st_dev)
      || first.device_minor != (unsigned int)minor(before.st_dev)) return -1;
  fd = open(resolved, O_PATH | O_NOFOLLOW | O_CLOEXEC);
  if (fd < 0 || fstat(fd, &descriptor) != 0 || lstat(resolved, &after) != 0
      || read_prepared_mount(path, read_only, &second) != 0
      || before.st_dev != descriptor.st_dev || before.st_ino != descriptor.st_ino
      || descriptor.st_dev != after.st_dev || descriptor.st_ino != after.st_ino
      || first.mount_id != second.mount_id || first.device_major != second.device_major
      || first.device_minor != second.device_minor) {
    if (fd >= 0) (void)close(fd);
    return -1;
  }
  (void)close(fd);
  return 0;
}

static int validate_prepared_sources(int authority, gid_t issuer_gid) {
  struct stat namespace_before;
  struct stat namespace_after;
  if (stat("/proc/1/ns/mnt", &namespace_before) != 0
      || namespace_before.st_dev == 0U || namespace_before.st_ino == 0U
      || validate_host_ancestor("/", 0U, 0U, 0U, 0) != 0
      || validate_host_ancestor("/run", 0U, 0U, 0U, 0) != 0
      || validate_host_ancestor("/run/authority-runtime-bootstrap", 0U, (gid_t)AUTHORITY_UID, (mode_t)0710, 1) != 0
      || validate_host_ancestor("/run/authority-runtime-trust", (uid_t)AUTHORITY_UID,
        (gid_t)IPC_GID, (mode_t)02750, 1) != 0) return -1;
  if (authority != 0) {
    if (validate_host_ancestor("/var", 0U, 0U, 0U, 0) != 0
        || validate_host_ancestor("/var/lib", 0U, 0U, 0U, 0) != 0
        || validate_prepared_mount(TRUST_DB_DIRECTORY, S_IFDIR, 0U, (gid_t)AUTHORITY_UID,
          (mode_t)0750, 0, 1) != 0
        || validate_prepared_mount(UDS_DIRECTORY, S_IFDIR, (uid_t)AUTHORITY_UID, (gid_t)IPC_GID,
          (mode_t)02750, 0, 0) != 0
        || validate_prepared_mount(READINESS_EPOCH, S_IFREG, 0U, (gid_t)AUTHORITY_UID,
          (mode_t)0440, 1, 1) != 0
        || validate_prepared_mount(READINESS_STATE, S_IFREG, (uid_t)AUTHORITY_UID,
          (gid_t)AUTHORITY_UID, (mode_t)0600, 1, 0) != 0) return -1;
  } else {
    if (validate_prepared_mount(UDS_DIRECTORY, S_IFDIR, (uid_t)AUTHORITY_UID, (gid_t)IPC_GID,
          (mode_t)02750, 0, 0) != 0
        || validate_prepared_mount(KEY_MOUNT, S_IFREG, 0U, issuer_gid,
          (mode_t)0640, 1, 1) != 0
        || validate_prepared_mount(MANIFEST_MOUNT, S_IFREG, 0U, issuer_gid,
          (mode_t)0640, 1, 1) != 0) return -1;
  }
  return stat("/proc/1/ns/mnt", &namespace_after) == 0
    && namespace_before.st_dev == namespace_after.st_dev
    && namespace_before.st_ino == namespace_after.st_ino ? 0 : -1;
}

static void forward_signal(int signal_number) {
  pid_t current = (pid_t)child_process;
  termination_signal = (sig_atomic_t)signal_number;
  if (current > 0) (void)kill(-current, signal_number);
}

static int install_signal_handlers(void) {
  struct sigaction action;
  memset(&action, 0, sizeof(action));
  action.sa_handler = forward_signal;
  if (sigemptyset(&action.sa_mask) != 0) return -1;
  if (sigaction(SIGTERM, &action, NULL) != 0 || sigaction(SIGINT, &action, NULL) != 0
      || sigaction(SIGHUP, &action, NULL) != 0) return -1;
  return 0;
}

static lifecycle_lock_status acquire_lifecycle_lock(int descriptor) {
  if (termination_signal != 0) return LIFECYCLE_LOCK_INTERRUPTED;
  if (flock(descriptor, LOCK_EX | LOCK_NB) == 0) {
    return termination_signal == 0 ? LIFECYCLE_LOCK_ACQUIRED : LIFECYCLE_LOCK_INTERRUPTED;
  }
  if (errno == EWOULDBLOCK || errno == EAGAIN) return LIFECYCLE_LOCK_BUSY;
  if (errno == EINTR && termination_signal != 0) return LIFECYCLE_LOCK_INTERRUPTED;
  return LIFECYCLE_LOCK_FAILED;
}

static void child_stdio(int status_fd) {
  int null_fd = open("/dev/null", O_RDWR | O_CLOEXEC);
  if (null_fd < 0) _exit(125);
  if (dup2(null_fd, STDIN_FILENO) < 0
      || dup2(status_fd >= 0 ? status_fd : null_fd, STDOUT_FILENO) < 0
      || dup2(null_fd, STDERR_FILENO) < 0) _exit(125);
  if (null_fd > STDERR_FILENO) (void)close(null_fd);
  if (status_fd > STDERR_FILENO) (void)close(status_fd);
}

static int elapsed_at_least(const struct timespec *start, long seconds) {
  struct timespec now;
  if (clock_gettime(CLOCK_MONOTONIC, &now) != 0) return -1;
  if (now.tv_sec - start->tv_sec > seconds) return 1;
  if (now.tv_sec - start->tv_sec == seconds && now.tv_nsec >= start->tv_nsec) return 1;
  return 0;
}

static long long elapsed_milliseconds(const struct timespec *start) {
  struct timespec now;
  long long seconds;
  long nanoseconds;
  if (clock_gettime(CLOCK_MONOTONIC, &now) != 0) return -1LL;
  seconds = (long long)(now.tv_sec - start->tv_sec);
  nanoseconds = now.tv_nsec - start->tv_nsec;
  if (nanoseconds < 0L) { seconds -= 1LL; nanoseconds += 1000000000L; }
  return seconds * 1000LL + (long long)(nanoseconds / 1000000L);
}

static int valid_container_id(const char *bytes, size_t length) {
  size_t index;
  if (length < 12U || length > 65U || bytes[length - 1U] != (char)10) return 0;
  for (index = 0U; index + 1U < length; index += 1U) {
    if (!((bytes[index] >= '0' && bytes[index] <= '9')
        || (bytes[index] >= 'a' && bytes[index] <= 'f'))) return 0;
  }
  return 1;
}

static int wait_for_child(pid_t child, int attached, int *status) {
  struct timespec start;
  struct timespec pause = { .tv_sec = 0, .tv_nsec = 100000000L };
  if (clock_gettime(CLOCK_MONOTONIC, &start) != 0) return -1;
  for (;;) {
    pid_t waited = waitpid(child, status, attached != 0 ? 0 : WNOHANG);
    if (waited == child) return 0;
    if (waited < 0 && errno != EINTR) return -1;
    if (attached != 0) continue;
    {
      int expired = elapsed_at_least(&start, OPERATION_TIMEOUT_SECONDS);
      if (expired < 0) return -1;
      if (expired != 0) {
        (void)kill(-child, SIGTERM);
        pause.tv_sec = 0; pause.tv_nsec = 200000000L;
        while (nanosleep(&pause, &pause) != 0 && errno == EINTR) { }
        (void)kill(-child, SIGKILL);
        while (waitpid(child, status, 0) < 0 && errno == EINTR) { }
        return 1;
      }
    }
    pause.tv_sec = 0; pause.tv_nsec = 100000000L;
    while (nanosleep(&pause, &pause) != 0 && errno == EINTR) { }
  }
}

static int run_operation(char *const command[], int attached, int status_mode) {
  int output_pipe[2] = { -1, -1 };
  int status = 0;
  char output[67];
  ssize_t length = 0;
  pid_t child;
  int wait_result;
  if (status_mode != 0 && pipe2(output_pipe, O_CLOEXEC) != 0) return RESULT_STATUS_FAILED;
  child = fork();
  if (child < 0) {
    if (output_pipe[0] >= 0) { (void)close(output_pipe[0]); (void)close(output_pipe[1]); }
    return status_mode != 0 ? RESULT_STATUS_FAILED : RESULT_OPERATION_FAILED;
  }
  if (child == 0) {
    if (setpgid(0, 0) != 0) _exit(125);
    if (status_mode != 0) (void)close(output_pipe[0]);
    child_stdio(status_mode != 0 ? output_pipe[1] : -1);
    execve(DOCKER, command, environ);
    _exit(errno == ENOENT ? 126 : 125);
  }
  child_process = (sig_atomic_t)child;
  (void)setpgid(child, child);
  if (status_mode != 0) (void)close(output_pipe[1]);
  wait_result = wait_for_child(child, attached, &status);
  if (wait_result != 0) {
    if (output_pipe[0] >= 0) (void)close(output_pipe[0]);
    child_process = -1;
    if (wait_result == 1) return RESULT_TIMEOUT;
    return status_mode != 0 ? RESULT_STATUS_FAILED : RESULT_OPERATION_FAILED;
  }
  child_process = -1;
  if (status_mode != 0) {
    do { length = read(output_pipe[0], output, sizeof(output)); } while (length < 0 && errno == EINTR);
    (void)close(output_pipe[0]);
    if (!WIFEXITED(status) || length < 0) return RESULT_STATUS_FAILED;
    if (WEXITSTATUS(status) == 126) return RESULT_ENGINE_UNAVAILABLE;
    if (WEXITSTATUS(status) != 0) return RESULT_STATUS_FAILED;
    if (length == 0) return STATUS_NOT_RUNNING;
    return valid_container_id(output, (size_t)length) != 0 ? 0 : STATUS_AMBIGUOUS;
  }
  if (!WIFEXITED(status)) return RESULT_OPERATION_FAILED;
  if (WEXITSTATUS(status) == 126) return RESULT_ENGINE_UNAVAILABLE;
  return WEXITSTATUS(status) == 0 ? 0 : RESULT_OPERATION_FAILED;
}

static int validate_compose_cli(void) {
  int output_pipe[2];
  int status = 0;
  char output[32];
  ssize_t length;
  pid_t child;
  int wait_result;
  int configuration_result;
  char *version[] = { (char *)DOCKER, (char *)"compose", (char *)"version", (char *)"--short", NULL };
  char *configuration[] = {
    (char *)DOCKER, (char *)"compose", (char *)"--project-name", (char *)PROJECT,
    (char *)"--file", (char *)COMPOSE, (char *)"config", (char *)"--quiet", NULL
  };
  if (pipe2(output_pipe, O_CLOEXEC) != 0) return -1;
  child = fork();
  if (child < 0) { (void)close(output_pipe[0]); (void)close(output_pipe[1]); return -1; }
  if (child == 0) {
    (void)close(output_pipe[0]);
    if (setpgid(0, 0) != 0) _exit(125);
    child_stdio(output_pipe[1]);
    execve(DOCKER, version, environ);
    _exit(125);
  }
  child_process = (sig_atomic_t)child;
  (void)setpgid(child, child);
  (void)close(output_pipe[1]);
  wait_result = wait_for_child(child, 0, &status);
  if (wait_result != 0) {
    (void)close(output_pipe[0]);
    child_process = -1;
    return wait_result == 1 ? RESULT_TIMEOUT : RESULT_ENGINE_UNAVAILABLE;
  }
  child_process = -1;
  do { length = read(output_pipe[0], output, sizeof(output)); } while (length < 0 && errno == EINTR);
  (void)close(output_pipe[0]);
  if (!WIFEXITED(status) || WEXITSTATUS(status) != 0) return RESULT_ENGINE_UNAVAILABLE;
  if (length != 7 || memcmp(output, "2.32.4\n", 7U) != 0) return -1;
  configuration_result = run_operation(configuration, 0, 0);
  if (configuration_result == RESULT_TIMEOUT
      || configuration_result == RESULT_ENGINE_UNAVAILABLE) return configuration_result;
  return configuration_result == 0 ? 0 : -1;
}

int main(int argc, char **argv) {
  int lock_fd = -1;
  lifecycle_lock_status lock_status;
  struct stat lock_node;
  struct stat lock_parent;
  int attached = 0;
  int status_mode = 0;
  int result = 64;
  int compose_cli_result;
  int prepared_role = -1;
  gid_t issuer_gid = 0U;
  const char *status_receipt = NULL;
  const char *status_service = NULL;
  const char *result_event = "completed";
  const char *error_code = "INVALID_OPERATION";
  const lifecycle_audit_contract *audit_contract = audit_contract_for(argc, argv);
  struct timespec started;
  int clock_valid = clock_gettime(CLOCK_MONOTONIC, &started) == 0;
  char *command[] = {
    (char *)DOCKER, (char *)"compose", (char *)"--project-name", (char *)PROJECT,
    (char *)"--file", (char *)COMPOSE, NULL, NULL, NULL, NULL, NULL, NULL, NULL
  };
  size_t index = 6U;

  openlog("zima-control-runtime-lifecycle", LOG_PID | LOG_NDELAY, LOG_AUTHPRIV);
  emit_audit_event(audit_contract, "requested", "requested", "NONE", 0LL, 0);
  if (audit_contract->kind == OP_INVALID || getuid() != 0U || geteuid() != 0U) {
    result_event = "rejected";
    goto finish;
  }
  if (clock_valid == 0) {
    result = 67;
    error_code = "INVALID_INSTALLATION";
    goto finish;
  }
  if (audit_contract->kind == OP_START_AUTHORITY || audit_contract->kind == OP_START_ISSUER) {
    if (normalize_inheritable_capabilities() != 0
        || exact_capture_capabilities() != 0) {
      result = 68;
      error_code = "INVALID_INSTALLATION";
      goto finish;
    }
  } else {
    if (transition_non_start_capabilities() != 0
        || exact_zero_capabilities() != 0) {
      result = 68;
      error_code = "INVALID_INSTALLATION";
      goto finish;
    }
  }
  if (validate_directory("/run", (mode_t)0022) != 0
      || validate_directory_with_owner("/run/authority-runtime-bootstrap", 0U, (gid_t)AUTHORITY_UID, (mode_t)07067) != 0
      || lstat("/run/authority-runtime-bootstrap", &lock_parent) != 0
      || lock_parent.st_uid != 0U || lock_parent.st_gid != (gid_t)AUTHORITY_UID
      || (lock_parent.st_mode & (mode_t)07777) != (mode_t)0710) {
    result = 66;
    error_code = "INVALID_INSTALLATION";
    goto finish;
  }
  if (install_signal_handlers() != 0) {
    result = 67;
    error_code = "INVALID_INSTALLATION";
    goto finish;
  }
  lock_fd = open(LOCK, O_CREAT | O_RDWR | O_NOFOLLOW | O_CLOEXEC, (mode_t)0600);
  if (lock_fd < 0 || fchown(lock_fd, 0U, 0U) != 0 || fchmod(lock_fd, (mode_t)0600) != 0
      || fstat(lock_fd, &lock_node) != 0 || !S_ISREG(lock_node.st_mode)
      || lock_node.st_uid != 0U || lock_node.st_gid != 0U
      || (lock_node.st_mode & (mode_t)07777) != (mode_t)0600 || lock_node.st_nlink != (nlink_t)1) {
    result = 67;
    error_code = "INVALID_INSTALLATION";
    goto finish;
  }
  lock_status = acquire_lifecycle_lock(lock_fd);
  if (lock_status == LIFECYCLE_LOCK_BUSY) {
    result = 66;
    result_event = "rejected";
    error_code = "LOCK_BUSY";
    goto finish;
  }
  if (lock_status == LIFECYCLE_LOCK_INTERRUPTED) {
    result = 128 + (int)termination_signal;
    error_code = safe_error_code(audit_contract->kind, result);
    goto finish;
  }
  if (lock_status != LIFECYCLE_LOCK_ACQUIRED) {
    result = 67;
    error_code = "INVALID_INSTALLATION";
    goto finish;
  }
  if (clearenv() != 0 || chdir("/") != 0) {
    result = 67;
    error_code = "INVALID_INSTALLATION";
    goto finish;
  }
  environ = (char *[]){ NULL };
  (void)umask((mode_t)0077);
  if (validate_installed_ancestors() != 0 || validate_platform_ancestors() != 0
      || validate_regular(DOCKER, (mode_t)0022, 1) != 0
      || validate_compose(&issuer_gid) != 0) {
    result = 65;
    error_code = "INVALID_INSTALLATION";
    goto finish;
  }
  if (audit_contract->kind == OP_START_AUTHORITY) prepared_role = 1;
  else if (audit_contract->kind == OP_START_ISSUER) prepared_role = 0;
  if (prepared_role >= 0) {
    if (validate_prepared_sources(prepared_role, issuer_gid) != 0) {
      result = 68;
      error_code = "INVALID_INSTALLATION";
      goto finish;
    }
    if (drop_capture_capabilities() != 0 || exact_zero_capabilities() != 0) {
      result = 68;
      error_code = "INVALID_INSTALLATION";
      goto finish;
    }
  }
  compose_cli_result = validate_compose_cli();
  if (compose_cli_result != 0) {
    result = compose_cli_result == RESULT_TIMEOUT || compose_cli_result == RESULT_ENGINE_UNAVAILABLE
      ? compose_cli_result : 65;
    error_code = compose_cli_result == RESULT_TIMEOUT ? "TIMEOUT"
      : compose_cli_result == RESULT_ENGINE_UNAVAILABLE ? "ENGINE_UNAVAILABLE"
      : "INVALID_INSTALLATION";
    goto finish;
  }

  if (audit_contract->kind == OP_START_AUTHORITY) {
    (void)unlink(AUTHORITY_STOPPED);
    command[index++] = (char *)"up"; command[index++] = (char *)"--no-deps";
    command[index++] = (char *)"--no-build"; command[index++] = (char *)"--pull";
    command[index++] = (char *)"never"; command[index++] = (char *)"authority"; attached = 1;
  } else if (audit_contract->kind == OP_STOP_AUTHORITY) {
    (void)unlink(AUTHORITY_STOPPED);
    command[index++] = (char *)"stop"; command[index++] = (char *)"--timeout";
    command[index++] = (char *)"20"; command[index++] = (char *)"authority";
  } else if (audit_contract->kind == OP_START_ISSUER) {
    (void)unlink(ISSUER_STOPPED);
    command[index++] = (char *)"up"; command[index++] = (char *)"--no-deps";
    command[index++] = (char *)"--no-build"; command[index++] = (char *)"--pull";
    command[index++] = (char *)"never"; command[index++] = (char *)"issuer"; attached = 1;
  } else if (audit_contract->kind == OP_STOP_ISSUER) {
    (void)unlink(ISSUER_STOPPED);
    command[index++] = (char *)"stop"; command[index++] = (char *)"--timeout";
    command[index++] = (char *)"20"; command[index++] = (char *)"issuer";
  } else if (audit_contract->kind == OP_STATUS_AUTHORITY) {
    command[index++] = (char *)"ps"; command[index++] = (char *)"--quiet";
    command[index++] = (char *)"--status"; command[index++] = (char *)"running";
    command[index++] = (char *)"authority"; status_mode = 1;
    status_receipt = AUTHORITY_STOPPED; status_service = "authority";
  } else if (audit_contract->kind == OP_STATUS_ISSUER) {
    command[index++] = (char *)"ps"; command[index++] = (char *)"--quiet";
    command[index++] = (char *)"--status"; command[index++] = (char *)"running";
    command[index++] = (char *)"issuer"; status_mode = 1;
    status_receipt = ISSUER_STOPPED; status_service = "issuer";
  } else if (audit_contract->kind == OP_REMOVE_RUNTIME_CONTAINERS) {
    command[index++] = (char *)"rm"; command[index++] = (char *)"--stop";
    command[index++] = (char *)"--force"; command[index++] = (char *)"issuer";
    command[index++] = (char *)"authority";
  } else {
    result_event = "rejected";
    goto finish;
  }
  command[index] = NULL;
  if (attached != 0) {
    (void)flock(lock_fd, LOCK_UN);
    (void)close(lock_fd);
    lock_fd = -1;
  }
  result = run_operation(command, attached, status_mode);
  if (status_receipt != NULL) {
    if (result == STATUS_NOT_RUNNING) {
      if (write_stopped_receipt(status_receipt, status_service) != 0) result = STATUS_AMBIGUOUS;
    } else {
      (void)unlink(status_receipt);
    }
  }
  error_code = safe_error_code(audit_contract->kind, result);

finish:
  emit_audit_event(audit_contract, result_event,
    result == 0 || result == STATUS_NOT_RUNNING ? "success" : "failure",
    error_code, clock_valid != 0 ? elapsed_milliseconds(&started) : 0LL, result);
  closelog();
  if (lock_fd >= 0) {
    (void)flock(lock_fd, LOCK_UN);
    (void)close(lock_fd);
  }
  return result;
}
