import "./styles.css";
import { renderDashboard } from "./app.js";
import { createRegistryApiClient, normalizeApiBaseUrl } from "./registry-api.js";

const root = document.querySelector<HTMLElement>("#app");

if (!root) {
  throw new Error("Dashboard root element is missing");
}

const api = createRegistryApiClient({
  baseUrl: normalizeApiBaseUrl(import.meta.env.VITE_API_BASE_URL),
});

void renderDashboard(root, api, window.location.pathname);
