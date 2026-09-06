import assert from "node:assert/strict";
import { test } from "node:test";
import {
  AuthorizationError,
  hasPermission,
  requireAuthenticated,
  requirePermission,
  requireRole,
  type AuthenticatedUser,
} from "./auth-policy.js";

const viewer: AuthenticatedUser = { id: "viewer", username: "viewer", role: "VIEWER" };
const operator: AuthenticatedUser = { id: "operator", username: "operator", role: "OPERATOR" };
const admin: AuthenticatedUser = { id: "admin", username: "admin", role: "ADMIN" };

test("registry read permission is available to every defined role", () => {
  assert.equal(hasPermission("VIEWER", "registry:read"), true);
  assert.equal(hasPermission("OPERATOR", "registry:read"), true);
  assert.equal(hasPermission("ADMIN", "registry:read"), true);
  assert.equal(hasPermission("VIEWER", "auth:admin"), false);
  assert.equal(hasPermission("OPERATOR", "auth:admin"), false);
  assert.equal(hasPermission("ADMIN", "auth:admin"), true);
});

test("authorization policy keeps authentication and role failures explicit", () => {
  assert.equal(requireAuthenticated(viewer), viewer);
  assert.equal(requirePermission(viewer, "registry:read"), viewer);
  assert.equal(requireRole(operator, "VIEWER"), operator);
  assert.equal(requireRole(admin, "ADMIN"), admin);
  assert.throws(() => requireAuthenticated(null), (error) => (
    error instanceof AuthorizationError && error.code === "AUTHENTICATION_REQUIRED"
  ));
  assert.throws(() => requireRole(viewer, "ADMIN"), (error) => (
    error instanceof AuthorizationError && error.code === "FORBIDDEN"
  ));
  assert.throws(() => requirePermission(operator, "auth:admin"), (error) => (
    error instanceof AuthorizationError && error.code === "FORBIDDEN"
  ));
});
