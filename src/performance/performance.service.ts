// ITM-Data-API/src/performance/performance.service.ts
import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma.service';
import { Prisma } from '@prisma/client';

@Injectable()
export class PerformanceService {
  constructor(private prisma: PrismaService) {}

  // 1. 장비 성능 이력 조회 (CPU, Memory, Temp 등)
  async getPerformanceHistory(startDate: string, endDate: string, eqpids?: string) {
    const where: Prisma.EqpPerfWhereInput = {
      servTs: {
        gte: new Date(startDate),
        lte: new Date(endDate),
      },
    };

    if (eqpids) {
      const eqpIdList = eqpids.split(',');
      where.eqpid = { in: eqpIdList };
    }

    return this.prisma.eqpPerf.findMany({
      where,
      orderBy: { servTs: 'asc' },
    });
  }

  // 2. 프로세스별 메모리 이력 조회 (Process Memory View)
  async getProcessHistory(
    startDate: string,
    endDate: string,
    eqpId: string,
    interval: number = 60, // 기본 1분 간격
  ) {
    // 데이터량이 많을 수 있으므로 Raw Query로 시간 간격(Grouping) 처리 권장
    // 여기서는 Prisma로 단순 조회 후 애플리케이션 레벨에서 처리하거나,
    // 데이터가 아주 많다면 아래와 같이 date_trunc 등을 사용하는 Raw Query로 최적화 가능
    
    // 단순 조회 방식 (데이터가 적을 때)
    return this.prisma.eqpProcPerf.findMany({
      where: {
        eqpid: eqpId,
        servTs: {
          gte: new Date(startDate),
          lte: new Date(endDate),
        },
      },
      orderBy: { servTs: 'asc' },
    });
  }

  // 3. ITM Agent 프로세스 트렌드 조회 (전체 장비 비교)
  async getItmAgentTrend(site: string, sdwt: string, startDate: string, endDate: string) {
    // 특정 프로세스('ITM Agent' 등)의 메모리 사용량을 장비별로 비교
    // Raw Query로 JOIN 및 필터링 수행
    
    const start = new Date(startDate);
    const end = new Date(endDate);

    let filterSql = Prisma.sql`
      WHERE p.process_name LIKE '%Agent%' 
        AND p.serv_ts >= ${start} 
        AND p.serv_ts <= ${end}
    `;

    if (sdwt) {
      filterSql = Prisma.sql`${filterSql} AND r.sdwt = ${sdwt}`;
    } else if (site) {
      filterSql = Prisma.sql`${filterSql} AND r.sdwt IN (SELECT sdwt FROM public.ref_sdwt WHERE site = ${site})`;
    }

    const results = await this.prisma.$queryRaw`
      SELECT 
        p.serv_ts as timestamp,
        p.eqpid as "processName", -- 차트에서 Series Key로 장비ID 사용
        p.memory_usage_mb as "memoryUsageMB"
      FROM public.eqp_proc_perf p
      JOIN public.ref_equipment r ON p.eqpid = r.eqpid
      ${filterSql}
      ORDER BY p.serv_ts ASC
    `;

    return results;
  }
}
