import { AuthApiError, type AuthApiClient } from "./auth-api.js";
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
): Promise<void> {
  if (auth) {
    await renderAuthenticatedDashboard(root, api, pathname, clock, auth);
    return;
  }

  await renderRegistryRoute(root, api, pathname, clock);
}

async function renderAuthenticatedDashboard(
  root: HTMLElement,
  api: RegistryApiClient,
  pathname: string,
  clock: Clock,
  auth: AuthApiClient,
): Promise<void> {
  renderAuthenticationLoading(root);
  let user;
  try {
    user = await auth.me();
  } catch (error) {
    if (error instanceof AuthApiError && error.code === "UNAUTHENTICATED") {
      showLogin(root, api, clock, auth);
      return;
    }
    renderAuthenticationUnavailable(root, () => {
      void renderAuthenticatedDashboard(root, api, pathname, clock, auth);
    });
    return;
  }

  if (normalizePathname(pathname) === "/login") {
    navigateAndRender(root, api, "/applications", clock, auth);
    return;
  }

  const content = createDashboardShell(root);
  addAuthenticatedUserControls(root, user, async () => {
    await auth.logout();
    root.ownerDocument.defaultView?.history.pushState({}, "", "/login");
    showLogin(root, api, clock, auth);
  });
  const showUnauthenticated = (): void => {
    showLogin(root, api, clock, auth);
  };
  await renderRegistryRoute(root, api, pathname, clock, content, showUnauthenticated);
}

function showLogin(
  root: HTMLElement,
  api: RegistryApiClient,
  clock: Clock,
  auth: AuthApiClient,
): void {
  renderLoginPage(root, auth, () => {
    navigateAndRender(root, api, "/applications", clock, auth);
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
  auth: AuthApiClient,
): void {
  root.ownerDocument.defaultView?.history.pushState({}, "", pathname);
  void renderDashboard(root, api, pathname, clock, auth);
}

async function renderRegistryRoute(
  root: HTMLElement,
  api: RegistryApiClient,
  pathname: string,
  clock: Clock,
  existingContent?: HTMLElement,
  onUnauthorized?: () => void,
): Promise<void> {
  const content = existingContent ?? createDashboardShell(root);
  const route = parseRoute(pathname);

  if (route.kind === "applications") {
    await renderApplicationsPage(content, api, clock, onUnauthorized);
    return;
  }

  if (route.kind === "application-detail") {
    await renderApplicationDetailPage(content, api, route.id, clock, onUnauthorized);
    return;
  }

  renderRouteNotFound(content);
}

type DashboardRoute =
  | { kind: "applications" }
  | { kind: "application-detail"; id: string }
  | { kind: "not-found" };

function parseRoute(pathname: string): DashboardRoute {
  const normalized = normalizePathname(pathname);

  if (normalized === "/" || normalized === "/applications") {
    return { kind: "applications" };
  }

  const detailMatch = /^\/applications\/([^/]+)$/.exec(normalized);
  if (!detailMatch?.[1]) {
    return { kind: "not-found" };
  }

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

function normalizePathname(pathname: string): string {
  return pathname.length > 1 && pathname.endsWith("/")
    ? pathname.slice(0, -1)
    : pathname;
}
