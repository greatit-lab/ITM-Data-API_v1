// ITM-Data-API/src/error/error.service.ts
import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma.service';
import { Prisma } from '@prisma/client';

@Injectable()
export class ErrorService {
  constructor(private prisma: PrismaService) {}

  // [유지] 필터 조건 생성 로직
  private getWhereInput(
    site: string,
    sdwt: string,
    start: string,
    end: string,
    eqpId?: string,
  ): Prisma.PlgErrorWhereInput {
    const where: Prisma.PlgErrorWhereInput = {
      timeStamp: {
        gte: new Date(start),
        lte: new Date(end),
      },
    };

    // 장비 ID 직접 필터링
    if (eqpId) {
      where.eqpid = eqpId;
    }

    // Site/SDWT 필터 조건
    if (site || sdwt) {
      where.equipment = {
        sdwtRel: {
          isUse: 'Y',
          ...(site ? { site } : {}),
        },
        ...(sdwt ? { sdwt } : {}),
      };
    }

    return where;
  }

  // 1. 에러 요약 통계
  async getErrorSummary(
    site: string,
    sdwt: string,
    start: string,
    end: string,
    eqpId?: string,
  ) {
    const where = this.getWhereInput(site, sdwt, start, end, eqpId);

    // 전체 에러 수
    const totalCount = await this.prisma.plgError.count({ where });

    // 가장 많이 발생한 에러 ID (Top 1)
    const groupByError = await this.prisma.plgError.groupBy({
      by: ['errorId'],
      where,
      _count: { errorId: true },
      orderBy: { _count: { errorId: 'desc' } },
      take: 1,
    });

    const topItem = groupByError[0];
    const topErrorCount = topItem?._count?.errorId ?? 0;
    const topErrorId = topItem?.errorId || '-';

    // [수정] Top Error ID에 해당하는 Label 조회 로직 추가
    let topErrorLabel = 'Unknown';
    if (topErrorId !== '-') {
      // 해당 errorId를 가진 가장 최근 로그 하나를 조회하여 라벨 확인
      const errorRecord = await this.prisma.plgError.findFirst({
        where: { errorId: topErrorId },
        select: { errorLabel: true },
        orderBy: { timeStamp: 'desc' },
      });

      if (errorRecord && errorRecord.errorLabel) {
        topErrorLabel = errorRecord.errorLabel;
      }
    }

    // 에러 발생 장비 수
    const groupByEqpAll = await this.prisma.plgError.groupBy({
      by: ['eqpid'],
      where,
    });
    const errorEqpCount = groupByEqpAll.length;

    // Worst Equipment 차트용 데이터 (Top 10)
    const groupByEqpTop10 = await this.prisma.plgError.groupBy({
      by: ['eqpid'],
      where,
      _count: { errorId: true },
      orderBy: { _count: { errorId: 'desc' } },
      take: 10,
    });

    const errorCountByEqp = groupByEqpTop10.map((item) => ({
      label: item.eqpid,
      value: item._count.errorId,
    }));

    return {
      totalErrorCount: totalCount,
      errorEqpCount: errorEqpCount,
      topErrorId: topErrorId,
      topErrorCount: topErrorCount,
      topErrorLabel: topErrorLabel, // [적용] 조회된 실제 라벨 반환
      errorCountByEqp: errorCountByEqp,
    };
  }

  // 2. 일별 에러 발생 트렌드
  async getErrorTrend(
    site: string,
    sdwt: string,
    start: string,
    end: string,
    eqpId?: string,
  ) {
    let filterSql = Prisma.sql`
      WHERE e.time_stamp >= ${new Date(start)} 
        AND e.time_stamp <= ${new Date(end)}
    `;

    if (eqpId) {
      filterSql = Prisma.sql`${filterSql} AND e.eqpid = ${eqpId}`;
    }

    if (sdwt) {
      filterSql = Prisma.sql`${filterSql} AND r.sdwt = ${sdwt}`;
    } else if (site) {
      filterSql = Prisma.sql`${filterSql} AND r.sdwt IN (SELECT sdwt FROM public.ref_sdwt WHERE site = ${site})`;
    }

    return this.prisma.$queryRaw`
      SELECT DATE(e.time_stamp) as date, COUNT(*)::int as count
      FROM public.plg_error e
      JOIN public.ref_equipment r ON e.eqpid = r.eqpid
      ${filterSql}
      GROUP BY DATE(e.time_stamp)
      ORDER BY date ASC
    `;
  }

  // 3. 에러 로그 목록 조회
  async getErrorLogs(
    page: number,
    limit: number,
    site: string,
    sdwt: string,
    start: string,
    end: string,
    eqpId?: string,
  ) {
    const where = this.getWhereInput(site, sdwt, start, end, eqpId);
    const skip = (page - 1) * limit;

    const [items, totalItems] = await this.prisma.$transaction([
      this.prisma.plgError.findMany({
        where,
        skip,
        take: limit,
        orderBy: { timeStamp: 'desc' },
        include: {
          equipment: {
            select: {
              sdwtRel: { select: { site: true } },
            },
          },
        },
      }),
      this.prisma.plgError.count({ where }),
    ]);

    const formattedItems = items.map((item) => ({
      ...item,
      eqpId: item.eqpid,
      site: item.equipment?.sdwtRel?.site || '-',
    }));

    return { items: formattedItems, totalItems };
  }
}
