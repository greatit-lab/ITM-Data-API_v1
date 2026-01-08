// ITM-Data-API/src/app.module.ts
import { Module } from '@nestjs/common';
import { PrismaService } from './prisma.service';
import { WaferModule } from './wafer/wafer.module'; // 기존
// [추가]
import { PreAlignModule } from './prealign/prealign.module';
import { PerformanceModule } from './performance/performance.module';
import { ErrorModule } from './error/error.module';
import { LampLifeModule } from './lamplife/lamplife.module';

@Module({
  imports: [
    WaferModule,
    PreAlignModule,
    PerformanceModule,
    ErrorModule,
    LampLifeModule, // 등록
  ],
  providers: [PrismaService],
})
export class AppModule {}
