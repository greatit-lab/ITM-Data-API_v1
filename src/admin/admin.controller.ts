// ITM-Data-API/src/admin/admin.controller.ts
import { Controller, Get, Post, Delete, Body, Param, Put } from '@nestjs/common';
import { AdminService } from './admin.service';
import { Prisma } from '@prisma/client';

@Controller('admin')
export class AdminController {
  constructor(private readonly adminService: AdminService) {}

  // 1. 관리자 사용자 관리
  @Get('users')
  async getAdminUsers() {
    return this.adminService.getAdminUsers();
  }

  @Post('users')
  async addAdminUser(@Body() body: Prisma.CfgAdminUserCreateInput) {
    return this.adminService.addAdminUser(body);
  }

  @Delete('users/:loginId')
  async deleteAdminUser(@Param('loginId') loginId: string) {
    return this.adminService.deleteAdminUser(loginId);
  }

  // 2. 게스트 권한 목록
  @Get('guest/access')
  async getGuestAccessList() {
    return this.adminService.getGuestAccessList();
  }

  @Post('guest/access')
  async grantGuestAccess(@Body() body: Prisma.CfgGuestAccessCreateInput) {
    return this.adminService.grantGuestAccess(body);
  }

  @Delete('guest/access/:loginId')
  async revokeGuestAccess(@Param('loginId') loginId: string) {
    return this.adminService.revokeGuestAccess(loginId);
  }

  // 3. 게스트 요청 승인/반려
  @Get('guest/request')
  async getGuestRequests() {
    return this.adminService.getGuestRequests();
  }

  @Put('guest/request/:reqId/approve')
  async approveGuestRequest(
    @Param('reqId') reqId: string,
    @Body('approverId') approverId: string,
  ) {
    return this.adminService.approveGuestRequest(Number(reqId), approverId);
  }

  @Put('guest/request/:reqId/reject')
  async rejectGuestRequest(
    @Param('reqId') reqId: string,
    @Body('rejectorId') rejectorId: string,
  ) {
    return this.adminService.rejectGuestRequest(Number(reqId), rejectorId);
  }
}
