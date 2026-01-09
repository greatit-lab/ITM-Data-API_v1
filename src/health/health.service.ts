// ITM-Data-API/src/health/health.service.ts
import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma.service';

interface PerfStatRaw {
  eqpid: string;
  avgUsage: number | null;
  tempStd: number | null;
}
interface LampStatRaw {
  eqpid: string;
  usageRatio: number | null;
}

@Injectable()
export class HealthService {
  constructor(private prisma: PrismaService) {}

  async getHealthSummary(site?: string, sdwt?: string) {
    // 1. 대상 장비 조회
    const equipmentWhere: any = {};
    if (sdwt) equipmentWhere.sdwt = sdwt;
    if (site) equipmentWhere.sdwtRel = { site, isUse: 'Y' };
    else equipmentWhere.sdwtRel = { isUse: 'Y' };

    const equipments = await this.prisma.refEquipment.findMany({
      where: equipmentWhere,
      select: { eqpid: true },
    });

    const eqpIds = equipments.map((e) => e.eqpid);
    if (eqpIds.length === 0) return [];

    const now = new Date();
    const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    const oneDayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);

    // 2. 통계 데이터 집계 (에러, 성능, 램프)
    const errorStats = await this.prisma.plgError.groupBy({
      by: ['eqpid'],
      where: { eqpid: { in: eqpIds }, timeStamp: { gte: sevenDaysAgo } },
      _count: { _all: true },
    });

    // Raw Query: 성능 통계
    const eqpIdString = eqpIds.map((id) => `'${id}'`).join(',');
    const perfRaw = await this.prisma.$queryRawUnsafe<PerfStatRaw[]>(
      `SELECT eqpid, AVG(cpu_usage + mem_usage) / 2 as "avgUsage", STDDEV(cpu_temp) as "tempStd"
       FROM public.eqp_perf
       WHERE eqpid IN (${eqpIdString}) AND serv_ts >= '${oneDayAgo.toISOString()}'
       GROUP BY eqpid`
    );

    // Raw Query: 램프 수명
    const lampRaw = await this.prisma.$queryRawUnsafe<LampStatRaw[]>(
      `SELECT eqpid, MAX(age_hour::float / NULLIF(lifespan_hour, 0)) as "usageRatio"
       FROM public.eqp_lamp_life
       WHERE eqpid IN (${eqpIdString})
       GROUP BY eqpid`
    );

    // 3. 점수 계산
    const errorMap = new Map(errorStats.map((e) => [e.eqpid, e._count._all]));
    const perfMap = new Map(perfRaw.map((p) => [p.eqpid, { usage: Number(p.avgUsage || 0), std: Number(p.tempStd || 0) }]));
    const lampMap = new Map(lampRaw.map((l) => [l.eqpid, Number(l.usageRatio || 0)]));

    return eqpIds.map((eqpId) => {
      // (A) 신뢰성: 에러 건수 기반
      const errorCount = errorMap.get(eqpId) || 0;
      const reliabilityScore = Math.max(0, 40 - errorCount * 4);

      // (B) 성능: 리소스 사용률 기반
      const perf = perfMap.get(eqpId) || { usage: 0, std: 0 };
      const resourceScore = Math.max(0, 30 * (1 - Math.max(0, perf.usage - 20) / 70));

      // (C) 부품: 램프 수명 기반
      const lampRatio = lampMap.get(eqpId) || 0;
      const componentScore = Math.max(0, 20 * (1 - Math.min(1, lampRatio)));

      // (D) 안정성: 온도 변동성 기반
      const stabilityScore = Math.max(0, 10 * (1 - Math.min(1, perf.std / 5)));

      const totalScore = Math.round(reliabilityScore + resourceScore + componentScore + stabilityScore);
      let status: 'Good' | 'Warning' | 'Critical' = 'Good';
      if (totalScore < 60) status = 'Critical';
      else if (totalScore < 80) status = 'Warning';

      return {
        eqpId,
        totalScore,
        status,
        factors: { reliability: reliabilityScore, performance: resourceScore, component: componentScore, stability: stabilityScore },
        details: { errorCount, avgResourceUsage: perf.usage, lampUsageRatio: lampRatio * 100, tempVolatility: perf.std },
      };
    }).sort((a, b) => a.totalScore - b.totalScore);
  }
}
