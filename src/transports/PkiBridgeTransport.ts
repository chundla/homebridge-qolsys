import { Logger } from 'homebridge';
import http from 'http';
import https from 'https';
import { URL } from 'url';
import {
  BridgeAutomationDeviceSnapshot,
  BridgeAutomationServiceSnapshot,
  BridgePartitionSnapshot,
  BridgeStateSnapshot,
  BridgeZoneSnapshot,
} from './bridgeTypes.js';
import {
  QolsysArmCommand,
  QolsysAutomationCommand,
  QolsysTransport,
  QolsysTransportConfig,
} from './types.js';

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

  async sendArmCommand(command: QolsysArmCommand): Promise<void> {
    const endpoint = this.config.bridgeEndpoint;

    if (!endpoint) {
      this.log.error('PKI bridge selected but BridgeEndpoint is not configured.');
      return;
    }

    const payload = {
      type: 'arm',
      armingType: command.armingType,
      partitionId: command.partitionId,
      delay: command.delay,
      bypass: command.bypass,
      userCode: command.userCode ?? this.config.userPinCode ?? '',
    };

    try {
      await this.httpPostJson(new URL('/command', endpoint).toString(), payload, 5000);
      this.log.debug(
        `PKI bridge arm command sent: ${command.armingType} partition ${command.partitionId}`,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      this.log.warn('PKI bridge arm command failed: ' + message);
    }
  }

  async sendAutomationCommand(command: QolsysAutomationCommand): Promise<void> {
    const endpoint = this.config.bridgeEndpoint;

    if (!endpoint) {
      this.log.error('PKI bridge selected but BridgeEndpoint is not configured.');
      return;
    }

    const payload = {
      type: 'automation',
      deviceType: command.type,
      action: command.action,
      virtualNodeId: command.virtualNodeId,
      endpoint: command.endpoint,
      value: command.value,
      mode: command.mode,
      fanMode: command.fanMode,
    };

    try {
      await this.httpPostJson(new URL('/command', endpoint).toString(), payload, 5000);
      this.log.debug(
        `PKI bridge automation command sent: ${command.action} node ${command.virtualNodeId}`,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      this.log.warn('PKI bridge automation command failed: ' + message);
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

  private httpPostJson(urlString: string, body: Record<string, unknown>, timeoutMs: number): Promise<void> {
    return new Promise((resolve, reject) => {
      let url: URL;

      try {
        url = new URL(urlString);
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Invalid URL';
        reject(new Error(message));
        return;
      }

      const payload = JSON.stringify(body);
      const client = url.protocol === 'https:' ? https : http;

      const request = client.request(
        url,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(payload),
          },
        },
        (response) => {
          const statusCode = response.statusCode ?? 0;
          if (statusCode < 200 || statusCode >= 300) {
            response.resume();
            reject(new Error('HTTP ' + statusCode));
            return;
          }
          response.resume();
          resolve();
        },
      );

      request.setTimeout(timeoutMs, () => {
        request.destroy(new Error('Request timeout'));
      });

      request.on('error', (error: Error) => reject(error));
      request.write(payload);
      request.end();
    });
  }

  private normalizeStatePayload(payload: unknown): BridgeStateSnapshot | undefined {
    if (typeof payload !== 'object' || payload === null) {
      return undefined;
    }

    const root = payload as Record<string, unknown>;
    const rawPartitions = root.partitions;
    const rawZones = root.zones;
    const rawAutomationDevices = root.automationDevices ?? root.automation_devices;

    if (!Array.isArray(rawPartitions) || !Array.isArray(rawZones)) {
      return undefined;
    }

    const partitions: BridgePartitionSnapshot[] = [];
    const zones: BridgeZoneSnapshot[] = [];
    const automationDevices: BridgeAutomationDeviceSnapshot[] = [];

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

    if (Array.isArray(rawAutomationDevices)) {
      for (const item of rawAutomationDevices) {
        if (typeof item !== 'object' || item === null) {
          continue;
        }

        const device = item as Record<string, unknown>;
        const virtualNodeId = this.coerceNumber(device.virtualNodeId ?? device.virtual_node_id);
        const name = this.coerceString(device.name);
        const deviceType = this.coerceString(device.deviceType ?? device.device_type);
        const protocol = this.coerceString(device.protocol);
        const partitionId = this.coerceNumber(device.partitionId ?? device.partition_id ?? 0) ?? 0;
        const rawServices = device.services;

        if (virtualNodeId === undefined || name === undefined || deviceType === undefined || protocol === undefined || !Array.isArray(rawServices)) {
          continue;
        }

        const services: BridgeAutomationServiceSnapshot[] = [];
        for (const serviceItem of rawServices) {
          if (typeof serviceItem !== 'object' || serviceItem === null) {
            continue;
          }

          const service = serviceItem as Record<string, unknown>;
          const type = this.coerceString(service.type);
          const endpoint = this.coerceNumber(service.endpoint ?? 0) ?? 0;
          if (!type) {
            continue;
          }

          services.push({
            type: type as BridgeAutomationServiceSnapshot['type'],
            endpoint,
            isOn: this.coerceBoolean(service.isOn ?? service.is_on),
            level: this.coerceNumber(service.level),
            supportsLevel: this.coerceBoolean(service.supportsLevel ?? service.supports_level),
            isLocked: this.coerceBoolean(service.isLocked ?? service.is_locked),
            isJammed: this.coerceBoolean(service.isJammed ?? service.is_jammed),
            isLocking: this.coerceBoolean(service.isLocking ?? service.is_locking),
            isUnlocking: this.coerceBoolean(service.isUnlocking ?? service.is_unlocking),
            isClosed: this.coerceBoolean(service.isClosed ?? service.is_closed),
            isOpening: this.coerceBoolean(service.isOpening ?? service.is_opening),
            isClosing: this.coerceBoolean(service.isClosing ?? service.is_closing),
            currentPosition: this.coerceNumber(service.currentPosition ?? service.current_position),
            supportsPosition: this.coerceBoolean(service.supportsPosition ?? service.supports_position),
            hvacMode: this.coerceString(service.hvacMode ?? service.hvac_mode),
            hvacModes: this.coerceStringArray(service.hvacModes ?? service.hvac_modes),
            hvacAction: this.coerceString(service.hvacAction ?? service.hvac_action),
            fanMode: this.coerceString(service.fanMode ?? service.fan_mode),
            fanModes: this.coerceStringArray(service.fanModes ?? service.fan_modes),
            currentTemperature: this.coerceNumber(service.currentTemperature ?? service.current_temperature),
            currentHumidity: this.coerceNumber(service.currentHumidity ?? service.current_humidity),
            targetHeatTemp: this.coerceNumber(service.targetHeatTemp ?? service.target_heat_temp),
            targetCoolTemp: this.coerceNumber(service.targetCoolTemp ?? service.target_cool_temp),
            targetTemperatureStep: this.coerceNumber(service.targetTemperatureStep ?? service.target_temperature_step),
            temperatureUnit: this.coerceString(service.temperatureUnit ?? service.temperature_unit),
          });
        }

        automationDevices.push({
          virtualNodeId,
          name,
          deviceType,
          protocol,
          partitionId,
          services,
        });
      }
    }

    return { partitions, zones, automationDevices };
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

  private coerceBoolean(value: unknown): boolean | undefined {
    if (typeof value === 'boolean') {
      return value;
    }

    if (typeof value === 'string') {
      if (value.toLowerCase() === 'true') {
        return true;
      }
      if (value.toLowerCase() === 'false') {
        return false;
      }
    }

    return undefined;
  }

  private coerceStringArray(value: unknown): string[] | undefined {
    if (!Array.isArray(value)) {
      return undefined;
    }

    const items = value
      .filter((item) => typeof item === 'string')
      .map((item) => item as string)
      .filter((item) => item.length > 0);

    return items.length > 0 ? items : undefined;
  }
}
