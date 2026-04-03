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

  // ---------------------------------------------------------
  // [Helper] KST 시간 생성 함수
  // ---------------------------------------------------------
  private getKstDate(): Date {
    const now = new Date();
    // UTC 시간에 9시간(ms)을 더해 KST Date 객체 생성
    return new Date(now.getTime() + 9 * 60 * 60 * 1000);
  }

  async login(loginDto: LoginDto) {
    return this.generateToken(loginDto.username, 'USER');
  }

  async guestLogin(loginDto: LoginDto) {
    return this.generateToken(loginDto.username, 'GUEST');
  }

  // =========================================================
  // [Guest Request Logic] - 신청 등록 구현 (KST 적용)
  // =========================================================

  async createGuestRequest(data: any) {
    const kstNow = this.getKstDate(); // KST 시간

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

  // =========================================================
  // [Context Logic] - DB 연동 (KST 적용)
  // =========================================================

  async getUserContext(loginId: string) {
    if (!loginId) {
      this.logger.error('[getUserContext] loginId is missing');
      throw new BadRequestException('loginId is required');
    }

    this.logger.log(`[DB Query] Finding context for loginId: ${loginId}`);

    const context = await this.prisma.sysUserContext.findUnique({
      where: { loginId },
      include: {
        sdwtInfo: true, 
      },
    });

    if (!context) {
      this.logger.warn(`[DB Result] No SysUserContext found for loginId: ${loginId}`);
      return null;
    }

    if (!context.sdwtInfo) {
      this.logger.warn(`[DB Result] Context found but 'sdwtInfo' (Join) is null. lastSdwtId: ${context.lastSdwtId}`);
      return null;
    }

    const result = {
      site: context.sdwtInfo.site,
      sdwt: context.sdwtInfo.sdwt,
    };

    this.logger.log(`[DB Result] Success. Returning: ${JSON.stringify(result)}`);
    return result;
  }

  async saveUserContext(loginId: string, site: string, sdwtName: string) {
    this.logger.log(`[saveUserContext] Searching RefSdwt for Site: ${site}, Name: ${sdwtName}`);

    const sdwtInfo = await this.prisma.refSdwt.findFirst({
      where: {
        site: site,
        sdwt: sdwtName,
      },
    });

    if (!sdwtInfo) {
      this.logger.error(`[saveUserContext] SDWT Info not found in DB.`);
      throw new NotFoundException(`SDWT info not found for Site: ${site}, Name: ${sdwtName}`);
    }

    // KST 시간 적용
    const kstNow = this.getKstDate();

    // 사용자 정보 없으면 생성 (안전장치)
    const userExists = await this.prisma.sysUser.findUnique({ where: { loginId } });
    if (!userExists) {
        this.logger.log(`[saveUserContext] Creating SysUser for safety.`);
        await this.prisma.sysUser.create({
            data: { 
              loginId, 
              loginCount: 1, 
              lastLoginAt: kstNow,
              createdAt: kstNow
            }
        });
    }

    // Context 저장 (KST 적용)
    await this.prisma.sysUserContext.upsert({
      where: { loginId },
      update: {
        lastSdwtId: sdwtInfo.id,
        updatedAt: kstNow,
      },
      create: {
        loginId,
        lastSdwtId: sdwtInfo.id,
        updatedAt: kstNow,
      },
    });

    this.logger.log(`[saveUserContext] Successfully saved.`);
    return { status: 'success', site, sdwt: sdwtName };
  }

  // =========================================================
  // [Backend 연동 로직] - Whitelist 및 권한 검증
  // =========================================================

  // [전체 교체] ITM-Data-API_v1/src/auth/auth.service.ts 내의 checkWhitelist 함수
  async checkWhitelist(loginId: string, compId?: string, deptId?: string) {
    this.logger.log(`[Whitelist] Checking loginId=${loginId}, compId=${compId}, deptId=${deptId}`);

    // 1순위: 새로 추가된 '개별 예외 허용 사용자' 검증
    const exceptionUser = await this.prisma.cfgUserException.findUnique({
      where: { loginId }
    });

    if (exceptionUser && exceptionUser.isActive === 'Y') {
      this.logger.log(`[Whitelist] Exception Access Granted for UserID: ${loginId}`);
      return { isActive: 'Y', role: 'USER' }; 
    }

    // 2순위: 부서 단위의 엄격한 권한 검증 (보안 결함 수정)
    if (!deptId) {
      this.logger.warn(`[Whitelist] Access Denied. No Dept ID provided.`);
      throw new BadRequestException('Department ID is required for access.');
    }

    // OR 조건이 아닌, deptId(PK) 기준으로 정확히 일치하는 부서만 찾습니다.
    const access = await this.prisma.refAccessCode.findUnique({
      where: { deptid: deptId }
    });

    if (access && access.isActive === 'Y') {
      // (선택적 보안 강화) 넘어온 회사 코드와 등록된 회사 코드가 일치하는지까지 교차 검증
      if (compId && access.compid && access.compid !== compId) {
         this.logger.warn(`[Whitelist] Access Denied. Company Code mismatch.`);
         throw new ForbiddenException('Company Code mismatch.');
      }
      this.logger.log(`[Whitelist] Access Granted via Dept: ${access.deptName}`);
      return { isActive: 'Y', role: 'USER' };
    }

    this.logger.warn(`[Whitelist] Access Denied. User's deptId (${deptId}) is not in whitelist.`);
    throw new NotFoundException('Not allowed');
  }

  async syncUser(dto: SyncUserDto) {
    const loginId = dto.loginId || dto.username || 'unknown';
    this.logger.log(`[Sync] Syncing user: ${loginId}`);
    
    const kstNow = this.getKstDate();

    try {
      await this.prisma.sysUser.upsert({
        where: { loginId },
        update: { 
            lastLoginAt: kstNow, 
            loginCount: { increment: 1 } 
        },
        create: { 
            loginId, 
            loginCount: 1, 
            lastLoginAt: kstNow,
            createdAt: kstNow 
        },
      });
    } catch (e) {
      this.logger.error(`[Sync] DB Error (Ignored): ${e}`);
    }
    return { loginId, status: 'synced' };
  }

  async checkAdmin(loginId: string) {
    const admin = await this.prisma.cfgAdminUser.findUnique({ where: { loginId } });
    if (admin) return { role: admin.role || 'ADMIN' };
    throw new NotFoundException('Not an admin');
  }

  /**
   * [수정] Guest 권한 확인 (KST 기준) 및 유효기간 반환
   */
  async checkGuest(loginId: string) {
    const guest = await this.prisma.cfgGuestAccess.findUnique({ where: { loginId } });
    
    // 현재 시간(KST) 생성
    const kstNow = this.getKstDate();

    // 유효기간 검증: validUntil이 현재 시간보다 미래여야 함
    if (guest && guest.validUntil > kstNow) {
       return { 
         grantedRole: 'GUEST',
         validUntil: guest.validUntil // 프론트엔드 알림을 위해 반환
       };
    }
    
    throw new NotFoundException('Not a guest');
  }

  private generateToken(username: string, role: string) {
    const payload = { username, role, sub: username };
    return {
      accessToken: this.jwtService.sign(payload),
      user: { username, role },
    };
  }
}
