// ITM-Data-API/src/health/health.controller.ts
import { Controller, Get, Query } from '@nestjs/common';
import { HealthService } from './health.service';

@Controller('Health')
export class HealthController {
  constructor(private readonly healthService: HealthService) {}

  @Get('summary')
  getSummary(@Query('site') site: string, @Query('sdwt') sdwt?: string) {
    return this.healthService.getHealthSummary(site, sdwt);
  }
}
