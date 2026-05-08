// ITM-Data-API_v1/src/dashboard/dashboard.service.ts
import { Injectable, InternalServerErrorException, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma.service';
import { Prisma } from '@prisma/client';

@Injectable()
export class DashboardService {
  private readonly logger = new Logger(DashboardService.name);

  constructor(private prisma: PrismaService) {}

  private compareVersions(v1: string, v2: string) {
    const p1 = v1.replace(/[^0-9.]/g, '').split('.').map(Number);
    const p2 = v2.replace(/[^0-9.]/g, '').split('.').map(Number);
    for (let i = 0; i < Math.max(p1.length, p2.length); i++) {
      const n1 = p1[i] || 0;
      const n2 = p2[i] || 0;
      if (n1 > n2) return 1;
      if (n1 < n2) return -1;
    }
    return 0;
  }

  // [초강력 페널티] 거리가 멀어질수록 점수가 수직 낙하하는 산식
  private calculateAgentScore(v: string, latest: string): number {
    if (!v) return 0;
    if (v === latest) return 100;
    
    const vParts = v.replace(/[^0-9.]/g, '').split('.').map(Number);
    const lParts = latest.replace(/[^0-9.]/g, '').split('.').map(Number);
    
    const l0 = lParts[0] || 0, v0 = vParts[0] || 0;
    const l1 = lParts[1] || 0, v1 = vParts[1] || 0;
    const l2 = lParts[2] || 0, v2 = vParts[2] || 0;
    const l3 = lParts[3] || 0, v3 = vParts[3] || 0;

    // 1. v0.1.0.0 미만 (예: v0.0.9.8)은 극단적 구버전으로 분류하여 즉시 0점
    if (v0 === 0 && v1 === 0) {
      return 0; 
    }

    // 2. 세그먼트별 극한의 누진 감점 적용
    if (l0 > v0) {
      return 0; // Major 차이는 즉시 0점
    } else if (l1 > v1) {
      // Minor 차이: 1차이 10점, 2차이 이상 0점
      const diff = l1 - v1;
      return diff === 1 ? 10 : 0;
    } else if (l2 > v2) {
      // Patch 차이: 1차이 60점, 2차이 20점, 3차이 이상 0점
      const diff = l2 - v2;
      if (diff === 1) return 60;
      if (diff === 2) return 20;
      return 0;
    } else if (l3 > v3) {
      // Build 차이: 1차이 90점, 2차이 75점, 3차이 50점, 4차이 20점
      const diff = l3 - v3;
      if (diff === 1) return 90;
      if (diff === 2) return 75;
      if (diff === 3) return 50;
      return Math.max(0, 50 - (diff - 3) * 30);
    }

    return 100; // 최신 버전보다 미래의 버전인 경우 방어코드
  }

  async getGlobalFleetData() {
    try {
      const kstNow = new Date(new Date().getTime() + 9 * 60 * 60 * 1000);
      const todayDateStr = kstNow.toISOString().split('T')[0];
      const startOfToday = new Date(`${todayDateStr}T00:00:00.000Z`);

      const latestVerEntry = await this.prisma.sysAgentVersion.findFirst({
        where: { isLatest: 'Y' },
        select: { version: true }
      });
      const latestVersion = latestVerEntry?.version || '';

      const sdwts = await this.prisma.refSdwt.findMany({
        where: { isUse: 'Y' },
        select: { id: true, site: true, sdwt: true },
        orderBy: { id: 'asc' }
      });

      const rawEquipments = await this.prisma.refEquipment.findMany({
        where: { sdwtRel: { isUse: 'Y' } },
        select: {
          eqpid: true,
          sdwt: true,
          agentInfo: { select: { eqpid: true, appVer: true } }, 
          agentStatus: { select: { status: true } },
        }
      });

      const equipments = rawEquipments.filter(e => e.agentInfo !== null);
      const eqpIds = equipments.map((e) => e.eqpid);
      
      const errorMap = new Map<string, number>();
      try {
        if (eqpIds.length > 0) {
          const errorCounts = await this.prisma.plgError.groupBy({
            by: ['eqpid'],
            where: {
              timeStamp: { gte: startOfToday },
              eqpid: { in: eqpIds }
            },
            _count: { _all: true }
          });
          
          errorCounts.forEach((e) => {
            errorMap.set(e.eqpid, e._count._all);
          });
        }
      } catch (err) {
        this.logger.warn("PlgError Query Failed:", err);
      }

      const siteMap = new Map<string, any>();
      let siteIndex = 0;

      for (const s of sdwts) {
        if (!siteMap.has(s.site)) {
          siteMap.set(s.site, {
            siteName: s.site,
            sdwts: [],
            siteStats: { total: 0, online: 0, offline: 0, alerts: 0 },
            index: siteIndex++
          });
        }

        const siteObj = siteMap.get(s.site);
        if (!siteObj.sdwts.find((sd: any) => sd.name === s.sdwt)) {
          siteObj.sdwts.push({
            name: s.sdwt,
            totalCount: 0,
            onlineCount: 0,
            offlineCount: 0,
            latestCount: 0, 
            totalStabilityPoints: 0,
            minStabilityPoint: 100, // 최약체 추적
            summary: { todayErrorCount: 0 },
            index: siteObj.sdwts.length
          });
        }
      }

      for (const eqp of equipments) {
        const targetSdwt = sdwts.find((s) => s.sdwt === eqp.sdwt);
        if (!targetSdwt) continue;

        const siteObj = siteMap.get(targetSdwt.site);
        if (!siteObj) continue;

        const sdwtObj = siteObj.sdwts.find((s: any) => s.name === eqp.sdwt);
        if (!sdwtObj) continue;

        const isOnline = eqp.agentStatus?.status === 'ONLINE';
        const errorCount = errorMap.get(eqp.eqpid) || 0;
        const hasError = errorCount > 0;

        const appVer = eqp.agentInfo?.appVer || '';
        const isLatest = appVer === latestVersion;
        
        // 개별 점수 산출 (0점 ~ 100점)
        const agentScore = this.calculateAgentScore(appVer, latestVersion);

        sdwtObj.totalCount++;
        if (isOnline) sdwtObj.onlineCount++;
        else sdwtObj.offlineCount++;
        if (hasError) sdwtObj.summary.todayErrorCount++;
        if (isLatest) sdwtObj.latestCount++; 
        
        sdwtObj.totalStabilityPoints += agentScore;
        // SDWT 내 가장 치명적인 장비 점수(최저점) 기록
        sdwtObj.minStabilityPoint = Math.min(sdwtObj.minStabilityPoint, agentScore);

        siteObj.siteStats.total++;
        if (isOnline) siteObj.siteStats.online++;
        else siteObj.siteStats.offline++;
        if (hasError) siteObj.siteStats.alerts++;
      }

      const result = Array.from(siteMap.values());
      result.forEach(site => {
        site.sdwts.forEach((sdwt: any) => {
          sdwt.isAllLatest = sdwt.totalCount > 0 && sdwt.latestCount === sdwt.totalCount;
          
          // 1. 단순 평균 산출
          const baseAverage = sdwt.totalCount > 0 ? sdwt.totalStabilityPoints / sdwt.totalCount : 0;
          let finalScore = baseAverage;

          // 2. [극한의 아웃라이어 페널티] 1대라도 80점 미만의 구버전이 있다면
          // 전체 평균의 50% 비중 + 최약체 장비의 50% 비중을 강제로 섞어 수직 낙하시킴 (지분율 상향)
          if (sdwt.totalCount > 1 && sdwt.minStabilityPoint < 80) {
            finalScore = (baseAverage * 0.5) + (sdwt.minStabilityPoint * 0.5);
          }
          
          sdwt.stabilityScore = Math.round(finalScore);
          
          delete sdwt.totalStabilityPoints;
          delete sdwt.minStabilityPoint;
        });
      });

      return result;

    } catch (error) {
      this.logger.error("getGlobalFleetData Fatal Error:", error);
      throw new InternalServerErrorException("Failed to fetch global fleet data");
    }
  }

  async getSummary(site?: string, sdwt?: string) {
    try {
      const safeSite = site && site.trim() !== '' ? site : undefined;
      const safeSdwt = sdwt && sdwt.trim() !== '' ? sdwt : undefined;

      const distinctVersions = await this.prisma.agentInfo.findMany({
        distinct: ['appVer'],
        select: { appVer: true },
        where: { appVer: { not: null } },
      });

      const versions = distinctVersions
        .map((v) => v.appVer)
        .filter((v) => v) as string[];

      versions.sort((a, b) => this.compareVersions(a, b));
      const latestAgentVersion =
        versions.length > 0 ? versions[versions.length - 1] : '';

      const equipmentWhere: Prisma.RefEquipmentWhereInput = {
        sdwtRel: {
          isUse: 'Y',
          ...(safeSite ? { site: safeSite } : {}),
        },
        ...(safeSdwt ? { sdwt: safeSdwt } : {}),
      };

      const now = new Date();
      const kstNow = new Date(now.getTime() + 9 * 60 * 60 * 1000); 
      
      const todayStr = kstNow.toISOString().split('T')[0];
      const startOfToday = new Date(`${todayStr}T00:00:00.000Z`);

      const tenMinAgoKst = new Date(kstNow.getTime() - 10 * 60 * 1000);
      const tenMinAgoStr = tenMinAgoKst.toISOString().substring(0, 19);
      const tenMinutesAgo = new Date(`${tenMinAgoStr}.000Z`);

      const oneHourAgoKst = new Date(kstNow.getTime() - 60 * 60 * 1000);
      const oneHourAgoStr = oneHourAgoKst.toISOString().substring(0, 19);
      const oneHourAgo = new Date(`${oneHourAgoStr}.000Z`);

      const targetEqps = await this.prisma.refEquipment.findMany({
        where: equipmentWhere,
        select: { eqpid: true }
      });
      const eqpIds = targetEqps.map(e => e.eqpid);

      const totalEqp = await this.prisma.refEquipment.count({ 
        where: { 
          ...equipmentWhere,
          agentInfo: { isNot: null } 
        } 
      });

      const totalServers = await this.prisma.cfgServer.count({
        where: { eqpid: { in: eqpIds } }
      });

      const activeServers = await this.prisma.cfgServer.count({
        where: { 
          update: { gte: tenMinutesAgo },
          eqpid: { in: eqpIds }
        }
      });

      const totalSdwts = await this.prisma.refSdwt.count({
        where: { 
          isUse: 'Y', 
          ...(safeSite ? { site: safeSite } : {}) 
        }
      });

      let todayErrorCount = 0;
      let todayErrorTotalCount = 0;
      let newAlarmCount = 0;

      try {
        if (eqpIds.length > 0) {
          const [totalError, recentError] = await Promise.all([
            this.prisma.plgError.count({
              where: {
                timeStamp: { gte: startOfToday }, 
                eqpid: { in: eqpIds },
              },
            }),
            this.prisma.plgError.count({
              where: { 
                timeStamp: { gte: oneHourAgo }, 
                eqpid: { in: eqpIds },
              },
            }),
          ]);

          todayErrorTotalCount = totalError;
          newAlarmCount = recentError;

          if (todayErrorTotalCount > 0) {
             const errorEqps = await this.prisma.plgError.findMany({
               where: {
                 timeStamp: { gte: startOfToday },
                 eqpid: { in: eqpIds },
               },
               distinct: ['eqpid'],
               select: { eqpid: true },
             });
             todayErrorCount = errorEqps.length;
          }
        }
      } catch (err) {
        this.logger.warn("Error stats query failed:", err);
      }

      const inactiveAgentCount = Math.max(0, totalEqp - activeServers);

      return {
        totalEqpCount: totalEqp,
        totalServers: totalServers,
        onlineAgentCount: activeServers,
        inactiveAgentCount: inactiveAgentCount,
        todayErrorCount,
        todayErrorTotalCount,
        newAlarmCount,
        latestAgentVersion,
        totalSdwts, 
        serverHealth: totalServers > 0 ? Math.round((activeServers / totalServers) * 100) : 0
      };

    } catch (error) {
      this.logger.error("getSummary Error:", error);
      throw new InternalServerErrorException("Failed to fetch dashboard summary");
    }
  }

  async getAgentStatus(site?: string, sdwt?: string) {
    try {
      const safeSite = site && site.trim() !== '' ? site : undefined;
      const safeSdwt = sdwt && sdwt.trim() !== '' ? sdwt : undefined;

      const targetEqps = await this.prisma.refEquipment.findMany({
        where: {
          sdwtRel: {
            isUse: 'Y',
            ...(safeSite ? { site: safeSite } : {}),
          },
          ...(safeSdwt ? { sdwt: safeSdwt } : {}),
        },
        select: { eqpid: true }
      });

      const eqpIds = targetEqps.map(e => e.eqpid);
      if (eqpIds.length === 0) return [];

      const kstNow = new Date(new Date().getTime() + 9 * 60 * 60 * 1000);
      const todayDateStr = kstNow.toISOString().split('T')[0];
      const startOfToday = new Date(`${todayDateStr}T00:00:00.000Z`);

      const baseInfoRaw = await this.prisma.$queryRaw<any[]>`
        SELECT 
            a.eqpid, 
            CASE WHEN COALESCE(s.status, 'OFFLINE') = 'ONLINE' THEN true ELSE false END AS is_online, 
            s.last_perf_update AS last_contact,
            a.pc_name, 
            a.app_ver,
            a.type, a.ip_address, a.os, a.system_type, a.locale, a.timezone,
            cs.use_proxy,
            cs.proxy_ip
        FROM public.agent_info a
        LEFT JOIN public.agent_status s ON a.eqpid = s.eqpid
        LEFT JOIN public.cfg_server cs ON a.eqpid = cs.eqpid
        WHERE a.eqpid IN (${Prisma.join(eqpIds)})
      `;

      const errorStats = await this.prisma.plgError.groupBy({
        by: ['eqpid'],
        where: {
          eqpid: { in: eqpIds },
          timeStamp: { gte: startOfToday }
        },
        _count: { _all: true }
      });
      const errorMap = new Map(errorStats.map(e => [e.eqpid, e._count._all]));

      const perfMap = new Map<string, any>();
      if (eqpIds.length > 0) {
        const latestPerfRaw = await this.prisma.$queryRaw<any[]>`
          SELECT DISTINCT ON (eqpid) eqpid, cpu_usage, mem_usage, serv_ts, ts 
          FROM public.eqp_perf 
          WHERE eqpid IN (${Prisma.join(eqpIds)}) 
          ORDER BY eqpid, serv_ts DESC
        `;
        
        for (const perf of latestPerfRaw) {
          perfMap.set(perf.eqpid, perf);
        }
      }

      return baseInfoRaw.map((r) => {
        const errCount = errorMap.get(r.eqpid) || 0;
        const pData = perfMap.get(r.eqpid);
        
        let clockDrift: number | null = null;
        if (pData && pData.serv_ts && pData.ts) {
          const servTs = new Date(pData.serv_ts).getTime();
          const eqpTs = new Date(pData.ts).getTime();
          clockDrift = (servTs - eqpTs) / 1000;
        }

        return {
          eqpId: r.eqpid,
          isOnline: r.is_online,
          lastContact: r.last_contact,
          pcName: r.pc_name,
          cpuUsage: pData && pData.cpu_usage != null ? Number(pData.cpu_usage) : 0,
          memoryUsage: pData && pData.mem_usage != null ? Number(pData.mem_usage) : 0,
          appVersion: r.app_ver || '',
          type: r.type || '',
          ipAddress: r.ip_address || '',
          os: r.os || '',
          systemType: r.system_type || '',
          locale: r.locale || '',
          timezone: r.timezone || '',
          todayAlarmCount: Number(errCount),
          clockDrift: clockDrift,
          useProxy: r.use_proxy || 'N', 
          proxyIp: r.proxy_ip || '', 
        };
      }).sort((a, b) => a.eqpId.localeCompare(b.eqpId));

    } catch (error) {
      this.logger.error("getAgentStatus Error:", error);
      throw new InternalServerErrorException("Failed to fetch agent status");
    }
  }

  async saveEasterEgg(data: { userId: string; eggType: string; score: number }) {
    try {
      const kstNow = new Date(Date.now() + 9 * 60 * 60 * 1000);

      const existingRecord = await this.prisma.sysEasterEgg.findUnique({
        where: {
          userId_eggType: {
            userId: data.userId,
            eggType: data.eggType,
          }
        }
      });

      if (!existingRecord || data.score > existingRecord.score) {
        return await this.prisma.sysEasterEgg.upsert({
          where: {
            userId_eggType: {
              userId: data.userId,
              eggType: data.eggType,
            }
          },
          update: {
            score: data.score,
            achievedAt: kstNow, 
          },
          create: {
            userId: data.userId,
            eggType: data.eggType,
            score: data.score,
            createdAt: kstNow,
            achievedAt: kstNow,
          },
        });
      }
      
      return existingRecord;

    } catch (error) {
      this.logger.error("saveEasterEgg Error:", error);
      throw new InternalServerErrorException("Failed to save easter egg record");
    }
  }

  async getEasterEggRanking(eggType: string) {
    try {
      const rankings = await this.prisma.$queryRaw<any[]>`
        SELECT 
          user_id as "id", 
          score,
          TO_CHAR(created_at, 'YYYY-MM-DD HH24:MI:SS') as "createdAt",
          TO_CHAR(achieved_at, 'YYYY-MM-DD HH24:MI:SS') as "achievedAt"
        FROM sys_easter_egg
        WHERE egg_type = ${eggType}
        ORDER BY score DESC, achieved_at ASC
        LIMIT 5;
      `;
      
      return Array.isArray(rankings) 
        ? rankings.map(r => ({ 
            id: String(r.id), 
            score: Number(r.score),
            createdAt: r.createdAt,
            achievedAt: r.achievedAt
          })) 
        : [];
    } catch (error) {
      this.logger.error("getEasterEggRanking Error:", error);
      throw new InternalServerErrorException("Failed to fetch easter egg rankings");
    }
  }
}
