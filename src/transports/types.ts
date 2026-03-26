export type QolsysTransportMode = 'c4' | 'pki';

export interface QolsysTransportConfig {
  host: string;
  port: number;
  secureToken?: string;
  userPinCode?: string;
  bridgeEndpoint?: string;
}

export interface QolsysTransport {
  readonly mode: QolsysTransportMode;
  connect(): void;
  disconnect(): void;
}
