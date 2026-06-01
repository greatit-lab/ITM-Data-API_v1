// ITM-Data-API/src/wafer/wafer.module.ts
import { Module } from '@nestjs/common';
import { WaferController } from './wafer.controller';
import { WaferService } from './wafer.service';
import { PrismaService } from '../prisma.service';
import { ArchivePrismaService } from '../archive-prisma.service'; // [추가됨] Archive DB 연결 서비스

@Module({
  controllers: [WaferController],
  providers: [WaferService, PrismaService, ArchivePrismaService], // [추가됨] 의존성 주입
})
export class WaferModule {}
