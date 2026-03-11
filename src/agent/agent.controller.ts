// ITM-Data-API_v1/src/agent/agent.controller.ts
import { Controller, Get } from '@nestjs/common';
import { AgentService } from './agent.service';

@Controller('agent') // 기준 경로: http://백엔드주소:8081/agent/...
export class AgentController {
  constructor(private readonly agentService: AgentService) {}

  @Get('versions')
  async getVersions() {
    return this.agentService.getVersions();
  }

  @Get('plugins')
  async getPlugins() {
    return this.agentService.getPlugins();
  }
}
