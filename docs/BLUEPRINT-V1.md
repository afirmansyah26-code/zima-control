# Zima Control Center v1 — Technical Blueprint

**Project:** Zima Control Center  
**Target platform:** ZimaOS / ZimaCube  
**Status:** Blueprint / Discovery Complete for initial architecture  
**Version:** 1.0-draft

---

## 1. Vision

Zima Control Center adalah panel manajemen bergaya cPanel untuk lingkungan Docker pada ZimaOS.

Fokusnya bukan mengambil alih fungsi dasar ZimaOS, tetapi menjadi lapisan orkestrasi untuk:

- application inventory
- deployment visibility
- backup
- restore
- storage destinations
- scheduling
- monitoring
- operational history

Prinsip utama:

> ZimaOS mengelola platform dan runtime; Zima Control Center mengelola workflow dan state operasional tambahan.

---

## 2. Scope v1

### Included

1. Application Registry
2. ZimaOS API integration
3. Docker/runtime inventory
4. Deployment snapshot
5. Backup Registry
6. Generic Backup Engine
7. Local destination
8. Synology destination
9. Backup scheduler
10. Backup history
11. Restore workflow
12. Dashboard
13. Basic storage and runtime monitoring

### Deferred

- Full replacement of ZimaOS app lifecycle UI
- Arbitrary shell execution from browser
- Destructive Docker operations as a primary feature
- Cloud destination implementation beyond an adapter-ready architecture
- Advanced multi-user RBAC

---

## 3. Runtime Architecture

```text
                         Browser
                            |
                            v
                 +----------------------+
                 | Zima Control Center  |
                 |      Web + API       |
                 +----------+-----------+
                            |
          +-----------------+------------------+
          |                 |                  |
          v                 v                  v
     ZimaOS API        Docker Engine      Filesystem
          |                 |                  |
          |                 |                  +----> Backup Sources
          |                 |
          |                 +----> Runtime / Logs / Stats
          |
          +----> Application / Compose Discovery

                         Backup Engine
                              |
              +---------------+---------------+
              |               |               |
              v               v               v
            Local          Synology         Cloud-ready
```

Zima Control Center sendiri disarankan berjalan sebagai Docker application. Dependency aplikasi tidak dipasang langsung ke host ZimaOS.

---

## 4. Discovery Model

Discovery menggunakan beberapa sumber yang saling melengkapi.

### ZimaOS Application Inventory

```http
GET /v2/app_management/installed/list?mode=sync
```

Digunakan untuk menemukan aplikasi yang terdaftar pada ZimaOS, container utama, status, image, port mapping, repository metadata, dan status managed/uncontrolled.

### Compose Discovery

```http
GET /v2/app_management/compose/{app}
Accept: application/yaml
```

Endpoint ini terbukti memberikan Compose definition lengkap, termasuk:

- services
- build context
- Dockerfile
- image
- command
- environment metadata
- env file paths
- healthcheck
- networks
- ports
- restart policy
- volumes
- `x-casaos` metadata

### Runtime Resource Usage

```http
GET /v2/app_management/installed/container/usage?container_ids=...
```

Dipakai sebagai salah satu sumber monitoring resource runtime.

### Upgrade Detection

```http
GET /v2/app_management/apps/upgradable
```

Mengembalikan daftar aplikasi yang mempunyai update tersedia.

---

## 5. Normalized Application Model

ZimaOS data tidak dipakai mentah-mentah oleh seluruh aplikasi internal. Adapter harus mengubahnya ke model ternormalisasi.

```text
Application
├── identity
├── runtime
├── deployment
├── persistent_sources
├── database_targets
├── backup_policy
└── health
```

Contoh konseptual:

```yaml
id: sisfov2
name: SISFO
runtime: docker
service_name: sisfo
container_name: sisfo_zimaos
status: running
managed_by: zimaos
deployment:
  type: compose
  build_context: /DATA/AppData/sisfov2
  dockerfile: Dockerfile
  ports:
    - published: 6091
      target: 6091
persistent_sources:
  - /DATA/AppData/sisfov2/storage
  - /DATA/AppData/sisfov2/public/uploads
databases:
  - engine: mariadb
    database: sisfonext_db
```

Nilai secret seperti password, JWT secret, dan credential tidak boleh dimasukkan ke log atau UI dalam bentuk mentah.

---

## 6. Resource Classification

Resource server dibagi menjadi tiga kategori.

### Application

Contoh:

- SISFO
- Cashflow
- ADMS
- Kolase / PhotoApp

### Infrastructure

Contoh:

- MariaDB
- Pi-hole
- Tailscale
- Cloudflared

### System

Contoh:

- ZimaOS
- Docker Engine
- CPU
- RAM
- Storage
- Network

MariaDB, khususnya, diperlakukan sebagai infrastructure/database service, bukan sekadar aplikasi biasa.

---

## 7. Backup Philosophy

Backup Engine harus generic.

Engine tidak boleh mempunyai kode khusus seperti:

```text
if app == "sisfo" ...
if app == "cashflow" ...
```

Sebaliknya aplikasi didefinisikan dengan sumber backup.

```text
Backup Job
├── application
├── deployment snapshot
├── database sources
├── filesystem sources
├── destination
├── retention
├── verification
└── schedule
```

---

## 8. Backup Source Types

Minimal v1:

```text
folder
file
database
deployment
```

### Folder

Digunakan untuk persistent application data dan uploads.

### File

Digunakan untuk file konfigurasi tertentu jika dibutuhkan.

### Database

Digunakan untuk logical backup database.

### Deployment

Digunakan untuk menyimpan snapshot Compose/deployment metadata.

---

## 9. Database Backup Strategy

Database tidak dibackup dengan menyalin direktori data mentah sebagai metode utama.

### MariaDB

Gunakan logical backup / dump.

Contoh kebutuhan aplikasi saat ini:

```text
MariaDB
├── sisfonext_db
├── cashflow_next
└── adms_db
```

Satu database service dapat mempunyai beberapa logical database target.

### SQLite

SQLite harus dibackup secara konsisten dengan mekanisme SQLite yang memperhatikan WAL/SHM.

Untuk PhotoApp, database berada di dalam persistent data `/opt/kolase/data` dan sebelumnya telah terdeteksi sebagai SQLite dengan WAL aktif.

Jangan mengandalkan copy mentah `.sqlite` saja ketika database sedang aktif.

---

## 10. Application File Backup

Backup mengambil data dari persistent bind mounts yang relevan.

Contoh pola:

```text
SISFO
├── /DATA/AppData/sisfov2/storage
└── /DATA/AppData/sisfov2/public/uploads

Cashflow
└── /DATA/AppData/cashflow-next/storage

ADMS
└── /DATA/AppData/adms

Kolase
└── /opt/kolase/data
```

Docker `overlay2` tidak dianggap sebagai application backup source.

---

## 11. Deployment Snapshot

Setiap backup application menyimpan deployment snapshot.

Minimal:

```text
deployment.yaml
```

Snapshot dapat berasal dari endpoint Compose ZimaOS.

Tujuannya agar recovery mempunyai konteks:

- service name
- image/build context
- ports
- networks
- volumes
- restart policy
- healthcheck
- deployment metadata

Secret yang tidak perlu disimpan harus disanitasi.

---

## 12. Backup Artifact Layout

Format konseptual:

```text
BackupRoot/
└── applications/
    └── <application-id>/
        ├── <timestamp-1>/
        │   ├── manifest.json
        │   ├── deployment.yaml
        │   ├── database/
        │   └── files/
        ├── <timestamp-2>/
        └── <timestamp-3>/
```

Timestamp directory adalah physical identifier. UI dapat menampilkan Version 1, Version 2, Version 3 berdasarkan urutan terbaru.

---

## 13. Manifest

Setiap backup menghasilkan manifest.

Contoh:

```json
{
  "format_version": 1,
  "application": "sisfov2",
  "created_at": "2026-09-05T02:00:00+07:00",
  "zimaos_version": "1.7.1",
  "architecture": "amd64",
  "backup_engine_version": "1.0.0",
  "sources": [],
  "artifacts": [],
  "checksums": {}
}
```

Manifest adalah metadata recovery, bukan tempat menyimpan secret aplikasi.

---

## 14. Retention Policy

Default:

```text
max versions = 3
```

Strategi harus aman terhadap kegagalan.

### Wrong

```text
delete old v3
rename v2 -> v3
rename v1 -> v2
create new v1
```

Jika proses gagal, backup terakhir dapat rusak atau hilang.

### Correct

```text
create temporary backup
        |
        v
verify backup
        |
        v
mark SUCCESS
        |
        v
promote new version
        |
        v
delete artifacts older than 3 good versions
```

Aturan fundamental:

> Backup baru gagal = backup lama tidak disentuh.

---

## 15. Backup Policy

Global default policy:

```text
schedule: configurable
time: configurable
timezone: Asia/Jakarta
retention: 3
verification: enabled
```

Per-application override diperbolehkan.

Contoh:

```text
Global: every 3 days at 02:00

SISFO: use global
Cashflow: use global
ADMS: every 7 days at 03:00
Kolase: every 7 days at 04:00
```

---

## 16. Destination Model

Destination abstraction:

```text
Destination
├── local
├── smb
├── nfs
├── google_drive (future)
└── s3_compatible (future)
```

v1 implementation target:

```text
Local
Synology via SMB/NFS
```

---

## 17. Restore Workflow

Restore harus berbentuk workflow, bukan single destructive action.

```text
Select backup
      |
      v
Preview
      |
      v
Validate
      |
      v
Confirm
      |
      v
Prepare safety backup
      |
      v
Restore database/files/deployment
      |
      v
Start / verify runtime
      |
      v
Health check
```

Restore mode yang direncanakan:

- Safe
- Replace

Safe mode membuat state perlindungan sebelum overwrite.

---

## 18. Application Backup UI

Konsep halaman:

```text
Backup SISFO
────────────────────────────
Enable Backup             ON

Schedule
Every [3] days
At [02:00]

Retention
[3] versions

Sources
☑ /DATA/AppData/sisfov2/storage
☑ /DATA/AppData/sisfov2/public/uploads
☑ MariaDB / sisfonext_db

Destination
☑ Local
☑ Synology
☐ Cloud

[ Save Configuration ]
[ Run Backup Now ]
```

Application yang baru terdeteksi tetapi belum dikonfigurasi harus ditandai:

```text
Backup not configured
```

bukan otomatis dianggap protected.

---

## 19. Dashboard

Dashboard v1 minimal menampilkan:

- total applications
- running applications
- protected applications
- applications without backup configuration
- last backup status
- local storage usage
- backup storage usage
- Synology connectivity
- failed backup alerts
- update availability

Contoh status:

```text
SISFO       Protected
Cashflow    Protected
ADMS        Protected
Kolase      Protected
NewApp      Backup not configured
```

---

## 20. Docker Module

Docker module v1 fokus read-only:

- Containers
- Images
- Networks
- Volumes
- Stats
- Logs
- Mounts

Destructive lifecycle operation bukan fokus milestone pertama.

---

## 21. Storage Module

Minimal:

```text
/DATA
/DATA/AppData
/DATA/Backup
/opt/kolase/data
```

Tampilkan:

- used
- free
- largest directories
- application data size
- backup size

---

## 22. Security

Request flow:

```text
Browser
  |
  v
Authentication
  |
  v
Authorization
  |
  v
Control Center API
  |
  v
Adapters
```

Tidak boleh ada pola:

```text
Browser -> arbitrary shell command
```

Terminal penuh ditunda.

### Secret rules

- jangan log raw Compose response
- jangan tampilkan database password
- jangan tampilkan JWT secret
- jangan simpan secret jika tidak diperlukan
- gunakan credential reference/secret storage

---

## 23. Internal API Draft

Read-only:

```http
GET /api/apps
GET /api/apps/{id}
GET /api/apps/{id}/deployment
GET /api/apps/{id}/backup
GET /api/backups
GET /api/backups/{id}
```

Mutating operations:

```http
POST /api/apps/{id}/backup/run
POST /api/apps/{id}/backup/config
POST /api/backups/{id}/restore
```

Semua operasi mutating harus mempunyai audit trail dan confirmation guard.

---

## 24. Suggested Project Structure

```text
zima-control-center/
├── README.md
├── docs/
│   ├── BLUEPRINT-V1.md
│   └── AUDIT-ZIMAOS.md
├── apps/
│   ├── web/
│   └── worker/
├── packages/
│   ├── core/
│   ├── zimaos-adapter/
│   ├── docker-adapter/
│   ├── backup-engine/
│   ├── database-adapter/
│   └── storage-adapter/
└── prisma/
```

---

## 25. Data Model Draft

### applications

```text
id
name
display_name
app_type
runtime
service_name
container_name
status
managed_by
zimaos_app_id
created_at
updated_at
```

### application_deployments

```text
id
application_id
compose_yaml
source_context
dockerfile
image
network
ports
environment_metadata
env_file_paths
captured_at
```

### backup_sources

```text
id
application_id
source_type
source_path
container_path
database_engine
database_name
database_host
enabled
backup_method
```

### database_connections

```text
id
name
engine
host
port
username
credential_ref
status
```

### backup_database_targets

```text
id
database_connection_id
database_name
backup_method
```

### backup_destinations

```text
id
name
type
path
enabled
credentials_ref
```

### backup_policies

```text
id
name
schedule
time
timezone
retention_count
verification_enabled
compression
enabled
```

### application_backup_policies

```text
application_id
policy_id
override_enabled
```

### backup_jobs

```text
id
application_id
policy_id
destination_id
started_at
finished_at
status
size_bytes
files_count
database_count
error_message
verification_status
```

---

## 26. Definition of Done — v1

Skenario penerimaan utama:

```text
Fresh ZimaOS
  |
  v
Install Zima Control Center
  |
  v
Discover applications automatically
  |
  v
Configure backup
  |
  v
Run backup
  |
  +--> MariaDB dump
  +--> SQLite consistent backup
  +--> persistent files
  +--> deployment snapshot
  +--> manifest
  +--> checksums
  +--> verification
  |
  v
Copy to Synology
  |
  v
Keep exactly 3 good versions
  |
  v
Simulate application failure
  |
  v
Restore
  |
  v
Start application
  |
  v
Health check passes
```

---

## 27. Initial Implementation Order

### Milestone 1A

Build adapters dan normalized models tanpa mutating operation.

### Milestone 1B

Build Application Registry dan Dashboard inventory.

### Milestone 2A

Build Backup Registry dan policy UI.

### Milestone 3A

Build Local Backup Engine.

### Milestone 4A

Build scheduler dan job worker.

### Milestone 5A

Build Synology destination.

### Milestone 6A

Build restore workflow.

---

## 28. Non-Goals for the First Coding Session

Jangan langsung:

- membuat restore engine
- membuat shell terminal dari browser
- membuat POST/PUT/PATCH/DELETE ke ZimaOS API
- mengubah konfigurasi aplikasi existing
- memindahkan Docker storage
- menyentuh `/var/lib/docker/overlay2`

Sesi coding pertama harus read-only dan menghasilkan inventory yang dapat diverifikasi.
