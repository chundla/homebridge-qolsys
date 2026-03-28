import { Service, CharacteristicValue } from 'homebridge';
import { HKAccessory } from './HKAccessory.js';
import { BridgeAutomationDeviceSnapshot, BridgeAutomationServiceSnapshot } from './transports/bridgeTypes.js';
import { HBQolsysPanel } from './platform.js';

export class HKAutomationThermostat extends HKAccessory {
  private service: Service;
  private readonly virtualNodeId: number;
  private readonly endpoint: number;
  private temperatureUnit: string | undefined;
  private targetMode: number = 0;

  constructor(
    protected readonly platform: HBQolsysPanel,
    device: BridgeAutomationDeviceSnapshot,
    service: BridgeAutomationServiceSnapshot,
  ) {
    super(platform, `Thermostat - ${device.name}`, `QolsysAutomationThermostat-${device.virtualNodeId}-${service.endpoint}`);

    this.virtualNodeId = device.virtualNodeId;
    this.endpoint = service.endpoint ?? 0;

    this.Accessory.getService(this.platform.Service.AccessoryInformation)!
      .setCharacteristic(this.platform.Characteristic.Model, 'Qolsys Thermostat')
      .setCharacteristic(this.platform.Characteristic.SerialNumber, `AutDev${device.virtualNodeId}:${this.endpoint}`);

    this.service = this.AddService(this.platform.Service.Thermostat, `Thermostat - ${device.name}`, `Thermostat-${device.virtualNodeId}-${this.endpoint}`);

    this.service.getCharacteristic(this.platform.Characteristic.TargetHeatingCoolingState)
      .onSet(this.handleSetTargetMode.bind(this));

    this.service.getCharacteristic(this.platform.Characteristic.TargetTemperature)
      .onSet(this.handleSetTargetTemperature.bind(this));

    this.service.getCharacteristic(this.platform.Characteristic.HeatingThresholdTemperature)
      .onSet(this.handleSetHeatingThreshold.bind(this));

    this.service.getCharacteristic(this.platform.Characteristic.CoolingThresholdTemperature)
      .onSet(this.handleSetCoolingThreshold.bind(this));

    this.UpdateFromService(service);
  }

  UpdateFromService(service: BridgeAutomationServiceSnapshot): void {
    this.temperatureUnit = service.temperatureUnit;

    const currentTemp = this.toHomeKitTemp(service.currentTemperature);
    if (currentTemp !== undefined) {
      this.service.updateCharacteristic(this.platform.Characteristic.CurrentTemperature, currentTemp);
    }

    const targetState = this.mapTargetState(service.hvacMode);
    this.targetMode = targetState;
    this.service.updateCharacteristic(this.platform.Characteristic.TargetHeatingCoolingState, targetState);

    const currentState = this.mapCurrentState(service.hvacAction);
    this.service.updateCharacteristic(this.platform.Characteristic.CurrentHeatingCoolingState, currentState);

    const heatTemp = this.toHomeKitTemp(service.targetHeatTemp);
    const coolTemp = this.toHomeKitTemp(service.targetCoolTemp);

    if (heatTemp !== undefined) {
      this.service.updateCharacteristic(this.platform.Characteristic.HeatingThresholdTemperature, heatTemp);
    }
    if (coolTemp !== undefined) {
      this.service.updateCharacteristic(this.platform.Characteristic.CoolingThresholdTemperature, coolTemp);
    }

    if (targetState === this.platform.Characteristic.TargetHeatingCoolingState.HEAT && heatTemp !== undefined) {
      this.service.updateCharacteristic(this.platform.Characteristic.TargetTemperature, heatTemp);
    } else if (targetState === this.platform.Characteristic.TargetHeatingCoolingState.COOL && coolTemp !== undefined) {
      this.service.updateCharacteristic(this.platform.Characteristic.TargetTemperature, coolTemp);
    } else if (targetState === this.platform.Characteristic.TargetHeatingCoolingState.AUTO && heatTemp !== undefined) {
      this.service.updateCharacteristic(this.platform.Characteristic.TargetTemperature, heatTemp);
    }

    const displayUnits = this.temperatureUnit === 'F'
      ? this.platform.Characteristic.TemperatureDisplayUnits.FAHRENHEIT
      : this.platform.Characteristic.TemperatureDisplayUnits.CELSIUS;
    this.service.updateCharacteristic(this.platform.Characteristic.TemperatureDisplayUnits, displayUnits);
  }

  private handleSetTargetMode(value: CharacteristicValue): void {
    const mode = typeof value === 'number' ? value : Number(value);
    this.targetMode = mode;
    const mapped = this.mapToQolsysMode(mode);
    void this.platform.SendAutomationCommand({
      type: 'thermostat',
      action: 'thermostat_mode',
      virtualNodeId: this.virtualNodeId,
      endpoint: this.endpoint,
      mode: mapped,
    });
  }

  private handleSetTargetTemperature(value: CharacteristicValue): void {
    const temp = typeof value === 'number' ? value : Number(value);
    const qolsysTemp = this.fromHomeKitTemp(temp);
    const action = this.targetMode === this.platform.Characteristic.TargetHeatingCoolingState.COOL
      ? 'thermostat_cool'
      : 'thermostat_heat';

    void this.platform.SendAutomationCommand({
      type: 'thermostat',
      action,
      virtualNodeId: this.virtualNodeId,
      endpoint: this.endpoint,
      value: qolsysTemp,
    });
  }

  private handleSetHeatingThreshold(value: CharacteristicValue): void {
    const temp = typeof value === 'number' ? value : Number(value);
    const qolsysTemp = this.fromHomeKitTemp(temp);
    void this.platform.SendAutomationCommand({
      type: 'thermostat',
      action: 'thermostat_heat',
      virtualNodeId: this.virtualNodeId,
      endpoint: this.endpoint,
      value: qolsysTemp,
    });
  }

  private handleSetCoolingThreshold(value: CharacteristicValue): void {
    const temp = typeof value === 'number' ? value : Number(value);
    const qolsysTemp = this.fromHomeKitTemp(temp);
    void this.platform.SendAutomationCommand({
      type: 'thermostat',
      action: 'thermostat_cool',
      virtualNodeId: this.virtualNodeId,
      endpoint: this.endpoint,
      value: qolsysTemp,
    });
  }

  private toHomeKitTemp(value: number | undefined): number | undefined {
    if (value === undefined || value === null || Number.isNaN(value)) {
      return undefined;
    }

    if (this.temperatureUnit === 'F') {
      return (value - 32) / 1.8;
    }

    return value;
  }

  private fromHomeKitTemp(value: number): number {
    if (this.temperatureUnit === 'F') {
      return Math.round(value * 1.8 + 32);
    }

    return Math.round(value * 10) / 10;
  }

  private mapTargetState(mode?: string): number {
    switch (mode) {
      case 'heat':
        return this.platform.Characteristic.TargetHeatingCoolingState.HEAT;
      case 'cool':
        return this.platform.Characteristic.TargetHeatingCoolingState.COOL;
      case 'auto':
      case 'heat_cool':
        return this.platform.Characteristic.TargetHeatingCoolingState.AUTO;
      case 'off':
        return this.platform.Characteristic.TargetHeatingCoolingState.OFF;
      default:
        return this.platform.Characteristic.TargetHeatingCoolingState.AUTO;
    }
  }

  private mapCurrentState(action?: string): number {
    switch (action) {
      case 'heating':
        return this.platform.Characteristic.CurrentHeatingCoolingState.HEAT;
      case 'cooling':
        return this.platform.Characteristic.CurrentHeatingCoolingState.COOL;
      default:
        return this.platform.Characteristic.CurrentHeatingCoolingState.OFF;
    }
  }

  private mapToQolsysMode(mode: number): string {
    switch (mode) {
      case this.platform.Characteristic.TargetHeatingCoolingState.HEAT:
        return 'heat';
      case this.platform.Characteristic.TargetHeatingCoolingState.COOL:
        return 'cool';
      case this.platform.Characteristic.TargetHeatingCoolingState.AUTO:
        return 'auto';
      case this.platform.Characteristic.TargetHeatingCoolingState.OFF:
      default:
        return 'off';
    }
  }
}
