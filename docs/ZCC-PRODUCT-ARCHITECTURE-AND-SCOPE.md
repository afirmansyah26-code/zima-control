# Zima Control Center — Product Architecture & Scope

## 1. Product Identity

Zima Control Center (ZCC) adalah aplikasi Docker terpisah
yang berjalan di ZimaOS.

Akses pengguna:

http://<ZIMAOS-IP>:<ZCC-PORT>

ZCC bukan pengganti ZimaOS.
ZCC bukan pengganti Portainer.
ZCC bukan pengganti Arcane.

Tujuan utama ZCC adalah:

> Application Backup & Recovery Manager untuk workload Docker
> yang berjalan di ZimaOS.

---

## 2. Primary User Problem

ZCC dibuat untuk melindungi data aplikasi Docker yang sudah
berjalan di ZimaOS.

Data yang harus dapat dilindungi:

1. Database aplikasi
2. Uploaded files
3. Uploaded photos
4. Uploaded documents
5. Persistent application files

ZCC harus menyediakan:

- backup manual
- backup terjadwal
- verification
- retention
- destination management
- restore
- history/audit

---

## 3. Role of ZCC

ZCC memiliki dua peran:

### Primary

Data Protection / Backup & Recovery

### Supporting

Basic Application Runtime Management

Runtime management hanya digunakan untuk mendukung
operasional aplikasi dan workflow backup/recovery.

---

## 4. Runtime Scope

Runtime operations yang diperbolehkan:

- STATUS
- INSPECT
- START
- STOP
- RESTART

Future basic deployment operations:

- Update source from GitHub
- BUILD
- REBUILD

Runtime feature harus tetap sederhana.

ZCC tidak ditujukan menjadi full Docker management platform.

---

## 5. Explicit Non-Goals

Jangan mengembangkan ZCC menjadi:

- Portainer clone
- Arcane clone
- full Docker IDE
- Kubernetes manager
- Swarm manager
- terminal platform
- arbitrary shell executor
- arbitrary docker exec interface
- general-purpose host administration panel

---

## 6. Terminal Policy

Interactive terminal tetap berada pada:

- Portainer
- Arcane

Contoh:

npx prisma migrate deploy
npx prisma generate
php artisan migrate
php artisan storage:link
composer install
npm install

ZCC tidak menyediakan arbitrary terminal/shell.

Future structured maintenance commands dapat dipertimbangkan
sebagai fitur terkontrol, tetapi bukan terminal bebas.

---

## 7. Docker Responsibility Boundary

Portainer / Arcane:

- terminal
- docker exec
- compose editing
- troubleshooting
- advanced Docker administration
- manual Docker operations

ZCC:

- application registry
- backup configuration
- backup execution
- restore
- scheduler
- retention
- verification
- backup destination
- basic runtime lifecycle

---

## 8. Target Application Model

Contoh:

SISFO
├── Database
│ └── MariaDB
├── Uploaded photos
├── Uploaded documents
└── Persistent application files

ZCC protects application data,
not Docker overlay2 internals.

---

## 9. Backup Architecture

Backup sources terdiri dari:

### Database Source

Contoh:

MariaDB
SQLite
PostgreSQL
future engines

### File Source

Contoh:

/DATA/AppData/sisfov2/storage
/DATA/AppData/sisfov2/public/uploads

Database dan file source diperlakukan
sebagai sumber backup yang berbeda.

---

## 10. Backup Workflow

Backup:

Application
→ discover configured sources
→ database backup
→ file backup
→ manifest
→ checksum
→ verification
→ finalize backup
→ retention

Backup yang gagal tidak boleh menghancurkan
last known good backup.

Retention default maksimum:

3 verified versions

---

## 11. Destinations

Initial:

- Local

Next:

- Synology

Future-ready:

- Cloud destinations

---

## 12. Scheduler

Scheduler harus mendukung:

Global default schedule
Per-application override
Job queue
Job history
Failure reporting

Contoh:

SISFO
Every day
02:00

Cashflow
Every 3 days
02:30

---

## 13. Restore

Restore harus mendukung:

- restore preview
- safety protection before overwrite
- database restore
- file restore
- verification
- post-restore health verification

---

## 14. UI Direction

ZCC UI harus terasa seperti
application backup/recovery control panel.

Contoh menu:

Dashboard
Applications
Backups
Schedules
Destinations
Restore
Jobs / History
Settings

Application detail:

SISFO
├── Overview
├── Runtime
├── Backup
├── Backup History
└── Restore

---

## 15. Architectural Rule

Every feature proposal must answer:

1. Apakah fitur ini membantu backup/recovery?
2. Apakah fitur ini membantu basic application operation?
3. Apakah fitur ini diperlukan untuk keamanan/reliability ZCC?
4. Apakah fitur ini hanya menjadikan ZCC sebagai Docker manager yang
   lebih kompleks?

Jika jawaban utamanya adalah #4,
fitur tersebut harus ditolak atau ditunda.

---

## 16. Agent Guardrail

Agent MUST NOT:

- broaden ZCC into a Portainer/Arcane replacement
- add arbitrary terminal access
- add arbitrary docker exec
- add arbitrary Docker API passthrough
- bypass runtime adapter boundaries
- add host shell execution from Web UI
- introduce unrelated Docker management features
- prioritize runtime management over backup/recovery without explicit approval

Agent SHOULD prioritize:

1. Backup
2. Recovery
3. Scheduler
4. Verification
5. Retention
6. Destination management
7. Application registry
8. Basic runtime operations

---

## 17. Architecture Principle

ZCC is:

Application-centric
Backup-centric
Recovery-centric
Docker-aware

ZCC is NOT:

Docker-centric
Container-admin-centric
Host-admin-centric

---

## 18. Future Evolution

Future versions may expand ZCC toward:

- broader Docker management
- application deployment
- monitoring
- storage management
- control-panel functionality

However:

> Future expansion must not alter the current product identity
> without an explicit architecture decision.
