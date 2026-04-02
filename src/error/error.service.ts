// ITM-Data-API/src/error/error.service.ts
import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma.service';
import { Prisma } from '@prisma/client';

export class ErrorQueryParams {
  site?: string;
  sdwt?: string;
  eqpId?: string;
  start?: string | Date;
  end?: string | Date;
}

@Injectable()
export class ErrorService {
  private readonly logger = new Logger(ErrorService.name);

  constructor(private prisma: PrismaService) {}

  // [핵심 수정 1] Prisma 타임존 오지랖 방지: 순수 문자열 추출 후 UTC(Z)로 강제 래핑
  private getSafeDates(start?: string | Date, end?: string | Date): { startDate: Date, endDate: Date } {
    const extractDateStr = (d?: string | Date, isStart: boolean = false): string => {
      if (!d) {
        // 기본값: 서버의 KST 시간 기준 오늘/7일전
        const temp = new Date();
        const kstTime = new Date(temp.getTime() + 9 * 60 * 60 * 1000);
        if (isStart) kstTime.setDate(kstTime.getDate() - 7);
        return kstTime.toISOString().split('T')[0];
      }
      
      const dStr = typeof d === 'string' ? d : d.toISOString();
      
      // '2026-04-02' 형태면 그대로 반환
      if (dStr.length === 10) return dStr;
      
      // '2026-04-01T15:00:00.000Z' 형태면, KST로 변환해 사용자가 실제 의도한 날짜 문자열 도출
      if (dStr.includes('T')) {
        const parsed = new Date(dStr);
        if(!isNaN(parsed.getTime())) {
            const kstDate = new Date(parsed.getTime() + 9 * 60 * 60 * 1000);
            return kstDate.toISOString().split('T')[0];
        }
      }
      
      return dStr.substring(0, 10);
    };

    const startStr = extractDateStr(start, true);
    const endStr = extractDateStr(end, false);

    // Prisma가 2026-04-02 00:00:00 문자열을 DB에 '그대로' 던지도록 유도
    const startDate = new Date(`${startStr}T00:00:00.000Z`);
    const endDate = new Date(`${endStr}T23:59:59.999Z`);

    return { startDate, endDate };
  }

  // 1. 에러 요약 정보
  async getErrorSummary(params: ErrorQueryParams) {
    const { site, sdwt, eqpId, start, end } = params;
    const { startDate, endDate } = this.getSafeDates(start, end);

    const whereCondition: Prisma.PlgErrorWhereInput = {
      timeStamp: { gte: startDate, lte: endDate },
    };

    if (eqpId) {
      whereCondition.eqpid = eqpId.trim();
    } else if (site || sdwt) {
      const eqpList = await this.getEqpIdsBySiteSdwt(site, sdwt);
      if (eqpList.length > 0) {
        whereCondition.eqpid = { in: eqpList };
      } else {
        return { 
          totalErrorCount: 0, 
          errorEqpCount: 0,
          topErrorId: '-',
          topErrorCount: 0,
          topErrorLabel: '-',
          errorCountByEqp: [] 
        };
      }
    }

    try {
      const totalErrorCount = await this.prisma.plgError.count({ where: whereCondition });

      const byEqp = await this.prisma.plgError.groupBy({
        by: ['eqpid'],
        where: whereCondition,
        _count: { _all: true },
        orderBy: { _count: { eqpid: 'desc' } },
      });

      const byErrorId = await this.prisma.plgError.groupBy({
        by: ['errorId'],
        where: whereCondition,
        _count: { _all: true },
        orderBy: { _count: { errorId: 'desc' } },
        take: 1,
      });

      let topErrorId = '-';
      let topErrorCount = 0;
      let topErrorLabel = '-';

      if (byErrorId.length > 0) {
        topErrorId = String(byErrorId[0].errorId);
        topErrorCount = byErrorId[0]._count._all;
        
        const errorInfo = await this.prisma.plgError.findFirst({
          where: { errorId: topErrorId },
          select: { errorLabel: true, errorDesc: true },
        });
        if (errorInfo) {
          topErrorLabel = errorInfo.errorLabel || errorInfo.errorDesc || '-';
        }
      }

      const errorCountByEqp = byEqp.slice(0, 10).map(item => ({
        label: item.eqpid,
        value: item._count._all
      }));

      return {
        totalErrorCount,
        errorEqpCount: byEqp.length,
        topErrorId,
        topErrorCount,
        topErrorLabel,
        errorCountByEqp,
      };

    } catch (e) {
      this.logger.error('Error fetching error summary:', e);
      throw e;
    }
  }

  // 2. 에러 트렌드
  async getErrorTrend(params: ErrorQueryParams) {
    const { site, sdwt, eqpId, start, end } = params;
    const { startDate, endDate } = this.getSafeDates(start, end);

    let eqpFilter = '';
    const queryParams: any[] = [startDate, endDate];

    if (eqpId) {
      eqpFilter = `AND e.eqpid = $${queryParams.length + 1}`;
      queryParams.push(eqpId.trim());
    } else if (site || sdwt) {
      const eqpList = await this.getEqpIdsBySiteSdwt(site, sdwt);
      if (eqpList.length > 0) {
          const eqpStr = eqpList.map(id => `'${id}'`).join(',');
          eqpFilter = `AND e.eqpid IN (${eqpStr})`;
      } else {
          return []; 
      }
    }

    // [핵심 수정 2] DB 데이터가 이미 로컬 시간 기준이므로 INTERVAL 보정을 제거
    const sql = `
      SELECT DATE(e.time_stamp) as date, COUNT(*)::int as count
      FROM public.plg_error e
      WHERE e.time_stamp >= $1 
        AND e.time_stamp <= $2
        ${eqpFilter}
      GROUP BY DATE(e.time_stamp)
      ORDER BY date ASC
    `;

    try {
      const result = await this.prisma.$queryRawUnsafe<any[]>(sql, ...queryParams);
      return result.map(r => ({
        date: typeof r.date === 'string' ? r.date : new Date(r.date).toISOString().split('T')[0],
        count: r.count
      }));
    } catch (e) {
      this.logger.error('Error fetching error trend:', e);
      return [];
    }
  }

  // 3. 에러 목록 조회
  async getErrorList(params: ErrorQueryParams & { page?: number, pageSize?: number }) {
    const { site, sdwt, eqpId, start, end, page = 0, pageSize = 50 } = params;
    const { startDate, endDate } = this.getSafeDates(start, end);

    const whereCondition: Prisma.PlgErrorWhereInput = {
      timeStamp: { gte: startDate, lte: endDate },
    };

    if (eqpId) {
      whereCondition.eqpid = eqpId.trim();
    } else if (site || sdwt) {
      const eqpList = await this.getEqpIdsBySiteSdwt(site, sdwt);
      if (eqpList.length > 0) {
        whereCondition.eqpid = { in: eqpList };
      } else {
        return { totalItems: 0, items: [] };
      }
    }

    try {
      const take = Number(pageSize) || 50;
      const skip = (Number(page) || 0) * take;

      const [total, items] = await this.prisma.$transaction([
        this.prisma.plgError.count({ where: whereCondition }),
        this.prisma.plgError.findMany({
          where: whereCondition,
          take: take,
          skip: skip,
          orderBy: { timeStamp: 'desc' },
        }),
      ]);

      // [핵심 수정 3] 프론트엔드가 날짜를 잘못 변환하지 못하도록, 백엔드에서 명시적 String 처리
      const mappedItems = items.map((item: any) => {
        // item.timeStamp 객체를 YYYY-MM-DD HH:mm:ss 문자열로 하드코딩 변환
        const formattedDate = item.timeStamp 
          ? new Date(item.timeStamp).toISOString().replace('T', ' ').substring(0, 19)
          : null;

        return {
          eqpId: item.eqpid,
          errorId: item.errorId,
          errorLabel: item.errorLabel,
          errorDesc: item.errorDesc,
          timeStamp: formattedDate, // Date 객체 대신 문자열 전달
          extraMessage1: item.extraMessage1,
          extraMessage2: item.extraMessage2,
        };
      });

      return { totalItems: total, items: mappedItems };
    } catch (e) {
      this.logger.error('Error fetching error list:', e);
      throw e;
    }
  }

  private async getEqpIdsBySiteSdwt(site?: string, sdwt?: string): Promise<string[]> {
    if (!site && !sdwt) return [];

    let sql = `
      SELECT t1.eqpid 
      FROM public.ref_equipment t1
      JOIN public.ref_sdwt t2 ON t1.sdwt = t2.sdwt
      WHERE 1=1
    `;
    const params: string[] = [];

    if (site) {
      sql += ` AND t2.site = $${params.length + 1}`;
      params.push(site);
    }
    if (sdwt) {
      sql += ` AND t2.sdwt = $${params.length + 1}`;
      params.push(sdwt);
    }

    try {
      const result = await this.prisma.$queryRawUnsafe<{ eqpid: string }[]>(sql, ...params);
      return result.map(r => r.eqpid);
    } catch (e) {
      this.logger.error('Error fetching equipment IDs:', e);
      return [];
    }
  }
}
