// ITM-Data-API/src/menu/menu.controller.ts
import { Controller, Get, Post, Put, Delete, Body, UseGuards, Param, Request } from '@nestjs/common';
import { MenuService } from './menu.service';
import { JwtAuthGuard } from '../auth/jwt-auth.guard'; // Auth 모듈의 Guard Import

// JWT Payload에 포함된 User 정보 인터페이스 (Auth 모듈에 정의된 것과 일치해야 함)
interface User {
  userId: string;
  username: string;
  role: string;
  // 필요한 경우 site, sdwt 등 추가
}

interface RequestWithUser extends Request {
  user: User;
}

// DTO 클래스 정의
export class CreateMenuDto {
  label: string;
  routerPath?: string;
  parentId?: number;
  icon?: string;
  sortOrder?: number;
  statusTag?: string;
  isVisible?: boolean;
  roles?: string[];
}

export class UpdateMenuDto {
  label?: string;
  routerPath?: string;
  parentId?: number;
  icon?: string;
  sortOrder?: number;
  statusTag?: string;
  isVisible?: boolean;
  roles?: string[];
}

@Controller('menu')
@UseGuards(JwtAuthGuard) // 모든 API에 JWT 인증 적용
export class MenuController {
  constructor(private readonly menuService: MenuService) {}

  // 1. 내 메뉴 조회 (사이드바용: 로그인한 사용자의 Role 기반 필터링)
  @Get('my')
  async getMyMenus(@Request() req: RequestWithUser) {
    // req.user가 없으면 기본값 'USER' 사용 (안전 장치)
    const role = req.user?.role ?? 'USER';
    return this.menuService.getMyMenus(role);
  }

  // 2. 전체 메뉴 트리 조회 (관리자 화면용: 모든 메뉴 및 권한 정보 포함)
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

  // 7. 특정 Role의 권한 일괄 저장
  @Post('permissions/:role')
  async savePermissions(
    @Param('role') role: string,
    @Body('menuIds') menuIds: number[],
  ) {
    return this.menuService.updateRolePermissions(role, menuIds);
  }
}
