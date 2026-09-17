export interface NativePeerCredentials {
  readonly pid: number;
  readonly uid: number;
  readonly gid: number;
}

declare const listenerBrand: unique symbol;
declare const connectionBrand: unique symbol;
export interface NativeAuthorityListener { readonly [listenerBrand]: true }
export interface NativePeerConnection { readonly [connectionBrand]: true }

export interface AuthorityNativeBinding {
  createAuthorityListener(): Promise<NativeAuthorityListener>;
  acceptAuthorityConnection(listener: NativeAuthorityListener): Promise<NativePeerConnection>;
  getPeerCredentials(connection: NativePeerConnection): NativePeerCredentials;
  readRuntimeFrame(connection: NativePeerConnection): Promise<Uint8Array>;
  writeRuntimeFrame(connection: NativePeerConnection, payload: Uint8Array): Promise<void>;
  closeRuntimeConnection(connection: NativePeerConnection): void;
  closeAuthorityListener(listener: NativeAuthorityListener): void;
}

export interface IssuerNativeBinding {
  connectAuthority(): Promise<NativePeerConnection>;
  getPeerCredentials(connection: NativePeerConnection): NativePeerCredentials;
  readRuntimeFrame(connection: NativePeerConnection): Promise<Uint8Array>;
  writeRuntimeFrame(connection: NativePeerConnection, payload: Uint8Array): Promise<void>;
  closeRuntimeConnection(connection: NativePeerConnection): void;
}
