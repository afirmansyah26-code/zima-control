#ifndef _GNU_SOURCE
#define _GNU_SOURCE
#endif
#include <errno.h>
#include <dirent.h>
#include <fcntl.h>
#include <grp.h>
#include <linux/capability.h>
#include <limits.h>
#include <openssl/evp.h>
#include <openssl/crypto.h>
#include <openssl/sha.h>
#include <openssl/x509.h>
#include <pwd.h>
#include <sqlite3.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/file.h>
#include <sys/mount.h>
#include <sys/prctl.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/sysmacros.h>
#include <sys/types.h>
#include <sys/syscall.h>
#include <sys/un.h>
#include <time.h>
#include <unistd.h>

#define TRUST_DB "/var/lib/authority-trust/db/trust.sqlite"
#define MANIFEST "/etc/authority-trust/issuer-boundary.json"
#define KEY_DIRECTORY "/var/lib/authority-trust/issuer/keys"
#define BOOTSTRAP_DIRECTORY "/run/authority-runtime-bootstrap"
#define KEY_MOUNT BOOTSTRAP_DIRECTORY "/issuer-active.pk8"
#define MANIFEST_MOUNT BOOTSTRAP_DIRECTORY "/issuer-boundary.json"
#define LOCK BOOTSTRAP_DIRECTORY "/supervisor.lock"
#define UDS_DIRECTORY "/run/authority-runtime-trust"
#define UDS_SOCKET UDS_DIRECTORY "/authority.sock"
#define AUTHORITY_UID 21012U
#define ISSUER_UID 21011U
#define IPC_GID 21013U
#define LIFECYCLE_ADAPTER "/usr/libexec/zima-control-center/runtime-lifecycle-adapter"
#define AUTHORITY_STOPPED BOOTSTRAP_DIRECTORY "/authority-stopped"
#define ISSUER_STOPPED BOOTSTRAP_DIRECTORY "/issuer-stopped"

typedef struct trust_snapshot {
  char authority_id[65];
  char issuer_id[65];
  char boundary_id[257];
  char binding_epoch[257];
  char fingerprint[65];
  char public_key[129];
  char public_key_encoding[32];
  char fingerprint_algorithm[16];
  char algorithm[16];
  long long key_version;
} trust_snapshot;

typedef struct boundary_manifest {
  char authority_id[65];
  char issuer_id[65];
  char boundary_id[257];
  char binding_epoch[257];
  unsigned int issuer_read_gid;
} boundary_manifest;

static int exact_node(const char *path, mode_t kind, uid_t uid, gid_t gid, mode_t mode, int one_link) {
  struct stat value;
  if (lstat(path, &value) != 0 || (value.st_mode & S_IFMT) != kind || S_ISLNK(value.st_mode)
      || value.st_uid != uid || value.st_gid != gid || (value.st_mode & (mode_t)07777) != mode
      || (one_link != 0 && value.st_nlink != (nlink_t)1)) return -1;
  return 0;
}

static int same_identity(const struct stat *left, const struct stat *right) {
  return left->st_dev == right->st_dev && left->st_ino == right->st_ino
    && left->st_uid == right->st_uid && left->st_gid == right->st_gid
    && (left->st_mode & (mode_t)07777) == (right->st_mode & (mode_t)07777)
    && left->st_nlink == right->st_nlink;
}

static int protected_directory(const char *path, uid_t uid, gid_t gid, mode_t mode, int exact_mode) {
  int fd;
  struct stat path_before;
  struct stat descriptor;
  struct stat path_after;
  if (lstat(path, &path_before) != 0 || !S_ISDIR(path_before.st_mode) || S_ISLNK(path_before.st_mode)
      || path_before.st_uid != uid || path_before.st_gid != gid
      || (exact_mode != 0 ? ((path_before.st_mode & (mode_t)07777) != mode)
        : ((path_before.st_mode & (mode_t)0022) != 0))) return -1;
  fd = open(path, O_PATH | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
  if (fd < 0 || fstat(fd, &descriptor) != 0 || lstat(path, &path_after) != 0
      || !same_identity(&path_before, &descriptor) || !same_identity(&descriptor, &path_after)) {
    if (fd >= 0) (void)close(fd);
    return -1;
  }
  (void)close(fd);
  return 0;
}

static int validate_system_ancestors(void) {
  return protected_directory("/", 0U, 0U, 0U, 0) == 0
    && protected_directory("/etc", 0U, 0U, 0U, 0) == 0
    && protected_directory("/var", 0U, 0U, 0U, 0) == 0
    && protected_directory("/var/lib", 0U, 0U, 0U, 0) == 0
    && protected_directory("/usr", 0U, 0U, 0U, 0) == 0
    && protected_directory("/usr/libexec", 0U, 0U, 0U, 0) == 0
    && protected_directory("/usr/libexec/zima-control-center", 0U, 0U, 0U, 0) == 0
    && protected_directory("/run", 0U, 0U, 0U, 0) == 0 ? 0 : -1;
}

static int protected_root_directory_any_group(const char *path) {
  int fd;
  struct stat before;
  struct stat descriptor;
  struct stat after;
  if (lstat(path, &before) != 0 || !S_ISDIR(before.st_mode) || S_ISLNK(before.st_mode)
      || before.st_uid != 0U || (before.st_mode & (mode_t)0022) != 0) return -1;
  fd = open(path, O_PATH | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
  if (fd < 0 || fstat(fd, &descriptor) != 0 || lstat(path, &after) != 0
      || !same_identity(&before, &descriptor) || !same_identity(&descriptor, &after)) {
    if (fd >= 0) { (void)close(fd); }
    return -1;
  }
  (void)close(fd);
  return 0;
}

static int validate_protected_ancestors(gid_t issuer_read_gid) {
  return validate_system_ancestors() == 0
    && protected_directory("/etc/authority-trust", 0U, issuer_read_gid, (mode_t)0750, 1) == 0
    && protected_directory("/var/lib/authority-trust", 0U, issuer_read_gid, (mode_t)0750, 1) == 0
    && protected_directory("/var/lib/authority-trust/issuer", 0U, issuer_read_gid, (mode_t)0750, 1) == 0
    && protected_directory(KEY_DIRECTORY, 0U, issuer_read_gid, (mode_t)0750, 1) == 0
    && protected_directory("/var/lib/authority-trust/db", 0U, (gid_t)AUTHORITY_UID, (mode_t)0750, 1) == 0
    && protected_directory(BOOTSTRAP_DIRECTORY, 0U, (gid_t)AUTHORITY_UID, (mode_t)0710, 1) == 0 ? 0 : -1;
}

static int full_read_file(const char *path, char *bytes, size_t capacity, size_t *length,
                          int *retained_fd, struct stat *identity) {
  /* Success transfers one validated descriptor to retained_fd; failure transfers none. */
  int fd = open(path, O_RDONLY | O_NOFOLLOW | O_CLOEXEC);
  ssize_t count;
  struct stat value;
  struct stat confirmed;
  if (retained_fd == NULL || identity == NULL) { if (fd >= 0) (void)close(fd); return -1; }
  *retained_fd = -1;
  memset(identity, 0, sizeof(*identity));
  if (fd < 0 || fstat(fd, &value) != 0 || !S_ISREG(value.st_mode)
      || value.st_nlink != (nlink_t)1 || value.st_size <= 0
      || (uint64_t)value.st_size >= (uint64_t)capacity) { if (fd >= 0) (void)close(fd); return -1; }
  count = read(fd, bytes, capacity - 1U);
  if (count != value.st_size || fstat(fd, &confirmed) != 0 || !same_identity(&value, &confirmed)) {
    (void)close(fd); return -1;
  }
  bytes[count] = '\0';
  *length = (size_t)count;
  *retained_fd = fd;
  *identity = confirmed;
  return 0;
}

static int copy_sqlite_text(sqlite3_stmt *statement, int column, char *output, size_t capacity) {
  const unsigned char *value = sqlite3_column_text(statement, column);
  int length = sqlite3_column_bytes(statement, column);
  if (value == NULL || length <= 0 || (size_t)length >= capacity
      || memchr(value, 0, (size_t)length) != NULL) return -1;
  memcpy(output, value, (size_t)length);
  output[(size_t)length] = 0;
  return length;
}

static int load_snapshot(trust_snapshot *snapshot) {
  sqlite3 *database = NULL;
  sqlite3_stmt *statement = NULL;
  const char *sql =
    "SELECT a.id,i.issuerId,i.serviceBoundaryId,i.bindingEpoch,k.keyVersion,k.publicKeyFingerprint,"
    "k.publicKey,k.publicKeyEncoding,k.fingerprintAlgorithm,k.algorithm "
    "FROM Authority a JOIN AuthorityIssuer i ON i.authorityId=a.id "
    "JOIN AuthoritySigningKey k ON k.id=i.activeKeyId AND k.issuerId=i.issuerId "
    "WHERE a.installationKey='PRIMARY' AND i.trustStatus='ACTIVE' "
    "AND i.pendingKeyId IS NULL AND i.currentOperationId IS NULL AND k.status='ACTIVE'";
  int result = -1;
  if (sqlite3_open_v2("file:" TRUST_DB "?mode=ro", &database, SQLITE_OPEN_READONLY | SQLITE_OPEN_URI, NULL) != SQLITE_OK) goto done;
  if (sqlite3_exec(database, "PRAGMA query_only=ON; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;", NULL, NULL, NULL) != SQLITE_OK) goto done;
  if (sqlite3_prepare_v2(database, "PRAGMA journal_mode", -1, &statement, NULL) != SQLITE_OK
      || sqlite3_step(statement) != SQLITE_ROW
      || strcmp((const char *)sqlite3_column_text(statement, 0), "delete") != 0) goto done;
  (void)sqlite3_finalize(statement); statement = NULL;
  if (sqlite3_prepare_v2(database, sql, -1, &statement, NULL) != SQLITE_OK || sqlite3_step(statement) != SQLITE_ROW) goto done;
  if (copy_sqlite_text(statement, 0, snapshot->authority_id, sizeof(snapshot->authority_id)) != 36
      || copy_sqlite_text(statement, 1, snapshot->issuer_id, sizeof(snapshot->issuer_id)) != 36
      || copy_sqlite_text(statement, 2, snapshot->boundary_id, sizeof(snapshot->boundary_id)) < 1
      || copy_sqlite_text(statement, 3, snapshot->binding_epoch, sizeof(snapshot->binding_epoch)) < 1
      || copy_sqlite_text(statement, 5, snapshot->fingerprint, sizeof(snapshot->fingerprint)) != 64
      || copy_sqlite_text(statement, 6, snapshot->public_key, sizeof(snapshot->public_key)) < 1
      || copy_sqlite_text(statement, 7, snapshot->public_key_encoding, sizeof(snapshot->public_key_encoding)) < 1
      || copy_sqlite_text(statement, 8, snapshot->fingerprint_algorithm, sizeof(snapshot->fingerprint_algorithm)) < 1
      || copy_sqlite_text(statement, 9, snapshot->algorithm, sizeof(snapshot->algorithm)) < 1) goto done;
  snapshot->key_version = sqlite3_column_int64(statement, 4);
  if (snapshot->key_version <= 0 || sqlite3_step(statement) != SQLITE_DONE) goto done;
  result = 0;
done:
  if (statement != NULL) (void)sqlite3_finalize(statement);
  if (database != NULL && sqlite3_close(database) != SQLITE_OK) result = -1;
  return result;
}

static int take_char(const char **cursor, const char *end, char expected) {
  if (*cursor >= end || **cursor != expected) return -1;
  *cursor += 1;
  return 0;
}

static int take_literal(const char **cursor, const char *end, const char *literal) {
  size_t length = strlen(literal);
  if ((size_t)(end - *cursor) < length || memcmp(*cursor, literal, length) != 0) return -1;
  *cursor += length;
  return 0;
}

static int boundary_character(unsigned char value) {
  return (value >= (unsigned char)'A' && value <= (unsigned char)'Z')
    || (value >= (unsigned char)'a' && value <= (unsigned char)'z')
    || (value >= (unsigned char)'0' && value <= (unsigned char)'9')
    || value == (unsigned char)'.' || value == (unsigned char)'_'
    || value == (unsigned char)':' || value == (unsigned char)'-';
}

static int take_string(const char **cursor, const char *end, char *output,
                       size_t capacity, int boundary) {
  size_t length = 0U;
  if (take_char(cursor, end, (char)34) != 0) return -1;
  while (*cursor < end && **cursor != (char)34) {
    unsigned char value = (unsigned char)**cursor;
    if (value < 0x20U || value == (unsigned char)'\\'
        || (boundary != 0 && boundary_character(value) == 0)
        || length + 1U >= capacity) return -1;
    output[length++] = (char)value;
    *cursor += 1;
  }
  if (length == 0U || take_char(cursor, end, (char)34) != 0) return -1;
  output[length] = 0;
  return 0;
}

static int canonical_uuid(const char *value) {
  size_t index;
  if (strlen(value) != 36U) return -1;
  for (index = 0U; index < 36U; index += 1U) {
    if (index == 8U || index == 13U || index == 18U || index == 23U) {
      if (value[index] != '-') return -1;
    } else if (!((value[index] >= '0' && value[index] <= '9')
        || (value[index] >= 'a' && value[index] <= 'f'))) return -1;
  }
  return 0;
}

static int canonical_fingerprint(const char *value) {
  size_t index;
  if (strlen(value) != 64U) return -1;
  for (index = 0U; index < 64U; index += 1U) {
    if (!((value[index] >= '0' && value[index] <= '9')
        || (value[index] >= 'a' && value[index] <= 'f'))) return -1;
  }
  return 0;
}

static void release_retained_descriptor(int *retained_fd) {
  int descriptor;
  if (retained_fd == NULL || *retained_fd < 0) return;
  descriptor = *retained_fd;
  *retained_fd = -1;
  (void)close(descriptor);
}

static int parse_manifest(boundary_manifest *manifest, int *retained_fd, struct stat *identity) {
  /* Parsing owns the transferred descriptor until success returns it to prepare_runtime. */
  char bytes[1025];
  char storage_policy[64];
  const char *cursor;
  const char *end;
  char *number_end = NULL;
  unsigned long read_gid;
  size_t length;
  if (manifest == NULL || retained_fd == NULL || identity == NULL
      || full_read_file(MANIFEST, bytes, sizeof(bytes), &length, retained_fd, identity) != 0) return -1;
  cursor = bytes;
  end = bytes + length;
  if (take_char(&cursor, end, '{') != 0
      || take_char(&cursor, end, (char)34) != 0
      || take_literal(&cursor, end, "authorityId") != 0
      || take_char(&cursor, end, (char)34) != 0 || take_char(&cursor, end, ':') != 0
      || take_string(&cursor, end, manifest->authority_id, sizeof(manifest->authority_id), 0) != 0
      || take_char(&cursor, end, ',') != 0
      || take_char(&cursor, end, (char)34) != 0
      || take_literal(&cursor, end, "bindingEpoch") != 0
      || take_char(&cursor, end, (char)34) != 0 || take_char(&cursor, end, ':') != 0
      || take_string(&cursor, end, manifest->binding_epoch, sizeof(manifest->binding_epoch), 1) != 0
      || strlen(manifest->binding_epoch) > 128U
      || take_char(&cursor, end, ',') != 0
      || take_char(&cursor, end, (char)34) != 0
      || take_literal(&cursor, end, "issuerId") != 0
      || take_char(&cursor, end, (char)34) != 0 || take_char(&cursor, end, ':') != 0
      || take_string(&cursor, end, manifest->issuer_id, sizeof(manifest->issuer_id), 0) != 0
      || take_char(&cursor, end, ',') != 0
      || take_char(&cursor, end, (char)34) != 0
      || take_literal(&cursor, end, "issuerReadGid") != 0
      || take_char(&cursor, end, (char)34) != 0 || take_char(&cursor, end, ':') != 0
      || cursor >= end || *cursor < '1' || *cursor > '9') return -1;
  errno = 0;
  read_gid = strtoul(cursor, &number_end, 10);
  if (errno != 0 || number_end == cursor || number_end > end || read_gid > (unsigned long)UINT32_MAX) return -1;
  cursor = number_end;
  manifest->issuer_read_gid = (unsigned int)read_gid;
  if (take_char(&cursor, end, ',') != 0
      || take_char(&cursor, end, (char)34) != 0
      || take_literal(&cursor, end, "schemaVersion") != 0
      || take_char(&cursor, end, (char)34) != 0 || take_char(&cursor, end, ':') != 0
      || take_char(&cursor, end, '1') != 0 || take_char(&cursor, end, ',') != 0
      || take_char(&cursor, end, (char)34) != 0
      || take_literal(&cursor, end, "serviceBoundaryId") != 0
      || take_char(&cursor, end, (char)34) != 0 || take_char(&cursor, end, ':') != 0
      || take_string(&cursor, end, manifest->boundary_id, sizeof(manifest->boundary_id), 1) != 0
      || strlen(manifest->boundary_id) > 128U
      || take_char(&cursor, end, ',') != 0
      || take_char(&cursor, end, (char)34) != 0
      || take_literal(&cursor, end, "storagePolicy") != 0
      || take_char(&cursor, end, (char)34) != 0 || take_char(&cursor, end, ':') != 0
      || take_string(&cursor, end, storage_policy, sizeof(storage_policy), 0) != 0
      || take_char(&cursor, end, '}') != 0 || cursor != end
      || strcmp(storage_policy, "AUTHORITY_TRUST_FS_V1") != 0
      || canonical_uuid(manifest->authority_id) != 0
      || canonical_uuid(manifest->issuer_id) != 0
      || manifest->issuer_read_gid == 0U
      || manifest->issuer_read_gid == AUTHORITY_UID
      || manifest->issuer_read_gid == ISSUER_UID
      || manifest->issuer_read_gid == IPC_GID) {
    release_retained_descriptor(retained_fd);
    memset(identity, 0, sizeof(*identity));
    return -1;
  }
  return 0;
}

static int validate_key(const trust_snapshot *snapshot, const boundary_manifest *manifest,
                        char key_path[512], int *retained_fd, struct stat *identity) {
  int fd;
  struct stat value;
  struct stat confirmed;
  unsigned char bytes[4096];
  ssize_t length;
  const unsigned char *cursor;
  EVP_PKEY *key = NULL;
  PKCS8_PRIV_KEY_INFO *canonical_info = NULL;
  unsigned char *canonical_der = NULL;
  unsigned char *canonical_cursor;
  int canonical_length = 0;
  unsigned char *public_der = NULL;
  unsigned char *public_cursor;
  int public_length;
  unsigned char digest[SHA256_DIGEST_LENGTH];
  char fingerprint[65];
  unsigned char public_base64[129];
  int base64_length;
  size_t index;
  int result = -1;
  if (canonical_fingerprint(snapshot->fingerprint) != 0
      || snprintf(key_path, 512U, KEY_DIRECTORY "/v%lld-%s.pk8",
        snapshot->key_version, snapshot->fingerprint) >= 512) return -1;
  fd = open(key_path, O_RDONLY | O_NOFOLLOW | O_CLOEXEC);
  if (fd < 0 || fstat(fd, &value) != 0 || !S_ISREG(value.st_mode) || value.st_nlink != (nlink_t)1
      || value.st_uid != 0U || value.st_gid != (gid_t)manifest->issuer_read_gid
      || (value.st_mode & (mode_t)07777) != (mode_t)0640 || value.st_size <= 0 || value.st_size > (off_t)sizeof(bytes)) {
    if (fd >= 0) { (void)close(fd); }
    return -1;
  }
  length = read(fd, bytes, sizeof(bytes));
  if (length != value.st_size || fstat(fd, &confirmed) != 0 || !same_identity(&value, &confirmed)) goto done;
  cursor = bytes;
  key = d2i_AutoPrivateKey(NULL, &cursor, length);
  if (key == NULL || cursor != bytes + length || EVP_PKEY_base_id(key) != EVP_PKEY_ED25519) goto done;
  canonical_info = EVP_PKEY2PKCS8(key);
  if (canonical_info == NULL) goto done;
  canonical_length = i2d_PKCS8_PRIV_KEY_INFO(canonical_info, NULL);
  if (canonical_length <= 0 || canonical_length != (int)length) goto done;
  canonical_der = malloc((size_t)canonical_length);
  if (canonical_der == NULL) goto done;
  canonical_cursor = canonical_der;
  if (i2d_PKCS8_PRIV_KEY_INFO(canonical_info, &canonical_cursor) != canonical_length
      || CRYPTO_memcmp(canonical_der, bytes, (size_t)canonical_length) != 0) goto done;
  public_length = i2d_PUBKEY(key, NULL);
  if (public_length <= 0 || public_length > 256) goto done;
  public_der = malloc((size_t)public_length);
  if (public_der == NULL) goto done;
  public_cursor = public_der;
  if (i2d_PUBKEY(key, &public_cursor) != public_length) goto done;
  base64_length = EVP_EncodeBlock(public_base64, public_der, public_length);
  if (base64_length <= 0 || base64_length >= (int)sizeof(public_base64)) goto done;
  public_base64[base64_length] = 0U;
  if (SHA256(public_der, (size_t)public_length, digest) == NULL) goto done;
  for (index = 0U; index < SHA256_DIGEST_LENGTH; index += 1U) {
    (void)snprintf(fingerprint + index * 2U, 3U, "%02x", digest[index]);
  }
  fingerprint[64] = '\0';
  if (strcmp(fingerprint, snapshot->fingerprint) != 0
      || strcmp((const char *)public_base64, snapshot->public_key) != 0
      || strcmp(snapshot->public_key_encoding, "SPKI_DER_BASE64") != 0
      || strcmp(snapshot->fingerprint_algorithm, "SHA-256") != 0
      || strcmp(snapshot->algorithm, "Ed25519") != 0) goto done;
  *retained_fd = fd;
  *identity = confirmed;
  result = 0;
done:
  OPENSSL_cleanse(bytes, sizeof(bytes));
  OPENSSL_cleanse(digest, sizeof(digest));
  if (canonical_der != NULL) OPENSSL_cleanse(canonical_der, (size_t)(canonical_length > 0 ? canonical_length : 0));
  free(canonical_der);
  PKCS8_PRIV_KEY_INFO_free(canonical_info);
  free(public_der);
  EVP_PKEY_free(key);
  if (result != 0) (void)close(fd);
  return result;
}

static int full_uid_map(void) {
  FILE *file = fopen("/proc/1/uid_map", "re");
  unsigned long long inside;
  unsigned long long outside;
  unsigned long long length;
  int valid;
  if (file == NULL) return -1;
  valid = fscanf(file, "%llu %llu %llu", &inside, &outside, &length) == 3
    && inside == 0ULL && outside == 0ULL && length >= 4294967294ULL;
  (void)fclose(file);
  return valid ? 0 : -1;
}

#define IDENTITY_BUFFER_SIZE 4096

static int resolve_account(uid_t uid, struct passwd *account, char *buffer, size_t size) {
  struct passwd *result = NULL;
  if (getpwuid_r(uid, account, buffer, size, &result) != 0 || result == NULL) return -1;
  return 0;
}

static int resolve_group(gid_t gid, struct group *group, char *buffer, size_t size) {
  struct group *result = NULL;
  if (getgrgid_r(gid, group, buffer, size, &result) != 0 || result == NULL) return -1;
  return 0;
}

static int member_of(const struct passwd *account, gid_t required) {
  gid_t groups[64];
  int count = (int)(sizeof(groups) / sizeof(groups[0]));
  int index;
  if (getgrouplist(account->pw_name, account->pw_gid, groups, &count) < 0) return -1;
  for (index = 0; index < count; index += 1) if (groups[index] == required) return 0;
  return -1;
}

static int validate_identities(gid_t issuer_read_gid) {
  struct passwd authority;
  struct passwd issuer;
  struct group authority_group;
  struct group issuer_group;
  struct group ipc_group;
  struct group read_group;
  char authority_buffer[IDENTITY_BUFFER_SIZE];
  char issuer_buffer[IDENTITY_BUFFER_SIZE];
  char authority_group_buffer[IDENTITY_BUFFER_SIZE];
  char issuer_group_buffer[IDENTITY_BUFFER_SIZE];
  char ipc_group_buffer[IDENTITY_BUFFER_SIZE];
  char read_group_buffer[IDENTITY_BUFFER_SIZE];
  if (resolve_account((uid_t)AUTHORITY_UID, &authority, authority_buffer, sizeof(authority_buffer)) != 0
      || resolve_account((uid_t)ISSUER_UID, &issuer, issuer_buffer, sizeof(issuer_buffer)) != 0
      || resolve_group((gid_t)AUTHORITY_UID, &authority_group,
        authority_group_buffer, sizeof(authority_group_buffer)) != 0
      || resolve_group((gid_t)ISSUER_UID, &issuer_group,
        issuer_group_buffer, sizeof(issuer_group_buffer)) != 0
      || resolve_group((gid_t)IPC_GID, &ipc_group, ipc_group_buffer, sizeof(ipc_group_buffer)) != 0
      || resolve_group(issuer_read_gid, &read_group, read_group_buffer, sizeof(read_group_buffer)) != 0) return -1;
  if (authority.pw_uid == issuer.pw_uid
      || authority_group.gr_gid == issuer_group.gr_gid
      || member_of(&authority, (gid_t)IPC_GID) != 0
      || member_of(&issuer, (gid_t)IPC_GID) != 0
      || member_of(&issuer, issuer_read_gid) != 0) return -1;
  return 0;
}

static int mounted(const char *path) {
  FILE *file = fopen("/proc/self/mountinfo", "re");
  char line[4096];
  int found = 0;
  if (file == NULL) return -1;
  while (fgets(line, (int)sizeof(line), file) != NULL) {
    char mount_point[PATH_MAX];
    char options[1024];
    if (sscanf(line, "%*s %*s %*s %*s %4095s %1023s", mount_point, options) == 2
        && strcmp(mount_point, path) == 0) { found += 1; }
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

static int same_captured_mount(const char *path, int read_only,
                               const mount_identity *expected, const struct stat *node) {
  mount_identity current;
  return capture_exact_mount(path, read_only, &current) == 0
    && current.id == expected->id
    && current.device_major == expected->device_major
    && current.device_minor == expected->device_minor
    && current.device_major == (unsigned int)major(node->st_dev)
    && current.device_minor == (unsigned int)minor(node->st_dev) ? 0 : -1;
}

static int harden_self_bind(const char *path, int read_only) {
  unsigned long flags = MS_BIND | MS_REMOUNT | MS_NODEV | MS_NOSUID | MS_NOEXEC;
  if (read_only != 0) flags |= MS_RDONLY;
  if (mounted(path) != 0 || mount(path, path, NULL, MS_BIND, NULL) != 0) return -1;
  if (mount(NULL, path, NULL, flags, NULL) != 0 || exact_mount_flags(path, read_only) != 0) {
    (void)umount2(path, MNT_DETACH);
    return -1;
  }
  return 0;
}

static int held_by_process(const struct stat *target) {
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

static int lifecycle_wrapper_running(void) {
  DIR *proc;
  struct dirent *entry;
  struct stat helper;
  if (exact_node(LIFECYCLE_ADAPTER, S_IFREG, 0U, 0U, (mode_t)0700, 1) != 0
      || stat(LIFECYCLE_ADAPTER, &helper) != 0) return -1;
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
      return 1;
    }
    if (errno != 0 && errno != ENOENT && errno != EACCES) { (void)closedir(proc); return -1; }
    errno = 0;
  }
  if (errno != 0) { (void)closedir(proc); return -1; }
  (void)closedir(proc);
  return 0;
}

static int boot_identifier(char output[37]) {
  int fd = open("/proc/sys/kernel/random/boot_id", O_RDONLY | O_NOFOLLOW | O_CLOEXEC);
  char bytes[38];
  ssize_t length;
  if (fd < 0) return -1;
  do { length = read(fd, bytes, sizeof(bytes)); } while (length < 0 && errno == EINTR);
  (void)close(fd);
  if (length != 37 || bytes[36] != '\n') return -1;
  memcpy(output, bytes, 36U); output[36] = '\0';
  return canonical_uuid(output);
}

static int valid_stopped_receipt(const char *path, const char *service) {
  int fd;
  char bytes[160];
  char expected[160];
  char receipt_service[16];
  char receipt_boot[37];
  char current_boot[37];
  unsigned long long seconds;
  int consumed = 0;
  ssize_t length;
  struct stat value;
  struct timespec now;
  fd = open(path, O_RDONLY | O_NOFOLLOW | O_CLOEXEC);
  if (fd < 0 || fstat(fd, &value) != 0 || !S_ISREG(value.st_mode) || value.st_uid != 0U
      || value.st_gid != 0U || (value.st_mode & (mode_t)07777) != (mode_t)0600
      || value.st_nlink != (nlink_t)1) { if (fd >= 0) (void)close(fd); return -1; }
  do { length = read(fd, bytes, sizeof(bytes) - 1U); } while (length < 0 && errno == EINTR);
  (void)close(fd);
  if (length <= 0 || length >= (ssize_t)sizeof(bytes)) return -1;
  bytes[length] = '\0';
  if (sscanf(bytes, "ZCC_RUNTIME_STOPPED_V1\nservice=%15[a-z]\nbootId=%36[0-9a-f-]\nmonotonicSeconds=%llu\n%n",
      receipt_service, receipt_boot, &seconds, &consumed) != 3 || consumed != (int)length
      || strcmp(receipt_service, service) != 0 || canonical_uuid(receipt_boot) != 0
      || boot_identifier(current_boot) != 0 || strcmp(receipt_boot, current_boot) != 0
      || clock_gettime(CLOCK_BOOTTIME, &now) != 0 || seconds > (unsigned long long)now.tv_sec
      || (unsigned long long)now.tv_sec - seconds > 5ULL) return -1;
  if (snprintf(expected, sizeof(expected),
      "ZCC_RUNTIME_STOPPED_V1\nservice=%s\nbootId=%s\nmonotonicSeconds=%llu\n",
      service, receipt_boot, seconds) != (int)length || memcmp(expected, bytes, (size_t)length) != 0) return -1;
  return 0;
}

static int both_runtimes_stopped(void) {
  return lifecycle_wrapper_running() == 0
    && valid_stopped_receipt(AUTHORITY_STOPPED, "authority") == 0
    && valid_stopped_receipt(ISSUER_STOPPED, "issuer") == 0 ? 0 : -1;
}

static int listener_alive(void) {
  int fd;
  int result;
  int connect_error;
  struct sockaddr_un address;
  fd = socket(AF_UNIX, SOCK_STREAM | SOCK_NONBLOCK | SOCK_CLOEXEC, 0);
  if (fd < 0) return -1;
  memset(&address, 0, sizeof(address));
  address.sun_family = AF_UNIX;
  (void)snprintf(address.sun_path, sizeof(address.sun_path), "%s", UDS_SOCKET);
  result = connect(fd, (const struct sockaddr *)&address, (socklen_t)sizeof(address));
  connect_error = errno;
  (void)close(fd);
  if (result == 0 || connect_error == EINPROGRESS || connect_error == EAGAIN) return 1;
  return connect_error == ECONNREFUSED ? 0 : -1;
}

static int prepare_uds(void) {
  struct stat socket_node;
  struct stat confirmed;
  if (mkdir(UDS_DIRECTORY, (mode_t)02750) != 0 && errno != EEXIST) return -1;
  if (chown(UDS_DIRECTORY, (uid_t)AUTHORITY_UID, (gid_t)IPC_GID) != 0
      || chmod(UDS_DIRECTORY, (mode_t)02750) != 0
      || exact_node(UDS_DIRECTORY, S_IFDIR, (uid_t)AUTHORITY_UID, (gid_t)IPC_GID, (mode_t)02750, 0) != 0) return -1;
  if (lstat(UDS_SOCKET, &socket_node) != 0) return errno == ENOENT ? 0 : -1;
  if (both_runtimes_stopped() != 0) return -1;
  if (!S_ISSOCK(socket_node.st_mode) || S_ISLNK(socket_node.st_mode) || socket_node.st_nlink != (nlink_t)1
      || socket_node.st_uid != (uid_t)AUTHORITY_UID || socket_node.st_gid != (gid_t)IPC_GID
      || (socket_node.st_mode & (mode_t)07777) != (mode_t)0660
      || listener_alive() != 0 || held_by_process(&socket_node) != 0) return -1;
  if (lstat(UDS_SOCKET, &confirmed) != 0 || !S_ISSOCK(confirmed.st_mode)
      || confirmed.st_dev != socket_node.st_dev || confirmed.st_ino != socket_node.st_ino) return -1;
  return unlink(UDS_SOCKET);
}

static int bind_validated_file(int source_fd, const struct stat *identity,
                               const char *source_path, const char *target) {
  int fd;
  char descriptor_path[64];
  struct stat existing;
  struct stat descriptor;
  struct stat current_source;
  struct stat mounted_target;
  if (mounted(target) != 0) return -1;
  if (fstat(source_fd, &descriptor) != 0 || !same_identity(identity, &descriptor)
      || lstat(source_path, &current_source) != 0 || !same_identity(identity, &current_source)) return -1;
  if (lstat(target, &existing) == 0) {
    if (!S_ISREG(existing.st_mode) || S_ISLNK(existing.st_mode)
        || existing.st_uid != 0U || existing.st_gid != 0U
        || (existing.st_mode & (mode_t)07777) != (mode_t)0600
        || existing.st_nlink != (nlink_t)1 || unlink(target) != 0) return -1;
  } else if (errno != ENOENT) {
    return -1;
  }
  fd = open(target, O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC | O_WRONLY, (mode_t)0600);
  if (fd < 0) return -1;
  (void)close(fd);
  if (snprintf(descriptor_path, sizeof(descriptor_path), "/proc/self/fd/%d", source_fd) <= 0
      || mount(descriptor_path, target, NULL, MS_BIND, NULL) != 0) { (void)unlink(target); return -1; }
  if (mount(NULL, target, NULL, MS_BIND | MS_REMOUNT | MS_RDONLY | MS_NODEV | MS_NOSUID | MS_NOEXEC, NULL) != 0) {
    (void)umount2(target, MNT_DETACH); (void)unlink(target); return -1;
  }
  if (fstat(source_fd, &descriptor) != 0 || lstat(source_path, &current_source) != 0
      || lstat(target, &mounted_target) != 0 || !same_identity(identity, &descriptor)
      || !same_identity(identity, &current_source) || !same_identity(identity, &mounted_target)
      || exact_mount_flags(target, 1) != 0) {
    (void)umount2(target, MNT_DETACH); (void)unlink(target); return -1;
  }
  return 0;
}

static int prepare_runtime(void) {
  trust_snapshot snapshot;
  boundary_manifest manifest;
  char key_path[512];
  int manifest_fd = -1;
  int key_fd = -1;
  int database_hardened = 0;
  int uds_hardened = 0;
  struct stat manifest_identity;
  struct stat key_identity;
  int result = 70;
  if (validate_system_ancestors() != 0 || both_runtimes_stopped() != 0 || full_uid_map() != 0
      || protected_root_directory_any_group("/etc/authority-trust") != 0
      || parse_manifest(&manifest, &manifest_fd, &manifest_identity) != 0
      || validate_protected_ancestors((gid_t)manifest.issuer_read_gid) != 0
      || exact_node("/var/lib/authority-trust/db", S_IFDIR, 0U, (gid_t)AUTHORITY_UID, (mode_t)0750, 0) != 0
      || exact_node(TRUST_DB, S_IFREG, 0U, (gid_t)AUTHORITY_UID, (mode_t)0640, 1) != 0
      || access("/var/lib/authority-trust/db/trust.sqlite-journal", F_OK) == 0
      || access("/var/lib/authority-trust/db/trust.sqlite-wal", F_OK) == 0
      || access("/var/lib/authority-trust/db/trust.sqlite-shm", F_OK) == 0
      || load_snapshot(&snapshot) != 0
      || validate_identities((gid_t)manifest.issuer_read_gid) != 0
      || strcmp(snapshot.authority_id, manifest.authority_id) != 0
      || strcmp(snapshot.issuer_id, manifest.issuer_id) != 0
      || strcmp(snapshot.boundary_id, manifest.boundary_id) != 0
      || strcmp(snapshot.binding_epoch, manifest.binding_epoch) != 0
      || exact_node(MANIFEST, S_IFREG, 0U, (gid_t)manifest.issuer_read_gid, (mode_t)0640, 1) != 0
      || exact_node(KEY_DIRECTORY, S_IFDIR, 0U, (gid_t)manifest.issuer_read_gid, (mode_t)0750, 0) != 0
      || validate_key(&snapshot, &manifest, key_path, &key_fd, &key_identity) != 0
      || prepare_uds() != 0) goto done;
  if (harden_self_bind("/var/lib/authority-trust/db", 1) != 0) { result = 71; goto done; }
  database_hardened = 1;
  if (harden_self_bind(UDS_DIRECTORY, 0) != 0) { result = 71; goto done; }
  uds_hardened = 1;
  if (bind_validated_file(key_fd, &key_identity, key_path, KEY_MOUNT) != 0
      || bind_validated_file(manifest_fd, &manifest_identity, MANIFEST, MANIFEST_MOUNT) != 0) {
    result = 71; goto done;
  }
  result = 0;
done:
  if (key_fd >= 0) (void)close(key_fd);
  release_retained_descriptor(&manifest_fd);
  if (result != 0) {
    if (mounted(MANIFEST_MOUNT) == 1) (void)umount2(MANIFEST_MOUNT, MNT_DETACH);
    if (mounted(KEY_MOUNT) == 1) (void)umount2(KEY_MOUNT, MNT_DETACH);
    (void)unlink(MANIFEST_MOUNT); (void)unlink(KEY_MOUNT);
    if (uds_hardened != 0) (void)umount2(UDS_DIRECTORY, MNT_DETACH);
    if (database_hardened != 0) (void)umount2("/var/lib/authority-trust/db", MNT_DETACH);
  }
  return result;
}

static int cleanup_runtime(void) {
  struct stat socket_node;
  struct stat confirmed;
  struct stat database_node;
  struct stat uds_node;
  struct stat key_node;
  struct stat manifest_node;
  mount_identity database_mount;
  mount_identity uds_mount;
  mount_identity key_mount;
  mount_identity manifest_mount;
  if (both_runtimes_stopped() != 0) return 72;
  if (lstat(UDS_SOCKET, &socket_node) == 0) {
    if (!S_ISSOCK(socket_node.st_mode) || S_ISLNK(socket_node.st_mode) || socket_node.st_nlink != (nlink_t)1
        || socket_node.st_uid != (uid_t)AUTHORITY_UID || socket_node.st_gid != (gid_t)IPC_GID
        || (socket_node.st_mode & (mode_t)07777) != (mode_t)0660
        || listener_alive() != 0 || held_by_process(&socket_node) != 0) return 72;
    if (lstat(UDS_SOCKET, &confirmed) != 0 || !S_ISSOCK(confirmed.st_mode)
        || confirmed.st_dev != socket_node.st_dev || confirmed.st_ino != socket_node.st_ino
        || unlink(UDS_SOCKET) != 0) return 72;
  } else if (errno != ENOENT) {
    return 72;
  }
  if (lstat("/var/lib/authority-trust/db", &database_node) != 0
      || !S_ISDIR(database_node.st_mode) || database_node.st_uid != 0U
      || database_node.st_gid != (gid_t)AUTHORITY_UID
      || (database_node.st_mode & (mode_t)07777) != (mode_t)0750
      || lstat(UDS_DIRECTORY, &uds_node) != 0 || !S_ISDIR(uds_node.st_mode)
      || uds_node.st_uid != (uid_t)AUTHORITY_UID || uds_node.st_gid != (gid_t)IPC_GID
      || (uds_node.st_mode & (mode_t)07777) != (mode_t)02750
      || lstat(KEY_MOUNT, &key_node) != 0 || !S_ISREG(key_node.st_mode)
      || key_node.st_uid != 0U || (key_node.st_mode & (mode_t)07777) != (mode_t)0640
      || key_node.st_nlink != (nlink_t)1
      || lstat(MANIFEST_MOUNT, &manifest_node) != 0 || !S_ISREG(manifest_node.st_mode)
      || manifest_node.st_uid != 0U || manifest_node.st_gid != key_node.st_gid
      || (manifest_node.st_mode & (mode_t)07777) != (mode_t)0640
      || manifest_node.st_nlink != (nlink_t)1
      || capture_exact_mount("/var/lib/authority-trust/db", 1, &database_mount) != 0
      || capture_exact_mount(UDS_DIRECTORY, 0, &uds_mount) != 0
      || capture_exact_mount(KEY_MOUNT, 1, &key_mount) != 0
      || capture_exact_mount(MANIFEST_MOUNT, 1, &manifest_mount) != 0
      || held_by_process(&database_node) != 0 || held_by_process(&uds_node) != 0
      || held_by_process(&key_node) != 0 || held_by_process(&manifest_node) != 0) return 73;
  if (same_captured_mount(MANIFEST_MOUNT, 1, &manifest_mount, &manifest_node) != 0
      || umount2(MANIFEST_MOUNT, 0) != 0
      || same_captured_mount(KEY_MOUNT, 1, &key_mount, &key_node) != 0
      || umount2(KEY_MOUNT, 0) != 0) return 73;
  if (mounted(MANIFEST_MOUNT) != 0 || mounted(KEY_MOUNT) != 0) return 73;
  if (lstat(MANIFEST_MOUNT, &confirmed) == 0) {
    if (!S_ISREG(confirmed.st_mode) || S_ISLNK(confirmed.st_mode)
        || confirmed.st_uid != 0U || confirmed.st_gid != 0U
        || (confirmed.st_mode & (mode_t)07777) != (mode_t)0600
        || confirmed.st_nlink != (nlink_t)1 || unlink(MANIFEST_MOUNT) != 0) return 74;
  } else if (errno != ENOENT) return 74;
  if (lstat(KEY_MOUNT, &confirmed) == 0) {
    if (!S_ISREG(confirmed.st_mode) || S_ISLNK(confirmed.st_mode)
        || confirmed.st_uid != 0U || confirmed.st_gid != 0U
        || (confirmed.st_mode & (mode_t)07777) != (mode_t)0600
        || confirmed.st_nlink != (nlink_t)1 || unlink(KEY_MOUNT) != 0) return 74;
  } else if (errno != ENOENT) return 74;
  if (same_captured_mount(UDS_DIRECTORY, 0, &uds_mount, &uds_node) != 0
      || umount2(UDS_DIRECTORY, 0) != 0) return 75;
  if (same_captured_mount("/var/lib/authority-trust/db", 1, &database_mount, &database_node) != 0
      || umount2("/var/lib/authority-trust/db", 0) != 0) return 75;
  if (rmdir(UDS_DIRECTORY) != 0 && errno != ENOENT) return 75;
  return 0;
}

static int ensure_control_directory(void) {
  int lock_fd;
  if (mkdir(BOOTSTRAP_DIRECTORY, (mode_t)0710) != 0 && errno != EEXIST) return -1;
  if (chown(BOOTSTRAP_DIRECTORY, 0U, (gid_t)AUTHORITY_UID) != 0 || chmod(BOOTSTRAP_DIRECTORY, (mode_t)0710) != 0
      || exact_node(BOOTSTRAP_DIRECTORY, S_IFDIR, 0U, (gid_t)AUTHORITY_UID, (mode_t)0710, 0) != 0) return -1;
  lock_fd = open(LOCK, O_CREAT | O_NOFOLLOW | O_CLOEXEC | O_RDWR, (mode_t)0600);
  if (lock_fd < 0 || fchown(lock_fd, 0U, 0U) != 0 || fchmod(lock_fd, (mode_t)0600) != 0) {
    if (lock_fd >= 0) { (void)close(lock_fd); }
    return -1;
  }
  return lock_fd;
}

static int systemd_context(void) {
  FILE *file = fopen("/proc/self/cgroup", "re");
  char line[1024];
  int found = 0;
  if (file == NULL) return -1;
  while (fgets(line, (int)sizeof(line), file) != NULL) {
    if (strstr(line, "zima-control-runtime-bootstrap.service") != NULL) { found = 1; break; }
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
  *identity = host_namespace;
  return 0;
}

#define CAPTURE_CAPABILITIES ((1U << CAP_CHOWN) | (1U << CAP_DAC_OVERRIDE) \
  | (1U << CAP_FOWNER) | (1U << CAP_FSETID) | (1U << CAP_SYS_ADMIN) | (1U << CAP_SYS_PTRACE) | (1U << CAP_SETPCAP))
#define OPERATION_CAPABILITIES ((1U << CAP_CHOWN) | (1U << CAP_DAC_OVERRIDE) \
  | (1U << CAP_FOWNER) | (1U << CAP_FSETID) | (1U << CAP_SYS_ADMIN))

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

static int exact_mount_capabilities(void) {
  struct __user_cap_header_struct header;
  struct __user_cap_data_struct data[2];
  uint32_t expected = (1U << CAP_CHOWN) | (1U << CAP_DAC_OVERRIDE)
    | (1U << CAP_FOWNER) | (1U << CAP_FSETID) | (1U << CAP_SYS_ADMIN);
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

static int exact_operation_capabilities(void) {
  if (exact_mount_capabilities() != 0) return -1;
  if (prctl(PR_CAPBSET_READ, CAP_SYS_PTRACE, 0L, 0L, 0L) != 0) return -1;
  if (prctl(PR_CAPBSET_READ, CAP_SETPCAP, 0L, 0L, 0L) != 0) return -1;
  return 0;
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
  data[0].effective = OPERATION_CAPABILITIES;
  data[0].permitted = OPERATION_CAPABILITIES;
  data[0].inheritable = 0U;
  data[1].effective = 0U;
  data[1].permitted = 0U;
  data[1].inheritable = 0U;
  if (syscall(SYS_capset, &header, data) != 0) return -1;
  return 0;
}

static int host_mount_namespace_unchanged(const struct stat *identity) {
  struct stat current;
  return stat("/proc/self/ns/mnt", &current) == 0
    && current.st_dev == identity->st_dev && current.st_ino == identity->st_ino ? 0 : -1;
}

int main(int argc, char **argv) {
  int lock_fd;
  int result;
  struct stat mount_namespace;
  if (argc != 2 || (strcmp(argv[1], "PREPARE") != 0 && strcmp(argv[1], "CLEANUP") != 0)
      || getuid() != 0U || geteuid() != 0U || systemd_context() != 0
      || normalize_inheritable_capabilities() != 0
      || exact_capture_capabilities() != 0
      || capture_host_mount_namespace(&mount_namespace) != 0
      || drop_capture_capabilities() != 0
      || exact_operation_capabilities() != 0) return 64;
  if (clearenv() != 0 || chdir("/") != 0) return 65;
  (void)umask((mode_t)0077);
  lock_fd = ensure_control_directory();
  if (lock_fd < 0 || flock(lock_fd, LOCK_EX) != 0) { if (lock_fd >= 0) (void)close(lock_fd); return 66; }
  result = strcmp(argv[1], "PREPARE") == 0 ? prepare_runtime() : cleanup_runtime();
  if (host_mount_namespace_unchanged(&mount_namespace) != 0) result = 76;
  (void)flock(lock_fd, LOCK_UN);
  (void)close(lock_fd);
  return result;
}
