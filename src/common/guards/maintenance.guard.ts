// ITM-Data-API_v1/src/common/guards/maintenance.guard.ts
import { Injectable, CanActivate, ExecutionContext, ServiceUnavailableException } from '@nestjs/common';
import { PrismaService } from '../../prisma.service';

@Injectable()
export class MaintenanceGuard implements CanActivate {
  constructor(private prisma: PrismaService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest();
    
    // 1. 관리자 설정 API, 로그인/SAML 인증 API는 점검 모드에서도 항상 예외 통과
    const allowPaths = ['/api/admin', '/api/auth/login', '/api/auth/saml'];
    if (allowPaths.some(path => request.url.includes(path))) {
      return true;
    }

    // 👨‍💻 [수정] 2. JWT 인증을 거쳐 request 객체에 담긴 사용자의 Role이 ADMIN인 경우 모든 데이터 API 통과
    const user = request.user;
    if (user && user.role === 'ADMIN') {
      return true;
    }

    try {
      // 3. 일반 사용자일 경우 점검 모드 상태 조회 후 차단
      const result: any[] = await this.prisma.$queryRaw`
        SELECT config_value FROM cfg_system_config WHERE config_key = 'MAINTENANCE_MODE'
      `;
      
      if (result.length > 0 && result[0].config_value === 'true') {
        throw new ServiceUnavailableException('시스템 점검 중입니다. 서비스 복구까지 잠시만 기다려 주세요.');
      }
    } catch (error) {
      // 조회 에러 발생 시 앱 중단 방지
      return true;
    }

    return true;
  }
}
