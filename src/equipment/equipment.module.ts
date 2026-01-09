// ITM-Data-API/src/equipment/equipment.module.ts
import { Module } from '@nestjs/common';
import { EquipmentController } from './equipment.controller';
import { EquipmentService } from './equipment.service';
import { PrismaService } from '../prisma.service';

@Module({
  controllers: [EquipmentController],
  providers: [EquipmentService, PrismaService],
  exports: [EquipmentService], // 다른 모듈에서 사용 가능하도록 export
})
export class EquipmentModule {}
