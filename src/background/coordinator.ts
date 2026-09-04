import type { DeviceStateRepository } from "../state/device-state.js";
import type { PendingPairingRepository } from "../state/pairing-state.js";
import { PairingClient, normalizeCptrOrigin } from "../transport/pairing.js";

export interface PairingClientLike {
  request(deviceName: string): Promise<{
    pairingId: string;
    claimSecret: string;
    expiresAt: number;
  }>;
  claim(pairingId: string, claimSecret: string): Promise<{
    deviceId: string;
    deviceCredential: string;
  }>;
}

export interface ControlTransportLike {
  start(): Promise<boolean>;
  stop(): void;
}

export interface ExtensionCoordinatorOptions {
  deviceState: DeviceStateRepository;
  pairingState: PendingPairingRepository;
  pairingClientFactory?: (origin: string) => PairingClientLike;
  transport: ControlTransportLike;
  now?: () => number;
}

export class ExtensionCoordinator {
  private readonly deviceState: DeviceStateRepository;
  private readonly pairingState: PendingPairingRepository;
  private readonly pairingClientFactory: (origin: string) => PairingClientLike;
  private readonly transport: ControlTransportLike;
  private readonly now: () => number;

  constructor(options: ExtensionCoordinatorOptions) {
    this.deviceState = options.deviceState;
    this.pairingState = options.pairingState;
    this.pairingClientFactory = options.pairingClientFactory ?? ((origin) => new PairingClient(origin));
    this.transport = options.transport;
    this.now = options.now ?? Date.now;
  }

  async requestPairing(cptrOrigin: string, deviceName: string): Promise<{
    pairingId: string;
    expiresAt: number;
    cptrOrigin: string;
    deviceName: string;
  }> {
    const origin = normalizeCptrOrigin(cptrOrigin);
    const name = deviceName.trim();
    if (!name || name.length > 120) throw new Error("Device name must be between 1 and 120 characters");

    await this.pairingState.clear();
    const pairing = await this.pairingClientFactory(origin).request(name);
    if (pairing.expiresAt <= this.now()) throw new Error("CPTR pairing challenge is already expired");

    await this.pairingState.save({
      cptrOrigin: origin,
      deviceName: name,
      pairingId: pairing.pairingId,
      claimSecret: pairing.claimSecret,
      expiresAt: pairing.expiresAt,
    });

    return {
      pairingId: pairing.pairingId,
      expiresAt: pairing.expiresAt,
      cptrOrigin: origin,
      deviceName: name,
    };
  }

  async claimPairing(pairingId: string): Promise<{
    paired: true;
    deviceId: string;
    deviceName: string;
    cptrOrigin: string;
  }> {
    const pending = await this.pairingState.load();
    if (!pending || pending.pairingId !== pairingId) throw new Error("Pending pairing challenge not found");
    if (pending.expiresAt <= this.now()) {
      await this.pairingState.clear();
      throw new Error("Pending pairing challenge has expired");
    }

    const claimed = await this.pairingClientFactory(pending.cptrOrigin).claim(
      pending.pairingId,
      pending.claimSecret,
    );

    await this.deviceState.save({
      cptrOrigin: pending.cptrOrigin,
      deviceId: claimed.deviceId,
      deviceCredential: claimed.deviceCredential,
      deviceName: pending.deviceName,
      resumeSequence: 0,
    });
    await this.pairingState.clear();
    await this.transport.start();

    return {
      paired: true,
      deviceId: claimed.deviceId,
      deviceName: pending.deviceName,
      cptrOrigin: pending.cptrOrigin,
    };
  }
}
