// ITM-Data-API_v1/src/agent/agent.controller.ts
import { Controller, Get, Header } from '@nestjs/common';
import { AgentService } from './agent.service';

@Controller('agent') // 기준 경로: http://백엔드주소:8081/agent/...
export class AgentController {
  constructor(private readonly agentService: AgentService) {}

  @Get('versions')
  async getVersions() {
    return this.agentService.getVersions();
  }

  // 신규 추가: Inno Setup 설치 직전 체크용 순수 텍스트 반환 API
  @Get('latest-version')
  @Header('Content-Type', 'text/plain; charset=utf-8')
  async getLatestVersionText() {
    return this.agentService.getLatestVersionText();
  }

  @Get('plugins')
  async getPlugins() {
    return this.agentService.getPlugins();
  }
}
