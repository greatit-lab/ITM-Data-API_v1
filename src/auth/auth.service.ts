// ITM-Data-API/src/auth/auth.service.ts
import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma.service';

@Injectable()
export class AuthService {
  constructor(private prisma: PrismaService) {}

  async checkWhitelist(compId?: string, deptId?: string) {
    // 1. Company ID 확인
    if (compId) {
      const found = await this.prisma.refAccessCode.findFirst({
        where: { compid: compId, isActive: 'Y' },
      });
      if (found) return { isActive: 'Y' };
    }
    // 2. Dept ID 확인
    if (deptId) {
      const found = await this.prisma.refAccessCode.findFirst({
        where: { deptid: deptId, isActive: 'Y' },
      });
      if (found) return { isActive: 'Y' };
    }
    return { isActive: 'N' };
  }

  async syncUser(loginId: string) {
    // 유저가 없으면 생성, 있으면 로그인 카운트 증가 등 업데이트
    const user = await this.prisma.sysUser.upsert({
      where: { loginId },
      update: {
        lastLoginAt: new Date(),
        loginCount: { increment: 1 },
      },
      create: {
        loginId,
        loginCount: 1,
      },
    });
    return user;
  }

  async checkAdmin(loginId: string) {
    return this.prisma.cfgAdminUser.findUnique({
      where: { loginId },
      select: { role: true },
    });
  }

  async checkGuest(loginId: string) {
    const now = new Date();
    return this.prisma.cfgGuestAccess.findFirst({
      where: {
        loginId,
        validUntil: { gte: now },
      },
      select: { grantedRole: true },
    });
  }

  async getGuestRequestStatus(loginId: string) {
    return this.prisma.cfgGuestRequest.findFirst({
      where: { loginId },
      orderBy: { createdAt: 'desc' },
      select: { status: true },
    });
  }

  async getUserContext(loginId: string) {
    const context = await this.prisma.sysUserContext.findUnique({
      where: { loginId },
      include: { sdwtInfo: true },
    });

    if (!context) return null;

    return {
      sdwtInfo: {
        site: context.sdwtInfo.site,
        sdwt: context.sdwtInfo.sdwt,
      },
    };
  }

  async saveUserContext(loginId: string, site: string, sdwt: string) {
    // SDWT ID 찾기
    const sdwtRef = await this.prisma.refSdwt.findFirst({
      where: { site, sdwt },
    });
    
    if (!sdwtRef) {
      throw new NotFoundException(`SDWT not found for site=${site}, sdwt=${sdwt}`);
    }

    return this.prisma.sysUserContext.upsert({
      where: { loginId },
      update: { lastSdwtId: sdwtRef.id },
      create: {
        loginId,
        lastSdwtId: sdwtRef.id,
      },
    });
  }

  async getAccessCodes() {
    return this.prisma.refAccessCode.findMany({
      where: { isActive: 'Y' },
      orderBy: { compid: 'asc' },
    });
  }

  async createGuestRequest(data: any) {
    // data: { loginId, deptCode, deptName, reason }
    return this.prisma.cfgGuestRequest.create({
      data: {
        loginId: data.loginId,
        deptCode: data.deptCode,
        deptName: data.deptName,
        reason: data.reason,
        status: 'PENDING',
      },
    });
  }
}
