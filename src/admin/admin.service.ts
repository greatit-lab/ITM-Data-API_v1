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
  
  private prevCpuSnapshot: Map<string, number> = new Map();

  constructor(private prisma: PrismaService) {}

  private getKstDate(): Date {
    const now = new Date();
    const kstDate = new Date(now.getTime() + 9 * 60 * 60 * 1000);
    kstDate.setMilliseconds(0);
    return kstDate;
  }

  // ==========================================
  // [신규 추가] 시스템 점검 모드 (Maintenance Mode)
  // ==========================================
  async getMaintenanceStatus() {
    try {
      const results: any[] = await this.prisma.$queryRaw`
        SELECT config_key, config_value 
        FROM cfg_system_config 
        WHERE config_key IN ('MAINTENANCE_MODE', 'MAINTENANCE_EXPECTED_TIME')
      `;
      
      let isMaintenance = false;
      let expectedTime = '별도 공지 시까지';

      for (const row of results) {
        if (row.config_key === 'MAINTENANCE_MODE') isMaintenance = row.config_value === 'true';
        if (row.config_key === 'MAINTENANCE_EXPECTED_TIME') expectedTime = row.config_value;
      }
      
      return { isMaintenance, expectedTime };
    } catch (error) {
      return { isMaintenance: false, expectedTime: '별도 공지 시까지' };
    }
  }

  async updateMaintenanceStatus(status: boolean, expectedTime: string = '별도 공지 시까지', loginId: string = 'system') {
    const val = status ? 'true' : 'false';
    try {
      await this.prisma.$executeRaw`
        CREATE TABLE IF NOT EXISTS cfg_system_config (
            config_key VARCHAR(50) PRIMARY KEY,
            config_value VARCHAR(255) NOT NULL,
            updated_at TIMESTAMP(0) DEFAULT CURRENT_TIMESTAMP(0)
        );
      `;
      
      // 모드 활성화 상태 업데이트
      await this.prisma.$executeRaw`
        INSERT INTO cfg_system_config (config_key, config_value, updated_at) 
        VALUES ('MAINTENANCE_MODE', ${val}, NOW()::timestamp(0))
        ON CONFLICT (config_key) 
        DO UPDATE SET config_value = EXCLUDED.config_value, updated_at = NOW()::timestamp(0);
      `;

      // 예상 완료 시간 업데이트
      await this.prisma.$executeRaw`
        INSERT INTO cfg_system_config (config_key, config_value, updated_at) 
        VALUES ('MAINTENANCE_EXPECTED_TIME', ${expectedTime}, NOW()::timestamp(0))
        ON CONFLICT (config_key) 
        DO UPDATE SET config_value = EXCLUDED.config_value, updated_at = NOW()::timestamp(0);
      `;
      
      this.logger.warn(`[System] Maintenance mode set to ${val} by ${loginId}. Expected: ${expectedTime}`);
      return { success: true, isMaintenance: status, expectedTime };
    } catch (error: any) {
      this.logger.error(`Failed to update maintenance mode: ${error.message}`);
      return { success: false, message: error.message };
    }
  }
  // ==========================================

  private async fetchPrometheusMetrics(url: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const client = url.startsWith('https') ? https : http;
      const req = client.get(url, { timeout: 10000 }, (res) => {
        if (res.statusCode && (res.statusCode < 200 || res.statusCode >= 300)) {
          return reject(new Error(`HTTP Status Code: ${res.statusCode}`));
        }
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => resolve(data));
      });
      req.on('error', reject);
      
      req.setTimeout(10000, () => {
        req.destroy();
        reject(new Error('Request timeout (10s)'));
      });
    });
  }

  private parseMetrics(text: string): Map<string, number> {
    const map = new Map<string, number>();
    const lines = text.split('\n');

    for (const line of lines) {
      if (!line || line.startsWith('#')) {
        continue;
      }
      const idx = line.lastIndexOf(' ');
      if (idx <= 0) {
        continue;
      }
      const key = line.substring(0, idx).trim();
      const value = Number(line.substring(idx + 1));

      if (!Number.isNaN(value)) {
        map.set(key, value);
      }
    }
    return map;
  }

  private calculateCpuUsage(current: Map<string, number>): number {
    let totalDelta = 0;
    let idleDelta = 0;

    for (const [key, value] of current.entries()) {
      if (!key.startsWith('node_cpu_seconds_total')) {
        continue;
      }
      const prev = this.prevCpuSnapshot.get(key);
      if (prev === undefined) {
        continue;
      }
      const delta = value - prev;
      totalDelta += delta;

      if (key.includes('mode="idle"')) {
        idleDelta += delta;
      }
    }

    this.prevCpuSnapshot = new Map(current);

    if (totalDelta <= 0) return 0;
    return (1 - idleDelta / totalDelta) * 100;
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
      
      req.setTimeout(15000, () => {
        req.destroy();
        reject(new Error('Request timeout (15s)'));
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
    if (tableName.startsWith('plg_onto_spectrum_y')) return 'serv_ts';

    return null; 
  }

  @Cron('0 * * * *', { timeZone: 'Asia/Seoul' })
  async collectDbaasMetrics() {
    this.logger.log('Starting DBaaS metrics collection...');
    
    const targetIp = '10.172.122.198';
    const url = `http://${targetIp}:9100/metrics`;
    const serverId = 'dbaas_db_server';

    try {
      const metricsText = await this.fetchPrometheusMetrics(url);
      const map = this.parseMetrics(metricsText);

      const memTotal = map.get('node_memory_MemTotal_bytes') ?? 0;
      const memAvailable = map.get('node_memory_MemAvailable_bytes') ?? 0;
      let memoryUsagePct = 0;
      if (memTotal > 0) {
        memoryUsagePct = ((memTotal - memAvailable) / memTotal) * 100;
      }

      let diskSize = 0;
      let diskAvail = 0;
      
      for (const [key, value] of map.entries()) {
        if (key.startsWith('node_filesystem_size_bytes') && key.includes('mountpoint="/data1"')) {
          diskSize = value;
        }
        if (key.startsWith('node_filesystem_avail_bytes') && key.includes('mountpoint="/data1"')) {
          diskAvail = value;
        }
      }

      let diskUsagePct = 0;
      if (diskSize > 0) {
        diskUsagePct = ((diskSize - diskAvail) / diskSize) * 100;
      }

      const cpuUsage = this.calculateCpuUsage(map);

      await (this.prisma as any).serverMetric.create({
        data: {
          serverId: serverId,
          cpu: Number(cpuUsage.toFixed(2)),
          memory: Number(memoryUsagePct.toFixed(2)),
          disk: Number(diskUsagePct.toFixed(2)),
          createdAt: this.getKstDate(),
        },
      });

      this.logger.log(`[DBaaS Metrics] Collected - CPU: ${cpuUsage.toFixed(2)}%, Mem: ${memoryUsagePct.toFixed(2)}%, Disk: ${diskUsagePct.toFixed(2)}%`);
    } catch (error: any) {
      this.logger.error(`[DBaaS Metrics Error] Failed to collect metrics from ${targetIp}: ${error.message}`);
    }
  }

  @Cron('0 0 2 * * *', { timeZone: 'Asia/Seoul' })
  async recordDailyStorageSize() {
    this.logger.log('Starting daily storage size recording (Cron)...');
    
    const now = new Date();
    const kstTime = new Date(now.getTime() + 9 * 60 * 60 * 1000);
    const kstYesterday = new Date(kstTime.getTime() - 24 * 60 * 60 * 1000);

    const yYear = kstYesterday.getUTCFullYear();
    const yMonth = kstYesterday.getUTCMonth(); 
    const yDate = kstYesterday.getUTCDate();

    const tYear = kstTime.getUTCFullYear();
    const tMonth = kstTime.getUTCMonth();
    const tDate = kstTime.getUTCDate();

    const checkDate = new Date(Date.UTC(yYear, yMonth, yDate));
    const pad = (n: number) => String(n).padStart(2, '0');
    
    const startDateStr = `${yYear}-${pad(yMonth + 1)}-${pad(yDate)} 00:00:00`;
    const endDateStr = `${tYear}-${pad(tMonth + 1)}-${pad(tDate)} 00:00:00`;
    const dateStr = `${yYear}${pad(yMonth + 1)}${pad(yDate)}`; 

    const kstNow = this.getKstDate();

    try {
      const uploadApiUrl = process.env.UPLOAD_API_URL || 'http://127.0.0.1:8082';
      const targetUrl = `${uploadApiUrl}/api/FileUpload/daily-size?date=${dateStr}`;
      
      const data = await this.fetchUploadApiSize(targetUrl);

      if (data && data.success) {
        const dailyIncrementBytes = Number(data.sizeBytes); 

        if (dailyIncrementBytes > 0) {
          await this.prisma.sysStorageHistory.upsert({
            where: { checkDate_tableName: { checkDate: checkDate, tableName: 'OBJECT_STORE_TOTAL' } },
            update: { sizeBytes: dailyIncrementBytes, rowCount: 0 },
            create: { checkDate, tableName: 'OBJECT_STORE_TOTAL', sizeBytes: dailyIncrementBytes, rowCount: 0, storageType: 'FILE', createdAt: kstNow },
          });
        }
      }
    } catch (error: any) {
      this.logger.error(`[Upload API Error] Failed to connect: ${error.message}`);
    }

    try {
      const dbTables: any[] = await this.prisma.$queryRaw`
        SELECT c.relname AS "tableName"
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p')
      `;

      for (const t of dbTables) {
        const tableName = String(t.tableName);
        const tsColumn = this.getTargetTimeColumn(tableName);

        if (!tsColumn) continue;

        const countStats: any[] = await this.prisma.$queryRawUnsafe(`
          SELECT COUNT(*)::bigint AS "dailyRowCount"
          FROM "${tableName}"
          WHERE "${tsColumn}" >= $1::timestamp AND "${tsColumn}" < $2::timestamp
        `, startDateStr, endDateStr);

        const dailyRowCount = Number(countStats[0]?.dailyRowCount || 0);

        if (dailyRowCount === 0) continue;

        const sampleStats: any[] = await this.prisma.$queryRawUnsafe(`
          SELECT COALESCE(AVG(pg_column_size(t.*)), 0) + 24 AS "avgRowSize"
          FROM (
            SELECT * FROM "${tableName}" 
            WHERE "${tsColumn}" >= $1::timestamp AND "${tsColumn}" < $2::timestamp 
            LIMIT 1000
          ) t
        `, startDateStr, endDateStr);

        const avgRowSize = Number(sampleStats[0]?.avgRowSize || 24);
        const dailySizeBytes = Math.round(dailyRowCount * avgRowSize);

        await this.prisma.sysStorageHistory.upsert({
          where: { checkDate_tableName: { checkDate: checkDate, tableName: tableName } },
          update: { sizeBytes: dailySizeBytes, rowCount: dailyRowCount },
          create: { checkDate, tableName: tableName, sizeBytes: dailySizeBytes, rowCount: dailyRowCount, storageType: 'DB', createdAt: kstNow },
        });
      }
    } catch (error: any) {
      this.logger.error(`[DB Query Error] ${error.message}`);
    }
  }

  @Cron('0 5 0 * * *', { timeZone: 'Asia/Seoul' })
  async cleanupOldServerMetrics() {
    this.logger.log('Cleaning up old server metrics (> 30 days)...');
    try {
      const thirtyDaysAgo = this.getKstDate();
      thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
      
      const result = await (this.prisma as any).serverMetric.deleteMany({
        where: { createdAt: { lt: thirtyDaysAgo } }
      });
      this.logger.log(`Deleted ${result.count} old server metrics.`);
    } catch (error: any) {
      this.logger.error(`Failed to clean up old server metrics: ${error.message}`);
    }
  }

  async recordServerMetric(data: { serverId: string; cpu: number; memory: number; disk: number }) {
    try {
      return await (this.prisma as any).serverMetric.create({
        data: {
          serverId: data.serverId,
          cpu: data.cpu,
          memory: data.memory,
          disk: data.disk,
          createdAt: this.getKstDate(),
        },
      });
    } catch (error: any) {
      this.logger.error(`Failed to record server metric: ${error.message}`);
      return { success: false };
    }
  }

  async getLatestServerMetrics() {
    try {
      const latestMetrics: any[] = await this.prisma.$queryRaw`
        SELECT DISTINCT ON ("serverId")
          "serverId", "cpu", "memory", "disk", "createdAt"
        FROM "ServerMetric"
        ORDER BY "serverId", "createdAt" DESC
      `;

      const SERVER_SPECS: Record<string, { name: string; cpu: number; memory: number; disk: number; order: number }> = {
        'web-server': { name: 'Web Server', cpu: 8, memory: 32, disk: 100, order: 1 },
        'api-server': { name: 'API Server', cpu: 8, memory: 32, disk: 100, order: 2 },
        'dbaas_db_server': { name: 'DBaaS DB Server', cpu: 12, memory: 64, disk: 4000, order: 3 },
        'db-storage-server': { name: 'DB & Storage Server', cpu: 12, memory: 64, disk: 4000, order: 4 },
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
          order: spec.order,
          cpu: Number(metric.cpu.toFixed(1)),
          cpuDetails: `${usedCpu} vCPU / ${spec.cpu} vCPU`, 
          memory: Number(metric.memory.toFixed(1)),
          memoryDetails: `${usedMem} GB / ${spec.memory} GB`, 
          disk: Number(metric.disk.toFixed(1)),
          diskDetails: `${usedDisk} GB / ${spec.disk} GB`, 
        };
      });

      return result.sort((a, b) => a.order - b.order);
    } catch (error: any) {
      this.logger.error(`[Real Data Mode] Failed to fetch latest metrics: ${error.message}`);
      return []; 
    }
  }

  async getServerTrend(serverId: string, days: number = 30) {
    const targetDate = this.getKstDate();
    targetDate.setDate(targetDate.getDate() - days);

    try {
      const rawData = await (this.prisma as any).serverMetric.findMany({
        where: { serverId, createdAt: { gte: targetDate } },
        orderBy: { createdAt: 'asc' },
      });

      if (!rawData || rawData.length === 0) return { dates: [], cpu: [], memory: [], disk: [] };
      
      const dates = rawData.map(d => d.createdAt.toISOString());
      const cpu = rawData.map(d => Number(d.cpu.toFixed(1)));
      const memory = rawData.map(d => Number(d.memory.toFixed(1)));
      const disk = rawData.map(d => Number(d.disk.toFixed(1)));

      return { dates, cpu, memory, disk };
    } catch (error: any) {
      this.logger.error(`[Real Data Mode] Failed to fetch trend for ${serverId}: ${error.message}`);
      return { dates: [], cpu: [], memory: [], disk: [] };
    }
  }

  async getExceptionUsers() { return this.prisma.cfgUserException.findMany({ orderBy: { createdAt: 'desc' } }); }
  async addExceptionUser(data: { loginId: string; deptCode?: string; deptName?: string; registeredBy: string }) { return this.prisma.cfgUserException.create({ data: { loginId: data.loginId, deptCode: data.deptCode, deptName: data.deptName, isActive: 'Y', registeredBy: data.registeredBy, createdAt: this.getKstDate() } }); }
  async updateExceptionUserStatus(loginId: string, isActive: string) { return this.prisma.cfgUserException.update({ where: { loginId }, data: { isActive } }); }
  async deleteExceptionUser(loginId: string) { return this.prisma.cfgUserException.delete({ where: { loginId } }); }
  async getAllUsers() { const users = await this.prisma.sysUser.findMany({ include: { context: { include: { sdwtInfo: true } } }, orderBy: { lastLoginAt: 'desc' } }); const admins = await this.prisma.cfgAdminUser.findMany(); const guests = await this.prisma.cfgGuestAccess.findMany(); const adminMap = new Map(admins.map(a => [a.loginId, a.role])); const guestMap = new Map(guests.map(g => [g.loginId, g.grantedRole])); return users.map(u => { let role = 'USER'; if (adminMap.has(u.loginId)) { role = adminMap.get(u.loginId) || 'ADMIN'; } else if (guestMap.has(u.loginId)) { role = guestMap.get(u.loginId) || 'GUEST'; } return { ...u, role }; }); }
  async getAllAdmins() { return this.prisma.cfgAdminUser.findMany({ orderBy: { assignedAt: 'desc' } }); }
  async addAdmin(data: any) { return this.prisma.cfgAdminUser.create({ data: { loginId: data.loginId, role: data.role || 'MANAGER', assignedBy: data.assignedBy, assignedAt: this.getKstDate() } }); }
  async deleteAdmin(loginId: string) { return this.prisma.cfgAdminUser.delete({ where: { loginId } }); }
  async getAllAccessCodes() { return this.prisma.refAccessCode.findMany({ orderBy: { updatedAt: 'desc' }, select: { compid: true, compName: true, deptid: true, deptName: true, description: true, isActive: true, updatedAt: true }, }); }
  async createAccessCode(data: any) { return this.prisma.refAccessCode.create({ data: { compid: data.compid, compName: data.compName, deptid: data.deptid, deptName: data.deptName, description: data.description, isActive: 'Y', updatedAt: this.getKstDate() } }); }
  async updateAccessCode(deptid: string, data: any) { return this.prisma.refAccessCode.update({ where: { deptid }, data: { compid: data.compid, compName: data.compName, deptName: data.deptName, description: data.description, isActive: data.isActive, updatedAt: this.getKstDate() } }); }
  async deleteAccessCode(deptid: string) { return this.prisma.refAccessCode.delete({ where: { deptid } }); }
  async getAllGuests() { return this.prisma.cfgGuestAccess.findMany({ orderBy: { createdAt: 'desc' } }); }
  
  // 🌟 [수정된 부분] 수동 등록 시 프론트엔드에서 전달된 grantedRole 파라미터를 동적으로 받도록 수정
  async addGuest(data: any) { 
      return this.prisma.cfgGuestAccess.create({ 
          data: { 
              loginId: data.loginId, 
              deptCode: data.deptCode, 
              deptName: data.deptName, 
              reason: data.reason, 
              validUntil: new Date(data.validUntil), 
              grantedRole: data.grantedRole || 'GUEST', // 'GUEST' 하드코딩 제거, 동적 맵핑
              createdAt: this.getKstDate() 
          } 
      }); 
  }
  
  async deleteGuest(loginId: string) { return this.prisma.cfgGuestAccess.delete({ where: { loginId } }); }
  async getGuestRequests() { return this.prisma.cfgGuestRequest.findMany({ orderBy: { createdAt: 'desc' } }); }
  
  // 🌟 [수정된 부분] 게스트 승인 시 Controller에서 전달되는 Body 페이로드 객체 구조에 맞춰 grantedRole 파싱 및 수정
  async approveGuestRequest(reqId: number, payload: any) { 
      const request = await this.prisma.cfgGuestRequest.findUnique({ where: { reqId } }); 
      if (!request) throw new NotFoundException('Request not found'); 
      
      const approverId = typeof payload === 'string' ? payload : payload?.approverId;
      const grantedRole = payload?.grantedRole || 'GUEST'; // 'GUEST' 하드코딩 제거
      
      const kstNow = this.getKstDate(); 
      let validUntil = new Date(kstNow.getTime());
      if (payload?.validUntil) {
          validUntil = new Date(payload.validUntil);
      } else {
          validUntil.setDate(validUntil.getDate() + 30);
      }

      return this.prisma.$transaction(async (tx) => { 
          await tx.cfgGuestRequest.update({ 
              where: { reqId }, 
              data: { status: 'APPROVED', processedBy: approverId, processedAt: kstNow } 
          }); 
          return tx.cfgGuestAccess.upsert({ 
              where: { loginId: request.loginId }, 
              update: { validUntil: validUntil, reason: request.reason, grantedRole: grantedRole }, // 하드코딩 제거
              create: { loginId: request.loginId, deptCode: request.deptCode, deptName: request.deptName, reason: request.reason, grantedRole: grantedRole, validUntil: validUntil, createdAt: kstNow }, // 하드코딩 제거
          }); 
      }); 
  }

  async rejectGuestRequest(reqId: number, rejectorId: string) { return this.prisma.cfgGuestRequest.update({ where: { reqId }, data: { status: 'REJECTED', processedBy: rejectorId, processedAt: this.getKstDate() } }); }
  async getSeverities() { return this.prisma.errSeverityMap.findMany(); }
  async addSeverity(data: any) { return this.prisma.errSeverityMap.create({ data: { errorId: data.errorId, severity: data.severity } }); }
  async updateSeverity(errorId: string, data: any) { return this.prisma.errSeverityMap.update({ where: { errorId }, data: { severity: data.severity } }); }
  async deleteSeverity(errorId: string) { return this.prisma.errSeverityMap.delete({ where: { errorId } }); }
  async getMetrics() { return this.prisma.cfgLotUniformityMetrics.findMany(); }
  async addMetric(data: any) { return this.prisma.cfgLotUniformityMetrics.create({ data: { metricName: data.metricName, isExcluded: data.isExcluded ? 'Y' : 'N' } }); }
  async updateMetric(metricName: string, data: any) { return this.prisma.cfgLotUniformityMetrics.update({ where: { metricName }, data: { isExcluded: data.isExcluded ? 'Y' : 'N' } }); }
  async deleteMetric(metricName: string) { return this.prisma.cfgLotUniformityMetrics.delete({ where: { metricName } }); }
  async getNewServerConfig() { return this.prisma.cfgNewServer.findUnique({ where: { id: 1 } }); }
  async updateNewServerConfig(data: any) { return this.prisma.cfgNewServer.upsert({ where: { id: 1 }, update: { newDbHost: data.newDbHost, newDbUser: data.newDbUser, newDbPw: data.newDbPw, newDbPort: data.newDbPort ? parseInt(data.newDbPort) : 5432, newFtpHost: data.newFtpHost, newFtpUser: data.newFtpUser, newFtpPw: data.newFtpPw, newFtpPort: data.newFtpPort ? parseInt(data.newFtpPort) : 21, description: data.description }, create: { id: 1, newDbHost: data.newDbHost || '', newDbUser: data.newDbUser, newDbPw: data.newDbPw, newDbPort: data.newDbPort ? parseInt(data.newDbPort) : 5432, newFtpHost: data.newFtpHost || '', newFtpUser: data.newFtpUser, newFtpPw: data.newFtpPw, newFtpPort: data.newFtpPort ? parseInt(data.newFtpPort) : 21, description: data.description }, }); }
  async getCfgServers() { const servers = await this.prisma.cfgServer.findMany({ orderBy: { eqpid: 'asc' } }); if (!servers.length) return []; const eqpIds = servers.map(s => s.eqpid); const equipments = await this.prisma.refEquipment.findMany({ where: { eqpid: { in: eqpIds } }, select: { eqpid: true, sdwt: true, sdwtRel: { select: { site: true } } } }); const eqpMap = new Map(equipments.map(e => [e.eqpid, e])); return servers.map(server => { const eqp = eqpMap.get(server.eqpid); return { ...server, sdwt: eqp?.sdwt || '-', site: eqp?.sdwtRel?.site || '-' }; }); }
  async updateCfgServer(eqpid: string, data: any) { return this.prisma.cfgServer.update({ where: { eqpid }, data: { agentDbHost: data.agentDbHost, agentFtpHost: data.agentFtpHost, updateFlag: data.updateFlag } }); }
  async logAccess(data: { loginId: string; menuName: string; accessUrl: string }) { return this.prisma.sysAccessLog.create({ data: { loginId: data.loginId, menuName: data.menuName, accessUrl: data.accessUrl, accessTs: this.getKstDate(), }, }); }

  async syncStorageNow() {
    this.logger.log('Manual storage sync triggered by admin.');
    try {
      const now = new Date();
      const kstTime = new Date(now.getTime() + 9 * 60 * 60 * 1000);
      const kstYesterday = new Date(kstTime.getTime() - 24 * 60 * 60 * 1000);
      
      const yYear = kstYesterday.getUTCFullYear();
      const yMonth = kstYesterday.getUTCMonth();
      const yDate = kstYesterday.getUTCDate();
      
      const checkDate = new Date(Date.UTC(yYear, yMonth, yDate));
      
      const pad = (n: number) => String(n).padStart(2, '0');
      const formattedDate = `${yYear}-${pad(yMonth + 1)}-${pad(yDate)}`;

      const existingCount = await this.prisma.sysStorageHistory.count({
        where: { checkDate: checkDate }
      });

      if (existingCount > 0) {
        this.logger.log(`[Manual Sync] Skipped. Data for ${formattedDate} already exists.`);
        return { success: false, message: `이미 전일(${formattedDate}) 데이터가 존재합니다. 동기화를 중단합니다.` };
      }

      await this.recordDailyStorageSize();

      return { success: true, message: `수동 스토리지 동기화가 완료되었습니다. (${formattedDate} 정상 적재)` };
    } catch (error: any) {
      this.logger.error(`[Manual Sync Error] ${error.message}`);
      return { success: false, message: `수동 동기화 중 오류가 발생했습니다: ${error.message}` };
    }
  }

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

  async getStorageUsage(startDate: string, endDate: string, interval: string) {
    const start = new Date(`${startDate}T00:00:00.000Z`);
    const end = new Date(`${endDate}T23:59:59.999Z`);

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

    // [1. Daily Trends] - startDate와 endDate 필터 범위 기준
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
      }
    } catch (error: any) {
      this.logger.error(`[Daily Trends Query Error] ${error.message}`);
    }

    // [2. Monthly Trends] - 당월 포함 최대 12개월 (단, 최초 적재월 이전의 빈 데이터는 제외)
    try {
      const kstNow = this.getKstDate();
      const mYear = kstNow.getUTCFullYear();
      const mMonth = kstNow.getUTCMonth();

      const defaultStartDate = new Date(Date.UTC(mYear, mMonth - 11, 1));
      const monthlyEndDate = new Date(Date.UTC(mYear, mMonth + 1, 0, 23, 59, 59, 999));

      const oldestRecord = await this.prisma.sysStorageHistory.findFirst({
        orderBy: { checkDate: 'asc' },
        select: { checkDate: true }
      });

      let displayStartDate = defaultStartDate;
      if (!oldestRecord) {
        displayStartDate = new Date(Date.UTC(mYear, mMonth, 1));
      } else if (oldestRecord.checkDate > defaultStartDate) {
        const oYear = oldestRecord.checkDate.getUTCFullYear();
        const oMonth = oldestRecord.checkDate.getUTCMonth();
        displayStartDate = new Date(Date.UTC(oYear, oMonth, 1));
      }

      const mHistories = await this.prisma.sysStorageHistory.findMany({
        where: { checkDate: { gte: displayStartDate, lte: monthlyEndDate } },
        orderBy: { checkDate: 'asc' }
      });

      const mPrevObjSum = await this.prisma.sysStorageHistory.aggregate({
        _sum: { sizeBytes: true },
        where: { storageType: 'FILE', checkDate: { lt: displayStartDate } }
      });
      const mPrevDbSum = await this.prisma.sysStorageHistory.aggregate({
        _sum: { sizeBytes: true },
        where: { storageType: 'DB', checkDate: { lt: displayStartDate } }
      });

      let mCumObjMB = Number(mPrevObjSum._sum.sizeBytes || 0) / (1024 * 1024);
      let mCumDbMB = Number(mPrevDbSum._sum.sizeBytes || 0) / (1024 * 1024);

      const mDateMap = new Map<string, { dbMB: number, objMB: number }>();

      let currentMonthCursor = new Date(displayStartDate.getTime());
      const endMonthTime = new Date(Date.UTC(mYear, mMonth, 1)).getTime();

      while (currentMonthCursor.getTime() <= endMonthTime) {
        const yyyy = currentMonthCursor.getUTCFullYear();
        const mm = String(currentMonthCursor.getUTCMonth() + 1).padStart(2, '0');
        mDateMap.set(`${yyyy}-${mm}`, { dbMB: 0, objMB: 0 });
        currentMonthCursor.setUTCMonth(currentMonthCursor.getUTCMonth() + 1);
      }

      mHistories.forEach(h => {
        const dateStr = h.checkDate.toISOString().substring(0, 7); 
        if (mDateMap.has(dateStr)) {
          const data = mDateMap.get(dateStr)!;
          if (h.storageType === 'FILE') {
            data.objMB += Number(h.sizeBytes) / (1024 * 1024);
          } else {
            data.dbMB += Number(h.sizeBytes) / (1024 * 1024);
          }
        }
      });

      mDateMap.forEach((data, monthStr) => {
        mCumDbMB += data.dbMB;
        mCumObjMB += data.objMB;
        monthlyTrends.push({
          date: monthStr,
          cumDbMB: mCumDbMB,
          cumObjMB: mCumObjMB,
          monthlyDbMB: data.dbMB,
          monthlyObjMB: data.objMB
        });
      });

    } catch (error: any) {
      this.logger.error(`[Monthly Trends Query Error] ${error.message}`);
    }

    return { summary: { totalDbUsageMB, totalObjectStorageMB, serverCapacityMB }, tableDetails, dailyTrends, monthlyTrends };
  }
}
