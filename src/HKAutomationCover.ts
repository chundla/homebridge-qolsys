import { Service, CharacteristicValue } from 'homebridge';
import { HKAccessory } from './HKAccessory.js';
import { BridgeAutomationDeviceSnapshot, BridgeAutomationServiceSnapshot } from './transports/bridgeTypes.js';
import { HBQolsysPanel } from './platform.js';

export class HKAutomationCover extends HKAccessory {
  private service: Service;
  private readonly virtualNodeId: number;
  private readonly endpoint: number;

  constructor(
    protected readonly platform: HBQolsysPanel,
    device: BridgeAutomationDeviceSnapshot,
    service: BridgeAutomationServiceSnapshot,
  ) {
    super(platform, `Garage Door - ${device.name}`, `QolsysAutomationCover-${device.virtualNodeId}-${service.endpoint}`);

    this.virtualNodeId = device.virtualNodeId;
    this.endpoint = service.endpoint ?? 0;

    this.Accessory.getService(this.platform.Service.AccessoryInformation)!
      .setCharacteristic(this.platform.Characteristic.Model, 'Qolsys Garage Door')
      .setCharacteristic(this.platform.Characteristic.SerialNumber, `AutDev${device.virtualNodeId}:${this.endpoint}`);

    this.service = this.AddService(this.platform.Service.GarageDoorOpener, `Garage Door - ${device.name}`, `Garage-${device.virtualNodeId}-${this.endpoint}`);

    this.service.getCharacteristic(this.platform.Characteristic.TargetDoorState)
      .onSet(this.handleSetTargetState.bind(this));

    this.service.getCharacteristic(this.platform.Characteristic.ObstructionDetected)
      .updateValue(false);

    this.UpdateFromService(service);
  }

  UpdateFromService(service: BridgeAutomationServiceSnapshot): void {
    let currentState = this.platform.Characteristic.CurrentDoorState.STOPPED;
    if (service.isOpening) {
      currentState = this.platform.Characteristic.CurrentDoorState.OPENING;
    } else if (service.isClosing) {
      currentState = this.platform.Characteristic.CurrentDoorState.CLOSING;
    } else if (service.isClosed) {
      currentState = this.platform.Characteristic.CurrentDoorState.CLOSED;
    } else {
      currentState = this.platform.Characteristic.CurrentDoorState.OPEN;
    }

    const targetState = service.isClosed
      ? this.platform.Characteristic.TargetDoorState.CLOSED
      : this.platform.Characteristic.TargetDoorState.OPEN;

    this.service.updateCharacteristic(this.platform.Characteristic.CurrentDoorState, currentState);
    this.service.updateCharacteristic(this.platform.Characteristic.TargetDoorState, targetState);
  }

  private handleSetTargetState(value: CharacteristicValue): void {
    const target = typeof value === 'number' ? value : Number(value);
    const action = target === this.platform.Characteristic.TargetDoorState.CLOSED ? 'cover_close' : 'cover_open';
    void this.platform.SendAutomationCommand({
      type: 'cover',
      action,
      virtualNodeId: this.virtualNodeId,
      endpoint: this.endpoint,
    });
  }
}
