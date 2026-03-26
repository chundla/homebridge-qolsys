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

export interface BridgeStateSnapshot {
  partitions: BridgePartitionSnapshot[];
  zones: BridgeZoneSnapshot[];
}
