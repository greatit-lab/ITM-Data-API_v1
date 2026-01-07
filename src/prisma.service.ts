// ITM-DATA-API/src/prisma.service.ts
import {
  Injectable,
  OnModuleInit,
  OnApplicationShutdown,
} from '@nestjs/common';
import { PrismaClient } from '@prisma/client';

@Injectable()
export class PrismaService
  extends PrismaClient
  implements OnModuleInit, OnApplicationShutdown
{
  async onModuleInit() {
    await this.$connect();
  }

  // [수정] 사용하지 않는 매개변수(_signal)를 완전히 삭제했습니다.
  async onApplicationShutdown() {
    await this.$disconnect();
  }
}
