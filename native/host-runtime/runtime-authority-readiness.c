#define _GNU_SOURCE
#include <dirent.h>
#include <errno.h>
#include <fcntl.h>
#include <limits.h>
#include <linux/capability.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/file.h>
#include <sys/mount.h>
#include <sys/prctl.h>
#include <sys/random.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/un.h>
#include <sys/syscall.h>
#include <time.h>
#include <unistd.h>

#define ROOT_DIR "/run/authority-runtime-bootstrap"
#define EPOCH ROOT_DIR "/authority-readiness-epoch"
#define STATE ROOT_DIR "/authority-readiness-state"
#define LOCK ROOT_DIR "/supervisor.lock"
#define SOCKET "/run/authority-runtime-trust/authority.sock"
#define LIFECYCLE_ADAPTER "/usr/libexec/zima-control-center/runtime-lifecycle-adapter"
#define AUTHORITY_STOPPED ROOT_DIR "/authority-stopped"
#define ISSUER_STOPPED ROOT_DIR "/issuer-stopped"
#define AUTHORITY_UID 21012U
#define IPC_GID 21013U

static int protected_directory(const char *path, uid_t uid, gid_t gid, mode_t mode, int exact) {
  int fd;
  struct stat before;
  struct stat descriptor;
  struct stat after;
  if (lstat(path, &before) != 0 || !S_ISDIR(before.st_mode) || S_ISLNK(before.st_mode)
      || before.st_uid != uid || (exact != 0
        ? (before.st_gid != gid || (before.st_mode & (mode_t)07777) != mode)
        : (before.st_mode & (mode_t)0022) != 0)) return -1;
  fd = open(path, O_PATH | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
  if (fd < 0 || fstat(fd, &descriptor) != 0 || lstat(path, &after) != 0
      || before.st_dev != descriptor.st_dev || before.st_ino != descriptor.st_ino
      || descriptor.st_dev != after.st_dev || descriptor.st_ino != after.st_ino) {
    if (fd >= 0) (void)close(fd);
    return -1;
  }
  (void)close(fd);
  return 0;
}

static int validate_protected_ancestors(void) {
  return protected_directory("/", 0U, 0U, 0U, 0) == 0
    && protected_directory("/run", 0U, 0U, 0U, 0) == 0
    && protected_directory(ROOT_DIR, 0U, 0U, (mode_t)0700, 1) == 0
    && protected_directory("/run/authority-runtime-trust", (uid_t)AUTHORITY_UID,
      (gid_t)IPC_GID, (mode_t)02750, 1) == 0 ? 0 : -1;
}

static int exact_file(const char *path, uid_t uid, gid_t gid, mode_t mode, struct stat *out) {
  struct stat value;
  if (lstat(path, &value) != 0 || !S_ISREG(value.st_mode) || S_ISLNK(value.st_mode)
      || value.st_uid != uid || value.st_gid != gid || (value.st_mode & (mode_t)07777) != mode
      || value.st_nlink != (nlink_t)1) return -1;
  if (out != NULL) *out = value;
  return 0;
}

static int exact_socket(uint64_t device, uint64_t inode) {
  struct stat value;
  if (lstat(SOCKET, &value) != 0 || !S_ISSOCK(value.st_mode) || S_ISLNK(value.st_mode)
      || value.st_uid != (uid_t)AUTHORITY_UID || value.st_gid != (gid_t)IPC_GID
      || (value.st_mode & (mode_t)07777) != (mode_t)0660 || value.st_dev == 0U || value.st_ino == 0U) return -1;
  if (device != 0U && ((uint64_t)value.st_dev != device || (uint64_t)value.st_ino != inode)) return -1;
  return 0;
}

static int path_is_mounted(const char *path) {
  FILE *file = fopen("/proc/self/mountinfo", "re");
  char line[4096];
  int found = 0;
  if (file == NULL) return -1;
  while (fgets(line, (int)sizeof(line), file) != NULL) {
    char mount_point[PATH_MAX];
    char options[1024];
    if (sscanf(line, "%*s %*s %*s %*s %4095s %1023s", mount_point, options) == 2
        && strcmp(mount_point, path) == 0) found += 1;
  }
  if (ferror(file) != 0 || found > 1) found = -1;
  (void)fclose(file);
  return found;
}

static int mount_option(const char *options, const char *expected) {
  size_t length = strlen(expected);
  const char *cursor = options;
  while (cursor != NULL && *cursor != '\0') {
    const char *end = strchr(cursor, ',');
    size_t token = end == NULL ? strlen(cursor) : (size_t)(end - cursor);
    if (token == length && memcmp(cursor, expected, length) == 0) return 1;
    cursor = end == NULL ? NULL : end + 1;
  }
  return 0;
}

typedef struct {
  unsigned long id;
  unsigned int device_major;
  unsigned int device_minor;
} mount_identity;

static int capture_exact_mount(const char *path, int read_only, mount_identity *identity) {
  FILE *file = fopen("/proc/self/mountinfo", "re");
  char line[4096];
  int matches = 0;
  int valid = 0;
  mount_identity candidate = { 0UL, 0U, 0U };
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
      candidate.id = mount_id;
      candidate.device_major = device_major;
      candidate.device_minor = device_minor;
      valid = mount_id > 0UL && mount_option(options, read_only != 0 ? "ro" : "rw")
        && !mount_option(options, read_only != 0 ? "rw" : "ro")
        && mount_option(options, "nodev") && mount_option(options, "nosuid")
        && mount_option(options, "noexec") && !mount_option(options, "dev")
        && !mount_option(options, "suid") && !mount_option(options, "exec");
    }
  }
  if (ferror(file) != 0) matches = -1;
  (void)fclose(file);
  if (matches != 1 || valid == 0) return -1;
  *identity = candidate;
  return 0;
}

static int exact_mount_flags(const char *path, int read_only) {
  mount_identity identity;
  return capture_exact_mount(path, read_only, &identity);
}

static int harden_file_mount(int source_fd, const char *path, int read_only) {
  unsigned long flags = MS_BIND | MS_REMOUNT | MS_NODEV | MS_NOSUID | MS_NOEXEC;
  char descriptor_path[64];
  struct stat descriptor;
  struct stat current;
  struct stat mounted_target;
  if (read_only != 0) flags |= MS_RDONLY;
  if (fstat(source_fd, &descriptor) != 0 || lstat(path, &current) != 0
      || descriptor.st_dev != current.st_dev || descriptor.st_ino != current.st_ino
      || snprintf(descriptor_path, sizeof(descriptor_path), "/proc/self/fd/%d", source_fd) <= 0
      || path_is_mounted(path) != 0
      || mount(descriptor_path, path, NULL, MS_BIND, NULL) != 0) return -1;
  if (mount(NULL, path, NULL, flags, NULL) != 0 || exact_mount_flags(path, read_only) != 0) {
    (void)umount2(path, MNT_DETACH); return -1;
  }
  if (fstat(source_fd, &descriptor) != 0 || lstat(path, &mounted_target) != 0
      || descriptor.st_dev != mounted_target.st_dev || descriptor.st_ino != mounted_target.st_ino) {
    (void)umount2(path, MNT_DETACH);
    return -1;
  }
  return 0;
}

static int held_by_other_process(const struct stat *target) {
  DIR *proc = opendir("/proc");
  struct dirent *entry;
  if (proc == NULL) return -1;
  errno = 0;
  while ((entry = readdir(proc)) != NULL) {
    char *end = NULL;
    long pid = strtol(entry->d_name, &end, 10);
    DIR *fds;
    struct dirent *fd_entry;
    char directory[64];
    if (end == entry->d_name || *end != '\0' || pid <= 0L || pid == (long)getpid()) continue;
    (void)snprintf(directory, sizeof(directory), "/proc/%ld/fd", pid);
    fds = opendir(directory);
    if (fds == NULL) {
      if (errno == ENOENT) { errno = 0; continue; }
      (void)closedir(proc);
      return -1;
    }
    errno = 0;
    while ((fd_entry = readdir(fds)) != NULL) {
      char descriptor[PATH_MAX];
      struct stat value;
      if (fd_entry->d_name[0] == '.') continue;
      {
        int rendered = snprintf(descriptor, sizeof(descriptor), "%s/%s", directory, fd_entry->d_name);
        if (rendered < 0 || (size_t)rendered >= sizeof(descriptor)) {
          (void)closedir(fds); (void)closedir(proc); return -1;
        }
      }
      if (stat(descriptor, &value) == 0) {
        if (value.st_dev == target->st_dev && value.st_ino == target->st_ino) {
          (void)closedir(fds); (void)closedir(proc); return 1;
        }
      } else if (errno != ENOENT) {
        (void)closedir(fds); (void)closedir(proc); return -1;
      }
      errno = 0;
    }
    if (errno != 0) { (void)closedir(fds); (void)closedir(proc); return -1; }
    (void)closedir(fds);
    errno = 0;
  }
  if (errno != 0) { (void)closedir(proc); return -1; }
  (void)closedir(proc);
  return 0;
}

static int validate_old_or_absent(const char *path, uid_t uid, gid_t gid, mode_t mode, int read_only) {
  struct stat value;
  struct stat confirmed;
  int held;
  int mounted;
  if (lstat(path, &value) != 0) return errno == ENOENT ? 0 : -1;
  if (exact_file(path, uid, gid, mode, &value) != 0) return -1;
  mounted = path_is_mounted(path);
  held = held_by_other_process(&value);
  if (mounted < 0 || held != 0) return -1;
  if (mounted == 1 && (exact_mount_flags(path, read_only) != 0 || umount2(path, 0) != 0)) return -1;
  if (exact_file(path, uid, gid, mode, &confirmed) != 0
      || confirmed.st_dev != value.st_dev || confirmed.st_ino != value.st_ino) return -1;
  return unlink(path);
}

static void base64url(const unsigned char input[32], char output[44]) {
  static const char alphabet[] = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
  size_t source = 0U;
  size_t destination = 0U;
  while (source + 3U <= 32U) {
    uint32_t value = ((uint32_t)input[source] << 16U)
      | ((uint32_t)input[source + 1U] << 8U) | (uint32_t)input[source + 2U];
    output[destination++] = alphabet[(value >> 18U) & 63U];
    output[destination++] = alphabet[(value >> 12U) & 63U];
    output[destination++] = alphabet[(value >> 6U) & 63U];
    output[destination++] = alphabet[value & 63U];
    source += 3U;
  }
  output[destination++] = alphabet[((uint32_t)input[30] << 16U | (uint32_t)input[31] << 8U) >> 18U & 63U];
  output[destination++] = alphabet[((uint32_t)input[30] << 16U | (uint32_t)input[31] << 8U) >> 12U & 63U];
  output[destination++] = alphabet[((uint32_t)input[30] << 16U | (uint32_t)input[31] << 8U) >> 6U & 63U];
  output[43] = '\0';
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

static int prepare(void) {
  unsigned char random[32];
  char encoded[44];
  char record[91];
  int epoch_fd = -1;
  int state_fd = -1;
  int directory_fd = -1;
  ssize_t random_length;
  struct stat root;
  if (validate_protected_ancestors() != 0
      || lstat(ROOT_DIR, &root) != 0 || !S_ISDIR(root.st_mode) || root.st_uid != 0U
      || root.st_gid != 0U || (root.st_mode & (mode_t)07777) != (mode_t)0700) return 70;
  if (lstat(SOCKET, &root) == 0 || errno != ENOENT) return 71;
  if (validate_old_or_absent(EPOCH, 0U, (gid_t)AUTHORITY_UID, (mode_t)0440, 1) != 0
      || validate_old_or_absent(STATE, (uid_t)AUTHORITY_UID, (gid_t)AUTHORITY_UID, (mode_t)0600, 0) != 0) return 72;
  epoch_fd = open(EPOCH, O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC | O_WRONLY, (mode_t)0400);
  if (epoch_fd < 0 || fchown(epoch_fd, 0U, (gid_t)AUTHORITY_UID) != 0
      || fchmod(epoch_fd, (mode_t)0440) != 0) goto fail;
  state_fd = open(STATE, O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC | O_WRONLY, (mode_t)0600);
  if (state_fd < 0 || fchown(state_fd, (uid_t)AUTHORITY_UID, (gid_t)AUTHORITY_UID) != 0
      || fchmod(state_fd, (mode_t)0600) != 0) goto fail;
  do { random_length = getrandom(random, sizeof(random), 0U); } while (random_length < 0 && errno == EINTR);
  if (random_length != (ssize_t)sizeof(random)) goto fail;
  base64url(random, encoded);
  if (snprintf(record, sizeof(record), "ZCC_AUTHORITY_READINESS_EPOCH_V1\ninstance=ar1-%s\n", encoded) != 90) goto fail;
  memset(random, 0, sizeof(random));
  if (full_write(epoch_fd, record, 90U) != 0 || fdatasync(epoch_fd) != 0
      || ftruncate(state_fd, 0) != 0 || fdatasync(state_fd) != 0) goto fail;
  directory_fd = open(ROOT_DIR, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
  if (directory_fd < 0 || fsync(directory_fd) != 0
      || exact_file(EPOCH, 0U, (gid_t)AUTHORITY_UID, (mode_t)0440, NULL) != 0
      || exact_file(STATE, (uid_t)AUTHORITY_UID, (gid_t)AUTHORITY_UID, (mode_t)0600, NULL) != 0) goto fail;
  (void)close(directory_fd);
  directory_fd = -1;
  if (harden_file_mount(epoch_fd, EPOCH, 1) != 0
      || harden_file_mount(state_fd, STATE, 0) != 0) goto fail;
  (void)close(state_fd); (void)close(epoch_fd);
  state_fd = -1; epoch_fd = -1;
  return 0;
fail:
  memset(random, 0, sizeof(random));
  if (directory_fd >= 0) (void)close(directory_fd);
  if (state_fd >= 0) (void)close(state_fd);
  if (epoch_fd >= 0) (void)close(epoch_fd);
  if (path_is_mounted(STATE) == 1) (void)umount2(STATE, MNT_DETACH);
  if (path_is_mounted(EPOCH) == 1) (void)umount2(EPOCH, MNT_DETACH);
  (void)unlink(STATE); (void)unlink(EPOCH);
  return 73;
}

static int read_epoch(char instance[48]) {
  int fd;
  char record[91];
  ssize_t length;
  struct stat before;
  struct stat after;
  fd = open(EPOCH, O_RDONLY | O_NOFOLLOW | O_CLOEXEC);
  if (fd < 0 || fstat(fd, &before) != 0) { if (fd >= 0) (void)close(fd); return -1; }
  length = read(fd, record, sizeof(record));
  if (fstat(fd, &after) != 0) { (void)close(fd); return -1; }
  (void)close(fd);
  if (length != 90 || before.st_dev != after.st_dev || before.st_ino != after.st_ino
      || before.st_size != after.st_size
      || exact_file(EPOCH, 0U, (gid_t)AUTHORITY_UID, (mode_t)0440, NULL) != 0) return -1;
  record[90] = '\0';
  if (strncmp(record, "ZCC_AUTHORITY_READINESS_EPOCH_V1\ninstance=ar1-", 46U) != 0
      || record[89] != '\n') return -1;
  memcpy(instance, record + 42U, 47U);
  instance[47] = '\0';
  if (strncmp(instance, "ar1-", 4U) != 0) return -1;
  return 0;
}

static int probe_listener(void) {
  int fd;
  int result;
  struct sockaddr_un address;
  fd = socket(AF_UNIX, SOCK_STREAM | SOCK_NONBLOCK | SOCK_CLOEXEC, 0);
  if (fd < 0) return -1;
  memset(&address, 0, sizeof(address));
  address.sun_family = AF_UNIX;
  (void)snprintf(address.sun_path, sizeof(address.sun_path), "%s", SOCKET);
  result = connect(fd, (const struct sockaddr *)&address, (socklen_t)sizeof(address));
  if (result != 0 && errno != EINPROGRESS) { (void)close(fd); return -1; }
  (void)close(fd);
  return 0;
}

static int validate_state(const char instance[48]) {
  int fd;
  char record[193];
  char expected[193];
  ssize_t length;
  struct stat before;
  struct stat after;
  struct stat socket_node;
  unsigned long long device;
  unsigned long long inode;
  int consumed = 0;
  fd = open(STATE, O_RDONLY | O_NOFOLLOW | O_CLOEXEC);
  if (fd < 0 || fstat(fd, &before) != 0) { if (fd >= 0) (void)close(fd); return -1; }
  length = read(fd, record, sizeof(record));
  if (fstat(fd, &after) != 0) { (void)close(fd); return -1; }
  (void)close(fd);
  if (length <= 0 || length > 192 || before.st_dev != after.st_dev || before.st_ino != after.st_ino
      || before.st_size != after.st_size || before.st_size != length
      || exact_file(STATE, (uid_t)AUTHORITY_UID, (gid_t)AUTHORITY_UID, (mode_t)0600, NULL) != 0) return -1;
  record[length] = '\0';
  if (sscanf(record,
      "ZCC_AUTHORITY_READINESS_STATE_V1\ninstance=%47[A-Za-z0-9_-]\nstate=READY\nsocketDevice=%llu\nsocketInode=%llu\n%n",
      expected, &device, &inode, &consumed) != 3 || consumed != (int)length
      || strcmp(expected, instance) != 0 || device == 0ULL || inode == 0ULL) return -1;
  if (snprintf(expected, sizeof(expected),
      "ZCC_AUTHORITY_READINESS_STATE_V1\ninstance=%s\nstate=READY\nsocketDevice=%llu\nsocketInode=%llu\n",
      instance, device, inode) != (int)length || memcmp(expected, record, (size_t)length) != 0) return -1;
  if (lstat(SOCKET, &socket_node) != 0 || exact_socket((uint64_t)device, (uint64_t)inode) != 0
      || probe_listener() != 0) return -1;
  return 0;
}

static int wait_ready(void) {
  char instance[48];
  struct timespec start;
  struct timespec now;
  struct timespec pause = { .tv_sec = 0, .tv_nsec = 100000000L };
  if (read_epoch(instance) != 0 || clock_gettime(CLOCK_MONOTONIC, &start) != 0) return 74;
  for (;;) {
    int lock_fd = open(LOCK, O_RDWR | O_NOFOLLOW | O_CLOEXEC);
    int valid;
    if (lock_fd < 0 || flock(lock_fd, LOCK_EX) != 0) { if (lock_fd >= 0) (void)close(lock_fd); return 75; }
    valid = validate_state(instance);
    (void)flock(lock_fd, LOCK_UN);
    (void)close(lock_fd);
    if (valid == 0) return 0;
    if (clock_gettime(CLOCK_MONOTONIC, &now) != 0) return 75;
    if ((now.tv_sec - start.tv_sec) > 30L
        || ((now.tv_sec - start.tv_sec) == 30L && now.tv_nsec >= start.tv_nsec)) return 76;
    while (nanosleep(&pause, &pause) != 0 && errno == EINTR) { }
    pause.tv_sec = 0; pause.tv_nsec = 100000000L;
  }
}

static int lifecycle_wrapper_absent(void) {
  DIR *proc;
  struct dirent *entry;
  struct stat helper;
  if (lstat(LIFECYCLE_ADAPTER, &helper) != 0 || !S_ISREG(helper.st_mode)
      || helper.st_uid != 0U || helper.st_gid != 0U || helper.st_nlink != (nlink_t)1) return -1;
  proc = opendir("/proc");
  if (proc == NULL) return -1;
  errno = 0;
  while ((entry = readdir(proc)) != NULL) {
    char *end = NULL;
    long pid = strtol(entry->d_name, &end, 10);
    char executable[64];
    struct stat value;
    if (end == entry->d_name || *end != '\0' || pid <= 0L || pid == (long)getpid()) continue;
    (void)snprintf(executable, sizeof(executable), "/proc/%ld/exe", pid);
    if (stat(executable, &value) == 0 && value.st_dev == helper.st_dev && value.st_ino == helper.st_ino) {
      (void)closedir(proc);
      return -1;
    }
    if (errno != 0 && errno != ENOENT && errno != EACCES) { (void)closedir(proc); return -1; }
    errno = 0;
  }
  if (errno != 0) { (void)closedir(proc); return -1; }
  (void)closedir(proc);
  return 0;
}

static int valid_stopped_receipt(const char *path, const char *service) {
  int fd = -1;
  int boot_fd = -1;
  char record[160];
  char receipt_service[16];
  char receipt_boot[37];
  char current_boot[38];
  unsigned long long seconds;
  int consumed = 0;
  ssize_t length;
  ssize_t boot_length;
  struct stat value;
  struct timespec now;
  fd = open(path, O_RDONLY | O_NOFOLLOW | O_CLOEXEC);
  if (fd < 0 || fstat(fd, &value) != 0 || !S_ISREG(value.st_mode)
      || value.st_uid != 0U || value.st_gid != 0U
      || (value.st_mode & (mode_t)07777) != (mode_t)0600 || value.st_nlink != (nlink_t)1) goto fail;
  do { length = read(fd, record, sizeof(record) - 1U); } while (length < 0 && errno == EINTR);
  (void)close(fd); fd = -1;
  boot_fd = open("/proc/sys/kernel/random/boot_id", O_RDONLY | O_NOFOLLOW | O_CLOEXEC);
  if (boot_fd < 0) goto fail;
  do { boot_length = read(boot_fd, current_boot, sizeof(current_boot)); } while (boot_length < 0 && errno == EINTR);
  (void)close(boot_fd); boot_fd = -1;
  if (length <= 0 || length >= (ssize_t)sizeof(record) || boot_length != 37
      || current_boot[36] != '\n' || clock_gettime(CLOCK_BOOTTIME, &now) != 0) goto fail;
  record[length] = '\0';
  current_boot[36] = '\0';
  if (sscanf(record,
      "ZCC_RUNTIME_STOPPED_V1\nservice=%15[a-z]\nbootId=%36[0-9a-f-]\nmonotonicSeconds=%llu\n%n",
      receipt_service, receipt_boot, &seconds, &consumed) != 3 || consumed != (int)length
      || strcmp(receipt_service, service) != 0 || strcmp(receipt_boot, current_boot) != 0
      || seconds > (unsigned long long)now.tv_sec
      || (unsigned long long)now.tv_sec - seconds > 5ULL) goto fail;
  return 0;
fail:
  if (fd >= 0) (void)close(fd);
  if (boot_fd >= 0) (void)close(boot_fd);
  return -1;
}

static int cleanup(void) {
  struct stat epoch;
  struct stat state;
  struct stat confirmed_epoch;
  struct stat confirmed_state;
  struct stat socket_node;
  mount_identity epoch_mount;
  mount_identity state_mount;
  if (validate_protected_ancestors() != 0 || lifecycle_wrapper_absent() != 0
      || valid_stopped_receipt(AUTHORITY_STOPPED, "authority") != 0
      || valid_stopped_receipt(ISSUER_STOPPED, "issuer") != 0
      || lstat(SOCKET, &socket_node) == 0 || errno != ENOENT) return 77;
  if (exact_file(EPOCH, 0U, (gid_t)AUTHORITY_UID, (mode_t)0440, &epoch) != 0
      || exact_file(STATE, (uid_t)AUTHORITY_UID, (gid_t)AUTHORITY_UID, (mode_t)0600, &state) != 0
      || capture_exact_mount(EPOCH, 1, &epoch_mount) != 0
      || capture_exact_mount(STATE, 0, &state_mount) != 0
      || held_by_other_process(&epoch) != 0 || held_by_other_process(&state) != 0) return 78;
  if (exact_file(EPOCH, 0U, (gid_t)AUTHORITY_UID, (mode_t)0440, &confirmed_epoch) != 0
      || exact_file(STATE, (uid_t)AUTHORITY_UID, (gid_t)AUTHORITY_UID, (mode_t)0600, &confirmed_state) != 0
      || confirmed_epoch.st_dev != epoch.st_dev || confirmed_epoch.st_ino != epoch.st_ino
      || confirmed_state.st_dev != state.st_dev || confirmed_state.st_ino != state.st_ino) return 78;
  {
    mount_identity current_epoch;
    mount_identity current_state;
    if (capture_exact_mount(EPOCH, 1, &current_epoch) != 0
        || capture_exact_mount(STATE, 0, &current_state) != 0
        || current_epoch.id != epoch_mount.id || current_epoch.device_major != epoch_mount.device_major
        || current_epoch.device_minor != epoch_mount.device_minor
        || current_state.id != state_mount.id || current_state.device_major != state_mount.device_major
        || current_state.device_minor != state_mount.device_minor) return 78;
  }
  if (umount2(STATE, 0) != 0 || umount2(EPOCH, 0) != 0
      || unlink(STATE) != 0 || unlink(EPOCH) != 0) return 79;
  {
    int directory_fd = open(ROOT_DIR, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
    if (directory_fd < 0 || fsync(directory_fd) != 0) { if (directory_fd >= 0) (void)close(directory_fd); return 79; }
    (void)close(directory_fd);
  }
  return 0;
}

static int systemd_context(const char *unit) {
  FILE *file = fopen("/proc/self/cgroup", "re");
  char line[1024];
  int found = 0;
  if (file == NULL) return -1;
  while (fgets(line, (int)sizeof(line), file) != NULL) {
    if (strstr(line, unit) != NULL) { found = 1; break; }
  }
  (void)fclose(file);
  return found == 1 ? 0 : -1;
}

static int capture_host_mount_namespace(struct stat *identity) {
  struct stat self_namespace;
  struct stat host_namespace;
  if (stat("/proc/self/ns/mnt", &self_namespace) != 0
      || stat("/proc/1/ns/mnt", &host_namespace) != 0
      || self_namespace.st_dev != host_namespace.st_dev
      || self_namespace.st_ino != host_namespace.st_ino
      || self_namespace.st_dev == 0U || self_namespace.st_ino == 0U) return -1;
  *identity = self_namespace;
  return 0;
}

static int exact_mount_capabilities(void) {
  struct __user_cap_header_struct header;
  struct __user_cap_data_struct data[2];
  uint32_t expected = (1U << CAP_CHOWN) | (1U << CAP_DAC_OVERRIDE)
    | (1U << CAP_FOWNER) | (1U << CAP_SYS_ADMIN);
  int capability;
  memset(&header, 0, sizeof(header));
  memset(data, 0, sizeof(data));
  header.version = _LINUX_CAPABILITY_VERSION_3;
  if (syscall(SYS_capget, &header, data) != 0
      || data[0].effective != expected || data[0].permitted != expected
      || data[0].inheritable != 0U || data[1].effective != 0U
      || data[1].permitted != 0U || data[1].inheritable != 0U) return -1;
  for (capability = 0; capability <= CAP_LAST_CAP; capability += 1) {
    if (prctl(PR_CAP_AMBIENT, PR_CAP_AMBIENT_IS_SET, capability, 0L, 0L) != 0) return -1;
  }
  return 0;
}

static int host_mount_namespace_unchanged(const struct stat *identity) {
  struct stat current;
  return capture_host_mount_namespace(&current) == 0
    && current.st_dev == identity->st_dev && current.st_ino == identity->st_ino ? 0 : -1;
}

int main(int argc, char **argv) {
  int lock_fd;
  int result;
  int mount_verb;
  struct stat mount_namespace;
  if (argc != 2 || getuid() != 0U || geteuid() != 0U) return 64;
  mount_verb = strcmp(argv[1], "PREPARE") == 0 || strcmp(argv[1], "CLEANUP") == 0;
  if ((mount_verb != 0 && systemd_context("zima-control-runtime-readiness-mount.service") != 0)
      || (mount_verb == 0 && (strcmp(argv[1], "WAIT") != 0
        || systemd_context("zima-control-runtime-authority.service") != 0))
      || (mount_verb != 0 && (exact_mount_capabilities() != 0
        || capture_host_mount_namespace(&mount_namespace) != 0))) return 64;
  if (clearenv() != 0 || chdir("/") != 0) return 65;
  (void)umask((mode_t)0077);
  if (strcmp(argv[1], "WAIT") == 0) return wait_ready();
  lock_fd = open(LOCK, O_RDWR | O_NOFOLLOW | O_CLOEXEC);
  if (lock_fd < 0 || flock(lock_fd, LOCK_EX) != 0) return 66;
  result = strcmp(argv[1], "PREPARE") == 0 ? prepare() : cleanup();
  if (host_mount_namespace_unchanged(&mount_namespace) != 0) result = 80;
  (void)flock(lock_fd, LOCK_UN);
  (void)close(lock_fd);
  return result;
}
