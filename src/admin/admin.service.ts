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

  // 밀리초를 절사한 한국 시간 생성
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
        if (res.statusCode && (res.statusCode < 200 || res.statusCode >= 300)) return reject(new Error(`Status: ${res.statusCode}`));
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => { try { resolve(JSON.parse(data)); } catch (e) { reject(new Error('Invalid JSON')); } });
      });
      req.on('error', reject);
      req.setTimeout(5000, () => { req.destroy(); reject(new Error('Timeout')); });
    });
  }

  // =======================================================================
  // [스케줄러] 매일 00:01에 어제 하루 동안의 "순증가량(Incremental)"만 기록
  // =======================================================================
  @Cron('0 1 0 * * *', { timeZone: 'Asia/Seoul' })
  async recordDailyStorageSize() {
    this.logger.log('Starting daily incremental storage recording...');
    const kstNow = this.getKstDate();
    const yesterday = new Date(Date.UTC(kstNow.getFullYear(), kstNow.getMonth(), kstNow.getDate() - 1));
    const yesterdayStr = yesterday.toISOString().split('T')[0];

    // 1. 오브젝트 스토리지 순증가량 계산
    try {
      const uploadApiUrl = process.env.UPLOAD_API_URL || 'http://127.0.0.1:8082';
      const data = await this.fetchUploadApiSize(`${uploadApiUrl}/api/FileUpload/size`);

      if (data && data.success) {
        const currentTotalBytes = Number(data.sizeBytes);
        
        // 바로 전날까지의 누적 합계를 가져와서 빼기 (순수 어제 증가분 계산)
        const prevTotal = await this.prisma.sysStorageHistory.aggregate({
          where: { storageType: 'FILE', checkDate: { lt: yesterday } },
          _sum: { sizeBytes: true }
        });
        const incrementalBytes = Math.max(0, currentTotalBytes - Number(prevTotal._sum.sizeBytes || 0));

        await this.prisma.sysStorageHistory.upsert({
          where: { checkDate_tableName: { checkDate: yesterday, tableName: 'OBJECT_STORE_TOTAL' } },
          update: { sizeBytes: incrementalBytes },
          create: { checkDate: yesterday, tableName: 'OBJECT_STORE_TOTAL', sizeBytes: incrementalBytes, storageType: 'FILE', createdAt: kstNow },
        });
      }
    } catch (e) { this.logger.error(`File incremental recording failed: ${e.message}`); }

    // 2. DB 테이블별 어제 하루 순증가량 계산
    try {
      const dbTables: any[] = await this.prisma.$queryRaw`
        SELECT c.relname as "tableName", 
               COALESCE(c.reltuples::bigint, 0) as "totalRows",
               COALESCE(pg_total_relation_size(c.oid), 0) as "totalBytes"
        FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relkind = 'r' AND c.relname != 'sys_storage_history'
      `;

      for (const t of dbTables) {
        const avgSize = Number(t.totalRows) > 0 ? Number(t.totalBytes) / Number(t.totalRows) : 0;
        
        // 테이블 내 시간 컬럼 찾기
        const cols: any[] = await this.prisma.$queryRaw`
          SELECT column_name FROM information_schema.columns 
          WHERE table_name = ${t.tableName} AND column_name IN ('serv_ts', 'access_ts', 'created_at', 'ts', 'datetime') LIMIT 1
        `;

        let incrementalRows = 0;
        if (cols.length > 0) {
          const timeCol = cols[0].column_name;
          const result: any[] = await this.prisma.$queryRawUnsafe(`
            SELECT COUNT(*)::int as count FROM public."${t.tableName}"
            WHERE "${timeCol}" >= '${yesterdayStr} 00:00:00' AND "${timeCol}" <= '${yesterdayStr} 23:59:59'
          `);
          incrementalRows = result[0].count;
        }

        const incrementalBytes = Math.round(incrementalRows * avgSize);

        await this.prisma.sysStorageHistory.upsert({
          where: { checkDate_tableName: { checkDate: yesterday, tableName: t.tableName } },
          update: { sizeBytes: incrementalBytes, rowCount: incrementalRows },
          create: { checkDate: yesterday, tableName: t.tableName, sizeBytes: incrementalBytes, rowCount: incrementalRows, storageType: 'DB', createdAt: kstNow },
        });
      }
      this.logger.log(`DB incremental recording complete for ${yesterdayStr}`);
    } catch (e) { this.logger.error(`DB incremental recording failed: ${e.message}`); }
  }

  // =======================================================================
  // [조회 API] 일별 데이터는 그대로, 누적 데이터는 SUM()으로 계산하여 리턴
  // =======================================================================
  async getStorageUsage(startDate: string, endDate: string, interval: string) {
    const start = new Date(`${startDate}T00:00:00.000Z`);
    const end = new Date(`${endDate}T23:59:59.999Z`);

    // 1. 실시간 현재 총량 (카드용)
    let totalDbUsageMB = 0;
    const dbTables: any[] = await this.prisma.$queryRaw`
      SELECT c.relname as "tableName", COALESCE(pg_total_relation_size(c.oid), 0) as "sizeBytes", COALESCE(c.reltuples::bigint, 0) as "rowCount"
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relkind = 'r' ORDER BY 2 DESC
    `;
    const tableDetails = dbTables.map(t => {
      const sizeMB = Number(t.sizeBytes) / (1024 * 1024);
      totalDbUsageMB += sizeMB;
      const isDynamic = t.tableName.startsWith('plg_') || t.tableName.startsWith('eqp_');
      return { tableName: t.tableName, type: isDynamic ? 'Dynamic' : 'Static', rowCount: Number(t.rowCount), sizeMB };
    });

    let totalObjectStorageMB = 0;
    try {
      const uploadApiUrl = process.env.UPLOAD_API_URL || 'http://127.0.0.1:8082';
      const data = await this.fetchUploadApiSize(`${uploadApiUrl}/api/FileUpload/size`);
      if (data && data.success) totalObjectStorageMB = Number(data.sizeBytes) / (1024 * 1024);
    } catch (e) {
      const latest = await this.prisma.sysStorageHistory.aggregate({ where: { storageType: 'FILE' }, _sum: { sizeBytes: true } });
      totalObjectStorageMB = Number(latest._sum.sizeBytes || 0) / (1024 * 1024);
    }

    // 2. 차트 데이터 가공 (누적치는 SUM으로, 일별은 그대로)
    const dailyTrends: any[] = [];
    const histories = await this.prisma.sysStorageHistory.findMany({ where: { checkDate: { lte: end } }, orderBy: { checkDate: 'asc' } });

    const dateGroup = new Map<string, { dailyDb: number, dailyObj: number }>();
    histories.forEach(h => {
      const d = h.checkDate.toISOString().split('T')[0];
      if (!dateGroup.has(d)) dateGroup.set(d, { dailyDb: 0, dailyObj: 0 });
      const g = dateGroup.get(d);
      if (h.storageType === 'FILE') g.dailyObj += Number(h.sizeBytes);
      else g.dailyDb += Number(h.sizeBytes);
    });

    let cumDb = 0; let cumObj = 0;
    const sortedDates = Array.from(dateGroup.keys()).sort();
    sortedDates.forEach(d => {
      const vals = dateGroup.get(d);
      cumDb += vals.dailyDb;
      cumObj += vals.dailyObj;
      if (new Date(d) >= start) {
        dailyTrends.push({ 
          date: d, 
          dailyDbMB: vals.dailyDb / (1024 * 1024), 
          dailyObjMB: vals.dailyObj / (1024 * 1024),
          cumDbMB: cumDb / (1024 * 1024),
          cumObjMB: cumObj / (1024 * 1024)
        });
      }
    });

    return { summary: { totalDbUsageMB, totalObjectStorageMB }, tableDetails, dailyTrends, monthlyTrends: [] };
  }

  async syncStorageNow() { await this.recordDailyStorageSize(); return { success: true }; }
  
  // ... 기존 유저/로그/서버 설정 관련 메서드들 (이전과 동일하게 유지) ...
}
