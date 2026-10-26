import { EventEmitter } from 'node:events';
import { Logger } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';
import { HttpLoggingMiddleware } from './http-logging.middleware.js';

describe('HttpLoggingMiddleware', () => {
  afterEach(() => vi.restoreAllMocks());

  it('preserves a safe correlation id and emits a structured completion log', () => {
    const log = vi.spyOn(Logger.prototype, 'log').mockImplementation(() => {});
    const response = new EventEmitter() as EventEmitter &
      Pick<Response, 'setHeader' | 'statusCode'>;
    response.statusCode = 201;
    response.setHeader = vi.fn();
    const request = {
      method: 'POST',
      originalUrl: '/wagering/transactions',
      header: vi.fn().mockReturnValue('provider:transaction-123'),
    } as unknown as Request;
    const next = vi.fn() as NextFunction;

    new HttpLoggingMiddleware().use(
      request,
      response as unknown as Response,
      next,
    );
    response.emit('finish');

    expect(response.setHeader).toHaveBeenCalledWith(
      'x-correlation-id',
      'provider:transaction-123',
    );
    expect(next).toHaveBeenCalledOnce();
    expect(log).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'http_request_completed',
        correlationId: 'provider:transaction-123',
        method: 'POST',
        path: '/wagering/transactions',
        statusCode: 201,
        durationMs: expect.any(Number),
      }),
    );
  });

  it('replaces unsafe correlation ids', () => {
    vi.spyOn(Logger.prototype, 'log').mockImplementation(() => {});
    const response = new EventEmitter() as EventEmitter &
      Pick<Response, 'setHeader' | 'statusCode'>;
    response.statusCode = 200;
    const setHeader = vi.fn();
    response.setHeader = setHeader;
    const request = {
      method: 'GET',
      originalUrl: '/health/live',
      header: vi.fn().mockReturnValue('contains spaces and control\n'),
    } as unknown as Request;

    new HttpLoggingMiddleware().use(
      request,
      response as unknown as Response,
      vi.fn(),
    );

    const generated = setHeader.mock.calls[0]?.[1];
    expect(generated).toEqual(expect.any(String));
    expect(generated).not.toBe('contains spaces and control\n');
    expect(generated).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });
});
