// ITM-Data-API/src/menu/menu.controller.ts
import { Controller, Get, Post, Put, Delete, Body, UseGuards, Param, Request, Logger, Query } from '@nestjs/common';
import { MenuService, CreateMenuDto, UpdateMenuDto } from './menu.service'; // DTO Import
import { JwtAuthGuard } from '../auth/jwt-auth.guard';

@Controller('menu')
export class MenuController {
  private readonly logger = new Logger(MenuController.name);

  constructor(private readonly menuService: MenuService) {}

  // 1. 내 메뉴 조회
  @Get('my')
  async getMyMenus(
    @Request() req: any, 
    @Query('role') queryRole?: string // 쿼리 파라미터로 role 수신
  ) {
    const tokenRole = req.user?.role;
    // 결정된 Role: 쿼리 파라미터 우선 -> 토큰 -> 기본값
    const finalRole = queryRole || tokenRole || 'USER';

    // [디버깅 로그] 3단계: Data API 컨트롤러 진입 확인
    this.logger.warn(`[DEBUG-DATA-3] MenuController.getMyMenus() Called`);
    this.logger.warn(`[DEBUG-DATA-3] QueryRole: "${queryRole}"`);
    this.logger.warn(`[DEBUG-DATA-3] TokenRole: "${tokenRole}"`);
    this.logger.warn(`[DEBUG-DATA-3] -> Decided FinalRole: "${finalRole}"`);

    return this.menuService.getMyMenus(finalRole);
  }

  // 2. 전체 메뉴 트리 조회
  @Get('all')
  async getAllMenus() {
    return this.menuService.getAllMenus();
  }

  // 3. 메뉴 생성
  @Post()
  async createMenu(@Body() createMenuDto: CreateMenuDto) {
    return this.menuService.createMenu(createMenuDto);
  }

  // 4. 메뉴 수정
  @Put(':id')
  async updateMenu(@Param('id') id: string, @Body() updateMenuDto: UpdateMenuDto) {
    return this.menuService.updateMenu(Number(id), updateMenuDto);
  }

  // 5. 메뉴 삭제
  @Delete(':id')
  async deleteMenu(@Param('id') id: string) {
    return this.menuService.deleteMenu(Number(id));
  }

  // 6. 권한 목록 조회
  @Get('permissions')
  async getPermissions() {
    return this.menuService.getAllRolePermissions();
  }

  // 7. 특정 Role 권한 저장
  @Post('permissions/:role')
  async savePermissions(
    @Param('role') role: string,
    @Body('menuIds') menuIds: number[],
  ) {
    return this.menuService.updateRolePermissions(role, menuIds);
  }
}
