// ITM-Data-API_v1/src/wafer/wafer.service.ts
import {
  Injectable,
  InternalServerErrorException,
  NotFoundException,
  BadRequestException,
  Logger,
} from '@nestjs/common';
import { PrismaService } from '../prisma.service';
import { ArchivePrismaService } from '../archive-prisma.service';
import { Prisma } from '@prisma/client';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { execFile } from 'child_process';
import { promisify } from 'util';
import axios from 'axios';
import dayjs from 'dayjs';

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

  constructor(
    private prisma: PrismaService,
    private archivePrisma: ArchivePrismaService
  ) {}

  // =========================================================================
  // [추가됨] 스마트 라우팅 및 3단계 검증 로직
  // =========================================================================
  private determineDatabaseRoute(params: WaferQueryParams): { client: any, isArchive: boolean } {
    const thresholdMonths = Number(process.env.ARCHIVE_MONTHS_THRESHOLD || 2);
    const maxArchiveDays = Number(process.env.ARCHIVE_MAX_SEARCH_DAYS || 31);
    const now = dayjs();
    const boundaryDate = now.subtract(thresholdMonths, 'month').startOf('day');

    let start = now.subtract(7, 'day').startOf('day');
    let end = now.endOf('day');

    if (params.startDate) start = dayjs(params.startDate);
    else if (params.ts) start = dayjs(params.ts);
    else if (params.dateTime) start = dayjs(params.dateTime);
    else if (params.servTs) start = dayjs(params.servTs);

    if (params.endDate) end = dayjs(params.endDate);
    else if (params.ts) end = dayjs(params.ts);
    else if (params.dateTime) end = dayjs(params.dateTime);
    else if (params.servTs) end = dayjs(params.servTs);

    const isStartInArchive = start.isBefore(boundaryDate);
    const isEndInArchive = end.isBefore(boundaryDate);

    // [Zone C] 경계선 교차 에러
    if (isStartInArchive && !isEndInArchive && !params.lotId) {
      throw new BadRequestException(
        `라이브 데이터와 아카이브 데이터 구간을 교차하여 조회할 수 없습니다. (아카이브 기준일: ${boundaryDate.format('YYYY-MM-DD')})`
      );
    }

    // [Zone B] 아카이브 DB 라우팅
    if (isStartInArchive && isEndInArchive) {
      const diffDays = end.diff(start, 'day');
      // lotId 단건 조회일 경우는 기간 제한(Max Days)을 검증하지 않음
      if (diffDays > maxArchiveDays && !params.lotId && !params.ts && !params.dateTime && !params.servTs) {
        throw new BadRequestException(
          `아카이브 데이터는 DB 리소스 보호를 위해 최대 ${maxArchiveDays}일까지만 동시 조회가 가능합니다.`
        );
      }
      return { client: this.archivePrisma, isArchive: true };
    }

    // [Zone A] 라이브 DB 라우팅
    return { client: this.prisma, isArchive: false };
  }
  // =========================================================================

  private getSafeDates(start?: string | Date, end?: string | Date): { startDate: Date, endDate: Date } {
    const now = new Date();
    
    let startDate = start ? new Date(start) : new Date();
    if (isNaN(startDate.getTime()) || !start) {
        startDate = new Date();
        startDate.setDate(startDate.getDate() - 7);
    }
    startDate.setHours(0, 0, 0, 0);

    let endDate = end ? new Date(end) : now;
    if (isNaN(endDate.getTime())) {
        endDate = now;
    }
    endDate.setHours(23, 59, 59, 999);

    return { startDate, endDate };
  }

  private parseSafeDate(dateVal: string | Date | undefined): Date {
    if (!dateVal) return new Date();
    if (dateVal instanceof Date) return dateVal;
    
    const cleanStr = String(dateVal).replace(/\+/g, ' ');
    return new Date(cleanStr);
  }

  private getWaferFlatRoute(params: WaferQueryParams): {
    client: any;
    isArchive: boolean;
    tableExpr: string;
  } {
    /*
      Wafer Flat Data 조회 기준
      - 오늘 + 전일: VM DB public.plg_wf_flat
      - 전전일 이전: DBaaS DB public.v_plg_wf_flat_archive

      주의:
      - Wafer Map 이미지는 Archive 여부와 무관하게 VM DB public.plg_wf_map 기준입니다.
      - Spectrum 차트 조회는 기존 getSpectrum() 흐름을 유지합니다.
    */
    const liveCutoff = dayjs().startOf('day').subtract(1, 'day');

    let start = dayjs().subtract(1, 'day').startOf('day');
    let end = dayjs().endOf('day');

    if (params.startDate) start = dayjs(params.startDate);
    else if (params.servTs) start = dayjs(params.servTs);
    else if (params.dateTime) start = dayjs(params.dateTime);
    else if (params.ts) start = dayjs(params.ts);

    if (params.endDate) end = dayjs(params.endDate);
    else if (params.servTs) end = dayjs(params.servTs);
    else if (params.dateTime) end = dayjs(params.dateTime);
    else if (params.ts) end = dayjs(params.ts);

    const isArchive = end.isBefore(liveCutoff);

    if (isArchive) {
      return {
        client: this.archivePrisma,
        isArchive: true,
        tableExpr: 'public.v_plg_wf_flat_archive',
      };
    }

    return {
      client: this.prisma,
      isArchive: false,
      tableExpr: 'public.plg_wf_flat',
    };
  }

  private async resolveSpectrumTableName(params: { eqpId?: string, lotId?: string, endDate?: string | Date, ts?: string | Date }, dbClient: any): Promise<string> {
    let targetDate = new Date();
    
    if (params.ts) {
      targetDate = this.parseSafeDate(params.ts);
    } 
    else if (params.lotId && params.eqpId) {
      try {
        const res = await dbClient.$queryRawUnsafe(
          `SELECT MAX(serv_ts) as max_ts FROM public.plg_wf_flat WHERE TRIM(eqpid) = TRIM($1) AND TRIM(lotid) = TRIM($2)`,
          params.eqpId, params.lotId
        );
        if (res[0]?.max_ts) {
          targetDate = new Date(res[0].max_ts);
        } else if (params.endDate) {
          targetDate = this.parseSafeDate(params.endDate);
        }
      } catch(e) {
        if (params.endDate) targetDate = this.parseSafeDate(params.endDate);
      }
    } 
    else if (params.endDate) {
      targetDate = this.parseSafeDate(params.endDate);
    }

    const isToday = dayjs(targetDate).isSame(dayjs(), 'day');
    if (isToday) return 'public.plg_onto_spectrum';

    const yy = dayjs(targetDate).format('YYYY');
    const mm = dayjs(targetDate).format('MM');
    const partTable = `plg_onto_spectrum_y${yy}m${mm}`;

    try {
      const tableExists = await dbClient.$queryRawUnsafe(
        `SELECT EXISTS (SELECT FROM pg_tables WHERE schemaname = 'public' AND tablename = $1) as "exists"`,
        partTable
      );
      if (tableExists[0]?.exists === true || tableExists[0]?.exists === 'true') {
        return `public.${partTable}`;
      }
    } catch(e) {}
    
    return 'public.plg_onto_spectrum';
  }

  private async checkSpectrumExists(
    eqpId: string, 
    lotId: string, 
    waferId: string | number, 
    dateVal: string | Date,
    dbClient: any
  ): Promise<boolean> {
    try {
      if (!eqpId || !lotId || waferId === undefined || waferId === null) return false;

      const safeEqp = String(eqpId).trim();
      const safeLot = String(lotId).trim();
      const safeWafer = Number(waferId);

      const mainSql = `
        SELECT EXISTS(
          SELECT 1 FROM public.plg_onto_spectrum
          WHERE TRIM("eqpid") = $1
            AND TRIM("lotid") = $2
            AND "waferid"::integer = $3
        ) as "exists"
      `;
      const mainResult = await dbClient.$queryRawUnsafe(mainSql, safeEqp, safeLot, safeWafer);
      if (mainResult[0]?.exists === true || mainResult[0]?.exists === 'true') return true;

      if (!dateVal) return false;
      const targetDate = this.parseSafeDate(dateVal); 
      if (isNaN(targetDate.getTime())) return false;

      const yy = dayjs(targetDate).format('YYYY');
      const mm = dayjs(targetDate).format('MM');
      const partTable = `plg_onto_spectrum_y${yy}m${mm}`;
      
      const tableExists = await dbClient.$queryRawUnsafe(
        `SELECT EXISTS (SELECT FROM pg_tables WHERE schemaname = 'public' AND tablename = $1) as "exists"`,
        partTable
      );

      if (tableExists[0]?.exists === true || tableExists[0]?.exists === 'true') {
        const partSql = `
          SELECT EXISTS(
            SELECT 1 FROM public.${partTable}
            WHERE TRIM("eqpid") = $1
              AND TRIM("lotid") = $2
              AND "waferid"::integer = $3
          ) as "exists"
        `;
        const partResult = await dbClient.$queryRawUnsafe(partSql, safeEqp, safeLot, safeWafer);
        return partResult[0]?.exists === true || partResult[0]?.exists === 'true';
      }

      return false;
      
    } catch (error) {
      this.logger.warn(`Spectrum check failed for ${eqpId}-${lotId}:`, error);
      return false;
    }
  }

  async getDistinctValues(
    column: string,
    params: WaferQueryParams,
  ): Promise<string[]> {
    const route = this.getWaferFlatRoute(params);
    const dbClient = route.client;
    const table = route.tableExpr;
    const { eqpId, lotId, cassetteRcp, stageGroup, film, startDate, endDate } = params;

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
      const result = await dbClient.$queryRawUnsafe(
        sql,
        ...queryParams,
      );
      return result
        .map((r: any) => {
          if (r.val === null || r.val === undefined) return '';
          if (typeof r.val === 'object') return JSON.stringify(r.val);
          return String(r.val);
        })
        .filter((v: string) => v !== '');
    } catch (e) {
      this.logger.warn(`Error fetching distinct ${column}:`, e);
      return [];
    }
  }

  async getDistinctPoints(params: WaferQueryParams): Promise<string[]> {
    const route = this.getWaferFlatRoute(params);
    const dbClient = route.client;
    const tableExpr = route.tableExpr;
    const { eqpId, lotId, cassetteRcp, stageRcp, stageGroup, film, startDate, endDate } = params;

    let sql = `
      SELECT DISTINCT point
      FROM ${tableExpr}
      WHERE 1=1
    `;

    const queryParams: (string | number | Date)[] = [];

    if (eqpId) {
      sql += ` AND eqpid = $${queryParams.length + 1}`;
      queryParams.push(eqpId);
    }
    if (lotId) {
      sql += ` AND lotid = $${queryParams.length + 1}`;
      queryParams.push(lotId);
    }
    if (cassetteRcp) {
      sql += ` AND cassettercp = $${queryParams.length + 1}`;
      queryParams.push(cassetteRcp);
    }
    if (stageRcp) {
      sql += ` AND stagercp = $${queryParams.length + 1}`;
      queryParams.push(stageRcp);
    }
    if (stageGroup) {
      sql += ` AND stagegroup = $${queryParams.length + 1}`;
      queryParams.push(stageGroup);
    }
    if (film) {
      sql += ` AND film = $${queryParams.length + 1}`;
      queryParams.push(film);
    }

    if (!lotId && startDate && endDate) {
      const { startDate: s, endDate: e } = this.getSafeDates(startDate, endDate);
      sql += ` AND serv_ts >= $${queryParams.length + 1} AND serv_ts <= $${queryParams.length + 2}`;
      queryParams.push(s, e);
    }

    sql += ` ORDER BY point ASC`;

    try {
      const results = await dbClient.$queryRawUnsafe(
        sql,
        ...queryParams,
      );
      return results.map((r: any) => String(r.point));
    } catch (e) {
      this.logger.error('Error fetching distinct points:', e);
      return [];
    }
  }

  async getSpectrumTrend(params: WaferQueryParams): Promise<any[]> {
    const dbClient = this.determineDatabaseRoute(params).client;
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
      // 설정은 항상 메인(Live) DB에서 조회
      const configMetrics = await this.prisma.$queryRaw<
        { metric_name: string }[]
      >`SELECT metric_name FROM public.cfg_lot_uniformity_metrics WHERE is_excluded = 'N'`;
      if (configMetrics.length > 0) {
        dynamicColumns = configMetrics.map((r) => r.metric_name);
      }
    } catch (e) { /* ignore */ }

    if (!dynamicColumns.includes('gof')) dynamicColumns.push('gof');
    dynamicColumns = [...new Set(dynamicColumns)];

    const tableName = await this.resolveSpectrumTableName(params, dbClient);

    const queryParams: (string | number | Date)[] = [];
    const selectColumns = dynamicColumns.map((col) => `f."${col}"`).join(', ');

    let sql = `
      SELECT DISTINCT ON (s."waferid")
        s."waferid", s."wavelengths", s."values", s."ts", s."eqpid",
        f."serv_ts", f."lotid",
        ${selectColumns}
      FROM ${tableName} s
      JOIN public.plg_wf_flat f 
        ON TRIM(s.eqpid) = TRIM(f.eqpid) 
        AND TRIM(s.lotid) = TRIM(f.lotid) 
        AND s.waferid::integer = f."waferid"
        AND s."point" = f."point"
        AND s."ts" = f."datetime"
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

    sql += ` ORDER BY s."waferid" ASC, s."ts" DESC, f."serv_ts" DESC`;

    try {
      const results = await dbClient.$queryRawUnsafe(sql, ...queryParams);

      const series = results.map((row: any) => {
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
          name: `Slot #${row.waferid}`,
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

  async getSpectrumGen(params: WaferQueryParams) {
    const dbClient = this.determineDatabaseRoute(params).client;
    const { lotId, waferId, pointId, eqpId, ts } = params;
    if (!lotId || !waferId || !pointId || !eqpId || !ts) return null;

    try {
      const targetDate = this.parseSafeDate(ts);
      const tableName = await this.resolveSpectrumTableName({ ts }, dbClient);

      const results = await dbClient.$queryRawUnsafe(
        `SELECT "wavelengths", "values" 
         FROM ${tableName}
         WHERE TRIM("lotid") = TRIM($1) 
           AND "waferid"::integer = $2  
           AND "point" = $3    
           AND TRIM("eqpid") = TRIM($4)    
           AND date_trunc('second', "ts") = date_trunc('second', $5::timestamp)
           AND "class" = 'GEN'
         ORDER BY "ts" DESC
         LIMIT 1`,
        lotId,
        Number(waferId),
        Number(pointId),
        eqpId,
        targetDate,
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
        name: `Model (Slot #${waferId})`,
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

    const route = this.getWaferFlatRoute(params);
    const dbClient = route.client;
    const tableExpr = route.tableExpr;

    const { startDate: s, endDate: e } = this.getSafeDates(startDate, endDate);

    let whereClause = 'WHERE 1=1';
    const queryParams: any[] = [];
    let pIdx = 1;

    if (eqpId) { 
        whereClause += ` AND eqpid = $${pIdx++}`; 
        queryParams.push(eqpId); 
    }
    if (!lotId) {
        whereClause += ` AND serv_ts >= $${pIdx++} AND serv_ts <= $${pIdx++}`;
        queryParams.push(s, e);
    }
    if (lotId) { 
        whereClause += ` AND lotid ILIKE $${pIdx++}`; 
        queryParams.push(`%${lotId}%`); 
    }
    if (waferId) { 
        whereClause += ` AND waferid = $${pIdx++}`; 
        queryParams.push(Number(waferId)); 
    }
    if (cassetteRcp) { 
        whereClause += ` AND cassettercp = $${pIdx++}`; 
        queryParams.push(cassetteRcp); 
    }
    if (stageRcp) { 
        whereClause += ` AND stagercp = $${pIdx++}`; 
        queryParams.push(stageRcp); 
    }
    if (stageGroup) { 
        whereClause += ` AND stagegroup = $${pIdx++}`; 
        queryParams.push(stageGroup); 
    }
    if (film) { 
        whereClause += ` AND film = $${pIdx++}`; 
        queryParams.push(film); 
    }

    const countSql = `
      WITH RankedData AS (
        SELECT eqpid, lotid, waferid, cassettercp, stagercp, stagegroup, film,
               ROW_NUMBER() OVER(PARTITION BY eqpid, lotid, waferid, cassettercp, stagercp, stagegroup, film ORDER BY serv_ts DESC) as rn
        FROM ${tableExpr}
        ${whereClause}
      )
      SELECT COUNT(*)::int as total FROM RankedData WHERE rn = 1
    `;
    const countResult = await dbClient.$queryRawUnsafe(countSql, ...queryParams);
    const total = Number(countResult[0]?.total || 0);

    const dataSql = `
      WITH RankedData AS (
        SELECT eqpid, lotid, waferid, cassettercp, stagercp, stagegroup, film, serv_ts as "servTs", datetime,
               ROW_NUMBER() OVER(PARTITION BY eqpid, lotid, waferid, cassettercp, stagercp, stagegroup, film ORDER BY serv_ts DESC) as rn
        FROM ${tableExpr}
        ${whereClause}
      )
      SELECT * FROM RankedData
      WHERE rn = 1
      ORDER BY "servTs" DESC, waferid ASC
      LIMIT $${pIdx++} OFFSET $${pIdx++}
    `;
    const dataParams = [...queryParams, Number(pageSize), Number(page) * Number(pageSize)];
    const items = (await dbClient.$queryRawUnsafe(dataSql, ...dataParams)) as any[];

    const mapLookup = new Set<string>();

    if (items.length > 0) {
      const eqpIds: string[] = Array.from(
        new Set<string>(items.map((i: any) => String(i.eqpid))),
      );
      const datetimes: Date[] = items
        .map((i: any) => i.datetime)
        .filter((d: any): d is Date => d !== null && d !== undefined);
      
      if (datetimes.length > 0) {
        const maps = await this.prisma.plgWfMap.findMany({
          where: {
            eqpid: { in: eqpIds },
            datetime: { in: datetimes }
          },
          select: { eqpid: true, datetime: true }
        });
        maps.forEach((m: any) => mapLookup.add(`${m.eqpid}_${m.datetime.getTime()}`));
      }
    }

    const updatedItems = await Promise.all(items.map(async (i: any) => {
      const checkDate = i.datetime || i.servTs;
      let hasSpec = true;
      
      if (!route.isArchive && checkDate && i.eqpid && i.lotid && i.waferid !== null) {
        hasSpec = await this.checkSpectrumExists(i.eqpid, i.lotid, i.waferid, checkDate, dbClient);
      }

      return {
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
        hasSpectrum: hasSpec,
      };
    }));

    return {
      totalItems: total,
      items: updatedItems,
      isArchiveMode: route.isArchive
    };
  }

  async getPdfImage(params: WaferQueryParams): Promise<string> {
    const { eqpId, lotId, waferId, dateTime, pointNumber } = params;

    if (!eqpId || !dateTime || pointNumber === undefined) {
      throw new InternalServerErrorException('EQP ID, DateTime, and PointNumber are required.');
    }

    let tempPdfPath: string | null = null;
    let expectedOutputBase: string | null = null;
    let actualOutputFound: string | null = null;

    try {
      const pdfCheckResult = await this.checkPdf({ eqpId, lotId, waferId, dateTime });

      if (!pdfCheckResult.exists || !pdfCheckResult.url) {
        throw new NotFoundException('PDF file URI not found in database.');
      }

      const dbUrl = pdfCheckResult.url;
      let finalDownloadUrl = dbUrl;

      if (!dbUrl.startsWith('http')) {
        const baseUrl = process.env.FILE_SERVER_URL || 'http://localhost:8082';
        finalDownloadUrl = `${baseUrl.replace(/\/$/, '')}/${dbUrl.replace(/^\//, '')}`;
      }

      const cleanDateStr = String(dateTime).replace(/\+/g, '').replace(/[- :T.Z]/g, ''); 
      const safeLotId = (lotId || 'unknown').replace(/[^a-zA-Z0-9]/g, '_');
      const safeWaferId = waferId !== undefined ? String(waferId) : 'x';
      
      const cacheFileName = `map_${eqpId}_${safeLotId}_w${safeWaferId}_${cleanDateStr}_pt${pointNumber}.png`;
      const cacheFilePath = path.join(os.tmpdir(), cacheFileName);

      if (fs.existsSync(cacheFilePath) && fs.statSync(cacheFilePath).size > 0) {
        try { return fs.readFileSync(cacheFilePath).toString('base64'); } catch (e) {}
      }

      const tempId = `${Date.now()}_${Math.random().toString(36).substring(7)}`;
      tempPdfPath = path.join(os.tmpdir(), `temp_wafer_${tempId}.pdf`);
      expectedOutputBase = path.join(os.tmpdir(), `temp_img_${tempId}`);

      const response = await axios({
        url: encodeURI(finalDownloadUrl),
        method: 'GET',
        responseType: 'arraybuffer',
        proxy: false,
        timeout: 10000,
      }).catch(err => {
         throw new Error(`Axios 다운로드 실패 (${finalDownloadUrl}): ${err.message}`);
      });

      const fileBuffer = Buffer.from(response.data);
      if (fileBuffer.length === 0) throw new Error(`다운로드된 파일이 0 Byte 입니다.`);
      if (fileBuffer.subarray(0, 4).toString('utf8') !== '%PDF') throw new Error(`파일이 PDF 형식이 아닙니다.`);

      fs.writeFileSync(tempPdfPath, fileBuffer);

      const popplerBinPath = process.env.POPPLER_BIN_PATH;
      if (!popplerBinPath) throw new Error('POPPLER_BIN_PATH 환경변수 누락');
      
      let targetPage = Number(pointNumber) || 1;
      const execOptions = {
        timeout: 60000,
        cwd: popplerBinPath,
        env: { ...process.env, PATH: `${popplerBinPath};${process.env.PATH}` }
      };

      const pdfinfoExe = path.join(popplerBinPath, 'pdfinfo.exe');
      try {
        const { stdout } = await execFileAsync(pdfinfoExe, [tempPdfPath], execOptions);
        const pagesMatch = stdout.match(/Pages:\s+(\d+)/);
        if (pagesMatch) {
          const totalPages = parseInt(pagesMatch[1], 10);
          if (targetPage > totalPages) {
            throw new NotFoundException(`요청한 Point(${targetPage})가 PDF 총 페이지 수(${totalPages})를 초과하여 이미지가 존재하지 않습니다.`);
          }
        }
      } catch (infoErr: any) {
        if (infoErr instanceof NotFoundException) throw infoErr; 
        this.logger.warn(`pdfinfo 검증 실패, 강제 추출 시도: ${infoErr.message}`);
      }

      const pdftocairoExe = path.join(popplerBinPath, 'pdftocairo.exe');

      const runPoppler = async (page: number) => {
         try {
           await execFileAsync(pdftocairoExe, [ '-png', '-f', String(page), '-l', String(page), tempPdfPath!, expectedOutputBase! ], execOptions);
         } catch (err: any) {
           const stderrMsg = err.stderr ? err.stderr.toString().trim() : '';
           const crashCode = err.code || 'N/A';
           throw new Error(`[Code: ${crashCode}] [stderr: ${stderrMsg}]`);
         }
      };

      try {
        await runPoppler(targetPage);
      } catch (err: any) {
         this.logger.warn(`Poppler 변환 실패 (Page ${targetPage}): ${err.message}`);
         throw new NotFoundException(`Point ${targetPage} 맵 이미지를 생성할 수 없습니다.`);
      }

      const tempDir = os.tmpdir();
      const filesInTemp = fs.readdirSync(tempDir);
      const basePrefix = path.basename(expectedOutputBase);
      
      const generatedFileName = filesInTemp.find(f => {
          if (!f.startsWith(basePrefix) || !f.endsWith('.png')) return false;
          const match = f.match(/-0*(\d+)\.png$/);
          if (match) {
             return parseInt(match[1], 10) === targetPage;
          }
          return false;
      });

      const anyGenerated = filesInTemp.find(f => f.startsWith(basePrefix) && f.endsWith('.png'));

      if (!generatedFileName) {
        if (anyGenerated) {
           fs.unlinkSync(path.join(tempDir, anyGenerated)); 
        }
        throw new NotFoundException(`Point ${targetPage}에 대한 맵 이미지가 PDF 내에 존재하지 않습니다.`);
      }

      actualOutputFound = path.join(tempDir, generatedFileName);

      fs.copyFileSync(actualOutputFound, cacheFilePath);
      const imageBuffer = fs.readFileSync(actualOutputFound);
      
      try { 
        if (actualOutputFound && fs.existsSync(actualOutputFound)) fs.unlinkSync(actualOutputFound); 
        if (tempPdfPath && fs.existsSync(tempPdfPath)) fs.unlinkSync(tempPdfPath); 
      } catch {}

      return imageBuffer.toString('base64');

    } catch (e) {
      try { 
        if (tempPdfPath && fs.existsSync(tempPdfPath)) fs.unlinkSync(tempPdfPath); 
        if (actualOutputFound && fs.existsSync(actualOutputFound)) fs.unlinkSync(actualOutputFound);
      } catch {}
      
      if (e instanceof NotFoundException) throw e;
      
      const error = e as Error;
      this.logger.error(`[PDF Processing Failed] ${error.message}`);
      throw new InternalServerErrorException(`PDF 처리 오류: ${error.message}`);
    }
  }

  async checkPdf(
    params: WaferQueryParams,
  ): Promise<{ exists: boolean; url: string | null }> {
    const dbClient = this.prisma;
    const { eqpId, lotId, waferId, servTs, dateTime } = params;

    const targetTimeVal = dateTime || servTs;
    if (!eqpId || !targetTimeVal) return { exists: false, url: null };

    try {
      let targetDate: Date;
      if (targetTimeVal instanceof Date) {
        targetDate = targetTimeVal;
      } else {
        const strVal = String(targetTimeVal).replace(/\+/g, ' ').replace('T', ' ').replace('Z', '');
        targetDate = new Date(strVal);
      }

      if (isNaN(targetDate.getTime())) return { exists: false, url: null };

      const cleanDateStr = dayjs(targetDate).format('YYYY-MM-DD HH:mm:ss');

      const results = (await dbClient.$queryRawUnsafe(
        `SELECT file_uri, datetime FROM public.plg_wf_map 
         WHERE TRIM(eqpid) = TRIM($1)
           AND date_trunc('second', datetime) = date_trunc('second', $2::timestamp)
         ORDER BY datetime DESC`,
        eqpId,
        cleanDateStr
      )) as any[];

      if (!results || results.length === 0) {
        return { exists: false, url: null };
      }

      const getUri = (r: any) => r.fileUri || r.file_uri || r.file_url || null;
      let candidates: any[] = results;

      if (lotId) {
        const targetLot = lotId.trim().replace(/\./g, '_'); 
        candidates = results.filter((r: any) => {
          const uri = getUri(r);
          if (!uri) return false;
          
          const filename = path.basename(uri);
          const hasLot = filename.includes(lotId.trim()) || filename.includes(targetLot);
          const hasWafer = waferId ? filename.includes(String(waferId)) : true;
          return hasLot && hasWafer;
        });
      }

      if (candidates.length > 0 && getUri(candidates[0])) {
        return { exists: true, url: getUri(candidates[0]) };
      }

      if (results.length > 0 && getUri(results[0])) {
        return { exists: true, url: getUri(results[0]) };
      }

      return { exists: false, url: null };

    } catch (e) {
      this.logger.warn(`Failed to check PDF:`, e);
    }
    return { exists: false, url: null };
  }

  async getSpectrum(params: WaferQueryParams) {
    const dbClient = this.determineDatabaseRoute(params).client;
    const { eqpId, lotId, waferId, pointNumber, ts } = params;
    if (!eqpId || !lotId || !waferId || pointNumber === undefined || !ts) return [];

    try {
      const targetDate = this.parseSafeDate(ts);
      const tableName = await this.resolveSpectrumTableName({ ts }, dbClient);

      const results = await dbClient.$queryRawUnsafe(
        `SELECT "class", "wavelengths", "values" 
         FROM ${tableName}
         WHERE TRIM("eqpid") = TRIM($1) 
           AND date_trunc('second', "ts") = date_trunc('second', $2::timestamp)
           AND TRIM("lotid") = TRIM($3) 
           AND "waferid"::integer = $4 
           AND "point" = $5
         ORDER BY "class" ASC, "ts" DESC`,
        eqpId,
        targetDate,  
        lotId,
        Number(waferId),
        Number(pointNumber),
      );

      if (!results || results.length === 0) return [];

      const uniqueResults = new Map<string, SpectrumRawResult>();
      results.forEach((r: any) => {
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

  private buildUniqueWhereParams(p: WaferQueryParams): { sql: string, params: any[] } | null {
    if (!p.eqpId) return null;
    let sql = `WHERE eqpid = $1`;
    const params: any[] = [p.eqpId];
    let pIdx = 2;

    const targetDateStr = p.dateTime || p.servTs;

    if (targetDateStr) {
      const targetDate = this.parseSafeDate(targetDateStr);
      const cleanDateStr = dayjs(targetDate).format('YYYY-MM-DD HH:mm:ss.SSS');

      if (p.dateTime) {
        sql += ` AND datetime = $${pIdx}::timestamp`;
        params.push(cleanDateStr);
        pIdx++;
      } else if (p.servTs) {
        sql += ` AND serv_ts = $${pIdx}::timestamp`;
        params.push(cleanDateStr);
        pIdx++;
      }

      if (p.lotId) { sql += ` AND lotid = $${pIdx++}`; params.push(String(p.lotId)); }
      if (p.waferId !== undefined && p.waferId !== null) { sql += ` AND waferid = $${pIdx++}`; params.push(Number(p.waferId)); }
      if (p.cassetteRcp) { sql += ` AND cassettercp = $${pIdx++}`; params.push(String(p.cassetteRcp)); }
      if (p.stageRcp) { sql += ` AND stagercp = $${pIdx++}`; params.push(String(p.stageRcp)); }
      if (p.stageGroup) { sql += ` AND stagegroup = $${pIdx++}`; params.push(String(p.stageGroup)); }
      if (p.film) { sql += ` AND film = $${pIdx++}`; params.push(String(p.film)); }

    } else {
      if (!p.lotId) {
        if (p.startDate) {
          const { startDate: s } = this.getSafeDates(p.startDate);
          sql += ` AND serv_ts >= $${pIdx++}`; params.push(s);
        }
        if (p.endDate) {
          const { endDate: e } = this.getSafeDates(undefined, p.endDate);
          sql += ` AND serv_ts <= $${pIdx++}`; params.push(e);
        }
      }
      
      if (p.lotId) { sql += ` AND lotid = $${pIdx++}`; params.push(String(p.lotId)); }
      if (p.waferId !== undefined && p.waferId !== null) { sql += ` AND waferid = $${pIdx++}`; params.push(Number(p.waferId)); }
      if (p.cassetteRcp) { sql += ` AND cassettercp = $${pIdx++}`; params.push(String(p.cassetteRcp)); }
      if (p.stageRcp) { sql += ` AND stagercp = $${pIdx++}`; params.push(String(p.stageRcp)); }
      if (p.stageGroup) { sql += ` AND stagegroup = $${pIdx++}`; params.push(String(p.stageGroup)); }
      if (p.film) { sql += ` AND film = $${pIdx++}`; params.push(String(p.film)); }
    }
    return { sql, params };
  }

  async getStatistics(params: WaferQueryParams) {
    const route = this.getWaferFlatRoute(params);
    const dbClient = route.client;
    const tableExpr = route.tableExpr;
    const columnTableName = route.isArchive ? 'v_plg_wf_flat_archive' : 'plg_wf_flat';
    const where = this.buildUniqueWhereParams(params);
    if (!where) return {};

    try {
      const validColumnsResult = await dbClient.$queryRawUnsafe(
        `SELECT column_name 
         FROM information_schema.columns 
         WHERE table_name = $1 AND table_schema = 'public'`,
        columnTableName,
      );

      const validColumnSet = new Set(
        validColumnsResult.map((r: any) => r.column_name.toLowerCase()),
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

      const sql = `SELECT ${selectParts} FROM ${tableExpr} ${where.sql} LIMIT 1`;
      const result = await dbClient.$queryRawUnsafe(sql, ...where.params);
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
    const route = this.getWaferFlatRoute(params);
    const dbClient = route.client;
    const tableExpr = route.tableExpr;
    const where = this.buildUniqueWhereParams(params);
    if (!where) return { headers: [], data: [] };

    try {
      const sql = `SELECT * FROM ${tableExpr} ${where.sql} ORDER BY point`;
      const rawData = await dbClient.$queryRawUnsafe(sql, ...where.params);

      if (!rawData || rawData.length === 0) return { headers: [], data: [] };

      const excludeCols = new Set(['eqpid', 'lotid', 'waferid', 'serv_ts', 'cassettercp', 'stagercp', 'stagegroup', 'film', 'datetime']);
      const allKeys = new Set<string>();
      rawData.forEach((row: any) => {
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

      const data = rawData.map((row: any) => headers.map((h) => row[h]));
      return { headers, data };
    } catch (e) {
      this.logger.error('Error in getPointData:', e);
      return { headers: [], data: [] };
    }
  }

  async getMatchingEquipments(params: WaferQueryParams): Promise<string[]> {
    const dbClient = this.determineDatabaseRoute(params).client;
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
      const res = await dbClient.$queryRawUnsafe(sql, ...queryParams);
      return res.map((r: any) => r.eqpid);
    } catch (e) {
      this.logger.error('Error fetching matching equipments:', e);
      return [];
    }
  }

  async getComparisonData(params: WaferQueryParams): Promise<ComparisonRawResult[]> {
    const dbClient = this.determineDatabaseRoute(params).client;
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
      return await dbClient.$queryRawUnsafe(sql, ...queryParams);
    } catch (e) {
      this.logger.error('Error fetching comparison data:', e);
      return [];
    }
  }

  async getOpticalTrend(params: WaferQueryParams) {
    const dbClient = this.determineDatabaseRoute(params).client;
    const { eqpId, startDate, endDate, cassetteRcp, stageGroup, film } = params;
    if (!eqpId || !startDate || !endDate) return [];

    try {
      const tableName = await this.resolveSpectrumTableName(params, dbClient);

      const { startDate: s, endDate: e } = this.getSafeDates(startDate, endDate);
      const queryParams: (string | number | Date)[] = [eqpId, s, e];
      let filterClause = '';
      if (cassetteRcp) { filterClause += ` AND f.cassettercp = $${queryParams.length + 1}`; queryParams.push(cassetteRcp); }
      if (stageGroup) { filterClause += ` AND f.stagegroup = $${queryParams.length + 1}`; queryParams.push(stageGroup); }
      if (film) { filterClause += ` AND f.film = $${queryParams.length + 1}`; queryParams.push(film); }

      const sql = `
        SELECT s.ts, s.lotid, s.waferid, s.point, s.wavelengths, s."values"
        FROM ${tableName} s
        JOIN public.plg_wf_flat f 
          ON TRIM(s.eqpid) = TRIM(f.eqpid) 
          AND TRIM(s.lotid) = TRIM(f.lotid) 
          AND s.waferid::integer = f.waferid
          AND s.point = f.point
          AND s.ts = f.datetime
        WHERE TRIM(s.eqpid) = TRIM($1)
          AND s.ts >= $2
          AND s.ts <= $3
          ${filterClause}
        ORDER BY s.ts ASC
        LIMIT 2000
      `;

      const rawData = await dbClient.$queryRawUnsafe(sql, ...queryParams);
      return rawData.map((d: any) => {
        const values = d.values || [];
        const wavelengths = d.wavelengths || [];
        const totalIntensity = values.reduce((acc: number, v: number) => acc + v, 0);
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
    const dbClient = this.determineDatabaseRoute(params).client;
    const where = this.buildUniqueWhereParams(params);
    if (!where) return [];
    const metric = params.metric || 't1';

    try {
      const data = await dbClient.$queryRawUnsafe(
        `SELECT point, x, y, "${metric}" as val FROM public.plg_wf_flat ${where.sql}`, ...where.params
      );
      if (!data.length) return [];
      const validData = data.filter((d: any) => d.val !== null);
      if (!validData.length) return [];
      const mean = validData.reduce((acc: number, cur: any) => acc + cur.val, 0) / validData.length;
      return validData.map((d: any) => ({ point: d.point, x: d.x, y: d.y, residual: d.val - mean }));
    } catch (e) {
      this.logger.error('Error in getResidualMap:', e);
      return [];
    }
  }

  async getGoldenSpectrum(params: WaferQueryParams): Promise<GoldenSpectrumResponse | null> {
    const dbClient = this.determineDatabaseRoute(params).client;
    const { eqpId, lotId, pointId } = params;
    
    if (!eqpId || !lotId || !pointId) return null;

    try {
      const bestGofSql = `
            SELECT waferid, datetime FROM public.plg_wf_flat
            WHERE eqpid = $1 AND lotid = $2 AND point = $3
              AND gof IS NOT NULL
            ORDER BY gof DESC LIMIT 1
        `;
      const queryParams: any[] = [eqpId, lotId, Number(pointId)];

      const bestData = await dbClient.$queryRawUnsafe(bestGofSql, ...queryParams);
      if (!bestData || bestData.length === 0) return null;

      const targetWaferId = bestData[0].waferid;
      const targetTs = bestData[0].datetime;

      const tableName = await this.resolveSpectrumTableName({ ts: targetTs }, dbClient);

      const spectrumSql = `
            SELECT wavelengths, "values" 
            FROM ${tableName}
            WHERE TRIM(eqpid) = TRIM($1) 
              AND TRIM(lotid) = TRIM($2) 
              AND waferid::integer = $3 
              AND point = $4 
              AND class = 'EXP' 
            ORDER BY ts DESC 
            LIMIT 1
        `;
      const spectrum = await dbClient.$queryRawUnsafe(
        spectrumSql, 
        eqpId, 
        lotId, 
        Number(targetWaferId), 
        Number(pointId)
      );

      if (!spectrum || spectrum.length === 0) return null;
      return { wavelengths: spectrum[0].wavelengths, values: spectrum[0].values };
    } catch (e) {
      this.logger.error('Error in getGoldenSpectrum:', e);
      return null;
    }
  }

  async getAvailableMetrics(params: WaferQueryParams): Promise<string[]> {
    const dbClient = this.determineDatabaseRoute(params).client;
    try {
      const configMetrics = await this.prisma.$queryRaw<{ metric_name: string }[]>`SELECT metric_name FROM public.cfg_lot_uniformity_metrics WHERE is_excluded = 'N' ORDER BY metric_name`;
      let candidates = configMetrics.map((m) => m.metric_name);
      if (candidates.length === 0) return [];

      const tableColumns = await dbClient.$queryRawUnsafe(
        `SELECT column_name FROM information_schema.columns WHERE table_name = 'plg_wf_flat' AND table_schema = 'public'`
      );
      const validColumnSet = new Set(tableColumns.map((c: any) => c.column_name.toLowerCase()));
      candidates = candidates.filter((metric) => validColumnSet.has(metric.toLowerCase()));
      if (candidates.length === 0) return [];

      const where = this.buildUniqueWhereParams({ ...params, waferId: undefined });
      if (!where) return candidates;

      const countSelects = candidates.map((col) => `COUNT("${col}") as "${col}"`).join(', ');
      const countResults = await dbClient.$queryRawUnsafe(
        `SELECT ${countSelects} FROM public.plg_wf_flat ${where.sql}`, ...where.params
      );
      if (!countResults || countResults.length === 0) return [];

      const counts = countResults[0];
      return candidates.filter((metric) => Number(counts[metric]) > 0);
    } catch (e) {
      this.logger.error('Failed to fetch available metrics:', e);
      return [];
    }
  }

  async getLotUniformityTrend(params: WaferQueryParams & { metric: string }): Promise<any[]> {
    const dbClient = this.determineDatabaseRoute(params).client;
    const { metric, ...rest } = params;
    const targetMetric = metric || 't1';
    const where = this.buildUniqueWhereParams({ ...rest, waferId: undefined });
    if (!where) return [];

    try {
      const results = await dbClient.$queryRawUnsafe(
        `SELECT waferid, point, x, y, dierow, diecol, "${targetMetric}" as value 
             FROM public.plg_wf_flat ${where.sql} 
             ORDER BY waferid, point`, ...where.params
      );
      const grouped: Record<string, any[]> = {};
      results.forEach((row: any) => {
        const wid = String(row.waferid);
        if (!grouped[wid]) grouped[wid] = [];
        grouped[wid].push(row);
      });
      return Object.keys(grouped).map((wid) => ({
        waferId: Number(wid),
        dataPoints: grouped[wid].map((p: any) => ({
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
