// ITM-Data-API/src/equipment/equipment.service.ts
import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma.service';
import { Prisma } from '@prisma/client';

@Injectable()
export class EquipmentService {
  constructor(private prisma: PrismaService) {}

  // 1. 인프라 관리용 목록 조회
  async getInfraList() {
    return this.prisma.refEquipment.findMany({
      include: {
        sdwtRel: true, // SDWT 정보 포함
      },
      orderBy: { eqpid: 'asc' },
    });
  }

  // 2. 장비 상세 조회 (Explorer 등)
  async getEquipmentDetails(params: {
    site?: string;
    sdwt?: string;
    eqpId?: string;
  }) {
    const { site, sdwt, eqpId } = params;

    // 동적 필터 조건 생성
    const where: Prisma.RefEquipmentWhereInput = {};

    if (eqpId) {
      where.eqpid = { contains: eqpId, mode: 'insensitive' };
    }

    if (sdwt || site) {
      where.sdwtRel = {};
      if (sdwt) where.sdwtRel.sdwt = sdwt;
      if (site) where.sdwtRel.site = site;
    }

    // Explorer에서는 ITM Agent가 설치된 장비만 조회 (AgentInfo 존재 여부)
    where.agentInfo = {
      isNot: null,
    };

    // AgentInfo가 있는 장비 위주로 조회
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

    const now = new Date().getTime();
    // 5분(300,000ms) 이내에 통신 기록이 있으면 Online으로 간주
    const ONLINE_THRESHOLD_MS = 5 * 60 * 1000;

    // DTO 변환 (Frontend 요구사항에 맞춤)
    return results.map((eqp) => {
      const info: any = eqp.agentInfo || {};
      const status: any = eqp.agentStatus || {};
      const itm: any = eqp.itmInfo || {};

      // Status 로직: '최근 통신 시간' 기준으로 Online 판별
      let isOnline = false;
      if (status.lastPerfUpdate) {
        const lastContactTime = new Date(status.lastPerfUpdate).getTime();
        if (now - lastContactTime < ONLINE_THRESHOLD_MS) {
          isOnline = true;
        }
      }

      return {
        eqpId: eqp.eqpid,
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

        // 데이터 대체 표시 문제 해결 (ITM Info가 없으면 '-' 표시)
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

    // [수정] type에 'error' 추가: Error 페이지에서도 Agent 설치된 장비만 나오도록 함
    if (
      type === 'wafer' ||
      type === 'agent' ||
      type === 'performance' ||
      type === 'error'
    ) {
      where.agentInfo = {
        isNot: null, // AgentInfo가 존재하는 레코드만 선택
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
      include: { sdwtRel: true },
    });

    if (!eqp) throw new NotFoundException(`Equipment ${eqpId} not found`);
    return eqp;
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
