// ITM-Data-API/src/wafer/wafer.service.ts
import {
  Injectable,
  InternalServerErrorException,
  NotFoundException,
  Logger,
} from '@nestjs/common';
import { PrismaService } from '../prisma.service';
import { Prisma } from '@prisma/client';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { execFile } from 'child_process';
import { promisify } from 'util';
import axios from 'axios';
import { Readable } from 'stream';

const execFileAsync = promisify(execFile);

export class WaferQueryParams {
  eqpId?: string;
  lotId?: string;
  waferId?: string | number;
  startDate?: string | Date;
  endDate?: string | Date;
  cassetteRcp?: string;
  stageRcp?: string;
  stageGroup?: string;
  film?: string;
  page?: string | number;
  pageSize?: string | number;
  servTs?: string | Date;
  ts?: string | Date;
  dateTime?: string | Date;
  pointNumber?: string | number;
  pointId?: string;
  waferIds?: string;
  metric?: string;
  site?: string;
  sdwt?: string;
  targetEqps?: string;
}

interface StatsRawResult {
  [key: string]: number | null;
}

interface PdfResult {
  file_uri: string;
  datetime: Date;
  original_filename?: string;
}

export interface GoldenSpectrumResponse {
  wavelengths: number[];
  values: number[];
}

export interface SpectrumRawResult {
  class: string;
  wavelengths: number[];
  values: number[];
  ts?: Date;
}

interface SpectrumTrendJoinedResult {
  waferid: string;
  eqpid: string;
  wavelengths: number[];
  values: number[];
  serv_ts: Date | null;
  ts: Date | null;
  [key: string]: any;
}

export interface ResidualRawResult {
  point: number;
  x: number | null;
  y: number | null;
  class: string;
  values: number[];
}

export interface GoldenRawResult {
  wavelengths: number[];
  values: number[];
}

export interface ResidualMapItem {
  point: number;
  x: number;
  y: number;
  residual: number;
}

export interface ComparisonRawResult {
  eqpid: string;
  lotid: string;
  waferid: number;
  point: number;
  [key: string]: string | number | null;
}

interface OpticalTrendRawResult {
  ts: Date;
  lotid: string;
  waferid: string;
  point: number;
  wavelengths: number[];
  values: number[];
}

@Injectable()
export class WaferService {
  private readonly logger = new Logger(WaferService.name);

  constructor(private prisma: PrismaService) {}

  private getSafeDates(start?: string | Date, end?: string | Date): { startDate: Date, endDate: Date } {
    const now = new Date();
    
    // 시작일: 입력값 또는 7일 전
    let startDate = start ? new Date(start) : new Date();
    if (isNaN(startDate.getTime()) || !start) {
        startDate = new Date();
        startDate.setDate(startDate.getDate() - 7);
    }
    startDate.setHours(0, 0, 0, 0);

    // 종료일: 입력값 또는 오늘
    let endDate = end ? new Date(end) : now;
    if (isNaN(endDate.getTime())) {
        endDate = now;
    }
    endDate.setHours(23, 59, 59, 999);

    return { startDate, endDate };
  }

  // [핵심] 날짜 포맷을 DB가 선호하는 Short Year (YY-MM-DD) 형식으로 변환
  // 예: "2026-01-28 09:17:25" -> "26-01-28 09:17:25"
  private toShortYearDate(dateVal: string | Date): string {
    if (!dateVal) return '';
    let dateStr = typeof dateVal === 'string' ? dateVal : dateVal.toISOString();
    
    // ISO 포맷 정리 (T, Z 제거)
    dateStr = dateStr.replace('T', ' ').replace('Z', '');

    // 20YY-MM-DD 형태로 시작하면 앞의 '20'을 제거하여 'YY-MM-DD'로 만듦
    // 정규식: 20으로 시작하고 뒤에 숫자 2개(연도)-숫자2개(월)-숫자2개(일) 패턴
    if (/^20\d{2}-\d{2}-\d{2}/.test(dateStr)) {
        return dateStr.substring(2);
    }
    return dateStr;
  }

  async getDistinctValues(
    column: string,
    params: WaferQueryParams,
  ): Promise<string[]> {
    const { eqpId, lotId, cassetteRcp, stageGroup, film, startDate, endDate } =
      params;

    const table = 'public.plg_wf_flat';
    let colName = column;

    if (column === 'lotids') colName = 'lotid';
    if (column === 'cassettercps') colName = 'cassettercp';
    if (column === 'stagercps' || column === 'stageRcps') colName = 'stagercp';
    if (column === 'stagegroups') colName = 'stagegroup';
    if (column === 'films') colName = 'film';
    if (column === 'waferids') colName = 'waferid';

    let whereClause = `WHERE 1=1`;
    const queryParams: (string | number | Date)[] = [];

    if (eqpId) {
      whereClause += ` AND eqpid = $${queryParams.length + 1}`;
      queryParams.push(eqpId);
    }
    if (lotId && colName !== 'lotid') {
      whereClause += ` AND lotid = $${queryParams.length + 1}`;
      queryParams.push(lotId);
    }
    if (cassetteRcp && colName !== 'cassettercp') {
      whereClause += ` AND cassettercp = $${queryParams.length + 1}`;
      queryParams.push(cassetteRcp);
    }
    if (stageGroup && colName !== 'stagegroup') {
      whereClause += ` AND stagegroup = $${queryParams.length + 1}`;
      queryParams.push(stageGroup);
    }
    if (film && colName !== 'film') {
      whereClause += ` AND film = $${queryParams.length + 1}`;
      queryParams.push(film);
    }

    if (!lotId && startDate && endDate) {
      const { startDate: s, endDate: e } = this.getSafeDates(startDate, endDate);
      whereClause += ` AND serv_ts >= $${queryParams.length + 1} AND serv_ts <= $${queryParams.length + 2}`;
      queryParams.push(s, e);
    }

    const sql = `SELECT DISTINCT "${colName}" as val FROM ${table} ${whereClause} ORDER BY "${colName}" DESC LIMIT 5000`;

    try {
      const result = await this.prisma.$queryRawUnsafe<{ val: unknown }[]>(
        sql,
        ...queryParams,
      );
      return result
        .map((r) => {
          if (r.val === null || r.val === undefined) return '';
          if (typeof r.val === 'object') return JSON.stringify(r.val);
          return String(r.val);
        })
        .filter((v) => v !== '');
    } catch (e) {
      this.logger.warn(`Error fetching distinct ${column}:`, e);
      return [];
    }
  }

  async getDistinctPoints(params: WaferQueryParams): Promise<string[]> {
    const { eqpId, lotId, cassetteRcp, stageRcp, stageGroup, film, startDate, endDate } = params;

    let sql = `
      SELECT DISTINCT s.point
      FROM public.plg_onto_spectrum s
      JOIN public.plg_wf_flat f 
        ON TRIM(s.eqpid) = TRIM(f.eqpid)
        AND TRIM(s.lotid) = TRIM(f.lotid)
        AND s.waferid::integer = f.waferid
        AND s.point = f.point
      WHERE 1=1
    `;

    const queryParams: (string | number | Date)[] = [];

    if (eqpId) {
      sql += ` AND s.eqpid = $${queryParams.length + 1}`;
      queryParams.push(eqpId);
    }
    if (lotId) {
      sql += ` AND s.lotid = $${queryParams.length + 1}`;
      queryParams.push(lotId);
    }
    if (cassetteRcp) {
      sql += ` AND f.cassettercp = $${queryParams.length + 1}`;
      queryParams.push(cassetteRcp);
    }
    if (stageRcp) {
      sql += ` AND f.stagercp = $${queryParams.length + 1}`;
      queryParams.push(stageRcp);
    }
    if (stageGroup) {
      sql += ` AND f.stagegroup = $${queryParams.length + 1}`;
      queryParams.push(stageGroup);
    }
    if (film) {
      sql += ` AND f.film = $${queryParams.length + 1}`;
      queryParams.push(film);
    }

    if (!lotId && startDate && endDate) {
      const { startDate: s, endDate: e } = this.getSafeDates(startDate, endDate);
      sql += ` AND s.ts >= $${queryParams.length + 1} AND s.ts <= $${queryParams.length + 2}`;
      queryParams.push(s, e);
    }

    sql += ` ORDER BY s.point ASC`;

    try {
      const results = await this.prisma.$queryRawUnsafe<{ point: number }[]>(
        sql,
        ...queryParams,
      );
      return results.map((r) => String(r.point));
    } catch (e) {
      this.logger.error('Error fetching distinct points:', e);
      return [];
    }
  }

  async getSpectrumTrend(params: WaferQueryParams): Promise<any[]> {
    const {
      eqpId,
      lotId,
      pointId,
      waferIds,
      startDate,
      endDate,
      cassetteRcp,
      stageRcp,
      stageGroup,
      film,
    } = params;

    if (!lotId || !pointId || !waferIds) {
      return [];
    }

    const waferIdList = waferIds.split(',').map((w) => w.trim());
    if (waferIdList.length === 0) return [];

    let dynamicColumns: string[] = ['t1', 'gof', 'mse'];
    try {
      const configMetrics = await this.prisma.$queryRaw<
        { metric_name: string }[]
      >`
        SELECT metric_name FROM public.cfg_lot_uniformity_metrics WHERE is_excluded = 'N'
      `;
      if (configMetrics.length > 0) {
        dynamicColumns = configMetrics.map((r) => r.metric_name);
      }
    } catch (e) {
      this.logger.warn(
        'Failed to fetch dynamic metrics config, using defaults.',
        e,
      );
    }

    if (!dynamicColumns.includes('gof')) dynamicColumns.push('gof');
    dynamicColumns = [...new Set(dynamicColumns)];

    const queryParams: (string | number | Date)[] = [];
    const selectColumns = dynamicColumns.map((col) => `f."${col}"`).join(', ');

    let sql = `
      SELECT DISTINCT ON (s."waferid")
        s."waferid", s."wavelengths", s."values", s."ts", s."eqpid",
        f."serv_ts", f."lotid",
        ${selectColumns}
      FROM public.plg_onto_spectrum s
      JOIN public.plg_wf_flat f 
        ON TRIM(s.lotid) = TRIM(f.lotid) 
        AND s.waferid::integer = f."waferid"
        AND s."point" = f."point"
      WHERE s."lotid" = $1
        AND s."point" = $2
        AND s."class" = 'EXP'
    `;
    queryParams.push(lotId, Number(pointId));

    if (cassetteRcp) {
      sql += ` AND f."cassettercp" = $${queryParams.length + 1}`;
      queryParams.push(cassetteRcp);
    }
    if (stageRcp) {
      sql += ` AND f."stagercp" = $${queryParams.length + 1}`;
      queryParams.push(stageRcp);
    }
    if (stageGroup) {
      sql += ` AND f."stagegroup" = $${queryParams.length + 1}`;
      queryParams.push(stageGroup);
    }
    if (film) {
      sql += ` AND f."film" = $${queryParams.length + 1}`;
      queryParams.push(film);
    }
    if (eqpId) {
      sql += ` AND s."eqpid" = $${queryParams.length + 1}`;
      queryParams.push(eqpId);
    }

    const waferParams = waferIdList
      .map((_, idx) => `$${queryParams.length + 1 + idx}`)
      .join(',');
    sql += ` AND s."waferid" IN (${waferParams})`;
    queryParams.push(...waferIdList);

    if (!lotId && startDate) {
      const { startDate: s } = this.getSafeDates(startDate);
      sql += ` AND s."ts" >= $${queryParams.length + 1}`;
      queryParams.push(s);
    }
    if (!lotId && endDate) {
      const { endDate: e } = this.getSafeDates(undefined, endDate);
      sql += ` AND s."ts" <= $${queryParams.length + 1}`;
      queryParams.push(e);
    }

    sql += ` ORDER BY s."waferid" ASC, f."serv_ts" DESC`;

    try {
      const results = await this.prisma.$queryRawUnsafe<
        SpectrumTrendJoinedResult[]
      >(sql, ...queryParams);

      const series = results.map((row) => {
        const dataPoints: number[][] = [];
        if (
          row.wavelengths &&
          row.values &&
          row.wavelengths.length === row.values.length
        ) {
          for (let i = 0; i < row.wavelengths.length; i++) {
            dataPoints.push([row.wavelengths[i], row.values[i] * 100]);
          }
        }

        const meta: Record<string, unknown> = {
          timestamp: row.serv_ts,
          scanTs: row.ts,
          eqpId: row.eqpid,
          rawWaferId: row.waferid,
          lotId: row['lotid'] || lotId,
        };

        dynamicColumns.forEach((col) => {
          meta[col] = row[col] as unknown;
        });

        return {
          name: `W${row.waferid}`,
          waferId: Number(row.waferid),
          pointId: Number(pointId),
          meta: meta,
          data: dataPoints,
        };
      });

      return series;
    } catch (e) {
      this.logger.error('Error fetching spectrum trend:', e);
      return [];
    }
  }

  // Model Fit Analysis용 GEN Spectrum 조회
  async getSpectrumGen(params: WaferQueryParams) {
    const { lotId, waferId, pointId, eqpId, ts } = params;
    if (!lotId || !waferId || !pointId || !eqpId || !ts) return null;

    try {
      const targetDate = typeof ts === 'string' ? new Date(ts) : ts;
      const now = new Date();
      const tYear = targetDate.getFullYear();
      const tMonth = targetDate.getMonth();
      const cYear = now.getFullYear();
      const cMonth = now.getMonth();

      let tableName = 'public.plg_onto_spectrum';
      if (tYear !== cYear || tMonth !== cMonth) {
        const mm = String(tMonth + 1).padStart(2, '0');
        tableName = `public.plg_onto_spectrum_y${tYear}m${mm}`;
      }

      // [수정] Short Year 적용 (YY-MM-DD)
      const tsRaw = this.toShortYearDate(ts);

      const results = await this.prisma.$queryRawUnsafe<SpectrumRawResult[]>(
        `SELECT "wavelengths", "values" 
         FROM ${tableName}
         WHERE "lotid" = $1 
           AND "waferid" = $2  
           AND "point" = $3    
           AND "eqpid" = $4    
           AND "ts" = $5::timestamp 
           AND "class" = 'GEN'
         LIMIT 1`,
        lotId,
        String(waferId),
        Number(pointId),
        eqpId,
        tsRaw,
      );

      if (!results || results.length === 0) return null;

      const row = results[0];
      const dataPoints: number[][] = [];
      if (row.wavelengths && row.values) {
        for (let i = 0; i < row.wavelengths.length; i++) {
          dataPoints.push([row.wavelengths[i], row.values[i] * 100]);
        }
      }

      return {
        name: `Model (W${waferId})`,
        type: 'line',
        lineStyle: { type: 'dashed', width: 2, color: '#ef4444' },
        data: dataPoints,
        symbol: 'none',
      };
    } catch (e) {
      this.logger.error('Error fetching GEN spectrum:', e);
      return null;
    }
  }

  async getFlatData(params: WaferQueryParams) {
    const {
      eqpId,
      lotId,
      waferId,
      startDate,
      endDate,
      cassetteRcp,
      stageRcp,
      stageGroup,
      film,
      page = 0,
      pageSize = 20,
    } = params;

    const { startDate: s, endDate: e } = this.getSafeDates(startDate, endDate);

    const where: Prisma.PlgWfFlatWhereInput = {
      eqpid: eqpId || undefined,
      servTs: lotId ? undefined : {
        gte: s,
        lte: e,
      },
      lotid: lotId ? { contains: lotId, mode: 'insensitive' } : undefined,
      waferid: waferId ? Number(waferId) : undefined,
      cassettercp: cassetteRcp || undefined,
      stagercp: stageRcp || undefined,
      stagegroup: stageGroup || undefined,
      film: film || undefined,
    };

    const uniqueGroupsPromise = this.prisma.plgWfFlat.groupBy({
      by: [
        'eqpid',
        'servTs',
        'lotid',
        'waferid',
        'cassettercp',
        'stagercp',
        'stagegroup',
        'film',
      ],
      where,
      _count: { _all: true },
    });

    const itemsPromise = this.prisma.plgWfFlat.findMany({
      where,
      take: Number(pageSize),
      skip: Number(page) * Number(pageSize),
      orderBy: [{ servTs: 'desc' }, { waferid: 'asc' }],
      distinct: [
        'eqpid',
        'servTs',
        'lotid',
        'waferid',
        'cassettercp',
        'stagercp',
        'stagegroup',
        'film',
      ],
      select: {
        eqpid: true,
        lotid: true,
        waferid: true,
        servTs: true,
        datetime: true,
        cassettercp: true,
        stagercp: true,
        stagegroup: true,
        film: true,
      },
    });

    const [uniqueGroups, items] = await this.prisma.$transaction([
      uniqueGroupsPromise,
      itemsPromise,
    ]);
    const total = uniqueGroups.length;

    let mapLookup = new Set<string>();
    let spcLookup = new Set<string>();

    if (items.length > 0) {
      const eqpIds = [...new Set(items.map(i => i.eqpid))];
      const datetimes = items.map(i => i.datetime).filter(d => d !== null) as Date[];
      
      const lotIds = [...new Set(items.map(i => i.lotid))].filter(l => l !== null) as string[];
      const waferIds = [...new Set(items.map(i => i.waferid))].filter(w => w !== null).map(String);

      const [maps, spectrums] = await Promise.all([
        datetimes.length > 0 ? this.prisma.plgWfMap.findMany({
          where: {
            eqpid: { in: eqpIds },
            datetime: { in: datetimes }
          },
          select: { eqpid: true, datetime: true }
        }) : Promise.resolve([] as { eqpid: string; datetime: Date }[]),

        this.prisma.plgOntoSpectrum.groupBy({
           by: ['eqpid', 'lotid', 'waferid'],
           where: {
             eqpid: { in: eqpIds },
             lotid: { in: lotIds },
             waferid: { in: waferIds }
           }
        })
      ]);

      maps.forEach(m => mapLookup.add(`${m.eqpid}_${m.datetime.getTime()}`));
      spectrums.forEach(s => spcLookup.add(`${s.eqpid}_${s.lotid}_${s.waferid}`));
    }

    return {
      totalItems: total,
      items: items.map((i) => ({
        eqpId: i.eqpid,
        lotId: i.lotid,
        waferId: i.waferid,
        servTs: i.servTs,
        dateTime: i.datetime,
        cassetteRcp: i.cassettercp,
        stageRcp: i.stagercp,
        stageGroup: i.stagegroup,
        film: i.film,
        hasWaferMap: i.datetime ? mapLookup.has(`${i.eqpid}_${i.datetime.getTime()}`) : false,
        hasSpectrum: spcLookup.has(`${i.eqpid}_${i.lotid}_${String(i.waferid)}`)
      })),
    };
  }

  async getPdfImage(params: WaferQueryParams): Promise<string> {
    const { eqpId, lotId, waferId, dateTime, pointNumber } = params;

    if (!eqpId || !dateTime || pointNumber === undefined) {
      throw new InternalServerErrorException(
        'EQP ID, DateTime, and PointNumber are required for PDF image.',
      );
    }

    // [핵심 수정] try/catch 범위 밖에서 변수 선언하여 스코프 오류(TS2304) 해결
    let tempPdfPath: string | null = null;
    let expectedOutput: string | null = null;

    try {
      const pdfCheckResult = await this.checkPdf({
        eqpId,
        lotId,
        waferId,
        dateTime: dateTime,
      });

      if (!pdfCheckResult.exists || !pdfCheckResult.url) {
        // [중요] 404 에러를 던져서 상위 catch가 500으로 감싸지 않게(아래 처리) 함
        throw new NotFoundException('PDF file URI not found in database.');
      }

      const downloadUrl = pdfCheckResult.url;
      if (!downloadUrl.startsWith('http')) {
        throw new InternalServerErrorException('Only HTTP/HTTPS URLs are supported.');
      }

      // [수정] 캐시 파일명에도 Short Year 포맷 적용 (260128...)
      const safeDateStr = this.toShortYearDate(dateTime);
      const dateStr = safeDateStr.slice(0, 8).replace(/-/g, ''); // YY-MM-DD -> YYMMDD
      const cacheFileName = `wafer_${eqpId}_${dateStr}_pt${pointNumber}.png`;
      const cacheFilePath = path.join(os.tmpdir(), cacheFileName);

      if (fs.existsSync(cacheFilePath) && fs.statSync(cacheFilePath).size > 0) {
        try { return fs.readFileSync(cacheFilePath).toString('base64'); } catch (e) { /* ignore */ }
      }

      const tempId = `${Date.now()}_${Math.random().toString(36).substring(7)}`;
      // [수정] 외부 변수(tempPdfPath, expectedOutput)에 값 할당
      tempPdfPath = path.join(os.tmpdir(), `temp_wafer_${tempId}.pdf`);
      const outputPrefix = path.join(os.tmpdir(), `temp_img_${tempId}`);
      expectedOutput = `${outputPrefix}.png`;

      const writer = fs.createWriteStream(tempPdfPath);
      const response = await axios({
        url: encodeURI(downloadUrl),
        method: 'GET',
        responseType: 'stream',
        proxy: false,
        timeout: 10000,
      });

      (response.data as Readable).pipe(writer);

      await new Promise<void>((resolve, reject) => {
        writer.on('finish', () => resolve());
        writer.on('error', reject);
      });

      if (!fs.existsSync(tempPdfPath) || fs.statSync(tempPdfPath).size === 0) {
        throw new Error('Downloaded PDF is empty or missing.');
      }

      const popplerBinPath = process.env.POPPLER_BIN_PATH;
      if (!popplerBinPath) throw new Error('POPPLER_BIN_PATH is missing.');
      const pdftocairoExe = path.join(popplerBinPath, 'pdftocairo.exe');
      
      let targetPage = Number(pointNumber);
      if (isNaN(targetPage) || targetPage < 1) targetPage = 1;

      const runConversion = async (page: number) => {
        // expectedOutput은 null이 아니라고 확신할 수 있는 시점이나 TS는 모르므로 체크
        if (expectedOutput && fs.existsSync(expectedOutput)) {
            try { fs.unlinkSync(expectedOutput); } catch(e) {}
        }
        // tempPdfPath도 마찬가지
        if (!tempPdfPath || !expectedOutput) return;

        const args = [ '-png', '-f', String(page), '-l', String(page), '-singlefile', tempPdfPath, outputPrefix ];
        
        await execFileAsync(pdftocairoExe, args, {
          timeout: 60000, 
          windowsHide: true,
          maxBuffer: 1024 * 1024 * 10 
        });
      };

      let conversionSuccess = false;
      try {
        await runConversion(targetPage);
        if (fs.existsSync(expectedOutput) && fs.statSync(expectedOutput).size > 0) {
          conversionSuccess = true;
        }
      } catch (err: any) {
        this.logger.warn(`[PDF] Page ${targetPage} failed: ${err.message}`);
      }

      if (!conversionSuccess) {
        await new Promise(resolve => setTimeout(resolve, 500));
        try {
          await runConversion(1);
          if (fs.existsSync(expectedOutput) && fs.statSync(expectedOutput).size > 0) {
            conversionSuccess = true;
          }
        } catch (err: any) {
          this.logger.error(`[PDF] Fallback failed: ${err.message}`);
        }
      }

      if (!conversionSuccess || !fs.existsSync(expectedOutput)) {
        throw new Error('Poppler finished but PNG file was not created.');
      }

      try {
        fs.copyFileSync(expectedOutput, cacheFilePath);
        fs.unlinkSync(expectedOutput);
      } catch (e) { /* ignore */ }

      const finalPath = fs.existsSync(cacheFilePath) ? cacheFilePath : expectedOutput;
      const imageBuffer = fs.readFileSync(finalPath);
      
      try { if (fs.existsSync(tempPdfPath)) fs.unlinkSync(tempPdfPath); } catch {}

      return imageBuffer.toString('base64');

    } catch (e) {
      // [수정] try 블록 밖에서 선언된 변수이므로 여기서 접근 가능
      try { 
        if (tempPdfPath && fs.existsSync(tempPdfPath)) fs.unlinkSync(tempPdfPath); 
        if (expectedOutput && fs.existsSync(expectedOutput)) fs.unlinkSync(expectedOutput);
      } catch { /* ignore */ }
      
      // NotFoundException은 500으로 감싸지 않고 그대로 던짐
      if (e instanceof NotFoundException) {
          throw e;
      }
      
      const error = e as { code?: string; message?: string };
      this.logger.error(`[ERROR] PDF Processing Failed: ${error.message}`);
      throw new InternalServerErrorException(`Failed to process PDF`);
    }
  }

  // [수정] checkPdf: 날짜 포맷 강제 변환 (YY-MM-DD)
  async checkPdf(
    params: WaferQueryParams,
  ): Promise<{ exists: boolean; url: string | null }> {
    const { eqpId, lotId, waferId, servTs, dateTime } = params;

    const targetTimeVal = dateTime || servTs;

    if (!eqpId || !targetTimeVal) return { exists: false, url: null };

    try {
      // [핵심] 20XX -> XX 로 변환하여 DB 조회
      const tsStr = this.toShortYearDate(targetTimeVal);

      const results = await this.prisma.$queryRawUnsafe<PdfResult[]>(
        `SELECT file_uri, datetime FROM public.plg_wf_map 
          WHERE eqpid = $1 
            AND datetime = $2::timestamp
          ORDER BY datetime DESC`,
        eqpId,
        tsStr,
      );

      if (!results || results.length === 0) {
        return { exists: false, url: null };
      }

      let candidates = results;
      if (lotId) {
        const targetLot = lotId.trim();
        const targetLotUnderscore = targetLot.replace(/\./g, '_');

        candidates = results.filter((r) => {
          if (!r.file_uri) return false;
          const uri = r.file_uri;
          const filename = path.basename(uri);
          const hasLot = filename.includes(targetLot) || filename.includes(targetLotUnderscore);
          let hasWafer = true;
          if (waferId) {
            hasWafer = filename.includes(String(waferId));
          }
          return hasLot && hasWafer;
        });
      }

      if (candidates.length > 0) {
        return { exists: true, url: candidates[0].file_uri };
      }
      return { exists: false, url: null };

    } catch (e) {
      this.logger.warn(`Failed to check PDF:`, e);
    }
    return { exists: false, url: null };
  }

  // [수정] Spectrum 조회도 Short Year 적용
  async getSpectrum(params: WaferQueryParams) {
    const { eqpId, lotId, waferId, pointNumber, ts } = params;
    if (!eqpId || !lotId || !waferId || pointNumber === undefined || !ts) return [];

    try {
      // [핵심] 날짜 변환
      const tsRaw = this.toShortYearDate(ts);
      const tableName = 'public.plg_onto_spectrum';

      const results = await this.prisma.$queryRawUnsafe<SpectrumRawResult[]>(
        `SELECT "class", "wavelengths", "values" 
         FROM ${tableName}
         WHERE "eqpid" = $1 
           AND "ts" = $2::timestamp
           AND "lotid" = $3 
           AND "waferid" = $4 
           AND "point" = $5
         ORDER BY "class" ASC`,
        eqpId,
        tsRaw,
        lotId,
        String(waferId),
        Number(pointNumber),
      );

      if (!results || results.length === 0) return [];

      const uniqueResults = new Map<string, SpectrumRawResult>();
      results.forEach((r) => {
        if (!uniqueResults.has(r.class)) uniqueResults.set(r.class, r);
      });

      return Array.from(uniqueResults.values()).map((r) => ({
        class: r.class,
        wavelengths: r.wavelengths,
        values: r.values,
      }));
    } catch (e) {
      this.logger.error('[WaferService] Error fetching spectrum data:', e);
      return [];
    }
  }

  async getStatistics(params: WaferQueryParams) {
    const whereSql = this.buildUniqueWhere(params);
    if (!whereSql) return {};

    try {
      const validColumnsResult = await this.prisma.$queryRawUnsafe<
        { column_name: string }[]
      >(
        `SELECT column_name 
         FROM information_schema.columns 
         WHERE table_name = 'plg_wf_flat' AND table_schema = 'public'`,
      );

      const validColumnSet = new Set(
        validColumnsResult.map((r) => r.column_name.toLowerCase()),
      );

      let targetColumns = ['t1', 'gof', 'z', 'srvisz', 'mse', 'thickness'];

      try {
        const configMetrics = await this.prisma.$queryRaw<
          { metric_name: string }[]
        >`SELECT metric_name FROM public.cfg_lot_uniformity_metrics WHERE is_excluded = 'N'`;
        if (configMetrics.length > 0) {
          const configNames = configMetrics.map((c) => c.metric_name.toLowerCase());
          targetColumns = [...new Set([...targetColumns, ...configNames])];
        }
      } catch (e) { /* ignore */ }

      const excludeCols = ['x', 'y', 'diex', 'diey', 'dierow', 'diecol', 'dienum', 'diepointtag', 'point', 'lotid', 'waferid', 'eqpid', 'serv_ts', 'datetime'];

      targetColumns = targetColumns.filter((col) => {
        const lowerCol = col.toLowerCase();
        return !excludeCols.includes(lowerCol) && validColumnSet.has(lowerCol);
      });

      if (targetColumns.length === 0) return {};

      const selectParts = targetColumns
        .map((col) => `MAX("${col}") as "${col}_max", MIN("${col}") as "${col}_min", AVG("${col}") as "${col}_mean", STDDEV_SAMP("${col}") as "${col}_std"`)
        .join(', ');

      const sql = `SELECT ${selectParts} FROM public.plg_wf_flat ${whereSql} LIMIT 1`;
      const result = await this.prisma.$queryRawUnsafe<StatsRawResult[]>(sql);
      const row = result[0] || {};
      const statsResult: Record<string, any> = {};

      for (const col of targetColumns) {
        if (row[`${col}_max`] === null || row[`${col}_max`] === undefined) continue;
        const max = Number(row[`${col}_max`] || 0);
        const min = Number(row[`${col}_min`] || 0);
        const mean = Number(row[`${col}_mean`] || 0);
        const std = Number(row[`${col}_std`] || 0);
        const range = max - min;
        statsResult[col] = {
          max, min, range, mean, stdDev: std,
          percentStdDev: mean !== 0 ? (std / mean) * 100 : 0,
          percentNonU: mean !== 0 ? (range / (2 * mean)) * 100 : 0,
        };
      }
      return statsResult;
    } catch (e) {
      this.logger.error('Error in getStatistics:', e);
      return {};
    }
  }

  async getPointData(
    params: WaferQueryParams,
  ): Promise<{ headers: string[]; data: unknown[][] }> {
    const whereSql = this.buildUniqueWhere(params);
    if (!whereSql) return { headers: [], data: [] };

    try {
      const rawData = await this.prisma.$queryRawUnsafe<
        Record<string, unknown>[]
      >(`SELECT * FROM public.plg_wf_flat ${whereSql} ORDER BY point`);

      if (!rawData || rawData.length === 0) return { headers: [], data: [] };

      const excludeCols = new Set(['eqpid', 'lotid', 'waferid', 'serv_ts', 'cassettercp', 'stagercp', 'stagegroup', 'film', 'datetime']);
      const allKeys = new Set<string>();
      rawData.forEach((row) => {
        Object.keys(row).forEach((k) => {
          if (!excludeCols.has(k) && row[k] !== null) allKeys.add(k);
        });
      });

      const customOrder = ['point', 'mse', 't1', 'gof', 'x', 'y', 'diex', 'diey', 'dierow', 'diecol', 'dienum', 'diepointtag', 'z', 'srvisz'];
      const headers = Array.from(allKeys).sort((a, b) => {
        const lowerA = a.toLowerCase();
        const lowerB = b.toLowerCase();
        const idxA = customOrder.indexOf(lowerA);
        const idxB = customOrder.indexOf(lowerB);
        if (idxA !== -1 && idxB !== -1) return idxA - idxB;
        if (idxA !== -1) return -1;
        if (idxB !== -1) return 1;
        return lowerA.localeCompare(lowerB);
      });

      const data = rawData.map((row) => headers.map((h) => row[h]));
      return { headers, data };
    } catch (e) {
      this.logger.error('Error in getPointData:', e);
      return { headers: [], data: [] };
    }
  }

  private buildUniqueWhere(p: WaferQueryParams): string | null {
    if (!p.eqpId) return null;
    let sql = `WHERE eqpid = '${String(p.eqpId)}'`;

    const targetDate = p.dateTime || p.servTs;

    if (targetDate) {
      // [수정] 날짜 정규화 (Short Year)
      let dateStr = this.toShortYearDate(targetDate);
      const cleanDateStr = dateStr; 

      sql += ` AND datetime >= '${cleanDateStr}'::timestamp - interval '2 second'`;
      sql += ` AND datetime <= '${cleanDateStr}'::timestamp + interval '2 second'`;

      if (p.lotId) sql += ` AND lotid = '${String(p.lotId)}'`;
      if (p.waferId) sql += ` AND waferid = ${Number(p.waferId)}`;
    } else {
      if (!p.lotId) {
        if (p.startDate) {
          const { startDate: s } = this.getSafeDates(p.startDate);
          sql += ` AND serv_ts >= '${s.toISOString()}'`;
        }
        if (p.endDate) {
          const { endDate: e } = this.getSafeDates(undefined, p.endDate);
          sql += ` AND serv_ts <= '${e.toISOString()}'`;
        }
      }
      
      if (p.lotId) sql += ` AND lotid = '${String(p.lotId)}'`;
      if (p.waferId) sql += ` AND waferid = ${Number(p.waferId)}`;
      if (p.cassetteRcp) sql += ` AND cassettercp = '${String(p.cassetteRcp)}'`;
      if (p.stageRcp) sql += ` AND stagercp = '${String(p.stageRcp)}'`;
      if (p.stageGroup) sql += ` AND stagegroup = '${String(p.stageGroup)}'`;
      if (p.film) sql += ` AND film = '${String(p.film)}'`;
    }
    return sql;
  }

  async getMatchingEquipments(params: WaferQueryParams): Promise<string[]> {
    const { site, sdwt, startDate, endDate, cassetteRcp, stageGroup, film } = params;
    if (!startDate || !endDate || !cassetteRcp) return [];
    const { startDate: s, endDate: e } = this.getSafeDates(startDate, endDate);

    let sql = `
      SELECT DISTINCT t1.eqpid
      FROM public.plg_wf_flat t1
      JOIN public.ref_equipment t2 ON t1.eqpid = t2.eqpid
      JOIN public.ref_sdwt t3 ON t2.sdwt = t3.sdwt
      WHERE t1.serv_ts >= $1 AND t1.serv_ts <= $2
        AND t1.cassettercp = $3
    `;

    const queryParams: (string | Date | number)[] = [s, e, cassetteRcp];
    let pIdx = 4;
    if (site) { sql += ` AND t3.site = $${pIdx++}`; queryParams.push(site); }
    if (sdwt) { sql += ` AND t3.sdwt = $${pIdx++}`; queryParams.push(sdwt); }
    if (stageGroup) { sql += ` AND t1.stagegroup = $${pIdx++}`; queryParams.push(stageGroup); }
    if (film) { sql += ` AND t1.film = $${pIdx++}`; queryParams.push(film); }

    sql += ` ORDER BY t1.eqpid`;
    try {
      const res = await this.prisma.$queryRawUnsafe<{ eqpid: string }[]>(sql, ...queryParams);
      return res.map((r) => r.eqpid);
    } catch (e) {
      this.logger.error('Error fetching matching equipments:', e);
      return [];
    }
  }

  async getComparisonData(params: WaferQueryParams): Promise<ComparisonRawResult[]> {
    const { startDate, endDate, cassetteRcp, stageGroup, film, targetEqps } = params;
    if (!targetEqps || !startDate || !endDate || !cassetteRcp) return [];
    const eqpList = targetEqps.split(',').map((e) => e.trim());

    let metrics: string[] = ['t1', 'gof', 'mse', 'thickness'];
    try {
      const conf = await this.prisma.$queryRaw<{ metric_name: string }[]>`SELECT metric_name FROM public.cfg_lot_uniformity_metrics WHERE is_excluded = 'N'`;
      if (conf.length > 0) metrics = conf.map((c) => c.metric_name);
    } catch (e) { /* ignore */ }

    const selectCols = metrics.map((m) => `"${m}"`).join(', ');
    const { startDate: s, endDate: e } = this.getSafeDates(startDate, endDate);

    let sql = `
      SELECT eqpid, lotid, waferid, point, ${selectCols}
      FROM public.plg_wf_flat
      WHERE serv_ts >= $1 AND serv_ts <= $2
        AND cassettercp = $3
        AND eqpid IN (${eqpList.map((e) => `'${e}'`).join(',')})
    `;

    const queryParams: (string | Date | number)[] = [s, e, cassetteRcp];
    let pIdx = 4;
    if (stageGroup) { sql += ` AND stagegroup = $${pIdx++}`; queryParams.push(stageGroup); }
    if (film) { sql += ` AND film = $${pIdx++}`; queryParams.push(film); }

    sql += ` ORDER BY serv_ts DESC LIMIT 5000`;
    try {
      return await this.prisma.$queryRawUnsafe<ComparisonRawResult[]>(sql, ...queryParams);
    } catch (e) {
      this.logger.error('Error fetching comparison data:', e);
      return [];
    }
  }

  async getOpticalTrend(params: WaferQueryParams) {
    const { eqpId, startDate, endDate, cassetteRcp, stageGroup, film } = params;
    if (!eqpId || !startDate || !endDate) return [];

    try {
      const { startDate: s, endDate: e } = this.getSafeDates(startDate, endDate);
      const queryParams: (string | number | Date)[] = [eqpId, s, e];
      let filterClause = '';
      if (cassetteRcp) { filterClause += ` AND f.cassettercp = $${queryParams.length + 1}`; queryParams.push(cassetteRcp); }
      if (stageGroup) { filterClause += ` AND f.stagegroup = $${queryParams.length + 1}`; queryParams.push(stageGroup); }
      if (film) { filterClause += ` AND f.film = $${queryParams.length + 1}`; queryParams.push(film); }

      const sql = `
        SELECT s.ts, s.lotid, s.waferid, s.point, s.wavelengths, s."values"
        FROM public.plg_onto_spectrum s
        JOIN public.plg_wf_flat f 
          ON s.eqpid = f.eqpid 
          AND s.lotid = f.lotid 
          AND s.waferid::integer = f.waferid
          AND s.point = f.point
        WHERE s.eqpid = $1
          AND s.ts >= $2
          AND s.ts <= $3
          ${filterClause}
        ORDER BY s.ts ASC
        LIMIT 2000
      `;

      const rawData = await this.prisma.$queryRawUnsafe<OpticalTrendRawResult[]>(sql, ...queryParams);
      return rawData.map((d) => {
        const values = d.values || [];
        const wavelengths = d.wavelengths || [];
        const totalIntensity = values.reduce((acc, v) => acc + v, 0);
        let maxVal = -Infinity;
        let minVal = Infinity;
        let maxIdx = 0;

        if (values.length === 0) { maxVal = 0; minVal = 0; } else {
          for (let i = 0; i < values.length; i++) {
            if (values[i] > maxVal) { maxVal = values[i]; maxIdx = i; }
            if (values[i] < minVal) { minVal = values[i]; }
          }
        }
        return {
          ts: d.ts,
          lotId: d.lotid,
          waferId: d.waferid,
          point: d.point,
          totalIntensity,
          peakIntensity: maxVal === -Infinity ? 0 : maxVal,
          peakWavelength: wavelengths[maxIdx] || 0,
          darkNoise: minVal === Infinity ? 0 : minVal,
        };
      });
    } catch (e) {
      this.logger.error('Error in getOpticalTrend:', e);
      return [];
    }
  }

  async getResidualMap(params: WaferQueryParams): Promise<ResidualMapItem[]> {
    const whereSql = this.buildUniqueWhere(params);
    if (!whereSql) return [];
    const metric = params.metric || 't1';

    try {
      const data = await this.prisma.$queryRawUnsafe<{ point: number; x: number; y: number; val: number }[]>(
        `SELECT point, x, y, "${metric}" as val FROM public.plg_wf_flat ${whereSql}`
      );
      if (!data.length) return [];
      const validData = data.filter((d) => d.val !== null);
      if (!validData.length) return [];
      const mean = validData.reduce((acc, cur) => acc + cur.val, 0) / validData.length;
      return validData.map((d) => ({ point: d.point, x: d.x, y: d.y, residual: d.val - mean }));
    } catch (e) {
      this.logger.error('Error in getResidualMap:', e);
      return [];
    }
  }

  async getGoldenSpectrum(params: WaferQueryParams): Promise<GoldenSpectrumResponse | null> {
    const { eqpId, lotId, pointId, cassetteRcp, stageGroup } = params;
    if (!eqpId || !lotId || !pointId) return null;

    try {
      const bestGofSql = `
            SELECT waferid FROM public.plg_wf_flat
            WHERE eqpid = $1 AND lotid = $2 AND point = $3
              ${cassetteRcp ? 'AND cassettercp = $4' : ''}
              ${stageGroup ? 'AND stagegroup = $5' : ''}
              AND gof IS NOT NULL
            ORDER BY gof DESC LIMIT 1
        `;
      const queryParams: any[] = [eqpId, lotId, Number(pointId)];
      if (cassetteRcp) queryParams.push(cassetteRcp);
      if (stageGroup) queryParams.push(stageGroup);

      const bestData = await this.prisma.$queryRawUnsafe<{ waferid: unknown }[]>(bestGofSql, ...queryParams);
      if (!bestData || bestData.length === 0) return null;

      const spectrumSql = `
            SELECT wavelengths, "values" FROM public.plg_onto_spectrum
            WHERE eqpid = $1 AND lotid = $2 AND waferid = $3 AND point = $4 AND class = 'EXP' 
            ORDER BY ts DESC LIMIT 1
        `;
      const spectrum = await this.prisma.$queryRawUnsafe<SpectrumRawResult[]>(spectrumSql, eqpId, lotId, String(bestData[0].waferid), Number(pointId));
      if (!spectrum || spectrum.length === 0) return null;
      return { wavelengths: spectrum[0].wavelengths, values: spectrum[0].values };
    } catch (e) {
      this.logger.error('Error in getGoldenSpectrum:', e);
      return null;
    }
  }

  async getAvailableMetrics(params: WaferQueryParams): Promise<string[]> {
    try {
      const configMetrics = await this.prisma.$queryRaw<{ metric_name: string }[]>`SELECT metric_name FROM public.cfg_lot_uniformity_metrics WHERE is_excluded = 'N' ORDER BY metric_name`;
      let candidates = configMetrics.map((m) => m.metric_name);
      if (candidates.length === 0) return [];

      const tableColumns = await this.prisma.$queryRawUnsafe<{ column_name: string }[]>(
        `SELECT column_name FROM information_schema.columns WHERE table_name = 'plg_wf_flat' AND table_schema = 'public'`
      );
      const validColumnSet = new Set(tableColumns.map((c) => c.column_name.toLowerCase()));
      candidates = candidates.filter((metric) => validColumnSet.has(metric.toLowerCase()));
      if (candidates.length === 0) return [];

      const whereSql = this.buildUniqueWhere({ ...params, waferId: undefined });
      if (!whereSql) return candidates;

      const countSelects = candidates.map((col) => `COUNT("${col}") as "${col}"`).join(', ');
      const countResults = await this.prisma.$queryRawUnsafe<Record<string, number | bigint>[]>(`SELECT ${countSelects} FROM public.plg_wf_flat ${whereSql}`);
      if (!countResults || countResults.length === 0) return [];

      const counts = countResults[0];
      return candidates.filter((metric) => Number(counts[metric]) > 0);
    } catch (e) {
      this.logger.error('Failed to fetch available metrics:', e);
      return [];
    }
  }

  async getLotUniformityTrend(params: WaferQueryParams & { metric: string }): Promise<any[]> {
    const { metric, ...rest } = params;
    const targetMetric = metric || 't1';
    const whereSql = this.buildUniqueWhere({ ...rest, waferId: undefined });
    if (!whereSql) return [];

    try {
      const results = await this.prisma.$queryRawUnsafe<any[]>(
        `SELECT waferid, point, x, y, dierow, diecol, "${targetMetric}" as value 
             FROM public.plg_wf_flat ${whereSql} 
             ORDER BY waferid, point`
      );
      const grouped: Record<string, any[]> = {};
      results.forEach((row) => {
        const wid = String(row.waferid);
        if (!grouped[wid]) grouped[wid] = [];
        grouped[wid].push(row);
      });
      return Object.keys(grouped).map((wid) => ({
        waferId: Number(wid),
        dataPoints: grouped[wid].map((p) => ({
          point: p.point,
          value: p.value,
          x: p.x,
          y: p.y,
          dieRow: p.dierow,
          dieCol: p.diecol,
        })),
      }));
    } catch (e) {
      this.logger.error('Error in getLotUniformityTrend:', e);
      return [];
    }
  }
}
