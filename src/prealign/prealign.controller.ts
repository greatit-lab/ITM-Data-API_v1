// ITM-Data-API/src/prealign/prealign.controller.ts
import { Controller, Get, Query } from '@nestjs/common';
import { PreAlignService } from './prealign.service';

@Controller('prealign')
export class PreAlignController {
  constructor(private readonly preAlignService: PreAlignService) {}

  // [수정] 경로: /prealign/trend
  @Get('trend')
  async getTrend(
    @Query('site') site: string,
    @Query('sdwt') sdwt: string,
    @Query('eqpId') eqpId: string,
    @Query('startDate') startDate: string,
    @Query('endDate') endDate: string,
  ) {
    // [핵심 수정] getLog -> getTrend 로 변경 (Service에 정의된 메서드명 사용)
    return this.preAlignService.getTrend(site, sdwt, eqpId, startDate, endDate);
  }
}
