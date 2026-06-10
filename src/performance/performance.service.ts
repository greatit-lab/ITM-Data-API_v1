// ITM-Data-API_v1/src/performance/performance.service.ts
import { Injectable, OnModuleDestroy, OnModuleInit, BadRequestException } from '@nestjs/common';
import { PrismaService } from '../prisma.service';
import { PrismaClient } from '@prisma/client';
import dayjs from 'dayjs';
import utc from 'dayjs/plugin/utc';

// DB에서 넘어오는 BigInt 처리를 위한 전역 패치
if (typeof (BigInt.prototype as any).toJSON === 'undefined') {
  (BigInt.prototype as any).toJSON = function () {
    return Number(this);
  };
}

dayjs.extend(utc);

@Injectable()
export class PerformanceService implements OnModuleInit, OnModuleDestroy {
  // DBaaS 아카이브 전용 독립 커넥션 풀
  private archivePrisma: PrismaClient;

  constructor(private prisma: PrismaService) {}

  onModuleInit() {
    this.archivePrisma = new PrismaClient({
      datasources: {
        db: {
          url: process.env.ARCHIVE_DATABASE_URL,
        },
      },
    });
  }

  async onModuleDestroy() {
    if (this.archivePrisma) {
      await this.archivePrisma.$disconnect();
    }
  }

  private parseDate(dateStr: string): Date {
    return dayjs.utc(dateStr).toDate();
  }

  // 오늘, 전일 뺀 나머지 = 어제 자정 이전
  private getCutoffDate(): Date {
    return dayjs().startOf('day').subtract(1, 'day').toDate();
  }

  private validateArchiveLimit(startDt: Date, endDt: Date, cutoffDate: Date) {
    if (startDt < cutoffDate) { 
      const maxDays = Number(process.env.ARCHIVE_MAX_SEARCH_DAYS) || 31;
      const diffDays = dayjs(endDt).diff(dayjs(startDt), 'day');
      
      if (diffDays > maxDays) {
        throw new BadRequestException(
          `과거 데이터(오늘, 전일 제외)는 시스템 보호를 위해 한 번에 최대 ${maxDays}일까지만 조회할 수 있습니다. 기간을 좁혀서 다시 조회해 주세요.`
        );
      }
    }
  }

  // =========================================================================
  // 1. 장비 성능 내역 (Performance History)
  // =========================================================================
  async getPerformanceHistory(
    startDate: string,
    endDate: string,
    eqpids?: string,
    intervalSec: number = 300, 
  ) {
    const startDt = this.parseDate(startDate);
    const endDt = this.parseDate(endDate);
    const parsedInterval = Number(intervalSec);
    const safeInterval = (!isNaN(parsedInterval) && parsedInterval > 0) ? parsedInterval : 300; 

    const cutoffDate = this.getCutoffDate();
    this.validateArchiveLimit(startDt, endDt, cutoffDate); 

    const eqpIdList = eqpids ? eqpids.split(',') : [];

    const buildQuery = (tableName: string, tStart: Date, tEnd: Date) => {
      let params: any[] = [tStart, tEnd];
      let eqpFilterSql = '';

      if (eqpIdList.length > 0) {
        const placeholders = eqpIdList.map((_, i) => `$${i + 3}`).join(',');
        eqpFilterSql = `AND eqpid IN (${placeholders})`;
        params.push(...eqpIdList);
      }

      const sql = `
        SELECT 
          eqpid as "eqpId", 
          to_timestamp(
            (floor(extract(epoch from serv_ts) / ${safeInterval}) * ${safeInterval})
          ) AT TIME ZONE 'UTC' as "servTs", 
          AVG(cpu_usage) as "cpuUsage", 
          AVG(mem_usage) as "memUsage", 
          AVG(cpu_temp) as "cpuTemp", 
          AVG(gpu_temp) as "gpuTemp", 
          AVG(fan_speed) as "fanSpeed" 
        FROM ${tableName} 
        WHERE serv_ts >= $1 AND serv_ts <= $2
        ${eqpFilterSql}
        GROUP BY 1, 2
      `;
      return { sql, params };
    };
    
    let archivePromise = Promise.resolve([] as any[]);

    // [라우팅 1] DBaaS 직접 조회 (eqp_perf_archive)
    if (startDt < cutoffDate) {
      const endPastDt = endDt < cutoffDate ? endDt : new Date(cutoffDate.getTime() - 1);
      const { sql, params } = buildQuery('public.eqp_perf_archive', startDt, endPastDt);
      
      archivePromise = this.archivePrisma.$queryRawUnsafe<any[]>(sql, ...params).catch(e => {
        console.warn(`[ITM-Data-API] DBaaS Archive Query Failed: ${e.message}`);
        return [];
      });
    }

    // [라우팅 2] 최신 데이터 로컬 조회 (eqp_perf)
    if (endDt >= cutoffDate) {
      const recentStartDt = startDt > cutoffDate ? startDt : cutoffDate;
      const { sql, params } = buildQuery('public.eqp_perf', recentStartDt, endDt);

      archivePromise = archivePromise.then(async (archiveRows) => {
        try {
          const localRows = await this.prisma.$queryRawUnsafe<any[]>(sql, ...params);
          return [...archiveRows, ...localRows];
        } catch (e) {
          console.warn(`[ITM-Data-API] Local VM Query Failed: ${(e as Error).message}`);
          return archiveRows;
        }
      });
    }

    const allResults = await archivePromise;

    return allResults.map(row => ({
       eqpId: row.eqpId,
       timestamp: dayjs.utc(row.servTs).format('YYYY-MM-DD HH:mm:ss'),
       cpuUsage: Number(Number(row.cpuUsage).toFixed(2)),
       memoryUsage: Number(Number(row.memUsage).toFixed(2)),
       cpuTemp: Number(Number(row.cpuTemp).toFixed(2)),
       gpuTemp: Number(Number(row.gpuTemp).toFixed(2)),
       fanSpeed: Number(Number(row.fanSpeed).toFixed(2))
    })).sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  }


  // =========================================================================
  // 2. 프로세스 메모리 내역 (Process History) - DBaaS 연결 개선
  // =========================================================================
  async getProcessHistory(
    startDate: string,
    endDate: string,
    eqpId: string,
    interval: number = 60,
  ) {
    const startDt = this.parseDate(startDate);
    const endDt = this.parseDate(endDate);
    const parsedInterval = Number(interval);
    const safeInterval = (!isNaN(parsedInterval) && parsedInterval > 0) ? parsedInterval : 60;
    
    const cutoffDate = this.getCutoffDate();
    this.validateArchiveLimit(startDt, endDt, cutoffDate);

    const buildQuery = (tableName: string, tStart: Date, tEnd: Date) => {
      const sql = `
        SELECT 
          to_timestamp(
            (floor(extract(epoch from serv_ts) / ${safeInterval}) * ${safeInterval})
          ) AT TIME ZONE 'UTC' as "servTs",
          process_name as "processName",
          MAX(memory_usage_mb) as "memoryUsageMB"
        FROM ${tableName}
        WHERE serv_ts >= $1 AND serv_ts <= $2
          AND eqpid = $3
        GROUP BY 1, 2
      `;
      return { sql, params: [tStart, tEnd, eqpId] };
    };

    let archivePromise = Promise.resolve([] as any[]);

    // [라우팅 1] DBaaS 직접 조회 (eqp_proc_perf_archive)
    if (startDt < cutoffDate) {
      const endPastDt = endDt < cutoffDate ? endDt : new Date(cutoffDate.getTime() - 1);
      const { sql, params } = buildQuery('public.eqp_proc_perf_archive', startDt, endPastDt);
      
      archivePromise = this.archivePrisma.$queryRawUnsafe<any[]>(sql, ...params).catch(e => {
        console.warn(`[ITM-Data-API] Process DBaaS Failed: ${e.message}`);
        return [];
      });
    }

    // [라우팅 2] 최신 데이터 로컬 조회 (eqp_proc_perf)
    if (endDt >= cutoffDate) {
      const recentStartDt = startDt > cutoffDate ? startDt : cutoffDate;
      const { sql, params } = buildQuery('public.eqp_proc_perf', recentStartDt, endDt);
      
      archivePromise = archivePromise.then(async (archiveRows) => {
        try {
          const localRows = await this.prisma.$queryRawUnsafe<any[]>(sql, ...params);
          return [...archiveRows, ...localRows];
        } catch (e) {
          return archiveRows;
        }
      });
    }

    const allResults = await archivePromise;

    return allResults.map(row => ({
       timestamp: dayjs.utc(row.servTs).format('YYYY-MM-DD HH:mm:ss'),
       processName: row.processName,
       memoryUsageMB: Number(row.memoryUsageMB) || 0
    })).sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  }


  // =========================================================================
  // 3. ITM Agent 트렌드 - DBaaS 연결 개선
  // =========================================================================
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
    const parsedInterval = Number(interval);
    const safeInterval = (!isNaN(parsedInterval) && parsedInterval > 0) ? parsedInterval : 60;
    
    const cutoffDate = this.getCutoffDate();
    this.validateArchiveLimit(startDt, endDt, cutoffDate);

    const buildQuery = (tableName: string, tStart: Date, tEnd: Date) => {
      let pIdx = 3;
      let params: any[] = [tStart, tEnd];
      let eqpFilter = '';
      let siteFilter = '';
      let sdwtFilter = '';

      if (eqpid) {
        eqpFilter = `AND a.eqpid = $${pIdx++}`;
        params.push(eqpid);
      }
      if (site) {
        siteFilter = `AND s.site = $${pIdx++}`;
        params.push(site);
      }
      if (sdwt) {
        sdwtFilter = `AND r.sdwt = $${pIdx++}`;
        params.push(sdwt);
      }

      const sql = `
        SELECT 
          to_timestamp(
            (floor(extract(epoch from a.serv_ts) / ${safeInterval}) * ${safeInterval})
          ) AT TIME ZONE 'UTC' as "servTs",
          a.eqpid as "eqpId",
          s.site as "site",
          r.sdwt as "sdwt",
          MAX(a.memory_usage_mb) as "memoryUsageMB",
          MAX(a.memory_commit_mb) as "memoryCommitMB", 
          i.app_ver as "agentVersion"
        FROM ${tableName} a
        LEFT JOIN public.ref_equipment r ON a.eqpid = r.eqpid
        LEFT JOIN public.ref_sdwt s ON r.sdwt = s.sdwt
        LEFT JOIN public.agent_info i ON a.eqpid = i.eqpid
        WHERE a.serv_ts >= $1 AND a.serv_ts <= $2
          AND a.process_name IN ('ITM_Agent', 'ITMAgent', 'ITM-Agent', 'itm_agent', 'itmagent', 'itm-agent')
          ${eqpFilter} ${siteFilter} ${sdwtFilter}
        GROUP BY 1, 2, 3, 4, 7
      `;
      return { sql, params };
    };

    let archivePromise = Promise.resolve([] as any[]);

    // [라우팅 1] DBaaS 직접 조회 (eqp_proc_perf_archive)
    if (startDt < cutoffDate) {
      const endPastDt = endDt < cutoffDate ? endDt : new Date(cutoffDate.getTime() - 1);
      const { sql, params } = buildQuery('public.eqp_proc_perf_archive', startDt, endPastDt);
      
      archivePromise = this.archivePrisma.$queryRawUnsafe<any[]>(sql, ...params).catch(e => {
        console.warn(`[ITM-Data-API] Agent Trend DBaaS Failed: ${e.message}`);
        return [];
      });
    }

    // [라우팅 2] 최신 데이터 로컬 조회 (eqp_proc_perf)
    if (endDt >= cutoffDate) {
      const recentStartDt = startDt > cutoffDate ? startDt : cutoffDate;
      const { sql, params } = buildQuery('public.eqp_proc_perf', recentStartDt, endDt);

      archivePromise = archivePromise.then(async (archiveRows) => {
        try {
          const localRows = await this.prisma.$queryRawUnsafe<any[]>(sql, ...params);
          return [...archiveRows, ...localRows];
        } catch (e) {
          return archiveRows;
        }
      });
    }

    const allResults = await archivePromise;

    return allResults.map(row => ({
       timestamp: dayjs.utc(row.servTs).format('YYYY-MM-DD HH:mm:ss'),
       eqpId: row.eqpId,
       site: row.site,
       sdwt: row.sdwt,
       memoryUsageMB: Number(row.memoryUsageMB) || 0,
       memoryCommitMB: Number(row.memoryCommitMB) || 0,
       agentVersion: row.agentVersion
    })).sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  }
}
