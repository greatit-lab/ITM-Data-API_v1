// ITM-Data-API/src/error/error.controller.ts
import { Controller, Get, Query } from '@nestjs/common';
import { ErrorService } from './error.service';

@Controller('error')
export class ErrorController {
  constructor(private readonly errorService: ErrorService) {}

  @Get('summary')
  async getSummary(
    @Query('site') site: string,
    @Query('sdwt') sdwt: string,
    @Query('startDate') startDate: string,
    @Query('endDate') endDate: string,
  ) {
    return this.errorService.getErrorSummary(site, sdwt, startDate, endDate);
  }

  @Get('trend')
  async getTrend(
    @Query('site') site: string,
    @Query('sdwt') sdwt: string,
    @Query('startDate') startDate: string,
    @Query('endDate') endDate: string,
  ) {
    return this.errorService.getErrorTrend(site, sdwt, startDate, endDate);
  }

  @Get('logs')
  async getLogs(
    @Query('page') page: number = 1,
    @Query('limit') limit: number = 20,
    @Query('site') site: string,
    @Query('sdwt') sdwt: string,
    @Query('startDate') startDate: string,
    @Query('endDate') endDate: string,
  ) {
    return this.errorService.getErrorLogs(Number(page), Number(limit), site, sdwt, startDate, endDate);
  }
}
