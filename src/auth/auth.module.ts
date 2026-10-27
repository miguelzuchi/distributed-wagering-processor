import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { NoAuthGuard } from './no-auth.guard.js';

@Module({
  providers: [{ provide: APP_GUARD, useClass: NoAuthGuard }],
})
export class AuthModule {}
