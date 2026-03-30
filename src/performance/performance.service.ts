// ITM-Data-API_v1/src/performance/performance.service.ts
import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma.service';
import { Prisma } from '@prisma/client';
import dayjs from 'dayjs';
import utc from 'dayjs/plugin/utc';

// [완벽 방어] Prisma Raw Query가 반환하는 BigInt 타입을 NestJS가 JSON으로 직렬화할 수 있도록 전역 패치 적용
if (typeof (BigInt.prototype as any).toJSON === 'undefined') {
  (BigInt.prototype as any).toJSON = function () {
    return Number(this);
  };
}

dayjs.extend(utc);

@Injectable()
export class PerformanceService {
  constructor(private prisma: PrismaService) {}

  private parseDate(dateStr: string): Date {
    return dayjs.utc(dateStr).toDate();
  }

  async getPerformanceHistory(
    startDate: string,
    endDate: string,
    eqpids?: string,
    intervalSec: number = 300, 
  ) {
    const safeInterval = (intervalSec && !isNaN(intervalSec) && intervalSec > 0) ? intervalSec : 300; 

    const where: Prisma.EqpPerfWhereInput = {
      servTs: {
        gte: this.parseDate(startDate), 
        lte: this.parseDate(endDate),   
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

    if (safeInterval > 0 && results.length > 0) {
      const grouped = new Map<string, any>();
      
      for (const row of results) {
        const timeMs = row.servTs.getTime();
        const bucketTime = Math.floor(timeMs / (safeInterval * 1000)) * (safeInterval * 1000);
        const bucketKey = `${row.eqpid}_${bucketTime}`;
        
        if (!grouped.has(bucketKey)) {
          grouped.set(bucketKey, {
            count: 1,
            eqpid: row.eqpid,
            servTs: new Date(bucketTime),
            cpuUsage: row.cpuUsage ? Number(row.cpuUsage) : 0,
            memUsage: row.memUsage ? Number(row.memUsage) : 0,
            cpuTemp: row.cpuTemp ? Number(row.cpuTemp) : 0,
            gpuTemp: row.gpuTemp ? Number(row.gpuTemp) : 0,
            fanSpeed: row.fanSpeed ? Number(row.fanSpeed) : 0,
          });
        } else {
          const bucket = grouped.get(bucketKey);
          bucket.count++;
          bucket.cpuUsage += row.cpuUsage ? Number(row.cpuUsage) : 0;
          bucket.memUsage += row.memUsage ? Number(row.memUsage) : 0;
          bucket.cpuTemp += row.cpuTemp ? Number(row.cpuTemp) : 0;
          bucket.gpuTemp += row.gpuTemp ? Number(row.gpuTemp) : 0;
          bucket.fanSpeed += row.fanSpeed ? Number(row.fanSpeed) : 0;
        }
      }

      return Array.from(grouped.values()).map((bucket) => ({
        eqpId: bucket.eqpid,
        timestamp: dayjs.utc(bucket.servTs).format('YYYY-MM-DD HH:mm:ss'),
        cpuUsage: Number((bucket.cpuUsage / bucket.count).toFixed(2)),
        memoryUsage: Number((bucket.memUsage / bucket.count).toFixed(2)),
        cpuTemp: Number((bucket.cpuTemp / bucket.count).toFixed(2)),
        gpuTemp: Number((bucket.gpuTemp / bucket.count).toFixed(2)),
        fanSpeed: Number((bucket.fanSpeed / bucket.count).toFixed(2)),
      })).sort((a, b) => a.timestamp.localeCompare(b.timestamp));
    }

    return results.map((row) => ({
      eqpId: row.eqpid,
      timestamp: dayjs.utc(row.servTs).format('YYYY-MM-DD HH:mm:ss'),
      cpuUsage: row.cpuUsage,
      memoryUsage: row.memUsage,
      cpuTemp: row.cpuTemp,
      gpuTemp: row.gpuTemp,
      fanSpeed: row.fanSpeed,
    }));
  }

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
          gte: this.parseDate(startDate), 
          lte: this.parseDate(endDate),   
        },
      },
      orderBy: { servTs: 'asc' },
    });

    return results.map((row: any) => ({
      timestamp: dayjs.utc(row.servTs).format('YYYY-MM-DD HH:mm:ss'),
      processName: row.processName,
      memoryUsageMB: row.memoryUsageMB ?? row.memoryUsageMb ?? 0, 
    }));
  }

  async getItmAgentTrend(
    site: string,
    sdwt: string,
    startDate: string,
    endDate: string,
    eqpid?: string,
    interval: number = 60,
  ) {
    // [수정] 광범위한 '%agent%' 와일드카드 제거 (SQLAgent, ZabbixAgent 등 타 프로세스 오탐지 원천 차단)
    // 실제 ITM Agent의 실행 파일명으로 사용될 수 있는 명확한 패턴만 엄격하게 매핑
    let filterSql = Prisma.sql`
      WHERE (p.process_name ILIKE 'ITM_Agent' OR p.process_name ILIKE 'ITMAgent' OR p.process_name ILIKE 'ITM-Agent')
        AND p.serv_ts >= CAST(${startDate} AS TIMESTAMP)
        AND p.serv_ts <= CAST(${endDate} AS TIMESTAMP)
    `;

    if (eqpid) {
      filterSql = Prisma.sql`${filterSql} AND p.eqpid = ${eqpid}`;
    }

    if (sdwt) {
      filterSql = Prisma.sql`${filterSql} AND r.sdwt = ${sdwt}`;
    } else if (site) {
      filterSql = Prisma.sql`${filterSql} AND r.sdwt IN (SELECT sdwt FROM public.ref_sdwt WHERE site = ${site})`;
    }

    try {
      const results = await this.prisma.$queryRaw`
        SELECT 
          to_timestamp(
            (floor(extract(epoch from p.serv_ts AT TIME ZONE 'UTC') / ${Prisma.raw(interval.toString())}) * ${Prisma.raw(interval.toString())})::double precision
          ) AT TIME ZONE 'UTC' as timestamp,
          p.eqpid as "eqpId",
          s.site as "site",
          r.sdwt as "sdwt",
          MAX(p.memory_usage_mb) as "memoryUsageMB",
          MAX(p.memory_commit_mb) as "memoryCommitMB", 
          MAX(i.app_ver) as "agentVersion"
        FROM public.eqp_proc_perf p
        LEFT JOIN public.ref_equipment r ON p.eqpid = r.eqpid
        LEFT JOIN public.ref_sdwt s ON r.sdwt = s.sdwt
        LEFT JOIN public.agent_info i ON p.eqpid = i.eqpid
        ${filterSql}
        GROUP BY 1, 2, 3, 4
        ORDER BY 1 ASC
      `;

      return (results as any[]).map(r => ({
        ...r,
        timestamp: dayjs.utc(r.timestamp).format('YYYY-MM-DD HH:mm:ss')
      }));

    } catch (e) {
      const fallbackResults = await this.prisma.$queryRaw`
        SELECT 
          to_timestamp(
            (floor(extract(epoch from p.serv_ts AT TIME ZONE 'UTC') / ${Prisma.raw(interval.toString())}) * ${Prisma.raw(interval.toString())})::double precision
          ) AT TIME ZONE 'UTC' as timestamp,
          p.eqpid as "eqpId",
          s.site as "site",
          r.sdwt as "sdwt",
          MAX(p.memory_usage_mb) as "memoryUsageMB",
          0::numeric as "memoryCommitMB", 
          MAX(i.app_ver) as "agentVersion"
        FROM public.eqp_proc_perf p
        LEFT JOIN public.ref_equipment r ON p.eqpid = r.eqpid
        LEFT JOIN public.ref_sdwt s ON r.sdwt = s.sdwt
        LEFT JOIN public.agent_info i ON p.eqpid = i.eqpid
        ${filterSql}
        GROUP BY 1, 2, 3, 4
        ORDER BY 1 ASC
      `;

      return (fallbackResults as any[]).map(r => ({
        ...r,
        timestamp: dayjs.utc(r.timestamp).format('YYYY-MM-DD HH:mm:ss')
      }));
    }
  }
}
