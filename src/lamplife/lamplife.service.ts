// ITM-Data-API_v1/src/lamplife/lamplife.service.ts
import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma.service';
import { Prisma } from '@prisma/client';

@Injectable()
export class LampLifeService {
  private readonly logger = new Logger(LampLifeService.name);

  constructor(private prisma: PrismaService) {}

  // 1. 램프 데이터 조회 (Raw SQL)
  async getLampData(site?: string, sdwt?: string, eqpId?: string) {
    try {
      let query = Prisma.sql`
        SELECT 
          l.eqpid, 
          l.lamp_name as "lampName", 
          l.lamp_no as "lampNo",
          l.age_hour as "ageHour", 
          l.lifespan_hour as "lifespanHour", 
          l.last_changed as "lastChanged", 
          l.serv_ts as "servTs",
          e.prc_group as "prcGroup"  -- [수정 1] ref_equipment 테이블에서 prc_group 조회 추가
        FROM public.eqp_lamp_life l
        JOIN public.ref_equipment e ON l.eqpid = e.eqpid
        LEFT JOIN public.ref_sdwt s ON e.sdwt = s.sdwt
        WHERE 1=1 
      `;

      if (site) {
        query = Prisma.sql`${query} AND s.site = ${site}`;
      }
      if (sdwt) {
        query = Prisma.sql`${query} AND e.sdwt = ${sdwt}`;
      }
      if (eqpId) {
        query = Prisma.sql`${query} AND l.eqpid = ${eqpId}`;
      }

      // [수정] 정렬 조건 변경: EqpId 오름차순, LampNo 오름차순
      // 기존: ORDER BY l.serv_ts DESC
      query = Prisma.sql`${query} ORDER BY l.eqpid ASC, l.lamp_no ASC`;

      const results = await this.prisma.$queryRaw<any[]>(query);

      return results.map((row) => ({
        eqpId: row.eqpid || row.EQPID,
        lampId: row.lampName || row.lamp_name, 
        lampNo: row.lampNo || row.lamp_no || 0, 
        ageHour: row.ageHour || row.age_hour || 0,
        lifespanHour: row.lifespanHour || row.lifespan_hour || 0,
        lastChanged: row.lastChanged || row.last_changed,
        servTs: row.servTs || row.serv_ts,
        // [수정 2] 프론트엔드에서 사용할 수 있도록 매핑 (값이 없을 경우 예외처리 'UNKNOWN')
        prc_group: row.prcGroup || row.prc_group || 'UNKNOWN', 
      }));

    } catch (e) {
      this.logger.error(`Failed to get Lamp Data (Raw SQL): ${e}`);
      return [];
    }
  }

  async addLampHistory(data: Prisma.EqpLampLifeCreateInput) {
    return this.prisma.eqpLampLife.create({
      data,
    });
  }
}
