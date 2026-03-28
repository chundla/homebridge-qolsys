import { Logger } from 'homebridge';
import { QolsysController } from '../QolsysController.js';
import { C4Transport } from './C4Transport.js';
import { PkiBridgeTransport } from './PkiBridgeTransport.js';
import {
  QolsysArmCommand,
  QolsysAutomationCommand,
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

    if (mode === 'pki') {
      this.activeTransport = new PkiBridgeTransport(this.log, {
        ...config,
        onBridgeSnapshot: (snapshot) => this.c4Transport.controller.ApplyBridgeSnapshot(snapshot),
      });
      this.log.warn('TransportMode=pki selected. C4 connection stays enabled for command compatibility.');
      this.log.warn('Configured BridgeEndpoint: ' + (config.bridgeEndpoint ?? 'unset'));
    } else {
      this.activeTransport = this.c4Transport;
    }
  }

  get controller(): QolsysController {
    // Runtime remains c4 until PKI transport is fully implemented.
    return this.c4Transport.controller;
  }

  get mode(): QolsysTransportMode {
    return this.selectedMode;
  }

  async sendArmCommand(command: QolsysArmCommand): Promise<void> {
    if (this.selectedMode === 'pki' && this.activeTransport.sendArmCommand) {
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
    if (this.selectedMode === 'pki' && this.activeTransport.sendAutomationCommand) {
      await this.activeTransport.sendAutomationCommand(command);
      return;
    }

    this.log.warn('Automation commands require PKI bridge transport. Ignoring command: ' + command.action);
  }

  connect(): void {
    if (this.selectedMode === 'pki') {
      this.activeTransport.connect();
    }

    this.c4Transport.connect();
  }

  disconnect(): void {
    this.activeTransport.disconnect();
    this.c4Transport.disconnect();
  }
}
