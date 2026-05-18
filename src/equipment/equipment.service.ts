// ITM-Data-API/src/equipment/equipment.service.ts
import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma.service';
import { Prisma } from '@prisma/client';

@Injectable()
export class EquipmentService {
  constructor(private prisma: PrismaService) {}

  // 1. 인프라 관리용 목록 조회
  async getInfraList() {
    const equipments = await this.prisma.refEquipment.findMany({
      orderBy: { eqpid: 'asc' },
    });

    const sdwtIds = [...new Set(equipments.map((e) => e.sdwt).filter(Boolean))];

    const sdwts = await this.prisma.refSdwt.findMany({
      where: { sdwt: { in: sdwtIds } },
    });

    const sdwtMap = new Map(sdwts.map((s) => [s.sdwt, s]));

    return equipments.map((item) => ({
      ...item,
      eqpId: item.eqpid, 
      sdwtRel: sdwtMap.get(item.sdwt) || null,
    }));
  }

  // 2. 장비 상세 조회 (Explorer 및 Equipment Status Summary 상세 팝업용 API)
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

    // cfgServer 정보와 agentInfo 정보를 함께 Join하여 관계 데이터 조회
    const results = await this.prisma.refEquipment.findMany({
      where,
      include: {
        agentInfo: true,
        agentStatus: true,
        sdwtRel: true,
        itmInfo: true,
        cfgServer: true, 
      },
      orderBy: { eqpid: 'asc' },
    });

    return results.map((eqp) => {
      const info: any = eqp.agentInfo || {};
      const status: any = eqp.agentStatus || {};
      const itm: any = eqp.itmInfo || {};
      const cfg: any = eqp.cfgServer || {}; 

      let isOnline = false;
      if (status.status && status.status.toUpperCase() === 'ONLINE') {
        isOnline = true;
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
        systemModel: itm.systemModel || '-',
        serialNum: itm.serialNum || '-',
        application: itm.application || '-',
        version: itm.version || '-',        // ITM 장비(설비) 자체 App Ver (itmInfo)
        dbVersion: itm.dbVersion || '-',
        appVer: info.appVer || '-',         // [버그 수정] 누락되었던 실제 ITM Agent 프로그램 버전(agentInfo) 매핑 추가!
        useProxy: cfg.useProxy || 'N',      // 프록시 여부 매핑
        proxyIp: cfg.proxyIp || '-',         // 프록시 IP 매핑
      };
    });
  }

  // 3. 장비 ID 목록 조회
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
