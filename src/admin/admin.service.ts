// ITM-Data-API_v1/src/admin/admin.service.ts
import { Injectable, NotFoundException, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma.service';
import { Prisma } from '@prisma/client';
import { Cron } from '@nestjs/schedule';
import * as http from 'http';
import * as https from 'https';

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
      
      // 스토리지 계산 지연에 대비해 타임아웃을 60초(60000ms)로 연장
      req.setTimeout(60000, () => {
        req.destroy();
        reject(new Error('Request timeout (60s)'));
      });
    });
  }

  @Cron('0 1 0 * * *', { timeZone: 'Asia/Seoul' })
  async recordDailyStorageSize() {
    this.logger.log('Starting daily storage size recording (Cron)...');
    const kstNow = this.getKstDate();
    // 기록 대상일 (예: 오늘 자정이면 어제 날짜)
    const checkDate = new Date(Date.UTC(kstNow.getFullYear(), kstNow.getMonth(), kstNow.getDate() - 1));

    // 1. 오브젝트 스토리지 (파일) 용량 기록 로직 (일일 증가량 계산)
    try {
      const uploadApiUrl = process.env.UPLOAD_API_URL || 'http://127.0.0.1:8082';
      const targetUrl = `${uploadApiUrl}/api/FileUpload/size`;
      
      const data = await this.fetchUploadApiSize(targetUrl);

      if (data && data.success) {
        const currentTotalBytes = Number(data.sizeBytes); 
        const sumResult = await this.prisma.sysStorageHistory.aggregate({
          _sum: { sizeBytes: true },
          where: { storageType: 'FILE' }
        });
        const previousTotalBytes = Number(sumResult._sum.sizeBytes || 0);
        const dailyIncrementBytes = currentTotalBytes - previousTotalBytes;

        await this.prisma.sysStorageHistory.upsert({
          where: { checkDate_tableName: { checkDate: checkDate, tableName: 'OBJECT_STORE_TOTAL' } },
          update: { sizeBytes: dailyIncrementBytes },
          create: { checkDate, tableName: 'OBJECT_STORE_TOTAL', sizeBytes: dailyIncrementBytes, storageType: 'FILE', createdAt: kstNow },
        });
      }
    } catch (error: any) {
      this.logger.error(`[Upload API Error] Failed to connect: ${error.message}`);
    }

    // 2. [수정됨] DB 용량 기록 로직 (특정 일자의 증가분만 정확하게 계산)
    try {
      // 해당 테이블의 타임스탬프 컬럼명도 함께 추출합니다.
      const dbTables: any[] = await this.prisma.$queryRaw`
        SELECT
          c.relname AS "tableName",
          (
            SELECT col.column_name
            FROM information_schema.columns col
            WHERE col.table_schema = n.nspname
              AND col.table_name = c.relname
              AND col.column_name IN ('serv_ts', 'access_ts', 'created_at', 'ts', 'datetime', 'time_stamp')
            LIMIT 1
          ) AS "tsColumn"
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relkind = 'r'
          AND EXISTS (
            SELECT 1 
            FROM information_schema.columns col 
            WHERE col.table_schema = n.nspname 
              AND col.table_name = c.relname 
              AND col.column_name IN ('serv_ts', 'access_ts', 'created_at', 'ts', 'datetime', 'time_stamp')
          )
      `;

      // 하루 간격을 구하기 위해 nextDate 설정
      const nextDate = new Date(checkDate.getTime() + 24 * 60 * 60 * 1000);

      for (const t of dbTables) {
        const tableName = String(t.tableName);
        const tsColumn = String(t.tsColumn);

        if (!tableName || !tsColumn) continue;

        // [핵심] checkDate 하루 동안 생성된 row의 개수와, 실제 row 들의 물리적 Byte 크기를 합산합니다.
        const dailyStats: any[] = await this.prisma.$queryRawUnsafe(`
          SELECT
            COUNT(*)::bigint AS "dailyRowCount",
            COALESCE(SUM(pg_column_size(t.*)), 0)::bigint AS "dailySizeBytes"
          FROM "${tableName}" t
          WHERE "${tsColumn}" >= $1 AND "${tsColumn}" < $2
        `, checkDate, nextDate);

        const dailyRowCount = Number(dailyStats[0]?.dailyRowCount || 0);
        const dailySizeBytes = Number(dailyStats[0]?.dailySizeBytes || 0);

        // 이제 전체 누적이 아닌 "일일 증가량(Increment)" 이 기록됩니다.
        await this.prisma.sysStorageHistory.upsert({
          where: { checkDate_tableName: { checkDate: checkDate, tableName: tableName } },
          update: { sizeBytes: dailySizeBytes, rowCount: dailyRowCount },
          create: {
            checkDate,
            tableName: tableName,
            sizeBytes: dailySizeBytes,
            rowCount: dailyRowCount,
            storageType: 'DB',
            createdAt: kstNow,
          },
        });
      }
    } catch (error: any) {
      this.logger.error(`[DB Query Error] ${error.message}`);
    }
  }

  async getStorageUsage(startDate: string, endDate: string, interval: string) {
    const start = new Date(`${startDate}T00:00:00.000Z`);
    const end = new Date(`${endDate}T23:59:59.999Z`);

    let totalDbUsageMB = 0;
    let tableDetails: any[] = [];
    
    // 테이블 요약은 현재 시점의 전체 용량이 맞으므로 기존 로직 유지
    try {
      const dbTables: any[] = await this.prisma.$queryRaw`
        SELECT
          c.relname AS "tableName",
          COALESCE(c.reltuples::bigint, 0) AS "rowCount",
          COALESCE(pg_total_relation_size(c.oid), 0) AS "sizeBytes"
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relkind = 'r'
          AND EXISTS (
            SELECT 1 
            FROM information_schema.columns col 
            WHERE col.table_schema = n.nspname 
              AND col.table_name = c.relname 
              AND col.column_name IN ('serv_ts', 'access_ts', 'created_at', 'ts', 'datetime', 'time_stamp')
          )
        ORDER BY pg_total_relation_size(c.oid) DESC
      `;

      tableDetails = dbTables.map((t) => {
        const sizeMB = Number(t.sizeBytes || 0) / (1024 * 1024);
        totalDbUsageMB += sizeMB;
        const tableName = String(t.tableName || '');
        const isDynamic = tableName.startsWith('plg_') || tableName.startsWith('eqp_') || tableName.startsWith('sys_') || tableName.startsWith('cfg_');
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
      let runningCumDbMB = 0; // [수정됨] DB 데이터도 증가분이므로 누적 변수 추가

      if (trendDates.length > 0) {
        const firstDate = new Date(trendDates[0]);
        firstDate.setUTCDate(firstDate.getUTCDate() - 1); 

        // 과거 누적 합산 (Object)
        const prevObjSum = await this.prisma.sysStorageHistory.aggregate({
          _sum: { sizeBytes: true },
          where: { storageType: 'FILE', checkDate: { lte: firstDate } }
        });
        runningCumObjMB = Number(prevObjSum._sum.sizeBytes || 0) / (1024 * 1024);

        // 과거 누적 합산 (DB)
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

        // DB 역시 이제 일일 증가량(Increment) 데이터입니다.
        const dailyDbMB = current.dbBytes / (1024 * 1024); 
        const dailyObjMB = current.objBytes / (1024 * 1024); 

        runningCumObjMB += dailyObjMB; 
        runningCumDbMB += dailyDbMB; // 매일의 데이터를 누적시킴

        dailyTrends.push({ 
          date, 
          cumDbMB: runningCumDbMB,  // [수정됨] 올바른 누적값 매핑
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

    return { summary: { totalDbUsageMB, totalObjectStorageMB }, tableDetails, dailyTrends, monthlyTrends };
  }

  async getExceptionUsers() {
    return this.prisma.cfgUserException.findMany({ orderBy: { createdAt: 'desc' } });
  }

  async addExceptionUser(data: { loginId: string; deptCode?: string; deptName?: string; registeredBy: string }) {
    return this.prisma.cfgUserException.create({
      data: {
        loginId: data.loginId,
        deptCode: data.deptCode,
        deptName: data.deptName,
        isActive: 'Y',
        registeredBy: data.registeredBy, 
        createdAt: this.getKstDate()
      }
    });
  }

  async updateExceptionUserStatus(loginId: string, isActive: string) {
    return this.prisma.cfgUserException.update({
      where: { loginId },
      data: { isActive }
    });
  }

  async deleteExceptionUser(loginId: string) {
    return this.prisma.cfgUserException.delete({ where: { loginId } });
  }

  async getAllUsers() { 
    const users = await this.prisma.sysUser.findMany({ 
      include: { context: { include: { sdwtInfo: true } } }, 
      orderBy: { lastLoginAt: 'desc' }
    }); 

    const admins = await this.prisma.cfgAdminUser.findMany();
    const guests = await this.prisma.cfgGuestAccess.findMany();

    const adminMap = new Map(admins.map(a => [a.loginId, a.role]));
    const guestMap = new Map(guests.map(g => [g.loginId, g.grantedRole]));

    return users.map(u => {
      let role = 'USER'; 
      if (adminMap.has(u.loginId)) {
        role = adminMap.get(u.loginId) || 'ADMIN';
      } else if (guestMap.has(u.loginId)) {
        role = guestMap.get(u.loginId) || 'GUEST';
      }

      return {
        ...u,
        role
      };
    });
  }

  async getAllAdmins() { return this.prisma.cfgAdminUser.findMany({ orderBy: { assignedAt: 'desc' } }); }
  async addAdmin(data: any) { return this.prisma.cfgAdminUser.create({ data: { loginId: data.loginId, role: data.role || 'MANAGER', assignedBy: data.assignedBy, assignedAt: this.getKstDate() } }); }
  async deleteAdmin(loginId: string) { return this.prisma.cfgAdminUser.delete({ where: { loginId } }); }
  async getAllAccessCodes() { return this.prisma.refAccessCode.findMany({ orderBy: { updatedAt: 'desc' }, select: { compid: true, compName: true, deptid: true, deptName: true, description: true, isActive: true, updatedAt: true }, }); }
  async createAccessCode(data: any) { return this.prisma.refAccessCode.create({ data: { compid: data.compid, compName: data.compName, deptid: data.deptid, deptName: data.deptName, description: data.description, isActive: 'Y', updatedAt: this.getKstDate() } }); }
  async updateAccessCode(deptid: string, data: any) { return this.prisma.refAccessCode.update({ where: { deptid }, data: { compid: data.compid, compName: data.compName, deptName: data.deptName, description: data.description, isActive: data.isActive, updatedAt: this.getKstDate() } }); }
  async deleteAccessCode(deptid: string) { return this.prisma.refAccessCode.delete({ where: { deptid } }); }
  async getAllGuests() { return this.prisma.cfgGuestAccess.findMany({ orderBy: { createdAt: 'desc' } }); }
  async addGuest(data: any) { return this.prisma.cfgGuestAccess.create({ data: { loginId: data.loginId, deptCode: data.deptCode, deptName: data.deptName, reason: data.reason, validUntil: new Date(data.validUntil), grantedRole: 'GUEST', createdAt: this.getKstDate() } }); }
  async deleteGuest(loginId: string) { return this.prisma.cfgGuestAccess.delete({ where: { loginId } }); }
  async getGuestRequests() { return this.prisma.cfgGuestRequest.findMany({ orderBy: { createdAt: 'desc' } }); }
  async approveGuestRequest(reqId: number, approverId: string) { const request = await this.prisma.cfgGuestRequest.findUnique({ where: { reqId } }); if (!request) throw new NotFoundException('Request not found'); const kstNow = this.getKstDate(); const validUntil = new Date(kstNow.getTime()); validUntil.setDate(validUntil.getDate() + 30); return this.prisma.$transaction(async (tx) => { await tx.cfgGuestRequest.update({ where: { reqId }, data: { status: 'APPROVED', processedBy: approverId, processedAt: kstNow } }); return tx.cfgGuestAccess.upsert({ where: { loginId: request.loginId }, update: { validUntil: validUntil, reason: request.reason, grantedRole: 'GUEST' }, create: { loginId: request.loginId, deptCode: request.deptCode, deptName: request.deptName, reason: request.reason, grantedRole: 'GUEST', validUntil: validUntil, createdAt: kstNow }, }); }); }
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
}
