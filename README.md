# Zima Control Center

Zima Control Center adalah control/orchestration layer untuk server ZimaOS yang menjalankan aplikasi Docker.

Proyek ini **tidak menggantikan ZimaOS**. ZimaOS tetap menjadi platform runtime dan application management; Zima Control Center menambahkan registry aplikasi yang ternormalisasi, backup/restore, destination management, scheduler, monitoring, dan workflow operasional.

## Status

**Blueprint / Discovery Phase**

Belum ada implementasi produksi.

## Target v1

- Application Registry
- ZimaOS deployment discovery
- Docker/runtime inventory
- Backup Registry
- Generic Backup Engine
- Restore Engine
- Local backup destination
- Synology backup destination
- Scheduler
- Job history dan verification
- Dashboard dan alerts dasar

## Prinsip desain

1. ZimaOS tetap menjadi platform runtime.
2. Discovery harus generic, bukan hard-coded untuk aplikasi tertentu.
3. Backup Engine juga generic dan dikonfigurasi dari dashboard.
4. Database aplikasi dan persistent files diperlakukan sebagai sumber backup yang berbeda.
5. Docker `overlay2` bukan sumber backup aplikasi.
6. Backup baru harus diverifikasi sebelum backup lama disentuh.
7. Retention default maksimum 3 versi.
8. Secret tidak boleh ditampilkan atau dicatat dalam log secara mentah.
9. Operasi read-only menjadi fondasi awal; operasi mutating diberi guard dan audit trail.

## Dokumentasi

- [Blueprint Zima Control Center v1](docs/BLUEPRINT-V1.md)
- [Audit ZimaOS](docs/AUDIT-ZIMAOS.md)

## Tahap implementasi

### Milestone 1 — Read-only Inventory

- ZimaOS API adapter
- Docker adapter
- Normalized Application Model
- Dashboard inventory dasar

### Milestone 2 — Backup Registry

- Backup sources
- Database targets
- Destinations
- Policies
- Retention

### Milestone 3 — Local Backup Engine

- MariaDB logical backup
- SQLite consistent backup
- Folder/file archive
- Manifest
- Checksums
- Verification
- Retention 3 versi

### Milestone 4 — Scheduler

- Global default schedule
- Per-app override
- Job queue
- Job history

### Milestone 5 — Synology

- SMB/NFS destination
- Rolling retention
- Connectivity check
- Verification

### Milestone 6 — Restore

- Restore preview
- Pre-restore safety backup
- Database restore
- File restore
- Deployment restore
- Health verification
