// ITM-Data-API_v1/src/error/error.service.ts
import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma.service';
import { Prisma } from '@prisma/client';

export class ErrorQueryParams {
  site?: string;
  sdwt?: string;
  eqpId?: string;
  start?: string | Date;
  end?: string | Date;
  page?: number;
  pageSize?: number;
}

@Injectable()
export class ErrorService {
  private readonly logger = new Logger(ErrorService.name);

  constructor(private prisma: PrismaService) {}

  // [해결 핵심] Prisma ORM과 QueryRaw의 타임존 불일치 버그를 해결하는 날짜 파서
  private getSafeDates(start?: string | Date, end?: string | Date) {
    let startStr = '';
    let endStr = '';

    if (start && end) {
      // 프론트엔드가 전송한 URL 문자열 복원 (+, T 기호를 모두 공백으로 통일)
      startStr = decodeURIComponent(String(start)).replace(/\+/g, ' ').replace('T', ' ');
      endStr = decodeURIComponent(String(end)).replace(/\+/g, ' ').replace('T', ' ');
    } else {
      // 파라미터가 없으면 기본 최근 7일
      const e = new Date();
      const s = new Date();
      s.setDate(s.getDate() - 7);
      const pad = (n: number) => String(n).padStart(2, '0');
      startStr = `${s.getFullYear()}-${pad(s.getMonth() + 1)}-${pad(s.getDate())} 00:00:00`;
      endStr = `${e.getFullYear()}-${pad(e.getMonth() + 1)}-${pad(e.getDate())} 23:59:59`;
    }

    // 1. Prisma ORM 조회용 (Summary, List)
    // Prisma는 DB 컬럼 특성에 따라 Z를 붙여야 원형 그대로 쿼리됩니다.
    const ormStartDate = new Date(`${startStr.replace(' ', 'T')}.000Z`);
    const ormEndDate = new Date(`${endStr.replace(' ', 'T')}.999Z`);

    // 2. QueryRaw 조회용 (Trend)
    // QueryRaw에 Date 객체를 던지면 Node.js(pg)가 로컬 KST 타임존으로 +9시간 시프트를 해버립니다!
    // 이를 막기 위해 순수 문자열(String)을 반환하여 직접 바인딩합니다.
    return { ormStartDate, ormEndDate, rawStartStr: startStr, rawEndStr: endStr };
  }

  async getErrorSummary(params: ErrorQueryParams) {
    const { site, sdwt, eqpId, start, end } = params;
    const { ormStartDate, ormEndDate } = this.getSafeDates(start, end);

    const whereCondition: Prisma.PlgErrorWhereInput = {
      timeStamp: { gte: ormStartDate, lte: ormEndDate },
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

  async getErrorTrend(params: ErrorQueryParams) {
    const { site, sdwt, eqpId, start, end } = params;
    // QueryRaw용 순수 문자열(String) 날짜 추출
    const { rawStartStr, rawEndStr } = this.getSafeDates(start, end);

    let eqpFilter = '';
    // Date 객체 대신 문자열 매개변수를 던져서 Postgres가 KST 변환 없이 정직하게 파싱하게 만듦!
    const queryParams: any[] = [rawStartStr, rawEndStr];

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

    // 문자열에 ::timestamp 캐스팅을 걸어 확실하게 타임존 개입 방어
    const sql = `
      SELECT DATE(e.time_stamp) as date, COUNT(*)::int as count
      FROM public.plg_error e
      WHERE e.time_stamp >= $1::timestamp
        AND e.time_stamp <= $2::timestamp
        ${eqpFilter}
      GROUP BY DATE(e.time_stamp)
      ORDER BY date ASC
    `;

    try {
      const result = await this.prisma.$queryRawUnsafe<any[]>(sql, ...queryParams);
      return result.map(r => {
        // Postgres에서 넘어온 date 객체를 로컬 날짜 문자열로 안전하게 변환
        const dStr = typeof r.date === 'string' 
          ? r.date 
          : new Date(r.date.getTime() - (r.date.getTimezoneOffset() * 60000)).toISOString();
          
        return {
          date: dStr.substring(0, 10),
          count: r.count
        };
      });
    } catch (e) {
      this.logger.error('Error fetching error trend:', e);
      return [];
    }
  }

  async getErrorList(params: ErrorQueryParams) {
    const { site, sdwt, eqpId, start, end, page = 0, pageSize = 50 } = params;
    const { ormStartDate, ormEndDate } = this.getSafeDates(start, end);

    const whereCondition: Prisma.PlgErrorWhereInput = {
      timeStamp: { gte: ormStartDate, lte: ormEndDate },
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

      const mappedItems = items.map((item: any) => {
        const formattedDate = item.timeStamp
          ? new Date(item.timeStamp).toISOString().replace('T', ' ').substring(0, 19)
          : null;

        return {
          eqpId: item.eqpid,
          errorId: item.errorId,
          errorLabel: item.errorLabel,
          errorDesc: item.errorDesc,
          timeStamp: formattedDate,
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
