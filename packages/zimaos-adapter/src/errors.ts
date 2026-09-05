export type ZimaOSAdapterErrorCode =
  | "HTTP_ERROR"
  | "INVALID_INSTALLED_LIST"
  | "INVALID_COMPOSE";

export class ZimaOSAdapterError extends Error {
  public constructor(
    public readonly code: ZimaOSAdapterErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "ZimaOSAdapterError";
  }
}
