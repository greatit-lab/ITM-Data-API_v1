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
    
    // validUntil이 문자열로 넘어올 경우 처리 (KST 보정 필요 시 로직 추가 가능)
    // 현재는 입력받은 날짜 그대로 사용
    
    return this.prisma.cfgGuestAccess.create({
      data: {
        loginId: data.loginId,
        deptCode: data.deptCode,
        deptName: data.deptName,
        reason: data.reason,
        validUntil: new Date(data.validUntil),
        grantedRole: 'GUEST',
        createdAt: kstNow, // [수정] UTC -> KST
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

  // [승인 로직] KST 적용
  async approveGuestRequest(reqId: number, approverId: string) {
    const request = await this.prisma.cfgGuestRequest.findUnique({ where: { reqId } });
    if (!request) throw new NotFoundException('Request not found');

    const kstNow = this.getKstDate();
    
    // 유효기간: KST 현재 시간 기준 + 30일
    const validUntil = new Date(kstNow.getTime());
    validUntil.setDate(validUntil.getDate() + 30);

    return this.prisma.$transaction(async (tx) => {
      // 1. 요청 상태 변경 (processedAt: KST)
      await tx.cfgGuestRequest.update({
        where: { reqId },
        data: {
          status: 'APPROVED',
          processedBy: approverId,
          processedAt: kstNow, // [수정] UTC -> KST
        },
      });

      // 2. 게스트 권한 부여 (createdAt: KST)
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
          createdAt: kstNow, // [수정] UTC -> KST
        },
      });

      return guest;
    });
  }

  // [반려 로직] KST 적용
  async rejectGuestRequest(reqId: number, rejectorId: string) {
    const kstNow = this.getKstDate();

    return this.prisma.cfgGuestRequest.update({
      where: { reqId },
      data: {
        status: 'REJECTED',
        processedBy: rejectorId,
        processedAt: kstNow, // [수정] UTC -> KST
      },
    });
  }
}
