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

  // [성능 개선 완료] 25초 병목의 원인인 DB 스캔 및 조인 쿼리 최적화
  async getItmAgentTrend(
    site: string,
    sdwt: string,
    startDate: string,
    endDate: string,
    eqpid?: string,
    interval: number = 60,
  ) {
    
    // 1. 조건에 맞는 장비(eqpid) 목록을 먼저 조회하여 본 쿼리의 탐색 범위(Full Scan)를 획기적으로 축소
    let targetEqpIds: string[] = [];
    const hasSiteOrSdwtFilter = site || sdwt;
    
    if (hasSiteOrSdwtFilter && !eqpid) {
      const eqps = await this.prisma.refEquipment.findMany({
        where: {
          sdwtRel: {
            ...(site ? { site: site } : {}),
          },
          ...(sdwt ? { sdwt: sdwt } : {})
        },
        select: { eqpid: true }
      });
      targetEqpIds = eqps.map(e => e.eqpid);
      
      // 필터에 맞는 장비가 없다면 복잡한 쿼리를 돌릴 필요 없이 즉시 빈 배열 반환
      if (targetEqpIds.length === 0) return [];
    }

    // 2. 엄청나게 느린 ILIKE 와일드카드 검색을 버리고 명시적 IN 구문 사용
    let filterSql = Prisma.sql`
      WHERE p.process_name IN ('ITM_Agent', 'ITMAgent', 'ITM-Agent', 'itm_agent', 'itmagent', 'itm-agent')
        AND p.serv_ts >= CAST(${startDate} AS TIMESTAMP)
        AND p.serv_ts <= CAST(${endDate} AS TIMESTAMP)
    `;

    if (eqpid) {
      filterSql = Prisma.sql`${filterSql} AND p.eqpid = ${eqpid}`;
    } else if (targetEqpIds.length > 0) {
      filterSql = Prisma.sql`${filterSql} AND p.eqpid IN (${Prisma.join(targetEqpIds)})`;
    }

    // 3. 4개 테이블을 JOIN 하기 전에 1개 대상 테이블만 먼저 묶어버리는 CTE(WITH 절) 구조 도입
    try {
      const results = await this.prisma.$queryRaw`
        WITH AggregatedData AS (
          SELECT 
            to_timestamp(
              (floor(extract(epoch from p.serv_ts AT TIME ZONE 'UTC') / ${Prisma.raw(interval.toString())}) * ${Prisma.raw(interval.toString())})::double precision
            ) AT TIME ZONE 'UTC' as timestamp,
            p.eqpid,
            MAX(p.memory_usage_mb) as memory_usage_mb,
            MAX(p.memory_commit_mb) as memory_commit_mb
          FROM public.eqp_proc_perf p
          ${filterSql}
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
        ORDER BY a.timestamp ASC
      `;

      return (results as any[]).map(r => ({
        ...r,
        timestamp: dayjs.utc(r.timestamp).format('YYYY-MM-DD HH:mm:ss')
      }));

    } catch (e) {
      // Fallback
      const fallbackResults = await this.prisma.$queryRaw`
        WITH AggregatedData AS (
          SELECT 
            to_timestamp(
              (floor(extract(epoch from p.serv_ts AT TIME ZONE 'UTC') / ${Prisma.raw(interval.toString())}) * ${Prisma.raw(interval.toString())})::double precision
            ) AT TIME ZONE 'UTC' as timestamp,
            p.eqpid,
            MAX(p.memory_usage_mb) as memory_usage_mb,
            0::numeric as memory_commit_mb
          FROM public.eqp_proc_perf p
          ${filterSql}
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
        ORDER BY a.timestamp ASC
      `;

      return (fallbackResults as any[]).map(r => ({
        ...r,
        timestamp: dayjs.utc(r.timestamp).format('YYYY-MM-DD HH:mm:ss')
      }));
    }
  }
}
