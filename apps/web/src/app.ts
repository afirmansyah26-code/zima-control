import type { RegistryApiClient } from "./registry-api.js";
import {
  createDashboardShell,
  renderApplicationDetailPage,
  renderApplicationsPage,
  renderRouteNotFound,
} from "./ui.js";

export type Clock = () => Date;

export async function renderDashboard(
  root: HTMLElement,
  api: RegistryApiClient,
  pathname: string,
  clock: Clock = () => new Date(),
): Promise<void> {
  const content = createDashboardShell(root);
  const route = parseRoute(pathname);

  if (route.kind === "applications") {
    await renderApplicationsPage(content, api, clock);
    return;
  }

  if (route.kind === "application-detail") {
    await renderApplicationDetailPage(content, api, route.id, clock);
    return;
  }

  renderRouteNotFound(content);
}

type DashboardRoute =
  | { kind: "applications" }
  | { kind: "application-detail"; id: string }
  | { kind: "not-found" };

function parseRoute(pathname: string): DashboardRoute {
  const normalized = pathname.length > 1 && pathname.endsWith("/")
    ? pathname.slice(0, -1)
    : pathname;

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
