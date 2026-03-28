import { Service, CharacteristicValue } from 'homebridge';
import { HKAccessory } from './HKAccessory.js';
import { BridgeAutomationDeviceSnapshot, BridgeAutomationServiceSnapshot } from './transports/bridgeTypes.js';
import { HBQolsysPanel } from './platform.js';

export class HKAutomationLock extends HKAccessory {
  private service: Service;
  private readonly virtualNodeId: number;
  private readonly endpoint: number;

  constructor(
    protected readonly platform: HBQolsysPanel,
    device: BridgeAutomationDeviceSnapshot,
    service: BridgeAutomationServiceSnapshot,
  ) {
    super(platform, `Lock - ${device.name}`, `QolsysAutomationLock-${device.virtualNodeId}-${service.endpoint}`);

    this.virtualNodeId = device.virtualNodeId;
    this.endpoint = service.endpoint ?? 0;

    this.Accessory.getService(this.platform.Service.AccessoryInformation)!
      .setCharacteristic(this.platform.Characteristic.Model, 'Qolsys Lock')
      .setCharacteristic(this.platform.Characteristic.SerialNumber, `AutDev${device.virtualNodeId}:${this.endpoint}`);

    this.service = this.AddService(this.platform.Service.LockMechanism, `Lock - ${device.name}`, `Lock-${device.virtualNodeId}-${this.endpoint}`);

    this.service.getCharacteristic(this.platform.Characteristic.LockTargetState)
      .onSet(this.handleSetTargetState.bind(this));

    this.UpdateFromService(service);
  }

  UpdateFromService(service: BridgeAutomationServiceSnapshot): void {
    const isLocked = Boolean(service.isLocked);
    const isJammed = Boolean(service.isJammed);
    const currentState = isJammed
      ? this.platform.Characteristic.LockCurrentState.JAMMED
      : isLocked
        ? this.platform.Characteristic.LockCurrentState.SECURED
        : this.platform.Characteristic.LockCurrentState.UNSECURED;

    this.service.updateCharacteristic(this.platform.Characteristic.LockCurrentState, currentState);
    this.service.updateCharacteristic(
      this.platform.Characteristic.LockTargetState,
      isLocked ? this.platform.Characteristic.LockTargetState.SECURED : this.platform.Characteristic.LockTargetState.UNSECURED,
    );
  }

  private handleSetTargetState(value: CharacteristicValue): void {
    const target = typeof value === 'number' ? value : Number(value);
    const action = target === this.platform.Characteristic.LockTargetState.SECURED ? 'lock' : 'unlock';
    void this.platform.SendAutomationCommand({
      type: 'lock',
      action,
      virtualNodeId: this.virtualNodeId,
      endpoint: this.endpoint,
    });
  }
}
