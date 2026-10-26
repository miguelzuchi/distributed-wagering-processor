import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Headers,
  Param,
  ParseUUIDPipe,
  Post,
  Res,
} from '@nestjs/common';
import type { Response } from 'express';
import { WagerTransactionStatus } from '../domain/wagering/wager-transaction.js';
import { SubmitWagerTransactionDto } from './dto/submit-wager-transaction.dto.js';
import {
  WageringService,
  WagerTransactionResponse,
} from './wagering.service.js';

@Controller('wagering/transactions')
export class WageringController {
  constructor(private readonly wagering: WageringService) {}

  @Post()
  async submit(
    @Body() input: SubmitWagerTransactionDto,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Res({ passthrough: true }) response: Response,
  ): Promise<WagerTransactionResponse> {
    if (!idempotencyKey?.trim()) {
      throw new BadRequestException('Idempotency-Key header is required');
    }
    const normalizedIdempotencyKey = idempotencyKey.trim();
    if (normalizedIdempotencyKey.length > 300) {
      throw new BadRequestException(
        'Idempotency-Key header must not exceed 300 characters',
      );
    }
    const result = await this.wagering.submit(input, normalizedIdempotencyKey);
    response.status(this.httpStatus(result));
    return result;
  }

  @Get(':transactionId')
  getById(
    @Param('transactionId', new ParseUUIDPipe()) transactionId: string,
  ): Promise<WagerTransactionResponse> {
    return this.wagering.getById(transactionId);
  }

  private httpStatus(result: WagerTransactionResponse): number {
    if (result.idempotentReplay) return 200;
    if (result.status === WagerTransactionStatus.PendingReference) return 202;
    if (result.status === WagerTransactionStatus.Rejected) return 422;
    return 201;
  }
}

@Controller('providers/:providerId/wagering/transactions')
export class ProviderWageringController {
  constructor(private readonly wagering: WageringService) {}

  @Get(':externalTransactionId')
  getByExternalId(
    @Param('providerId') providerId: string,
    @Param('externalTransactionId') externalTransactionId: string,
  ): Promise<WagerTransactionResponse> {
    return this.wagering.getByProviderExternalId(
      providerId,
      externalTransactionId,
    );
  }
}
