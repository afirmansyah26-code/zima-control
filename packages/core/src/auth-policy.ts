export const roles = ["ADMIN", "OPERATOR", "VIEWER"] as const;
export type Role = (typeof roles)[number];

export const permissions = [
  "registry:read",
  "application:start",
  "application:stop",
  "application:restart",
  "auth:admin",
] as const;
export type Permission = (typeof permissions)[number];

export interface AuthenticatedUser {
  id: string;
  username: string;
  role: Role;
}

export type AuthorizationErrorCode = "AUTHENTICATION_REQUIRED" | "FORBIDDEN";

export class AuthorizationError extends Error {
  public constructor(public readonly code: AuthorizationErrorCode, message: string) {
    super(message);
    this.name = "AuthorizationError";
  }
}

export function requireAuthenticated(user: AuthenticatedUser | null): AuthenticatedUser {
  if (!user) {
    throw new AuthorizationError("AUTHENTICATION_REQUIRED", "Authentication is required");
  }
  return user;
}

export function requireRole(
  user: AuthenticatedUser | null,
  role: Role,
): AuthenticatedUser {
  const authenticated = requireAuthenticated(user);
  if (!canActAs(authenticated.role, role)) {
    throw new AuthorizationError("FORBIDDEN", "The authenticated user is not allowed to perform this action");
  }
  return authenticated;
}

export function requirePermission(
  user: AuthenticatedUser | null,
  permission: Permission,
): AuthenticatedUser {
  const authenticated = requireAuthenticated(user);
  if (!hasPermission(authenticated.role, permission)) {
    throw new AuthorizationError("FORBIDDEN", "The authenticated user is not allowed to perform this action");
  }
  return authenticated;
}

export function hasPermission(role: Role, permission: Permission): boolean {
  switch (permission) {
    case "registry:read":
      return canActAs(role, "VIEWER");
    case "application:start":
    case "application:stop":
    case "application:restart":
      return canActAs(role, "OPERATOR");
    case "auth:admin":
      return canActAs(role, "ADMIN");
  }
}

export function canActAs(role: Role, requiredRole: Role): boolean {
  return roleRank(role) >= roleRank(requiredRole);
}

function roleRank(role: Role): number {
  switch (role) {
    case "VIEWER":
      return 1;
    case "OPERATOR":
      return 2;
    case "ADMIN":
      return 3;
  }
}
