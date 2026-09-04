# ZimaOS Audit Notes

Dokumen ini mencatat temuan discovery awal yang menjadi dasar Blueprint Zima Control Center v1.

## Platform

```text
ZimaOS: 1.7.1
Hardware: ZimaCube
Architecture: amd64 / x86_64
Kernel: 6.18.9
Docker: 27.5.1
Docker Compose: 2.32.4
DockerRootDir: /var/lib/docker
```

## Storage

Root filesystem berbentuk appliance/SquashFS, sedangkan persistent writable data berada pada `/DATA`.

Beberapa path penting:

```text
/DATA
/DATA/AppData
/DATA/Backup
/DATA/.casaos
/DATA/.docker
/opt
```

`/var/lib/docker` berada di atas storage persistent ZimaOS. Docker overlay storage bukan application backup source.

## Docker Volumes

Pada audit awal tidak ditemukan Docker named volume yang digunakan aplikasi utama. Aplikasi saat ini dominan menggunakan bind mount.

## Application API

### Installed applications

```http
GET /v2/app_management/installed/list?mode=sync
```

HTTP 200 terbukti berhasil.

Data yang terlihat mencakup:

- app_type
- author_type
- auto_start
- containers
- image
- service_name
- port_mappings
- status
- install_status
- is_uncontrolled
- repo_id
- repo_app_id
- version

### Compose

```http
GET /v2/app_management/compose/{app}
Accept: application/yaml
```

HTTP 200 terbukti berhasil untuk:

- `adms_web`
- `sisfov2`
- `cashflow-next`
- `kolase`
- `mariadb`

Response YAML memberikan deployment definition.

### Resource usage

```http
GET /v2/app_management/installed/container/usage?container_ids=...
```

UI ZimaOS memanggil endpoint ini secara berkala dan menerima HTTP 200.

### Upgrade detection

```http
GET /v2/app_management/apps/upgradable
```

Pada audit saat itu hasilnya kosong (`data: []`).

## Application Patterns Found

### ADMS

```text
Compose name: adms_web
Image: php:8.2-apache
Port: 8088 -> 80
Network: zima-net
Persistent mount:
  /DATA/AppData/adms -> /var/www/html
```

Application data ada di `/DATA/AppData/adms`, termasuk upload, config, backups, dan logs.

### SISFO

```text
Compose name: sisfov2
Service: sisfo
Build context: /DATA/AppData/sisfov2
Dockerfile: Dockerfile
Container: sisfo_zimaos
Port: 6091 -> 6091
```

Persistent mounts:

```text
/DATA/AppData/sisfov2/storage
/DATA/AppData/sisfov2/public/uploads
```

SISFO menggunakan MariaDB dan juga mempunyai environment/env-file configuration.

### Cashflow

```text
Compose name: cashflow-next
Service: cashflow
Build context: /DATA/AppData/cashflow-next
Dockerfile: Dockerfile
Container: cashflow_zimaos
Port: 6090 -> 6090
```

Persistent mount:

```text
/DATA/AppData/cashflow-next/storage
```

### Kolase / PhotoApp

```text
Compose name: kolase
Service: photoapp
Build context: /opt/kolase
Dockerfile: Dockerfile
Container: photoapp
Port: 3000 -> 3000
```

Persistent mount:

```text
/opt/kolase/data -> /data
```

Environment metadata menunjukkan lokasi:

```text
DATABASE_PATH=/data/database/photoapp.sqlite
UPLOAD_PATH=/data/uploads
BACKUP_PATH=/data/backups
LOG_PATH=/data/logs
```

Pada audit file system sebelumnya, SQLite WAL/SHM aktif. Karena itu backup SQLite harus konsisten dan WAL-aware.

### MariaDB

```text
Compose name: mariadb
Service: mariadb
Image: mariadb:11
Port: 3306 -> 3306
Network: zima-net
Persistent mount:
  /DATA/mariadb -> /var/lib/mysql
```

MariaDB diperlakukan sebagai infrastructure/database service.

## ZimaOS Application Paths

ZimaOS menyimpan metadata aplikasi pada struktur `.casaos`, termasuk application metadata dan Compose files untuk sejumlah managed applications.

Custom Compose files juga ditemukan di `/DATA/AppData`.

Kesimpulan:

> `/DATA/.casaos/apps` tidak boleh dipakai sebagai satu-satunya sumber application discovery.

ZimaOS App Management API mampu melihat custom applications yang juga tidak selalu tinggal di `.casaos/apps`.

## API Safety

Audit API dilakukan dengan GET/read-only.

Endpoint internal ZimaOS tidak boleh diekspos langsung ke internet. Control Center harus menggunakan adapter internal/server-side.

Response Compose dapat mengandung secret dan credential application. Nilai tersebut harus disanitasi sebelum logging, storage metadata, atau rendering ke browser.

## Discovery Conclusion

Untuk v1, discovery layer disarankan menggunakan:

```text
ZimaOS API
  +
Docker API
  +
Filesystem
```

ZimaOS API adalah sumber utama application/deployment metadata; Docker adalah sumber verifikasi runtime; filesystem adalah sumber persistent data dan backup.
