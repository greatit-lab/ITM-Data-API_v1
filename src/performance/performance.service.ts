// backend/src/performance/performance.service.ts
import { Injectable } from '@nestjs/common';
import { DataApiService } from '../common/data-api.service';

export interface PerformanceTrendResponse {
  eqpId: string;
  timestamp: string | Date;
  cpuUsage: number;
  memoryUsage: number;
  cpuTemp: number;
  gpuTemp: number;
  fanSpeed: number;
}

export interface ProcessMemoryResponse {
  timestamp: string | Date;
  processName: string;
  memoryUsageMB: number;
}

export interface ItmAgentTrendResponse {
  timestamp: string | Date;
  eqpId: string;
  memoryUsageMB: number;
}

@Injectable()
export class PerformanceService {
  // [중요] Data API의 Controller 경로와 일치해야 함 ('performance')
  private readonly DOMAIN = 'performance';

  constructor(private readonly dataApiService: DataApiService) {}

  // 1. 성능 트렌드 이력 (PerformanceTrendView용)
  async getHistory(
    startDate: string,
    endDate: string,
    eqpids: string,
    intervalSeconds: number = 300,
  ): Promise<PerformanceTrendResponse[]> {
    const params = {
      startDate,
      endDate,
      eqpids,
      intervalSeconds,
    };
    
    const result = await this.dataApiService.request<PerformanceTrendResponse[]>(
      this.DOMAIN,
      'get',
      'history',
      undefined,
      params,
    );
    return result || [];
  }

  // 2. 프로세스 메모리 이력 (ProcessMemoryView용)
  async getProcessHistory(
    startDate: string,
    endDate: string,
    eqpId: string,
    intervalSeconds?: number,
  ): Promise<ProcessMemoryResponse[]> {
    const params = {
      startDate,
      endDate,
      eqpId,
      // [수정] Data API는 'interval'이라는 파라미터명을 사용하므로 매핑 필요
      interval: intervalSeconds, 
    };

    // [중요] Data API 엔드포인트: /performance/process-history
    const result = await this.dataApiService.request<ProcessMemoryResponse[]>(
      this.DOMAIN,
      'get',
      'process-history',
      undefined,
      params,
    );
    return result || [];
  }

  // 3. ITM Agent 메모리 트렌드 (ItmAgentMemoryView용)
  async getItmAgentTrend(
    site: string,
    sdwt: string,
    eqpid: string,
    startDate: string,
    endDate: string,
    intervalSeconds?: number,
  ): Promise<ItmAgentTrendResponse[]> {
    const params = {
      site,
      sdwt,
      // [수정] Data API 파라미터명 확인 (보통 eqpId 사용)
      eqpId: eqpid, 
      startDate,
      endDate,
      // [수정] Data API 파라미터명 확인 (보통 interval 사용 가능성 있음, 여기선 intervalSeconds 유지 가정)
      // 만약 Data API가 interval을 쓴다면 interval: intervalSeconds 로 수정 필요
      interval: intervalSeconds, 
    };

    const result = await this.dataApiService.request<ItmAgentTrendResponse[]>(
      this.DOMAIN,
      'get',
      'itm-agent-trend',
      undefined,
      params,
    );
    return result || [];
  }
}
