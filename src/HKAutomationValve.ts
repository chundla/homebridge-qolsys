import { Service, CharacteristicValue } from 'homebridge';
import { HKAccessory } from './HKAccessory.js';
import { BridgeAutomationDeviceSnapshot, BridgeAutomationServiceSnapshot } from './transports/bridgeTypes.js';
import { HBQolsysPanel } from './platform.js';

export class HKAutomationValve extends HKAccessory {
  private service: Service;
  private readonly virtualNodeId: number;
  private readonly endpoint: number;

  constructor(
    protected readonly platform: HBQolsysPanel,
    device: BridgeAutomationDeviceSnapshot,
    service: BridgeAutomationServiceSnapshot,
  ) {
    super(platform, `Valve - ${device.name}`, `QolsysAutomationValve-${device.virtualNodeId}-${service.endpoint}`);

    this.virtualNodeId = device.virtualNodeId;
    this.endpoint = service.endpoint ?? 0;

    this.Accessory.getService(this.platform.Service.AccessoryInformation)!
      .setCharacteristic(this.platform.Characteristic.Model, 'Qolsys Valve')
      .setCharacteristic(this.platform.Characteristic.SerialNumber, `AutDev${device.virtualNodeId}:${this.endpoint}`);

    this.service = this.AddService(this.platform.Service.Valve, `Valve - ${device.name}`, `Valve-${device.virtualNodeId}-${this.endpoint}`);

    this.service.getCharacteristic(this.platform.Characteristic.ValveType)
      .updateValue(this.platform.Characteristic.ValveType.GENERIC_VALVE);

    this.service.getCharacteristic(this.platform.Characteristic.Active)
      .onSet(this.handleSetActive.bind(this));

    this.UpdateFromService(service);
  }

  UpdateFromService(service: BridgeAutomationServiceSnapshot): void {
    if (service.isClosed !== undefined) {
      const active = service.isClosed ? this.platform.Characteristic.Active.INACTIVE : this.platform.Characteristic.Active.ACTIVE;
      this.service.updateCharacteristic(this.platform.Characteristic.Active, active);
      this.service.updateCharacteristic(
        this.platform.Characteristic.InUse,
        service.isClosed ? this.platform.Characteristic.InUse.NOT_IN_USE : this.platform.Characteristic.InUse.IN_USE,
      );
    }
  }

  private handleSetActive(value: CharacteristicValue): void {
    const active = typeof value === 'number' ? value : Number(value);
    const action = active === this.platform.Characteristic.Active.ACTIVE ? 'valve_open' : 'valve_close';
    void this.platform.SendAutomationCommand({
      type: 'valve',
      action,
      virtualNodeId: this.virtualNodeId,
      endpoint: this.endpoint,
    });
  }
}
