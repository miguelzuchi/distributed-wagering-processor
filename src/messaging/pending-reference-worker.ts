import {
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnModuleDestroy,
} from '@nestjs/common';
import { WageringService } from '../wagering/wagering.service.js';

@Injectable()
export class PendingReferenceWorker
  implements OnApplicationBootstrap, OnModuleDestroy
{
  private readonly logger = new Logger(PendingReferenceWorker.name);
  private timer?: ReturnType<typeof setTimeout>;
  private stopped = false;

  constructor(private readonly wagering: WageringService) {}

  onApplicationBootstrap(): void {
    this.schedule(250);
  }

  onModuleDestroy(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
  }

  private schedule(delay: number): void {
    if (this.stopped) return;
    this.timer = setTimeout(() => void this.run(), delay);
    this.timer.unref();
  }

  private async run(): Promise<void> {
    try {
      const processed = await this.wagering.reprocessDueReferences();
      this.schedule(processed > 0 ? 0 : 500);
    } catch (error) {
      this.logger.warn({
        event: 'pending_reference_batch_failed',
        error: error instanceof Error ? error.name : 'UnknownError',
      });
      this.schedule(1_000);
    }
  }
}
