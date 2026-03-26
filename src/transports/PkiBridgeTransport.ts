import { Logger } from 'homebridge';
import { QolsysTransport, QolsysTransportConfig } from './types';

export class PkiBridgeTransport implements QolsysTransport {
  public readonly mode = 'pki' as const;

  constructor(
    private readonly log: Logger,
    private readonly config: QolsysTransportConfig,
  ) {}

  connect(): void {
    this.log.warn('PKI bridge transport not implemented yet. Endpoint: ' + (this.config.bridgeEndpoint ?? 'unset'));
  }

  disconnect(): void {
    // no-op for scaffold
  }
}
