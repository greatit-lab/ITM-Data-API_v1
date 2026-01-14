// ITM-Data-API/src/prealign/prealign.service.ts
import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma.service';
import { Prisma } from '@prisma/client';

@Injectable()
export class PreAlignService {
  private readonly logger = new Logger(PreAlignService.name);

  constructor(private prisma: PrismaService) {}

  async getTrend(
    site: string,
    sdwt: string,
    eqpId: string,
    startDate: string,
    endDate: string,
  ) {
    try {
      // [수정] 테이블: plg_prealign / 컬럼: xmm, ymm, notch
      let query = Prisma.sql`
        SELECT 
          p.serv_ts,
          p.eqpid,
          p.xmm,   -- 실제 컬럼명 사용
          p.ymm,   -- 실제 컬럼명 사용
          p.notch  -- 실제 컬럼명 사용
        FROM public.plg_prealign p 
        JOIN public.ref_equipment e ON p.eqpid = e.eqpid
        LEFT JOIN public.ref_sdwt s ON e.sdwt = s.sdwt
        WHERE p.serv_ts >= ${new Date(startDate)}
          AND p.serv_ts <= ${new Date(endDate)}
      `;

      if (site) {
        query = Prisma.sql`${query} AND s.site = ${site}`;
      }
      if (sdwt) {
        query = Prisma.sql`${query} AND e.sdwt = ${sdwt}`;
      }
      if (eqpId) {
        query = Prisma.sql`${query} AND p.eqpid = ${eqpId}`;
      }

      query = Prisma.sql`${query} ORDER BY p.serv_ts ASC`;

      const results = await this.prisma.$queryRaw<any[]>(query);

      // [수정] 반환 키값을 xmm, ymm, notch로 통일
      return results.map((row) => ({
        timestamp: row.serv_ts || row.servTs,
        eqpId: row.eqpid || row.eqpId,
        xmm: row.xmm ?? 0,
        ymm: row.ymm ?? 0,
        notch: row.notch ?? 0,
      }));

    } catch (e) {
      this.logger.error(`Failed to get PreAlign Trend: ${e}`);
      return [];
    }
  }
}
