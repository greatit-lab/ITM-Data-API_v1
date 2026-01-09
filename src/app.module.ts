// ITM-Data-API/src/app.module.ts
import { Module } from '@nestjs/common';
import { PrismaService } from './prisma.service';

// 1. 기존 데이터 API 모듈
import { WaferModule } from './wafer/wafer.module';
import { PreAlignModule } from './prealign/prealign.module'; // [수정] PrealignModule -> PreAlignModule
import { PerformanceModule } from './performance/performance.module';
import { LampLifeModule } from './lamplife/lamplife.module';
import { ErrorModule } from './error/error.module';

// 2. 인증 및 공통 모듈
import { AuthModule } from './auth/auth.module';
import { MenuModule } from './menu/menu.module';     
import { FiltersModule } from './filters/filters.module'; 

// 3. 비즈니스 로직 이관 모듈
import { DashboardModule } from './dashboard/dashboard.module';
import { HealthModule } from './health/health.module';
import { InfraModule } from './infra/infra.module';
import { AdminModule } from './admin/admin.module';
import { EquipmentModule } from './equipment/equipment.module'; 

@Module({
  imports: [
    // Data Modules
    WaferModule,
    PreAlignModule, // [수정] 클래스명 일치시킴
    PerformanceModule,
    LampLifeModule,
    ErrorModule,

    // Core Modules
    AuthModule,
    MenuModule,
    FiltersModule,

    // Ported Modules
    DashboardModule,
    HealthModule,
    InfraModule,
    AdminModule,
    EquipmentModule, 
  ],
  controllers: [],
  providers: [PrismaService],
})
export class AppModule {}
