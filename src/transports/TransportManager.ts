import { Logger } from 'homebridge';
import { QolsysController } from '../QolsysController.js';
import { C4Transport } from './C4Transport.js';
import { MqttTransport } from './MqttTransport.js';
import {
  QolsysArmCommand,
  QolsysAutomationCommand,
  QolsysPanelCommand,
  QolsysTransport,
  QolsysTransportConfig,
  QolsysTransportMode,
} from './types.js';

export class TransportManager {
  private readonly selectedMode: QolsysTransportMode;
  private readonly activeTransport: QolsysTransport;
  private readonly c4Transport: C4Transport;

  constructor(
    private readonly log: Logger,
    mode: QolsysTransportMode,
    config: QolsysTransportConfig,
  ) {
    this.selectedMode = mode;
    this.c4Transport = new C4Transport(config);

    if (mode === 'mqtt') {
      this.activeTransport = new MqttTransport(this.log, config);
      this.log.info('TransportMode=mqtt selected. State and commands use MQTT topics.');
    } else {
      this.activeTransport = this.c4Transport;
    }
  }

  get controller(): QolsysController {
    if (this.selectedMode === 'mqtt' && 'controller' in this.activeTransport) {
      return (this.activeTransport as MqttTransport).controller;
    }

    return this.c4Transport.controller;
  }

  get mode(): QolsysTransportMode {
    return this.selectedMode;
  }

  async sendArmCommand(command: QolsysArmCommand): Promise<void> {
    if (this.activeTransport.sendArmCommand) {
      await this.activeTransport.sendArmCommand(command);
      return;
    }

    this.c4Transport.controller.SendArmCommand(
      command.armingType,
      command.partitionId,
      command.delay,
      command.bypass,
    );
  }

  async sendAutomationCommand(command: QolsysAutomationCommand): Promise<void> {
    if (this.activeTransport.sendAutomationCommand) {
      await this.activeTransport.sendAutomationCommand(command);
      return;
    }

    this.log.warn('Automation commands require MQTT transport. Ignoring command: ' + command.action);
  }

  async sendPanelCommand(command: QolsysPanelCommand): Promise<void> {
    if (this.activeTransport.sendPanelCommand) {
      await this.activeTransport.sendPanelCommand(command);
      return;
    }

    this.log.warn('Panel commands require MQTT transport. Ignoring command: ' + command.command);
  }

  connect(): void {
    this.activeTransport.connect();
  }

  disconnect(): void {
    this.activeTransport.disconnect();
  }
}
