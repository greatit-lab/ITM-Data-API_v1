// ITM-Data-API_v1/src/admin/admin.service.ts
import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma.service';

@Injectable()
export class AdminService {
  constructor(private prisma: PrismaService) {}

  private getKstDate(): Date {
    const now = new Date();
    return new Date(now.getTime() + 9 * 60 * 60 * 1000);
  }

  async getAllUsers() {
    return this.prisma.sysUser.findMany({
      include: { context: { include: { sdwtInfo: true } } },
      orderBy: { lastLoginAt: 'desc' },
    });
  }

  async getAllAdmins() { return this.prisma.cfgAdminUser.findMany({ orderBy: { assignedAt: 'desc' } }); }
  async addAdmin(data: any) { return this.prisma.cfgAdminUser.create({ data: { loginId: data.loginId, role: data.role || 'MANAGER', assignedBy: data.assignedBy, assignedAt: this.getKstDate() } }); }
  async deleteAdmin(loginId: string) { return this.prisma.cfgAdminUser.delete({ where: { loginId } }); }

  async getAllAccessCodes() {
    return this.prisma.refAccessCode.findMany({
      orderBy: { updatedAt: 'desc' },
      select: { compid: true, compName: true, deptid: true, deptName: true, description: true, isActive: true, updatedAt: true },
    });
  }
  async createAccessCode(data: any) { return this.prisma.refAccessCode.create({ data: { compid: data.compid, compName: data.compName, deptid: data.deptid, deptName: data.deptName, description: data.description, isActive: 'Y', updatedAt: this.getKstDate() } }); }
  async updateAccessCode(compid: string, data: any) { return this.prisma.refAccessCode.update({ where: { compid }, data: { compName: data.compName, deptid: data.deptid, deptName: data.deptName, description: data.description, isActive: data.isActive, updatedAt: this.getKstDate() } }); }
  async deleteAccessCode(compid: string) { return this.prisma.refAccessCode.delete({ where: { compid } }); }

  async getAllGuests() { return this.prisma.cfgGuestAccess.findMany({ orderBy: { createdAt: 'desc' } }); }
  async addGuest(data: any) { return this.prisma.cfgGuestAccess.create({ data: { loginId: data.loginId, deptCode: data.deptCode, deptName: data.deptName, reason: data.reason, validUntil: new Date(data.validUntil), grantedRole: 'GUEST', createdAt: this.getKstDate() } }); }
  async deleteGuest(loginId: string) { return this.prisma.cfgGuestAccess.delete({ where: { loginId } }); }

  async getGuestRequests() { return this.prisma.cfgGuestRequest.findMany({ orderBy: { createdAt: 'desc' } }); }
  async approveGuestRequest(reqId: number, approverId: string) {
    const request = await this.prisma.cfgGuestRequest.findUnique({ where: { reqId } });
    if (!request) throw new NotFoundException('Request not found');
    const kstNow = this.getKstDate();
    const validUntil = new Date(kstNow.getTime());
    validUntil.setDate(validUntil.getDate() + 30);

    return this.prisma.$transaction(async (tx) => {
      await tx.cfgGuestRequest.update({ where: { reqId }, data: { status: 'APPROVED', processedBy: approverId, processedAt: kstNow } });
      return tx.cfgGuestAccess.upsert({
        where: { loginId: request.loginId },
        update: { validUntil: validUntil, reason: request.reason, grantedRole: 'GUEST' },
        create: { loginId: request.loginId, deptCode: request.deptCode, deptName: request.deptName, reason: request.reason, grantedRole: 'GUEST', validUntil: validUntil, createdAt: kstNow },
      });
    });
  }
  async rejectGuestRequest(reqId: number, rejectorId: string) { return this.prisma.cfgGuestRequest.update({ where: { reqId }, data: { status: 'REJECTED', processedBy: rejectorId, processedAt: this.getKstDate() } }); }

  async getSeverities() { return this.prisma.errSeverityMap.findMany(); }
  async addSeverity(data: any) { return this.prisma.errSeverityMap.create({ data: { errorId: data.errorId, severity: data.severity } }); }
  async updateSeverity(errorId: string, data: any) { return this.prisma.errSeverityMap.update({ where: { errorId }, data: { severity: data.severity } }); }
  async deleteSeverity(errorId: string) { return this.prisma.errSeverityMap.delete({ where: { errorId } }); }

  async getMetrics() { return this.prisma.cfgLotUniformityMetrics.findMany(); }
  async addMetric(data: any) { return this.prisma.cfgLotUniformityMetrics.create({ data: { metricName: data.metricName, isExcluded: data.isExcluded ? 'Y' : 'N' } }); }
  async updateMetric(metricName: string, data: any) { return this.prisma.cfgLotUniformityMetrics.update({ where: { metricName }, data: { isExcluded: data.isExcluded ? 'Y' : 'N' } }); }
  async deleteMetric(metricName: string) { return this.prisma.cfgLotUniformityMetrics.delete({ where: { metricName } }); }

  async getNewServerConfig() { return this.prisma.cfgNewServer.findUnique({ where: { id: 1 } }); }
  async updateNewServerConfig(data: any) {
    return this.prisma.cfgNewServer.upsert({
      where: { id: 1 },
      update: { newDbHost: data.newDbHost, newDbUser: data.newDbUser, newDbPw: data.newDbPw, newDbPort: data.newDbPort ? parseInt(data.newDbPort) : 5432, newFtpHost: data.newFtpHost, newFtpUser: data.newFtpUser, newFtpPw: data.newFtpPw, newFtpPort: data.newFtpPort ? parseInt(data.newFtpPort) : 21, description: data.description },
      create: { id: 1, newDbHost: data.newDbHost || '', newDbUser: data.newDbUser, newDbPw: data.newDbPw, newDbPort: data.newDbPort ? parseInt(data.newDbPort) : 5432, newFtpHost: data.newFtpHost || '', newFtpUser: data.newFtpUser, newFtpPw: data.newFtpPw, newFtpPort: data.newFtpPort ? parseInt(data.newFtpPort) : 21, description: data.description },
    });
  }

  async getCfgServers() {
    const servers = await this.prisma.cfgServer.findMany({ orderBy: { eqpid: 'asc' } });
    if (!servers.length) return [];
    const eqpIds = servers.map(s => s.eqpid);
    const equipments = await this.prisma.refEquipment.findMany({ where: { eqpid: { in: eqpIds } }, select: { eqpid: true, sdwt: true, sdwtRel: { select: { site: true } } } });
    const eqpMap = new Map(equipments.map(e => [e.eqpid, e]));
    return servers.map(server => {
      const eqp = eqpMap.get(server.eqpid);
      return { ...server, sdwt: eqp?.sdwt || '-', site: eqp?.sdwtRel?.site || '-' };
    });
  }
  async updateCfgServer(eqpid: string, data: any) { return this.prisma.cfgServer.update({ where: { eqpid }, data: { agentDbHost: data.agentDbHost, agentFtpHost: data.agentFtpHost, updateFlag: data.updateFlag } }); }

  // ==========================================
  // [Usage Analytics] DB 실제 저장 및 조회 로직
  // ==========================================
  async logAccess(data: { loginId: string; menuName: string; accessUrl: string }) {
    return this.prisma.sysAccessLog.create({
      data: {
        loginId: data.loginId,
        menuName: data.menuName,
        accessUrl: data.accessUrl,
      },
    });
  }

  async getUsageAnalytics(startDate: string, endDate: string) {
    const start = new Date(startDate);
    const end = new Date(endDate);
    end.setHours(23, 59, 59, 999);

    // [개선] 증감률 계산을 위한 이전 기간(Previous Period) 계산
    const periodMs = end.getTime() - start.getTime() + 1;
    const prevStart = new Date(start.getTime() - periodMs);
    const prevEnd = new Date(end.getTime() - periodMs);

    const currentWhere = { accessTs: { gte: start, lte: end } };
    const prevWhere = { accessTs: { gte: prevStart, lte: prevEnd } };

    // 1. KPI 데이터 (현재 기간)
    const totalViews = await this.prisma.sysAccessLog.count({ where: currentWhere });
    const users = await this.prisma.sysAccessLog.groupBy({ by: ['loginId'], where: currentWhere });
    const totalUsers = users.length;
    
    // 1-1. KPI 데이터 (이전 기간)
    const prevViews = await this.prisma.sysAccessLog.count({ where: prevWhere });
    const prevUsersGrp = await this.prisma.sysAccessLog.groupBy({ by: ['loginId'], where: prevWhere });
    const prevUsers = prevUsersGrp.length;

    // 1-2. 증감률(Delta) 퍼센트 계산
    const viewsDelta = prevViews === 0 ? (totalViews > 0 ? 100 : 0) : Math.round(((totalViews - prevViews) / prevViews) * 100);
    const usersDelta = prevUsers === 0 ? (totalUsers > 0 ? 100 : 0) : Math.round(((totalUsers - prevUsers) / prevUsers) * 100);

    const topMenuObj = await this.prisma.sysAccessLog.groupBy({
      by: ['menuName'], _count: { menuName: true }, where: currentWhere,
      orderBy: { _count: { menuName: 'desc' } }, take: 1,
    });
    const topPage = topMenuObj.length > 0 ? topMenuObj[0].menuName : '-';

    // 2. 일별 트렌드
    const dailyData = await this.prisma.$queryRaw`
      SELECT to_char(access_ts, 'MM-DD') as date, COUNT(id)::int as views, COUNT(DISTINCT login_id)::int as users
      FROM public.sys_access_logs
      WHERE access_ts >= ${start} AND access_ts <= ${end}
      GROUP BY to_char(access_ts, 'MM-DD')
      ORDER BY date ASC
    `;

    // 3. 페이지 랭킹
    const menuUtilization = await this.prisma.sysAccessLog.groupBy({
      by: ['menuName'], _count: { menuName: true }, where: currentWhere,
      orderBy: { _count: { menuName: 'desc' } }, take: 10,
    });

    // 4. 최근 로그 (최대 1000건 - 페이징/다운로드용 넉넉히)
    const recentLogs = await this.prisma.sysAccessLog.findMany({
      where: currentWhere,
      orderBy: { accessTs: 'desc' },
      take: 1000,
    });

    return {
      kpi: { totalUsers, totalViews, topPage, viewsDelta, usersDelta },
      dailyTrend: dailyData,
      menuUtilization: menuUtilization.map((m) => ({ menu: m.menuName, views: m._count.menuName })),
      recentLogs: recentLogs.map((l) => ({
        time: new Date(l.accessTs).toLocaleString('sv-SE', { timeZone: 'Asia/Seoul' }).replace(',', ''), 
        loginId: l.loginId,
        menu: l.menuName,
      })),
    };
  }
}
