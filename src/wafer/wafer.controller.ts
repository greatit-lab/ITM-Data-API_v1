// ITM-Data-API/src/wafer/wafer.controller.ts
import { Controller, Get, Query } from '@nestjs/common';
import { WaferService, WaferQueryParams } from './wafer.service';

// [수정] 'api/wafer' -> 'wafer' (Global Prefix 'api'와 결합되어 /api/wafer 가 됨)
@Controller('wafer')
export class WaferController {
  constructor(private readonly waferService: WaferService) {}

  @Get('distinct-values')
  getDistinctValues(@Query() query: WaferQueryParams & { field: string }) {
    return this.waferService.getDistinctValues(query.field, query);
  }

  @Get('distinct-points')
  getDistinctPoints(@Query() query: WaferQueryParams) {
    return this.waferService.getDistinctPoints(query);
  }

  @Get('spectrum-trend')
  getSpectrumTrend(@Query() query: WaferQueryParams) {
    return this.waferService.getSpectrumTrend(query);
  }

  @Get('spectrum-gen')
  getSpectrumGen(@Query() query: WaferQueryParams) {
    return this.waferService.getSpectrumGen(query);
  }

  @Get('flat-data')
  getFlatData(@Query() query: WaferQueryParams) {
    return this.waferService.getFlatData(query);
  }

  @Get('pdf-image')
  async getPdfImage(@Query() query: WaferQueryParams) {
    const base64Image = await this.waferService.getPdfImage(query);
    return { image: base64Image };
  }

  @Get('check-pdf')
  checkPdf(@Query() query: WaferQueryParams) {
    return this.waferService.checkPdf(query);
  }

  @Get('spectrum')
  getSpectrum(@Query() query: WaferQueryParams) {
    return this.waferService.getSpectrum(query);
  }

  @Get('statistics')
  getStatistics(@Query() query: WaferQueryParams) {
    return this.waferService.getStatistics(query);
  }

  @Get('point-data')
  getPointData(@Query() query: WaferQueryParams) {
    return this.waferService.getPointData(query);
  }

  @Get('residual-map')
  getResidualMap(@Query() query: WaferQueryParams) {
    return this.waferService.getResidualMap(query);
  }

  @Get('golden-spectrum')
  getGoldenSpectrum(@Query() query: WaferQueryParams) {
    return this.waferService.getGoldenSpectrum(query);
  }

  @Get('available-metrics')
  getAvailableMetrics(@Query() query: WaferQueryParams) {
    return this.waferService.getAvailableMetrics(query);
  }

  @Get('lot-uniformity-trend')
  getLotUniformityTrend(@Query() query: WaferQueryParams & { metric: string }) {
    return this.waferService.getLotUniformityTrend(query);
  }

  @Get('matching-equipments')
  getMatchingEquipments(@Query() query: WaferQueryParams) {
    return this.waferService.getMatchingEquipments(query);
  }

  @Get('comparison-data')
  getComparisonData(@Query() query: WaferQueryParams) {
    return this.waferService.getComparisonData(query);
  }

  @Get('optical-trend')
  getOpticalTrend(@Query() query: WaferQueryParams) {
    return this.waferService.getOpticalTrend(query);
  }
}
