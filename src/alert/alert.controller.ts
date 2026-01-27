// ITM-DATA-API/src/alert/alert.controller.ts
import { Controller, Get, Post, Param, Query, ParseIntPipe } from '@nestjs/common';
import { AlertService } from './alert.service';

@Controller('alert')
// [수정] @UseGuards(JwtAuthGuard) 제거 -> 인증 없이 접근 허용 (내부망 통신)
export class AlertController {
  constructor(private readonly alertService: AlertService) {}

  // 1. 내 알림 조회
  // GET /alert?userId=gily.choi
  @Get()
  async getMyAlerts(@Query('userId') userId: string) {
    if (!userId) return []; // userId 없으면 빈 배열 반환
    return this.alertService.getMyAlerts(userId);
  }

  // 2. 안 읽은 개수 조회 (Polling용)
  // GET /alert/unread-count?userId=gily.choi
  @Get('unread-count')
  async getUnreadCount(@Query('userId') userId: string) {
    if (!userId) return 0;
    return this.alertService.getUnreadCount(userId);
  }

  // 3. 읽음 처리
  // POST /alert/:id/read
  @Post(':id/read')
  async readAlert(@Param('id', ParseIntPipe) id: number) {
    return this.alertService.readAlert(id);
  }
}
