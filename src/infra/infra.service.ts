// ITM-Data-API/src/infra/infra.service.ts
import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma.service';
import { Prisma } from '@prisma/client';

@Injectable()
export class InfraService {
  constructor(private prisma: PrismaService) {}

  // --- 1. SDWT 관리 (ref_sdwt) ---

  // 목록 조회
  async getSdwts() {
    return this.prisma.refSdwt.findMany({
      orderBy: { sdwt: 'asc' },
    });
  }

  // 생성
  async createSdwt(data: Prisma.RefSdwtCreateInput) {
    // update 시간 자동 처리됨 (DB Default or Prisma)
    return this.prisma.refSdwt.create({ data });
  }

  // 수정
  async updateSdwt(id: string, data: Prisma.RefSdwtUpdateInput) {
    return this.prisma.refSdwt.update({
      where: { id },
      data: {
        ...data,
        update: new Date(), // 수정 시간 갱신
      },
    });
  }

  // 삭제
  async deleteSdwt(id: string) {
    return this.prisma.refSdwt.delete({
      where: { id },
    });
  }

  // --- 2. Agent Server Config 관리 (cfg_server) ---

  // 목록 조회
  async getAgentServers() {
    return this.prisma.cfgServer.findMany({
      orderBy: { eqpid: 'asc' },
    });
  }

  // 생성
  async createAgentServer(data: Prisma.CfgServerCreateInput) {
    return this.prisma.cfgServer.create({ data });
  }

  // 수정
  async updateAgentServer(eqpid: string, data: Prisma.CfgServerUpdateInput) {
    return this.prisma.cfgServer.update({
      where: { eqpid },
      data,
    });
  }

  // 삭제
  async deleteAgentServer(eqpid: string) {
    return this.prisma.cfgServer.delete({
      where: { eqpid },
    });
  }
}
