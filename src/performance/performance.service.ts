// ITM-Data-API/src/performance/performance.service.ts
import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma.service';

@Injectable()
export class PerformanceService {
  constructor(private prisma: PrismaService) {}

  // 1. 시스템 성능 이력
  async getSystemPerformance(eqpIds: string[], start: string, end: string) {
    // [수정] logSystemPerformance -> eqpPerf
    return this.prisma.eqpPerf.findMany({
      where: {
        eqpid: { in: eqpIds },
        servTs: { gte: new Date(start), lte: new Date(end) }, // [수정] timestamp -> servTs
      },
      orderBy: { servTs: 'asc' },
    });
  }

  // 2. 프로세스별 메모리 이력
  async getProcessPerformance(eqpId: string, start: string, end: string) {
    // [수정] logProcessPerformance -> eqpProcPerf
    return this.prisma.eqpProcPerf.findMany({
      where: {
        eqpid: eqpId,
        servTs: { gte: new Date(start), lte: new Date(end) }, // [수정] timestamp -> servTs
      },
      orderBy: { servTs: 'asc' },
    });
  }

  // 3. ITM Agent 트렌드
  async getItmAgentTrend(site: string, sdwt: string, start: string, end: string) {
    // [수정] logProcessPerformance -> eqpProcPerf
    return this.prisma.eqpProcPerf.findMany({
      where: {
        processName: 'ITM_Agent',
        servTs: { gte: new Date(start), lte: new Date(end) }, // [수정] timestamp -> servTs
        // site, sdwt 조인이 필요하다면 prisma include 또는 raw query 사용 필요
        // 현재는 단일 테이블 조회로 유지
      },
      orderBy: { servTs: 'asc' },
    });
  }
}
