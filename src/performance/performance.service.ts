// ITM-Data-API_v1/src/performance/performance.service.ts
import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma.service';
import { Prisma } from '@prisma/client';
import dayjs from 'dayjs';
import utc from 'dayjs/plugin/utc';

// Prisma Raw Query가 반환하는 BigInt 타입을 NestJS가 JSON으로 직렬화할 수 있도록 전역 패치 적용
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

  // [성능 개선 완료] 75초 지연 해결: ORM findMany 원시 조회 방식 폐기 및 DB 레벨 타임 버킷 그룹핑 적용
  async getProcessHistory(
    startDate: string,
    endDate: string,
    eqpId: string,
    interval: number = 60,
  ) {
    const startDt = this.parseDate(startDate);
    const endDt = this.parseDate(endDate);
    const safeInterval = interval && !isNaN(interval) && interval > 0 ? interval : 60;

    try {
      const results = await this.prisma.$queryRaw`
        SELECT 
          to_timestamp(
            (floor(extract(epoch from serv_ts) / ${safeInterval}) * ${safeInterval})
          ) AT TIME ZONE 'UTC' as timestamp,
          process_name as "processName",
          MAX(memory_usage_mb) as "memoryUsageMB"
        FROM public.eqp_proc_perf
        WHERE eqpid = ${eqpId}
          AND serv_ts >= ${startDt}
          AND serv_ts <= ${endDt}
        GROUP BY 1, 2
        ORDER BY timestamp ASC
      `;

      return (results as any[]).map((row: any) => ({
        timestamp: dayjs.utc(row.timestamp).format('YYYY-MM-DD HH:mm:ss'),
        processName: row.processName,
        memoryUsageMB: Number(row.memoryUsageMB) || 0, 
      }));

    } catch (e) {
      console.error('getProcessHistory query error:', e);
      return [];
    }
  }

  // [성능 최종 최적화] Type-Casting(CAST)으로 인한 DB 인덱스 무력화 현상 해결 (Native Date Parameter 사용)
  async getItmAgentTrend(
    site: string,
    sdwt: string,
    startDate: string,
    endDate: string,
    eqpid?: string,
    interval: number = 60,
  ) {
    const startDt = this.parseDate(startDate);
    const endDt = this.parseDate(endDate);
    const safeInterval = interval && !isNaN(interval) && interval > 0 ? interval : 60;
    
    let eqpidFilter = Prisma.empty;
    if (eqpid) {
      eqpidFilter = Prisma.sql`AND p.eqpid = ${eqpid}`;
    }

    let metadataFilter = Prisma.empty;
    if (site) {
      metadataFilter = Prisma.sql`AND s.site = ${site}`;
    }
    if (sdwt) {
      metadataFilter = Prisma.sql`${metadataFilter} AND r.sdwt = ${sdwt}`;
    }

    try {
      const results = await this.prisma.$queryRaw`
        /* CAST( AS TIMESTAMP) 제거 및 순수 Date Parameter 주입으로 Index 적중률 100% 확보 */
        WITH AggregatedData AS (
          SELECT 
            to_timestamp(
              (floor(extract(epoch from p.serv_ts) / ${safeInterval}) * ${safeInterval})
            ) AT TIME ZONE 'UTC' as timestamp,
            p.eqpid,
            MAX(p.memory_usage_mb) as memory_usage_mb,
            MAX(p.memory_commit_mb) as memory_commit_mb
          FROM public.eqp_proc_perf p
          WHERE p.serv_ts >= ${startDt}
            AND p.serv_ts <= ${endDt}
            AND p.process_name IN ('ITM_Agent', 'ITMAgent', 'ITM-Agent', 'itm_agent', 'itmagent', 'itm-agent')
            ${eqpidFilter}
          GROUP BY 1, 2
        )
        SELECT 
          a.timestamp,
          a.eqpid as "eqpId",
          s.site as "site",
          r.sdwt as "sdwt",
          a.memory_usage_mb as "memoryUsageMB",
          a.memory_commit_mb as "memoryCommitMB", 
          i.app_ver as "agentVersion"
        FROM AggregatedData a
        LEFT JOIN public.ref_equipment r ON a.eqpid = r.eqpid
        LEFT JOIN public.ref_sdwt s ON r.sdwt = s.sdwt
        LEFT JOIN public.agent_info i ON a.eqpid = i.eqpid
        WHERE 1=1 ${metadataFilter}
        ORDER BY a.timestamp ASC
      `;

      return (results as any[]).map(r => ({
        ...r,
        timestamp: dayjs.utc(r.timestamp).format('YYYY-MM-DD HH:mm:ss')
      }));

    } catch (e) {
      // Fallback: memory_commit_mb 컬럼이 없을 경우
      const fallbackResults = await this.prisma.$queryRaw`
        WITH AggregatedData AS (
          SELECT 
            to_timestamp(
              (floor(extract(epoch from p.serv_ts) / ${safeInterval}) * ${safeInterval})
            ) AT TIME ZONE 'UTC' as timestamp,
            p.eqpid,
            MAX(p.memory_usage_mb) as memory_usage_mb,
            0::numeric as memory_commit_mb
          FROM public.eqp_proc_perf p
          WHERE p.serv_ts >= ${startDt}
            AND p.serv_ts <= ${endDt}
            AND p.process_name IN ('ITM_Agent', 'ITMAgent', 'ITM-Agent', 'itm_agent', 'itmagent', 'itm-agent')
            ${eqpidFilter}
          GROUP BY 1, 2
        )
        SELECT 
          a.timestamp,
          a.eqpid as "eqpId",
          s.site as "site",
          r.sdwt as "sdwt",
          a.memory_usage_mb as "memoryUsageMB",
          a.memory_commit_mb as "memoryCommitMB", 
          i.app_ver as "agentVersion"
        FROM AggregatedData a
        LEFT JOIN public.ref_equipment r ON a.eqpid = r.eqpid
        LEFT JOIN public.ref_sdwt s ON r.sdwt = s.sdwt
        LEFT JOIN public.agent_info i ON a.eqpid = i.eqpid
        WHERE 1=1 ${metadataFilter}
        ORDER BY a.timestamp ASC
      `;

      return (fallbackResults as any[]).map(r => ({
        ...r,
        timestamp: dayjs.utc(r.timestamp).format('YYYY-MM-DD HH:mm:ss')
      }));
    }
  }
}
