import assert from "node:assert/strict";
import { test } from "node:test";
import type { AuthUserResponse } from "@zima-control-center/application-registry-contracts";
import { JSDOM } from "jsdom";
import { AuthApiError, createAuthApiClient, type AuthApiClient } from "./auth-api.js";
import { renderDashboard } from "./app.js";
import { RegistryApiError, type FetchImplementation } from "./registry-api.js";

const user: AuthUserResponse = { id: "user-1", username: "admin", role: "ADMIN" };

function setup(pathname = "/applications") {
  const dom = new JSDOM("<!doctype html><div id=\"app\"></div>", {
    url: `https://control.example${pathname}`,
  });
  const root = dom.window.document.querySelector<HTMLElement>("#app");
  assert.ok(root);
  return { dom, root };
}

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function registryApi(fetchImplementation: FetchImplementation) {
  return {
    listApplications: async () => {
      const response = await fetchImplementation("/api/applications", { method: "GET" });
      if (response.status === 401) {
        throw new RegistryApiError("UNAUTHENTICATED", "Authentication is required");
      }
      return await response.json() as never;
    },
    getApplicationDetail: async () => ({}) as never,
  };
}

function authMock(
  me: AuthApiClient["me"],
  login: AuthApiClient["login"] = async () => user,
  logout: AuthApiClient["logout"] = async () => undefined,
): AuthApiClient {
  return { me, login, logout };
}

test("unauthenticated dashboard renders a login form", async () => {
  const { root } = setup();
  const auth = authMock(async () => { throw new AuthApiError("UNAUTHENTICATED"); });
  const api = registryApi(async () => json([]));

  await renderDashboard(root, api, "/applications", undefined, auth);

  assert.match(root.textContent ?? "", /Sign in/);
  assert.ok(root.querySelector("form.auth-form"));
  assert.ok(root.querySelector<HTMLInputElement>("#username"));
  assert.ok(root.querySelector<HTMLInputElement>("#password"));
});

test("bad credentials show a safe login error and do not reflect input", async () => {
  const { dom, root } = setup("/login");
  const auth = authMock(
    async () => { throw new AuthApiError("UNAUTHENTICATED"); },
    async () => { throw new AuthApiError("INVALID_CREDENTIALS"); },
  );
  await renderDashboard(root, registryApi(async () => json([])), "/login", undefined, auth);
  const form = root.querySelector<HTMLFormElement>(".auth-form");
  const username = root.querySelector<HTMLInputElement>("#username");
  const password = root.querySelector<HTMLInputElement>("#password");
  assert.ok(form && username && password);
  username.value = "admin@example.test";
  password.value = "password=should-not-render";
  form.dispatchEvent(new dom.window.Event("submit", { bubbles: true, cancelable: true }));
  await waitFor(() => !root.querySelector<HTMLElement>(".auth-error")?.hidden);

  assert.match(root.textContent ?? "", /Invalid username or password/);
  assert.doesNotMatch(root.textContent ?? "", /password=should-not-render|admin@example.test/);
});

test("successful login navigates to applications without storing a token", async () => {
  const { dom, root } = setup("/login");
  let authenticated = false;
  const auth = authMock(
    async () => {
      if (!authenticated) {
        throw new AuthApiError("UNAUTHENTICATED");
      }
      return user;
    },
    async () => {
      authenticated = true;
      return user;
    },
  );
  await renderDashboard(root, registryApi(async () => json([])), "/login", undefined, auth);
  const form = root.querySelector<HTMLFormElement>(".auth-form");
  const username = root.querySelector<HTMLInputElement>("#username");
  const password = root.querySelector<HTMLInputElement>("#password");
  assert.ok(form && username && password);
  username.value = "admin";
  password.value = "correct horse battery staple";
  form.dispatchEvent(new dom.window.Event("submit", { bubbles: true, cancelable: true }));
  await waitFor(() => root.querySelector(".dashboard-shell") !== null);

  assert.equal(dom.window.location.pathname, "/applications");
  assert.match(root.textContent ?? "", /Applications/);
  assert.equal("localStorage" in dom.window, true);
  assert.equal(dom.window.localStorage.length, 0);
  assert.equal("sessionStorage" in dom.window, true);
  assert.equal(dom.window.sessionStorage.length, 0);
});

test("logout returns an authenticated dashboard to the login state", async () => {
  const { dom, root } = setup();
  let loggedOut = false;
  const auth = authMock(
    async () => loggedOut ? (() => { throw new AuthApiError("UNAUTHENTICATED"); })() : user,
    async () => user,
    async () => { loggedOut = true; },
  );
  await renderDashboard(root, registryApi(async () => json([])), "/applications", undefined, auth);
  const logout = root.querySelector<HTMLButtonElement>(".auth-controls button");
  assert.ok(logout);
  logout.click();
  await waitFor(() => root.querySelector(".auth-form") !== null);
  assert.equal(dom.window.location.pathname, "/login");
  assert.match(root.textContent ?? "", /Sign in/);
});

test("a registry 401 transitions an authenticated dashboard to login", async () => {
  const { root } = setup();
  const auth = authMock(async () => user);
  const api = registryApi(async () => json({ error: { code: "AUTHENTICATION_REQUIRED" } }, 401));
  await renderDashboard(root, api, "/applications", undefined, auth);

  await waitFor(() => root.querySelector(".auth-form") !== null);
  assert.match(root.textContent ?? "", /Sign in/);
});

test("auth client uses same-origin credentials and only sends the CSRF header", async () => {
  const requests: Array<{ url: string; init: RequestInit | undefined }> = [];
  const client = createAuthApiClient({
    cookieSource: () => "zima_cc_csrf=abcdefghijklmnopqrstuvwxyz0123456789_-",
    fetchImplementation: async (input, init) => {
      requests.push({ url: typeof input === "string" ? input : input.toString(), init });
      if (requests.length === 1) {
        return json({ user });
      }
      return json({ loggedOut: true });
    },
  });

  await client.me();
  await client.logout();
  assert.equal(requests[0]?.init?.credentials, "same-origin");
  assert.equal(requests[1]?.init?.credentials, "same-origin");
  const headers = new Headers(requests[1]?.init?.headers);
  assert.equal(headers.get("X-CSRF-Token"), "abcdefghijklmnopqrstuvwxyz0123456789_-");
  assert.equal(headers.get("Authorization"), null);
});

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    if (predicate()) {
      return;
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
  assert.fail("Timed out waiting for UI state");
}
