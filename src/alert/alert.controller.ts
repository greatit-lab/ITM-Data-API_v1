// ITM-DATA-API/src/alert/alert.controller.ts
import { Controller, Get, Post, Body, Param, UseGuards, Request, ParseIntPipe } from '@nestjs/common';
import { AlertService } from './alert.service';
// JwtAuthGuard가 auth 모듈에 있다고 가정
import { JwtAuthGuard } from '../auth/jwt-auth.guard'; 

@Controller('alert')
@UseGuards(JwtAuthGuard)
export class AlertController {
  constructor(private readonly alertService: AlertService) {}

  // 내 알림 조회
  @Get()
  async getMyAlerts(@Request() req) {
    // req.user.userId는 JWT 전략에 따라 다를 수 있음 (username or userId 확인 필요)
    return this.alertService.getMyAlerts(req.user.username); 
  }

  // 안 읽은 개수 조회 (Polling용)
  @Get('unread-count')
  async getUnreadCount(@Request() req) {
    return this.alertService.getUnreadCount(req.user.username);
  }

  // 읽음 처리
  @Post(':id/read')
  async readAlert(@Param('id', ParseIntPipe) id: number) {
    return this.alertService.readAlert(id);
  }
}
