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

  // 신규 추가: 최신 에이전트 버전을 순수 텍스트로 반환 (Inno Setup 용)
  async getLatestVersionText() {
    // Prisma 스키마에 정의된 낙타표기법(Camel Case) 프로퍼티명 적용
    const latest = await this.prisma.sysAgentVersion.findFirst({
      where: {
        isLatest: 'Y', 
      },
    });
    
    // versionNum 대신 정확한 프로퍼티명인 version 적용
    return latest ? latest.version : '0.0.0.0';
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
