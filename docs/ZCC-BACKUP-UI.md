# ZCC Backup Management UI Specification & Architecture

## Overview

The Zima Control Center (ZCC) Backup Management UI provides production-ready visualization, administration, and execution monitoring for application backup lifecycle operations. It strictly consumes approved backend contracts (`/api/apps/:id/backup`, `/api/apps/:id/backup/config`, `/api/apps/:id/backup/run`, `/api/backups`, and `/api/backups/:id`) without redesigning backend schemas or introducing unauthenticated endpoints.

---

## 1. UI States & Components

### 1.1 Application Detail — Backup & Disaster Recovery Section (`#application-backup-section`)
Embedded directly inside the Application Detail view (`createApplicationDetail`), this section displays the full backup posture for an application:
- **Header Actions**:
  - `View in History` quick-link to filter `/backups?applicationId=:id`.
  - `[ Run Backup Now ]` trigger button (bound to Operator and Admin roles).
  - `Edit Configuration` / `Configure Backup` modal trigger (Admin role only).
- **Active Job Banner** (when a backup job is in flight: `QUEUED`, `INITIALIZING`, `CAPTURING`, or `VERIFYING`):
  - Displays dynamic state badge with pulsing indicator.
  - Job ID, trigger type, and started elapsed timestamp.
  - Explanatory notice: *"A backup job is actively executing. Another backup cannot be started until this job completes to prevent data collisions."*
  - Bounded 3-second live polling loop that terminates upon reaching terminal states (`COMPLETED`, `FAILED`, `CANCELLED`).
- **Unconfigured State** (`.backup-empty-panel`):
  - Guidance message explaining that schedule, retention, and storage sources are not configured.
  - Direct call-to-action button for Admins (`Configure Backup Now`) or contextual hint for Viewers/Operators.
- **Configured Overview Cards Grid**:
  - **Automated Schedule**: Displays cron expression or *"Manual Only"*, a human-readable plain-English explanation, and a prominent badge: `Schedule timezone: UTC`.
  - **Retention Policy**: Maximum number of newest verified backups retained (1–100) and policy active/disabled status.
  - **Storage Destination**: Active backup destination name, type (`LOCAL_FILESYSTEM`), and base storage directory path.
- **Latest Verified Backup Card**:
  - Only presented as verified when `verificationStatus === "VERIFIED"`.
  - Displays completed timestamp, trigger badge (`MANUAL` / `SCHEDULED`), artifact archive size formatted in human-readable bytes (e.g. `24.1 KB`), and source summary tags (`Database (MARIADB)`, `Files`).
- **Sources Summary List**:
  - Cards breaking down configured data capture points:
    - **Persistent Files**: Directory host path, file exclusions (e.g. `cache/**`, `*.tmp`), symlink follow policy.
    - **Database**: Engine (`MARIADB` / `MYSQL`), target database name, host, port, username.
    - **Secret Redaction**: Raw database passwords are never rendered in plain text; secret references display as `Protected / Masked (••••••••)`.

### 1.2 Configuration Modal Editor (Admin Only)
- Accessible only to users with the `ADMIN` role.
- Modal dialog with client-side validation and structured input fields:
  - **Status**: Enabled (Active) vs. Disabled (Paused).
  - **Schedule**: Standard 5-field cron expression in UTC, with live real-time human-readable explanation and explicit UTC notice.
  - **Retention**: Bounded integer between 1 and 100.
  - **Sources Editor**: Dynamic list permitting addition, modification, and removal of sources:
    - *Persistent Files*: Source name, host path, exclusions (comma-separated), symlink policy checkbox.
    - *Database*: Engine selector (`MARIADB`, `MYSQL`), target database name, host, port, username, password/secret reference input (`type="password"`).

### 1.3 Backup History View (`/backups`)
- Dedicated top-level navigation route with filterable audit table:
  - **Filters Toolbar**:
    - Application dropdown filter (populated with current applications).
    - Status dropdown filter (`All`, `QUEUED`, `INITIALIZING`, `CAPTURING`, `VERIFYING`, `COMPLETED`, `FAILED`, `CANCELLED`).
    - Verification dropdown filter (`All`, `VERIFIED`, `FAILED`, `UNVERIFIED`).
    - Reset Filters button.
  - **Audit Table Columns**:
    1. Application (with link to Application Detail)
    2. Trigger (`MANUAL`, `SCHEDULED`)
    3. Status (semantic color badges)
    4. Verification (`✓ Verified`, `✗ Verification Failed`, `Unverified`)
    5. Created (UTC timestamp)
    6. Completed (UTC timestamp or in-progress indicator)
    7. Artifact Size (human-readable bytes)
    8. Retained (`Retained` vs `Pruned`)
    9. Actions (`View Details`)
  - **Pagination**: 10 records per page with `First`, `Previous`, Page Indicator (`Page X of Y`), `Next`, and `Last` navigation.

### 1.4 Backup Detail View (`/backups/:id`)
- Deep-dive inspection view for individual backup runs:
  - **Breadcrumbs & Back Navigation**: Direct return to Backup History or Application Detail.
  - **Job Lifecycle Header**: Status badge, trigger type, and execution duration.
  - **4-Tier Verification Engine Checklist**:
    - Tier 1: Checksum & File Existence (SHA-256 verification and file presence on storage).
    - Tier 2: Archive Integrity (tar/gzip structure validity and test extractability).
    - Tier 3: Metadata Conformance (manifest integrity, versioning, and structure match).
    - Tier 4: Payload Verification (database dump validity and file count matching).
  - **Source Task Breakdown**: Per-source capture status, task execution duration, and payload metrics.
  - **Artifact & Manifest Metadata**: Base path, file name, byte size, SHA-256 hash, and schema version.

---

## 2. Role-Based Access Control (RBAC)

The UI respects the 3-tier ZCC role hierarchy, while backend authorization remains authoritative:

| Role | View Backup Posture & History | View Backup Details | Run Backup Now (`POST /run`) | Configure Backups (`POST /config`) |
| :--- | :---: | :---: | :---: | :---: |
| **VIEWER** | ✓ Allowed | ✓ Allowed | ✗ Disabled / Hidden | ✗ Hidden (No Edit Button) |
| **OPERATOR** | ✓ Allowed | ✓ Allowed | ✓ Enabled & Actionable | ✗ Hidden (No Edit Button) |
| **ADMIN** | ✓ Allowed | ✓ Allowed | ✓ Enabled & Actionable | ✓ Full Configuration Access |

*Note: Any attempt to bypass client controls is rejected by backend middleware with `403 FORBIDDEN`.*

---

## 3. UTC Scheduling Presentation

As required by Section 3:
- The backend scheduler operates strictly in **UTC**.
- The UI makes this explicit across all screens:
  - Overview card: `Schedule timezone: UTC`.
  - Cron explanation helper: `Daily at 02:00 — Timezone: UTC`.
  - Configuration form input label: `Schedule (Cron expression in UTC)`.
- No silent conversions to browser local time are performed.

---

## 4. Live Job Polling & Concurrency

- Triggering `POST /api/apps/:id/backup/run` returns:
  - `202 Accepted` when a new job is created.
  - `200 OK` when an existing job is already active (idempotent, safe duplicate handling).
- The client initiates a bounded polling loop every 3 seconds to update the active job state.
- **Termination Guarantee**: Polling stops immediately upon reaching terminal state (`COMPLETED`, `FAILED`, `CANCELLED`) or when navigating away (`destroy()` lifecycle method).
- **Process Safety**: In Node.js testing environments, active timers are unref'd to prevent open handles from hanging test suites.

---

## 5. Security & Secret Redaction

- **Zero Secret Exposure**:
  - The UI never requests, receives, or renders raw database secrets or passwords in plain text.
  - Secret references are masked with bullets (`••••••••`) or protected indicators (`(Configured / Protected)`).
  - In forms, credentials use `type="password"`.
- **Security Boundaries**:
  - No Docker socket or terminal access endpoints are consumed or introduced.
  - Same-origin session cookies and `x-csrf-token` headers are strictly enforced on all mutations.

---

## 6. Error Handling

API error codes are cleanly mapped into safe, user-friendly error banners with retry capabilities:

| API Error Code | User-Facing Description |
| :--- | :--- |
| `BACKUP_NOT_CONFIGURED` | Backup is not configured for this application. |
| `BACKUP_SOURCE_INVALID` | Invalid backup source configuration provided. |
| `BACKUP_DESTINATION_INVALID` | Configured storage destination is invalid or unreachable. |
| `BACKUP_CONFIG_INVALID` | Invalid backup configuration parameters provided. |
| `APPLICATION_NOT_FOUND` | Application could not be found. |
| `BACKUP_NOT_FOUND` | Backup job could not be found. |
| `FORBIDDEN` | You do not have permission to perform this action. |
| `CSRF_REQUIRED` | CSRF token missing or invalid. Please refresh the page. |
| `AUTHENTICATION_REQUIRED` | Authentication required. Please log in again. |

---

## 7. Responsive Design

The Backup UI utilizes responsive flex and grid layouts:
- **Desktop**: Side-by-side metric cards, full tabular history with sorting/filtering, and expansive detail grids.
- **Tablet**: 2-column card wrapping with scrollable history tables.
- **Mobile**: Single-column vertical stacks, responsive modal dialogs, and mobile-friendly table layout using `data-label` cell attributes.
