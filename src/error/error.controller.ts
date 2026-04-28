// ITM-Data-API_v1/src/error/error.controller.ts
import { Controller, Get, Query } from '@nestjs/common'; 
import { ErrorService, ErrorQueryParams } from './error.service';

@Controller('error')
export class ErrorController {
  constructor(private readonly errorService: ErrorService) {}

  @Get('summary')
  async getErrorSummary(
    @Query('site') site?: string,
    @Query('sdwt') sdwt?: string,
    @Query('startDate') startDate?: string,
    @Query('endDate') endDate?: string,
    @Query('start') start?: string, // [해결 핵심] start 파라미터 추가
    @Query('end') end?: string,     // [해결 핵심] end 파라미터 추가
    @Query('eqpId') eqpId?: string,
  ) {
    const params: ErrorQueryParams = {
      site,
      sdwt,
      // start가 있으면 start를, 없으면 startDate를 사용하도록 양방향 방어 적용
      start: start || startDate, 
      end: end || endDate,
      eqpId,
    };
    return this.errorService.getErrorSummary(params);
  }

  @Get('trend')
  async getErrorTrend(
    @Query('site') site?: string,
    @Query('sdwt') sdwt?: string,
    @Query('startDate') startDate?: string,
    @Query('endDate') endDate?: string,
    @Query('start') start?: string, // [해결 핵심] start 파라미터 추가
    @Query('end') end?: string,     // [해결 핵심] end 파라미터 추가
    @Query('eqpId') eqpId?: string,
  ) {
    const params: ErrorQueryParams = {
      site,
      sdwt,
      start: start || startDate,
      end: end || endDate,
      eqpId,
    };
    return this.errorService.getErrorTrend(params);
  }

  @Get('list')
  async getErrorList(
    @Query('site') site?: string,
    @Query('sdwt') sdwt?: string,
    @Query('startDate') startDate?: string,
    @Query('endDate') endDate?: string,
    @Query('start') start?: string, // [해결 핵심] start 파라미터 추가
    @Query('end') end?: string,     // [해결 핵심] end 파라미터 추가
    @Query('eqpId') eqpId?: string,
    @Query('page') page?: number,
    @Query('pageSize') pageSize?: number,
    @Query('limit') limit?: number, // limit 파라미터도 예비로 받아둠
  ) {
    const params = {
      site,
      sdwt,
      start: start || startDate,
      end: end || endDate,
      eqpId,
      page,
      // pageSize나 limit 어떤 이름으로 들어와도 처리되도록 방어
      pageSize: pageSize || limit, 
    };
    return this.errorService.getErrorList(params);
  }
}
