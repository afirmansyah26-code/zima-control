# Milestone 1A.1 — ZimaOS Adapter

## Status

1A.1.1 Project packages: Completed

- npm workspaces dibuat.
- Tiga workspace dibuat: `@zima-control-center/worker`, `@zima-control-center/core`, dan `@zima-control-center/zimaos-adapter`.
- TypeScript shared configuration dibuat.
- Workspace dependency direction: worker bergantung pada core dan zimaos-adapter; core dan zimaos-adapter tidak saling bergantung.
- Typecheck berhasil.

Implementation note: 1A.1.2 - ZimaOSClient masih pending. Endpoint ZimaOS belum diimplementasikan pada milestone ini.

Kita lanjut **langsung ke Milestone 1A.1: ZimaOS Adapter — read-only discovery**.

Untuk tahap ini targetnya bukan UI dan bukan database write. Kita membuat adapter yang bisa:

```text
ZimaOS
  ├── installed/list
  └── compose/{app}
        ↓
ZimaOS Adapter
        ↓
Normalized Application data
```

Saya sarankan kita implementasikan dalam proyek baru secara bertahap. Karena source code proyek belum kita lihat, saya tidak akan mengasumsikan struktur yang sudah ada.

### 1. Struktur yang kita buat

```text
zima-control-center/
├── apps/
│   └── worker/
├── packages/
│   ├── core/
│   └── zimaos-adapter/
├── prisma/
│   └── schema.prisma
└── docs/
    ├── BLUEPRINT-V1.md
    ├── AUDIT-ZIMAOS.md
    ├── ERD-APPLICATION-REGISTRY.md
    └── MILESTONE-1A1-ZIMAOS-ADAPTER.md
```

`zimaos-adapter` bertanggung jawab **hanya membaca ZimaOS**.

Tidak boleh ada:

```text
POST
PUT
PATCH
DELETE
docker stop
docker restart
docker rm
```

pada milestone ini.

---

## 2. Kontrak adapter

Kita buat API internal sesederhana mungkin:

```ts
export interface ZimaOSAdapter {
  getInstalledApplications(): Promise<ZimaOSApplication[]>;
  getApplicationCompose(appName: string): Promise<string>;
}
```

Data mentah ZimaOS:

```ts
export interface ZimaOSApplication {
  id: string;
  name: string;
  title?: Record<string, string>;
  app_type?: string;
  author_type?: string;
  status?: string;
  install_status?: string;
  is_uncontrolled?: boolean;
  port?: string | null;
  scheme?: string | null;
  version?: string | null;
  containers: ZimaOSContainer[];
}
```

dan:

```ts
export interface ZimaOSContainer {
  id: string;
  name: string;
  image: string;
  service_name: string;
  state: string;
  status: string;
  port_mappings: string[];
}
```

Kita **menyimpan struktur raw ini sebagai tipe TypeScript**, tetapi belum langsung memasukkannya ke database.

---

## 3. HTTP client

Buat:

```text
packages/zimaos-adapter/src/client.ts
```

Contoh:

```ts
export class ZimaOSClient {
  constructor(
    private readonly baseUrl: string,
  ) {}

  private async request<T>(path: string): Promise<T> {
    const response = await fetch(
      `${this.baseUrl}${path}`,
      {
        method: "GET",
        headers: {
          Accept: "application/json",
        },
      },
    );

    if (!response.ok) {
      throw new Error(
        `ZimaOS API ${response.status}: ${response.statusText}`,
      );
    }

    return response.json() as Promise<T>;
  }

  async getInstalledApplications(): Promise<ZimaOSApplication[]> {
    const result = await this.request<{
      data: ZimaOSApplication[];
    }>(
      "/v2/app_management/installed/list?mode=sync",
    );

    return result.data;
  }

  async getApplicationCompose(
    appName: string,
  ): Promise<string> {
    const response = await fetch(
      `${this.baseUrl}/v2/app_management/compose/${encodeURIComponent(appName)}`,
      {
        method: "GET",
        headers: {
          Accept: "application/yaml",
        },
      },
    );

    if (!response.ok) {
      throw new Error(
        `ZimaOS Compose API ${response.status}: ${response.statusText}`,
      );
    }

    return response.text();
  }
}
```

Perhatikan `compose` menggunakan:

```http
Accept: application/yaml
```

karena dari audit kita sudah membuktikan ZimaOS memang menyediakan YAML secara langsung.

---

# 4. Jangan simpan secret dari Compose

Ini bagian yang sangat penting.

Response SISFO/MariaDB kita sudah menunjukkan bahwa Compose API dapat mengembalikan credential dan secret.

Karena itu adapter harus mempunyai sanitizer.

Misalnya:

```text
DATABASE_URL
JWT_SECRET
MYSQL_PASSWORD
MYSQL_ROOT_PASSWORD
```

tidak boleh masuk log.

Kita buat:

```text
packages/zimaos-adapter/src/sanitize.ts
```

Konsep:

```ts
const SECRET_KEYS = new Set([
  "PASSWORD",
  "PASS",
  "SECRET",
  "TOKEN",
  "API_KEY",
  "DATABASE_URL",
]);

export function isSecretKey(key: string): boolean {
  const normalized = key.toUpperCase();

  for (const pattern of SECRET_KEYS) {
    if (normalized.includes(pattern)) {
      return true;
    }
  }

  return false;
}
```

Untuk logging:

```text
DATABASE_URL = [REDACTED]
JWT_SECRET   = [REDACTED]
```

Tetapi jangan sampai sanitizer mengubah data source sebelum kita membutuhkan data deployment sebenarnya. Jadi:

```text
raw response
    ↓
parser
    ↓
normalized metadata
    ↓
safe logging
```

bukan:

```text
raw response
    ↓
redact permanently
    ↓
database
```

---

# 5. Normalizer

Ini lapisan yang menurut saya sangat penting.

ZimaOS mempunyai struktur sendiri:

```text
app
└── containers
```

Sedangkan database kita punya:

```text
Application
└── Deployment
    └── Service
```

Maka:

```text
packages/zimaos-adapter/src/normalizer.ts
```

mengubah:

```text
ZimaOSApplication
      +
Compose YAML
```

menjadi:

```text
NormalizedApplication
```

Contoh:

```ts
export interface NormalizedApplication {
  name: string;
  displayName: string;
  status: string;
  managedBy: "zimaos" | "uncontrolled" | "unknown";

  services: NormalizedService[];
}
```

dan:

```ts
export interface NormalizedService {
  name: string;
  containerName: string | null;
  image: string | null;

  ports: Array<{
    published: string;
    target: number;
    protocol: string;
  }>;

  volumes: Array<{
    source: string;
    target: string;
  }>;

  networks: string[];
}
```

---

# 6. Contoh hasil normalisasi SISFO

Input dari ZimaOS:

```text
sisfov2
```

hasil:

```json
{
  "name": "sisfov2",
  "displayName": "SISFO",
  "status": "running",
  "managedBy": "zimaos",
  "services": [
    {
      "name": "sisfo",
      "containerName": "sisfo_zimaos",
      "image": null,
      "ports": [
        {
          "published": "6091",
          "target": 6091,
          "protocol": "tcp"
        }
      ],
      "volumes": [
        {
          "source": "/DATA/AppData/sisfov2/storage",
          "target": "/app/storage"
        },
        {
          "source": "/DATA/AppData/sisfov2/public/uploads",
          "target": "/app/public/uploads"
        }
      ],
      "networks": [
        "tunnel_net",
        "zima-net"
      ]
    }
  ]
}
```

Karena SISFO menggunakan `build`, bukan `image`, normalizer harus mampu meng-handle keduanya.

---

# 7. Compose parser

Karena response YAML perlu dibaca, package ini membutuhkan YAML parser.

Saya menyarankan:

```text
yaml
```

bukan parser buatan sendiri.

Contoh:

```ts
import { parse } from "yaml";

const compose = parse(composeYaml);
```

Kemudian:

```ts
compose.services
```

bisa dipetakan ke `ApplicationService`.

---

# 8. Discovery service

Kemudian kita buat:

```text
packages/core/src/application-discovery.ts
```

Alurnya:

```ts
const apps = await zimaos.getInstalledApplications();

for (const app of apps) {
  const compose =
    await zimaos.getApplicationCompose(app.name);

  const normalized =
    normalizeApplication(app, compose);

  // Milestone 1A.1:
  // hanya return / report
}
```

Belum melakukan:

```ts
prisma.application.upsert(...)
```

karena kita ingin **memastikan hasil discovery benar dulu**.

---

# 9. Output CLI

Saya justru ingin Milestone 1A.1 menghasilkan command:

```bash
npm run discovery
```

Output:

```text
Zima Control Center
Application Discovery
────────────────────────────────

ZimaOS API:
  http://127.0.0.1

Applications discovered: 12

✓ adms_web
  service: adms_web
  container: adms_web-adms_web-1
  status: running
  volumes: 1

✓ cashflow-next
  service: cashflow
  container: cashflow_zimaos
  status: running
  volumes: 1

✓ kolase
  service: photoapp
  container: photoapp
  status: running
  volumes: 1

✓ sisfov2
  service: sisfo
  container: sisfo_zimaos
  status: running
  volumes: 2

✓ mariadb
  service: mariadb
  container: mariadb-mariadb-1
  status: running
  volumes: 1

...

Discovery completed.
```

Tidak ada secret yang ditampilkan.

---

# 10. Acceptance criteria Milestone 1A.1

Kita nyatakan milestone ini berhasil kalau:

```text
✅ Connect ke ZimaOS gateway
✅ GET installed/list berhasil
✅ Semua aplikasi terdeteksi
✅ GET compose/{app} berhasil
✅ YAML berhasil diparse
✅ build/image sama-sama didukung
✅ volumes terdeteksi
✅ ports terdeteksi
✅ networks terdeteksi
✅ container mapping terdeteksi
✅ managed/uncontrolled terdeteksi
✅ secret tidak muncul di log
✅ tidak ada operasi mutasi
✅ discovery bisa dijalankan berulang
```

Target praktis pada server Anda:

```text
ADMS       → discovered
SISFO      → discovered
Cashflow   → discovered
Kolase     → discovered
MariaDB    → discovered
```

dan aplikasi lain juga otomatis ikut masuk tanpa kita menambahkan nama secara manual.

---

## 11. Dokumentasi

Kita juga perlu menambahkan:

```text
docs/MILESTONE-1A1-ZIMAOS-ADAPTER.md
```

Isinya:

```text
Purpose
API endpoints
Request/response contract
TypeScript models
Normalization rules
Secret handling
Error handling
Acceptance criteria
Known limitations
```

Ini penting supaya ketika beberapa hari lagi kita melanjutkan proyek, kita tahu persis **apa yang sudah dibuktikan dan apa yang belum**.

### Urutan implementasi sekarang

```text
1A.1.1  Project packages
1A.1.2  ZimaOSClient
1A.1.3  Raw API types
1A.1.4  YAML parser
1A.1.5  Normalizer
1A.1.6  Secret sanitizer
1A.1.7  Discovery CLI
1A.1.8  Test terhadap ZimaOS nyata
```

## Status

Status: Planned

Sub-milestone:
1A.1.1 Project packages
1A.1.2 ZimaOSClient
1A.1.3 Raw API types
1A.1.4 YAML parser
1A.1.5 Normalizer
1A.1.6 Secret sanitizer
1A.1.7 Discovery CLI
1A.1.8 Test terhadap ZimaOS nyata

Kemudian setelah implementasi selesai, kita ubah menjadi:
Status: Completed
Completed date: YYYY-MM-DD