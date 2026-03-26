import { Logger } from 'homebridge';
import http from 'http';
import https from 'https';
import { URL } from 'url';
import { BridgePartitionSnapshot, BridgeStateSnapshot, BridgeZoneSnapshot } from './bridgeTypes';
import { QolsysTransport, QolsysTransportConfig } from './types';

export class PkiBridgeTransport implements QolsysTransport {
  public readonly mode = 'pki' as const;
  private pollTimer?: NodeJS.Timeout;

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
    this.pollBridgeState(endpoint);
    this.pollTimer = setInterval(() => this.pollBridgeState(endpoint), 5000);
  }

  disconnect(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = undefined;
    }
  }

  private probeBridge(endpoint: string): void {
    this.httpGetJson(new URL('/health', endpoint).toString(), 2000)
      .then(() => {
        this.log.info('PKI bridge health check succeeded.');
      })
      .catch((error: Error) => {
        this.log.warn('PKI bridge health check failed: ' + error.message);
      });
  }

  private pollBridgeState(endpoint: string): void {
    const stateUrl = new URL('/state', endpoint).toString();

    this.httpGetJson(stateUrl, 3000)
      .then((payload: unknown) => {
        const snapshot = this.normalizeStatePayload(payload);

        if (snapshot !== undefined && this.config.onBridgeSnapshot !== undefined) {
          this.config.onBridgeSnapshot(snapshot);
        }
      })
      .catch((error: Error) => {
        this.log.debug('PKI bridge state poll failed: ' + error.message);
      });
  }

  private httpGetJson(urlString: string, timeoutMs: number): Promise<unknown> {
    return new Promise((resolve, reject) => {
      let url: URL;

      try {
        url = new URL(urlString);
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Invalid URL';
        reject(new Error(message));
        return;
      }

      const client = url.protocol === 'https:' ? https : http;
      const request = client.get(url.toString(), (response) => {
        const statusCode = response.statusCode ?? 0;

        if (statusCode < 200 || statusCode >= 300) {
          response.resume();
          reject(new Error('HTTP ' + statusCode));
          return;
        }

        let raw = '';
        response.setEncoding('utf8');
        response.on('data', (chunk: string) => {
          raw += chunk;
        });
        response.on('end', () => {
          try {
            resolve(JSON.parse(raw));
          } catch (error) {
            const message = error instanceof Error ? error.message : 'Invalid JSON';
            reject(new Error(message));
          }
        });
      });

      request.setTimeout(timeoutMs, () => {
        request.destroy(new Error('Request timeout'));
      });

      request.on('error', (error: Error) => reject(error));
    });
  }

  private normalizeStatePayload(payload: unknown): BridgeStateSnapshot | undefined {
    if (typeof payload !== 'object' || payload === null) {
      return undefined;
    }

    const root = payload as Record<string, unknown>;
    const rawPartitions = root.partitions;
    const rawZones = root.zones;

    if (!Array.isArray(rawPartitions) || !Array.isArray(rawZones)) {
      return undefined;
    }

    const partitions: BridgePartitionSnapshot[] = [];
    const zones: BridgeZoneSnapshot[] = [];

    for (const item of rawPartitions) {
      if (typeof item !== 'object' || item === null) {
        continue;
      }

      const part = item as Record<string, unknown>;
      const id = this.coerceNumber(part.id);
      const name = this.coerceString(part.name);
      const status = this.coerceString(part.status);
      const secureArm = Boolean(part.secureArm ?? part.secure_arm ?? false);

      if (id === undefined || name === undefined || status === undefined) {
        continue;
      }

      partitions.push({ id, name, status, secureArm });
    }

    for (const item of rawZones) {
      if (typeof item !== 'object' || item === null) {
        continue;
      }

      const zone = item as Record<string, unknown>;
      const id = this.coerceNumber(zone.id);
      const partitionId = this.coerceNumber(zone.partitionId ?? zone.partition_id);
      const name = this.coerceString(zone.name);
      const type = this.coerceString(zone.type);
      const status = this.coerceString(zone.status);

      if (id === undefined || partitionId === undefined || name === undefined || type === undefined || status === undefined) {
        continue;
      }

      zones.push({ id, partitionId, name, type, status });
    }

    return { partitions, zones };
  }

  private coerceNumber(value: unknown): number | undefined {
    if (typeof value === 'number' && Number.isFinite(value)) {
      return value;
    }

    if (typeof value === 'string') {
      const parsed = Number(value);
      if (Number.isFinite(parsed)) {
        return parsed;
      }
    }

    return undefined;
  }

  private coerceString(value: unknown): string | undefined {
    if (typeof value === 'string' && value.length > 0) {
      return value;
    }

    return undefined;
  }
}
