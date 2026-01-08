// ITM-Data-API/src/error/error.module.ts
import { Module } from '@nestjs/common';
import { ErrorController } from './error.controller';
import { ErrorService } from './error.service';
import { PrismaService } from '../prisma.service';

@Module({
  controllers: [ErrorController],
  providers: [ErrorService, PrismaService],
})
export class ErrorModule {}
