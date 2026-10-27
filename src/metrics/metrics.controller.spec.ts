import { EntityManager } from '@mikro-orm/postgresql';
import { Test } from '@nestjs/testing';
import { MetricsController } from './metrics.controller.js';

describe('MetricsController', () => {
  it('renders a Prometheus snapshot from persisted state', async () => {
    const execute = vi.fn().mockResolvedValue([
      {
        transactions_total: '12',
        transactions_pending_reference: '2',
        transactions_rejected: '1',
        outbox_pending: '3',
        outbox_retrying: '1',
        inbox_processed_total: '8',
        inbox_rejected_total: '2',
        idempotent_replays_total: '7',
        outbox_lag_seconds: '1.5',
        processing_latency_seconds: '0.02',
        transactions_processed: '9',
        transactions_failed: '0',
        transactions_pending: '0',
      },
    ]);
    const entityManager = { fork: () => ({ execute }) };
    const module = await Test.createTestingModule({
      controllers: [MetricsController],
      providers: [{ provide: EntityManager, useValue: entityManager }],
    }).compile();

    const result = await module.get(MetricsController).scrape();

    expect(result).toContain('# TYPE wagering_transactions_total counter');
    expect(result).toContain('wagering_transactions_total 12');
    expect(result).toContain('wagering_transactions_pending_reference 2');
    expect(result).toContain('wagering_outbox_pending 3');
    expect(result).toContain('wagering_inbox_rejected_total 2');
    expect(result).toContain('wagering_idempotent_replays_total 7');
    expect(result).toContain('wagering_outbox_lag_seconds 1.5');
    expect(result).toContain('wagering_transactions_processed 9');
    expect(execute).toHaveBeenCalledOnce();
  });

  it('uses zero when an aggregate is absent', async () => {
    const entityManager = {
      fork: () => ({ execute: vi.fn().mockResolvedValue([]) }),
    };
    const module = await Test.createTestingModule({
      controllers: [MetricsController],
      providers: [{ provide: EntityManager, useValue: entityManager }],
    }).compile();

    const result = await module.get(MetricsController).scrape();

    expect(result).toContain('wagering_transactions_total 0');
    expect(result).toContain('wagering_outbox_pending 0');
  });
});
