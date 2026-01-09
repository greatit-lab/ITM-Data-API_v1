// ITM-Data-API/src/filters/filters.service.ts
import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma.service';

@Injectable()
export class FiltersService {
  constructor(private prisma: PrismaService) {}

  // 1. Site 목록 조회 (RefSdwt 테이블 기준)
  async getSites() {
    // DB에서 사용 중인(isUse='Y') Site 목록을 중복 제거하여 조회
    const results = await this.prisma.refSdwt.findMany({
      select: { site: true },
      where: { 
        site: { not: null },
        isUse: 'Y' // 사용 여부 체크
      },
      distinct: ['site'], // DISTINCT site
      orderBy: { site: 'asc' },
    });

    // 객체 배열 [{site: 'A'}, {site: 'B'}] -> 문자열 배열 ['A', 'B']로 변환
    return results.map((r) => r.site).filter((site) => site !== null);
  }

  // 2. SDWT 목록 조회 (RefSdwt 테이블 기준)
  async getSdwts(site?: string) {
    const where: any = { 
      isUse: 'Y',
      sdwt: { not: null }
    };
    
    // Site가 선택된 경우 해당 Site에 속한 SDWT만 조회
    if (site) {
      where.site = site;
    }

    const results = await this.prisma.refSdwt.findMany({
      select: { sdwt: true },
      where: where,
      distinct: ['sdwt'], // DISTINCT sdwt
      orderBy: { sdwt: 'asc' },
    });

    return results.map((r) => r.sdwt).filter((sdwt) => sdwt !== null);
  }
}
