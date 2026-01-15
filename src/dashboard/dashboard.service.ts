// ITM-Data-API/src/dashboard/dashboard.service.ts

import { Injectable, InternalServerErrorException, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma.service';
import { Prisma } from '@prisma/client';

// Raw Query 결과 매핑을 위한 인터페이스
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
}

@Injectable()
export class DashboardService {
  private readonly logger = new Logger(DashboardService.name);

  constructor(private prisma: PrismaService) {}

  // 버전 문자열 비교 헬퍼 함수
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

  // 1. 대시보드 요약 정보 조회
  async getSummary(site?: string, sdwt?: string) {
    try {
      // [개선] 빈 문자열 파라미터 처리 (빈 문자열이면 undefined로 변환하여 필터 무시)
      const safeSite = site && site.trim() !== '' ? site : undefined;
      const safeSdwt = sdwt && sdwt.trim() !== '' ? sdwt : undefined;

      this.logger.debug(`getSummary called with - site: ${safeSite}, sdwt: ${safeSdwt}`);

      // (1) 최신 Agent 버전 계산
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

      // (2) 장비 필터 조건 생성
      // [주의] safeSite, safeSdwt가 undefined이면 조건에서 제외됨 -> 전체 조회
      const equipmentWhere: Prisma.RefEquipmentWhereInput = {
        sdwtRel: {
          isUse: 'Y',
          ...(safeSite ? { site: safeSite } : {}),
        },
        ...(safeSdwt ? { sdwt: safeSdwt } : {}),
      };

      // 시간 기준점 설정
      const now = new Date();
      const tenMinutesAgo = new Date(now.getTime() - 10 * 60 * 1000);
      const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
      const oneHourAgo = new Date(now.getTime() - 60 * 60 * 1000);

      // (3) 주요 카운트 조회
      
      // 전체 장비 수 (Agent 정보가 있는 장비 대상)
      const totalEqp = await this.prisma.refEquipment.count({ 
        where: { 
          ...equipmentWhere,
          agentInfo: { isNot: null } 
        } 
      });

      // 전체 서버 설정 수
      const totalServers = await this.prisma.cfgServer.count();

      // 활성 서버 수 (최근 10분 내 업데이트)
      const activeServers = await this.prisma.cfgServer.count({
        where: { update: { gte: tenMinutesAgo } }
      });

      // 전체 SDWT 수
      const totalSdwts = await this.prisma.refSdwt.count({
        where: { 
          isUse: 'Y', 
          ...(safeSite ? { site: safeSite } : {}) 
        }
      });

      // (4) 에러 통계 조회
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

        // 에러 발생 장비 수 (Distinct Count)
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

      // 비활성 에이전트 수 계산
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

  // 2. Agent 상태 목록 조회 (Raw Query)
  async getAgentStatus(site?: string, sdwt?: string) {
    try {
      // [개선] 빈 문자열 파라미터 안전 처리
      const safeSite = site && site.trim() !== '' ? site : undefined;
      const safeSdwt = sdwt && sdwt.trim() !== '' ? sdwt : undefined;

      // 동적 WHERE 절 구성
      let whereCondition = Prisma.sql`WHERE r.sdwt IN (SELECT sdwt FROM public.ref_sdwt WHERE is_use = 'Y')`;

      if (safeSdwt) {
        whereCondition = Prisma.sql`${whereCondition} AND r.sdwt = ${safeSdwt}`;
      } else if (safeSite) {
        whereCondition = Prisma.sql`${whereCondition} AND r.sdwt IN (SELECT sdwt FROM public.ref_sdwt WHERE site = ${safeSite})`;
      }

      // 복잡한 조인을 위한 Raw Query 실행
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
            p.ts AS last_perf_eqp_ts
        FROM public.agent_info a
        JOIN public.ref_equipment r ON a.eqpid = r.eqpid
        LEFT JOIN public.agent_status s ON a.eqpid = s.eqpid
        LEFT JOIN (
            SELECT eqpid, cpu_usage, mem_usage, serv_ts, ts, 
                  ROW_NUMBER() OVER(PARTITION BY eqpid ORDER BY serv_ts DESC) as rn
            FROM public.eqp_perf
            WHERE serv_ts >= NOW() - INTERVAL '1 day' 
        ) p ON a.eqpid = p.eqpid AND p.rn = 1
        LEFT JOIN (
            SELECT eqpid, COUNT(*) AS alarm_count 
            FROM public.plg_error 
            WHERE time_stamp >= CURRENT_DATE
            GROUP BY eqpid
        ) e ON a.eqpid = e.eqpid
        ${whereCondition}
        ORDER BY a.eqpid ASC;
      `;

      // 결과 매핑 및 Time Drift 계산
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
        };
      });
    } catch (error) {
      this.logger.error("getAgentStatus Error:", error);
      throw new InternalServerErrorException("Failed to fetch agent status");
    }
  }
}
