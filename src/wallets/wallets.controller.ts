import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import {
  CreateWalletDto,
  LedgerQueryDto,
  WalletIdParamDto,
} from './dto/create-wallet.dto.js';
import { WalletResponse, WalletsService } from './wallets.service.js';

@Controller('wallets')
export class WalletsController {
  constructor(private readonly wallets: WalletsService) {}

  @Post()
  create(@Body() input: CreateWalletDto): Promise<WalletResponse> {
    return this.wallets.create(input);
  }

  @Get(':walletId')
  getById(@Param() params: WalletIdParamDto): Promise<WalletResponse> {
    return this.wallets.getById(params.walletId);
  }

  @Get(':walletId/ledger')
  listLedger(
    @Param() params: WalletIdParamDto,
    @Query() query: LedgerQueryDto,
  ) {
    return this.wallets.listLedger(params.walletId, query);
  }

  @Post(':walletId/reconciliation')
  reconcile(@Param() params: WalletIdParamDto) {
    return this.wallets.reconcile(params.walletId);
  }
}
