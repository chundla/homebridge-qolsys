import { QolsysController } from '../QolsysController';
import { QolsysTransport, QolsysTransportConfig } from './types';

export class C4Transport implements QolsysTransport {
  public readonly mode = 'c4' as const;
  public readonly controller: QolsysController;

  constructor(config: QolsysTransportConfig) {
    this.controller = new QolsysController(config.host, config.port);
    this.controller.SecureToken = config.secureToken ?? '';
    this.controller.UserPinCode = config.userPinCode ?? '';
  }

  connect(): void {
    this.controller.Connect();
  }

  disconnect(): void {
    // QolsysController currently doesn't expose an explicit disconnect call.
  }
}
