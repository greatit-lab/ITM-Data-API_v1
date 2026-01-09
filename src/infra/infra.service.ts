// ITM-Data-API/src/infra/infra.service.ts
import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma.service';
import { Prisma } from '@prisma/client';

@Injectable()
export class InfraService {
  constructor(private prisma: PrismaService) {}

  // 1. SDWT 관리
  async getSdwts() {
    return this.prisma.refSdwt.findMany({ orderBy: { sdwt: 'asc' } });
  }
  async createSdwt(data: Prisma.RefSdwtCreateInput) {
    return this.prisma.refSdwt.create({ data });
  }
  async updateSdwt(id: string, data: Prisma.RefSdwtUpdateInput) {
    return this.prisma.refSdwt.update({ where: { id }, data: { ...data, update: new Date() } });
  }
  async deleteSdwt(id: string) {
    return this.prisma.refSdwt.delete({ where: { id } });
  }

  // 2. Agent Server Config 관리
  async getAgentServers() {
    return this.prisma.cfgServer.findMany({ orderBy: { eqpid: 'asc' } });
  }
  async createAgentServer(data: Prisma.CfgServerCreateInput) {
    return this.prisma.cfgServer.create({ data });
  }
  async updateAgentServer(eqpid: string, data: Prisma.CfgServerUpdateInput) {
    return this.prisma.cfgServer.update({ where: { eqpid }, data });
  }
  async deleteAgentServer(eqpid: string) {
    return this.prisma.cfgServer.delete({ where: { eqpid } });
  }
}
