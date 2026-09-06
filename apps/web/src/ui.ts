import type {
  ApplicationDetailResponse,
  ApplicationEnvironmentMetadataResponse,
  ApplicationRuntimeContainerResponse,
  ApplicationServiceResponse,
  ApplicationSummaryResponse,
} from "@zima-control-center/application-registry-contracts";
import type { Clock } from "./app.js";
import {
  applicationStatuses,
  RegistryApiError,
  type ApplicationStatusFilter,
  type RegistryApiClient,
} from "./registry-api.js";

const unavailable = "Not available";
const timezone = "Asia/Jakarta";

export function createDashboardShell(root: HTMLElement): HTMLElement {
  const document = root.ownerDocument;
  const skipLink = element(document, "a", "skip-link", "Skip to content");
  skipLink.href = "#main-content";

  const brandMark = element(document, "span", "brand-mark", "Z");
  brandMark.setAttribute("aria-hidden", "true");
  const brandCopy = element(document, "span", "brand-copy");
  brandCopy.append(
    element(document, "strong", undefined, "Zima Control Center"),
    element(document, "span", undefined, "Application registry"),
  );
  const brand = element(document, "a", "brand");
  brand.href = "/applications";
  brand.setAttribute("aria-label", "Zima Control Center applications");
  brand.append(brandMark, brandCopy);

  const navLink = element(document, "a", "nav-link active");
  navLink.href = "/applications";
  navLink.setAttribute("aria-current", "page");
  const navIcon = element(document, "span", "nav-icon", "▦");
  navIcon.setAttribute("aria-hidden", "true");
  navLink.append(
    navIcon,
    element(document, "span", undefined, "Applications"),
  );

  const navigation = element(document, "nav", "primary-nav");
  navigation.setAttribute("aria-label", "Primary navigation");
  navigation.append(navLink);

  const environment = element(document, "div", "environment-chip");
  const environmentDot = element(document, "span", "environment-dot");
  environmentDot.setAttribute("aria-hidden", "true");
  environment.append(
    environmentDot,
    element(document, "span", undefined, "Read-only registry"),
  );

  const header = element(document, "header", "topbar");
  header.append(brand, navigation, environment);

  const content = element(document, "main", "main-content");
  content.id = "main-content";
  content.tabIndex = -1;

  const shell = element(document, "div", "dashboard-shell");
  shell.append(skipLink, header, content);
  root.replaceChildren(shell);
  return content;
}

export async function renderApplicationsPage(
  content: HTMLElement,
  api: RegistryApiClient,
  clock: Clock,
  onUnauthorized?: () => void,
): Promise<void> {
  const document = content.ownerDocument;
  const heading = pageHeading(
    document,
    "Inventory",
    "Applications",
    "Current application identities, desired deployments, and observed runtime state.",
  );
  const toolbar = element(document, "div", "toolbar");
  const search = inputField(document, "Search applications", "Search by name or display name");
  const status = statusFilter(document);
  toolbar.append(search.wrapper, status.wrapper);

  const results = element(document, "div", "results-region");
  results.setAttribute("aria-live", "polite");
  results.setAttribute("aria-busy", "true");
  content.replaceChildren(heading, toolbar, results);

  let applications: ApplicationSummaryResponse[] = [];

  const renderResults = (): void => {
    const query = search.input.value.trim().toLocaleLowerCase();
    const filtered = applications.filter((application) => {
      if (!query) {
        return true;
      }
      return application.name.toLocaleLowerCase().includes(query)
        || application.displayName?.toLocaleLowerCase().includes(query) === true;
    });
    results.replaceChildren(createApplicationsTable(document, filtered, clock));
    results.setAttribute("aria-busy", "false");
  };

  const load = async (selectedStatus?: ApplicationStatusFilter): Promise<void> => {
    results.setAttribute("aria-busy", "true");
    results.replaceChildren(loadingState(document, "Loading applications"));
    try {
      applications = [...await api.listApplications(selectedStatus)].sort(compareApplications);
      renderResults();
    } catch (error) {
      if (error instanceof RegistryApiError && error.code === "UNAUTHENTICATED" && onUnauthorized) {
        onUnauthorized();
        return;
      }
      results.setAttribute("aria-busy", "false");
      results.replaceChildren(errorState(
        document,
        "Applications could not be loaded",
        "The registry read API is unavailable. Existing application state has not been changed.",
        () => { void load(readStatusFilter(status.select)); },
      ));
    }
  };

  search.input.addEventListener("input", renderResults);
  status.select.addEventListener("change", () => {
    void load(readStatusFilter(status.select));
  });

  await load();
}

export async function renderApplicationDetailPage(
  content: HTMLElement,
  api: RegistryApiClient,
  applicationId: string,
  clock: Clock,
  onUnauthorized?: () => void,
): Promise<void> {
  const document = content.ownerDocument;
  const loading = loadingState(document, "Loading application detail");
  content.replaceChildren(loading);

  try {
    const detail = await api.getApplicationDetail(applicationId);
    content.replaceChildren(createApplicationDetail(document, detail, clock));
  } catch (error) {
    if (error instanceof RegistryApiError && error.code === "UNAUTHENTICATED" && onUnauthorized) {
      onUnauthorized();
      return;
    }
    if (error instanceof RegistryApiError && error.code === "NOT_FOUND") {
      content.replaceChildren(notFoundState(document));
      return;
    }
    content.replaceChildren(errorState(
      document,
      "Application detail could not be loaded",
      "The registry read API did not return a usable application snapshot.",
      () => { void renderApplicationDetailPage(content, api, applicationId, clock); },
    ));
  }
}

export function renderRouteNotFound(content: HTMLElement): void {
  content.replaceChildren(notFoundState(content.ownerDocument));
}

function pageHeading(
  document: Document,
  eyebrow: string,
  title: string,
  description: string,
): HTMLElement {
  const copy = element(document, "div");
  copy.append(
    element(document, "p", "eyebrow", eyebrow),
    element(document, "h1", undefined, title),
    element(document, "p", "page-description", description),
  );
  const heading = element(document, "div", "page-heading");
  heading.append(copy);
  return heading;
}

function inputField(
  document: Document,
  label: string,
  placeholder: string,
): { wrapper: HTMLElement; input: HTMLInputElement } {
  const id = "application-search";
  const input = document.createElement("input");
  input.id = id;
  input.type = "search";
  input.placeholder = placeholder;
  input.autocomplete = "off";
  input.className = "control";
  const wrapper = element(document, "div", "field search-field");
  const labelElement = element(document, "label", "field-label", label);
  labelElement.htmlFor = id;
  wrapper.append(labelElement, input);
  return { wrapper, input };
}

function statusFilter(
  document: Document,
): { wrapper: HTMLElement; select: HTMLSelectElement } {
  const id = "application-status";
  const select = document.createElement("select");
  select.id = id;
  select.className = "control";
  select.append(option(document, "", "All statuses"));
  for (const value of applicationStatuses) {
    select.append(option(document, value, statusLabel(value)));
  }
  const label = element(document, "label", "field-label", "Status");
  label.htmlFor = id;
  const wrapper = element(document, "div", "field status-field");
  wrapper.append(label, select);
  return { wrapper, select };
}

function option(document: Document, value: string, label: string): HTMLOptionElement {
  const item = document.createElement("option");
  item.value = value;
  item.textContent = label;
  return item;
}

function readStatusFilter(select: HTMLSelectElement): ApplicationStatusFilter | undefined {
  return applicationStatuses.find((status) => status === select.value);
}

function createApplicationsTable(
  document: Document,
  applications: ApplicationSummaryResponse[],
  clock: Clock,
): HTMLElement {
  if (applications.length === 0) {
    return emptyState(
      document,
      "No applications found",
      "No application matches the current search and status filter.",
    );
  }

  const table = document.createElement("table");
  table.className = "data-table applications-table";
  const caption = document.createElement("caption");
  caption.className = "sr-only";
  caption.textContent = "Discovered applications";
  table.append(caption, tableHeader(document, [
    "Application",
    "Status",
    "Runtime",
    "Managed by",
    "Last discovered",
  ]));
  const body = document.createElement("tbody");
  for (const application of applications) {
    const row = document.createElement("tr");
    const identityCell = cell(document, "Application");
    const link = element(
      document,
      "a",
      "application-link",
      application.displayName ?? application.name,
    );
    link.href = `/applications/${encodeURIComponent(application.id)}`;
    identityCell.append(link);
    if (application.displayName) {
      identityCell.append(element(document, "span", "cell-secondary", application.name));
    }
    if (application.isUncontrolled === true) {
      identityCell.append(element(document, "span", "tag muted", "Uncontrolled"));
    }

    const statusCell = cell(document, "Status");
    statusCell.append(statusBadge(document, application.status));
    const runtimeCell = cell(document, "Runtime");
    runtimeCell.append(textOrUnavailable(document, application.runtime));
    const managedCell = cell(document, "Managed by");
    managedCell.append(textOrUnavailable(document, application.managedBy));
    const freshnessCell = cell(document, "Last discovered");
    freshnessCell.append(freshness(document, application.lastDiscoveredAt, clock));
    row.append(identityCell, statusCell, runtimeCell, managedCell, freshnessCell);
    body.append(row);
  }
  table.append(body);
  const frame = element(document, "div", "table-frame");
  frame.append(table);
  return frame;
}

function createApplicationDetail(
  document: Document,
  detail: ApplicationDetailResponse,
  clock: Clock,
): HTMLElement {
  const application = detail.application;
  const wrapper = element(document, "div", "detail-page");
  const back = element(document, "a", "back-link", "← All applications");
  back.href = "/applications";

  const titleLine = element(document, "div", "detail-title-line");
  titleLine.append(
    element(document, "h1", undefined, application.displayName ?? application.name),
    statusBadge(document, application.status),
  );
  const headerCopy = element(document, "div");
  headerCopy.append(
    element(document, "p", "eyebrow", "Application detail"),
    titleLine,
    element(document, "p", "page-description", application.name),
  );
  const headerMeta = element(document, "div", "header-meta");
  headerMeta.append(
    compactDatum(document, "Runtime", application.runtime),
    compactDatum(document, "Managed by", application.managedBy),
  );
  const header = element(document, "header", "detail-header");
  header.append(back, headerCopy, headerMeta);

  wrapper.append(
    header,
    freshnessSection(document, detail, clock),
    overviewSection(document, detail, clock),
    deploymentSection(document, detail, clock),
    servicesSection(document, detail.services),
    runtimeSection(document, detail.runtimeContainers, clock),
  );
  return wrapper;
}

function freshnessSection(
  document: Document,
  detail: ApplicationDetailResponse,
  clock: Clock,
): HTMLElement {
  const grid = element(document, "div", "freshness-grid");
  grid.append(
    freshnessCard(document, "Last discovered", detail.freshness.lastDiscoveredAt, clock),
    freshnessCard(document, "Deployment snapshot", detail.freshness.deploymentDiscoveredAt, clock),
    freshnessCard(document, "Runtime observed", detail.freshness.latestRuntimeObservedAt, clock),
  );
  return grid;
}

function freshnessCard(
  document: Document,
  label: string,
  value: string | null,
  clock: Clock,
): HTMLElement {
  const card = element(document, "div", "freshness-card");
  card.append(element(document, "span", "datum-label", label), freshness(document, value, clock));
  return card;
}

function overviewSection(
  document: Document,
  detail: ApplicationDetailResponse,
  clock: Clock,
): HTMLElement {
  const application = detail.application;
  const list = element(document, "dl", "definition-grid");
  addDefinition(document, list, "Application ID", application.id, true);
  addDefinition(document, list, "Canonical name", application.name);
  addDefinition(document, list, "Display name", application.displayName);
  addDefinition(document, list, "Resource type", application.resourceType);
  addDefinition(document, list, "ZimaOS ID", application.zimaosAppId, true);
  addDefinition(document, list, "Uncontrolled", booleanLabel(application.isUncontrolled));
  addDefinition(document, list, "Created", absoluteTimestamp(application.createdAt, clock()));
  addDefinition(document, list, "Updated", absoluteTimestamp(application.updatedAt, clock()));
  return section(document, "Overview", "Canonical registry identity and classification.", list);
}

function deploymentSection(
  document: Document,
  detail: ApplicationDetailResponse,
  clock: Clock,
): HTMLElement {
  if (!detail.currentDeployment) {
    return section(
      document,
      "Deployment",
      "Current desired deployment metadata.",
      emptyState(document, "No current deployment", "A deployment snapshot is not available."),
    );
  }
  const deployment = detail.currentDeployment;
  const list = element(document, "dl", "definition-grid");
  addDefinition(document, list, "Compose name", deployment.composeName);
  addDefinition(document, list, "Source context", deployment.sourceContext, true);
  addDefinition(document, list, "Dockerfile", deployment.dockerfilePath, true);
  addDefinition(document, list, "Source hash", deployment.sourceHash, true);
  addDefinition(document, list, "Discovered", absoluteTimestamp(deployment.discoveredAt, clock()));
  return section(document, "Deployment", "Current desired deployment metadata.", list);
}

function servicesSection(document: Document, services: ApplicationServiceResponse[]): HTMLElement {
  if (services.length === 0) {
    return section(
      document,
      "Services",
      "Desired Compose services.",
      emptyState(document, "No current services", "No desired services are present in this snapshot."),
    );
  }
  const list = element(document, "div", "service-list");
  for (const service of services) {
    list.append(serviceCard(document, service));
  }
  return section(document, "Services", "Desired Compose services and safe metadata.", list);
}

function serviceCard(document: Document, service: ApplicationServiceResponse): HTMLElement {
  const card = element(document, "article", "service-card");
  const heading = element(document, "div", "service-heading");
  const title = element(document, "h3", undefined, service.name);
  heading.append(title, element(document, "span", "tag", "Desired state"));
  const metadata = element(document, "dl", "service-metadata");
  addDefinition(document, metadata, "Image", service.image, true);
  addDefinition(document, metadata, "Build context", service.buildContext, true);
  addDefinition(document, metadata, "Container name", service.containerName, true);
  card.append(
    heading,
    metadata,
    collectionBlock(document, "Ports", portList(document, service)),
    collectionBlock(document, "Volumes", volumeList(document, service)),
    collectionBlock(document, "Networks", networkList(document, service)),
    collectionBlock(document, "Environment metadata", environmentTable(document, service.environmentMetadata)),
  );
  return card;
}

function portList(document: Document, service: ApplicationServiceResponse): HTMLElement {
  if (service.ports.length === 0) {
    return inlineEmpty(document, "No desired ports");
  }
  const list = element(document, "ul", "mapping-list");
  for (const port of service.ports) {
    const item = document.createElement("li");
    item.append(
      code(document, port.published),
      element(document, "span", "mapping-arrow", "→"),
      code(document, `${port.target}/${port.protocol}`),
    );
    list.append(item);
  }
  return list;
}

function volumeList(document: Document, service: ApplicationServiceResponse): HTMLElement {
  if (service.volumes.length === 0) {
    return inlineEmpty(document, "No desired volumes");
  }
  const list = element(document, "ul", "mapping-list path-list");
  for (const volume of service.volumes) {
    const item = document.createElement("li");
    item.append(code(document, volume.source), element(document, "span", "mapping-arrow", "→"), code(document, volume.target));
    list.append(item);
  }
  return list;
}

function networkList(document: Document, service: ApplicationServiceResponse): HTMLElement {
  if (service.networks.length === 0) {
    return inlineEmpty(document, "No desired networks");
  }
  const list = element(document, "ul", "chip-list");
  for (const network of service.networks) {
    const item = document.createElement("li");
    item.append(
      element(document, "span", "network-name", network.name),
      element(
        document,
        "span",
        "tag muted",
        network.isExternal === null ? unavailable : network.isExternal ? "External" : "Internal",
      ),
    );
    list.append(item);
  }
  return list;
}

function environmentTable(
  document: Document,
  metadata: ApplicationEnvironmentMetadataResponse[],
): HTMLElement {
  if (metadata.length === 0) {
    return inlineEmpty(document, "No environment metadata");
  }
  const table = document.createElement("table");
  table.className = "data-table compact-table";
  table.append(tableHeader(document, ["Key", "Type", "Configured", "Present", "Source"]));
  const body = document.createElement("tbody");
  for (const item of metadata) {
    const row = document.createElement("tr");
    const keyCell = cell(document, "Key");
    keyCell.append(code(document, item.key));
    if (item.isSecret) {
      keyCell.append(element(document, "span", "tag secret-tag", "Secret"));
    }
    row.append(
      keyCell,
      textCell(document, "Type", item.type),
      textCell(document, "Configured", booleanLabel(item.configured)),
      textCell(document, "Present", booleanLabel(item.present)),
      textCell(document, "Source", item.source),
    );
    body.append(row);
  }
  table.append(body);
  const frame = element(document, "div", "table-frame nested");
  frame.append(table);
  return frame;
}

function runtimeSection(
  document: Document,
  containers: ApplicationRuntimeContainerResponse[],
  clock: Clock,
): HTMLElement {
  if (containers.length === 0) {
    return section(
      document,
      "Runtime",
      "Current observations only; absence does not imply a stopped application.",
      emptyState(
        document,
        "No current runtime containers",
        "No authoritative current container observation is available.",
      ),
    );
  }
  const table = document.createElement("table");
  table.className = "data-table runtime-table";
  table.append(tableHeader(document, ["Container", "Image", "State", "Status", "Observed"]));
  const body = document.createElement("tbody");
  for (const container of containers) {
    const row = document.createElement("tr");
    const identity = cell(document, "Container");
    identity.append(
      element(document, "span", "container-name", container.containerName ?? unavailable),
      code(document, container.containerId, "truncate-code"),
    );
    row.append(
      identity,
      textCell(document, "Image", container.image, true),
      textCell(document, "State", container.state),
      textCell(document, "Status", container.status),
      timeCell(document, "Observed", container.observedAt, clock),
    );
    body.append(row);
  }
  table.append(body);
  const frame = element(document, "div", "table-frame");
  frame.append(table);
  return section(
    document,
    "Runtime",
    "Current observations only; freshness is not a health assertion.",
    frame,
  );
}

function section(
  document: Document,
  title: string,
  description: string,
  body: HTMLElement,
): HTMLElement {
  const header = element(document, "div", "section-heading");
  header.append(element(document, "h2", undefined, title), element(document, "p", undefined, description));
  const sectionElement = element(document, "section", "content-section");
  sectionElement.append(header, body);
  return sectionElement;
}

function collectionBlock(document: Document, title: string, body: HTMLElement): HTMLElement {
  const block = element(document, "section", "collection-block");
  block.append(element(document, "h4", undefined, title), body);
  return block;
}

function tableHeader(document: Document, labels: string[]): HTMLTableSectionElement {
  const head = document.createElement("thead");
  const row = document.createElement("tr");
  for (const label of labels) {
    const header = document.createElement("th");
    header.scope = "col";
    header.textContent = label;
    row.append(header);
  }
  head.append(row);
  return head;
}

function cell(document: Document, label: string): HTMLTableCellElement {
  const item = document.createElement("td");
  item.dataset.label = label;
  return item;
}

function textCell(
  document: Document,
  label: string,
  value: string | null,
  monospace = false,
): HTMLTableCellElement {
  const item = cell(document, label);
  item.append(monospace ? code(document, value ?? unavailable) : textOrUnavailable(document, value));
  return item;
}

function timeCell(
  document: Document,
  label: string,
  value: string | null,
  clock: Clock,
): HTMLTableCellElement {
  const item = cell(document, label);
  item.append(freshness(document, value, clock));
  return item;
}

function addDefinition(
  document: Document,
  list: HTMLElement,
  label: string,
  value: string | null,
  monospace = false,
): void {
  const group = element(document, "div", "definition-item");
  const description = element(document, "dd");
  description.append(monospace ? code(document, value ?? unavailable) : (value ?? unavailable));
  group.append(element(document, "dt", "datum-label", label), description);
  list.append(group);
}

function compactDatum(document: Document, label: string, value: string | null): HTMLElement {
  const item = element(document, "div", "compact-datum");
  item.append(element(document, "span", "datum-label", label), textOrUnavailable(document, value));
  return item;
}

function statusBadge(document: Document, value: string | null): HTMLElement {
  const normalized = value?.trim().toUpperCase() ?? "";
  const known = applicationStatuses.find((status) => status === normalized);
  const label = known ? statusLabel(known) : value?.trim() || unavailable;
  const badge = element(document, "span", `status-badge status-${statusTone(known)}`, label);
  badge.setAttribute("aria-label", `Status: ${label}`);
  const dot = element(document, "span", "status-dot");
  dot.setAttribute("aria-hidden", "true");
  badge.prepend(dot);
  return badge;
}

function statusTone(status: ApplicationStatusFilter | undefined): string {
  switch (status) {
    case "RUNNING": return "running";
    case "STOPPED": return "stopped";
    case "DEGRADED": return "degraded";
    case "ERROR": return "error";
    case "UNKNOWN": return "unknown";
    default: return "missing";
  }
}

function statusLabel(status: ApplicationStatusFilter): string {
  return status.charAt(0) + status.slice(1).toLocaleLowerCase();
}

function freshness(document: Document, value: string | null, clock: Clock): HTMLElement {
  const formatted = formatTimestamp(value, clock());
  if (!formatted.valid) {
    return element(document, "span", "unavailable", unavailable);
  }
  const time = element(document, "time", "freshness-value", formatted.relative);
  time.setAttribute("datetime", formatted.iso);
  time.title = formatted.absolute;
  return time;
}

function absoluteTimestamp(value: string | null, now: Date): string {
  const formatted = formatTimestamp(value, now);
  return formatted.valid ? formatted.absolute : unavailable;
}

type FormattedTimestamp =
  | { valid: false }
  | { valid: true; relative: string; absolute: string; iso: string };

function formatTimestamp(value: string | null, now: Date): FormattedTimestamp {
  if (!value) {
    return { valid: false };
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return { valid: false };
  }
  const absolute = new Intl.DateTimeFormat("en-GB", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: timezone,
  }).format(date);
  const delta = now.getTime() - date.getTime();
  if (delta < -60_000) {
    return { valid: true, relative: "Future timestamp", absolute, iso: date.toISOString() };
  }
  if (delta < 60_000) {
    return { valid: true, relative: "Just now", absolute, iso: date.toISOString() };
  }
  const minutes = Math.floor(delta / 60_000);
  if (minutes < 60) {
    return { valid: true, relative: `${minutes} min ago`, absolute, iso: date.toISOString() };
  }
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    return { valid: true, relative: `${hours} hr ago`, absolute, iso: date.toISOString() };
  }
  const days = Math.floor(hours / 24);
  return { valid: true, relative: `${days} day${days === 1 ? "" : "s"} ago`, absolute, iso: date.toISOString() };
}

function booleanLabel(value: boolean | null): string {
  return value === null ? unavailable : value ? "Yes" : "No";
}

function textOrUnavailable(document: Document, value: string | null): HTMLElement {
  return element(document, "span", value ? undefined : "unavailable", value || unavailable);
}

function code(document: Document, value: string, className?: string): HTMLElement {
  return element(document, "code", className, value);
}

function inlineEmpty(document: Document, message: string): HTMLElement {
  return element(document, "p", "inline-empty", message);
}

function loadingState(document: Document, message: string): HTMLElement {
  const state = element(document, "div", "state-panel loading-state");
  state.setAttribute("role", "status");
  const spinner = element(document, "span", "spinner");
  spinner.setAttribute("aria-hidden", "true");
  state.append(spinner, element(document, "p", undefined, message));
  return state;
}

function emptyState(document: Document, title: string, description: string): HTMLElement {
  const state = element(document, "div", "state-panel empty-state");
  const icon = element(document, "span", "state-icon", "○");
  icon.setAttribute("aria-hidden", "true");
  state.append(
    icon,
    element(document, "h3", undefined, title),
    element(document, "p", undefined, description),
  );
  return state;
}

function errorState(
  document: Document,
  title: string,
  description: string,
  retry: () => void,
): HTMLElement {
  const state = element(document, "div", "state-panel error-state");
  state.setAttribute("role", "alert");
  const icon = element(document, "span", "state-icon", "!");
  icon.setAttribute("aria-hidden", "true");
  const button = element(document, "button", "button", "Retry");
  button.type = "button";
  button.addEventListener("click", retry);
  state.append(
    icon,
    element(document, "h2", undefined, title),
    element(document, "p", undefined, description),
    button,
  );
  return state;
}

function notFoundState(document: Document): HTMLElement {
  const state = element(document, "div", "state-panel empty-state");
  const icon = element(document, "span", "state-icon", "○");
  icon.setAttribute("aria-hidden", "true");
  const link = element(document, "a", "button", "Back to applications");
  link.href = "/applications";
  state.append(
    icon,
    element(document, "h1", undefined, "Application not found"),
    element(document, "p", undefined, "The requested application is not present in the current registry."),
    link,
  );
  return state;
}

function element<K extends keyof HTMLElementTagNameMap>(
  document: Document,
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const item = document.createElement(tag);
  if (className) {
    item.className = className;
  }
  if (text !== undefined) {
    item.textContent = text;
  }
  return item;
}

function compareApplications(
  left: ApplicationSummaryResponse,
  right: ApplicationSummaryResponse,
): number {
  return compareText(left.name, right.name) || compareText(left.id, right.id);
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
