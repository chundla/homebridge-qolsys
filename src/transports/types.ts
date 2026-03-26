export type QolsysTransportMode = 'c4' | 'pki';

import { BridgeStateSnapshot } from './bridgeTypes';

export interface QolsysTransportConfig {
  host: string;
  port: number;
  secureToken?: string;
  userPinCode?: string;
  bridgeEndpoint?: string;
  onBridgeSnapshot?: (snapshot: BridgeStateSnapshot) => void;
}

export interface QolsysTransport {
  readonly mode: QolsysTransportMode;
  connect(): void;
  disconnect(): void;
}
