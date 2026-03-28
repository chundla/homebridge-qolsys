export interface BridgeZoneSnapshot {
  id: number;
  partitionId: number;
  name: string;
  type: string;
  status: string;
}

export interface BridgePartitionSnapshot {
  id: number;
  name: string;
  secureArm: boolean;
  status: string;
}

export type BridgeAutomationServiceType = 'light' | 'lock' | 'cover' | 'siren' | 'valve' | 'thermostat';

export interface BridgeAutomationServiceSnapshot {
  type: BridgeAutomationServiceType;
  endpoint: number;
  isOn?: boolean;
  level?: number;
  supportsLevel?: boolean;
  isLocked?: boolean;
  isJammed?: boolean;
  isLocking?: boolean;
  isUnlocking?: boolean;
  isClosed?: boolean;
  isOpening?: boolean;
  isClosing?: boolean;
  currentPosition?: number;
  supportsPosition?: boolean;
  hvacMode?: string;
  hvacModes?: string[];
  hvacAction?: string;
  fanMode?: string;
  fanModes?: string[];
  currentTemperature?: number;
  currentHumidity?: number;
  targetHeatTemp?: number;
  targetCoolTemp?: number;
  targetTemperatureStep?: number;
  temperatureUnit?: string;
}

export interface BridgeAutomationDeviceSnapshot {
  virtualNodeId: number;
  name: string;
  deviceType: string;
  protocol: string;
  partitionId: number;
  services: BridgeAutomationServiceSnapshot[];
}

export interface BridgeStateSnapshot {
  partitions: BridgePartitionSnapshot[];
  zones: BridgeZoneSnapshot[];
  automationDevices?: BridgeAutomationDeviceSnapshot[];
}
