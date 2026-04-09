import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { Logger } from 'homebridge';
import http from 'http';
import https from 'https';
import mqtt, { IClientOptions, MqttClient } from 'mqtt';
import path from 'path';
import { URL } from 'url';
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

  private readonly bridgePartitions = new Map<number, BridgePartitionSnapshot>();
  private readonly bridgeZones = new Map<number, BridgeZoneSnapshot>();
  private readonly bridgeAutomationDevices = new Map<number, BridgeAutomationDeviceSnapshot>();
  private bridgeBaseTopic: string;
  private readonly localCaPath?: string;

  constructor(
    private readonly log: Logger,
    private readonly config: QolsysTransportConfig,
  ) {
    this.controller = new QolsysController(config.host, config.port);
    this.controller.SecureToken = config.secureToken ?? '';
    this.controller.UserPinCode = config.userPinCode ?? '';
    this.bridgeBaseTopic = config.mqttBridgeRootTopic?.trim() || 'qolsys';
    this.localCaPath = config.mqttBootstrapCaPath;
  }

  connect(): void {
    void this.connectAsync();
  }

  private async connectAsync(): Promise<void> {
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

    const caPath = await this.resolveCaPath();
    if (caPath) {
      options.ca = readFileSync(caPath);
      options.rejectUnauthorized = true;
    }

    this.client = mqtt.connect(this.config.mqttUrl, options);

    this.client.on('connect', () => {
      this.log.info('Connected to MQTT broker at ' + this.config.mqttUrl);

      const bridgeWildcard = `${this.bridgeBaseTopic}/v1/+/#`;
      this.client?.subscribe(bridgeWildcard, (error) => {
        if (error) {
          this.log.error('Failed subscribing to MQTT bridge topic: ' + error.message);
          return;
        }
        this.log.info('Subscribed to MQTT bridge topic: ' + bridgeWildcard);
      });
    });

    this.client.on('message', (topic, payload) => {
      try {
        const raw = JSON.parse(payload.toString());

        if (this.handleBridgeTopicMessage(topic, raw)) {
          this.controller.ApplyBridgeSnapshot(this.buildSnapshotFromBridgeCache());
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown error';
        this.log.warn('Failed to parse MQTT payload: ' + message);
      }
    });

    this.client.on('error', (error) => {
      this.log.warn('MQTT transport error: ' + error.message);
    });

    this.client.on('close', () => {
      this.log.warn('MQTT broker connection closed.');
    });
  }

  private async resolveCaPath(): Promise<string | undefined> {
    const configuredPath = this.config.mqttCaPath?.trim();
    if (configuredPath && existsSync(configuredPath)) {
      return configuredPath;
    }

    const bootstrapPath = this.localCaPath ?? path.resolve(process.cwd(), 'qolsys-ca', 'mqtt_bridge_ca.cer');
    if (existsSync(bootstrapPath)) {
      return bootstrapPath;
    }

    const endpoint = this.config.bridgeEndpoint ?? 'http://127.0.0.1:9123';
    const ca = await this.fetchBootstrapCa(endpoint);
    if (!ca) {
      return undefined;
    }

    mkdirSync(path.dirname(bootstrapPath), { recursive: true });
    writeFileSync(bootstrapPath, ca);
    return bootstrapPath;
  }

  private async fetchBootstrapCa(endpoint: string): Promise<Buffer | undefined> {
    const caUrl = new URL('/mqtt-bridge/ca', endpoint);
    const client = caUrl.protocol === 'https:' ? https : http;

    return await new Promise((resolve) => {
      const req = client.get(caUrl, (res) => {
        if ((res.statusCode ?? 0) !== 200) {
          res.resume();
          resolve(undefined);
          return;
        }

        const chunks: Buffer[] = [];
        res.on('data', (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
        res.on('end', () => resolve(Buffer.concat(chunks)));
      });

      req.setTimeout(3000, () => {
        req.destroy(new Error('Request timeout'));
      });

      req.on('error', () => resolve(undefined));
    });
  }

  disconnect(): void {
    this.client?.end(true);
    this.client = undefined;
  }

  async sendArmCommand(command: QolsysArmCommand): Promise<void> {
    await this.publishBridgeCommand(`${this.bridgeBaseTopic}/partition/${command.partitionId}/command`, {
      command: command.armingType,
      partition_id: command.partitionId,
      user_code: command.userCode ?? this.config.userPinCode ?? '',
      exit_delay: command.delay > 0,
      exit_sounds: true,
      instant_arm: command.delay <= 0,
      silent_disarm: false,
    });
  }

  async sendAutomationCommand(command: QolsysAutomationCommand): Promise<void> {
    const mapped = this.toBridgeAutomationCommand(command);
    if (!mapped) {
      this.log.warn('Unsupported automation command for MQTT bridge: ' + command.action);
      return;
    }

    await this.publishBridgeCommand(
      `${this.bridgeBaseTopic}/automation/${command.virtualNodeId}/command`,
      {
        command: mapped.command,
        virtual_node_id: command.virtualNodeId,
        endpoint: command.endpoint,
        ...mapped.extra,
      },
    );
  }

  async sendPanelCommand(command: import('./types.js').QolsysPanelCommand): Promise<void> {
    await this.publishBridgeCommand(`${this.bridgeBaseTopic}/panel/command`, {
      command: command.command,
      partition_id: command.partitionId,
      scene_id: command.sceneId,
      silent: command.silent,
      text: command.text,
    });
  }

  private publishBridgeCommand(topic: string, payload: Record<string, unknown>): Promise<void> {
    return this.publish(topic, payload);
  }

  private publish(topic: string, payload: Record<string, unknown>): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const client = this.client;
      if (!client || !client.connected) {
        reject(new Error('MQTT client is not connected'));
        return;
      }

      client.publish(topic, JSON.stringify(payload), { qos: 1 }, (error) => {
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

  private applySnapshot(snapshot: BridgeStateSnapshot): void {
    this.bridgePartitions.clear();
    this.bridgeZones.clear();
    this.bridgeAutomationDevices.clear();

    for (const partition of snapshot.partitions) {
      this.bridgePartitions.set(partition.id, partition);
    }
    for (const zone of snapshot.zones) {
      this.bridgeZones.set(zone.id, zone);
    }
    for (const device of snapshot.automationDevices ?? []) {
      this.bridgeAutomationDevices.set(device.virtualNodeId, device);
    }

    this.controller.ApplyBridgeSnapshot(snapshot);
  }

  private handleBridgeTopicMessage(topic: string, payload: unknown): boolean {
    const parsed = this.parseBridgeTopic(topic);
    if (!parsed) {
      return false;
    }

    this.bridgeBaseTopic = parsed.baseTopic;

    if (parsed.kind === 'partition') {
      const normalized = this.normalizeBridgePartitionPayload(payload, parsed.entityId);
      if (!normalized) {
        return false;
      }
      this.bridgePartitions.set(normalized.id, normalized);
      return true;
    }

    if (parsed.kind === 'zone') {
      const normalized = this.normalizeBridgeZonePayload(payload, parsed.entityId);
      if (!normalized) {
        return false;
      }
      this.bridgeZones.set(normalized.id, normalized);
      return true;
    }

    if (parsed.kind === 'automation') {
      const normalized = this.normalizeBridgeAutomationPayload(payload, parsed.entityId);
      if (!normalized) {
        return false;
      }
      this.bridgeAutomationDevices.set(normalized.virtualNodeId, normalized);
      return true;
    }

    return false;
  }

  private buildSnapshotFromBridgeCache(): BridgeStateSnapshot {
    return {
      partitions: Array.from(this.bridgePartitions.values()),
      zones: Array.from(this.bridgeZones.values()),
      automationDevices: Array.from(this.bridgeAutomationDevices.values()),
    };
  }

  private parseBridgeTopic(topic: string):
    | { baseTopic: string; kind: 'partition' | 'zone' | 'automation'; entityId?: number }
    | undefined {
    const parts = topic.split('/').filter((item) => item.length > 0);
    const versionIndex = parts.indexOf('v1');
    if (versionIndex < 1 || versionIndex + 3 >= parts.length) {
      return undefined;
    }

    const domain = parts[versionIndex + 2];
    const maybeId = this.coerceNumber(parts[versionIndex + 3]);
    const baseTopic = parts.slice(0, versionIndex + 2).join('/');

    if (domain === 'partition') {
      return { baseTopic, kind: 'partition', entityId: maybeId };
    }

    if (domain === 'zone') {
      return { baseTopic, kind: 'zone', entityId: maybeId };
    }

    if (domain === 'automation') {
      return { baseTopic, kind: 'automation', entityId: maybeId };
    }

    return undefined;
  }

  private normalizeBridgePartitionPayload(payload: unknown, topicId?: number): BridgePartitionSnapshot | undefined {
    if (typeof payload !== 'object' || payload === null) {
      return undefined;
    }

    const root = payload as Record<string, unknown>;
    const state = this.coerceRecord(root.state);
    const attributes = this.coerceRecord(root.attributes);

    const id = this.coerceNumber(root.id) ?? topicId;
    const name = this.coerceString(attributes?.name) ?? `Partition ${id ?? ''}`.trim();
    const statusRaw = this.coerceString(state?.status);
    const previous = id !== undefined ? this.bridgePartitions.get(id) : undefined;

    if (id === undefined || !statusRaw) {
      return undefined;
    }

    return {
      id,
      name,
      status: statusRaw.replace(/-/g, '_'),
      secureArm: previous?.secureArm ?? false,
    };
  }

  private normalizeBridgeZonePayload(payload: unknown, topicId?: number): BridgeZoneSnapshot | undefined {
    if (typeof payload !== 'object' || payload === null) {
      return undefined;
    }

    const root = payload as Record<string, unknown>;
    const state = this.coerceRecord(root.state);
    const attributes = this.coerceRecord(root.attributes);

    const id = this.coerceNumber(root.id) ?? topicId;
    const partitionId = this.coerceNumber(attributes?.partition_id);
    const name = this.coerceString(attributes?.name);
    const status = this.mapBridgeZoneStatus(this.coerceString(state?.status));
    const type = this.mapBridgeZoneType(
      this.coerceString(attributes?.group),
      this.coerceString(attributes?.device_type),
    );

    if (id === undefined || partitionId === undefined || !name || !status || !type) {
      return undefined;
    }

    return {
      id,
      partitionId,
      name,
      type,
      status,
    };
  }

  private normalizeBridgeAutomationPayload(payload: unknown, topicId?: number): BridgeAutomationDeviceSnapshot | undefined {
    if (typeof payload !== 'object' || payload === null) {
      return undefined;
    }

    const root = payload as Record<string, unknown>;
    const attributes = this.coerceRecord(root.attributes);
    const state = this.coerceRecord(root.state);

    const virtualNodeId = this.coerceNumber(root.id) ?? topicId;
    const name = this.coerceString(attributes?.name);
    const deviceType = this.coerceString(attributes?.type);
    const protocol = this.coerceString(attributes?.protocol);
    const rawServices = state?.services;

    if (virtualNodeId === undefined || !name || !deviceType || !protocol || !Array.isArray(rawServices)) {
      return undefined;
    }

    const services: BridgeAutomationServiceSnapshot[] = [];
    for (const item of rawServices) {
      const normalized = this.normalizeBridgeAutomationServicePayload(item);
      if (normalized) {
        services.push(normalized);
      }
    }

    return {
      virtualNodeId,
      name,
      deviceType,
      protocol,
      partitionId: 0,
      services,
    };
  }

  private normalizeBridgeAutomationServicePayload(payload: unknown): BridgeAutomationServiceSnapshot | undefined {
    if (typeof payload !== 'object' || payload === null) {
      return undefined;
    }

    const root = payload as Record<string, unknown>;
    const state = this.coerceRecord(root.state) ?? {};
    const attributes = this.coerceRecord(root.attributes) ?? {};
    const capabilities = this.coerceRecord(root.capabilities) ?? {};

    const rawType = this.coerceString(root.type);
    const type = this.mapBridgeAutomationServiceType(rawType);
    if (!type) {
      return undefined;
    }

    const endpoint = this.coerceNumber(attributes.endpoint ?? root.endpoint ?? 0) ?? 0;

    const hvacModeRaw = this.coerceString(state.hvac_mode);
    const hvacActionRaw = this.coerceString(state.hvac_action);
    const fanModeRaw = this.coerceString(state.fan_mode);

    return {
      type,
      endpoint,
      isOn: this.coerceBoolean(state.is_on),
      level: this.coerceNumber(state.level),
      supportsLevel: this.coerceBoolean(capabilities.supports_level),
      isLocked: this.coerceBoolean(state.is_locked),
      isJammed: this.coerceBoolean(state.is_jammed),
      isLocking: this.coerceBoolean(state.is_locking),
      isUnlocking: this.coerceBoolean(state.is_unlocking),
      isClosed: this.coerceBoolean(state.is_closed),
      isOpening: this.coerceBoolean(state.is_opening),
      isClosing: this.coerceBoolean(state.is_closing),
      currentPosition: this.coerceNumber(state.current_position),
      supportsPosition: this.coerceBoolean(capabilities.supports_position),
      hvacMode: hvacModeRaw ? hvacModeRaw.toLowerCase() : undefined,
      hvacModes: this.coerceStringArray(attributes.hvac_modes)?.map((mode) => mode.toLowerCase()),
      hvacAction: hvacActionRaw ? hvacActionRaw.toLowerCase() : undefined,
      fanMode: fanModeRaw ? fanModeRaw.toLowerCase().replace(/^fan_/, '') : undefined,
      fanModes: this.coerceStringArray(attributes.fan_modes)
        ?.map((mode) => mode.toLowerCase().replace(/^fan_/, '')),
      currentTemperature: this.coerceNumber(state.current_temperature),
      currentHumidity: this.coerceNumber(state.current_humidity),
      targetHeatTemp: this.coerceNumber(state.target_heat_temp),
      targetCoolTemp: this.coerceNumber(state.target_cool_temp),
      targetTemperatureStep: this.coerceNumber(state.target_temperature_step),
      temperatureUnit: this.mapTemperatureUnit(this.coerceString(attributes.device_temperature_unit)),
    };
  }

  private toBridgeAutomationCommand(command: QolsysAutomationCommand):
    | { command: string; extra?: Record<string, unknown> }
    | undefined {
    switch (command.action) {
      case 'light_on':
      case 'light_off':
      case 'lock':
      case 'unlock':
      case 'cover_open':
      case 'cover_close':
      case 'siren_on':
      case 'siren_off':
      case 'valve_open':
      case 'valve_close':
      case 'valve_stop':
        return { command: command.action };

      case 'valve_position':
        return { command: 'valve_position', extra: { position: command.value } };

      case 'light_level':
        return { command: 'light_level', extra: { level: command.value } };

      case 'thermostat_mode':
        return {
          command: 'thermostat_mode',
          extra: { mode: this.toBridgeHvacMode(command.mode) },
        };

      case 'thermostat_fan_mode':
        return {
          command: 'thermostat_fan_mode',
          extra: { fan_mode: this.toBridgeFanMode(command.fanMode) },
        };

      case 'thermostat_heat':
      case 'thermostat_cool':
        return {
          command: command.action,
          extra: { temperature: command.value },
        };

      default:
        return undefined;
    }
  }

  private toBridgeHvacMode(value?: string): string | undefined {
    if (!value) {
      return undefined;
    }

    const normalized = value.trim().toLowerCase();
    switch (normalized) {
      case 'off':
        return 'OFF';
      case 'heat':
        return 'HEAT';
      case 'cool':
        return 'COOL';
      case 'auto':
        return 'AUTO';
      case 'heat_cool':
      case 'heat-cool':
        return 'HEAT_COOL';
      case 'fan_only':
      case 'fan-only':
        return 'FAN_ONLY';
      case 'dry':
        return 'DRY';
      default:
        return value.toUpperCase();
    }
  }

  private toBridgeFanMode(value?: string): string | undefined {
    if (!value) {
      return undefined;
    }

    const normalized = value.trim().toLowerCase();
    switch (normalized) {
      case 'on':
        return 'FAN_ON';
      case 'off':
        return 'FAN_OFF';
      case 'auto':
        return 'FAN_AUTO';
      case 'low':
        return 'FAN_LOW';
      case 'medium':
        return 'FAN_MEDIUM';
      case 'high':
        return 'FAN_HIGH';
      case 'circulate':
        return 'FAN_CIRCULATE';
      default:
        return value.toUpperCase();
    }
  }

  private mapBridgeAutomationServiceType(type?: string): BridgeAutomationServiceSnapshot['type'] | undefined {
    if (!type) {
      return undefined;
    }

    switch (type.toLowerCase()) {
      case 'light':
      case 'lightservice':
        return 'light';
      case 'lock':
      case 'lockservice':
        return 'lock';
      case 'cover':
      case 'coverservice':
        return 'cover';
      case 'siren':
      case 'sirenservice':
        return 'siren';
      case 'valve':
      case 'valveservice':
        return 'valve';
      case 'thermostat':
      case 'thermostatservice':
        return 'thermostat';
      default:
        return undefined;
    }
  }

  private mapBridgeZoneStatus(status?: string): string | undefined {
    if (!status) {
      return undefined;
    }

    const normalized = status.trim().toUpperCase();
    if (['OPEN', 'ACTIVE', 'ACTIVATED', 'DETECTED'].includes(normalized)) {
      return 'Open';
    }

    if (['CLOSED', 'IDLE', 'INACTIVE', 'RESTORED', 'NOT_DETECTED'].includes(normalized)) {
      return 'Closed';
    }

    return status;
  }

  private mapBridgeZoneType(group?: string, deviceType?: string): string | undefined {
    const raw = (group ?? deviceType ?? '').trim();
    const normalized = raw.toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/_+/g, '_');

    switch (normalized) {
      case 'DOOR_WINDOW':
      case 'DOOR_WINDOW_M':
      case 'INTRUSION':
      case 'ENTRYEXIT':
      case 'ENTRY_EXIT_NORMAL_DELAY':
      case 'ENTRY_EXIT_LONG_DELAY':
      case 'PERIMETER':
      case 'INSTANT_PERIMETER_DW':
      case 'INSTANT_INTERIOR_DOOR':
      case 'AWAY_INSTANT_FOLLOWER_DELAY':
      case 'DOOR':
      case 'WINDOW':
      case 'CONTACT':
        return 'Door_Window';

      case 'MOTION':
      case 'OCCUPANCY':
      case 'FOLLOWER':
      case 'MOTION_SENSOR':
      case 'PANEL_MOTION_SENSOR':
      case 'AWAY_INSTANT_MOTION':
      case 'STAY_INSTANT_MOTION':
      case 'STAY_DELAY_MOTION':
      case 'AWAY_DELAY_MOTION':
        return 'Motion';

      case 'PANEL_MOTION':
      case 'SAFETY_MOTION':
        return 'Panel Motion';

      case 'GLASS_BREAK':
        return 'GlassBreak';

      case 'PANEL_GLASS_BREAK':
        return 'Panel Glass Break';

      case 'SMOKE_DETECTOR':
      case 'SMOKE_M':
        return 'SmokeDetector';

      case 'CO_DETECTOR':
      case 'CARBON_MONOXIDE':
      case 'CO':
        return 'CODetector';

      case 'WATER':
      case 'WATER_NON_REPORTING':
      case 'FLOOD':
        return 'Water';

      case 'FREEZE':
      case 'FREEZE_NON_REPORTING':
        return 'Freeze';

      case 'HEAT':
      case 'HIGH_TEMPERATURE':
        return 'Heat';

      case 'DOORBELL':
        return 'Doorbell';

      default:
        return undefined;
    }
  }

  private mapTemperatureUnit(value?: string): string | undefined {
    if (!value) {
      return undefined;
    }

    const normalized = value.trim().toUpperCase();
    if (normalized === 'FAHRENHEIT' || normalized === 'F') {
      return 'F';
    }

    if (normalized === 'CELSIUS' || normalized === 'C') {
      return 'C';
    }

    return value;
  }

  private coerceRecord(value: unknown): Record<string, unknown> | undefined {
    if (typeof value !== 'object' || value === null) {
      return undefined;
    }

    return value as Record<string, unknown>;
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
