import { requireRole } from "@zima-control-center/core";
import type { Hono } from "hono";
import type { AuthenticationBoundary } from "./auth/http.js";
import type { ApplicationMutationStatusReadService } from "./mutation-status-service.js";

export function installApplicationMutationStatusRoute(
  app: Hono,
  auth: AuthenticationBoundary,
  statusService: ApplicationMutationStatusReadService,
): void {
  app.get("/api/mutations/:operationId", async (context) => {
    const user = await auth.currentUser(context.req.header("Cookie"));
    const actor = requireRole(user, "OPERATOR");
    const response = await statusService.get(actor, context.req.param("operationId"));
    return context.json(response, 200);
  });
}
