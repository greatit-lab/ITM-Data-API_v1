// ITM-Data-API/src/manual/manual.service.ts
import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma.service';

@Injectable()
export class ManualService {
  private readonly logger = new Logger(ManualService.name);

  constructor(private prisma: PrismaService) {}

  // [GET] 전체 매뉴얼 목록 조회 (정렬 순서대로)
  async findAll() {
    return this.prisma.sysManual.findMany({
      orderBy: { sortOrder: 'asc' },
    });
  }

  // [PUT] 매뉴얼 데이터 일괄 저장 (개선된 로직)
  async saveAll(sections: any[]) {
    this.logger.log(`Saving ${sections.length} manual sections...`);

    // 트랜잭션: 도중에 에러 발생 시 전체 롤백
    return this.prisma.$transaction(async (tx) => {
      try {
        // 1. 현재 존재하는 모든 ID 목록 조회
        const existingIds = (await tx.sysManual.findMany({ select: { id: true } })).map(m => m.id);
        
        // 2. 요청된 데이터의 ID 목록
        const newIds = sections.map(s => s.id);

        // 3. 삭제 대상: 기존에는 있지만 요청에는 없는 ID
        const toDelete = existingIds.filter(id => !newIds.includes(id));
        
        if (toDelete.length > 0) {
          await tx.sysManual.deleteMany({
            where: { id: { in: toDelete } }
          });
          this.logger.debug(`Deleted ${toDelete.length} old sections.`);
        }

        // 4. Upsert (생성 또는 수정)
        // createMany는 PostgreSQL에서 중복 충돌 시 에러가 나므로, 
        // 안전하게 하나씩 upsert 하거나, 기존 데이터를 보존하며 업데이트합니다.
        for (const [index, section] of sections.entries()) {
          await tx.sysManual.upsert({
            where: { id: section.id },
            update: {
              title: section.title,
              subtitle: section.subtitle,
              icon: section.icon,
              content: section.content,
              imageUrl: section.imageUrl,
              sortOrder: index, // 배열 인덱스를 정렬 순서로 사용
            },
            create: {
              id: section.id,
              title: section.title,
              subtitle: section.subtitle,
              icon: section.icon,
              content: section.content,
              imageUrl: section.imageUrl,
              sortOrder: index,
            },
          });
        }
        
        this.logger.log('Manual save completed successfully.');
        // 저장 후 최신 목록 반환
        return await tx.sysManual.findMany({ orderBy: { sortOrder: 'asc' } });

      } catch (e) {
        this.logger.error('Failed to save manuals inside transaction', e);
        throw e; // 트랜잭션 롤백 유도
      }
    });
  }
}
