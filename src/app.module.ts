// ITM-Data-API/src/app.module.ts
import { Module, NestModule, MiddlewareConsumer, Logger } from '@nestjs/common';
import { PrismaService } from './prisma.service';
import { ConfigModule } from '@nestjs/config'; // ConfigModule 추가 권장

// 1. 기존 데이터 API 모듈
import { WaferModule } from './wafer/wafer.module';
import { PreAlignModule } from './prealign/prealign.module';
import { PerformanceModule } from './performance/performance.module';
import { LampLifeModule } from './lamplife/lamplife.module';
import { ErrorModule } from './error/error.module';

// 2. 인증 및 공통 모듈
import { AuthModule } from './auth/auth.module';
import { MenuModule } from './menu/menu.module';
import { FiltersModule } from './filters/filters.module';

// [New] 게시판 및 알림 모듈
import { BoardModule } from './board/board.module';
import { AlertModule } from './alert/alert.module'; // [확인] 포함됨

// 3. 비즈니스 로직 이관 모듈
import { DashboardModule } from './dashboard/dashboard.module';
import { HealthModule } from './health/health.module';
import { InfraModule } from './infra/infra.module';
import { AdminModule } from './admin/admin.module';
import { EquipmentModule } from './equipment/equipment.module';
import { ManualModule } from './manual/manual.module';

@Module({
  imports: [
    // ConfigModule 설정 (필요 시)
    ConfigModule.forRoot({ isGlobal: true }),

    // 1. 데이터 모듈
    WaferModule,
    PreAlignModule,
    PerformanceModule,
    LampLifeModule,
    ErrorModule,

    // 2. 인증/공통 모듈
    AuthModule,
    MenuModule,
    FiltersModule,

    // [New] 게시판 및 알림 모듈 등록
    BoardModule,
    AlertModule,

    // 3. 비즈니스 모듈
    DashboardModule,
    HealthModule,
    InfraModule,
    AdminModule,
    EquipmentModule,
    ManualModule,
  ],
  controllers: [],
  providers: [PrismaService],
})
export class AppModule implements NestModule {
  private readonly logger = new Logger('HTTP');

  configure(consumer: MiddlewareConsumer) {
    consumer
      .apply((req: any, res: any, next: any) => {
        const { method, originalUrl } = req;
        const start = Date.now();

        this.logger.log(`📥 Incoming Request: ${method} ${originalUrl}`);

        res.on('finish', () => {
          const { statusCode } = res;
          const duration = Date.now() - start;
          this.logger.log(
            `📤 Response: ${method} ${originalUrl} ${statusCode} - ${duration}ms`,
          );
        });

        next();
      })
      .forRoutes('*');
  }
}
