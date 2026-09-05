import type {
  ApplicationDeploymentView,
  ApplicationEnvironmentMetadataView,
  ApplicationFreshness,
  ApplicationNetworkView,
  ApplicationPortView,
  ApplicationRuntimeContainerView,
  ApplicationServiceView,
  ApplicationSummary,
  ApplicationVolumeView,
} from "@zima-control-center/core";

export interface ApplicationSummaryResponse {
  id: ApplicationSummary["id"];
  name: ApplicationSummary["name"];
  displayName: ApplicationSummary["displayName"];
  resourceType: ApplicationSummary["resourceType"];
  runtime: ApplicationSummary["runtime"];
  status: ApplicationSummary["status"];
  managedBy: ApplicationSummary["managedBy"];
  zimaosAppId: ApplicationSummary["zimaosAppId"];
  isUncontrolled: ApplicationSummary["isUncontrolled"];
  lastDiscoveredAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ApplicationDeploymentResponse {
  id: ApplicationDeploymentView["id"];
  composeName: ApplicationDeploymentView["composeName"];
  sourceContext: ApplicationDeploymentView["sourceContext"];
  dockerfilePath: ApplicationDeploymentView["dockerfilePath"];
  sourceHash: ApplicationDeploymentView["sourceHash"];
  discoveredAt: string;
}

export interface ApplicationPortResponse {
  published: ApplicationPortView["published"];
  target: ApplicationPortView["target"];
  protocol: ApplicationPortView["protocol"];
}

export interface ApplicationVolumeResponse {
  source: ApplicationVolumeView["source"];
  target: ApplicationVolumeView["target"];
}

export interface ApplicationNetworkResponse {
  name: ApplicationNetworkView["name"];
  isExternal: ApplicationNetworkView["isExternal"];
}

export interface ApplicationEnvironmentMetadataResponse {
  key: ApplicationEnvironmentMetadataView["key"];
  type: ApplicationEnvironmentMetadataView["type"];
  isSecret: ApplicationEnvironmentMetadataView["isSecret"];
  configured: ApplicationEnvironmentMetadataView["configured"];
  present: ApplicationEnvironmentMetadataView["present"];
  source: ApplicationEnvironmentMetadataView["source"];
}

export interface ApplicationServiceResponse {
  id: ApplicationServiceView["id"];
  name: ApplicationServiceView["name"];
  containerName: ApplicationServiceView["containerName"];
  image: ApplicationServiceView["image"];
  buildContext: ApplicationServiceView["buildContext"];
  ports: ApplicationPortResponse[];
  volumes: ApplicationVolumeResponse[];
  networks: ApplicationNetworkResponse[];
  environmentMetadata: ApplicationEnvironmentMetadataResponse[];
}

export interface ApplicationRuntimeContainerResponse {
  containerId: ApplicationRuntimeContainerView["containerId"];
  containerName: ApplicationRuntimeContainerView["containerName"];
  image: ApplicationRuntimeContainerView["image"];
  state: ApplicationRuntimeContainerView["state"];
  status: ApplicationRuntimeContainerView["status"];
  observedAt: string | null;
}

export type ApplicationFreshnessResponse = {
  [Key in keyof ApplicationFreshness]: string | null;
};

export interface ApplicationDetailResponse {
  application: ApplicationSummaryResponse;
  currentDeployment: ApplicationDeploymentResponse | null;
  services: ApplicationServiceResponse[];
  runtimeContainers: ApplicationRuntimeContainerResponse[];
  freshness: ApplicationFreshnessResponse;
}

export type ApiErrorCode =
  | "APPLICATION_NOT_FOUND"
  | "INVALID_REQUEST"
  | "INTERNAL_ERROR";

export interface ApiErrorResponse {
  error: {
    code: ApiErrorCode;
    message: string;
  };
}
