// ITM-Data-Api/src/lamplife/lamplife.controller.ts
import { Controller, Get, Query } from '@nestjs/common';
import { LampLifeService } from './lamplife.service';

@Controller('lamplife')
export class LampLifeController {
  constructor(private readonly lampService: LampLifeService) {}

  @Get()
  async getLampLife(@Query('site') site: string, @Query('sdwt') sdwt: string) {
    return this.lampService.getLampStatus(site, sdwt);
  }
}
