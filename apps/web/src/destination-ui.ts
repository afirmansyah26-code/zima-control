// apps/web/src/destination-ui.ts
// Destination Management UI for ZCC Backup Storage (Phase 8.2)

import type { AuthRole } from "@zima-control-center/application-registry-contracts";
import type { Clock } from "./app.js";
import {
  BackupApiError,
  type BackupApiClient,
  type BackupDestinationDetailDto,
  type BackupDestinationSummaryDto,
  type BackupDestinationValidationResultDto,
  type CreateBackupDestinationInputDto,
  type DestinationHealthDto,
  type DestinationType,
  type UpdateBackupDestinationInputDto,
} from "./backup-api.js";
import { formatBytes, relativeTime } from "./backup-ui.js";

// ==============================================================================
// DOM HELPERS
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

function createOption(document: Document, value: string, text: string): HTMLOptionElement {
  const opt = document.createElement("option");
  opt.value = value;
  opt.textContent = text;
  return opt;
}

// ==============================================================================
// HEALTH & STATUS BADGES
// ==============================================================================

export interface HealthStateMapping {
  readonly label: string;
  readonly cssClass: string;
  readonly icon: string;
}

export function mapDestinationHealthState(health?: DestinationHealthDto | null): HealthStateMapping {
  if (!health) {
    return { label: "Unknown/error", cssClass: "tag-neutral", icon: "?" };
  }

  const reason = (health.reason || "").toLowerCase();
  const status = (health.status || "").toUpperCase();

  if (reason.includes("mismatch") || (reason.includes("marker") && reason.includes("id"))) {
    return { label: "Identity mismatch", cssClass: "tag-danger", icon: "✕" };
  }
  if (reason.includes("permission") || (health.mounted && !health.writable && reason.includes("permission"))) {
    return { label: "Permission denied", cssClass: "tag-danger", icon: "✕" };
  }
  if (!health.mounted || reason.includes("not mounted") || reason.includes("unmounted")) {
    return { label: "Not mounted", cssClass: "tag-danger", icon: "✕" };
  }
  if (health.mounted && !health.writable) {
    return { label: "Read-only", cssClass: "tag-warning", icon: "⚠" };
  }
  if (status === "HEALTHY") {
    return { label: "Healthy", cssClass: "tag-success", icon: "✓" };
  }
  if (status === "UNAVAILABLE") {
    return { label: "Unavailable", cssClass: "tag-danger", icon: "✕" };
  }
  return { label: "Unknown/error", cssClass: "tag-neutral", icon: "?" };
}

export function destinationHealthBadge(document: Document, health?: DestinationHealthDto | null): HTMLElement {
  const mapping = mapDestinationHealthState(health);
  const badge = el(document, "span", `tag ${mapping.cssClass} destination-health-tag`);
  badge.textContent = `${mapping.icon} ${mapping.label}`;
  return badge;
}

export function destinationTypeBadge(document: Document, type: DestinationType | string): HTMLElement {
  const badge = el(document, "span", "tag destination-type-tag");
  if (type === "SYNOLOGY_NAS") {
    badge.className += " tag-accent";
    badge.textContent = "Synology NAS";
  } else {
    badge.className += " tag-neutral";
    badge.textContent = "Local Filesystem";
  }
  return badge;
}

export function destinationStatusBadge(document: Document, isActive: boolean): HTMLElement {
  const badge = el(document, "span", "tag destination-active-tag");
  if (isActive) {
    badge.className += " tag-success";
    badge.textContent = "● Active";
  } else {
    badge.className += " tag-warning";
    badge.textContent = "○ Disabled";
  }
  return badge;
}

// ==============================================================================
// DESTINATION MANAGEMENT PAGE (/backup-destinations)
// ==============================================================================

export async function renderBackupDestinationsPage(
  content: HTMLElement,
  backupApi: BackupApiClient,
  clock: Clock,
  navigate: (pathname: string) => void,
  userRole: AuthRole = "VIEWER",
): Promise<void> {
  const document = content.ownerDocument;

  // 1. Page Heading
  const heading = el(document, "div", "page-heading");
  const eyebrow = el(document, "p", "page-eyebrow", "Storage & Infrastructure");
  const title = el(document, "h1", undefined, "Backup Destinations");
  const desc = el(
    document,
    "p",
    "page-description",
    "Manage and validate Local Filesystem and Synology NAS storage targets for deterministic disaster recovery.",
  );
  heading.append(eyebrow, title, desc);

  // 2. Toolbar Actions
  const toolbar = el(document, "div", "toolbar destinations-toolbar");
  const toolbarLeft = el(document, "div", "toolbar-left");
  const toolbarRight = el(document, "div", "toolbar-right");

  const refreshBtn = el(document, "button", "button button-quiet", "↻ Refresh");
  refreshBtn.id = "refresh-destinations-btn";
  toolbarLeft.append(refreshBtn);

  if (userRole === "ADMIN") {
    const addBtn = el(document, "button", "button button-primary", "+ Add Destination");
    addBtn.id = "create-destination-button";
    addBtn.addEventListener("click", () => {
      renderCreateDestinationModal(content, backupApi, () => {
        void fetchAndRender();
      });
    });
    toolbarRight.append(addBtn);
  }

  toolbar.append(toolbarLeft, toolbarRight);

  // 3. Results Container
  const results = el(document, "div", "results-region");
  results.setAttribute("aria-live", "polite");
  content.replaceChildren(heading, toolbar, results);

  async function fetchAndRender() {
    results.replaceChildren(el(document, "div", "state-panel", "Loading backup destinations..."));

    try {
      const destinations = await backupApi.listDestinations();
      renderDestinationsList(destinations);
    } catch (err: unknown) {
      const msg = err instanceof BackupApiError ? err.message : "Failed to load backup destinations";
      const errorPanel = el(document, "div", "state-panel error-state");
      errorPanel.append(
        el(document, "h3", undefined, "Destination Registry Error"),
        el(document, "p", undefined, msg),
      );
      const retryBtn = el(document, "button", "button", "Retry");
      retryBtn.addEventListener("click", () => { void fetchAndRender(); });
      errorPanel.append(retryBtn);
      results.replaceChildren(errorPanel);
    }
  }

  refreshBtn.addEventListener("click", () => {
    void fetchAndRender();
  });

  function renderDestinationsList(destinations: BackupDestinationSummaryDto[]) {
    if (destinations.length === 0) {
      const emptyPanel = el(document, "div", "state-panel empty-destinations-panel");
      emptyPanel.append(
        el(document, "h3", undefined, "No backup destination configured."),
        el(
          document,
          "p",
          undefined,
          "No storage targets are currently registered. Administrators can provision local or Synology NAS storage.",
        ),
      );
      if (userRole === "ADMIN") {
        const createEmptyBtn = el(document, "button", "button button-primary", "+ Add Destination");
        createEmptyBtn.addEventListener("click", () => {
          renderCreateDestinationModal(content, backupApi, () => {
            void fetchAndRender();
          });
        });
        emptyPanel.append(createEmptyBtn);
      }
      results.replaceChildren(emptyPanel);
      return;
    }

    const grid = el(document, "div", "destination-grid");

    for (const dest of destinations) {
      const card = el(document, "article", "destination-card");
      card.id = `destination-card-${dest.id}`;

      // Card Header
      const cardHeader = el(document, "div", "destination-card-header");
      const titleWrapper = el(document, "div", "destination-title-wrapper");
      titleWrapper.append(
        el(document, "h2", "destination-name", dest.name),
        destinationTypeBadge(document, dest.type),
        destinationStatusBadge(document, dest.isActive),
      );
      const healthBadgeWrapper = el(document, "div", "destination-health-wrapper");
      const currentHealthBadge = destinationHealthBadge(document, dest.health);
      healthBadgeWrapper.append(currentHealthBadge);
      cardHeader.append(titleWrapper, healthBadgeWrapper);

      // Card Body
      const cardBody = el(document, "div", "destination-card-body");

      // Storage Capacity & Meter
      const cap = dest.health.capacityBytes !== null ? Number(dest.health.capacityBytes) : null;
      const avail = dest.health.availableBytes !== null ? Number(dest.health.availableBytes) : null;
      const meterBlock = el(document, "div", "storage-meter-block");
      const meterLabel = el(document, "div", "storage-meter-labels");

      if (cap !== null && avail !== null && cap > 0) {
        const used = Math.max(0, cap - avail);
        const pctUsed = Math.min(100, Math.round((used / cap) * 100));
        meterLabel.append(
          el(document, "span", "stat-highlight", `${formatBytes(avail)} free`),
          el(document, "span", "stat-total", `of ${formatBytes(cap)} (${pctUsed}% used)`),
        );
        const track = el(document, "div", "storage-meter-track");
        const fill = el(document, "div", "storage-meter-fill");
        fill.style.width = `${pctUsed}%`;
        if (pctUsed > 90) fill.className += " meter-critical";
        else if (pctUsed > 75) fill.className += " meter-warning";
        track.append(fill);
        meterBlock.append(meterLabel, track);
      } else {
        meterLabel.append(el(document, "span", "stat-unavailable", "Capacity not reported / unmounted"));
        meterBlock.append(meterLabel);
      }

      // Metadata Key-Value Grid
      const metaGrid = el(document, "dl", "destination-meta-grid");

      // Sanitized Location
      addMetaItem(document, metaGrid, "Location", dest.displayLocation);

      // Mounted & Writable
      const mountStateText = dest.health.mounted ? "✓ Mounted" : "✕ Not Mounted";
      const writeStateText = dest.health.writable ? "✓ Writable" : "✕ Read-Only";
      addMetaItem(document, metaGrid, "Filesystem Access", `${mountStateText} • ${writeStateText}`);

      // Last Health Check
      const checkedText = dest.health.checkedAt
        ? relativeTime(dest.health.checkedAt, clock())
        : "Pending check";
      addMetaItem(document, metaGrid, "Last Validated", checkedText);

      // Dependency Summary (if available)
      const depContainer = el(document, "div", "destination-dependencies-block");
      cardBody.append(meterBlock, metaGrid, depContainer);

      // Validation Result Notice Container (dynamic)
      const noticeContainer = el(document, "div", "validation-notice-container");
      cardBody.append(noticeContainer);

      // Card Actions
      const cardActions = el(document, "div", "destination-card-actions");

      // "Check Health" button (Operator & Admin)
      if (userRole === "OPERATOR" || userRole === "ADMIN") {
        const checkHealthBtn = el(document, "button", "button button-secondary check-health-btn", "Check Health");
        checkHealthBtn.id = `check-health-${dest.id}`;
        checkHealthBtn.addEventListener("click", async () => {
          checkHealthBtn.disabled = true;
          checkHealthBtn.textContent = "Checking Health...";
          noticeContainer.replaceChildren(el(document, "div", "status-checking-banner", "Executing live preflight validation..."));

          try {
            const validation: BackupDestinationValidationResultDto = await backupApi.validateDestination(dest.id);
            // Update badge
            const newBadge = destinationHealthBadge(document, {
              status: validation.status,
              mounted: validation.mounted,
              writable: validation.writable,
              availableBytes: validation.availableBytes,
              capacityBytes: validation.capacityBytes,
              reason: validation.reason,
            });
            healthBadgeWrapper.replaceChildren(newBadge);

            const outcomeBanner = el(
              document,
              "div",
              validation.status === "HEALTHY" ? "validation-banner-success" : "validation-banner-error",
            );
            if (validation.status === "HEALTHY") {
              outcomeBanner.textContent = `✓ Health check verified: Storage is mounted, writable, and responsive.`;
            } else {
              const reasonText = validation.reason || "Storage target is unavailable or failing preflight.";
              outcomeBanner.textContent = `✕ Health check failed: ${reasonText}`;
            }
            noticeContainer.replaceChildren(outcomeBanner);
          } catch (err: unknown) {
            const msg = err instanceof BackupApiError ? err.message : "Validation request failed";
            const errBanner = el(document, "div", "validation-banner-error", `✕ Error: ${msg}`);
            noticeContainer.replaceChildren(errBanner);
          } finally {
            checkHealthBtn.disabled = false;
            checkHealthBtn.textContent = "Check Health";
          }
        });
        cardActions.append(checkHealthBtn);
      }

      // Admin Only Actions: Edit, Enable, Disable
      if (userRole === "ADMIN") {
        const editBtn = el(document, "button", "button button-quiet", "Rename");
        editBtn.id = `edit-destination-${dest.id}`;
        editBtn.addEventListener("click", () => {
          renderEditDestinationModal(content, dest, backupApi, () => {
            void fetchAndRender();
          });
        });
        cardActions.append(editBtn);

        if (dest.isActive) {
          const disableBtn = el(document, "button", "button button-quiet button-danger-quiet", "Disable");
          disableBtn.id = `disable-destination-${dest.id}`;
          disableBtn.addEventListener("click", () => {
            renderDisableDestinationModal(content, dest, backupApi, () => {
              void fetchAndRender();
            });
          });
          cardActions.append(disableBtn);
        } else {
          const enableBtn = el(document, "button", "button button-secondary", "Enable");
          enableBtn.id = `enable-destination-${dest.id}`;
          enableBtn.addEventListener("click", async () => {
            enableBtn.disabled = true;
            enableBtn.textContent = "Enabling...";
            try {
              await backupApi.enableDestination(dest.id);
              void fetchAndRender();
            } catch (err: unknown) {
              const msg = err instanceof BackupApiError ? err.message : "Failed to enable destination";
              alert(`Unable to enable destination: ${msg}`);
              enableBtn.disabled = false;
              enableBtn.textContent = "Enable";
            }
          });
          cardActions.append(enableBtn);
        }
      }

      card.append(cardHeader, cardBody, cardActions);
      grid.append(card);

      // Asynchronously fetch dependency counts to enrich display without blocking
      void backupApi.getDestination(dest.id).then((detail: BackupDestinationDetailDto) => {
        if (detail.dependencies) {
          const deps = detail.dependencies;
          depContainer.replaceChildren();
          const depList = el(document, "div", "destination-dep-summary");
          depList.append(
            el(document, "span", "dep-badge", `${deps.activeConfigsCount} bound app${deps.activeConfigsCount === 1 ? "" : "s"}`),
            el(document, "span", "dep-badge", `${deps.activeJobsCount} active job${deps.activeJobsCount === 1 ? "" : "s"}`),
            el(document, "span", "dep-badge", `${deps.retainedArtifactsCount} archive${deps.retainedArtifactsCount === 1 ? "" : "s"}`),
          );
          depContainer.append(depList);
        }
      }).catch(() => {
        // Silently continue if detail fetch is throttled or unsupported
      });
    }

    results.replaceChildren(grid);
  }

  void fetchAndRender();
}

function addMetaItem(document: Document, grid: HTMLElement, label: string, value: string): void {
  const dt = el(document, "dt", "meta-label", label);
  const dd = el(document, "dd", "meta-value", value);
  grid.append(dt, dd);
}

// ==============================================================================
// CREATE DESTINATION MODAL (Admin Only)
// ==============================================================================

export function renderCreateDestinationModal(
  root: HTMLElement,
  backupApi: BackupApiClient,
  onSuccess: () => void,
): void {
  const document = root.ownerDocument;
  const overlay = el(document, "div", "modal-overlay");
  overlay.id = "create-destination-modal";

  const modal = el(document, "div", "modal-container modal-destination");
  const header = el(document, "header", "modal-header");
  header.append(
    el(document, "h2", undefined, "Register Backup Destination"),
    el(
      document,
      "p",
      "modal-description",
      "Add a Local Filesystem target or a pre-provisioned Synology NAS network share for disaster recovery.",
    ),
  );

  const form = el(document, "form", "modal-form");

  // Name
  const nameField = el(document, "div", "field");
  nameField.append(el(document, "label", "field-label", "Destination Name"));
  const nameInput = el(document, "input", "control");
  nameInput.id = "destination-name-input";
  nameInput.placeholder = "e.g. synology-primary-backup or local-storage";
  nameInput.required = true;
  nameField.append(nameInput);

  // Type
  const typeField = el(document, "div", "field");
  typeField.append(el(document, "label", "field-label", "Destination Type"));
  const typeSelect = el(document, "select", "control");
  typeSelect.id = "destination-type-select";
  typeSelect.append(
    createOption(document, "LOCAL_FILESYSTEM", "Local Filesystem"),
    createOption(document, "SYNOLOGY_NAS", "Synology NAS"),
  );
  typeField.append(typeSelect);

  // Provisioned Target Selector for Synology NAS
  const synologyContainer = el(document, "div", "synology-preset-container");
  synologyContainer.style.display = "none";

  const shareField = el(document, "div", "field");
  shareField.append(el(document, "label", "field-label", "Provisioned NAS Mount Point"));
  const shareSelect = el(document, "select", "control");
  shareSelect.id = "destination-basepath-select";
  shareSelect.append(
    createOption(document, "/zcc-destinations/synology-staging-test", "Staging Synology Share (/zcc-destinations/synology-staging-test)"),
    createOption(document, "/zcc-destinations/synology-primary", "Primary Synology Share (/zcc-destinations/synology-primary)"),
    createOption(document, "", "Automatic Directory (/zcc-destinations/<name>)"),
  );
  const shareHelp = el(
    document,
    "p",
    "field-help",
    "Select the pre-mounted infrastructure share. ZCC enforces zero credential storage and zero raw terminal access.",
  );
  shareField.append(shareSelect, shareHelp);
  synologyContainer.append(shareField);

  typeSelect.addEventListener("change", () => {
    if (typeSelect.value === "SYNOLOGY_NAS") {
      synologyContainer.style.display = "block";
    } else {
      synologyContainer.style.display = "none";
    }
  });

  const errorRegion = el(document, "div", "form-error-region");

  const modalActions = el(document, "div", "modal-actions");
  const cancelBtn = el(document, "button", "button button-quiet", "Cancel");
  cancelBtn.type = "button";
  cancelBtn.addEventListener("click", () => { overlay.remove(); });

  const submitBtn = el(document, "button", "button button-primary", "Register Destination");
  submitBtn.type = "submit";
  submitBtn.id = "submit-destination-button";

  modalActions.append(cancelBtn, submitBtn);

  form.append(nameField, typeField, synologyContainer, errorRegion, modalActions);
  modal.append(header, form);
  overlay.append(modal);
  root.append(overlay);

  nameInput.focus();

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    errorRegion.replaceChildren();

    const name = nameInput.value.trim();
    if (!name) {
      errorRegion.textContent = "Destination name is required.";
      return;
    }

    const type = typeSelect.value as DestinationType;
    let basePath: string | undefined = undefined;
    if (type === "SYNOLOGY_NAS") {
      basePath = shareSelect.value.trim() || undefined;
    }

    submitBtn.disabled = true;
    submitBtn.textContent = "Registering...";

    try {
      const payload: CreateBackupDestinationInputDto = {
        name,
        type,
        basePath,
      };
      await backupApi.createDestination(payload);
      overlay.remove();
      onSuccess();
    } catch (err: unknown) {
      submitBtn.disabled = false;
      submitBtn.textContent = "Register Destination";
      if (err instanceof BackupApiError) {
        errorRegion.textContent = err.message;
      } else {
        errorRegion.textContent = "Failed to register destination. Check parameters and health.";
      }
    }
  });
}

// ==============================================================================
// EDIT DESTINATION MODAL (Admin Only)
// ==============================================================================

export function renderEditDestinationModal(
  root: HTMLElement,
  dest: BackupDestinationSummaryDto,
  backupApi: BackupApiClient,
  onSuccess: () => void,
): void {
  const document = root.ownerDocument;
  const overlay = el(document, "div", "modal-overlay");
  overlay.id = "edit-destination-modal";

  const modal = el(document, "div", "modal-container modal-destination");
  const header = el(document, "header", "modal-header");
  header.append(
    el(document, "h2", undefined, `Rename Destination: ${dest.name}`),
    el(document, "p", "modal-description", "Update the display name of this backup storage destination. Infrastructure bindings and types remain immutable."),
  );

  const form = el(document, "form", "modal-form");

  // Name
  const nameField = el(document, "div", "field");
  nameField.append(el(document, "label", "field-label", "Destination Name"));
  const nameInput = el(document, "input", "control");
  nameInput.id = "edit-destination-name-input";
  nameInput.value = dest.name;
  nameInput.required = true;
  nameField.append(nameInput);

  // Immutable Metadata
  const metaList = el(document, "dl", "definition-grid");
  addMetaItem(document, metaList, "Destination Type", dest.type === "SYNOLOGY_NAS" ? "Synology NAS" : "Local Filesystem");
  addMetaItem(document, metaList, "Mount Location", dest.displayLocation);

  const errorRegion = el(document, "div", "form-error-region");

  const modalActions = el(document, "div", "modal-actions");
  const cancelBtn = el(document, "button", "button button-quiet", "Cancel");
  cancelBtn.type = "button";
  cancelBtn.addEventListener("click", () => { overlay.remove(); });

  const submitBtn = el(document, "button", "button button-primary", "Save Changes");
  submitBtn.type = "submit";
  submitBtn.id = "save-edit-destination-btn";

  modalActions.append(cancelBtn, submitBtn);

  form.append(nameField, metaList, errorRegion, modalActions);
  modal.append(header, form);
  overlay.append(modal);
  root.append(overlay);

  nameInput.focus();

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    errorRegion.replaceChildren();

    const newName = nameInput.value.trim();
    if (!newName) {
      errorRegion.textContent = "Destination name cannot be blank.";
      return;
    }

    submitBtn.disabled = true;
    submitBtn.textContent = "Saving...";

    try {
      const payload: UpdateBackupDestinationInputDto = { name: newName };
      await backupApi.updateDestination(dest.id, payload);
      overlay.remove();
      onSuccess();
    } catch (err: unknown) {
      submitBtn.disabled = false;
      submitBtn.textContent = "Save Changes";
      if (err instanceof BackupApiError) {
        errorRegion.textContent = err.message;
      } else {
        errorRegion.textContent = "Failed to update destination name.";
      }
    }
  });
}

// ==============================================================================
// DISABLE CONFIRMATION DIALOG (Admin Only)
// ==============================================================================

export function renderDisableDestinationModal(
  root: HTMLElement,
  dest: BackupDestinationSummaryDto,
  backupApi: BackupApiClient,
  onSuccess: () => void,
): void {
  const document = root.ownerDocument;
  const overlay = el(document, "div", "modal-overlay");
  overlay.id = "disable-destination-modal";

  const modal = el(document, "div", "modal-container modal-danger");
  const header = el(document, "header", "modal-header");
  header.append(
    el(document, "h2", undefined, `Disable Destination: ${dest.name}`),
  );

  const contentBlock = el(document, "div", "modal-body-copy");

  // Prominent Safety Notice (Section 6 Requirement)
  const noticeBox = el(document, "div", "safety-notice-box");
  noticeBox.append(
    el(document, "strong", "safety-notice-title", "Menonaktifkan destination tidak menghapus backup yang sudah ada."),
    el(
      document,
      "p",
      "safety-notice-text",
      "Disabling this destination will prevent new backups and new configurations from binding to it. Historical backups, archived manifests, and checksums will remain safe and intact on storage.",
    ),
  );

  contentBlock.append(noticeBox);

  // Force checkbox option
  const forceField = el(document, "div", "field-checkbox");
  const forceCheckbox = el(document, "input", "control-checkbox");
  forceCheckbox.type = "checkbox";
  forceCheckbox.id = "force-disable-checkbox";
  const forceLabel = el(
    document,
    "label",
    "checkbox-label",
    "Force deactivation if active application backup configurations currently point to this destination.",
  );
  forceLabel.htmlFor = "force-disable-checkbox";
  forceField.append(forceCheckbox, forceLabel);
  contentBlock.append(forceField);

  const errorRegion = el(document, "div", "form-error-region");

  const modalActions = el(document, "div", "modal-actions");
  const cancelBtn = el(document, "button", "button button-quiet", "Cancel");
  cancelBtn.type = "button";
  cancelBtn.addEventListener("click", () => { overlay.remove(); });

  const confirmBtn = el(document, "button", "button button-danger", "Disable Destination");
  confirmBtn.type = "button";
  confirmBtn.id = "confirm-disable-destination-btn";

  modalActions.append(cancelBtn, confirmBtn);

  modal.append(header, contentBlock, errorRegion, modalActions);
  overlay.append(modal);
  root.append(overlay);

  confirmBtn.addEventListener("click", async () => {
    confirmBtn.disabled = true;
    confirmBtn.textContent = "Disabling...";
    errorRegion.replaceChildren();

    const force = forceCheckbox.checked;

    try {
      await backupApi.disableDestination(dest.id, { force });
      overlay.remove();
      onSuccess();
    } catch (err: unknown) {
      confirmBtn.disabled = false;
      confirmBtn.textContent = "Disable Destination";
      if (err instanceof BackupApiError) {
        errorRegion.textContent = err.message;
      } else {
        errorRegion.textContent = "Cannot disable destination: active backup jobs or dependencies exist.";
      }
    }
  });
}
