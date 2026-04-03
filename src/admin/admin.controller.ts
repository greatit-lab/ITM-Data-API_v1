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

  // 🌟 [추가됨] 예외 접근 허용 관리 API 
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
}
