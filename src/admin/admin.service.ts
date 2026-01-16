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
  // [User Management]
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
  // [Guest Management]
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
  // [Guest Request]
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
  // [추가] 1. 에러 심각도 (Error Severity)
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
  // [추가] 2. 분석 지표 (Analysis Metrics)
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
}
