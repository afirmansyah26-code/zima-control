// apps/web/src/backup-ui.ts
// UI Components for ZCC Backup Management, History, and Detail

import type { AuthRole } from "@zima-control-center/application-registry-contracts";
import type { Clock } from "./app.js";
import {
  BackupApiError,
  type ActiveBackupJobDto,
  type ApplicationBackupStatusResponse,
  type BackupApiClient,
  type BackupConfigDto,
  type BackupConfigInput,
  type BackupDetailResponse,
  type BackupHistoryFilterOptions,
  type BackupHistoryItemDto,
  type BackupHistoryListResponse,
  type BackupJobStatus,
  type BackupSourceInput,
  type BackupTriggerType,
  type VerificationStatus,
} from "./backup-api.js";

// ==============================================================================
// UTILITY & FORMATTING FUNCTIONS
// ==============================================================================

export function formatBytes(bytes: number | string | bigint | null | undefined): string {
  if (bytes === null || bytes === undefined || bytes === "") return "—";
  const num = typeof bytes === "bigint" ? Number(bytes) : Number(bytes);
  if (Number.isNaN(num) || num < 0) return "—";
  if (num === 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.floor(Math.log(num) / Math.log(1024));
  const val = num / Math.pow(1024, i);
  return `${val < 10 && i > 0 ? val.toFixed(2) : val.toFixed(1)} ${units[i] || "B"}`;
}

export function explainCronExpression(cron: string | null | undefined): { text: string; isUtc: boolean } {
  if (!cron || !cron.trim()) {
    return { text: "Manual backups only (No automated schedule configured)", isUtc: true };
  }
  const parts = cron.trim().split(/\s+/);
  if (parts.length !== 5) {
    return { text: `Custom schedule: ${cron}`, isUtc: true };
  }

  const [min, hr, dom, mon, dow] = parts;

  if (min === "*" && hr === "*" && dom === "*" && mon === "*" && dow === "*") {
    return { text: "Every minute", isUtc: true };
  }
  if (min.startsWith("*/") && hr === "*" && dom === "*" && mon === "*" && dow === "*") {
    return { text: `Every ${min.slice(2)} minutes`, isUtc: true };
  }
  if (min === "0" && hr === "*" && dom === "*" && mon === "*" && dow === "*") {
    return { text: "Hourly at minute 0", isUtc: true };
  }
  if (min === "0" && hr.startsWith("*/") && dom === "*" && mon === "*" && dow === "*") {
    return { text: `Every ${hr.slice(2)} hours at minute 0`, isUtc: true };
  }
  if (dom === "*" && mon === "*" && dow === "*") {
    return { text: `Daily at ${hr.padStart(2, "0")}:${min.padStart(2, "0")} UTC`, isUtc: true };
  }
  if (dom === "*" && mon === "*" && dow !== "*") {
    const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
    const dayName = days[Number(dow)] || `day ${dow}`;
    return { text: `Weekly on ${dayName} at ${hr.padStart(2, "0")}:${min.padStart(2, "0")} UTC`, isUtc: true };
  }
  if (dom !== "*" && mon === "*" && dow === "*") {
    return { text: `Monthly on day ${dom} at ${hr.padStart(2, "0")}:${min.padStart(2, "0")} UTC`, isUtc: true };
  }

  return { text: `Scheduled (${cron})`, isUtc: true };
}

export function relativeTime(timestamp: string | null | undefined, clockDate: Date): string {
  if (!timestamp) return "Never";
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return "Unknown";
  const diffSec = Math.floor((clockDate.getTime() - date.getTime()) / 1000);
  if (diffSec < 0) return "In the future";
  if (diffSec < 60) return "Just now";
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin} min ago`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr} hr ago`;
  const diffDays = Math.floor(diffHr / 24);
  return `${diffDays} day${diffDays > 1 ? "s" : ""} ago`;
}

export function formatUtcDateTime(timestamp: string | null | undefined): string {
  if (!timestamp) return "—";
  const d = new Date(timestamp);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toISOString().replace("T", " ").replace(/\.\d{3}Z$/, " UTC");
}

// ==============================================================================
// DOM HELPERS & BADGES
// ==============================================================================

function el<K extends keyof HTMLElementTagNameMap>(
  document: Document,
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}

export function backupJobStatusBadge(document: Document, status: BackupJobStatus): HTMLElement {
  const badge = el(document, "span", "tag backup-status-tag");
  switch (status) {
    case "COMPLETED":
      badge.className += " tag-success";
      badge.textContent = "Completed";
      break;
    case "FAILED":
      badge.className += " tag-danger";
      badge.textContent = "Failed";
      break;
    case "CANCELLED":
      badge.className += " tag-warning";
      badge.textContent = "Cancelled";
      break;
    case "QUEUED":
      badge.className += " tag-info";
      badge.textContent = "Queued";
      break;
    case "INITIALIZING":
      badge.className += " tag-info";
      badge.textContent = "Initializing";
      break;
    case "CAPTURING":
      badge.className += " tag-info tag-pulsing";
      badge.textContent = "Capturing";
      break;
    case "VERIFYING":
      badge.className += " tag-info tag-pulsing";
      badge.textContent = "Verifying";
      break;
    default:
      badge.textContent = status;
  }
  return badge;
}

export function verificationStatusBadge(document: Document, status: VerificationStatus | undefined): HTMLElement {
  const badge = el(document, "span", "tag verification-tag");
  if (!status || status === "PENDING") {
    badge.className += " tag-warning";
    badge.textContent = "Pending Verification";
  } else if (status === "VERIFIED") {
    badge.className += " tag-success";
    badge.textContent = "✓ Verified";
  } else {
    badge.className += " tag-danger";
    badge.textContent = "Verification Failed";
  }
  return badge;
}

export function triggerTypeBadge(document: Document, trigger: BackupTriggerType): HTMLElement {
  const badge = el(document, "span", "tag trigger-tag");
  if (trigger === "SCHEDULED") {
    badge.className += " tag-accent";
    badge.textContent = "Scheduled";
  } else {
    badge.className += " tag-neutral";
    badge.textContent = "Manual";
  }
  return badge;
}

export function retentionBadge(document: Document, isRetained: boolean, prunedAt?: string | null): HTMLElement {
  const badge = el(document, "span", "tag retention-tag");
  if (isRetained) {
    badge.className += " tag-success";
    badge.textContent = "Retained";
  } else {
    badge.className += " tag-neutral";
    badge.textContent = prunedAt ? "Pruned" : "Not Retained";
  }
  return badge;
}

// ==============================================================================
// 1. APPLICATION DETAIL — BACKUP SECTION
// ==============================================================================

export interface BackupSectionController {
  destroy: () => void;
  reload: () => Promise<void>;
}

export function renderBackupSection(
  parent: HTMLElement,
  applicationId: string,
  userRole: AuthRole,
  backupApi: BackupApiClient,
  clock: Clock,
  navigate: (pathname: string) => void,
): BackupSectionController {
  const document = parent.ownerDocument;
  const section = el(document, "section", "content-section backup-section");
  section.id = "application-backup-section";
  parent.append(section);

  let activePollTimer: ReturnType<typeof setTimeout> | null = null;
  let isDestroyed = false;

  function stopPolling() {
    if (activePollTimer) {
      clearTimeout(activePollTimer);
      activePollTimer = null;
    }
  }

  async function loadAndRender() {
    stopPolling();
    section.replaceChildren(el(document, "div", "backup-loading-state", "Loading backup configuration and status..."));

    try {
      const data = await backupApi.getApplicationBackupStatus(applicationId);
      if (isDestroyed) return;
      renderSectionContent(data);
    } catch (err: unknown) {
      if (isDestroyed) return;
      const errorMsg = err instanceof BackupApiError ? err.message : "Failed to load backup status";
      const errorPanel = el(document, "div", "state-panel error-state");
      errorPanel.append(
        el(document, "h3", undefined, "Backup Status Unavailable"),
        el(document, "p", undefined, errorMsg),
      );
      const retryBtn = el(document, "button", "button", "Retry");
      retryBtn.type = "button";
      retryBtn.addEventListener("click", () => { void loadAndRender(); });
      errorPanel.append(retryBtn);
      section.replaceChildren(errorPanel);
    }
  }

  function renderSectionContent(data: ApplicationBackupStatusResponse) {
    const heading = el(document, "div", "section-heading");
    const headingCopy = el(document, "div");
    headingCopy.append(
      el(document, "p", "eyebrow", "Data Protection"),
      el(document, "h2", undefined, "Backup & Disaster Recovery"),
      el(document, "p", "page-description", "Automated snapshots, retention policy, and verified artifacts for this application."),
    );

    const controls = el(document, "div", "backup-header-actions");

    // History link
    const historyLink = el(document, "a", "button button-quiet", "View in History");
    historyLink.href = `/backups?applicationId=${encodeURIComponent(applicationId)}`;
    historyLink.addEventListener("click", (e) => {
      e.preventDefault();
      navigate(`/backups?applicationId=${encodeURIComponent(applicationId)}`);
    });
    controls.append(historyLink);

    // Run Backup Now button (Operator or Admin)
    const runBtn = el(document, "button", "button button-primary", "Run Backup Now");
    runBtn.type = "button";
    runBtn.id = "run-backup-now-button";

    const isRunning = !!(data.activeJob && ["QUEUED", "INITIALIZING", "CAPTURING", "VERIFYING"].includes(data.activeJob.status));
    const isViewer = userRole === "VIEWER";
    const isConfigured = !!data.config;

    if (isViewer) {
      runBtn.disabled = true;
      runBtn.title = "Operator or Admin role required to trigger backups";
    } else if (isRunning) {
      runBtn.disabled = true;
      runBtn.title = "A backup is already running for this application";
    } else if (!isConfigured) {
      runBtn.disabled = true;
      runBtn.title = "Backup must be configured before running";
    } else {
      runBtn.addEventListener("click", async () => {
        runBtn.disabled = true;
        runBtn.textContent = "Starting...";
        try {
          await backupApi.runBackupNow(applicationId);
          await loadAndRender();
        } catch (runErr: unknown) {
          runBtn.disabled = false;
          runBtn.textContent = "Run Backup Now";
          const msg = runErr instanceof BackupApiError ? runErr.message : "Failed to trigger backup";
          alert(msg);
        }
      });
    }
    controls.append(runBtn);

    // Configure Backup button (Admin only)
    if (userRole === "ADMIN") {
      const configBtn = el(document, "button", "button", isConfigured ? "Edit Configuration" : "Configure Backup");
      configBtn.type = "button";
      configBtn.id = "configure-backup-button";
      configBtn.addEventListener("click", () => {
        openConfigEditor(data.config);
      });
      controls.append(configBtn);
    }

    heading.append(headingCopy, controls);
    section.replaceChildren(heading);

    // Active Job Banner
    if (isRunning && data.activeJob) {
      const activeCard = el(document, "div", "active-job-banner");
      const activeHeader = el(document, "div", "active-job-header");
      const spinner = el(document, "span", "spinner");
      const activeTitle = el(document, "strong", undefined, `Backup in progress: ${data.activeJob.status}`);
      activeHeader.append(spinner, activeTitle, backupJobStatusBadge(document, data.activeJob.status));

      const activeNotice = el(document, "p", "active-job-notice",
        "A backup job is actively executing. Another backup cannot be started until this job completes to prevent data collisions."
      );
      const activeMeta = el(document, "div", "active-job-meta");
      activeMeta.append(
        el(document, "span", undefined, `Job ID: ${data.activeJob.id.slice(0, 8)}`),
        el(document, "span", undefined, `Trigger: ${data.activeJob.triggerType}`),
        el(document, "span", undefined, `Started: ${relativeTime(data.activeJob.startedAt || data.activeJob.createdAt, clock())}`),
      );

      activeCard.append(activeHeader, activeNotice, activeMeta);
      section.append(activeCard);

      // Start live polling
      schedulePoll();
    }

    // Unconfigured State
    if (!data.config) {
      const emptyPanel = el(document, "div", "state-panel backup-empty-panel");
      emptyPanel.append(
        el(document, "h3", undefined, "Backup Not Configured"),
        el(document, "p", undefined, "This application does not have a backup schedule, retention policy, or storage sources configured."),
      );
      if (userRole === "ADMIN") {
        const setupBtn = el(document, "button", "button button-primary", "Configure Backup Now");
        setupBtn.type = "button";
        setupBtn.addEventListener("click", () => { openConfigEditor(null); });
        emptyPanel.append(setupBtn);
      } else {
        emptyPanel.append(el(document, "span", "inline-hint", "An administrator must configure backups for this application."));
      }
      section.append(emptyPanel);
      return;
    }

    // Config Overview Cards Grid
    const cfg = data.config;
    const overviewGrid = el(document, "div", "backup-overview-grid");

    // Card 1: Schedule & Timezone
    const schedCard = el(document, "div", "backup-card");
    const schedExplanation = explainCronExpression(cfg.scheduleCron);
    schedCard.append(
      el(document, "span", "datum-label", "Automated Schedule"),
      el(document, "div", "card-main-stat", cfg.scheduleCron ? cfg.scheduleCron : "Manual Only"),
      el(document, "p", "card-subtext", schedExplanation.text),
      el(document, "div", "timezone-badge", "Schedule timezone: UTC"),
    );

    // Card 2: Retention Policy
    const retCard = el(document, "div", "backup-card");
    retCard.append(
      el(document, "span", "datum-label", "Retention Policy"),
      el(document, "div", "card-main-stat", `${cfg.retentionVersions} versions`),
      el(document, "p", "card-subtext", "Oldest verified backups beyond this limit are automatically pruned."),
      el(document, "div", "status-indicator", cfg.status === "ENABLED" ? "● Policy Active" : "○ Backups Disabled"),
    );

    // Card 3: Destination
    const destCard = el(document, "div", "backup-card");
    destCard.append(
      el(document, "span", "datum-label", "Storage Destination"),
      el(document, "div", "card-main-stat", cfg.destination?.name || "Local Filesystem"),
      el(document, "code", "truncate-code", cfg.destination?.basePath || "/DATA/AppData/backups"),
      el(document, "span", "tag tag-neutral", cfg.destination?.type || "LOCAL_FILESYSTEM"),
    );

    overviewGrid.append(schedCard, retCard, destCard);
    section.append(overviewGrid);

    // Card 4: Last Verified Backup (if exists)
    if (data.lastVerifiedBackup && data.lastVerifiedBackup.verificationStatus === "VERIFIED") {
      const lvb = data.lastVerifiedBackup;
      const lvbCard = el(document, "div", "last-backup-card");
      const lvbHeader = el(document, "div", "last-backup-header");
      lvbHeader.append(
        el(document, "span", "datum-label", "Latest Verified Backup"),
        verificationStatusBadge(document, lvb.verificationStatus),
      );
      const lvbBody = el(document, "div", "last-backup-body");
      lvbBody.append(
        el(document, "div", "lvb-stat", `Bundle Size: ${formatBytes(lvb.bundleSizeBytes)}`),
        el(document, "div", "lvb-stat", `Completed: ${relativeTime(lvb.createdAt, clock())} (${formatUtcDateTime(lvb.createdAt)})`),
      );
      const lvbAction = el(document, "a", "button button-quiet", "View Backup Details →");
      lvbAction.href = `/backups/${lvb.jobId}`;
      lvbAction.addEventListener("click", (e) => {
        e.preventDefault();
        navigate(`/backups/${lvb.jobId}`);
      });
      lvbCard.append(lvbHeader, lvbBody, lvbAction);
      section.append(lvbCard);
    } else {
      const noVerifiedCard = el(document, "div", "inline-notice");
      noVerifiedCard.textContent = "No verified backups recorded yet for this application.";
      section.append(noVerifiedCard);
    }

    // Sources Summary Table
    const sourcesHeading = el(document, "h3", "backup-subheading", "Configured Backup Sources");
    section.append(sourcesHeading);

    if (cfg.sources.length === 0) {
      section.append(el(document, "p", "inline-empty", "No sources defined in configuration."));
    } else {
      const sourceList = el(document, "div", "backup-source-list");
      for (const src of cfg.sources) {
        const item = el(document, "article", "service-card source-card");
        const itemHeading = el(document, "div", "service-heading");
        itemHeading.append(
          el(document, "h4", undefined, src.name),
          el(document, "span", "tag", src.sourceType === "DATABASE" ? `Database (${src.dbEngine})` : "Persistent Files"),
        );
        const meta = el(document, "dl", "service-metadata");
        if (src.sourceType === "DATABASE") {
          addDlItem(document, meta, "Engine", src.dbEngine || "MARIADB");
          addDlItem(document, meta, "Host : Port", `${src.dbHost || "localhost"} : ${src.dbPort || 3306}`);
          addDlItem(document, meta, "Target Database", src.dbTarget || "—");
          addDlItem(document, meta, "User", src.dbUser || "—");
          addDlItem(document, meta, "Secret Reference", src.dbSecretRef ? "Configured (Protected)" : "None");
        } else {
          addDlItem(document, meta, "Host Path", src.fileHostPath || "—");
          addDlItem(document, meta, "Exclusions", src.fileExclusions?.length ? src.fileExclusions.join(", ") : "None");
          addDlItem(document, meta, "Symlinks", src.fileFollowSymlinks ? "Follow symlinks" : "Do not follow");
        }
        item.append(itemHeading, meta);
        sourceList.append(item);
      }
      section.append(sourceList);
    }
  }

  function schedulePoll() {
    stopPolling();
    activePollTimer = setTimeout(async () => {
      if (isDestroyed) return;
      try {
        const fresh = await backupApi.getApplicationBackupStatus(applicationId);
        if (isDestroyed) return;
        renderSectionContent(fresh);
      } catch {
        // Retry next cycle if transient error
        if (!isDestroyed) schedulePoll();
      }
    }, 3000);
    if (typeof (activePollTimer as any)?.unref === "function") {
      (activePollTimer as any).unref();
    }
  }

  // Configuration Modal Editor (Admin Only)
  function openConfigEditor(existingConfig: BackupConfigDto | null) {
    const modalOverlay = el(document, "div", "modal-overlay");
    const modal = el(document, "div", "modal-card");

    const modalTitle = el(document, "h2", undefined, existingConfig ? "Edit Backup Configuration" : "Configure Application Backup");
    const modalDesc = el(document, "p", "page-description", "Configure automated backup schedule, retention versions, and data capture sources.");

    const form = el(document, "form", "backup-config-form");

    // Status: Enabled / Disabled
    const statusWrapper = el(document, "div", "field");
    const statusLabel = el(document, "label", "field-label", "Backup Status");
    const statusSelect = el(document, "select", "control");
    statusSelect.append(
      createOption(document, "ENABLED", "Enabled (Active)"),
      createOption(document, "DISABLED", "Disabled (Paused)"),
    );
    statusSelect.value = existingConfig?.status ?? "ENABLED";
    statusWrapper.append(statusLabel, statusSelect);

    // Schedule Cron
    const cronWrapper = el(document, "div", "field");
    const cronLabel = el(document, "label", "field-label", "Schedule (Cron expression in UTC)");
    const cronInput = el(document, "input", "control");
    cronInput.type = "text";
    cronInput.id = "config-schedule-cron";
    cronInput.placeholder = "e.g. 0 2 * * * (or leave blank for manual only)";
    cronInput.value = existingConfig?.scheduleCron ?? "";

    const cronHelper = el(document, "p", "field-help");
    const updateCronHelper = () => {
      const info = explainCronExpression(cronInput.value);
      cronHelper.textContent = `${info.text} — Timezone: UTC`;
    };
    cronInput.addEventListener("input", updateCronHelper);
    updateCronHelper();

    cronWrapper.append(cronLabel, cronInput, cronHelper);

    // Retention Versions
    const retWrapper = el(document, "div", "field");
    const retLabel = el(document, "label", "field-label", "Retention Versions to Keep");
    const retInput = el(document, "input", "control");
    retInput.type = "number";
    retInput.id = "config-retention-versions";
    retInput.min = "1";
    retInput.max = "100";
    retInput.value = String(existingConfig?.retentionVersions ?? 3);
    const retHelper = el(document, "p", "field-help", "Maximum number of newest verified backups to retain (1–100).");
    retWrapper.append(retLabel, retInput, retHelper);

    // Sources Editor
    const sourcesContainer = el(document, "div", "sources-editor-container");
    const sourcesTitle = el(document, "h3", undefined, "Backup Sources");
    sourcesContainer.append(sourcesTitle);

    let sourcesState: BackupSourceInput[] = existingConfig?.sources?.map((s) => ({
      name: s.name,
      sourceType: s.sourceType,
      dbEngine: s.dbEngine ?? undefined,
      dbTarget: s.dbTarget ?? undefined,
      dbHost: s.dbHost ?? undefined,
      dbPort: s.dbPort ?? undefined,
      dbUser: s.dbUser ?? undefined,
      dbSecretRef: s.dbSecretRef ?? undefined,
      fileHostPath: s.fileHostPath ?? undefined,
      fileExclusions: s.fileExclusions ?? undefined,
      fileFollowSymlinks: s.fileFollowSymlinks ?? false,
    })) || [
      {
        name: "storage",
        sourceType: "PERSISTENT_FILES",
        fileHostPath: `/DATA/AppData/${applicationId}/storage`,
        fileFollowSymlinks: false,
      },
    ];

    const sourcesListEl = el(document, "div", "sources-form-list");
    sourcesContainer.append(sourcesListEl);

    function renderSourcesList() {
      sourcesListEl.replaceChildren();
      sourcesState.forEach((src, idx) => {
        const itemCard = el(document, "div", "source-editor-card");
        const itemHeader = el(document, "div", "source-editor-header");
        itemHeader.append(
          el(document, "strong", undefined, `Source #${idx + 1}`),
          el(document, "button", "button button-quiet button-danger-quiet", "Remove"),
        );
        const removeBtn = itemHeader.querySelector("button")!;
        removeBtn.type = "button";
        removeBtn.addEventListener("click", () => {
          sourcesState.splice(idx, 1);
          renderSourcesList();
        });

        const grid = el(document, "div", "source-editor-grid");

        // Type
        const typeField = el(document, "div", "field");
        typeField.append(el(document, "label", "field-label", "Source Type"));
        const typeSelect = el(document, "select", "control");
        typeSelect.append(
          createOption(document, "PERSISTENT_FILES", "Persistent Files"),
          createOption(document, "DATABASE", "Database (MariaDB / MySQL)"),
        );
        typeSelect.value = src.sourceType;
        typeSelect.addEventListener("change", () => {
          src.sourceType = typeSelect.value as any;
          if (src.sourceType === "DATABASE") {
            src.dbEngine = src.dbEngine || "MARIADB";
            src.dbPort = src.dbPort || 3306;
          }
          renderSourcesList();
        });
        typeField.append(typeSelect);

        // Name
        const nameField = el(document, "div", "field");
        nameField.append(el(document, "label", "field-label", "Source Identifier Name"));
        const nameInput = el(document, "input", "control");
        nameInput.value = src.name;
        nameInput.placeholder = "e.g. app-storage or app-database";
        nameInput.addEventListener("input", () => { src.name = nameInput.value; });
        nameField.append(nameInput);

        grid.append(typeField, nameField);

        if (src.sourceType === "PERSISTENT_FILES") {
          // Host Path
          const pathField = el(document, "div", "field");
          pathField.append(el(document, "label", "field-label", "Host Directory Path"));
          const pathInput = el(document, "input", "control");
          pathInput.value = src.fileHostPath || "";
          pathInput.placeholder = "/DATA/AppData/...";
          pathInput.addEventListener("input", () => { src.fileHostPath = pathInput.value; });
          pathField.append(pathInput);

          // Exclusions
          const exclField = el(document, "div", "field");
          exclField.append(el(document, "label", "field-label", "Exclusion Patterns (comma separated)"));
          const exclInput = el(document, "input", "control");
          exclInput.value = src.fileExclusions ? src.fileExclusions.join(", ") : "";
          exclInput.placeholder = "*.tmp, cache/*, .git";
          exclInput.addEventListener("input", () => {
            src.fileExclusions = exclInput.value.split(",").map((s) => s.trim()).filter(Boolean);
          });
          exclField.append(exclInput);

          grid.append(pathField, exclField);
        } else {
          // Database Fields
          const engineField = el(document, "div", "field");
          engineField.append(el(document, "label", "field-label", "Engine"));
          const engineSelect = el(document, "select", "control");
          engineSelect.append(
            createOption(document, "MARIADB", "MariaDB"),
            createOption(document, "MYSQL", "MySQL"),
          );
          engineSelect.value = src.dbEngine || "MARIADB";
          engineSelect.addEventListener("change", () => { src.dbEngine = engineSelect.value as any; });
          engineField.append(engineSelect);

          const dbTargetField = el(document, "div", "field");
          dbTargetField.append(el(document, "label", "field-label", "Target Database Name"));
          const dbTargetInput = el(document, "input", "control");
          dbTargetInput.value = src.dbTarget || "";
          dbTargetInput.placeholder = "e.g. app_db";
          dbTargetInput.addEventListener("input", () => { src.dbTarget = dbTargetInput.value; });
          dbTargetField.append(dbTargetInput);

          const hostField = el(document, "div", "field");
          hostField.append(el(document, "label", "field-label", "Host Address"));
          const hostInput = el(document, "input", "control");
          hostInput.value = src.dbHost || "localhost";
          hostInput.addEventListener("input", () => { src.dbHost = hostInput.value; });
          hostField.append(hostInput);

          const portField = el(document, "div", "field");
          portField.append(el(document, "label", "field-label", "Port"));
          const portInput = el(document, "input", "control");
          portInput.type = "number";
          portInput.value = String(src.dbPort || 3306);
          portInput.addEventListener("input", () => { src.dbPort = Number(portInput.value) || 3306; });
          portField.append(portInput);

          const userField = el(document, "div", "field");
          userField.append(el(document, "label", "field-label", "Username"));
          const userInput = el(document, "input", "control");
          userInput.value = src.dbUser || "root";
          userInput.addEventListener("input", () => { src.dbUser = userInput.value; });
          userField.append(userInput);

          const secretField = el(document, "div", "field");
          secretField.append(el(document, "label", "field-label", "Secret Reference / Password"));
          const secretInput = el(document, "input", "control");
          secretInput.type = "password";
          secretInput.placeholder = src.dbSecretRef ? "(Unchanged / Protected)" : "Enter secret ref or password";
          secretInput.addEventListener("input", () => { src.dbSecretRef = secretInput.value; });
          secretField.append(secretInput);

          grid.append(engineField, dbTargetField, hostField, portField, userField, secretField);
        }

        itemCard.append(itemHeader, grid);
        sourcesListEl.append(itemCard);
      });
    }

    renderSourcesList();

    const addSourceBtn = el(document, "button", "button button-quiet", "+ Add Source");
    addSourceBtn.type = "button";
    addSourceBtn.id = "add-source-button";
    addSourceBtn.addEventListener("click", () => {
      sourcesState.push({
        name: `source-${sourcesState.length + 1}`,
        sourceType: "PERSISTENT_FILES",
        fileHostPath: "",
        fileFollowSymlinks: false,
      });
      renderSourcesList();
    });
    sourcesContainer.append(addSourceBtn);

    // Validation Error Region
    const errorRegion = el(document, "div", "form-error-region");

    // Modal Actions
    const modalActions = el(document, "div", "modal-actions");
    const cancelBtn = el(document, "button", "button button-quiet", "Cancel");
    cancelBtn.type = "button";
    cancelBtn.addEventListener("click", () => { modalOverlay.remove(); });

    const saveBtn = el(document, "button", "button button-primary", "Save Configuration");
    saveBtn.type = "submit";
    saveBtn.id = "save-backup-config-button";

    modalActions.append(cancelBtn, saveBtn);

    form.append(statusWrapper, cronWrapper, retWrapper, sourcesContainer, errorRegion, modalActions);

    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      errorRegion.replaceChildren();

      // Client-side quick validations
      const retentionVersions = Number(retInput.value);
      if (!Number.isInteger(retentionVersions) || retentionVersions < 1 || retentionVersions > 100) {
        errorRegion.textContent = "Retention versions must be an integer between 1 and 100.";
        return;
      }

      if (sourcesState.length === 0) {
        errorRegion.textContent = "At least one backup source must be configured.";
        return;
      }

      for (const s of sourcesState) {
        if (!s.name || !s.name.trim()) {
          errorRegion.textContent = "Every source must have a non-empty name identifier.";
          return;
        }
        if (s.sourceType === "PERSISTENT_FILES" && !s.fileHostPath) {
          errorRegion.textContent = `Source '${s.name}' requires a valid host directory path.`;
          return;
        }
        if (s.sourceType === "DATABASE") {
          if (!s.dbTarget) {
            errorRegion.textContent = `Database source '${s.name}' requires a target database name.`;
            return;
          }
          if (!s.dbHost) {
            errorRegion.textContent = `Database source '${s.name}' requires a host address.`;
            return;
          }
        }
      }

      saveBtn.disabled = true;
      saveBtn.textContent = "Saving...";

      const payload: BackupConfigInput = {
        status: statusSelect.value as any,
        scheduleCron: cronInput.value.trim() || null,
        retentionVersions,
        sources: sourcesState,
      };

      try {
        await backupApi.saveApplicationBackupConfig(applicationId, payload);
        modalOverlay.remove();
        await loadAndRender();
      } catch (saveErr: unknown) {
        saveBtn.disabled = false;
        saveBtn.textContent = "Save Configuration";
        errorRegion.textContent = saveErr instanceof BackupApiError ? saveErr.message : "Failed to save configuration";
      }
    });

    modal.append(modalTitle, modalDesc, form);
    modalOverlay.append(modal);
    document.body.append(modalOverlay);
  }

  void loadAndRender();

  return {
    destroy: () => {
      isDestroyed = true;
      stopPolling();
    },
    reload: loadAndRender,
  };
}

function addDlItem(document: Document, dl: HTMLElement, term: string, detail: string) {
  const item = el(document, "div", "definition-item");
  item.append(
    el(document, "dt", undefined, term),
    el(document, "dd", undefined, detail),
  );
  dl.append(item);
}

function createOption(document: Document, value: string, text: string): HTMLOptionElement {
  const opt = document.createElement("option");
  opt.value = value;
  opt.textContent = text;
  return opt;
}

// ==============================================================================
// 2. BACKUP HISTORY VIEW (/backups)
// ==============================================================================

export async function renderBackupHistoryPage(
  content: HTMLElement,
  backupApi: BackupApiClient,
  clock: Clock,
  navigate: (pathname: string) => void,
  userRole?: AuthRole,
  initialAppId?: string,
): Promise<void> {
  const document = content.ownerDocument;

  const heading = el(document, "div", "page-heading");
  const copy = el(document, "div");
  copy.append(
    el(document, "p", "eyebrow", "Data Protection"),
    el(document, "h1", undefined, "Backup History"),
    el(document, "p", "page-description", "Audit trail of all automated scheduled and manual backups across applications."),
  );
  heading.append(copy);

  // Filters Toolbar
  const toolbar = el(document, "div", "toolbar backup-history-toolbar");

  // App Filter
  const appField = el(document, "div", "field");
  appField.append(el(document, "label", "field-label", "Application Filter"));
  const appInput = el(document, "input", "control");
  appInput.placeholder = "All applications (or enter ID/name)";
  appInput.value = initialAppId || "";
  appField.append(appInput);

  // Status Filter
  const statusField = el(document, "div", "field");
  statusField.append(el(document, "label", "field-label", "Job Status"));
  const statusSelect = el(document, "select", "control");
  statusSelect.append(
    createOption(document, "", "All statuses"),
    createOption(document, "COMPLETED", "Completed"),
    createOption(document, "FAILED", "Failed"),
    createOption(document, "CAPTURING", "Capturing (Active)"),
    createOption(document, "VERIFYING", "Verifying (Active)"),
    createOption(document, "QUEUED", "Queued"),
  );
  statusField.append(statusSelect);

  // Verification Filter
  const verField = el(document, "div", "field");
  verField.append(el(document, "label", "field-label", "Verification Status"));
  const verSelect = el(document, "select", "control");
  verSelect.append(
    createOption(document, "", "All verification states"),
    createOption(document, "VERIFIED", "Verified Only"),
    createOption(document, "PENDING", "Pending"),
    createOption(document, "VERIFICATION_FAILED", "Failed Verification"),
  );
  verField.append(verSelect);

  toolbar.append(appField, statusField, verField);

  const results = el(document, "div", "results-region");
  results.setAttribute("aria-live", "polite");
  content.replaceChildren(heading, toolbar, results);

  let currentPage = 1;
  const limit = 20;

  async function fetchAndRender() {
    results.replaceChildren(el(document, "div", "state-panel", "Loading backup records..."));

    const filter: BackupHistoryFilterOptions = {
      page: currentPage,
      limit,
      applicationId: appInput.value.trim() || undefined,
      status: (statusSelect.value as BackupJobStatus) || undefined,
      verificationStatus: (verSelect.value as VerificationStatus) || undefined,
    };

    try {
      const response = await backupApi.listBackupHistory(filter);
      renderTable(response);
    } catch (err: unknown) {
      const msg = err instanceof BackupApiError ? err.message : "Failed to fetch backup history";
      const errorPanel = el(document, "div", "state-panel error-state");
      errorPanel.append(
        el(document, "h3", undefined, "Unable to Load History"),
        el(document, "p", undefined, msg),
      );
      const retryBtn = el(document, "button", "button", "Retry");
      retryBtn.addEventListener("click", () => { void fetchAndRender(); });
      errorPanel.append(retryBtn);
      results.replaceChildren(errorPanel);
    }
  }

  function renderTable(data: BackupHistoryListResponse) {
    if (data.items.length === 0) {
      results.replaceChildren(
        el(document, "div", "state-panel empty-history-panel", "No backup history records match the current filters.")
      );
      return;
    }

    const tableFrame = el(document, "div", "table-frame");
    const table = el(document, "table", "data-table backup-history-table");

    const thead = el(document, "thead");
    const trHead = el(document, "tr");
    ["Application", "Trigger", "Status", "Verification", "Created", "Completed", "Size", "Retained", "Actions"].forEach((col) => {
      trHead.append(el(document, "th", undefined, col));
    });
    thead.append(trHead);

    const tbody = el(document, "tbody");
    for (const item of data.items) {
      const row = el(document, "tr");

      // App
      const tdApp = el(document, "td");
      tdApp.setAttribute("data-label", "Application");
      const appLink = el(document, "a", "application-link", item.applicationDisplayName || item.applicationName);
      appLink.href = `/applications/${encodeURIComponent(item.applicationId)}`;
      appLink.addEventListener("click", (e) => {
        e.preventDefault();
        navigate(`/applications/${encodeURIComponent(item.applicationId)}`);
      });
      tdApp.append(appLink);

      // Trigger
      const tdTrigger = el(document, "td");
      tdTrigger.setAttribute("data-label", "Trigger");
      tdTrigger.append(triggerTypeBadge(document, item.triggerType));

      // Status
      const tdStatus = el(document, "td");
      tdStatus.setAttribute("data-label", "Status");
      tdStatus.append(backupJobStatusBadge(document, item.status));

      // Verification
      const tdVer = el(document, "td");
      tdVer.setAttribute("data-label", "Verification");
      tdVer.append(verificationStatusBadge(document, item.artifact?.verificationStatus));

      // Created
      const tdCreated = el(document, "td");
      tdCreated.setAttribute("data-label", "Created");
      tdCreated.textContent = relativeTime(item.createdAt, clock());

      // Completed
      const tdCompleted = el(document, "td");
      tdCompleted.setAttribute("data-label", "Completed");
      tdCompleted.textContent = item.completedAt ? relativeTime(item.completedAt, clock()) : "—";

      // Size
      const tdSize = el(document, "td");
      tdSize.setAttribute("data-label", "Size");
      tdSize.textContent = item.artifact ? formatBytes(item.artifact.bundleSizeBytes) : "—";

      // Retained
      const tdRet = el(document, "td");
      tdRet.setAttribute("data-label", "Retained");
      tdRet.append(retentionBadge(document, item.artifact?.isRetained ?? false, item.artifact?.prunedAt));

      // Action
      const tdAction = el(document, "td");
      tdAction.setAttribute("data-label", "Actions");
      const detailLink = el(document, "a", "button button-quiet button-sm", "Details →");
      detailLink.href = `/backups/${item.id}`;
      detailLink.addEventListener("click", (e) => {
        e.preventDefault();
        navigate(`/backups/${item.id}`);
      });
      tdAction.append(detailLink);

      row.append(tdApp, tdTrigger, tdStatus, tdVer, tdCreated, tdCompleted, tdSize, tdRet, tdAction);
      tbody.append(row);
    }

    table.append(thead, tbody);
    tableFrame.append(table);

    // Pagination Toolbar
    const pagination = el(document, "div", "pagination-bar");
    const summary = el(document, "span", "pagination-summary", `Showing page ${data.page} of ${data.totalPages} (${data.total} total records)`);

    const prevBtn = el(document, "button", "button button-quiet", "← Previous");
    prevBtn.disabled = data.page <= 1;
    prevBtn.addEventListener("click", () => {
      if (currentPage > 1) {
        currentPage--;
        void fetchAndRender();
      }
    });

    const nextBtn = el(document, "button", "button button-quiet", "Next →");
    nextBtn.disabled = data.page >= data.totalPages;
    nextBtn.addEventListener("click", () => {
      if (currentPage < data.totalPages) {
        currentPage++;
        void fetchAndRender();
      }
    });

    const pagButtons = el(document, "div", "pagination-buttons");
    pagButtons.append(prevBtn, nextBtn);
    pagination.append(summary, pagButtons);

    results.replaceChildren(tableFrame, pagination);
  }

  // Filter Listeners
  let searchTimer: ReturnType<typeof setTimeout> | null = null;
  appInput.addEventListener("input", () => {
    if (searchTimer) clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      currentPage = 1;
      void fetchAndRender();
    }, 300);
  });
  statusSelect.addEventListener("change", () => {
    currentPage = 1;
    void fetchAndRender();
  });
  verSelect.addEventListener("change", () => {
    currentPage = 1;
    void fetchAndRender();
  });

  void fetchAndRender();
}

// ==============================================================================
// 3. BACKUP DETAIL VIEW (/backups/:id)
// ==============================================================================

export async function renderBackupDetailPage(
  content: HTMLElement,
  backupApi: BackupApiClient,
  jobId: string,
  clock: Clock,
  navigate: (pathname: string) => void,
): Promise<void> {
  const document = content.ownerDocument;
  content.replaceChildren(el(document, "div", "state-panel", "Loading backup details..."));

  let detail: BackupDetailResponse;
  try {
    detail = await backupApi.getBackupDetail(jobId);
  } catch (err: unknown) {
    const msg = err instanceof BackupApiError ? err.message : "Failed to load backup details";
    const errorPanel = el(document, "div", "state-panel error-state");
    errorPanel.append(
      el(document, "h3", undefined, "Backup Detail Unavailable"),
      el(document, "p", undefined, msg),
    );
    const backBtn = el(document, "button", "button", "← Back to History");
    backBtn.addEventListener("click", () => { navigate("/backups"); });
    errorPanel.append(backBtn);
    content.replaceChildren(errorPanel);
    return;
  }

  const wrapper = el(document, "div", "detail-page backup-detail-page");

  // Back link
  const back = el(document, "a", "back-link", "← Back to Backup History");
  back.href = "/backups";
  back.addEventListener("click", (e) => {
    e.preventDefault();
    navigate("/backups");
  });

  // Header
  const titleLine = el(document, "div", "detail-title-line");
  titleLine.append(
    el(document, "h1", undefined, `Backup Job ${detail.job.id.slice(0, 8)}`),
    backupJobStatusBadge(document, detail.job.status),
    verificationStatusBadge(document, detail.artifact?.verificationStatus),
  );

  const header = el(document, "header", "detail-header");
  header.append(back, titleLine);
  wrapper.append(header);

  // Section 1: Overview & Lifecycle
  const overviewList = el(document, "dl", "definition-grid");
  addDlItem(document, overviewList, "Application", detail.application.displayName || detail.application.name);
  addDlItem(document, overviewList, "Trigger Type", detail.job.triggerType);
  addDlItem(document, overviewList, "Created At", formatUtcDateTime(detail.job.createdAt));
  addDlItem(document, overviewList, "Started At", formatUtcDateTime(detail.job.startedAt));
  addDlItem(document, overviewList, "Completed At", formatUtcDateTime(detail.job.completedAt));
  if (detail.job.failureReasonCode) {
    addDlItem(document, overviewList, "Failure Reason", `${detail.job.failureReasonCode} - ${detail.job.failureDetail || "Unknown"}`);
  }
  wrapper.append(createSection(document, "Job Lifecycle", "Execution status and timing parameters.", overviewList));

  // Section 2: Source Tasks
  const sourceTaskList = el(document, "div", "service-list");
  if (detail.sourceTasks.length === 0) {
    sourceTaskList.append(el(document, "p", "inline-empty", "No source tasks recorded."));
  } else {
    for (const task of detail.sourceTasks) {
      const card = el(document, "article", "service-card");
      const cardHead = el(document, "div", "service-heading");
      cardHead.append(
        el(document, "h3", undefined, task.sourceName),
        el(document, "span", "tag", task.sourceType),
        backupJobStatusBadge(document, task.status as any),
      );
      const meta = el(document, "dl", "service-metadata");
      addDlItem(document, meta, "Bytes Captured", formatBytes(task.bytesCaptured));
      addDlItem(document, meta, "SHA-256 Digest", task.sha256Digest ? task.sha256Digest.slice(0, 16) + "..." : "—");
      addDlItem(document, meta, "Timing", `${relativeTime(task.startedAt, clock())} → ${relativeTime(task.completedAt, clock())}`);
      card.append(cardHead, meta);
      sourceTaskList.append(card);
    }
  }
  wrapper.append(createSection(document, "Source Tasks", "Individual data sources processed in this unified archive.", sourceTaskList));

  // Section 3: Artifact & 4-Tier Verification
  const artifactSection = el(document, "div", "artifact-detail-block");
  if (!detail.artifact) {
    artifactSection.append(el(document, "p", "inline-empty", "No physical artifact generated for this job."));
  } else {
    const art = detail.artifact;
    const artGrid = el(document, "dl", "definition-grid");
    addDlItem(document, artGrid, "Bundle Filename", art.bundleFileName);
    addDlItem(document, artGrid, "Compressed Size", formatBytes(art.bundleSizeBytes));
    addDlItem(document, artGrid, "Uncompressed Size", formatBytes(art.uncompressedBytes));
    addDlItem(document, artGrid, "SHA-256 Digest", art.sha256Digest);
    addDlItem(document, artGrid, "Retention Status", art.isRetained ? "Retained on disk" : `Pruned (${formatUtcDateTime(art.prunedAt)})`);
    artifactSection.append(artGrid);

    // 4-Tier Verification Records
    const verHeading = el(document, "h4", "tier-checklist-heading", "Four-Tier Verification Engine Results");
    const verList = el(document, "ul", "tier-checklist");

    const checks = [
      { name: "Tier 1: Existence Check", desc: "Bundle file, manifest, and SHA-256 sidecars exist in designated storage." },
      { name: "Tier 2: Size Sanity Check", desc: "Non-zero archive size within expected thresholds." },
      { name: "Tier 3: SHA-256 Checksum", desc: "Cryptographic hash matches sidecar and manifest verification record." },
      { name: "Tier 4: Archive Integrity", desc: "Zstandard decompression and tar structural validation without error." },
    ];

    checks.forEach((c) => {
      const li = el(document, "li", "tier-item");
      const isVerified = art.verificationStatus === "VERIFIED";
      li.append(
        el(document, "span", isVerified ? "tier-icon tier-pass" : "tier-icon tier-fail", isVerified ? "✓" : "✗"),
        el(document, "div", "tier-info", `${c.name}: ${c.desc}`),
      );
      verList.append(li);
    });

    artifactSection.append(verHeading, verList);
  }
  wrapper.append(createSection(document, "Verified Artifact & Integrity Checks", "Cryptographic verification and storage details.", artifactSection));

  content.replaceChildren(wrapper);
}

function createSection(document: Document, title: string, desc: string, content: HTMLElement): HTMLElement {
  const sec = el(document, "section", "content-section");
  const heading = el(document, "div", "section-heading");
  heading.append(
    el(document, "h2", undefined, title),
    el(document, "p", "page-description", desc),
  );
  sec.append(heading, content);
  return sec;
}
