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

        const isLatest = eqp.agentInfo?.appVer === latestVersion;

        sdwtObj.totalCount++;
        if (isOnline) sdwtObj.onlineCount++;
        else sdwtObj.offlineCount++;
        if (hasError) sdwtObj.summary.todayErrorCount++;
        if (isLatest) sdwtObj.latestCount++; 

        siteObj.siteStats.total++;
        if (isOnline) siteObj.siteStats.online++;
        else siteObj.siteStats.offline++;
        if (hasError) siteObj.siteStats.alerts++;
      }

      const result = Array.from(siteMap.values());
      result.forEach(site => {
        site.sdwts.forEach((sdwt: any) => {
          sdwt.isAllLatest = sdwt.totalCount > 0 && sdwt.latestCount === sdwt.totalCount;
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

      // 🚀 핵심 성능 개선 구간: 루프를 제거하고 PostgreSQL DISTINCT ON을 활용한 단일 쿼리 일괄 조회
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

  // ========================================================================
  // 이스터에그(글로벌 리더보드) 기능
  // ========================================================================

  async saveEasterEgg(data: { userId: string; eggType: string; score: number }) {
    try {
      // KST(한국 표준시) 시간 강제 기록 적용
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
