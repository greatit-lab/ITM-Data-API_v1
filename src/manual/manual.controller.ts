// ITM-Data-API/src/manual/manual.controller.ts
import { Controller, Get, Put, Body, Logger, HttpException, HttpStatus } from '@nestjs/common';
import { ManualService } from './manual.service';

@Controller('manual')
export class ManualController {
  // [추가] 디버깅을 위한 Logger 인스턴스
  private readonly logger = new Logger(ManualController.name);

  constructor(private readonly manualService: ManualService) {}

  @Get()
  async getManuals() {
    return await this.manualService.findAll();
  }

  @Put()
  async saveManuals(@Body() body: { sections: any[] }) {
    // 1. 요청 수신 로그 (섹션 개수 확인)
    const sectionCount = body.sections ? body.sections.length : 0;
    this.logger.log(`[Manual Save] Request received. Sections: ${sectionCount}`);

    try {
      // 2. 서비스 호출
      const result = await this.manualService.saveAll(body.sections);
      this.logger.log(`[Manual Save] Successfully saved ${sectionCount} sections.`);
      return result;
    } catch (error) {
      // 3. 에러 상세 로그
      this.logger.error(`[Manual Save] Failed. Error: ${error.message}`, error.stack);
      
      // 클라이언트에 명확한 에러 반환
      throw new HttpException(
        {
          status: HttpStatus.INTERNAL_SERVER_ERROR,
          error: 'Failed to save manual data',
          message: error.message,
        },
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }
}
