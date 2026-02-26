// ITM-Data-API/src/equipment/equipment.service.ts
import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma.service';
import { Prisma } from '@prisma/client';

@Injectable()
export class EquipmentService {
  constructor(private prisma: PrismaService) {}

  // 1. 인프라 관리용 목록 조회 (500 에러 해결 버전)
  async getInfraList() {
    // [변경 1] include: { sdwtRel: true }를 제거하여 Relation 충돌 방지
    const equipments = await this.prisma.refEquipment.findMany({
      orderBy: { eqpid: 'asc' },
    });

    // [변경 2] 코드 레벨에서 SDWT 정보 안전하게 매핑 (Manual Join)
    // 장비 데이터에 있는 sdwt 값들을 추출 (중복 제거)
    const sdwtIds = [...new Set(equipments.map((e) => e.sdwt).filter(Boolean))];

    // 존재하는 SDWT 정보만 조회
    const sdwts = await this.prisma.refSdwt.findMany({
      where: { sdwt: { in: sdwtIds } },
    });

    // 조회를 위한 Map 생성
    const sdwtMap = new Map(sdwts.map((s) => [s.sdwt, s]));

    // [변경 3] Frontend 호환성(eqpId) 및 SDWT 정보 결합하여 반환
    return equipments.map((item) => ({
      ...item,
      eqpId: item.eqpid, // Frontend는 CamelCase 'eqpId'를 기대함
      sdwtRel: sdwtMap.get(item.sdwt) || null, // 데이터가 없으면 null 처리 (에러 방지)
    }));
  }

  // 2. 장비 상세 조회 (Explorer 등)
  async getEquipmentDetails(params: {
    site?: string;
    sdwt?: string;
    eqpId?: string;
  }) {
    const { site, sdwt, eqpId } = params;

    const where: Prisma.RefEquipmentWhereInput = {};

    if (eqpId) {
      where.eqpid = { contains: eqpId, mode: 'insensitive' };
    }

    if (sdwt || site) {
      where.sdwtRel = {};
      if (sdwt) where.sdwtRel.sdwt = sdwt;
      if (site) where.sdwtRel.site = site;
    }

    where.agentInfo = {
      isNot: null,
    };

    // 상세 조회는 필터링 조건이 많아 include 유지하되, try-catch로 보호 가능성 열어둠
    // (단, 이곳은 AgentInfo가 있는 장비만 조회하므로 데이터 정합성이 높을 것으로 예상)
    const results = await this.prisma.refEquipment.findMany({
      where,
      include: {
        agentInfo: true,
        agentStatus: true,
        sdwtRel: true,
        itmInfo: true,
      },
      orderBy: { eqpid: 'asc' },
    });

    return results.map((eqp) => {
      const info: any = eqp.agentInfo || {};
      const status: any = eqp.agentStatus || {};
      const itm: any = eqp.itmInfo || {};

      // [수정된 부분] AgentStatus의 status 컬럼 값을 직접 참조하여 Online 여부 판단
      // 기존 시간 차이 기반 계산법을 제거하고 DB 값 기준으로 변경
      let isOnline = false;
      if (status.status && status.status.toUpperCase() === 'ONLINE') {
        isOnline = true;
      }

      return {
        eqpId: eqp.eqpid, // 매핑
        pcName: info.pcName || '-',
        isOnline: isOnline,
        ipAddress: info.ipAddress || '-',
        lastContact: status.lastPerfUpdate
          ? new Date(status.lastPerfUpdate).toISOString()
          : null,
        os: info.os || '-',
        systemType: info.systemType || '-',
        timezone: info.timezone || '-',
        macAddress: info.macAddress || '-',
        cpu: info.cpu || '-',
        memory: info.memory || '-',
        disk: info.disk || '-',
        vga: info.vga || '-',
        type: info.type || '-',
        locale: info.locale || '-',
        systemModel: itm.systemModel || '-',
        serialNum: itm.serialNum || '-',
        application: itm.application || '-',
        version: itm.version || '-',
        dbVersion: itm.dbVersion || '-',
      };
    });
  }

  // 3. 장비 ID 목록 조회 (Dropdown 용)
  async getEqpIds(params: { site?: string; sdwt?: string; type?: string }) {
    const { site, sdwt, type } = params;
    const where: Prisma.RefEquipmentWhereInput = {};

    if (sdwt) {
      where.sdwt = sdwt;
    } else if (site) {
      where.sdwtRel = { site };
    }

    if (
      type === 'wafer' ||
      type === 'agent' ||
      type === 'performance' ||
      type === 'error'
    ) {
      where.agentInfo = {
        isNot: null,
      };
    }

    const results = await this.prisma.refEquipment.findMany({
      where,
      select: { eqpid: true },
      orderBy: { eqpid: 'asc' },
    });

    return results.map((r) => r.eqpid);
  }

  // 4. 단일 장비 조회
  async getEquipment(eqpId: string) {
    const eqp = await this.prisma.refEquipment.findUnique({
      where: { eqpid: eqpId },
      // 단일 조회 시에도 include가 실패할 수 있으므로, 필요시 getInfraList처럼 분리 가능
      // 현재는 유지
      include: { sdwtRel: true },
    });

    if (!eqp) throw new NotFoundException(`Equipment ${eqpId} not found`);
    return { ...eqp, eqpId: eqp.eqpid };
  }

  // 5. 장비 추가
  async createEquipment(data: Prisma.RefEquipmentCreateInput) {
    return this.prisma.refEquipment.create({ data });
  }

  // 6. 장비 수정
  async updateEquipment(eqpId: string, data: Prisma.RefEquipmentUpdateInput) {
    return this.prisma.refEquipment.update({
      where: { eqpid: eqpId },
      data,
    });
  }

  // 7. 장비 삭제
  async deleteEquipment(eqpId: string) {
    return this.prisma.refEquipment.delete({
      where: { eqpid: eqpId },
    });
  }
}
