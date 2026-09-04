# Zima Control Center v1 — ERD Application Registry

**Milestone:** 1A  
**Status:** Design draft  
**Scope:** Application Registry + deployment discovery

## 1. Tujuan

Application Registry adalah canonical model milik Zima Control Center untuk merepresentasikan aplikasi yang ditemukan dari ZimaOS dan runtime Docker.

Registry **tidak menggantikan** data internal ZimaOS. ZimaOS tetap menjadi sumber discovery, sedangkan database ini menyimpan model ternormalisasi dan metadata discovery yang diperlukan oleh fitur Zima Control Center.

## 2. Batas Milestone 1A

Masuk:

- identitas aplikasi
- klasifikasi application/infrastructure
- referensi ID aplikasi ZimaOS
- current deployment
- service Compose
- port mapping
- bind mount / volume mapping
- network
- environment metadata tanpa secret plaintext
- container/runtime identity
- discovery timestamps
- source hash untuk mendeteksi perubahan deployment

Belum masuk:

- backup policy
- backup destination
- backup job
- restore job
- scheduler
- credential/secret vault
- destructive lifecycle operations

## 3. Prinsip Data

### 3.1 Application adalah entitas utama

Satu aplikasi dapat mempunyai satu deployment aktif, beberapa service Compose, beberapa port, mount, network, dan container.

### 3.2 Raw Compose tidak boleh menyimpan secret plaintext

Endpoint Compose ZimaOS dapat mengembalikan `DATABASE_URL`, password, JWT secret, dan environment sensitif lainnya. Database registry menyimpan **sanitized/redacted compose** dan metadata environment, bukan secret mentah.

### 3.3 Discovery bersifat idempotent

Discovery berikutnya harus memperbarui record yang sama berdasarkan stable identity, bukan membuat duplikasi aplikasi.

### 3.4 ZimaOS ID dan nama aplikasi bukan hal yang sama

`zimaos_app_id` disimpan terpisah dari `name` agar perubahan display name tidak merusak identity internal.

## 4. ERD Konseptual

```text
┌────────────────────────┐
│       Application      │
├────────────────────────┤
│ id PK                  │
│ name UNIQUE            │
│ display_name           │
│ resource_type          │
│ runtime                │
│ status                 │
│ managed_by             │
│ zimaos_app_id          │
│ zimaos_store_app_id    │
│ is_uncontrolled        │
│ last_discovered_at     │
└───────────┬────────────┘
            │ 1
            │
            │ 0..1
┌───────────▼────────────┐
│  ApplicationDeployment │
├────────────────────────┤
│ id PK                  │
│ application_id FK UQ  │
│ compose_name           │
│ compose_yaml_redacted  │
│ source_context         │
│ dockerfile_path        │
│ source_hash            │
│ discovered_at          │
└───────────┬────────────┘
            │ 1
            │
            ├───────────────< ApplicationService
            │                  │
            │                  ├──< DeploymentPort
            │                  ├──< DeploymentVolume
            │                  ├──< DeploymentNetwork
            │                  ├──< EnvironmentVariable
            │                  └──< RuntimeContainer
            │
            └───────────────< DeploymentNetwork
```

## 5. Entitas

### Application

Identity dan status canonical aplikasi.

Contoh:

```text
sisfov2 / SISFO / application / docker / running
```

### ApplicationDeployment

Snapshot deployment terakhir yang berhasil dibaca dari ZimaOS Compose API.

Menyimpan `compose_yaml_redacted`, build context, Dockerfile, dan hash.

### ApplicationService

Representasi service Compose. Satu deployment dapat mempunyai banyak service.

### DeploymentPort

Mapping port Compose seperti `6091:6091/tcp`.

### DeploymentVolume

Mount seperti:

```text
/DATA/AppData/sisfov2/storage -> /app/storage
```

`source` adalah path host dan `target` adalah path container.

### DeploymentNetwork

Network yang digunakan service, termasuk apakah network external.

### EnvironmentVariable

Metadata environment variable. Untuk variable secret, nilai plaintext tidak disimpan.

### RuntimeContainer

Identity runtime Docker terakhir yang diketahui untuk service, termasuk container ID, container name, image, dan state.

## 6. Identity Strategy

Prioritas identity:

```text
1. zimaos_app_id, jika tersedia
2. runtime/container/compose identity hasil discovery
3. fallback internal generated ID
```

Untuk aplikasi ZimaOS, contoh:

```text
zimaapp://v2app/sisfov2
```

Untuk aplikasi yang tidak memiliki ZimaOS ID, `name` internal tetap harus unik dan stabil.

## 7. Status Model

Status application canonical:

```text
RUNNING
STOPPED
DEGRADED
ERROR
UNKNOWN
```

Status discovery terpisah dari status runtime. Discovery gagal tidak boleh otomatis mengubah aplikasi menjadi `STOPPED`.

## 8. Managed Model

`managed_by`:

```text
ZIMAOS
EXTERNAL
UNKNOWN
```

`is_uncontrolled` tetap disimpan karena merupakan metadata yang diberikan ZimaOS dan berguna untuk membedakan resource seperti MariaDB.

## 9. Discovery Upsert

Pseudo-flow:

```text
GET installed/list
        |
        v
normalize application
        |
        v
find by zimaos_app_id
        |
   +----+----+
   |         |
 found     new
   |         |
 update    insert
   |
   v
GET compose/{app}
   |
   v
sanitize secrets
   |
   v
calculate source_hash
   |
   v
replace current deployment snapshot
```

Runtime container data diperbarui dari Docker/ZimaOS tanpa mengubah identity aplikasi.

## 10. Change Detection

`source_hash` dihitung dari representasi deployment yang sudah disanitasi dan dinormalisasi.

Tujuannya:

```text
hash sama     -> deployment tidak berubah
hash berbeda  -> deployment berubah
```

Perubahan environment secret tidak dapat dibandingkan berdasarkan nilai plaintext karena secret tidak disimpan. Untuk secret, registry cukup mengetahui bahwa variable tersebut ada dan bertipe secret.

## 11. Contoh Data SISFO

```text
Application
  id: sisfov2
  name: sisfov2
  display_name: SISFO
  resource_type: APPLICATION
  runtime: DOCKER
  managed_by: ZIMAOS
  status: RUNNING
  zimaos_app_id: zimaapp://v2app/sisfov2

Deployment
  compose_name: sisfov2
  source_context: /DATA/AppData/sisfov2
  dockerfile_path: /DATA/AppData/sisfov2/Dockerfile

Service
  name: sisfo
  container_name: sisfo_zimaos
  image: null
  build_context: /DATA/AppData/sisfov2

Volumes
  /DATA/AppData/sisfov2/storage -> /app/storage
  /DATA/AppData/sisfov2/public/uploads -> /app/public/uploads

Ports
  6091 -> 6091/tcp
```

## 12. Contoh Data Kolase

```text
Application
  id: kolase
  name: kolase
  display_name: Kolase
  resource_type: APPLICATION
  runtime: DOCKER

Deployment
  source_context: /opt/kolase

Service
  name: photoapp
  container_name: photoapp
  build_context: /opt/kolase

Volume
  /opt/kolase/data -> /data

Port
  3000 -> 3000/tcp
```

## 13. Keputusan Arsitektur

Application Registry harus **deployment-aware**, tetapi belum menjadi Backup Registry.

Dengan pemisahan tersebut:

```text
Application Registry
        |
        +--> Backup Registry (Milestone 2)
        |
        +--> Dashboard
        |
        +--> Docker/Runtime
        |
        +--> Restore planning
```

Database registry menjadi sumber state internal Zima Control Center, sedangkan ZimaOS API dan Docker tetap menjadi sumber discovery/runtime.
