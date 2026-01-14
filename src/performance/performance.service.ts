// ITM-Data-API/src/performance/performance.service.ts
import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma.service';
import { Prisma } from '@prisma/client';

@Injectable()
export class PerformanceService {
  constructor(private prisma: PrismaService) {}

  // 1. 장비 성능 이력 조회
  async getPerformanceHistory(
    startDate: string,
    endDate: string,
    eqpids?: string,
  ) {
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

    const results = await this.prisma.eqpPerf.findMany({
      where,
      orderBy: { servTs: 'asc' },
    });

    return results.map((row) => ({
      eqpId: row.eqpid,
      timestamp: row.servTs,
      cpuUsage: row.cpuUsage,
      memoryUsage: row.memUsage,
      cpuTemp: row.cpuTemp,
      gpuTemp: row.gpuTemp,
      fanSpeed: row.fanSpeed,
    }));
  }

  // 2. 프로세스별 메모리 이력 조회
  async getProcessHistory(
    startDate: string,
    endDate: string,
    eqpId: string,
    interval: number = 60,
  ) {
    const results = await this.prisma.eqpProcPerf.findMany({
      where: {
        eqpid: eqpId,
        servTs: {
          gte: new Date(startDate),
          lte: new Date(endDate),
        },
      },
      orderBy: { servTs: 'asc' },
    });

    return results.map((row: any) => ({
      timestamp: row.servTs,
      processName: row.processName,
      memoryUsageMB: row.memoryUsageMb ?? row.memoryUsageMB ?? 0,
    }));
  }

  // 3. ITM Agent 프로세스 트렌드 조회
  async getItmAgentTrend(
    site: string,
    sdwt: string,
    startDate: string,
    endDate: string,
    eqpid?: string,
    interval: number = 60,
  ) {
    const start = new Date(startDate);
    const end = new Date(endDate);

    let filterSql = Prisma.sql`
      WHERE p.process_name LIKE '%Agent%' 
        AND p.serv_ts >= ${start} 
        AND p.serv_ts <= ${end}
    `;

    if (eqpid) {
      filterSql = Prisma.sql`${filterSql} AND p.eqpid = ${eqpid}`;
    }

    if (sdwt) {
      filterSql = Prisma.sql`${filterSql} AND r.sdwt = ${sdwt}`;
    } else if (site) {
      filterSql = Prisma.sql`${filterSql} AND r.sdwt IN (SELECT sdwt FROM public.ref_sdwt WHERE site = ${site})`;
    }

    // [수정] public.agent_info 테이블의 app_ver 컬럼 조회
    const results = await this.prisma.$queryRaw`
      SELECT 
        to_timestamp(floor(extract(epoch from p.serv_ts) / ${interval}) * ${interval}) as timestamp,
        p.eqpid as "eqpId",
        MAX(p.memory_usage_mb) as "memoryUsageMB",
        MAX(i.app_ver) as "agentVersion"
      FROM public.eqp_proc_perf p
      JOIN public.ref_equipment r ON p.eqpid = r.eqpid
      LEFT JOIN public.agent_info i ON r.eqpid = i.eqpid
      ${filterSql}
      GROUP BY 1, 2
      ORDER BY 1 ASC
    `;

    return results;
  }
}
