import { Module } from '@nestjs/common';
import {
  ProviderWageringController,
  WageringController,
} from './wagering.controller.js';
import { WageringService } from './wagering.service.js';

@Module({
  controllers: [WageringController, ProviderWageringController],
  providers: [WageringService],
  exports: [WageringService],
})
export class WageringModule {}
