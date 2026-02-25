// ITM-Data-API/src/performance/performance.service.ts
import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma.service';
import { Prisma } from '@prisma/client';
import dayjs from 'dayjs';
import utc from 'dayjs/plugin/utc';

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
    intervalSec: number = 300, // [수정] 5분(300초)으로 변경
  ) {
    const safeInterval = (intervalSec && !isNaN(intervalSec) && intervalSec > 0) ? intervalSec : 300; // [수정] 5분(300초)으로 변경

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
      memoryUsageMB: row.memoryUsageMb ?? row.memoryUsageMB ?? 0,
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
    const start = this.parseDate(startDate); 
    const end = this.parseDate(endDate);     

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

    return (results as any[]).map(r => ({
      ...r,
      timestamp: dayjs.utc(r.timestamp).format('YYYY-MM-DD HH:mm:ss')
    }));
  }
}
