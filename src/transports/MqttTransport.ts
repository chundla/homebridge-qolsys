import { Logger } from 'homebridge';
import mqtt, { IClientOptions, MqttClient } from 'mqtt';
import { QolsysController } from '../QolsysController.js';
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

export class MqttTransport implements QolsysTransport {
  public readonly mode = 'mqtt' as const;
  public readonly controller: QolsysController;
  private client?: MqttClient;

  constructor(
    private readonly log: Logger,
    private readonly config: QolsysTransportConfig,
  ) {
    this.controller = new QolsysController(config.host, config.port);
    this.controller.SecureToken = config.secureToken ?? '';
    this.controller.UserPinCode = config.userPinCode ?? '';
  }

  connect(): void {
    if (!this.config.mqttUrl) {
      this.log.error('TransportMode=mqtt selected but MqttUrl is not configured.');
      return;
    }

    const options: IClientOptions = {
      username: this.config.mqttUsername,
      password: this.config.mqttPassword,
      clientId: this.config.mqttClientId,
      reconnectPeriod: 5000,
    };

    this.client = mqtt.connect(this.config.mqttUrl, options);

    this.client.on('connect', () => {
      this.log.info('Connected to MQTT broker at ' + this.config.mqttUrl);
      const stateTopic = this.config.mqttStateTopic ?? 'qolsys/state';
      this.client?.subscribe(stateTopic, (error) => {
        if (error) {
          this.log.error('Failed subscribing to MQTT state topic: ' + error.message);
          return;
        }
        this.log.info('Subscribed to MQTT state topic: ' + stateTopic);
      });
    });

    this.client.on('message', (topic, payload) => {
      const stateTopic = this.config.mqttStateTopic ?? 'qolsys/state';
      if (topic !== stateTopic) {
        return;
      }

      try {
        const raw = JSON.parse(payload.toString());
        const snapshot = this.normalizeStatePayload(raw);
        if (!snapshot) {
          this.log.debug('Ignoring invalid MQTT state payload.');
          return;
        }
        this.controller.ApplyBridgeSnapshot(snapshot);
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown error';
        this.log.warn('Failed to parse MQTT state payload: ' + message);
      }
    });

    this.client.on('error', (error) => {
      this.log.warn('MQTT transport error: ' + error.message);
    });

    this.client.on('close', () => {
      this.log.warn('MQTT broker connection closed.');
    });
  }

  disconnect(): void {
    this.client?.end(true);
    this.client = undefined;
  }

  async sendArmCommand(command: QolsysArmCommand): Promise<void> {
    await this.publishCommand({
      type: 'arm',
      armingType: command.armingType,
      partitionId: command.partitionId,
      delay: command.delay,
      bypass: command.bypass,
      userCode: command.userCode ?? this.config.userPinCode ?? '',
    });
  }

  async sendAutomationCommand(command: QolsysAutomationCommand): Promise<void> {
    if (this.config.mqttCommandTopic) {
      this.log.info(`MQTT publish -> ${this.config.mqttCommandTopic}`);
    }
    await this.publishCommand({
      type: 'automation',
      deviceType: command.type,
      action: command.action,
      virtualNodeId: command.virtualNodeId,
      endpoint: command.endpoint,
      value: command.value,
      mode: command.mode,
      fanMode: command.fanMode,
    });
  }

  private publishCommand(payload: Record<string, unknown>): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const client = this.client;
      if (!client || !client.connected) {
        reject(new Error('MQTT client is not connected'));
        return;
      }

      const commandTopic = this.config.mqttCommandTopic ?? 'qolsys/command';
      client.publish(commandTopic, JSON.stringify(payload), { qos: 1 }, (error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    }).catch((error: Error) => {
      this.log.warn('Failed to publish MQTT command: ' + error.message);
    });
  }

  private normalizeStatePayload(payload: unknown): BridgeStateSnapshot | undefined {
    if (typeof payload !== 'object' || payload === null) {
      return undefined;
    }

    const root = payload as Record<string, unknown>;
    const stateRoot = (typeof root.state === 'object' && root.state !== null)
      ? root.state as Record<string, unknown>
      : root;

    const rawPartitions = stateRoot.partitions;
    const rawZones = stateRoot.zones;
    const rawAutomationDevices = stateRoot.automationDevices ?? stateRoot.automation_devices;

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
