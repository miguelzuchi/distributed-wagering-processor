import { Body, Controller, Get, Param, Post } from '@nestjs/common';
import { CreateWalletDto, WalletIdParamDto } from './dto/create-wallet.dto.js';
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
}
