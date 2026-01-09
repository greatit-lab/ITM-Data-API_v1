// ITM-Data-API/src/error/error.service.ts
import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma.service';
import { Prisma } from '@prisma/client';

@Injectable()
export class ErrorService {
  constructor(private prisma: PrismaService) {}

  // [수정] Site, SDWT 필터링을 위한 Where 조건 생성
  // PlgError -> Equipment -> SdwtRel 관계를 활용
  private getWhereInput(site: string, sdwt: string, start: string, end: string): Prisma.PlgErrorWhereInput {
    const where: Prisma.PlgErrorWhereInput = {
      timeStamp: {
        gte: new Date(start),
        lte: new Date(end),
      },
    };

    // 장비 필터 조건 추가
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
  async getErrorSummary(site: string, sdwt: string, start: string, end: string) {
    const where = this.getWhereInput(site, sdwt, start, end);
    
    // 전체 에러 수
    const totalCount = await this.prisma.plgError.count({ where });

    // 가장 많이 발생한 에러 ID (Group By)
    const groupByError = await this.prisma.plgError.groupBy({
      by: ['errorId'],
      where,
      _count: { errorId: true },
      orderBy: { _count: { errorId: 'desc' } },
      take: 1,
    });
    
    const topItem = groupByError[0];
    const topErrorCount = topItem?._count?.errorId ?? 0;

    // 에러 발생 장비 수
    const groupByEqp = await this.prisma.plgError.groupBy({
      by: ['eqpid'],
      where,
    });
    const errorEqpCount = groupByEqp.length;

    return {
        totalErrorCount: totalCount,
        errorEqpCount: errorEqpCount, 
        topErrorId: topItem?.errorId || '-',
        topErrorCount: topErrorCount,
        topErrorLabel: 'Unknown', // 필요 시 Error ID 매핑 테이블 조회 추가 가능
        errorCountByEqp: []
    };
  }

  // 2. 일별 에러 발생 트렌드 (Raw Query 사용)
  async getErrorTrend(site: string, sdwt: string, start: string, end: string) {
    // Raw Query에서는 Prisma Relation을 직접 쓸 수 없으므로 JOIN 필요
    // plg_error (e) -> ref_equipment (r) -> ref_sdwt (s)
    
    let filterSql = Prisma.sql`
      WHERE e.time_stamp >= ${new Date(start)} 
        AND e.time_stamp <= ${new Date(end)}
    `;

    if (sdwt) {
      filterSql = Prisma.sql`${filterSql} AND r.sdwt = ${sdwt}`;
    } else if (site) {
      filterSql = Prisma.sql`${filterSql} AND r.sdwt IN (SELECT sdwt FROM public.ref_sdwt WHERE site = ${site})`;
    }

    return this.prisma.$queryRaw`
      SELECT DATE(e.time_stamp) as date, COUNT(*) as count
      FROM public.plg_error e
      JOIN public.ref_equipment r ON e.eqpid = r.eqpid
      ${filterSql}
      GROUP BY DATE(e.time_stamp)
      ORDER BY date ASC
    `;
  }

  // 3. 에러 로그 목록 조회 (페이지네이션)
  async getErrorLogs(page: number, limit: number, site: string, sdwt: string, start: string, end: string) {
    const where = this.getWhereInput(site, sdwt, start, end);
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
              sdwtRel: { select: { site: true } } // 결과에 Site 정보 포함
            }
          }
        }
      }),
      this.prisma.plgError.count({ where }),
    ]);

    // 결과 포맷팅 (Frontend에서 쓰기 편하게)
    const formattedItems = items.map(item => ({
      ...item,
      site: item.equipment?.sdwtRel?.site || '-'
    }));

    return { items: formattedItems, totalItems };
  }
}
