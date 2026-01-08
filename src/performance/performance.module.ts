// ITM-Data-API/src/performance/performance.module.ts
import { Module } from '@nestjs/common';
import { PerformanceController } from './performance.controller';
import { PerformanceService } from './performance.service';
import { PrismaService } from '../prisma.service';

@Module({
  controllers: [PerformanceController],
  providers: [PerformanceService, PrismaService],
})
export class PerformanceModule {}
