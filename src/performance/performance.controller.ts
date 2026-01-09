// ITM-Data-API/src/performance/performance.controller.ts
import { Controller, Get, Query } from '@nestjs/common';
import { PerformanceService } from './performance.service';

@Controller('performance')
export class PerformanceController {
  constructor(private readonly performanceService: PerformanceService) {}

  // 1. 장비 성능 이력
  @Get('history')
  async getHistory(
    @Query('startDate') startDate: string,
    @Query('endDate') endDate: string,
    @Query('eqpids') eqpids?: string,
  ) {
    return this.performanceService.getPerformanceHistory(startDate, endDate, eqpids);
  }

  // 2. 프로세스 이력
  @Get('process-history')
  async getProcessHistory(
    @Query('startDate') startDate: string,
    @Query('endDate') endDate: string,
    @Query('eqpId') eqpId: string,
    @Query('interval') interval?: number,
  ) {
    return this.performanceService.getProcessHistory(startDate, endDate, eqpId, Number(interval));
  }

  // 3. ITM Agent 트렌드
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
