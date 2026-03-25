// ITM-Data-API/src/filters/filters.service.ts
import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma.service';
import { Prisma } from '@prisma/client';

@Injectable()
export class FiltersService {
  constructor(private prisma: PrismaService) {}

  // 1. Site 목록 조회 (RefSdwt 테이블 기준, id 오름차순 정렬)
  async getSites() {
    // Prisma의 groupBy를 사용하여 site별로 가장 작은 id(최초 생성 순서)를 찾고 그 기준으로 정렬합니다.
    const results = await this.prisma.refSdwt.groupBy({
      by: ['site'],
      where: { 
        isUse: 'Y' 
      },
      _min: {
        id: true, // 그룹 내에서 가장 작은 id 값 찾기
      },
      orderBy: {
        _min: {
          id: 'asc', // 가장 작은 id를 기준으로 오름차순 정렬
        },
      },
    });

    return results.map((r) => r.site);
  }

  // 2. SDWT 목록 조회 (RefSdwt 테이블 기준, id 오름차순 정렬)
  async getSdwts(site?: string) {
    const where: Prisma.RefSdwtWhereInput = { 
      isUse: 'Y' 
    };
    
    if (site) {
      where.site = site;
    }

    // Prisma의 groupBy를 사용하여 sdwt별로 가장 작은 id를 찾고 그 기준으로 정렬합니다.
    const results = await this.prisma.refSdwt.groupBy({
      by: ['sdwt'],
      where: where,
      _min: {
        id: true, // 그룹 내에서 가장 작은 id 값 찾기
      },
      orderBy: {
        _min: {
          id: 'asc', // 가장 작은 id를 기준으로 오름차순 정렬
        },
      },
    });

    return results.map((r) => r.sdwt);
  }
}
