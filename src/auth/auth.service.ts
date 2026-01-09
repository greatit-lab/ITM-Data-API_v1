// ITM-Data-API/src/auth/auth.service.ts
import { Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { PrismaService } from '../prisma.service';
import { LoginDto } from './auth.interface'; // [확인] 경로 일치

@Injectable()
export class AuthService {
  constructor(
    private prisma: PrismaService,
    private jwtService: JwtService,
  ) {}

  // 1. 로그인 로직
  async login(loginDto: LoginDto) {
    const { username, password } = loginDto;

    // [개발용] 관리자 프리패스 (실제 운영 시에는 삭제하거나 AD 연동)
    if (username === 'admin' && password === 'admin') {
      return this.generateToken(username, 'ADMIN');
    }

    // DB 사용자 조회
    const user = await this.prisma.sysUser.findUnique({
      where: { loginId: username },
    });

    if (!user) {
      // 사용자가 없으면 인증 실패 처리 (또는 AD 인증 후 자동 생성 로직 필요)
      throw new UnauthorizedException('Invalid credentials');
    }

    // [TODO] 비밀번호 검증 로직 추가 (bcrypt 등)
    
    // 권한 조회 (Admin 테이블 확인)
    const adminUser = await this.prisma.cfgAdminUser.findUnique({
      where: { loginId: username },
    });

    const role = adminUser ? adminUser.role : 'USER';

    return this.generateToken(username, role);
  }

  // 2. 게스트 로그인
  async guestLogin(loginDto: LoginDto) {
    const { username } = loginDto;

    const guestAccess = await this.prisma.cfgGuestAccess.findUnique({
      where: { loginId: username },
    });

    if (!guestAccess) {
      throw new UnauthorizedException('Guest access not granted');
    }

    if (guestAccess.validUntil < new Date()) {
      throw new UnauthorizedException('Guest access expired');
    }

    return this.generateToken(username, 'GUEST');
  }

  // 3. 토큰 생성 헬퍼
  private generateToken(username: string, role: string) {
    const payload = { username, role, sub: username };
    return {
      accessToken: this.jwtService.sign(payload),
      user: {
        username,
        role,
      },
    };
  }
}
