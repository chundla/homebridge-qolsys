import { Service, CharacteristicValue } from 'homebridge';
import { HKAccessory } from './HKAccessory.js';
import { BridgeAutomationDeviceSnapshot, BridgeAutomationServiceSnapshot } from './transports/bridgeTypes.js';
import { HBQolsysPanel } from './platform.js';

export class HKAutomationSiren extends HKAccessory {
  private service: Service;
  private readonly virtualNodeId: number;
  private readonly endpoint: number;

  constructor(
    protected readonly platform: HBQolsysPanel,
    device: BridgeAutomationDeviceSnapshot,
    service: BridgeAutomationServiceSnapshot,
  ) {
    super(platform, `Siren - ${device.name}`, `QolsysAutomationSiren-${device.virtualNodeId}-${service.endpoint}`);

    this.virtualNodeId = device.virtualNodeId;
    this.endpoint = service.endpoint ?? 0;

    this.Accessory.getService(this.platform.Service.AccessoryInformation)!
      .setCharacteristic(this.platform.Characteristic.Model, 'Qolsys Siren')
      .setCharacteristic(this.platform.Characteristic.SerialNumber, `AutDev${device.virtualNodeId}:${this.endpoint}`);

    this.service = this.AddService(
      this.platform.Service.Switch,
      `Siren - ${device.name}`,
      `Siren-${device.virtualNodeId}-${this.endpoint}`,
    );

    this.service.getCharacteristic(this.platform.Characteristic.On)
      .onSet(this.handleSetOn.bind(this));

    this.UpdateFromService(service);
  }

  UpdateFromService(service: BridgeAutomationServiceSnapshot): void {
    if (service.isOn !== undefined) {
      this.service.updateCharacteristic(this.platform.Characteristic.On, service.isOn);
    }
  }

  private handleSetOn(value: CharacteristicValue): void {
    const isOn = Boolean(value);
    const action = isOn ? 'siren_on' : 'siren_off';
    void this.platform.SendAutomationCommand({
      type: 'siren',
      action,
      virtualNodeId: this.virtualNodeId,
      endpoint: this.endpoint,
    });
  }
}
