// ITM-DATA-API\src\wafer\wafer.service.ts
import {
  Injectable,
  InternalServerErrorException,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../prisma.service';
import { Prisma } from '@prisma/client';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as poppler from 'pdf-poppler';
import axios from 'axios';
import { Readable } from 'stream';

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
}

interface SpectrumRawResult {
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

interface LotTrendRawResult {
  waferid: number;
  point: number;
  x: number;
  y: number;
  dierow: number | null;
  diecol: number | null;
  value: number;
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

interface PopplerModule {
  convert: (file: string, options: any) => Promise<any>;
}

@Injectable()
export class WaferService {
  constructor(private prisma: PrismaService) {}

  // 1. Distinct Values 조회
  async getDistinctValues(
    column: string,
    params: WaferQueryParams,
  ): Promise<string[]> {
    const { eqpId, lotId, cassetteRcp, stageGroup, startDate, endDate } =
      params;

    const table = 'public.plg_wf_flat';
    let colName = column;

    if (column === 'lotids') colName = 'lotid';
    if (column === 'cassettercps') colName = 'cassettercp';
    if (column === 'stagegroups') colName = 'stagegroup';
    if (column === 'films') colName = 'film';
    if (column === 'waferids') colName = 'waferid';

    let whereClause = `WHERE 1=1`;
    const queryParams: (string | number | Date)[] = [];

    if (eqpId) {
      whereClause += ` AND eqpid = $${queryParams.length + 1}`;
      queryParams.push(eqpId);
    }
    if (lotId) {
      whereClause += ` AND lotid = $${queryParams.length + 1}`;
      queryParams.push(lotId);
    }
    if (cassetteRcp) {
      whereClause += ` AND cassettercp = $${queryParams.length + 1}`;
      queryParams.push(cassetteRcp);
    }
    if (stageGroup) {
      whereClause += ` AND stagegroup = $${queryParams.length + 1}`;
      queryParams.push(stageGroup);
    }

    if (startDate && endDate) {
      whereClause += ` AND serv_ts >= $${queryParams.length + 1} AND serv_ts <= $${queryParams.length + 2}`;
      queryParams.push(new Date(startDate), new Date(endDate));
    }

    const sql = `SELECT DISTINCT "${colName}" as val FROM ${table} ${whereClause} ORDER BY "${colName}" DESC LIMIT 100`;

    try {
      const result = await this.prisma.$queryRawUnsafe<{ val: unknown }[]>(
        sql,
        ...queryParams,
      );
      return result
        .map((r) => {
          if (r.val === null || r.val === undefined) return '';
          // [린트 해결] 객체 여부를 체크하여 안전하게 문자열 변환
          if (typeof r.val === 'object') return JSON.stringify(r.val);
          return String(r.val);
        })
        .filter((v) => v !== '');
    } catch (e) {
      console.warn(`Error fetching distinct ${column}:`, e);
      return [];
    }
  }

  // Lot, RCP, Stage 조건에 맞는 실제 Point 목록 조회
  async getDistinctPoints(params: WaferQueryParams): Promise<string[]> {
    const { eqpId, lotId, cassetteRcp, stageGroup, startDate, endDate } =
      params;

    let sql = `
      SELECT DISTINCT s.point
      FROM public.plg_onto_spectrum s
      JOIN public.plg_wf_flat f 
        ON s.eqpid = f.eqpid 
        AND s.lotid = f.lotid 
        AND s.waferid = f.waferid::varchar 
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
    if (stageGroup) {
      sql += ` AND f.stagegroup = $${queryParams.length + 1}`;
      queryParams.push(stageGroup);
    }

    if (startDate && endDate) {
      sql += ` AND s.ts >= $${queryParams.length + 1} AND s.ts <= $${queryParams.length + 2}`;
      queryParams.push(new Date(startDate), new Date(endDate));
    }

    sql += ` ORDER BY s.point ASC`;

    try {
      const results = await this.prisma.$queryRawUnsafe<{ point: number }[]>(
        sql,
        ...queryParams,
      );
      return results.map((r) => String(r.point));
    } catch (e) {
      console.error('Error fetching distinct points:', e);
      return [];
    }
  }

  // Spectrum Trend 데이터 조회
  async getSpectrumTrend(params: WaferQueryParams): Promise<any[]> {
    const {
      eqpId,
      lotId,
      pointId,
      waferIds,
      startDate,
      endDate,
      cassetteRcp,
      stageGroup,
    } = params;

    if (!lotId || !pointId || !waferIds) {
      return [];
    }

    const waferIdList = waferIds.split(',').map((w) => w.trim());
    if (waferIdList.length === 0) return [];

    let dynamicColumns: string[] = [];
    try {
      const configMetrics = await this.prisma.$queryRaw<
        { metric_name: string }[]
      >`
        SELECT metric_name FROM public.cfg_lot_uniformity_metrics WHERE is_excluded = 'N'
      `;
      const configColNames = configMetrics.map((r) => r.metric_name);
      if (configColNames.length > 0) {
        dynamicColumns = configColNames;
      } else {
        dynamicColumns = ['t1', 'gof', 'mse'];
      }
    } catch (e) {
      console.warn(
        'Failed to fetch dynamic metrics config, using defaults.',
        e,
      );
      dynamicColumns = ['t1', 'gof', 'mse'];
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
        ON s."lotid" = f."lotid 
        AND s."waferid" = f."waferid"::varchar 
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
    if (stageGroup) {
      sql += ` AND f."stagegroup" = $${queryParams.length + 1}`;
      queryParams.push(stageGroup);
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

    if (startDate) {
      sql += ` AND s."ts" >= $${queryParams.length + 1}`;
      queryParams.push(new Date(startDate));
    }
    if (endDate) {
      sql += ` AND s."ts" <= $${queryParams.length + 1}`;
      queryParams.push(new Date(endDate));
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
      console.error('Error fetching spectrum trend:', e);
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

      const tsRaw = targetDate.toISOString();

      const results = await this.prisma.$queryRawUnsafe<SpectrumRawResult[]>(
        `SELECT "wavelengths", "values" 
         FROM ${tableName}
         WHERE "lotid" = $1 
           AND "waferid" = $2  
           AND "point" = $3    
           AND "eqpid" = $4    
           AND "ts" >= $5::timestamp - interval '2 second'
           AND "ts" <= $5::timestamp + interval '2 second'
           AND "class" = 'GEN'
         ORDER BY ABS(EXTRACT(EPOCH FROM ("ts" - $5::timestamp))) ASC
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
      console.error('Error fetching GEN spectrum:', e);
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

    let searchEnd: Date | undefined;
    if (endDate) {
      searchEnd = new Date(endDate);
      searchEnd.setDate(searchEnd.getDate() + 1);
    }

    const where: Prisma.PlgWfFlatWhereInput = {
      eqpid: eqpId || undefined,
      servTs: {
        gte: startDate ? new Date(startDate) : undefined,
        lt: searchEnd,
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

    const pdfCheckResult = await this.checkPdf({
      eqpId,
      lotId,
      waferId,
      servTs: dateTime,
    });

    if (!pdfCheckResult.exists || !pdfCheckResult.url) {
      throw new NotFoundException('PDF file URI not found in database.');
    }

    const dateObj = new Date(dateTime as string);
    const dateStr = dateObj.toISOString().slice(0, 10).replace(/-/g, '');
    const cacheFileName = `wafer_${eqpId}_${dateStr}_pt${pointNumber}.png`;
    const cacheFilePath = path.join(os.tmpdir(), cacheFileName);

    if (fs.existsSync(cacheFilePath)) {
      try {
        const imageBuffer = fs.readFileSync(cacheFilePath);
        return imageBuffer.toString('base64');
      } catch {
        /* ignore */
      }
    }

    let downloadUrl = pdfCheckResult.url;
    const baseUrl = process.env.PDF_SERVER_BASE_URL;

    if (baseUrl && !downloadUrl.startsWith('http')) {
      let normalizedPath = downloadUrl.replace(/\\/g, '/');
      if (!normalizedPath.startsWith('/'))
        normalizedPath = `/${normalizedPath}`;
      const normalizedBase = baseUrl.endsWith('/')
        ? baseUrl.slice(0, -1)
        : baseUrl;
      downloadUrl = `${normalizedBase}${normalizedPath}`;
    }

    const encodedUrl = encodeURI(downloadUrl);
    const tempId = `${Date.now()}_${Math.random().toString(36).substring(7)}`;
    const tempPdfPath = path.join(os.tmpdir(), `temp_wafer_${tempId}.pdf`);
    const outputPrefix = path.join(os.tmpdir(), `temp_img_${tempId}`);

    try {
      const writer = fs.createWriteStream(tempPdfPath);
      const response = await axios({
        url: encodedUrl,
        method: 'GET',
        responseType: 'stream',
        proxy: false,
      });

      const headers = response.headers as Record<string, unknown>;
      const contentType = headers['content-type'];

      if (
        typeof contentType === 'string' &&
        contentType.toLowerCase().includes('html')
      ) {
        writer.close();
        if (fs.existsSync(tempPdfPath)) fs.unlinkSync(tempPdfPath);
        throw new Error(
          `Invalid content-type: ${contentType}. Server returned HTML instead of PDF.`,
        );
      }

      (response.data as Readable).pipe(writer);

      await new Promise<void>((resolve, reject) => {
        writer.on('finish', () => resolve());
        writer.on('error', reject);
      });

      try {
        const fd = fs.openSync(tempPdfPath, 'r');
        const headerBuffer = Buffer.alloc(100);
        const bytesRead = fs.readSync(fd, headerBuffer, 0, 100, 0);
        fs.closeSync(fd);

        const headerString = headerBuffer.toString('utf8', 0, bytesRead);

        if (bytesRead < 4 || !headerString.startsWith('%PDF')) {
          console.error(
            `[PDF Signature Error] First 100 chars of downloaded file: \n${headerString}`,
          );
          throw new Error(
            `File signature mismatch. The downloaded file is NOT a PDF. Content starts with: ${headerString.substring(0, 50)}...`,
          );
        }
      } catch (checkErr) {
        if (fs.existsSync(tempPdfPath)) fs.unlinkSync(tempPdfPath);
        throw checkErr;
      }

      // [수정] 하드코딩 경로 제거 및 환경 변수 우선 사용
      const popplerBinPath = process.env.POPPLER_BIN_PATH; 
      
      if (!popplerBinPath) {
        throw new Error('POPPLER_BIN_PATH is not defined in environment variables.');
      }
      
      const targetPage = Number(pointNumber);

      const opts = {
        format: 'png',
        out_dir: os.tmpdir(),
        out_prefix: path.basename(outputPrefix),
        page: targetPage,
        binPath: popplerBinPath,
      };

      const popplerLib = poppler as unknown as PopplerModule;
      await popplerLib.convert(tempPdfPath, opts);

      const dirFiles = fs.readdirSync(os.tmpdir());
      const generatedImageName = dirFiles.find(
        (f) => f.startsWith(path.basename(outputPrefix)) && f.endsWith('.png'),
      );

      if (!generatedImageName) {
        throw new Error(
          'Image generation failed (poppler did not output png).',
        );
      }

      const generatedImagePath = path.join(os.tmpdir(), generatedImageName);

      try {
        fs.copyFileSync(generatedImagePath, cacheFilePath);
        fs.unlinkSync(generatedImagePath);
      } catch {
        /* ignore */
      }

      const finalPath = fs.existsSync(cacheFilePath)
        ? cacheFilePath
        : generatedImagePath;
      const imageBuffer = fs.readFileSync(finalPath);
      const base64Image = imageBuffer.toString('base64');

      try {
        if (fs.existsSync(tempPdfPath)) fs.unlinkSync(tempPdfPath);
      } catch {
        /* ignore */
      }

      return base64Image;
    } catch (e) {
      try {
        if (fs.existsSync(tempPdfPath)) fs.unlinkSync(tempPdfPath);
      } catch {
        /* ignore */
      }

      const error = e as { code?: string; message?: string };
      console.error(`[ERROR] PDF Processing Failed. URL: ${encodedUrl}`, e);
      throw new InternalServerErrorException(
        `Failed to process PDF: ${error.message || 'Unknown error'}`,
      );
    }
  }

  async getSpectrum(params: WaferQueryParams) {
    const { eqpId, lotId, waferId, pointNumber, ts } = params;

    if (!eqpId || !lotId || !waferId || pointNumber === undefined || !ts) {
      return [];
    }

    try {
      const targetDate = new Date(ts);
      const tsRaw = targetDate.toISOString();
      const tableName = 'public.plg_onto_spectrum';

      const results = await this.prisma.$queryRawUnsafe<SpectrumRawResult[]>(
        `SELECT "class", "wavelengths", "values" 
         FROM ${tableName}
         WHERE "eqpid" = $1 
           AND "ts" >= $2::timestamp - interval '2 second'
           AND "ts" <= $2::timestamp + interval '2 second'
           AND "lotid" = $3 
           AND "waferid" = $4 
           AND "point" = $5`,
        eqpId,
        tsRaw,
        lotId,
        String(waferId),
        Number(pointNumber),
      );

      if (!results || results.length === 0) {
        return [];
      }

      return results.map((r) => ({
        class: r.class,
        wavelengths: r.wavelengths,
        values: r.values,
      }));
    } catch (e) {
      console.error('[WaferService] Error fetching spectrum data:', e);
      return [];
    }
  }

  async getStatistics(params: WaferQueryParams) {
    const whereSql = this.buildUniqueWhere(params);
    if (!whereSql) return this.getEmptyStatistics();

    try {
      const result = await this.prisma.$queryRawUnsafe<StatsRawResult[]>(`
        SELECT
          MAX(t1) as t1_max, MIN(t1) as t1_min, AVG(t1) as t1_mean, STDDEV_SAMP(t1) as t1_std,
          MAX(gof) as gof_max, MIN(gof) as gof_min, AVG(gof) as gof_mean, STDDEV_SAMP(gof) as gof_std,
          MAX(z) as z_max, MIN(z) as z_min, AVG(z) as z_mean, STDDEV_SAMP(z) as z_std,
          MAX(srvisz) as s_max, MIN(srvisz) as s_min, AVG(srvisz) as s_mean, STDDEV_SAMP(srvisz) as s_std
        FROM public.plg_wf_flat
        ${whereSql}
        LIMIT 1
      `);

      const row = result[0] || ({} as StatsRawResult);
      if (row.t1_max === null) return this.getEmptyStatistics();

      const createStatItem = (prefix: string) => {
        const max = Number(row[`${prefix}_max`] || 0);
        const min = Number(row[`${prefix}_min`] || 0);
        const mean = Number(row[`${prefix}_mean`] || 0);
        const std = Number(row[`${prefix}_std`] || 0);
        const range = max - min;
        return {
          max,
          min,
          range,
          mean,
          stdDev: std,
          percentStdDev: mean !== 0 ? (std / mean) * 100 : 0,
          percentNonU: mean !== 0 ? (range / (2 * mean)) * 100 : 0,
        };
      };

      return {
        t1: createStatItem('t1'),
        gof: createStatItem('gof'),
        z: createStatItem('z'),
        srvisz: createStatItem('s'),
      };
    } catch (e) {
      console.error('Error in getStatistics:', e);
      return this.getEmptyStatistics();
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
      >(`
        SELECT * FROM public.plg_wf_flat ${whereSql} ORDER BY point
      `);

      if (!rawData || rawData.length === 0) return { headers: [], data: [] };

      const excludeCols = new Set([
        'eqpid',
        'lotid',
        'waferid',
        'serv_ts',
        'cassettercp',
        'stagercp',
        'stagegroup',
        'film',
        'datetime',
      ]);
      const allKeys = new Set<string>();
      rawData.forEach((row) => {
        Object.keys(row).forEach((k) => {
          if (!excludeCols.has(k) && row[k] !== null) allKeys.add(k);
        });
      });

      const customOrder = [
        'point',
        'mse',
        't1',
        'gof',
        'x',
        'y',
        'diex',
        'diey',
        'dierow',
        'diecol',
        'dienum',
        'diepointtag',
        'z',
        'srvisz',
      ];
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
      console.error('Error in getPointData:', e);
      return { headers: [], data: [] };
    }
  }

  async checkPdf(
    params: WaferQueryParams,
  ): Promise<{ exists: boolean; url: string | null }> {
    const { eqpId, lotId, waferId, servTs } = params;
    if (!eqpId || !servTs) return { exists: false, url: null };

    try {
      const ts = typeof servTs === 'string' ? servTs : servTs.toISOString();

      const results = await this.prisma.$queryRawUnsafe<PdfResult[]>(
        `SELECT file_uri FROM public.plg_wf_map 
          WHERE eqpid = $1 
            AND datetime >= $2::timestamp - interval '24 hours'
            AND datetime <= $2::timestamp + interval '24 hours'
          ORDER BY datetime DESC`,
        eqpId,
        ts,
      );

      if (!results || results.length === 0) {
        return { exists: false, url: null };
      }

      if (lotId) {
        const targetLot = lotId.trim();
        const targetLotUnderscore = targetLot.replace(/\./g, '_');

        const matched = results.find((r) => {
          if (!r.file_uri) return false;
          const uri = r.file_uri;

          const hasLot =
            uri.includes(targetLot) || uri.includes(targetLotUnderscore);

          let hasWafer = true;
          if (waferId) {
            hasWafer = uri.includes(String(waferId));
          }

          return hasLot && hasWafer;
        });

        if (matched) {
          return { exists: true, url: matched.file_uri };
        }
      } else {
        return { exists: true, url: results[0].file_uri };
      }
    } catch (e) {
      console.warn(`Failed to check PDF for ${String(eqpId)}:`, e);
    }
    return { exists: false, url: null };
  }

  async getResidualMap(params: WaferQueryParams): Promise<ResidualMapItem[]> {
    const { eqpId, lotId, waferId, ts } = params;
    if (!eqpId || !lotId || !waferId || !ts) return [];

    const targetDate = new Date(ts);
    const tsRaw = targetDate.toISOString();

    const rawData = await this.prisma.$queryRawUnsafe<ResidualRawResult[]>(
      `SELECT s.point, f.x, f.y, s.class, s.values 
        FROM public.plg_onto_spectrum s
        JOIN public.plg_wf_flat f 
          ON s.eqpid = f.eqpid 
          AND s.lotid = f.lotid 
          AND s.waferid = f.waferid::varchar 
          AND s.point = f.point
        WHERE s.eqpid = $1 
          AND s.ts >= $2::timestamp - interval '2 second'
          AND s.ts <= $2::timestamp + interval '2 second'
          AND f.serv_ts >= $2::timestamp - interval '5 second'
          AND f.serv_ts <= $2::timestamp + interval '5 second'
          AND s.lotid = $3 
          AND s.waferid = $4`,
      eqpId,
      tsRaw,
      lotId,
      String(waferId),
    );

    const mapData: Map<
      number,
      { exp: number[]; gen: number[]; x: number; y: number }
    > = new Map();

    rawData.forEach((r) => {
      if (!mapData.has(r.point)) {
        mapData.set(r.point, {
          exp: [],
          gen: [],
          x: r.x || 0,
          y: r.y || 0,
        });
      }
      const item = mapData.get(r.point);
      if (item) {
        if (r.class.toLowerCase() === 'exp') item.exp = r.values || [];
        if (r.class.toLowerCase() === 'gen') item.gen = r.values || [];
      }
    });

    const result: ResidualMapItem[] = [];
    mapData.forEach((val, point) => {
      if (
        val.exp.length > 0 &&
        val.gen.length > 0 &&
        val.exp.length === val.gen.length
      ) {
        const sumDiff = val.exp.reduce(
          (acc, curr, idx) => acc + Math.abs(curr - val.gen[idx]),
          0,
        );
        result.push({ point, x: val.x, y: val.y, residual: sumDiff });
      }
    });

    return result;
  }

  async getGoldenSpectrum(params: WaferQueryParams) {
    const { eqpId, cassetteRcp, stageGroup, film, pointId } = params;

    let sql = `
      SELECT s."wavelengths", s."values"
      FROM public.plg_onto_spectrum s
      JOIN public.plg_wf_flat f 
        ON s."eqpid" = f.eqpid 
        AND s."lotid" = f.lotid 
        AND s."waferid" = f.waferid::varchar 
        AND s."point" = f.point
      WHERE s."class" = 'EXP'
        AND f."eqpid" = $1
        AND f."cassettercp" = $2
        AND f."stagegroup" = $3
    `;

    const queryParams: (string | number)[] = [
      eqpId || '',
      cassetteRcp || '',
      stageGroup || '',
    ];

    if (pointId) {
      sql += ` AND s."point" = $${queryParams.length + 1}`;
      queryParams.push(Number(pointId));
    }

    if (film) {
      sql += ` AND f."film" = $${queryParams.length + 1}`;
      queryParams.push(film);
    }

    sql += ` ORDER BY f."gof" DESC LIMIT 10`;

    try {
      const samples = await this.prisma.$queryRawUnsafe<GoldenRawResult[]>(
        sql,
        ...queryParams,
      );

      if (samples.length === 0) return null;

      const baseWavelengths = samples[0].wavelengths;
      const valueSums: number[] = Array.from(
        { length: baseWavelengths.length },
        () => 0,
      );
      let count = 0;

      samples.forEach((sample) => {
        if (sample.values && sample.values.length === baseWavelengths.length) {
          sample.values.forEach((v: number, i: number) => (valueSums[i] += v));
          count++;
        }
      });

      if (count === 0) return null;

      return {
        wavelengths: baseWavelengths,
        values: valueSums.map((v) => v / count),
      };
    } catch (e) {
      console.error('Error fetching Golden Spectrum:', e);
      return null;
    }
  }

  async getAvailableMetrics(params: WaferQueryParams): Promise<string[]> {
    const { lotId, cassetteRcp, stageGroup, film } = params;

    if (!lotId || !cassetteRcp || !stageGroup || !film) {
      return [];
    }

    let allowedMetrics: string[] = [];
    try {
      const configResult = await this.prisma.$queryRaw<
        { metric_name: string }[]
      >`
        SELECT metric_name
        FROM public.cfg_lot_uniformity_metrics
        WHERE is_excluded = 'N'
      `;
      allowedMetrics = configResult.map((r) => r.metric_name);
    } catch {
      return [];
    }

    if (allowedMetrics.length === 0) return [];

    const countSelects = allowedMetrics
      .map((col) => `COUNT("${col}") as "${col}"`)
      .join(', ');

    const checkSql = `
      SELECT ${countSelects}
      FROM public.plg_wf_flat
      WHERE "lotid" = $1
        AND "cassettercp" = $2
        AND "stagegroup" = $3
        AND "film" = $4
    `;

    try {
      const countsResult = await this.prisma.$queryRawUnsafe<
        Record<string, number | bigint>[]
      >(checkSql, lotId, cassetteRcp, stageGroup, film);

      if (!countsResult || countsResult.length === 0) {
        return [];
      }

      const counts = countsResult[0];

      return allowedMetrics
        .filter((col) => {
          const val = counts[col];
          return val !== undefined && val !== null && Number(val) > 0;
        })
        .sort();
    } catch {
      return [];
    }
  }

  async getLotUniformityTrend(params: WaferQueryParams & { metric: string }) {
    const { lotId, cassetteRcp, stageGroup, film, metric } = params;

    if (!lotId || !cassetteRcp || !stageGroup || !film || !metric) {
      return [];
    }

    const metricCol = `"${metric}"`;

    const sql = `
      SELECT 
        f.waferid,
        f.point,
        f.${metricCol} as value,
        f.x, 
        f.y,
        f.dierow, 
        f.diecol
      FROM public.plg_wf_flat f
      WHERE f.lotid = $1
        AND f.cassettercp = $2
        AND f.stagegroup = $3
        AND f.film = $4
        AND f.${metricCol} IS NOT NULL
      ORDER BY f.waferid ASC, f.point ASC
    `;

    try {
      const results = await this.prisma.$queryRawUnsafe<LotTrendRawResult[]>(
        sql,
        lotId,
        cassetteRcp,
        stageGroup,
        film,
      );

      const grouped = new Map<
        number,
        {
          waferId: number;
          dataPoints: {
            point: number;
            value: number;
            x: number;
            y: number;
            dieRow: number | null;
            dieCol: number | null;
          }[];
        }
      >();

      results.forEach((r) => {
        if (!grouped.has(r.waferid)) {
          grouped.set(r.waferid, {
            waferId: r.waferid,
            dataPoints: [],
          });
        }

        const xVal = r.x !== null ? Number(r.x) : 0;
        const yVal = r.y !== null ? Number(r.y) : 0;

        grouped.get(r.waferid)?.dataPoints.push({
          point: r.point,
          value: r.value,
          x: xVal,
          y: yVal,
          dieRow: r.dierow,
          dieCol: r.diecol,
        });
      });

      return Array.from(grouped.values()).sort((a, b) => a.waferId - b.waferId);
    } catch (e) {
      console.error('Error fetching lot uniformity trend:', e);
      return [];
    }
  }

  private buildUniqueWhere(p: WaferQueryParams): string | null {
    if (!p.eqpId) return null;
    let sql = `WHERE eqpid = '${String(p.eqpId)}'`;

    if (p.servTs) {
      const ts =
        typeof p.servTs === 'string' ? p.servTs : p.servTs.toISOString();
      sql += ` AND serv_ts >= '${ts}'::timestamp - interval '24 hours'`;
      sql += ` AND serv_ts <= '${ts}'::timestamp + interval '24 hours'`;
    }

    if (p.startDate) {
      const s =
        typeof p.startDate === 'string'
          ? p.startDate
          : p.startDate.toISOString();
      sql += ` AND serv_ts >= '${s}'`;
    }
    if (p.endDate) {
      const e =
        typeof p.endDate === 'string' ? p.endDate : p.endDate.toISOString();
      sql += ` AND serv_ts <= '${e}'`;
    }

    if (p.lotId) sql += ` AND lotid = '${String(p.lotId)}'`;
    if (p.waferId) sql += ` AND waferid = ${Number(p.waferId)}`;
    if (p.cassetteRcp) sql += ` AND cassettercp = '${String(p.cassetteRcp)}'`;
    if (p.stageRcp) sql += ` AND stagercp = '${String(p.stageRcp)}'`;
    if (p.stageGroup) sql += ` AND stagegroup = '${String(p.stageGroup)}'`;
    if (p.film) sql += ` AND film = '${String(p.film)}'`;
    return sql;
  }

  private getEmptyStatistics() {
    const emptyItem = {
      max: 0,
      min: 0,
      range: 0,
      mean: 0,
      stdDev: 0,
      percentStdDev: 0,
      percentNonU: 0,
    };
    return { t1: emptyItem, gof: emptyItem, z: emptyItem, srvisz: emptyItem };
  }

  async getMatchingEquipments(params: WaferQueryParams): Promise<string[]> {
    const { site, sdwt, startDate, endDate, cassetteRcp, stageGroup, film } =
      params;

    if (!startDate || !endDate || !cassetteRcp) return [];

    const start =
      typeof startDate === 'string' ? new Date(startDate) : startDate;
    const end = typeof endDate === 'string' ? new Date(endDate) : endDate;

    let sql = `
      SELECT DISTINCT t1.eqpid
      FROM public.plg_wf_flat t1
      JOIN public.ref_equipment t2 ON t1.eqpid = t2.eqpid
      JOIN public.ref_sdwt t3 ON t2.sdwt = t3.sdwt
      WHERE t1.serv_ts >= $1 AND t1.serv_ts <= $2
        AND t1.cassettercp = $3
    `;

    const queryParams: (string | Date | number)[] = [start, end, cassetteRcp];
    let pIdx = 4;

    if (site) {
      sql += ` AND t3.site = $${pIdx++}`;
      queryParams.push(site);
    }
    if (sdwt) {
      sql += ` AND t3.sdwt = $${pIdx++}`;
      queryParams.push(sdwt);
    }
    if (stageGroup) {
      sql += ` AND t1.stagegroup = $${pIdx++}`;
      queryParams.push(stageGroup);
    }
    if (film) {
      sql += ` AND t1.film = $${pIdx++}`;
      queryParams.push(film);
    }

    sql += ` ORDER BY t1.eqpid`;

    try {
      const res = await this.prisma.$queryRawUnsafe<{ eqpid: string }[]>(
        sql,
        ...queryParams,
      );
      return res.map((r) => r.eqpid);
    } catch (e) {
      console.error('Error fetching matching equipments:', e);
      return [];
    }
  }

  async getComparisonData(
    params: WaferQueryParams,
  ): Promise<ComparisonRawResult[]> {
    const { startDate, endDate, cassetteRcp, stageGroup, film, targetEqps } =
      params;

    if (!targetEqps || !startDate || !endDate || !cassetteRcp) return [];
    const eqpList = targetEqps.split(',').map((e) => e.trim());

    let metrics: string[] = ['t1', 'gof', 'mse', 'thickness'];
    try {
      const conf = await this.prisma.$queryRaw<{ metric_name: string }[]>`
        SELECT metric_name FROM public.cfg_lot_uniformity_metrics WHERE is_excluded = 'N'
      `;
      if (conf.length > 0) metrics = conf.map((c) => c.metric_name);
    } catch (e) {
      console.warn('Failed to fetch metrics config:', e);
    }

    const selectCols = metrics.map((m) => `"${m}"`).join(', ');

    const start =
      typeof startDate === 'string' ? new Date(startDate) : startDate;
    const end = typeof endDate === 'string' ? new Date(endDate) : endDate;

    let sql = `
      SELECT eqpid, lotid, waferid, point, ${selectCols}
      FROM public.plg_wf_flat
      WHERE serv_ts >= $1 AND serv_ts <= $2
        AND cassettercp = $3
        AND eqpid IN (${eqpList.map((e) => `'${e}'`).join(',')})
    `;

    const queryParams: (string | Date | number)[] = [start, end, cassetteRcp];
    let pIdx = 4;

    if (stageGroup) {
      sql += ` AND stagegroup = $${pIdx++}`;
      queryParams.push(stageGroup);
    }
    if (film) {
      sql += ` AND film = $${pIdx++}`;
      queryParams.push(film);
    }

    sql += ` ORDER BY serv_ts DESC LIMIT 5000`;

    try {
      return await this.prisma.$queryRawUnsafe<ComparisonRawResult[]>(
        sql,
        ...queryParams,
      );
    } catch (e) {
      console.error('Error fetching comparison data:', e);
      return [];
    }
  }

  async getOpticalTrend(params: WaferQueryParams) {
    const { eqpId, startDate, endDate, cassetteRcp, stageGroup, film } = params;

    if (!eqpId || !startDate || !endDate) return [];

    try {
      const start = new Date(startDate);
      const end = new Date(endDate);

      const queryParams: (string | number | Date)[] = [eqpId, start, end];

      let filterClause = '';

      if (cassetteRcp) {
        filterClause += ` AND f.cassettercp = $${queryParams.length + 1}`;
        queryParams.push(cassetteRcp);
      }
      if (stageGroup) {
        filterClause += ` AND f.stagegroup = $${queryParams.length + 1}`;
        queryParams.push(stageGroup);
      }
      if (film) {
        filterClause += ` AND f.film = $${queryParams.length + 1}`;
        queryParams.push(film);
      }

      const sql = `
        SELECT 
          s.ts, s.lotid, s.waferid, s.point, s.wavelengths, s."values"
        FROM public.plg_onto_spectrum s
        JOIN public.plg_wf_flat f 
          ON s.eqpid = f.eqpid 
          AND s.lotid = f.lotid 
          AND s.waferid = f.waferid::varchar 
          AND s.point = f.point
        WHERE s.eqpid = $1
          AND s.ts >= $2
          AND s.ts <= $3
          ${filterClause}
        ORDER BY s.ts ASC
        LIMIT 2000
      `;

      const rawData = await this.prisma.$queryRawUnsafe<
        OpticalTrendRawResult[]
      >(sql, ...queryParams);

      return rawData.map((d) => {
        const values = d.values || [];
        const wavelengths = d.wavelengths || [];

        const totalIntensity = values.reduce((acc, v) => acc + v, 0);

        let maxVal = -Infinity;
        let minVal = Infinity;
        let maxIdx = 0;

        if (values.length === 0) {
          maxVal = 0;
          minVal = 0;
        } else {
          for (let i = 0; i < values.length; i++) {
            if (values[i] > maxVal) {
              maxVal = values[i];
              maxIdx = i;
            }
            if (values[i] < minVal) {
              minVal = values[i];
            }
          }
        }

        const peakWavelength = wavelengths[maxIdx] || 0;
        const darkNoise = minVal === Infinity ? 0 : minVal;

        return {
          ts: d.ts,
          lotId: d.lotid,
          waferId: d.waferid,
          point: d.point,
          totalIntensity,
          peakIntensity: maxVal === -Infinity ? 0 : maxVal,
          peakWavelength,
          darkNoise,
        };
      });
    } catch (e) {
      console.error('Error in getOpticalTrend:', e);
      return [];
    }
  }
}
