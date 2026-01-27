// ITM-Data-API/src/manual/manual.controller.ts
import { Controller, Get, Put, Body, Logger } from '@nestjs/common';
import { ManualService } from './manual.service';

@Controller('manual')
export class ManualController {
  // [추가] 디버깅을 위한 로거 생성
  private readonly logger = new Logger(ManualController.name);

  constructor(private readonly manualService: ManualService) {}

  // 조회: GET /manual (또는 /api/manual - Global Prefix 설정에 따름)
  @Get()
  async getManuals() {
    return await this.manualService.findAll();
  }

  // 저장: PUT /manual
  @Put()
  async saveManuals(@Body() body: { sections: any[] }) {
    // [추가] 저장 요청 로그 출력 (요청 데이터 크기 및 개수 확인용)
    const sectionCount = body.sections ? body.sections.length : 0;
    this.logger.log(`[Manual] Save request received. Sections count: ${sectionCount}`);

    try {
      const result = await this.manualService.saveAll(body.sections);
      this.logger.log(`[Manual] Successfully saved ${sectionCount} sections.`);
      return result;
    } catch (error) {
      this.logger.error(`[Manual] Failed to save manual. Error: ${error.message}`, error.stack);
      throw error;
    }
  }
}
