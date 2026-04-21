// ITM-Data-API_v1/src/admin/admin.service.ts
import { Injectable, NotFoundException, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma.service';
import { Prisma } from '@prisma/client';
import { Cron } from '@nestjs/schedule';
import * as http from 'http';
import * as https from 'https';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

@Injectable()
export class AdminService {
  private readonly logger = new Logger(AdminService.name);

  constructor(private prisma: PrismaService) {}

  private getKstDate(): Date {
    const now = new Date();
    const kstDate = new Date(now.getTime() + 9 * 60 * 60 * 1000);
    kstDate.setMilliseconds(0);
    return kstDate;
  }

  private async fetchUploadApiSize(url: string): Promise<any> {
    return new Promise((resolve, reject) => {
      const client = url.startsWith('https') ? https : http;
      const req = client.get(url, (res) => {
        if (res.statusCode && (res.statusCode < 200 || res.statusCode >= 300)) {
          return reject(new Error(`HTTP Status Code: ${res.statusCode}`));
        }
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          try { resolve(JSON.parse(data)); } 
          catch (e) { reject(new Error('Invalid JSON response')); }
        });
      });
      req.on('error', reject);
      req.setTimeout(180000, () => {
        req.destroy();
        reject(new Error('Request timeout (180s)'));
      });
    });
  }

  private getTargetTimeColumn(tableName: string): string | null {
    const columnMap: Record<string, string> = {
      'eqp_perf': 'serv_ts',
      'eqp_proc_perf': 'serv_ts',
      'plg_error': 'serv_ts',
      'plg_onto_spectrum': 'serv_ts',
      'plg_prealign': 'serv_ts',
      'plg_wf_flat': 'serv_ts',
      'plg_wf_map': 'serv_ts',
      'sys_access_logs': 'access_ts',
      'sys_alert': 'created_at',
      'sys_board': 'created_at',
      'sys_board_comment': 'created_at',
      'sys_user': 'created_at',
      'sys_user_context': 'updated_at',
    };
    if (columnMap[tableName]) return columnMap[tableName];
    return null; 
  }

  @Cron('0 0 2 * * *', { timeZone: 'Asia/Seoul' })
  async recordDailyStorageSize() {
    this.logger.log('Starting daily storage size recording (Cron)...');
    const now = new Date();
    const kstTime = new Date(now.getTime() + 9 * 60 * 60 * 1000);
    const kstYesterday = new Date(kstTime.getTime() - 24 * 60 * 60 * 1000);
    const checkDate = new Date(Date.UTC(kstYesterday.getUTCFullYear(), kstYesterday.getUTCMonth(), kstYesterday.getUTCDate()));
    const kstNow = this.getKstDate();
    try {
      const uploadApiUrl = process.env.UPLOAD_API_URL || 'http://127.0.0.1:8082';
      const dateStr = `${kstYesterday.getUTCFullYear()}${String(kstYesterday.getUTCMonth() + 1).padStart(2, '0')}${String(kstYesterday.getUTCDate()).padStart(2, '0')}`;
      const data = await this.fetchUploadApiSize(`${uploadApiUrl}/api/FileUpload/daily-size?date=${dateStr}`);
      if (data?.success && Number(data.sizeBytes) > 0) {
        await this.prisma.sysStorageHistory.upsert({
          where: { checkDate_tableName: { checkDate, tableName: 'OBJECT_STORE_TOTAL' } },
          update: { sizeBytes: Number(data.sizeBytes), rowCount: 0 },
          create: { checkDate, tableName: 'OBJECT_STORE_TOTAL', sizeBytes: Number(data.sizeBytes), rowCount: 0, storageType: 'FILE', createdAt: kstNow },
        });
      }
    } catch (e) { this.logger.error(`[Upload API Error] ${e.message}`); }
    try {
      const dbTables: any[] = await this.prisma.$queryRaw`SELECT c.relname AS "tableName" FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p')`;
      for (const t of dbTables) {
        const tableName = String(t.tableName);
        const tsColumn = this.getTargetTimeColumn(tableName);
        if (!tsColumn) continue;
        const countStats: any[] = await this.prisma.$queryRawUnsafe(`SELECT COUNT(*)::bigint AS "dailyRowCount" FROM "${tableName}" WHERE "${tsColumn}" >= $1::timestamp AND "${tsColumn}" < $2::timestamp`, 
          `${kstYesterday.getUTCFullYear()}-${kstYesterday.getUTCMonth()+1}-${kstYesterday.getUTCDate()} 00:00:00`,
          `${kstTime.getUTCFullYear()}-${kstTime.getUTCMonth()+1}-${kstTime.getUTCDate()} 00:00:00`);
        const dailyRowCount = Number(countStats[0]?.dailyRowCount || 0);
        if (dailyRowCount === 0) continue;
        await this.prisma.sysStorageHistory.upsert({
          where: { checkDate_tableName: { checkDate, tableName } },
          update: { rowCount: dailyRowCount },
          create: { checkDate, tableName, sizeBytes: 0, rowCount: dailyRowCount, storageType: 'DB', createdAt: kstNow },
        });
      }
    } catch (e) { this.logger.error(`[DB Size Error] ${e.message}`); }
  }

  @Cron('0 5 0 * * *', { timeZone: 'Asia/Seoul' })
  async cleanupOldServerMetrics() {
    this.logger.log('Cleaning up old server metrics (> 30 days)...');
    try {
      const thirtyDaysAgo = this.getKstDate();
      thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
      const result = await (this.prisma as any).serverMetric.deleteMany({ where: { createdAt: { lt: thirtyDaysAgo } } });
      this.logger.log(`Deleted ${result.count} old records.`);
    } catch (e) { this.logger.error(`[Cleanup Error] ${e.message}`); }
  }

  async recordServerMetric(data: { serverId: string; cpu: number; memory: number; disk: number }) {
    try {
      return await (this.prisma as any).serverMetric.create({
        data: { serverId: data.serverId, cpu: data.cpu, memory: data.memory, disk: data.disk, createdAt: this.getKstDate() },
      });
    } catch (e) { this.logger.error(`[Record Metric Error] ${e.message}`); return { success: false }; }
  }

  async getLatestServerMetrics() {
    try {
      const latestMetrics: any[] = await this.prisma.$queryRaw`SELECT DISTINCT ON ("serverId") "serverId", "cpu", "memory", "disk", "createdAt" FROM "ServerMetric" ORDER BY "serverId", "createdAt" DESC`;

      const SERVER_SPECS: Record<string, { name: string; cpu: number; memory: number; disk: number; order: number }> = {
        'web-server': { name: 'Web Server', cpu: 8, memory: 32, disk: 100, order: 1 }, 
        'api-server': { name: 'API Server', cpu: 8, memory: 32, disk: 100, order: 2 },
        'db-storage-server': { name: 'DB & Storage Server', cpu: 12, memory: 64, disk: 4000, order: 3 }, 
        'default': { name: 'Unknown Server', cpu: 4, memory: 16, disk: 200, order: 99 }
      };

      const result = latestMetrics.map(metric => {
        let status = 'healthy';
        if (metric.cpu >= 90 || metric.memory >= 90) status = 'critical';
        else if (metric.cpu >= 75 || metric.memory >= 75) status = 'warning';

        const spec = SERVER_SPECS[metric.serverId] || SERVER_SPECS['default'];
        const usedCpu = (spec.cpu * (metric.cpu / 100)).toFixed(1);
        const usedMem = (spec.memory * (metric.memory / 100)).toFixed(1);
        const usedDisk = (spec.disk * (metric.disk / 100)).toFixed(1);

        return {
          id: metric.serverId,
          name: spec.name,
          ip: 'Connected',
          status,
          order: spec.order, // 정렬용 순서값 추가
          cpu: Number(metric.cpu.toFixed(1)),
          cpuDetails: `${usedCpu} vCPU / ${spec.cpu} vCPU`, 
          memory: Number(metric.memory.toFixed(1)),
          memoryDetails: `${usedMem} GB / ${spec.memory} GB`, 
          disk: Number(metric.disk.toFixed(1)),
          diskDetails: `${usedDisk} GB / ${spec.disk} GB`, 
        };
      });

      // [핵심 변경] Web -> API -> DB 순으로 정렬하여 반환
      return result.sort((a, b) => a.order - b.order);

    } catch (e) { this.logger.error(`[Fetch Metrics Error] ${e.message}`); return []; }
  }

  async getServerTrend(serverId: string, days: number = 30) {
    const targetDate = this.getKstDate();
    targetDate.setDate(targetDate.getDate() - days);
    try {
      const rawData = await (this.prisma as any).serverMetric.findMany({ where: { serverId, createdAt: { gte: targetDate } }, orderBy: { createdAt: 'asc' } });
      if (!rawData.length) return { dates: [], cpu: [], memory: [], disk: [] };
      return {
        dates: rawData.map(d => d.createdAt.toISOString()),
        cpu: rawData.map(d => Number(d.cpu.toFixed(1))),
        memory: rawData.map(d => Number(d.memory.toFixed(1))),
        disk: rawData.map(d => Number(d.disk.toFixed(1))),
      };
    } catch (e) { return { dates: [], cpu: [], memory: [], disk: [] }; }
  }

  async getExceptionUsers() { return this.prisma.cfgUserException.findMany({ orderBy: { createdAt: 'desc' } }); }
  async addExceptionUser(data: any) { return this.prisma.cfgUserException.create({ data: { ...data, isActive: 'Y', createdAt: this.getKstDate() } }); }
  async updateExceptionUserStatus(loginId: string, isActive: string) { return this.prisma.cfgUserException.update({ where: { loginId }, data: { isActive } }); }
  async deleteExceptionUser(loginId: string) { return this.prisma.cfgUserException.delete({ where: { loginId } }); }
  async getAllUsers() { return this.prisma.sysUser.findMany({ include: { context: { include: { sdwtInfo: true } } }, orderBy: { lastLoginAt: 'desc' } }); }
  async getAllAdmins() { return this.prisma.cfgAdminUser.findMany({ orderBy: { assignedAt: 'desc' } }); }
  async addAdmin(data: any) { return this.prisma.cfgAdminUser.create({ data: { ...data, assignedAt: this.getKstDate() } }); }
  async deleteAdmin(loginId: string) { return this.prisma.cfgAdminUser.delete({ where: { loginId } }); }
  async getAllAccessCodes() { return this.prisma.refAccessCode.findMany({ orderBy: { updatedAt: 'desc' } }); }
  async createAccessCode(data: any) { return this.prisma.refAccessCode.create({ data: { ...data, isActive: 'Y', updatedAt: this.getKstDate() } }); }
  async updateAccessCode(deptid: string, data: any) { return this.prisma.refAccessCode.update({ where: { deptid }, data: { ...data, updatedAt: this.getKstDate() } }); }
  async deleteAccessCode(deptid: string) { return this.prisma.refAccessCode.delete({ where: { deptid } }); }
  async getAllGuests() { return this.prisma.cfgGuestAccess.findMany({ orderBy: { createdAt: 'desc' } }); }
  async addGuest(data: any) { return this.prisma.cfgGuestAccess.create({ data: { ...data, grantedRole: 'GUEST', createdAt: this.getKstDate() } }); }
  async deleteGuest(loginId: string) { return this.prisma.cfgGuestAccess.delete({ where: { loginId } }); }
  async getGuestRequests() { return this.prisma.cfgGuestRequest.findMany({ orderBy: { createdAt: 'desc' } }); }
  async approveGuestRequest(reqId: number, approverId: string) { return { success: true }; }
  async rejectGuestRequest(reqId: number, rejectorId: string) { return this.prisma.cfgGuestRequest.update({ where: { reqId }, data: { status: 'REJECTED', processedBy: rejectorId, processedAt: this.getKstDate() } }); }
  async getSeverities() { return this.prisma.errSeverityMap.findMany(); }
  async addSeverity(data: any) { return this.prisma.errSeverityMap.create({ data }); }
  async updateSeverity(errorId: string, data: any) { return this.prisma.errSeverityMap.update({ where: { errorId }, data }); }
  async deleteSeverity(errorId: string) { return this.prisma.errSeverityMap.delete({ where: { errorId } }); }
  async getMetrics() { return this.prisma.cfgLotUniformityMetrics.findMany(); }
  async addMetric(data: any) { return this.prisma.cfgLotUniformityMetrics.create({ data }); }
  async updateMetric(metricName: string, data: any) { return this.prisma.cfgLotUniformityMetrics.update({ where: { metricName }, data }); }
  async deleteMetric(metricName: string) { return this.prisma.cfgLotUniformityMetrics.delete({ where: { metricName } }); }
  async getNewServerConfig() { return this.prisma.cfgNewServer.findUnique({ where: { id: 1 } }); }
  async updateNewServerConfig(data: any) { return this.prisma.cfgNewServer.upsert({ where: { id: 1 }, update: data, create: { id: 1, ...data } }); }
  async getCfgServers() { return this.prisma.cfgServer.findMany(); }
  async updateCfgServer(eqpid: string, data: any) { return this.prisma.cfgServer.update({ where: { eqpid }, data }); }
  async logAccess(data: any) { return this.prisma.sysAccessLog.create({ data: { ...data, accessTs: this.getKstDate() } }); }
  async syncStorageNow() { await this.recordDailyStorageSize(); return { success: true }; }
  async getUsageAnalytics(startDate: string, endDate: string) {
    const start = new Date(startDate.replace(' ', 'T') + '.000Z');
    const end = new Date(endDate.replace(' ', 'T') + '.999Z');
    const generateDateRange = (sStr: string, eStr: string) => {
      const dates: string[] = []; 
      const curr = new Date(sStr.substring(0, 10) + 'T00:00:00.000Z');
      const last = new Date(eStr.substring(0, 10) + 'T00:00:00.000Z');
      while (curr <= last) {
        const mm = String(curr.getUTCMonth() + 1).padStart(2, '0');
        const dd = String(curr.getUTCDate()).padStart(2, '0');
        dates.push(`${mm}-${dd}`);
        curr.setUTCDate(curr.getUTCDate() + 1);
      }
      return dates;
    };
    const dateLabels = generateDateRange(startDate, endDate);
    const admins = await this.prisma.cfgAdminUser.findMany({ select: { loginId: true } });
    const excludeIds = admins.map(a => a.loginId?.toLowerCase()).filter(Boolean);
    ['admin', 'administrator', 'system', 'manager'].forEach(id => excludeIds.push(id));
    const currentWhere = { accessTs: { gte: start, lte: end }, loginId: { notIn: Array.from(new Set(excludeIds)) } };
    const totalViews = await this.prisma.sysAccessLog.count({ where: { ...currentWhere, menuName: { not: 'APP_ENTRY' } } });
    const totalVisits = await this.prisma.sysAccessLog.count({ where: { ...currentWhere, menuName: 'APP_ENTRY' } });
    const usersGrp = await this.prisma.sysAccessLog.groupBy({ by: ['loginId'], where: currentWhere });
    const totalUsers = usersGrp.length;
    return { kpi: { totalUsers, totalVisits, totalViews }, dailyTrend: dateLabels.map(d => ({ date: d, views: 0, visits: 0, users: 0 })) };
  }
  async getStorageUsage(startDate: string, endDate: string, interval: string) {
    const start = new Date(`${startDate}T00:00:00.000Z`);
    const end = new Date(`${endDate}T23:59:59.999Z`);
    let serverCapacityMB = 4194304;
    try {
      const { stdout } = await execAsync("df -m /appdata | awk 'NR==2 {print $2}'");
      const parsed = parseInt(stdout.trim(), 10);
      if (!isNaN(parsed)) serverCapacityMB = parsed;
    } catch (e) {}
    let totalDbUsageMB = 0;
    const dbTables: any[] = await this.prisma.$queryRaw`SELECT c.relname AS "tableName", COALESCE(pg_total_relation_size(c.oid), 0) AS "sizeBytes" FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p')`;
    const tableDetails = dbTables.map(t => {
      const mb = Number(t.sizeBytes) / (1024 * 1024);
      totalDbUsageMB += mb;
      return { tableName: t.tableName, sizeMB: mb };
    });
    return { summary: { totalDbUsageMB, totalObjectStorageMB: 0, serverCapacityMB }, tableDetails, dailyTrends: [], monthlyTrends: [] };
  }
}
