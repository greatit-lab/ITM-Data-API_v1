// ITM-Data-API/src/lamplife/lamplife.service.ts)
import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma.service';

@Injectable()
export class LampLifeService {
  constructor(private prisma: PrismaService) {}

  async getLampStatus(site: string, sdwt: string) {
    // 최신 램프 상태 조회
    // RefLampLife 테이블 가정
    return this.prisma.refLampLife.findMany({
      // where: { site, sdwt } // 필요 시 장비 테이블과 Join 조건 추가
      orderBy: { eqpid: 'asc' }
    });
  }
}
