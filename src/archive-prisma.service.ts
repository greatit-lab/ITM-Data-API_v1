// ITM-DATA-API/src/archive-prisma.service.ts
import {
  Injectable,
  OnModuleInit,
  OnApplicationShutdown,
} from '@nestjs/common';
import { PrismaClient } from '@prisma/client';

@Injectable()
export class ArchivePrismaService
  extends PrismaClient
  implements OnModuleInit, OnApplicationShutdown
{
  constructor() {
    // 런타임에 datasources url을 오버라이딩하여 Archive DB로 연결을 우회합니다.
    super({
      datasources: {
        db: {
          url: process.env.ARCHIVE_DATABASE_URL,
        },
      },
    });
  }

  async onModuleInit() {
    await this.$connect();
  }

  async onApplicationShutdown() {
    await this.$disconnect();
  }
}
