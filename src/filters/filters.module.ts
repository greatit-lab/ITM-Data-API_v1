// ITM-Data-API/src/filters/filters.module.ts
import { Module } from '@nestjs/common';
import { FiltersController } from './filters.controller';
import { FiltersService } from './filters.service';
import { PrismaService } from '../prisma.service';

@Module({
  controllers: [FiltersController],
  providers: [
    FiltersService, 
    PrismaService // [중요] DB 연결을 위해 필수
  ],
  exports: [FiltersService], // 다른 모듈에서 사용할 경우를 대비해 export
})
export class FiltersModule {}
