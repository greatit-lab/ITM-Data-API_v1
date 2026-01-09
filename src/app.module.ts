// ITM-Data-API/src/app.module.ts
import { Module } from '@nestjs/common';
import { PrismaService } from './prisma.service';

// 1. 기존 데이터 API 모듈
import { WaferModule } from './wafer/wafer.module';
import { PrealignModule } from './prealign/prealign.module';
import { PerformanceModule } from './performance/performance.module';
import { LampLifeModule } from './lamplife/lamplife.module';
import { ErrorModule } from './error/error.module';

// 2. 인증 및 공통 모듈
import { AuthModule } from './auth/auth.module';
import { MenuModule } from './menu/menu.module';     // 메뉴 관리 (DB 연동)
import { FiltersModule } from './filters/filters.module'; // 필터 (Site/SDWT)

// 3. 비즈니스 로직 이관 모듈 (기존 5432 -> 8081)
import { DashboardModule } from './dashboard/dashboard.module';
import { HealthModule } from './health/health.module';
import { InfraModule } from './infra/infra.module';
import { AdminModule } from './admin/admin.module';
import { EquipmentModule } from './equipment/equipment.module'; // [중요] 장비 모듈 추가

@Module({
  imports: [
    // Data Modules
    WaferModule,
    PrealignModule,
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
    EquipmentModule, // AppModule에 등록
  ],
  controllers: [],
  providers: [PrismaService],
})
export class AppModule {}
