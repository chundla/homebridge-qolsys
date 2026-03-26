import { Logger } from 'homebridge';
import http from 'http';
import https from 'https';
import { URL } from 'url';
import { QolsysTransport, QolsysTransportConfig } from './types';

export class PkiBridgeTransport implements QolsysTransport {
  public readonly mode = 'pki' as const;

  constructor(
    private readonly log: Logger,
    private readonly config: QolsysTransportConfig,
  ) {}

  connect(): void {
    const endpoint = this.config.bridgeEndpoint;

    if (!endpoint) {
      this.log.error('PKI bridge selected but BridgeEndpoint is not configured.');
      return;
    }

    this.log.warn('PKI bridge transport is experimental. Endpoint: ' + endpoint);
    this.probeBridge(endpoint);
  }

  disconnect(): void {
    // no-op for scaffold
  }

  private probeBridge(endpoint: string): void {
    try {
      const healthUrl = new URL('/health', endpoint).toString();
      const url = new URL(healthUrl);
      const client = url.protocol === 'https:' ? https : http;

      const request = client.get(healthUrl, (response) => {
        const statusCode = response.statusCode ?? 0;

        if (statusCode >= 200 && statusCode < 300) {
          this.log.info('PKI bridge health check succeeded (' + statusCode + ').');
        } else {
          this.log.warn('PKI bridge health check returned status ' + statusCode + '.');
        }

        response.resume();
      });

      request.setTimeout(2000, () => {
        this.log.warn('PKI bridge health check timed out.');
        request.destroy();
      });

      request.on('error', (error: Error) => {
        this.log.warn('PKI bridge health check failed: ' + error.message);
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      this.log.warn('Invalid BridgeEndpoint URL: ' + message);
    }
  }
}
