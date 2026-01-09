// ITM-Data-API/src/equipment/equipment.service.ts
import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma.service';
import { Prisma } from '@prisma/client';

@Injectable()
export class EquipmentService {
  constructor(private prisma: PrismaService) {}

  // 1. 인프라 관리용 목록 조회 (단순 목록)
  async getInfraList() {
    return this.prisma.refEquipment.findMany({
      orderBy: { eqpid: 'asc' },
    });
  }

  // 2. 장비 상세 조회 (Explorer용 - AgentInfo, Status 포함)
  async getEquipmentDetails(params: { site?: string; sdwt?: string; eqpId?: string }) {
    const { site, sdwt, eqpId } = params;
    const where: Prisma.RefEquipmentWhereInput = {};

    // SDWT 필터 (직접 컬럼)
    if (sdwt) {
      where.sdwt = sdwt;
    }

    // Site 필터 (RefSdwt 관계 테이블 조회)
    if (site) {
      where.sdwtRel = {
        site: site,
        isUse: 'Y', // 사용 중인 SDWT만
      };
    }

    // 특정 장비 ID 필터
    if (eqpId) {
      where.eqpid = eqpId;
    }

    return this.prisma.refEquipment.findMany({
      where,
      include: {
        agentInfo: true,   // 에이전트 상세 정보 포함
        agentStatus: true, // 에이전트 상태 정보 포함
      },
      orderBy: { eqpid: 'asc' },
    });
  }

  // 3. 장비 ID 목록 조회 (필터링 적용)
  async getEqpIds(params: { site?: string; sdwt?: string; type?: string }) {
    const { site, sdwt } = params;
    const where: Prisma.RefEquipmentWhereInput = {};

    if (sdwt) where.sdwt = sdwt;
    if (site) {
      where.sdwtRel = {
        site: site,
        isUse: 'Y',
      };
    }
    // type 필터가 필요하다면 로직 추가 (예: where.eqpType = type)

    const results = await this.prisma.refEquipment.findMany({
      select: { eqpid: true },
      where,
      orderBy: { eqpid: 'asc' },
    });

    return results.map((r) => r.eqpid);
  }

  // 4. 단일 장비 조회
  async getEquipment(eqpId: string) {
    return this.prisma.refEquipment.findUnique({
      where: { eqpid: eqpId },
      include: {
        sdwtRel: true, // 소속 SDWT 정보 포함
      },
    });
  }

  // 5. 장비 추가
  async createEquipment(data: Prisma.RefEquipmentCreateInput) {
    return this.prisma.refEquipment.create({
      data: {
        ...data,
        lastUpdate: new Date(),
      },
    });
  }

  // 6. 장비 수정
  async updateEquipment(eqpId: string, data: Prisma.RefEquipmentUpdateInput) {
    return this.prisma.refEquipment.update({
      where: { eqpid: eqpId },
      data: {
        ...data,
        lastUpdate: new Date(),
      },
    });
  }

  // 7. 장비 삭제
  async deleteEquipment(eqpId: string) {
    // 연관 데이터 삭제 정책에 따라 먼저 자식 테이블을 지워야 할 수도 있음 (Cascade 설정 확인 필요)
    // 여기서는 장비만 삭제 시도
    return this.prisma.refEquipment.delete({
      where: { eqpid: eqpId },
    });
  }
}
