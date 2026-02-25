// ITM-Data-API/src/performance/performance.controller.ts
import { Controller, Get, Query } from '@nestjs/common';
import { PerformanceService } from './performance.service';

@Controller('performance')
export class PerformanceController {
  constructor(private readonly performanceService: PerformanceService) {}

  @Get('history')
  async getHistory(
    @Query('startDate') startDate: string,
    @Query('endDate') endDate: string,
    @Query('eqpids') eqpids?: string,
    @Query('interval') interval?: string,
  ) {
    const intervalSec = interval ? parseInt(interval, 10) : 300; // [수정] 5분(300초)으로 변경
    return this.performanceService.getPerformanceHistory(
      startDate,
      endDate,
      eqpids,
      intervalSec, 
    );
  }

  @Get('process-history')
  async getProcessHistory(
    @Query('startDate') startDate: string,
    @Query('endDate') endDate: string,
    @Query('eqpId') eqpId: string,
    @Query('interval') interval?: string,
  ) {
    const intervalSec = interval ? parseInt(interval, 10) : 60;
    return this.performanceService.getProcessHistory(
      startDate,
      endDate,
      eqpId,
      intervalSec,
    );
  }

  @Get('itm-agent-trend')
  async getItmAgentTrend(
    @Query('site') site: string,
    @Query('sdwt') sdwt: string,
    @Query('startDate') startDate: string,
    @Query('endDate') endDate: string,
    @Query('eqpid') eqpid?: string,
    @Query('interval') interval?: string, 
  ) {
    const intervalSec = interval ? parseInt(interval, 10) : 60;
    return this.performanceService.getItmAgentTrend(
      site,
      sdwt,
      startDate,
      endDate,
      eqpid,
      intervalSec,
    );
  }
}
