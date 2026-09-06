import { timingSafeEqual } from "node:crypto";
import { AuthServiceError } from "./service.js";

export const csrfHeaderName = "X-CSRF-Token";

export function assertSameOriginRequest(requestUrl: string, origin: string | undefined): void {
  if (origin === undefined) {
    return;
  }
  try {
    if (origin !== new URL(requestUrl).origin) {
      throw new AuthServiceError("CSRF_REQUIRED");
    }
  } catch (error) {
    if (error instanceof AuthServiceError) {
      throw error;
    }
    throw new AuthServiceError("CSRF_REQUIRED");
  }
}

export function assertCsrfToken(headerValue: string | undefined, cookieValue: string | undefined): void {
  if (!headerValue || !cookieValue || !/^[A-Za-z0-9_-]{32,128}$/.test(headerValue)) {
    throw new AuthServiceError("CSRF_REQUIRED");
  }
  const headerBuffer = Buffer.from(headerValue);
  const cookieBuffer = Buffer.from(cookieValue);
  if (headerBuffer.length !== cookieBuffer.length || !timingSafeEqual(headerBuffer, cookieBuffer)) {
    throw new AuthServiceError("CSRF_REQUIRED");
  }
}
