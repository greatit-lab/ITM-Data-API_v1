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
          l.offset_hour as "offsetHour", -- [추가] 에이전트 보정값(오프셋) 조회
          e.prc_group as "prcGroup"
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
        offsetHour: row.offsetHour || row.offset_hour || 0, // [추가] 오프셋 값 매핑 (없으면 0)
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
