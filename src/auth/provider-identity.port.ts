import type { ExecutionContext } from '@nestjs/common';

export interface ProviderIdentity {
  readonly providerId: string;
  readonly subject: string;
}

export abstract class ProviderIdentityPort {
  abstract resolve(context: ExecutionContext): Promise<ProviderIdentity | undefined>;
}
