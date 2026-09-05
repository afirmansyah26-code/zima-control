import "./styles.css";
import { renderDashboard } from "./app.js";
import { createRegistryApiClient } from "./registry-api.js";
import { createSafeConfigurationError, readWebRuntimeConfig } from "./runtime.js";

const root = document.querySelector<HTMLElement>("#app");

if (root) {
  try {
    const api = createRegistryApiClient({
      baseUrl: readWebRuntimeConfig(import.meta.env.VITE_API_BASE_URL).apiBaseUrl,
    });
    void renderDashboard(root, api, window.location.pathname);
  } catch {
    root.replaceChildren(createSafeConfigurationError(document));
  }
}
