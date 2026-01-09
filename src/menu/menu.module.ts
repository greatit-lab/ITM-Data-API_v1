// ITM-Data-API/src/menu/menu.module.ts
import { Module } from '@nestjs/common';
import { MenuController } from './menu.controller';
import { MenuService } from './menu.service';
import { PrismaService } from '../prisma.service';

@Module({
  imports: [], // AuthModule 등 필요한 경우 추가
  controllers: [MenuController],
  providers: [
    MenuService, 
    PrismaService // PrismaService 공급
  ],
  exports: [MenuService], // 다른 모듈에서 MenuService를 사용할 수 있도록 Export
})
export class MenuModule {}
