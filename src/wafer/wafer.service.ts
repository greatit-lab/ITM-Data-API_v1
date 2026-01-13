// ITM-Data-API/src/wafer/wafer.service.ts
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

interface PopplerModule {
  convert: (file: string, options: any) => Promise<any>;
}

@Injectable()
export class WaferService {
  constructor(private prisma: PrismaService) {}

  // 1. Distinct Values 조회 (필터 목록)
  async getDistinctValues(
    column: string,
    params: WaferQueryParams
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

    if (startDate && endDate) {
      whereClause += ` AND serv_ts >= $${queryParams.length + 1} AND serv_ts <= $${queryParams.length + 2}`;
      queryParams.push(new Date(startDate), new Date(endDate));
    }

    const sql = `SELECT DISTINCT "${colName}" as val FROM ${table} ${whereClause} ORDER BY "${colName}" DESC LIMIT 100`;

    try {
      const result = await this.prisma.$queryRawUnsafe<{ val: unknown }[]>(
        sql,
        ...queryParams
      );
      return result
        .map((r) => {
          if (r.val === null || r.val === undefined) return '';
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
        ...queryParams
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
        ON s."lotid" = f."lotid" 
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

  // [수정] 통계 로직 개선: T1 의존성 제거 및 존재하지 않는 컬럼 조회 방지
  async getStatistics(params: WaferQueryParams) {
    const whereSql = this.buildUniqueWhere(params);
    if (!whereSql) return {};

    try {
      // 1. 실제 DB에 존재하는 컬럼 목록 조회 (42703 에러 방지)
      const validColumnsResult = await this.prisma.$queryRawUnsafe<{ column_name: string }[]>(
        `SELECT column_name 
         FROM information_schema.columns 
         WHERE table_name = 'plg_wf_flat' AND table_schema = 'public'`
      );
      
      const validColumnSet = new Set(validColumnsResult.map(r => r.column_name.toLowerCase()));

      // 2. 기본 컬럼 정의 (thickness 등 오류 유발 가능성 있는 컬럼 포함)
      let targetColumns = ['t1', 'gof', 'z', 'srvisz', 'mse', 'thickness'];

      // 3. DB 설정에서 추가 메트릭 가져오기
      try {
        const configMetrics = await this.prisma.$queryRaw<{ metric_name: string }[]>`
          SELECT metric_name FROM public.cfg_lot_uniformity_metrics WHERE is_excluded = 'N'
        `;
        if (configMetrics.length > 0) {
          const configNames = configMetrics.map(c => c.metric_name.toLowerCase());
          targetColumns = [...new Set([...targetColumns, ...configNames])];
        }
      } catch (e) {
        console.warn('Failed to fetch metric config, using defaults.');
      }

      // 4. 제외 목록 필터링 + 실제 DB 존재 여부 확인
      const excludeCols = ['x', 'y', 'diex', 'diey', 'dierow', 'diecol', 'dienum', 'diepointtag', 'point', 'lotid', 'waferid', 'eqpid', 'serv_ts', 'datetime'];
      
      targetColumns = targetColumns.filter(col => {
        const lowerCol = col.toLowerCase();
        // 제외 목록에 없으면서 && 실제 DB에 존재하는 컬럼만 선택
        return !excludeCols.includes(lowerCol) && validColumnSet.has(lowerCol);
      });

      if (targetColumns.length === 0) {
        return {}; // 조회할 컬럼이 하나도 없으면 빈 객체 반환
      }

      // 5. 동적 SQL 생성
      const selectParts = targetColumns.map(col => `
        MAX("${col}") as "${col}_max", 
        MIN("${col}") as "${col}_min", 
        AVG("${col}") as "${col}_mean", 
        STDDEV_SAMP("${col}") as "${col}_std"
      `).join(', ');

      const sql = `
        SELECT ${selectParts}
        FROM public.plg_wf_flat
        ${whereSql}
        LIMIT 1
      `;

      const result = await this.prisma.$queryRawUnsafe<StatsRawResult[]>(sql);
      const row = result[0] || {};

      // 6. 결과 매핑
      const statsResult: Record<string, any> = {};

      for (const col of targetColumns) {
        // 데이터가 없으면(null) 건너뜀
        if (row[`${col}_max`] === null || row[`${col}_max`] === undefined) {
          continue;
        }

        const max = Number(row[`${col}_max`] || 0);
        const min = Number(row[`${col}_min`] || 0);
        const mean = Number(row[`${col}_mean`] || 0);
        const std = Number(row[`${col}_std`] || 0);
        const range = max - min;

        statsResult[col] = {
          max,
          min,
          range,
          mean,
          stdDev: std,
          percentStdDev: mean !== 0 ? (std / mean) * 100 : 0,
          percentNonU: mean !== 0 ? (range / (2 * mean)) * 100 : 0,
        };
      }

      return statsResult;

    } catch (e) {
      console.error('Error in getStatistics:', e);
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

  private buildUniqueWhere(p: WaferQueryParams): string | null {
    if (!p.eqpId) return null;
    let sql = `WHERE eqpid = '${String(p.eqpId)}'`;

    const targetDate = p.dateTime || p.servTs;

    if (targetDate) {
      let dateStr = "";
      if (typeof targetDate === 'string') {
        dateStr = targetDate;
      } else {
        dateStr = targetDate.toISOString();
      }
      
      const cleanDateStr = dateStr.replace('T', ' ').replace('Z', '').split('.')[0];
      
      sql += ` AND datetime >= '${cleanDateStr}'::timestamp - interval '2 second'`;
      sql += ` AND datetime <= '${cleanDateStr}'::timestamp + interval '2 second'`;

      if (p.lotId) sql += ` AND lotid = '${String(p.lotId)}'`;
      if (p.waferId) sql += ` AND waferid = ${Number(p.waferId)}`;
      
    } 
    else {
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
    }
    return sql;
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

  // [추가] 누락된 메서드 구현 1: getResidualMap
  async getResidualMap(params: WaferQueryParams): Promise<ResidualMapItem[]> {
    const whereSql = this.buildUniqueWhere(params);
    if (!whereSql) return [];
    
    // 기본적으로 't1'을 사용하되 params.metric이 있으면 그것을 사용
    const metric = params.metric || 't1'; 
    
    try {
      const data = await this.prisma.$queryRawUnsafe<{ point: number, x: number, y: number, val: number }[]>(
        `SELECT point, x, y, "${metric}" as val FROM public.plg_wf_flat ${whereSql}`
      );
      
      if (!data.length) return [];
      
      const validData = data.filter(d => d.val !== null);
      if (!validData.length) return [];

      const mean = validData.reduce((acc, cur) => acc + cur.val, 0) / validData.length;
      
      return validData.map(d => ({
        point: d.point,
        x: d.x,
        y: d.y,
        residual: d.val - mean
      }));
    } catch (e) {
      console.error('Error in getResidualMap:', e);
      return [];
    }
  }

  // [수정] Golden Ref 조회 로직: 'GOLDEN' 클래스가 아닌 '최고 GOF(Best Known)' 데이터 조회
  async getGoldenSpectrum(params: WaferQueryParams): Promise<GoldenSpectrumResponse | null> {
    const { eqpId, lotId, pointId, cassetteRcp, stageGroup } = params;
    
    // 조건 필수값 체크
    if (!eqpId || !lotId || !pointId) return null;
    
    try {
        // 1. 해당 조건(Lot, RCP, Stage, Point)에서 GOF가 가장 높은(Best) 웨이퍼 조회
        const bestGofSql = `
            SELECT waferid
            FROM public.plg_wf_flat
            WHERE eqpid = $1
              AND lotid = $2
              AND point = $3
              ${cassetteRcp ? "AND cassettercp = $4" : ""}
              ${stageGroup ? "AND stagegroup = $5" : ""}
              AND gof IS NOT NULL
            ORDER BY gof DESC
            LIMIT 1
        `;
        
        const queryParams: any[] = [eqpId, lotId, Number(pointId)];
        if (cassetteRcp) queryParams.push(cassetteRcp);
        if (stageGroup) queryParams.push(stageGroup);

        const bestData = await this.prisma.$queryRawUnsafe<{ waferid: unknown }[]>(bestGofSql, ...queryParams);
        
        if (!bestData || bestData.length === 0) return null; // 조건에 맞는 데이터가 없음

        const targetWaferId = String(bestData[0].waferid);

        // 2. 찾은 Best Wafer의 스펙트럼 데이터 조회 (EXP 클래스 기준)
        // plg_onto_spectrum 테이블에서 해당 웨이퍼/포인트의 스펙트럼 가져오기
        const spectrumSql = `
            SELECT wavelengths, "values"
            FROM public.plg_onto_spectrum
            WHERE eqpid = $1
              AND lotid = $2
              -- [중요] WaferID 타입 이슈 방지를 위해 ::varchar 캐스팅 제거하고 파라미터 바인딩 사용
              AND waferid = $3 
              AND point = $4
              AND class = 'EXP' 
            ORDER BY ts DESC
            LIMIT 1
        `;

        const spectrum = await this.prisma.$queryRawUnsafe<SpectrumRawResult[]>(
            spectrumSql, 
            eqpId, 
            lotId, 
            targetWaferId, 
            Number(pointId)
        );
        
        if (!spectrum || spectrum.length === 0) return null;
        
        return {
            wavelengths: spectrum[0].wavelengths,
            values: spectrum[0].values
        };
    } catch(e) { 
        console.error('Error in getGoldenSpectrum:', e);
        return null; 
    }
  }

  // [수정] Metric 목록 조회 로직: DB 컬럼 존재 + 실제 데이터 존재(Count > 0) 체크
  async getAvailableMetrics(params: WaferQueryParams): Promise<string[]> {
    try {
        // 1. 설정 테이블에서 Metric 목록 조회
        const configMetrics = await this.prisma.$queryRaw<{metric_name: string}[]>`
            SELECT metric_name FROM public.cfg_lot_uniformity_metrics WHERE is_excluded = 'N' ORDER BY metric_name
        `;
        
        if (configMetrics.length === 0) return [];

        // 2. 실제 테이블(plg_wf_flat) 컬럼 목록 조회 (스키마 확인)
        const tableColumns = await this.prisma.$queryRawUnsafe<{ column_name: string }[]>(
            `SELECT column_name 
             FROM information_schema.columns 
             WHERE table_name = 'plg_wf_flat' AND table_schema = 'public'`
        );

        const validColumnSet = new Set(tableColumns.map(c => c.column_name.toLowerCase()));

        // 3. 교집합 필터링
        const candidates = configMetrics
            .map(m => m.metric_name)
            .filter(metric => validColumnSet.has(metric.toLowerCase()));

        if (candidates.length === 0) return [];

        // 4. [핵심] 실제 데이터 존재 여부 확인 (Count > 0)
        // waferId 조건은 제외하고 Lot 단위로 체크
        const whereSql = this.buildUniqueWhere({ 
            ...params, 
            waferId: undefined 
        }); 
        
        if (!whereSql) return candidates; 

        // 동적 Count 쿼리 생성
        const countSelects = candidates.map(col => `COUNT("${col}") as "${col}"`).join(', ');
        const countQuery = `SELECT ${countSelects} FROM public.plg_wf_flat ${whereSql}`;
        
        const countResults = await this.prisma.$queryRawUnsafe<Record<string, number | bigint>[]>(countQuery);
        
        if (!countResults || countResults.length === 0) return [];
        
        const counts = countResults[0];
        
        // 데이터가 있는 컬럼만 최종 반환
        return candidates.filter(metric => Number(counts[metric]) > 0);

    } catch (e) { 
        console.warn('Failed to fetch available metrics with check', e);
        return ['t1', 'gof', 'mse', 'thickness']; 
    }
  }

  // [추가] 누락된 메서드 구현 4: getLotUniformityTrend
  async getLotUniformityTrend(params: WaferQueryParams & { metric: string }): Promise<any[]> {
    const { metric, ...rest } = params;
    const targetMetric = metric || 't1';
    
    // lot 단위 조회를 위해 waferId 조건 제거
    const whereSql = this.buildUniqueWhere({ ...rest, waferId: undefined }); 
    if (!whereSql) return [];
    
    try {
        const results = await this.prisma.$queryRawUnsafe<any[]>(
            `SELECT waferid, point, x, y, dierow, diecol, "${targetMetric}" as value 
             FROM public.plg_wf_flat ${whereSql} 
             ORDER BY waferid, point`
        );
        
        // WaferID 별로 그룹화
        const grouped: Record<string, any[]> = {};
        results.forEach(row => {
            const wid = String(row.waferid);
            if (!grouped[wid]) grouped[wid] = [];
            grouped[wid].push(row);
        });
        
        const series = Object.keys(grouped).map(wid => ({
            waferId: Number(wid),
            dataPoints: grouped[wid].map(p => ({
                point: p.point,
                value: p.value,
                x: p.x,
                y: p.y,
                dieRow: p.dierow,
                dieCol: p.diecol
            }))
        }));
        
        return series;
    } catch(e) { 
        console.error('Error in getLotUniformityTrend:', e);
        return []; 
    }
  }
}
