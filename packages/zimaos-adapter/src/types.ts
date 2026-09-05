export interface ZimaOSContainerDto {
  id: string;
  name: string;
  image: string;
  service_name: string;
  state: string;
  status: string;
  port_mappings: string[];
}

export interface ZimaOSApplicationDto {
  id?: string | null;
  name: string;
  title?: Record<string, string>;
  app_type?: string;
  author_type?: string;
  status?: string;
  install_status?: string;
  is_uncontrolled?: boolean;
  port?: string | null;
  scheme?: string | null;
  version?: string | null;
  containers: ZimaOSContainerDto[];
}

export interface ZimaOSInstalledListResponse {
  data: ZimaOSApplicationDto[];
}

export interface ZimaOSReadClient {
  getInstalledApplications(): Promise<ZimaOSApplicationDto[]>;
  getApplicationCompose(appName: string): Promise<ZimaOSComposeResult>;
}

export type ZimaOSComposeResult =
  | {
      yaml: string;
      authority: "authoritative";
    }
  | {
      yaml: string;
      authority: "non-authoritative";
      reason: "SOURCE_CANNOT_PROVE_COMPLETENESS";
    };
