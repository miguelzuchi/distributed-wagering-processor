import { randomUUID } from 'node:crypto';
import { Injectable, Logger, NestMiddleware } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';

const CORRELATION_HEADER = 'x-correlation-id';
const SAFE_CORRELATION_ID = /^[A-Za-z0-9._:-]{1,128}$/;

@Injectable()
export class HttpLoggingMiddleware implements NestMiddleware {
  private readonly logger = new Logger(HttpLoggingMiddleware.name);

  use(request: Request, response: Response, next: NextFunction): void {
    const startedAt = process.hrtime.bigint();
    const suppliedCorrelationId = request.header(CORRELATION_HEADER)?.trim();
    const correlationId =
      suppliedCorrelationId && SAFE_CORRELATION_ID.test(suppliedCorrelationId)
        ? suppliedCorrelationId
        : randomUUID();

    response.setHeader(CORRELATION_HEADER, correlationId);
    response.once('finish', () => {
      const durationMs =
        Number(process.hrtime.bigint() - startedAt) / 1_000_000;
      this.logger.log({
        event: 'http_request_completed',
        correlationId,
        method: request.method,
        path: request.originalUrl,
        statusCode: response.statusCode,
        durationMs: Number(durationMs.toFixed(3)),
      });
    });
    next();
  }
}
