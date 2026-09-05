import assert from "node:assert/strict";
import { test } from "node:test";
import type {
  ApplicationDetailResponse,
  ApplicationSummaryResponse,
} from "@zima-control-center/application-registry-contracts";
import { JSDOM } from "jsdom";
import { renderDashboard } from "./app.js";
import {
  createRegistryApiClient,
  normalizeApiBaseUrl,
  type FetchImplementation,
} from "./registry-api.js";
import { createSafeConfigurationError, readWebRuntimeConfig } from "./runtime.js";

const now = new Date("2026-09-05T12:00:00.000Z");
const safeTimestamp = "2026-09-05T11:55:00.000Z";

function application(
  overrides: Partial<ApplicationSummaryResponse> = {},
): ApplicationSummaryResponse {
  return {
    id: "app-1",
    name: "sisfo",
    displayName: "SISFO",
    resourceType: "APPLICATION",
    runtime: "DOCKER",
    status: "RUNNING",
    managedBy: "ZIMAOS",
    zimaosAppId: "zimaapp://v2app/sisfo",
    isUncontrolled: false,
    lastDiscoveredAt: safeTimestamp,
    createdAt: "2026-09-01T00:00:00.000Z",
    updatedAt: safeTimestamp,
    ...overrides,
  };
}

function detail(overrides: Partial<ApplicationDetailResponse> = {}): ApplicationDetailResponse {
  return {
    application: application(),
    currentDeployment: {
      id: "deployment-1",
      composeName: "sisfo",
      sourceContext: "/DATA/AppData/sisfo",
      dockerfilePath: "/DATA/AppData/sisfo/Dockerfile",
      sourceHash: "sha256-safe-hash",
      discoveredAt: safeTimestamp,
    },
    services: [{
      id: "service-1",
      name: "web",
      containerName: "sisfo-web",
      image: "example/sisfo:1",
      buildContext: "/DATA/AppData/sisfo",
      ports: [{ published: "6091", target: 6091, protocol: "tcp" }],
      volumes: [{ source: "/DATA/AppData/sisfo/storage", target: "/app/storage" }],
      networks: [{ name: "sisfo-network", isExternal: false }],
      environmentMetadata: [{
        key: "DATABASE_URL",
        type: "SECRET",
        isSecret: true,
        configured: true,
        present: true,
        source: "compose",
      }],
    }],
    runtimeContainers: [{
      containerId: "0123456789abcdef",
      containerName: "sisfo-web",
      image: "example/sisfo:1",
      state: "running",
      status: "Up 5 minutes",
      observedAt: safeTimestamp,
    }],
    freshness: {
      lastDiscoveredAt: safeTimestamp,
      deploymentDiscoveredAt: safeTimestamp,
      latestRuntimeObservedAt: safeTimestamp,
    },
    ...overrides,
  };
}

function setup(pathname = "/applications") {
  const dom = new JSDOM("<!doctype html><div id=\"app\"></div>", {
    url: `https://control.example${pathname}`,
  });
  const root = dom.window.document.querySelector<HTMLElement>("#app");
  assert.ok(root);
  return { dom, root };
}

function apiFrom(
  handler: (url: string, init: RequestInit | undefined) => Promise<Response> | Response,
) {
  const fetchImplementation: FetchImplementation = async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    return handler(url, init);
  };
  return createRegistryApiClient({ fetchImplementation });
}

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

test("applications list renders API results in deterministic order", async () => {
  const { root } = setup();
  const api = apiFrom(() => json([
    application({ id: "z", name: "zeta", displayName: "Zeta" }),
    application({ id: "a", name: "alpha", displayName: "Alpha" }),
  ]));

  await renderDashboard(root, api, "/applications", () => now);

  const links = [...root.querySelectorAll<HTMLElement>(".application-link")];
  assert.deepEqual(links.map((link) => link.textContent), ["Alpha", "Zeta"]);
  assert.equal(links[0]?.getAttribute("href"), "/applications/a");
  assert.match(root.textContent ?? "", /5 min ago/);
});

test("applications page shows an explicit empty state", async () => {
  const { root } = setup();
  await renderDashboard(root, apiFrom(() => json([])), "/applications", () => now);

  assert.match(root.textContent ?? "", /No applications found/);
});

test("applications page exposes a readable loading state", async () => {
  const { root } = setup();
  let resolveResponse: ((response: Response) => void) | undefined;
  const pending = new Promise<Response>((resolve) => { resolveResponse = resolve; });
  const render = renderDashboard(root, apiFrom(() => pending), "/applications", () => now);

  assert.match(root.textContent ?? "", /Loading applications/);
  assert.equal(root.querySelector("[role=status]") !== null, true);
  assert.ok(resolveResponse);
  resolveResponse(json([]));
  await render;
});

test("API failures render a safe retry state without raw errors", async () => {
  const { root } = setup();
  const api = apiFrom(() => {
    throw new Error("Prisma DATABASE_URL=file:prod.db password=do-not-render");
  });

  await renderDashboard(root, api, "/applications", () => now);

  const text = root.textContent ?? "";
  assert.match(text, /Applications could not be loaded/);
  assert.match(text, /Retry/);
  assert.doesNotMatch(text, /Prisma|DATABASE_URL|do-not-render/);
});

test("status filter uses the supported API query and search remains client-side", async () => {
  const { dom, root } = setup();
  const requests: string[] = [];
  const api = apiFrom((url) => {
    requests.push(url);
    if (url.endsWith("?status=STOPPED")) {
      return json([application({ id: "stopped", name: "archive", displayName: "Archive", status: "STOPPED" })]);
    }
    return json([
      application({ id: "one", name: "sisfo", displayName: "SISFO" }),
      application({ id: "two", name: "cashflow", displayName: "Cashflow" }),
    ]);
  });
  await renderDashboard(root, api, "/applications", () => now);

  const search = root.querySelector<HTMLInputElement>("#application-search");
  assert.ok(search);
  search.value = "cash";
  search.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
  assert.deepEqual(
    [...root.querySelectorAll<HTMLElement>(".application-link")].map((item) => item.textContent),
    ["Cashflow"],
  );
  assert.equal(requests.length, 1, "search must not add an API query");

  const status = root.querySelector<HTMLSelectElement>("#application-status");
  assert.ok(status);
  status.value = "STOPPED";
  status.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
  await waitFor(() => requests.length === 2);
  assert.equal(requests[1], "/api/applications?status=STOPPED");
});

test("application detail renders deployment, services, mappings, metadata, and runtime", async () => {
  const { root } = setup("/applications/app-1");
  const api = apiFrom((url) => {
    assert.equal(url, "/api/applications/app-1");
    return json(detail());
  });

  await renderDashboard(root, api, "/applications/app-1", () => now);

  const text = root.textContent ?? "";
  for (const expected of [
    "SISFO",
    "sha256-safe-hash",
    "web",
    "6091/tcp",
    "/app/storage",
    "sisfo-network",
    "DATABASE_URL",
    "Secret",
    "0123456789abcdef",
    "Up 5 minutes",
  ]) {
    assert.match(text, new RegExp(escapeRegularExpression(expected)));
  }
});

test("service child collections have explicit empty states", async () => {
  const { root } = setup("/applications/app-1");
  const snapshot = detail();
  const currentService = snapshot.services[0];
  assert.ok(currentService);
  snapshot.services = [{
    ...currentService,
    ports: [],
    volumes: [],
    networks: [],
    environmentMetadata: [],
  }];

  await renderDashboard(root, apiFrom(() => json(snapshot)), "/applications/app-1", () => now);

  const text = root.textContent ?? "";
  assert.match(text, /No desired ports/);
  assert.match(text, /No desired volumes/);
  assert.match(text, /No desired networks/);
  assert.match(text, /No environment metadata/);
});

test("application not found receives a dedicated safe state", async () => {
  const { root } = setup("/applications/missing");
  await renderDashboard(
    root,
    apiFrom(() => json({ error: { code: "APPLICATION_NOT_FOUND", message: "hidden" } }, 404)),
    "/applications/missing",
    () => now,
  );

  assert.match(root.textContent ?? "", /Application not found/);
  assert.match(root.textContent ?? "", /Back to applications/);
  assert.doesNotMatch(root.textContent ?? "", /hidden/);
});

test("untrusted extra secret and Compose fields are discarded before rendering", async () => {
  const { root } = setup("/applications/app-1");
  const unsafe = detail() as ApplicationDetailResponse & Record<string, unknown>;
  unsafe.composeYamlRedacted = "password=compose-secret-do-not-render";
  const service = (unsafe.services[0] ?? {}) as unknown as Record<string, unknown>;
  const environment = ((service.environmentMetadata as unknown[])?.[0] ?? {}) as Record<string, unknown>;
  environment.value = "environment-secret-do-not-render";
  environment.password = "password-secret-do-not-render";
  environment.token = "token-secret-do-not-render";

  await renderDashboard(root, apiFrom(() => json(unsafe)), "/applications/app-1", () => now);

  const output = root.textContent ?? "";
  assert.doesNotMatch(output, /compose-secret-do-not-render/);
  assert.doesNotMatch(output, /environment-secret-do-not-render/);
  assert.doesNotMatch(output, /password-secret-do-not-render/);
  assert.doesNotMatch(output, /token-secret-do-not-render/);
  assert.equal(root.querySelector("script, iframe") !== null, false);
});

test("unknown and missing statuses render neutral accessible labels", async () => {
  const { root } = setup();
  await renderDashboard(root, apiFrom(() => json([
    application({ id: "future", name: "future", status: "PAUSED" }),
    application({ id: "missing", name: "missing", status: null }),
  ])), "/applications", () => now);

  const badges = [...root.querySelectorAll<HTMLElement>(".status-badge")];
  assert.deepEqual(badges.map((item) => item.textContent?.trim()), ["PAUSED", "Not available"]);
  assert.deepEqual(
    badges.map((item) => item.getAttribute("aria-label")),
    ["Status: PAUSED", "Status: Not available"],
  );
  assert.equal(badges.every((item) => item.classList.contains("status-missing")), true);
});

test("missing, malformed, and future freshness timestamps render neutrally", async () => {
  const { root } = setup();
  await renderDashboard(root, apiFrom(() => json([
    application({ id: "missing", name: "missing", lastDiscoveredAt: null }),
    application({ id: "malformed", name: "malformed", lastDiscoveredAt: "not-a-date" }),
    application({ id: "future", name: "future", lastDiscoveredAt: "2026-09-06T12:00:00.000Z" }),
  ])), "/applications", () => now);

  const text = root.textContent ?? "";
  assert.match(text, /Not available/);
  assert.match(text, /Future timestamp/);
  assert.doesNotMatch(text, /Invalid Date|NaN|ago ago/);
});

test("null deployment and empty collections are neutral and never imply stopped", async () => {
  const { root } = setup("/applications/app-1");
  const emptyDetail = detail({
    application: application({ status: null }),
    currentDeployment: null,
    services: [],
    runtimeContainers: [],
    freshness: {
      lastDiscoveredAt: null,
      deploymentDiscoveredAt: null,
      latestRuntimeObservedAt: null,
    },
  });
  await renderDashboard(root, apiFrom(() => json(emptyDetail)), "/applications/app-1", () => now);

  const text = root.textContent ?? "";
  assert.match(text, /No current deployment/);
  assert.match(text, /No current services/);
  assert.match(text, /No current runtime containers/);
  assert.match(text, /absence does not imply a stopped application/i);
  assert.equal(root.querySelector(".status-badge")?.textContent?.trim(), "Not available");
  assert.doesNotMatch(text, /Status: Stopped/);
});

test("invalid API payloads become a safe UI error", async () => {
  const { root } = setup("/applications/app-1");
  await renderDashboard(
    root,
    apiFrom(() => json({ application: { id: 42 }, raw: "do-not-reflect" })),
    "/applications/app-1",
    () => now,
  );

  assert.match(root.textContent ?? "", /Application detail could not be loaded/);
  assert.doesNotMatch(root.textContent ?? "", /do-not-reflect|42/);
});

test("API base URL configuration allows HTTP origins without credentials", () => {
  assert.equal(normalizeApiBaseUrl(undefined), "");
  assert.equal(normalizeApiBaseUrl("https://api.example.test/registry/"), "https://api.example.test/registry");
  assert.throws(() => normalizeApiBaseUrl("javascript:alert(1)"), /configuration is invalid/);
  assert.throws(() => normalizeApiBaseUrl("https://user:password@example.test"), /configuration is invalid/);
});

test("registry client uses same-origin API paths by default", async () => {
  const requests: string[] = [];
  const client = createRegistryApiClient({
    fetchImplementation: async (input) => {
      requests.push(typeof input === "string" ? input : input.toString());
      return json([]);
    },
  });

  await client.listApplications();
  assert.deepEqual(requests, ["/api/applications"]);
});

test("API base URL rejects server secrets, query strings, and fragments", () => {
  assert.throws(() => normalizeApiBaseUrl("file:/data/registry.db"), /configuration is invalid/);
  assert.throws(() => normalizeApiBaseUrl("https://api.example.test/?token=secret"), /configuration is invalid/);
  assert.throws(() => normalizeApiBaseUrl("https://api.example.test/#secret"), /configuration is invalid/);
});

test("web runtime defaults to same-origin and renders a fixed configuration failure", () => {
  assert.deepEqual(readWebRuntimeConfig(undefined), { apiBaseUrl: "" });
  assert.throws(
    () => readWebRuntimeConfig("https://user:do-not-return@example.test"),
    (error) => error instanceof Error && !error.message.includes("do-not-return"),
  );

  const { dom } = setup();
  const error = createSafeConfigurationError(dom.window.document);
  assert.equal(error.getAttribute("role"), "alert");
  assert.match(error.textContent ?? "", /configuration is invalid/);
  assert.doesNotMatch(error.textContent ?? "", /do-not-return|password|token/i);
});

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (predicate()) {
      return;
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
  assert.fail("Timed out waiting for UI state");
}

function escapeRegularExpression(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
