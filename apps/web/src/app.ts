import type { AuthRole } from "@zima-control-center/application-registry-contracts";
import { AuthApiError, type AuthApiClient } from "./auth-api.js";
import { createBackupApiClient, type BackupApiClient } from "./backup-api.js";
import { renderBackupDetailPage, renderBackupHistoryPage } from "./backup-ui.js";
import { renderBackupDestinationsPage } from "./destination-ui.js";
import type { RegistryApiClient } from "./registry-api.js";
import {
  createDashboardShell,
  renderApplicationDetailPage,
  renderApplicationsPage,
  renderRouteNotFound,
} from "./ui.js";
import {
  addAuthenticatedUserControls,
  renderAuthenticationLoading,
  renderAuthenticationUnavailable,
  renderLoginPage,
} from "./auth-ui.js";

export type Clock = () => Date;

export async function renderDashboard(
  root: HTMLElement,
  api: RegistryApiClient,
  pathname: string,
  clock: Clock = () => new Date(),
  auth?: AuthApiClient,
  backupApi?: BackupApiClient,
): Promise<void> {
  const effectiveBackupApi = backupApi ?? createBackupApiClient();

  if (auth) {
    await renderAuthenticatedDashboard(root, api, pathname, clock, auth, effectiveBackupApi);
    return;
  }

  const navigate = (nextPath: string) => {
    navigateAndRender(root, api, nextPath, clock, auth, effectiveBackupApi);
  };
  await renderRegistryRoute(
    root,
    api,
    pathname,
    clock,
    undefined,
    undefined,
    "VIEWER",
    effectiveBackupApi,
    navigate,
  );
}

async function renderAuthenticatedDashboard(
  root: HTMLElement,
  api: RegistryApiClient,
  pathname: string,
  clock: Clock,
  auth: AuthApiClient,
  backupApi: BackupApiClient,
): Promise<void> {
  renderAuthenticationLoading(root);
  let user;
  try {
    user = await auth.me();
  } catch (error) {
    if (error instanceof AuthApiError && error.code === "UNAUTHENTICATED") {
      showLogin(root, api, clock, auth, backupApi);
      return;
    }
    renderAuthenticationUnavailable(root, () => {
      void renderAuthenticatedDashboard(root, api, pathname, clock, auth, backupApi);
    });
    return;
  }

  if (normalizePathname(pathname.split("?")[0] || "") === "/login") {
    navigateAndRender(root, api, "/applications", clock, auth, backupApi);
    return;
  }

  const navigate = (nextPath: string) => {
    navigateAndRender(root, api, nextPath, clock, auth, backupApi);
  };

  const content = createDashboardShell(root, pathname, navigate);
  addAuthenticatedUserControls(root, user, async () => {
    await auth.logout();
    root.ownerDocument.defaultView?.history.pushState({}, "", "/login");
    showLogin(root, api, clock, auth, backupApi);
  });
  const showUnauthenticated = (): void => {
    showLogin(root, api, clock, auth, backupApi);
  };
  await renderRegistryRoute(
    root,
    api,
    pathname,
    clock,
    content,
    showUnauthenticated,
    user.role,
    backupApi,
    navigate,
  );
}

function showLogin(
  root: HTMLElement,
  api: RegistryApiClient,
  clock: Clock,
  auth: AuthApiClient,
  backupApi: BackupApiClient,
): void {
  renderLoginPage(root, auth, () => {
    navigateAndRender(root, api, "/applications", clock, auth, backupApi);
  });
  if (root.ownerDocument.defaultView?.location.pathname !== "/login") {
    const view = root.ownerDocument.defaultView;
    view?.history.replaceState({}, "", "/login");
  }
}

function navigateAndRender(
  root: HTMLElement,
  api: RegistryApiClient,
  pathname: string,
  clock: Clock,
  auth?: AuthApiClient,
  backupApi?: BackupApiClient,
): void {
  root.ownerDocument.defaultView?.history.pushState({}, "", pathname);
  void renderDashboard(root, api, pathname, clock, auth, backupApi);
}

async function renderRegistryRoute(
  root: HTMLElement,
  api: RegistryApiClient,
  pathname: string,
  clock: Clock,
  existingContent?: HTMLElement,
  onUnauthorized?: () => void,
  userRole: AuthRole = "VIEWER",
  backupApi: BackupApiClient = createBackupApiClient(),
  navigate?: (nextPath: string) => void,
): Promise<void> {
  const content = existingContent ?? createDashboardShell(root, pathname, navigate);
  const route = parseRoute(pathname);

  if (route.kind === "applications") {
    await renderApplicationsPage(content, api, clock, onUnauthorized, navigate);
    return;
  }

  if (route.kind === "application-detail") {
    await renderApplicationDetailPage(
      content,
      api,
      route.id,
      clock,
      onUnauthorized,
      userRole,
      backupApi,
      navigate,
    );
    return;
  }

  if (route.kind === "backups") {
    await renderBackupHistoryPage(
      content,
      backupApi,
      clock,
      navigate ?? (() => {}),
      userRole,
      route.applicationId,
    );
    return;
  }

  if (route.kind === "backup-detail") {
    await renderBackupDetailPage(
      content,
      backupApi,
      route.id,
      clock,
      navigate ?? (() => {}),
    );
    return;
  }

  if (route.kind === "backup-destinations") {
    await renderBackupDestinationsPage(
      content,
      backupApi,
      clock,
      navigate ?? (() => {}),
      userRole,
    );
    return;
  }

  renderRouteNotFound(content);
}

type DashboardRoute =
  | { kind: "applications" }
  | { kind: "application-detail"; id: string }
  | { kind: "backups"; applicationId?: string }
  | { kind: "backup-detail"; id: string }
  | { kind: "backup-destinations" }
  | { kind: "not-found" };

export function parseRoute(pathname: string): DashboardRoute {
  const [rawPath, rawQuery] = pathname.split("?");
  const normalized = normalizePathname(rawPath || "/");

  if (normalized === "/" || normalized === "/applications") {
    return { kind: "applications" };
  }

  if (normalized === "/backup-destinations") {
    return { kind: "backup-destinations" };
  }

  const detailMatch = /^\/applications\/([^/]+)$/.exec(normalized);
  if (detailMatch?.[1]) {
    try {
      const id = decodeURIComponent(detailMatch[1]);
      if (!id || id.length > 128 || /[\u0000-\u001f\u007f]/.test(id)) {
        return { kind: "not-found" };
      }
      return { kind: "application-detail", id };
    } catch {
      return { kind: "not-found" };
    }
  }

  if (normalized === "/backups") {
    const params = new URLSearchParams(rawQuery || "");
    const applicationId = params.get("applicationId") || undefined;
    return { kind: "backups", applicationId };
  }

  const backupDetailMatch = /^\/backups\/([^/]+)$/.exec(normalized);
  if (backupDetailMatch?.[1]) {
    try {
      const id = decodeURIComponent(backupDetailMatch[1]);
      if (!id || id.length > 128 || /[\u0000-\u001f\u007f]/.test(id)) {
        return { kind: "not-found" };
      }
      return { kind: "backup-detail", id };
    } catch {
      return { kind: "not-found" };
    }
  }

  return { kind: "not-found" };
}

function normalizePathname(pathname: string): string {
  return pathname.length > 1 && pathname.endsWith("/")
    ? pathname.slice(0, -1)
    : pathname;
}
