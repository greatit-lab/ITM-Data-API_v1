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

      const SERVER_SPECS: Record<string, { name: string; cpu: number; memory: number; disk: number }> = {
        'web-server': { name: 'Web Server', cpu: 8, memory: 32, disk: 200 }, 
        'api-server': { name: 'API Server', cpu: 8, memory: 32, disk: 200 },
        'db-storage-server': { name: 'DB & Storage Server', cpu: 12, memory: 64, disk: 4000 }, 
        'default': { name: 'Unknown Server', cpu: 4, memory: 16, disk: 200 }
      };

      return latestMetrics.map(metric => {
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
          cpu: Number(metric.cpu.toFixed(1)),
          cpuDetails: `${usedCpu} vCPU / ${spec.cpu} vCPU`, 
          memory: Number(metric.memory.toFixed(1)),
          memoryDetails: `${usedMem} GB / ${spec.memory} GB`, 
          disk: Number(metric.disk.toFixed(1)),
          diskDetails: `${usedDisk} GB / ${spec.disk} GB`, 
        };
      });
    } catch (e) { this.logger.error(`[Fetch Metrics Error] ${e.message}`); return []; }
  }

  async getServerTrend(serverId: string, days: number = 30) {
    const targetDate = this.getKstDate();
    targetDate.setDate(targetDate.getDate() - days);
    
    try {
      const rawData = await (this.prisma as any).serverMetric.findMany({ 
        where: { serverId, createdAt: { gte: targetDate } }, 
        orderBy: { createdAt: 'asc' } 
      });
      
      if (!rawData.length) return { dates: [], cpu: [], memory: [], disk: [] };

      const dates = rawData.map(d => d.createdAt.toISOString());
      const cpu = rawData.map(d => Number(d.cpu.toFixed(1)));
      const memory = rawData.map(d => Number(d.memory.toFixed(1)));
      const disk = rawData.map(d => Number(d.disk.toFixed(1)));

      return { dates, cpu, memory, disk };
      
    } catch (e) { 
      return { dates: [], cpu: [], memory: [], disk: [] }; 
    }
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

  // ==========================================
  // [복구 완료] Usage Analytics 집계 로직
  // ==========================================
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
    const excludeSet = new Set<string>();
    const baseExcludes = ['admin', 'administrator', 'system', 'manager'];
    admins.forEach(a => { if (a.loginId) baseExcludes.push(a.loginId); });
    baseExcludes.forEach(id => { excludeSet.add(id); excludeSet.add(id.toLowerCase()); excludeSet.add(id.toUpperCase()); });
    const excludeIds = Array.from(excludeSet);

    const periodMs = end.getTime() - start.getTime() + 1;
    const prevStart = new Date(start.getTime() - periodMs);
    const prevEnd = new Date(end.getTime() - periodMs);

    const userFilter = { loginId: { notIn: excludeIds } };
    const currentWhere = { accessTs: { gte: start, lte: end }, ...userFilter };
    const prevWhere = { accessTs: { gte: prevStart, lte: prevEnd }, ...userFilter };

    const totalViews = await this.prisma.sysAccessLog.count({ where: { ...currentWhere, menuName: { not: 'APP_ENTRY' } } });
    const totalVisits = await this.prisma.sysAccessLog.count({ where: { ...currentWhere, menuName: 'APP_ENTRY' } });
    const users = await this.prisma.sysAccessLog.groupBy({ by: ['loginId'], where: currentWhere });
    const totalUsers = users.length;
    
    const prevViews = await this.prisma.sysAccessLog.count({ where: { ...prevWhere, menuName: { not: 'APP_ENTRY' } } });
    const prevVisits = await this.prisma.sysAccessLog.count({ where: { ...prevWhere, menuName: 'APP_ENTRY' } });
    const prevUsersGrp = await this.prisma.sysAccessLog.groupBy({ by: ['loginId'], where: prevWhere });
    const prevUsers = prevUsersGrp.length;

    const viewsDelta = prevViews === 0 ? (totalViews > 0 ? 100 : 0) : Math.round(((totalViews - prevViews) / prevViews) * 100);
    const visitsDelta = prevVisits === 0 ? (totalVisits > 0 ? 100 : 0) : Math.round(((totalVisits - prevVisits) / prevVisits) * 100);
    const usersDelta = prevUsers === 0 ? (totalUsers > 0 ? 100 : 0) : Math.round(((totalUsers - prevUsers) / prevUsers) * 100);

    const topMenuObj = await this.prisma.sysAccessLog.groupBy({ by: ['menuName'], _count: { menuName: true }, where: { ...currentWhere, menuName: { not: 'APP_ENTRY' } }, orderBy: { _count: { menuName: 'desc' } }, take: 1, });
    const topPage = topMenuObj.length > 0 ? topMenuObj[0].menuName : '-';

    const lowerExcludeIds = Array.from(new Set(baseExcludes.map(id => id.toLowerCase())));
    let adminCondition = Prisma.empty;
    if (lowerExcludeIds.length > 0) {
      adminCondition = Prisma.sql`AND LOWER(login_id) NOT IN (${Prisma.join(lowerExcludeIds)})`;
    }

    const dailyData: any[] = await this.prisma.$queryRaw`
      SELECT to_char(access_ts, 'MM-DD') as date, 
             COUNT(id) FILTER (WHERE menu_name != 'APP_ENTRY')::int as views,
             COUNT(id) FILTER (WHERE menu_name = 'APP_ENTRY')::int as visits,
             COUNT(DISTINCT login_id)::int as users
      FROM public.sys_access_logs
      WHERE access_ts >= ${startDate}::timestamp AND access_ts <= ${endDate}::timestamp
      ${adminCondition}
      GROUP BY to_char(access_ts, 'MM-DD')
      ORDER BY date ASC
    `;

    const trendMap = new Map(dailyData.map((d: any) => [d.date, d]));
    const paddedDailyTrend = dateLabels.map(date => {
      const existing = trendMap.get(date);
      return { date, views: existing ? existing.views : 0, visits: existing ? existing.visits : 0, users: existing ? existing.users : 0 };
    });

    const dailyMenuData = await this.prisma.$queryRaw`
      SELECT to_char(access_ts, 'MM-DD') as date, menu_name as menu, COUNT(id)::int as views
      FROM public.sys_access_logs
      WHERE access_ts >= ${startDate}::timestamp AND access_ts <= ${endDate}::timestamp
      AND menu_name != 'APP_ENTRY'
      ${adminCondition}
      GROUP BY to_char(access_ts, 'MM-DD'), menu_name
      ORDER BY date ASC
    `;

    const menuUtilization = await this.prisma.sysAccessLog.groupBy({ by: ['menuName'], _count: { menuName: true }, where: { ...currentWhere, menuName: { not: 'APP_ENTRY' } }, orderBy: { _count: { menuName: 'desc' } }, take: 10, });
    const recentLogs = await this.prisma.sysAccessLog.findMany({ where: { ...currentWhere, menuName: { not: 'APP_ENTRY' } }, orderBy: { accessTs: 'desc' }, take: 1000, });

    return {
      kpi: { totalUsers, totalVisits, totalViews, topPage, viewsDelta, visitsDelta, usersDelta },
      dailyTrend: paddedDailyTrend, dailyMenuTrend: dailyMenuData, 
      menuUtilization: menuUtilization.map((m) => ({ menu: m.menuName, views: m._count.menuName })),
      recentLogs: recentLogs.map((l) => {
        const d = new Date(l.accessTs);
        return { time: d.toISOString().replace('T', ' ').substring(0, 19), loginId: l.loginId, menu: l.menuName };
      }),
    };
  }

  // ==========================================
  // [복구 완료] Storage DB & Analytics 집계 로직
  // ==========================================
  async getStorageUsage(startDate: string, endDate: string, interval: string) {
    const start = new Date(`${startDate}T00:00:00.000Z`);
    const end = new Date(`${endDate}T23:59:59.999Z`);

    // [수정 반영] OS 디스크 크기 조회 대상을 '/' 에서 실제 데이터가 있는 '/appdata' 로 변경
    let serverCapacityMB = 4194304;
    try {
      const { stdout } = await execAsync("df -m /appdata | awk 'NR==2 {print $2}'");
      const parsed = parseInt(stdout.trim(), 10);
      if (!isNaN(parsed) && parsed > 0) {
        serverCapacityMB = parsed;
      }
    } catch (error: any) {
      this.logger.warn(`[OS Disk Warning] 리눅스 실제 디스크 크기 조회 실패, 기본값 사용: ${error.message}`);
    }

    let totalDbUsageMB = 0;
    let tableDetails: any[] = [];
    
    try {
      const dbTables: any[] = await this.prisma.$queryRaw`
        SELECT
          c.relname AS "tableName",
          COALESCE(c.reltuples::bigint, 0) AS "rowCount",
          COALESCE(pg_total_relation_size(c.oid), 0) AS "sizeBytes"
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p')
        ORDER BY pg_total_relation_size(c.oid) DESC
      `;

      tableDetails = dbTables.map((t) => {
        const sizeMB = Number(t.sizeBytes || 0) / (1024 * 1024);
        totalDbUsageMB += sizeMB;
        const tableName = String(t.tableName || '');
        const isDynamic = this.getTargetTimeColumn(tableName) !== null;
        return { tableName, type: isDynamic ? 'Dynamic' : 'Static', rowCount: Number(t.rowCount || 0), sizeMB };
      });
    } catch (error: any) {
      this.logger.error(`[DB Query Error] ${error.message}`);
    }

    let totalObjectStorageMB = 0;
    try {
      const uploadApiUrl = process.env.UPLOAD_API_URL || 'http://127.0.0.1:8082';
      const targetUrl = `${uploadApiUrl}/api/FileUpload/size`;
      
      const data = await this.fetchUploadApiSize(targetUrl);
      if (data && data.success) {
        totalObjectStorageMB = Number(data.sizeBytes) / (1024 * 1024);
      } else {
        throw new Error('API returned false');
      }
    } catch (error: any) {
      this.logger.warn(`[File Storage Warning] Real-time fetch failed. Checking DB History fallback.`);
      const fallbackSum = await this.prisma.sysStorageHistory.aggregate({
        _sum: { sizeBytes: true },
        where: { storageType: 'FILE' }
      });
      totalObjectStorageMB = Number(fallbackSum._sum.sizeBytes || 0) / (1024 * 1024);
    }

    const dailyTrends: Array<{ date: string; cumDbMB: number; cumObjMB: number; dailyDbMB: number; dailyObjMB: number; }> = [];
    const monthlyTrends: Array<{ date: string; cumDbMB: number; cumObjMB: number; monthlyDbMB: number; monthlyObjMB: number; }> = [];

    try {
      const histories = await this.prisma.sysStorageHistory.findMany({
        where: { checkDate: { gte: start, lte: end } },
        orderBy: { checkDate: 'asc' }
      });

      const dateMap = new Map<string, { dbBytes: number, objBytes: number }>();
      histories.forEach(h => {
        const dateStr = h.checkDate.toISOString().split('T')[0];
        if (!dateMap.has(dateStr)) dateMap.set(dateStr, { dbBytes: 0, objBytes: 0 });
        const data = dateMap.get(dateStr)!;
        
        if (h.storageType === 'FILE') {
          data.objBytes += Number(h.sizeBytes); 
        } else {
          data.dbBytes += Number(h.sizeBytes);  
        }
      });

      const trendDates = Array.from(dateMap.keys()).sort();
      
      let runningCumObjMB = 0;
      let runningCumDbMB = 0; 

      if (trendDates.length > 0) {
        const firstDate = new Date(trendDates[0]);
        firstDate.setUTCDate(firstDate.getUTCDate() - 1); 

        const prevObjSum = await this.prisma.sysStorageHistory.aggregate({
          _sum: { sizeBytes: true },
          where: { storageType: 'FILE', checkDate: { lte: firstDate } }
        });
        runningCumObjMB = Number(prevObjSum._sum.sizeBytes || 0) / (1024 * 1024);

        const prevDbSum = await this.prisma.sysStorageHistory.aggregate({
          _sum: { sizeBytes: true },
          where: { storageType: 'DB', checkDate: { lte: firstDate } }
        });
        runningCumDbMB = Number(prevDbSum._sum.sizeBytes || 0) / (1024 * 1024);
      }

      const monthlyMap = new Map<string, any>();

      for (let i = 0; i < trendDates.length; i++) {
        const date = trendDates[i];
        const current = dateMap.get(date)!;

        const dailyDbMB = current.dbBytes / (1024 * 1024); 
        const dailyObjMB = current.objBytes / (1024 * 1024); 

        runningCumObjMB += dailyObjMB; 
        runningCumDbMB += dailyDbMB; 

        dailyTrends.push({ 
          date, 
          cumDbMB: runningCumDbMB,
          cumObjMB: runningCumObjMB, 
          dailyDbMB: dailyDbMB,       
          dailyObjMB: dailyObjMB 
        });

        const month = date.substring(0, 7);
        if (!monthlyMap.has(month)) monthlyMap.set(month, { date: month, cumDbMB: runningCumDbMB, cumObjMB: runningCumObjMB, monthlyDbMB: 0, monthlyObjMB: 0 });
        const m = monthlyMap.get(month)!;
        
        m.monthlyDbMB += dailyDbMB;
        m.monthlyObjMB += dailyObjMB;
        m.cumDbMB = runningCumDbMB; 
        m.cumObjMB = runningCumObjMB;
      }
      monthlyTrends.push(...Array.from(monthlyMap.values()));
    } catch (error: any) {
      this.logger.error(`[Trends Query Error] ${error.message}`);
    }

    return { summary: { totalDbUsageMB, totalObjectStorageMB, serverCapacityMB }, tableDetails, dailyTrends, monthlyTrends };
  }
}
