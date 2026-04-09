export type QolsysTransportMode = 'c4' | 'mqtt' | 'pki';

import { BridgeStateSnapshot } from './bridgeTypes.js';
import { QolsysAlarmMode } from '../QolsysPartition.js';

export interface QolsysTransportConfig {
  host: string;
  port: number;
  secureToken?: string;
  userPinCode?: string;
  mqttUrl?: string;
  mqttUsername?: string;
  mqttPassword?: string;
  mqttClientId?: string;
  mqttCaPath?: string;
  mqttBootstrapCaPath?: string;
  mqttBridgeRootTopic?: string;
  bridgeEndpoint?: string;
  onBridgeSnapshot?: (snapshot: BridgeStateSnapshot) => void;
}

export interface QolsysArmCommand {
  armingType: QolsysAlarmMode;
  partitionId: number;
  delay: number;
  bypass: boolean;
  userCode?: string;
}

export type QolsysPanelCommandType = 'execute_scene' | 'trigger_police' | 'trigger_auxilliary' | 'trigger_fire' | 'speak';

export interface QolsysPanelCommand {
  command: QolsysPanelCommandType;
  partitionId?: number;
  sceneId?: number;
  silent?: boolean;
  text?: string;
}

export type QolsysAutomationCommandType = 'light' | 'lock' | 'cover' | 'siren' | 'valve' | 'thermostat';

export interface QolsysAutomationCommand {
  type: QolsysAutomationCommandType;
  action:
    | 'light_on'
    | 'light_off'
    | 'light_level'
    | 'lock'
    | 'unlock'
    | 'cover_open'
    | 'cover_close'
    | 'siren_on'
    | 'siren_off'
    | 'valve_open'
    | 'valve_close'
    | 'valve_stop'
    | 'valve_position'
    | 'thermostat_mode'
    | 'thermostat_fan_mode'
    | 'thermostat_heat'
    | 'thermostat_cool';
  virtualNodeId: number;
  endpoint: number;
  value?: number;
  mode?: string;
  fanMode?: string;
}

export interface QolsysTransport {
  readonly mode: QolsysTransportMode;
  connect(): void;
  disconnect(): void;
  sendArmCommand?: (command: QolsysArmCommand) => Promise<void>;
  sendAutomationCommand?: (command: QolsysAutomationCommand) => Promise<void>;
  sendPanelCommand?: (command: QolsysPanelCommand) => Promise<void>;
}
