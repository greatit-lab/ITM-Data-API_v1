// ITM-Data-API_v1/src/admin/admin.controller.ts
import { Controller, Get, Post, Put, Delete, Body, Param, Query } from '@nestjs/common';
import { AdminService } from './admin.service';

@Controller('admin')
export class AdminController {
  constructor(private readonly adminService: AdminService) {}

  @Get('users') async getAllUsers() { return this.adminService.getAllUsers(); }
  
  @Get('admins') async getAllAdmins() { return this.adminService.getAllAdmins(); }
  @Post('admins') async addAdmin(@Body() body: any) { return this.adminService.addAdmin(body); }
  @Delete('admins/:loginId') async deleteAdmin(@Param('loginId') loginId: string) { return this.adminService.deleteAdmin(loginId); }

  @Get('access-codes') async getAllAccessCodes() { return this.adminService.getAllAccessCodes(); }
  @Post('access-codes') async createAccessCode(@Body() body: any) { return this.adminService.createAccessCode(body); }
  @Put('access-codes/:deptid') async updateAccessCode(@Param('deptid') deptid: string, @Body() body: any) { return this.adminService.updateAccessCode(deptid, body); }
  @Delete('access-codes/:deptid') async deleteAccessCode(@Param('deptid') deptid: string) { return this.adminService.deleteAccessCode(deptid); }

  @Get('exceptions') async getExceptionUsers() { return this.adminService.getExceptionUsers(); }
  @Post('exceptions') async addExceptionUser(@Body() body: any) { return this.adminService.addExceptionUser(body); }
  @Put('exceptions/:loginId/status') async updateExceptionUserStatus(@Param('loginId') loginId: string, @Body() body: { isActive: string }) { return this.adminService.updateExceptionUserStatus(loginId, body.isActive); }
  @Delete('exceptions/:loginId') async deleteExceptionUser(@Param('loginId') loginId: string) { return this.adminService.deleteExceptionUser(loginId); }

  @Get('guests') async getAllGuests() { return this.adminService.getAllGuests(); }
  @Post('guests') async addGuest(@Body() body: any) { return this.adminService.addGuest(body); }
  @Delete('guests/:loginId') async deleteGuest(@Param('loginId') loginId: string) { return this.adminService.deleteGuest(loginId); }

  @Get('guest/request') async getGuestRequests() { return this.adminService.getGuestRequests(); }
  @Put('guest/request/:reqId/approve') async approveGuestRequest(@Param('reqId') reqId: string, @Body() body: { approverId: string }) { return this.adminService.approveGuestRequest(parseInt(reqId), body.approverId); }
  @Put('guest/request/:reqId/reject') async rejectGuestRequest(@Param('reqId') reqId: string, @Body() body: { rejectorId: string }) { return this.adminService.rejectGuestRequest(parseInt(reqId), body.rejectorId); }

  @Get('severity') async getSeverities() { return this.adminService.getSeverities(); }
  @Post('severity') async addSeverity(@Body() body: any) { return this.adminService.addSeverity(body); }
  @Put('severity/:errorId') async updateSeverity(@Param('errorId') errorId: string, @Body() body: any) { return this.adminService.updateSeverity(errorId, body); }
  @Delete('severity/:errorId') async deleteSeverity(@Param('errorId') errorId: string) { return this.adminService.deleteSeverity(errorId); }

  @Get('metrics') async getMetrics() { return this.adminService.getMetrics(); }
  @Post('metrics') async addMetric(@Body() body: any) { return this.adminService.addMetric(body); }
  @Put('metrics/:metricName') async updateMetric(@Param('metricName') metricName: string, @Body() body: any) { return this.adminService.updateMetric(metricName, body); }
  @Delete('metrics/:metricName') async deleteMetric(@Param('metricName') metricName: string) { return this.adminService.deleteMetric(metricName); }

  @Get('new-server') async getNewServerConfig() { return this.adminService.getNewServerConfig(); }
  @Put('new-server') async updateNewServerConfig(@Body() body: any) { return this.adminService.updateNewServerConfig(body); }

  @Get('servers') async getCfgServers() { return this.adminService.getCfgServers(); }
  @Put('servers/:eqpid') async updateCfgServer(@Param('eqpid') eqpid: string, @Body() body: any) { return this.adminService.updateCfgServer(eqpid, body); }

  @Post('access-log')
  async logAccess(@Body() body: { loginId: string; menuName: string; accessUrl: string }) {
    return this.adminService.logAccess(body);
  }

  @Get('usage-analytics')
  async getUsageAnalytics(@Query('startDate') startDate: string, @Query('endDate') endDate: string) {
    return this.adminService.getUsageAnalytics(startDate, endDate);
  }

  @Get('storage-usage')
  async getStorageUsage(@Query('startDate') startDate: string, @Query('endDate') endDate: string, @Query('interval') interval: string) {
    return this.adminService.getStorageUsage(startDate, endDate, interval);
  }

  // ==========================================
  // [신규 추가] 긴급 서비스 점검 모드 API
  // ==========================================
  @Get('maintenance')
  async getMaintenanceStatus() {
    return this.adminService.getMaintenanceStatus();
  }

  @Post('maintenance')
  async updateMaintenanceStatus(@Body() body: { status: boolean; expectedTime?: string }) {
    return this.adminService.updateMaintenanceStatus(body.status, body.expectedTime, 'admin');
  }

  // ==========================================
  // [기존 유지] 수동 스토리지 동기화 API 연결부
  // ==========================================
  @Post('storage-sync')
  async syncStorageNow() {
    return this.adminService.syncStorageNow();
  }

  // ==========================================
  // [기존 유지] 서버 모니터링 API 3종 세트
  // ==========================================

  // 1. 에이전트(리눅스 서버)가 데이터를 쏠 때 받는 곳 (POST)
  @Post('server-metrics')
  async recordMetric(@Body() body: { serverId: string; cpu: number; memory: number; disk: number }) {
    return this.adminService.recordServerMetric(body);
  }

  // 2. 프론트엔드 상단 실시간 카드에 데이터를 주는 곳 (GET)
  @Get('server-metrics')
  async getLatestMetrics() {
    return this.adminService.getLatestServerMetrics();
  }

  // 3. 프론트엔드 하단 30일 차트에 트렌드 데이터를 주는 곳 (GET)
  @Get('server-trend/:serverId')
  async getServerTrend(
    @Param('serverId') serverId: string,
    @Query('days') days?: number,
  ) {
    return this.adminService.getServerTrend(serverId, days ? Number(days) : 30);
  }
}
