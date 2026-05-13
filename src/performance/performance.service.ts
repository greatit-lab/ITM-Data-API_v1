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
    const startDt = this.parseDate(startDate);
    const endDt = this.parseDate(endDate);
    const safeInterval = (intervalSec && !isNaN(intervalSec) && intervalSec > 0) ? intervalSec : 300; 

    const eqpIdList = eqpids ? eqpids.split(',') : [];
    
    // 당일과 전일 자정을 구함 (로컬 타임 기준)
    // cutoffDate = 어제 00:00:00 (이 시간 이후는 eqp_perf, 이전은 월별 파티션 테이블 조회)
    const cutoffDate = dayjs().startOf('day').subtract(1, 'day').toDate();

    let queries: string[] = [];
    let params: any[] = [];
    let paramIndex = 1;

    // 동적 쿼리 생성기 (UNION ALL을 위해 서브 쿼리 구조화)
    const addQuery = (tableName: string, tStart: Date, tEnd: Date) => {
      let q = `
        SELECT 
          eqpid, 
          serv_ts as "servTs", 
          cpu_usage as "cpuUsage", 
          mem_usage as "memUsage", 
          cpu_temp as "cpuTemp", 
          gpu_temp as "gpuTemp", 
          fan_speed as "fanSpeed" 
        FROM ${tableName} 
        WHERE serv_ts >= $${paramIndex++} AND serv_ts <= $${paramIndex++}
      `;
      params.push(tStart, tEnd);
      
      if (eqpIdList.length > 0) {
         const placeholders = eqpIdList.map(() => `$${paramIndex++}`).join(', ');
         q += ` AND eqpid IN (${placeholders})`;
         params.push(...eqpIdList);
      }
      queries.push(q);
    };

    // 1. 과거 데이터 조회 (월별 파티션 테이블 탐색) -> serv_ts < cutoffDate
    if (startDt < cutoffDate) {
      let currentMonth = dayjs(startDt).startOf('month');
      const endPastDt = endDt < cutoffDate ? endDt : new Date(cutoffDate.getTime() - 1);
      
      while (currentMonth.toDate() <= endPastDt) {
        const yyyy = currentMonth.format('YYYY');
        const mm = currentMonth.format('MM');
        const tableName = `public.eqp_perf_y${yyyy}m${mm}`; // ex: eqp_perf_y2026m04
        
        // 각 월에 해당하는 날짜 경계값만 잘라내서 쿼리 생성
        const mStart = currentMonth.toDate() < startDt ? startDt : currentMonth.toDate();
        const mEnd = currentMonth.endOf('month').toDate() > endPastDt ? endPastDt : currentMonth.endOf('month').toDate();
        
        addQuery(tableName, mStart, mEnd);
        
        currentMonth = currentMonth.add(1, 'month');
      }
    }

    // 2. 최근 데이터 조회 (당일 및 전일 자정 이후 -> eqp_perf 단일 테이블)
    if (endDt >= cutoffDate) {
      const recentStartDt = startDt > cutoffDate ? startDt : cutoffDate;
      addQuery('public.eqp_perf', recentStartDt, endDt);
    }

    let results: any[] = [];
    if (queries.length > 0) {
      // 파티션 테이블들과 현재 테이블 쿼리를 UNION ALL로 결합하고 최종 정렬
      const finalQuery = queries.join(' UNION ALL ') + ' ORDER BY "servTs" ASC';
      try {
        results = await this.prisma.$queryRawUnsafe<any[]>(finalQuery, ...params);
      } catch (e) {
        console.error('getPerformanceHistory partition query error:', e);
        // 테이블이 아직 생성되지 않았거나 권한 에러 방어
        return [];
      }
    }

    // 기존 자바스크립트 기반의 interval(초 단위) 그룹핑 로직은 원형 그대로 유지하여 하위 호환성 보장
    if (safeInterval > 0 && results.length > 0) {
      const grouped = new Map<string, any>();
      
      for (const row of results) {
        // queryRaw로 가져온 servTs는 Date 객체임
        const timeMs = new Date(row.servTs).getTime();
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

  // [성능 개선 및 월별 파티셔닝 적용 완료]
  async getProcessHistory(
    startDate: string,
    endDate: string,
    eqpId: string,
    interval: number = 60,
  ) {
    const startDt = this.parseDate(startDate);
    const endDt = this.parseDate(endDate);
    const safeInterval = interval && !isNaN(interval) && interval > 0 ? interval : 60;

    // cutoffDate = 어제 00:00:00
    const cutoffDate = dayjs().startOf('day').subtract(1, 'day').toDate();

    let queries: string[] = [];
    let params: any[] = [];
    let paramIndex = 1;

    // 파티션 서브 쿼리 구조 생성기
    const addQuery = (tableName: string, tStart: Date, tEnd: Date) => {
      let q = `
        SELECT serv_ts, process_name, memory_usage_mb
        FROM ${tableName}
        WHERE serv_ts >= $${paramIndex++} AND serv_ts <= $${paramIndex++}
          AND eqpid = $${paramIndex++}
      `;
      params.push(tStart, tEnd, eqpId);
      queries.push(q);
    };

    // 1. 과거 데이터 조회
    if (startDt < cutoffDate) {
      let currentMonth = dayjs(startDt).startOf('month');
      const endPastDt = endDt < cutoffDate ? endDt : new Date(cutoffDate.getTime() - 1);
      
      while (currentMonth.toDate() <= endPastDt) {
        const yyyy = currentMonth.format('YYYY');
        const mm = currentMonth.format('MM');
        const tableName = `public.eqp_proc_perf_y${yyyy}m${mm}`;
        
        const mStart = currentMonth.toDate() < startDt ? startDt : currentMonth.toDate();
        const mEnd = currentMonth.endOf('month').toDate() > endPastDt ? endPastDt : currentMonth.endOf('month').toDate();
        
        addQuery(tableName, mStart, mEnd);
        
        currentMonth = currentMonth.add(1, 'month');
      }
    }

    // 2. 최신 데이터 조회 
    if (endDt >= cutoffDate) {
      const recentStartDt = startDt > cutoffDate ? startDt : cutoffDate;
      addQuery('public.eqp_proc_perf', recentStartDt, endDt);
    }

    if (queries.length === 0) return [];

    const unionQuery = queries.join(' UNION ALL ');

    const finalQuery = `
      SELECT 
        to_timestamp(
          (floor(extract(epoch from serv_ts) / ${safeInterval}) * ${safeInterval})
        ) AT TIME ZONE 'UTC' as timestamp,
        process_name as "processName",
        MAX(memory_usage_mb) as "memoryUsageMB"
      FROM (
        ${unionQuery}
      ) as combined_data
      GROUP BY 1, 2
      ORDER BY timestamp ASC
    `;

    try {
      const results = await this.prisma.$queryRawUnsafe<any[]>(finalQuery, ...params);

      return results.map((row: any) => ({
        timestamp: dayjs.utc(row.timestamp).format('YYYY-MM-DD HH:mm:ss'),
        processName: row.processName,
        memoryUsageMB: Number(row.memoryUsageMB) || 0, 
      }));
    } catch (e) {
      console.error('getProcessHistory query error:', e);
      return [];
    }
  }

  // [성능 최종 최적화 및 파티셔닝 적용] ITM Agent 데이터 동적 라우팅 및 CTE 기반 최적화
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
    
    // cutoffDate = 어제 00:00:00
    const cutoffDate = dayjs().startOf('day').subtract(1, 'day').toDate();

    // 동적 파티션 쿼리 생성을 위한 Helper 함수 (Fallback 처리 지원)
    const buildQuery = (isFallback: boolean) => {
      let queries: string[] = [];
      let params: any[] = [];
      let paramIndex = 1;

      const addQuery = (tableName: string, tStart: Date, tEnd: Date) => {
        let q = `
          SELECT serv_ts, eqpid, memory_usage_mb
          ${isFallback ? ', 0::numeric as memory_commit_mb' : ', memory_commit_mb'}
          FROM ${tableName}
          WHERE serv_ts >= $${paramIndex++} AND serv_ts <= $${paramIndex++}
            AND process_name IN ('ITM_Agent', 'ITMAgent', 'ITM-Agent', 'itm_agent', 'itmagent', 'itm-agent')
        `;
        params.push(tStart, tEnd);

        if (eqpid) {
          q += ` AND eqpid = $${paramIndex++}`;
          params.push(eqpid);
        }
        queries.push(q);
      };

      // 1. 과거 데이터 (월별 테이블)
      if (startDt < cutoffDate) {
        let currentMonth = dayjs(startDt).startOf('month');
        const endPastDt = endDt < cutoffDate ? endDt : new Date(cutoffDate.getTime() - 1);
        
        while (currentMonth.toDate() <= endPastDt) {
          const yyyy = currentMonth.format('YYYY');
          const mm = currentMonth.format('MM');
          const tableName = `public.eqp_proc_perf_y${yyyy}m${mm}`;
          
          const mStart = currentMonth.toDate() < startDt ? startDt : currentMonth.toDate();
          const mEnd = currentMonth.endOf('month').toDate() > endPastDt ? endPastDt : currentMonth.endOf('month').toDate();
          
          addQuery(tableName, mStart, mEnd);
          currentMonth = currentMonth.add(1, 'month');
        }
      }

      // 2. 최신 데이터 (기본 테이블)
      if (endDt >= cutoffDate) {
        const recentStartDt = startDt > cutoffDate ? startDt : cutoffDate;
        addQuery('public.eqp_proc_perf', recentStartDt, endDt);
      }

      // 외부 조인용 필터 추가
      let outerFilters = "";
      if (site) {
        outerFilters += ` AND s.site = $${paramIndex++}`;
        params.push(site);
      }
      if (sdwt) {
        outerFilters += ` AND r.sdwt = $${paramIndex++}`;
        params.push(sdwt);
      }

      const unionQuery = queries.length > 0 ? queries.join(' UNION ALL ') : '';

      const finalQuery = unionQuery ? `
        WITH AggregatedData AS (
          SELECT 
            to_timestamp(
              (floor(extract(epoch from serv_ts) / ${safeInterval}) * ${safeInterval})
            ) AT TIME ZONE 'UTC' as timestamp,
            eqpid,
            MAX(memory_usage_mb) as memory_usage_mb,
            MAX(memory_commit_mb) as memory_commit_mb
          FROM (
            ${unionQuery}
          ) as combined_data
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
        WHERE 1=1 ${outerFilters}
        ORDER BY a.timestamp ASC
      ` : '';

      return { finalQuery, params, hasQueries: queries.length > 0 };
    };

    try {
      const { finalQuery, params, hasQueries } = buildQuery(false);
      if (!hasQueries) return [];
      
      const results = await this.prisma.$queryRawUnsafe<any[]>(finalQuery, ...params);
      
      return results.map(r => ({
        ...r,
        timestamp: dayjs.utc(r.timestamp).format('YYYY-MM-DD HH:mm:ss')
      }));

    } catch (e) {
      console.warn('getItmAgentTrend fallback triggered (commit_mb column missing in some partitions)');
      // Fallback: 파티션 테이블들 중 일부에 memory_commit_mb 컬럼이 없을 경우를 방어
      const { finalQuery, params, hasQueries } = buildQuery(true);
      if (!hasQueries) return [];
      
      const fallbackResults = await this.prisma.$queryRawUnsafe<any[]>(finalQuery, ...params);
      
      return fallbackResults.map(r => ({
        ...r,
        timestamp: dayjs.utc(r.timestamp).format('YYYY-MM-DD HH:mm:ss')
      }));
    }
  }
}
