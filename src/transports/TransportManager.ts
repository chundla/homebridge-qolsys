import { Logger } from 'homebridge';
import { QolsysController } from '../QolsysController';
import { C4Transport } from './C4Transport';
import { PkiBridgeTransport } from './PkiBridgeTransport';
import { QolsysTransport, QolsysTransportConfig, QolsysTransportMode } from './types';

export class TransportManager {
  private readonly selectedMode: QolsysTransportMode;
  private readonly activeTransport: QolsysTransport;
  private readonly c4Transport: C4Transport;

  constructor(
    private readonly log: Logger,
    mode: QolsysTransportMode,
    config: QolsysTransportConfig,
  ) {
    this.selectedMode = mode;
    this.c4Transport = new C4Transport(config);

    if (mode === 'pki') {
      this.activeTransport = new PkiBridgeTransport(this.log, config);
      this.log.warn('TransportMode=pki selected, but PKI transport is not active yet. Falling back to c4 for runtime.');
      this.log.warn('Configured BridgeEndpoint: ' + (config.bridgeEndpoint ?? 'unset'));
    } else {
      this.activeTransport = this.c4Transport;
    }
  }

  get controller(): QolsysController {
    // Runtime remains c4 until PKI transport is fully implemented.
    return this.c4Transport.controller;
  }

  get mode(): QolsysTransportMode {
    return this.selectedMode;
  }

  connect(): void {
    if (this.selectedMode === 'pki') {
      this.activeTransport.connect();
    }

    this.c4Transport.connect();
  }

  disconnect(): void {
    this.activeTransport.disconnect();
    this.c4Transport.disconnect();
  }
}
