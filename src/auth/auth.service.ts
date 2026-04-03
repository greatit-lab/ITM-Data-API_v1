// ITM-Data-API/src/auth/auth.service.ts
import { Injectable, Logger, NotFoundException, BadRequestException, ForbiddenException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { PrismaService } from '../prisma.service';
import { LoginDto, SyncUserDto } from './auth.interface';

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    private prisma: PrismaService,
    private jwtService: JwtService,
  ) {}

  private getKstDate(): Date {
    const now = new Date();
    return new Date(now.getTime() + 9 * 60 * 60 * 1000);
  }

  // =========================================================
  // [인증 검증 로직] - 사용자의 요청에 따른 순서 재배치
  // =========================================================

  async checkWhitelist(loginId: string, compId?: string, deptId?: string) {
    this.logger.log(`[Whitelist] Checking loginId=${loginId}, compId=${compId}, deptId=${deptId}`);

    // 🌟 [1단계] 부서 단위 엄격 검증 (최우선 확인)
    if (deptId) {
      const access = await this.prisma.refAccessCode.findUnique({
        where: { deptid: deptId }
      });

      if (access && access.isActive === 'Y') {
        // 회사 코드 교차 검증 (보안 강화)
        if (compId && access.compid && access.compid !== compId) {
          this.logger.warn(`[Whitelist] Access Denied. Company Code mismatch for Dept: ${deptId}`);
          throw new ForbiddenException('Company Code mismatch.');
        }
        this.logger.log(`[Whitelist] Access Granted via Dept: ${access.deptName}`);
        return { isActive: 'Y', role: 'USER' };
      }
    }

    // 🌟 [2단계] 개별 예외 사용자 확인 (부서 매칭 실패 시 확인)
    const exceptionUser = await this.prisma.cfgUserException.findUnique({
      where: { loginId }
    });

    if (exceptionUser && exceptionUser.isActive === 'Y') {
      this.logger.log(`[Whitelist] Exception Access Granted for UserID: ${loginId}`);
      return { isActive: 'Y', role: 'USER' }; 
    }

    // 🌟 [3단계] 모두 해당 없음 (이후 로직에서 게스트 신청 상태 확인으로 이어짐)
    this.logger.warn(`[Whitelist] Access Denied. No matching Dept or Exception found for: ${loginId}`);
    throw new NotFoundException('Not allowed');
  }

  // ... 이하 기존 코드(login, syncUser, checkGuest 등)는 동일하게 유지 ...
  
  async login(loginDto: LoginDto) {
    return this.generateToken(loginDto.username, 'USER');
  }

  async guestLogin(loginDto: LoginDto) {
    return this.generateToken(loginDto.username, 'GUEST');
  }

  async createGuestRequest(data: any) {
    const kstNow = this.getKstDate();
    return this.prisma.cfgGuestRequest.create({
      data: {
        loginId: data.loginId,
        deptCode: data.deptCode,
        deptName: data.deptName,
        reason: data.reason,
        status: 'PENDING',
        createdAt: kstNow, 
      },
    });
  }

  async getGuestRequestStatus(loginId: string) {
    const request = await this.prisma.cfgGuestRequest.findFirst({
      where: { loginId },
      orderBy: { reqId: 'desc' },
    });
    if (request) return { status: request.status };
    throw new NotFoundException('No request found');
  }

  async getUserContext(loginId: string) {
    if (!loginId) throw new BadRequestException('loginId is required');
    const context = await this.prisma.sysUserContext.findUnique({
      where: { loginId },
      include: { sdwtInfo: true },
    });
    if (!context || !context.sdwtInfo) return null;
    return { site: context.sdwtInfo.site, sdwt: context.sdwtInfo.sdwt };
  }

  async saveUserContext(loginId: string, site: string, sdwtName: string) {
    const sdwtInfo = await this.prisma.refSdwt.findFirst({ where: { site, sdwt: sdwtName } });
    if (!sdwtInfo) throw new NotFoundException(`SDWT info not found`);
    const kstNow = this.getKstDate();
    const userExists = await this.prisma.sysUser.findUnique({ where: { loginId } });
    if (!userExists) {
        await this.prisma.sysUser.create({ data: { loginId, loginCount: 1, lastLoginAt: kstNow, createdAt: kstNow } });
    }
    await this.prisma.sysUserContext.upsert({
      where: { loginId },
      update: { lastSdwtId: sdwtInfo.id, updatedAt: kstNow },
      create: { loginId, lastSdwtId: sdwtInfo.id, updatedAt: kstNow },
    });
    return { status: 'success', site, sdwt: sdwtName };
  }

  async syncUser(dto: SyncUserDto) {
    const loginId = dto.loginId || dto.username || 'unknown';
    const kstNow = this.getKstDate();
    try {
      await this.prisma.sysUser.upsert({
        where: { loginId },
        update: { lastLoginAt: kstNow, loginCount: { increment: 1 } },
        create: { loginId, loginCount: 1, lastLoginAt: kstNow, createdAt: kstNow },
      });
    } catch (e) { this.logger.error(`[Sync] DB Error: ${e}`); }
    return { loginId, status: 'synced' };
  }

  async checkAdmin(loginId: string) {
    const admin = await this.prisma.cfgAdminUser.findUnique({ where: { loginId } });
    if (admin) return { role: admin.role || 'ADMIN' };
    throw new NotFoundException('Not an admin');
  }

  async checkGuest(loginId: string) {
    const guest = await this.prisma.cfgGuestAccess.findUnique({ where: { loginId } });
    const kstNow = this.getKstDate();
    if (guest && guest.validUntil > kstNow) {
       return { grantedRole: 'GUEST', validUntil: guest.validUntil };
    }
    throw new NotFoundException('Not a guest');
  }

  private generateToken(username: string, role: string) {
    const payload = { username, role, sub: username };
    return { accessToken: this.jwtService.sign(payload), user: { username, role } };
  }
}
