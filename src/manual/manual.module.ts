// ITM-Data-API/src/manual/manual.module.ts
import { Module } from '@nestjs/common';
import { ManualService } from './manual.service';
import { ManualController } from './manual.controller';
import { PrismaService } from '../prisma.service';

@Module({
  controllers: [ManualController],
  providers: [ManualService, PrismaService],
})
export class ManualModule {}
