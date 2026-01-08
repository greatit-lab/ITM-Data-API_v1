// ITM-Data/src/prealign/prealign.module.ts
import { Module } from '@nestjs/common';
import { PreAlignController } from './prealign.controller';
import { PreAlignService } from './prealign.service';
import { PrismaService } from '../prisma.service';

@Module({
  controllers: [PreAlignController],
  providers: [PreAlignService, PrismaService],
})
export class PreAlignModule {}
