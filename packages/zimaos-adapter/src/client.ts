import type {
  ZimaOSApplicationDto,
  ZimaOSInstalledListResponse,
  ZimaOSReadClient,
  ZimaOSComposeResult,
} from "./types.js";
import { ZimaOSAdapterError } from "./errors.js";

export class ZimaOSClient implements ZimaOSReadClient {
  public constructor(
    private readonly baseUrl: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  private async requestJson<T>(path: string): Promise<T> {
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method: "GET",
        headers: {
          Accept: "application/json",
        },
      });
    } catch {
      throw new ZimaOSAdapterError("HTTP_ERROR", "ZimaOS request failed");
    }

    if (!response.ok) {
      throw new ZimaOSAdapterError(
        "HTTP_ERROR",
        `ZimaOS HTTP ${response.status}`,
      );
    }

    try {
      return await response.json() as T;
    } catch {
      throw new ZimaOSAdapterError(
        "INVALID_INSTALLED_LIST",
        "ZimaOS installed application response is invalid",
      );
    }
  }

  public async getInstalledApplications(): Promise<ZimaOSApplicationDto[]> {
    const result = await this.requestJson<ZimaOSInstalledListResponse>(
      "/v2/app_management/installed/list?mode=sync",
    );

    if (!result || typeof result !== "object" || !Array.isArray((result as ZimaOSInstalledListResponse).data)) {
      throw new ZimaOSAdapterError(
        "INVALID_INSTALLED_LIST",
        "ZimaOS installed application response is invalid",
      );
    }

    for (const application of result.data) {
      if (
        !application
        || typeof application !== "object"
        || (application.id !== undefined && application.id !== null && typeof application.id !== "string")
        || typeof application.name !== "string"
        || !Array.isArray(application.containers)
      ) {
        throw new ZimaOSAdapterError(
          "INVALID_INSTALLED_LIST",
          "ZimaOS installed application item is invalid",
        );
      }
      for (const container of application.containers) {
        if (
          !container
          || typeof container !== "object"
          || typeof container.id !== "string"
          || typeof container.name !== "string"
          || typeof container.image !== "string"
          || typeof container.service_name !== "string"
          || typeof container.state !== "string"
          || typeof container.status !== "string"
          || !Array.isArray(container.port_mappings)
        ) {
          throw new ZimaOSAdapterError(
            "INVALID_INSTALLED_LIST",
            "ZimaOS installed application container is invalid",
          );
        }
      }
    }

    return result.data;
  }

  public async getApplicationCompose(appName: string): Promise<ZimaOSComposeResult> {
    let response: Response;
    try {
      response = await this.fetchImpl(
        `${this.baseUrl}/v2/app_management/compose/${encodeURIComponent(appName)}`,
        {
          method: "GET",
          headers: {
            Accept: "application/yaml",
          },
        },
      );
    } catch {
      throw new ZimaOSAdapterError("HTTP_ERROR", "ZimaOS Compose request failed");
    }

    if (!response.ok) {
      throw new ZimaOSAdapterError(
        "HTTP_ERROR",
        `ZimaOS Compose HTTP ${response.status}`,
      );
    }

    let text: string;
    try {
      text = await response.text();
    } catch {
      throw new ZimaOSAdapterError("INVALID_COMPOSE", "ZimaOS Compose response is invalid");
    }
    if (!text.trim()) {
      throw new ZimaOSAdapterError("INVALID_COMPOSE", "ZimaOS Compose response is empty");
    }

    return {
      yaml: text,
      authority: "non-authoritative",
      reason: "SOURCE_CANNOT_PROVE_COMPLETENESS",
    };
  }
}
