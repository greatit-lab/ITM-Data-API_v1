// ITM-Data-API/src/admin/admin.service.ts
import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma.service';

@Injectable()
export class AdminService {
  constructor(private prisma: PrismaService) {}

  // ---------------------------------------------------------
  // [Helper] KST 시간 생성 함수
  // ---------------------------------------------------------
  private getKstDate(): Date {
    const now = new Date();
    return new Date(now.getTime() + 9 * 60 * 60 * 1000);
  }

  // ==========================================
  // [User Management] 시스템 사용자 조회
  // ==========================================
  async getAllUsers() {
    return this.prisma.sysUser.findMany({
      include: {
        context: {
          include: { sdwtInfo: true },
        },
      },
      orderBy: { lastLoginAt: 'desc' },
    });
  }

  // ==========================================
  // [Admin Management] 운영자(Manager) 관리
  // ==========================================
  async getAllAdmins() {
    return this.prisma.cfgAdminUser.findMany({
      orderBy: { assignedAt: 'desc' },
    });
  }

  async addAdmin(data: any) {
    const kstNow = this.getKstDate();
    return this.prisma.cfgAdminUser.create({
      data: {
        loginId: data.loginId,
        role: data.role || 'MANAGER',
        assignedBy: data.assignedBy,
        assignedAt: kstNow,
      },
    });
  }

  async deleteAdmin(loginId: string) {
    return this.prisma.cfgAdminUser.delete({
      where: { loginId },
    });
  }

  // ==========================================
  // [Access Code / Whitelist] 접근 허용 관리
  // ==========================================
  async getAllAccessCodes() {
    return this.prisma.refAccessCode.findMany({
      orderBy: { updatedAt: 'desc' },
      select: {
        compid: true,
        compName: true,
        deptid: true,
        deptName: true,
        description: true,
        isActive: true,
        updatedAt: true,
      },
    });
  }

  async createAccessCode(data: any) {
    const kstNow = this.getKstDate();
    return this.prisma.refAccessCode.create({
      data: {
        compid: data.compid, // PK
        compName: data.compName,
        deptid: data.deptid,
        deptName: data.deptName,
        description: data.description,
        isActive: 'Y',
        updatedAt: kstNow,
      },
    });
  }

  async updateAccessCode(compid: string, data: any) {
    const kstNow = this.getKstDate();
    return this.prisma.refAccessCode.update({
      where: { compid },
      data: {
        compName: data.compName,
        deptid: data.deptid,
        deptName: data.deptName,
        description: data.description,
        isActive: data.isActive,
        updatedAt: kstNow,
      },
    });
  }

  async deleteAccessCode(compid: string) {
    return this.prisma.refAccessCode.delete({
      where: { compid },
    });
  }

  // ==========================================
  // [Guest Management] 게스트 이력 관리
  // ==========================================
  async getAllGuests() {
    return this.prisma.cfgGuestAccess.findMany({
      orderBy: { createdAt: 'desc' },
    });
  }

  async addGuest(data: any) {
    const kstNow = this.getKstDate();
    return this.prisma.cfgGuestAccess.create({
      data: {
        loginId: data.loginId,
        deptCode: data.deptCode,
        deptName: data.deptName,
        reason: data.reason,
        validUntil: new Date(data.validUntil),
        grantedRole: 'GUEST',
        createdAt: kstNow, 
      },
    });
  }

  async deleteGuest(loginId: string) {
    return this.prisma.cfgGuestAccess.delete({
      where: { loginId },
    });
  }

  // ==========================================
  // [Guest Request] 접근 신청 관리
  // ==========================================
  async getGuestRequests() {
    return this.prisma.cfgGuestRequest.findMany({
      orderBy: { createdAt: 'desc' },
    });
  }

  async approveGuestRequest(reqId: number, approverId: string) {
    const request = await this.prisma.cfgGuestRequest.findUnique({ where: { reqId } });
    if (!request) throw new NotFoundException('Request not found');

    const kstNow = this.getKstDate();
    const validUntil = new Date(kstNow.getTime());
    validUntil.setDate(validUntil.getDate() + 30);

    return this.prisma.$transaction(async (tx) => {
      await tx.cfgGuestRequest.update({
        where: { reqId },
        data: {
          status: 'APPROVED',
          processedBy: approverId,
          processedAt: kstNow,
        },
      });

      const guest = await tx.cfgGuestAccess.upsert({
        where: { loginId: request.loginId },
        update: {
          validUntil: validUntil,
          reason: request.reason,
          grantedRole: 'GUEST',
        },
        create: {
          loginId: request.loginId,
          deptCode: request.deptCode,
          deptName: request.deptName,
          reason: request.reason,
          grantedRole: 'GUEST',
          validUntil: validUntil,
          createdAt: kstNow,
        },
      });
      return guest;
    });
  }

  async rejectGuestRequest(reqId: number, rejectorId: string) {
    const kstNow = this.getKstDate();
    return this.prisma.cfgGuestRequest.update({
      where: { reqId },
      data: {
        status: 'REJECTED',
        processedBy: rejectorId,
        processedAt: kstNow,
      },
    });
  }

  // ==========================================
  // [Infra] 1. 에러 심각도 (Severity)
  // ==========================================
  async getSeverities() {
    return this.prisma.errSeverityMap.findMany();
  }

  async addSeverity(data: any) {
    return this.prisma.errSeverityMap.create({
      data: {
        errorId: data.errorId,
        severity: data.severity,
      },
    });
  }

  async updateSeverity(errorId: string, data: any) {
    return this.prisma.errSeverityMap.update({
      where: { errorId },
      data: {
        severity: data.severity,
      },
    });
  }

  async deleteSeverity(errorId: string) {
    return this.prisma.errSeverityMap.delete({
      where: { errorId },
    });
  }

  // ==========================================
  // [Infra] 2. 분석 지표 (Metrics)
  // ==========================================
  async getMetrics() {
    return this.prisma.cfgLotUniformityMetrics.findMany();
  }

  async addMetric(data: any) {
    return this.prisma.cfgLotUniformityMetrics.create({
      data: {
        metricName: data.metricName,
        isExcluded: data.isExcluded ? 'Y' : 'N',
      },
    });
  }

  async updateMetric(metricName: string, data: any) {
    return this.prisma.cfgLotUniformityMetrics.update({
      where: { metricName },
      data: {
        isExcluded: data.isExcluded ? 'Y' : 'N',
      },
    });
  }

  async deleteMetric(metricName: string) {
    return this.prisma.cfgLotUniformityMetrics.delete({
      where: { metricName },
    });
  }

  // ==========================================
  // [System Config] 1. 공통 서버 설정 (New Server)
  // ==========================================
  async getNewServerConfig() {
    // id는 1로 고정하여 관리
    return this.prisma.cfgNewServer.findUnique({
      where: { id: 1 },
    });
  }

  async updateNewServerConfig(data: any) {
    // upsert: 없으면 생성, 있으면 수정
    return this.prisma.cfgNewServer.upsert({
      where: { id: 1 },
      update: {
        newDbHost: data.newDbHost,
        newDbUser: data.newDbUser,
        newDbPw: data.newDbPw,
        newDbPort: data.newDbPort ? parseInt(data.newDbPort) : 5432,
        newFtpHost: data.newFtpHost,
        newFtpUser: data.newFtpUser,
        newFtpPw: data.newFtpPw,
        newFtpPort: data.newFtpPort ? parseInt(data.newFtpPort) : 21,
        description: data.description,
      },
      create: {
        id: 1,
        newDbHost: data.newDbHost || '',
        newDbUser: data.newDbUser,
        newDbPw: data.newDbPw,
        newDbPort: data.newDbPort ? parseInt(data.newDbPort) : 5432,
        newFtpHost: data.newFtpHost || '',
        newFtpUser: data.newFtpUser,
        newFtpPw: data.newFtpPw,
        newFtpPort: data.newFtpPort ? parseInt(data.newFtpPort) : 21,
        description: data.description,
      },
    });
  }

  // ==========================================
  // [System Config] 2. 장비별 에이전트 설정 (Cfg Server)
  // [개선] Site, SDWT 정보 Join 하여 반환
  // ==========================================
  async getCfgServers() {
    // 1. 에이전트 설정 목록 조회
    const servers = await this.prisma.cfgServer.findMany({
      orderBy: { eqpid: 'asc' },
    });

    if (!servers.length) return [];

    // 2. 관련된 장비들의 Site, SDWT 정보 조회 (Join)
    const eqpIds = servers.map(s => s.eqpid);
    const equipments = await this.prisma.refEquipment.findMany({
      where: { eqpid: { in: eqpIds } },
      select: {
        eqpid: true,
        sdwt: true,
        sdwtRel: {
          select: { site: true }
        }
      }
    });

    // 3. 매핑용 Map 생성 (eqpid -> equipment info)
    const eqpMap = new Map(equipments.map(e => [e.eqpid, e]));

    // 4. 데이터 병합 (Merge)
    return servers.map(server => {
      const eqp = eqpMap.get(server.eqpid);
      return {
        ...server,
        // 장비 정보가 있으면 해당 정보를, 없으면 '-' 처리
        sdwt: eqp?.sdwt || '-',
        site: eqp?.sdwtRel?.site || '-'
      };
    });
  }

  async updateCfgServer(eqpid: string, data: any) {
    return this.prisma.cfgServer.update({
      where: { eqpid },
      data: {
        agentDbHost: data.agentDbHost,
        agentFtpHost: data.agentFtpHost,
        updateFlag: data.updateFlag, // 'yes' | 'no'
      },
    });
  }
}
