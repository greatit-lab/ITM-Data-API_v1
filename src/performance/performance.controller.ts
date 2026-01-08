// ITM-Data-API/src/performance/performance.controller.ts
import { Controller, Get, Query } from '@nestjs/common';
import { PerformanceService } from './performance.service';

@Controller('performance')
export class PerformanceController {
  constructor(private readonly performanceService: PerformanceService) {}

  @Get('history')
  async getHistory(
    @Query('eqpids') eqpids: string,
    @Query('startDate') startDate: string,
    @Query('endDate') endDate: string,
  ) {
    const eqpIdList = eqpids.split(',');
    return this.performanceService.getSystemPerformance(eqpIdList, startDate, endDate);
  }

  @Get('process-history')
  async getProcessHistory(
    @Query('eqpId') eqpId: string,
    @Query('startDate') startDate: string,
    @Query('endDate') endDate: string,
  ) {
    return this.performanceService.getProcessPerformance(eqpId, startDate, endDate);
  }

  @Get('itm-agent-trend')
  async getItmAgentTrend(
    @Query('site') site: string,
    @Query('sdwt') sdwt: string,
    @Query('startDate') startDate: string,
    @Query('endDate') endDate: string,
  ) {
    return this.performanceService.getItmAgentTrend(site, sdwt, startDate, endDate);
  }
}
