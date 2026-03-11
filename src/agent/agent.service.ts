// ITM-Data-API_v1/src/agent/agent.service.ts
import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma.service';

@Injectable()
export class AgentService {
  constructor(private prisma: PrismaService) {}

  // 버전 정보 목록 조회 (최신 날짜순 정렬)
  async getVersions() {
    return this.prisma.sysAgentVersion.findMany({
      orderBy: {
        releaseDate: 'desc',
      },
    });
  }

  // 활성화된 플러그인 목록 조회 (정렬 순서 기준)
  async getPlugins() {
    return this.prisma.sysAgentPlugin.findMany({
      where: {
        isActive: 'Y',
      },
      orderBy: {
        sortOrder: 'asc',
      },
    });
  }
}
