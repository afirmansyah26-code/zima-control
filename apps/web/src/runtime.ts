import { normalizeApiBaseUrl } from "./registry-api.js";

export interface WebRuntimeConfig {
  apiBaseUrl: string;
}

export function readWebRuntimeConfig(apiBaseUrl: string | undefined): WebRuntimeConfig {
  return { apiBaseUrl: normalizeApiBaseUrl(apiBaseUrl) };
}

export function createSafeConfigurationError(ownerDocument: Document): HTMLElement {
  const main = ownerDocument.createElement("main");
  main.setAttribute("role", "alert");
  const heading = ownerDocument.createElement("h1");
  heading.textContent = "Dashboard configuration error";
  const message = ownerDocument.createElement("p");
  message.textContent = "The dashboard could not start because its public API configuration is invalid.";
  main.append(heading, message);
  return main;
}
