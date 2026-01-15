// ITM-Data-API/src/menu/menu.service.ts
import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma.service';
import { RefMenu, Prisma } from '@prisma/client';

export interface MenuNode {
  menuId: number;
  label: string;
  routerPath: string | null;
  icon: string | null;
  parentId: number | null;
  sortOrder: number | null;
  children: MenuNode[];
  statusTag?: string | null;
  isVisible?: boolean;
  roles?: string[];
}

export class CreateMenuDto {
  label: string;
  routerPath?: string;
  parentId?: number | null;
  icon?: string;
  sortOrder?: number;
  statusTag?: string;
  isVisible?: boolean;
  roles?: string[];
}

export class UpdateMenuDto {
  label?: string;
  routerPath?: string;
  parentId?: number | null;
  icon?: string;
  sortOrder?: number;
  statusTag?: string;
  isVisible?: boolean;
  roles?: string[];
}

@Injectable()
export class MenuService {
  private readonly logger = new Logger(MenuService.name);

  constructor(private prisma: PrismaService) {}

  // [핵심] 사용자용 메뉴 트리 조회
  async getMyMenus(role: string): Promise<MenuNode[]> {
    try {
      const safeRole = role ? role.toUpperCase() : 'USER';
      
      // [디버깅 로그] 4단계: 서비스 로직 진입
      this.logger.warn(`[DEBUG-DATA-4] MenuService.getMyMenus() processing...`);
      this.logger.warn(`[DEBUG-DATA-4] Raw Role: "${role}" -> Normalized: "${safeRole}"`);

      // 1. 활성화된 전체 메뉴 조회
      const allMenus = await this.prisma.refMenu.findMany({
        where: { isVisible: 'Y' },
        orderBy: { sortOrder: 'asc' },
      });
      
      this.logger.warn(`[DEBUG-DATA-4] DB Total Active Menus: ${allMenus.length}`);
      
      if (allMenus.length === 0) {
        this.logger.error('[DEBUG-DATA-4] ERROR: No active menus found in DB (ref_menu table is empty or all hidden)');
        return [];
      }

      // 2. 관리자(ADMIN) 권한 확인 (슈퍼패스)
      if (process.env.ENABLE_DEMO_MODE === 'true' || safeRole === 'ADMIN') {
        this.logger.warn('[DEBUG-DATA-4] !!! ADMIN ACCESS GRANTED !!! Returning Full Tree.');
        return this.buildMenuTree(allMenus);
      }

      // 3. 일반 사용자: 권한 테이블 조회
      const rolesToCheck = [role, safeRole, role.toLowerCase()];
      const uniqueRoles = [...new Set(rolesToCheck)].filter(r => r); 
      
      this.logger.warn(`[DEBUG-DATA-4] Checking DB permissions for roles: [${uniqueRoles.join(', ')}]`);

      const accessible = await this.prisma.cfgMenuRole.findMany({
        where: { role: { in: uniqueRoles } },
        select: { menuId: true, role: true },
      });
      
      this.logger.warn(`[DEBUG-DATA-4] Found ${accessible.length} permission entries in cfg_menu_role`);

      if (accessible.length === 0) {
        this.logger.warn(`[DEBUG-DATA-4] Warning: No menu permissions found for this user.`);
        return [];
      }

      const allowedIds = new Set(accessible.map((a) => a.menuId));
      const validMenus = this.filterMenusRecursive(allMenus, allowedIds);

      this.logger.warn(`[DEBUG-DATA-4] Final Filtered Menus Count: ${validMenus.length}`);

      return this.buildMenuTree(validMenus);

    } catch (error) {
      this.logger.error('[DEBUG-DATA-ERROR] Failed to get user menus', error);
      return [];
    }
  }

  // [관리자용] 전체 메뉴 및 권한 매핑 조회
  async getAllMenus(): Promise<MenuNode[]> {
    const menus = await this.prisma.refMenu.findMany({
      orderBy: { sortOrder: 'asc' },
    });
    const roleMappings = await this.prisma.cfgMenuRole.findMany();
    
    const roleMap = new Map<number, string[]>();
    roleMappings.forEach(mapping => {
      if (!roleMap.has(mapping.menuId)) roleMap.set(mapping.menuId, []);
      roleMap.get(mapping.menuId)?.push(mapping.role);
    });

    return this.buildMenuTree(menus, roleMap);
  }

  // --- CRUD Operations ---
  async createMenu(data: CreateMenuDto) {
    const { label, routerPath, parentId, icon, sortOrder, statusTag, roles, isVisible } = data;
    const newMenu = await this.prisma.refMenu.create({
      data: {
        label,
        routerPath: routerPath || null,
        parentId: parentId || null,
        icon: icon || null,
        sortOrder: sortOrder || 0,
        statusTag: statusTag || null,
        isVisible: isVisible === false ? 'N' : 'Y',
      },
    });
    if (roles && roles.length > 0) {
      await this.prisma.cfgMenuRole.createMany({
        data: roles.map((role) => ({ menuId: newMenu.menuId, role })),
      });
    }
    return newMenu;
  }

  async updateMenu(id: number, data: UpdateMenuDto) {
    const { label, routerPath, parentId, icon, sortOrder, statusTag, roles, isVisible } = data;
    const updateData: Prisma.RefMenuUpdateInput = {
      ...(label !== undefined && { label }),
      ...(routerPath !== undefined && { routerPath: routerPath || null }),
      ...(parentId !== undefined && { parentId }),
      ...(icon !== undefined && { icon: icon || null }),
      ...(sortOrder !== undefined && { sortOrder }),
      ...(statusTag !== undefined && { statusTag: statusTag || null }),
      ...(isVisible !== undefined && { isVisible: isVisible ? 'Y' : 'N' }),
    };
    const updatedMenu = await this.prisma.refMenu.update({
      where: { menuId: id },
      data: updateData,
    });
    if (roles && Array.isArray(roles)) {
      await this.prisma.$transaction(async (tx) => {
        await tx.cfgMenuRole.deleteMany({ where: { menuId: id } });
        if (roles.length > 0) {
          await tx.cfgMenuRole.createMany({
            data: roles.map((role) => ({ menuId: id, role })),
          });
        }
      });
    }
    return updatedMenu;
  }

  async deleteMenu(id: number) {
    await this.prisma.cfgMenuRole.deleteMany({ where: { menuId: id } });
    return this.prisma.refMenu.delete({ where: { menuId: id } });
  }

  async updateRolePermissions(role: string, menuIds: number[]): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      await tx.cfgMenuRole.deleteMany({ where: { role } });
      if (menuIds.length > 0) {
        await tx.cfgMenuRole.createMany({
          data: menuIds.map((menuId) => ({ role, menuId })),
        });
      }
    });
  }

  async getAllRolePermissions() {
    return this.prisma.cfgMenuRole.findMany();
  }

  // --- Helper Methods ---
  private filterMenusRecursive(allMenus: RefMenu[], allowedIds: Set<number>): RefMenu[] {
    const menuMap = new Map<number, RefMenu>(allMenus.map(m => [m.menuId, m]));
    const resultIds = new Set<number>();
    allowedIds.forEach(id => resultIds.add(id));
    allowedIds.forEach(id => {
      let current = menuMap.get(id);
      while (current && current.parentId) {
        const parent = menuMap.get(current.parentId);
        if (parent) {
          resultIds.add(parent.menuId);
          current = parent;
        } else {
          break;
        }
      }
    });
    return allMenus.filter(m => resultIds.has(m.menuId));
  }

  private buildMenuTree(menus: RefMenu[], roleMap?: Map<number, string[]>): MenuNode[] {
    const map = new Map<number, MenuNode>();
    const roots: MenuNode[] = [];
    menus.forEach((menu) => {
      map.set(menu.menuId, {
        menuId: menu.menuId,
        label: menu.label,
        routerPath: menu.routerPath,
        icon: menu.icon,
        parentId: menu.parentId,
        sortOrder: menu.sortOrder,
        statusTag: menu.statusTag,
        isVisible: menu.isVisible === 'Y',
        children: [],
        roles: roleMap ? (roleMap.get(menu.menuId) || []) : undefined,
      });
    });
    menus.forEach((menu) => {
      if (menu.parentId && map.has(menu.parentId)) {
        const parent = map.get(menu.parentId);
        parent?.children.push(map.get(menu.menuId)!);
      } else {
        roots.push(map.get(menu.menuId)!);
      }
    });
    const sortNodes = (nodes: MenuNode[]) => {
      nodes.sort((a, b) => (a.sortOrder || 0) - (b.sortOrder || 0));
      nodes.forEach(node => {
        if (node.children.length > 0) sortNodes(node.children);
      });
    };
    sortNodes(roots);
    return roots;
  }
}
