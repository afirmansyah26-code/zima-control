import "./styles.css";
import { renderDashboard } from "./app.js";
import { createAuthApiClient } from "./auth-api.js";
import { createRegistryApiClient } from "./registry-api.js";
import { createSafeConfigurationError, readWebRuntimeConfig } from "./runtime.js";

const root = document.querySelector<HTMLElement>("#app");

if (root) {
  try {
    const apiBaseUrl = readWebRuntimeConfig(import.meta.env.VITE_API_BASE_URL).apiBaseUrl;
    const api = createRegistryApiClient({
      baseUrl: apiBaseUrl,
    });
    const auth = createAuthApiClient({ baseUrl: apiBaseUrl });
    const render = (): void => {
      void renderDashboard(root, api, window.location.pathname, undefined, auth);
    };
    render();
    window.addEventListener("popstate", render);
  } catch {
    root.replaceChildren(createSafeConfigurationError(document));
  }
}
