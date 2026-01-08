// ITM-Data-API/src/lamplife/lamplife.service.ts
import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma.service';

@Injectable()
export class LampLifeService {
  constructor(private prisma: PrismaService) {}

  async getLampStatus(site: string, sdwt: string) {
    return this.prisma.eqpLampLife.findMany({
      where: {
        // [수정] site, sdwt 변수를 사용하여 장비 필터링 적용
        equipment: {
          // sdwt 값이 있으면 필터링
          ...(sdwt && { sdwt: sdwt }),
          // site 값이 있으면 RefSdwt 관계를 통해 필터링
          ...(site && {
            sdwtRel: {
              site: site
            }
          })
        }
      },
      orderBy: { eqpid: 'asc' }
    });
  }
}
