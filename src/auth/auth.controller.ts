// [전체 코드 교체] ITM-Data-API/src/auth/auth.controller.ts
import { Controller, Post, Get, Body, Query, Logger } from '@nestjs/common';
import { AuthService } from './auth.service';
import { LoginDto, SyncUserDto } from './auth.interface';

@Controller('auth')
export class AuthController {
  private readonly logger = new Logger(AuthController.name);

  constructor(private readonly authService: AuthService) {}

  @Get('ping')
  async ping() {
    return 'pong';
  }

  @Post('login')
  async login(@Body() loginDto: LoginDto) {
    return this.authService.login(loginDto);
  }

  @Post('guest/login')
  async guestLogin(@Body() loginDto: LoginDto) {
    return this.authService.guestLogin(loginDto);
  }

  // =========================================================
  // [Guest Request] 게스트 권한 신청 (신규 추가)
  // =========================================================
  
  /**
   * 게스트 접근 권한 신청 등록
   * BFF에서 전달된 신청 정보를 DB(cfg_guest_request)에 저장합니다.
   */
  @Post('guest-request')
  async createGuestRequest(@Body() body: any) {
    this.logger.log(`[Guest Request] Received request for: ${body.loginId}`);
    return this.authService.createGuestRequest(body);
  }

  @Get('guest-request/status')
  async getGuestRequestStatus(@Query('loginId') loginId: string) {
    return this.authService.getGuestRequestStatus(loginId);
  }

  // =========================================================
  // [사용자 Context (Site/SDWT) 관리]
  // =========================================================

  @Get('context')
  async getUserContext(@Query('loginId') loginId: string) {
    this.logger.log(`[API Request] GET /auth/context - loginId: ${loginId}`);
    const result = await this.authService.getUserContext(loginId);
    this.logger.log(`[API Response] GET /auth/context - Result: ${JSON.stringify(result)}`);
    return result;
  }

  @Post('context')
  async saveUserContext(@Body() body: { loginId: string; site: string; sdwt: string }) {
    this.logger.log(`[API Request] POST /auth/context - Body: ${JSON.stringify(body)}`);
    return this.authService.saveUserContext(body.loginId, body.site, body.sdwt);
  }

  // =========================================================
  // [Backend 연동 엔드포인트]
  // =========================================================

  @Get('whitelist/check')
  async checkWhitelist(
    @Query('compId') compId?: string,
    @Query('deptId') deptId?: string,
    @Query('username') username?: string, 
  ) {
    return this.authService.checkWhitelist(compId, deptId);
  }

  @Post('user/sync')
  async syncUser(@Body() dto: SyncUserDto) {
    return this.authService.syncUser(dto);
  }

  @Get('admin/check')
  async checkAdmin(@Query('loginId') loginId: string) {
    return this.authService.checkAdmin(loginId);
  }

  @Get('guest/check')
  async checkGuest(@Query('loginId') loginId: string) {
    return this.authService.checkGuest(loginId);
  }
}
