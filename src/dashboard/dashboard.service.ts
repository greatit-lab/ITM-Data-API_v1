// ITM-Data-API/src/dashboard/dashboard.service.ts
import { Injectable, InternalServerErrorException, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma.service';
import { Prisma } from '@prisma/client';

interface AgentStatusRawResult {
  eqpid: string;
  is_online: boolean;
  last_contact: Date | null;
  pc_name: string | null;
  cpu_usage: number;
  mem_usage: number;
  app_ver: string | null;
  type: string | null;
  ip_address: string | null;
  os: string | null;
  system_type: string | null;
  locale: string | null;
  timezone: string | null;
  today_alarm_count: number;
  last_perf_serv_ts: Date | null;
  last_perf_eqp_ts: Date | null;
  use_proxy: string | null; 
  proxy_ip: string | null;  
}

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

  // [극강의 방어력 적용] 에러 원천 차단형 메모리 집계 로직
  async getGlobalFleetData() {
    try {
      const kstNow = new Date(new Date().getTime() + 9 * 60 * 60 * 1000);
      const todayDateStr = kstNow.toISOString().split('T')[0];
      const startOfToday = new Date(`${todayDateStr}T00:00:00.000Z`);

      // 1. 모든 사용 중인 SDWT 기본 정보 조회
      const sdwts = await this.prisma.refSdwt.findMany({
        where: { isUse: 'Y' },
        select: { id: true, site: true, sdwt: true },
        orderBy: { id: 'asc' }
      });

      // 2. 장비 조회 (Prisma 에러를 유발할 수 있는 isNot: null 조건을 빼고 전체를 가져옴)
      const rawEquipments = await this.prisma.refEquipment.findMany({
        where: { sdwtRel: { isUse: 'Y' } },
        select: {
          eqpid: true,
          sdwt: true,
          agentInfo: { select: { eqpid: true } },
          agentStatus: { select: { status: true } },
        }
      });

      // 서버 메모리에서 안전하게 필터링 (에이전트가 등록된 장비만 남김)
      const equipments = rawEquipments.filter(e => e.agentInfo !== null);
      const eqpIds = equipments.map((e) => e.eqpid);
      
      // 3. 에러 카운트 (개별 테이블 오류로 전체 로딩이 멈추지 않도록 독립 try-catch 적용)
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
        this.logger.warn("PlgError Query Failed (에러 데이터 로드 실패, 조회는 계속됨):", err);
      }

      // 4. 프론트엔드용 JSON 트리 구조로 In-Memory 고속 집계
      const siteMap = new Map<string, any>();
      let siteIndex = 0;

      // 사이트 및 SDWT 골격 먼저 생성
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
            summary: { todayErrorCount: 0 },
            index: siteObj.sdwts.length
          });
        }
      }

      // 조회된 장비 데이터를 골격에 채워 넣기
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

        // SDWT 누적
        sdwtObj.totalCount++;
        if (isOnline) sdwtObj.onlineCount++;
        else sdwtObj.offlineCount++;
        if (hasError) sdwtObj.summary.todayErrorCount++;

        // Site 누적
        siteObj.siteStats.total++;
        if (isOnline) siteObj.siteStats.online++;
        else siteObj.siteStats.offline++;
        if (hasError) siteObj.siteStats.alerts++;
      }

      return Array.from(siteMap.values());

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
        const [totalError, recentError] = await Promise.all([
          this.prisma.plgError.count({
            where: {
              timeStamp: { gte: startOfToday }, 
              equipment: equipmentWhere,
            },
          }),
          this.prisma.plgError.count({
            where: { 
              timeStamp: { gte: oneHourAgo }, 
              equipment: equipmentWhere 
            },
          }),
        ]);

        todayErrorTotalCount = totalError;
        newAlarmCount = recentError;

        if (todayErrorTotalCount > 0) {
           const errorEqps = await this.prisma.plgError.findMany({
             where: {
               timeStamp: { gte: startOfToday },
               equipment: equipmentWhere,
             },
             distinct: ['eqpid'],
             select: { eqpid: true },
           });
           todayErrorCount = errorEqps.length;
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

      let whereCondition = Prisma.sql`WHERE r.sdwt IN (SELECT sdwt FROM public.ref_sdwt WHERE is_use = 'Y')`;

      if (safeSdwt) {
        whereCondition = Prisma.sql`${whereCondition} AND r.sdwt = ${safeSdwt}`;
      } else if (safeSite) {
        whereCondition = Prisma.sql`${whereCondition} AND r.sdwt IN (SELECT sdwt FROM public.ref_sdwt WHERE site = ${safeSite})`;
      }

      const kstNow = new Date(new Date().getTime() + 9 * 60 * 60 * 1000);
      const todayDateStr = kstNow.toISOString().split('T')[0];

      const results = await this.prisma.$queryRaw<AgentStatusRawResult[]>`
        SELECT 
            a.eqpid, 
            CASE WHEN COALESCE(s.status, 'OFFLINE') = 'ONLINE' THEN true ELSE false END AS is_online, 
            s.last_perf_update AS last_contact,
            a.pc_name, 
            COALESCE(p.cpu_usage, 0) AS cpu_usage, 
            COALESCE(p.mem_usage, 0) AS mem_usage, 
            a.app_ver,
            a.type, a.ip_address, a.os, a.system_type, a.locale, a.timezone,
            COALESCE(e.alarm_count, 0)::int AS today_alarm_count,
            p.serv_ts AS last_perf_serv_ts,
            p.ts AS last_perf_eqp_ts,
            cs.use_proxy,
            cs.proxy_ip
        FROM public.agent_info a
        JOIN public.ref_equipment r ON a.eqpid = r.eqpid
        LEFT JOIN public.agent_status s ON a.eqpid = s.eqpid
        LEFT JOIN public.cfg_server cs ON a.eqpid = cs.eqpid
        LEFT JOIN (
            SELECT eqpid, cpu_usage, mem_usage, serv_ts, ts, 
                  ROW_NUMBER() OVER(PARTITION BY eqpid ORDER BY serv_ts DESC) as rn
            FROM public.eqp_perf
            WHERE serv_ts >= NOW() - INTERVAL '1 day' 
        ) p ON a.eqpid = p.eqpid AND p.rn = 1
        LEFT JOIN (
            SELECT eqpid, COUNT(*) AS alarm_count 
            FROM public.plg_error 
            WHERE time_stamp >= CAST(${todayDateStr} AS TIMESTAMP)
            GROUP BY eqpid
        ) e ON a.eqpid = e.eqpid
        ${whereCondition}
        ORDER BY a.eqpid ASC;
      `;

      return results.map((r) => {
        let clockDrift: number | null = null;
        if (r.last_perf_serv_ts && r.last_perf_eqp_ts) {
          const servTs = new Date(r.last_perf_serv_ts).getTime();
          const eqpTs = new Date(r.last_perf_eqp_ts).getTime();
          clockDrift = (servTs - eqpTs) / 1000;
        }

        return {
          eqpId: r.eqpid,
          isOnline: r.is_online,
          lastContact: r.last_contact,
          pcName: r.pc_name,
          cpuUsage: r.cpu_usage,
          memoryUsage: r.mem_usage,
          appVersion: r.app_ver || '',
          type: r.type || '',
          ipAddress: r.ip_address || '',
          os: r.os || '',
          systemType: r.system_type || '',
          locale: r.locale || '',
          timezone: r.timezone || '',
          todayAlarmCount: r.today_alarm_count,
          clockDrift: clockDrift,
          useProxy: r.use_proxy || 'N', 
          proxyIp: r.proxy_ip || '',    
        };
      });
    } catch (error) {
      this.logger.error("getAgentStatus Error:", error);
      throw new InternalServerErrorException("Failed to fetch agent status");
    }
  }
}
