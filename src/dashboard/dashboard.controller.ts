// ITM-Data-API_v1/src/dashboard/dashboard.controller.ts
import { Controller, Get, Post, Body, Query } from '@nestjs/common';
import { DashboardService } from './dashboard.service';

@Controller('dashboard')
export class DashboardController {
  constructor(private readonly dashboardService: DashboardService) {}

  // [필수 확인!] 프론트엔드에서 호출하는 통합 데이터 라우트
  @Get('global-fleet')
  async getGlobalFleetData() {
    return this.dashboardService.getGlobalFleetData();
  }

  @Get('summary')
  async getSummary(
    @Query('site') site?: string,
    @Query('sdwt') sdwt?: string,
  ) {
    return this.dashboardService.getSummary(site, sdwt);
  }

  @Get('agentstatus')
  async getAgentStatus(
    @Query('site') site?: string,
    @Query('sdwt') sdwt?: string,
  ) {
    return this.dashboardService.getAgentStatus(site, sdwt);
  }

  // ========================================================================
  // [신규 추가] 이스터에그(글로벌 리더보드) 기능
  // ========================================================================

  @Post('easter-egg')
  async saveEasterEgg(
    @Body() body: { userId: string; eggType: string; score: number },
  ) {
    return this.dashboardService.saveEasterEgg(body);
  }

  @Get('easter-egg/ranking')
  async getEasterEggRanking(@Query('eggType') eggType: string) {
    return this.dashboardService.getEasterEggRanking(eggType);
  }
}
