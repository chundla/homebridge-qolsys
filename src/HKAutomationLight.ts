import { Service, CharacteristicValue } from 'homebridge';
import { HKAccessory } from './HKAccessory.js';
import { BridgeAutomationDeviceSnapshot, BridgeAutomationServiceSnapshot } from './transports/bridgeTypes.js';
import { HBQolsysPanel } from './platform.js';

export class HKAutomationLight extends HKAccessory {
  private service: Service;
  private readonly virtualNodeId: number;
  private readonly endpoint: number;
  private readonly supportsLevel: boolean;

  constructor(
    protected readonly platform: HBQolsysPanel,
    device: BridgeAutomationDeviceSnapshot,
    service: BridgeAutomationServiceSnapshot,
  ) {
    super(platform, `Light - ${device.name}`, `QolsysAutomationLight-${device.virtualNodeId}-${service.endpoint}`);

    this.virtualNodeId = device.virtualNodeId;
    this.endpoint = service.endpoint ?? 0;
    this.supportsLevel = Boolean(service.supportsLevel);

    this.Accessory.getService(this.platform.Service.AccessoryInformation)!
      .setCharacteristic(this.platform.Characteristic.Model, 'Qolsys Light')
      .setCharacteristic(this.platform.Characteristic.SerialNumber, `AutDev${device.virtualNodeId}:${this.endpoint}`);

    this.service = this.AddService(this.platform.Service.Lightbulb, `Light - ${device.name}`, `Light-${device.virtualNodeId}-${this.endpoint}`);

    this.service.getCharacteristic(this.platform.Characteristic.On)
      .onSet(this.handleSetOn.bind(this));

    if (this.supportsLevel) {
      this.service.getCharacteristic(this.platform.Characteristic.Brightness)
        .onSet(this.handleSetBrightness.bind(this));
    }

    this.UpdateFromService(service);
  }

  UpdateFromService(service: BridgeAutomationServiceSnapshot): void {
    if (service.isOn !== undefined) {
      this.service.updateCharacteristic(this.platform.Characteristic.On, service.isOn);
    }

    if (this.supportsLevel && service.level !== undefined && service.level !== null) {
      const percent = Math.min(100, Math.max(0, Math.round((service.level / 99) * 100)));
      this.service.updateCharacteristic(this.platform.Characteristic.Brightness, percent);
    }
  }

  private handleSetOn(value: CharacteristicValue): void {
    const isOn = Boolean(value);
    const action = isOn ? 'light_on' : 'light_off';
    void this.platform.SendAutomationCommand({
      type: 'light',
      action,
      virtualNodeId: this.virtualNodeId,
      endpoint: this.endpoint,
    });
  }

  private handleSetBrightness(value: CharacteristicValue): void {
    const level = typeof value === 'number' ? value : Number(value);
    const scaled = Math.max(0, Math.min(99, Math.round((level / 100) * 99)));
    void this.platform.SendAutomationCommand({
      type: 'light',
      action: 'light_level',
      virtualNodeId: this.virtualNodeId,
      endpoint: this.endpoint,
      value: scaled,
    });
  }
}
