// itm-data-api/src/mail-recipient/mail-recipient.controller.ts
import {
  Controller,
  Get,
  Post,
  Put,
  Delete,
  Body,
  Param,
  Req,
} from '@nestjs/common';
import { Request } from 'express';
import { MailRecipientService } from './mail-recipient.service';
import { CreateMailRecipientDto, UpdateMailRecipientDto } from './dto/mail-recipient.dto';

interface RequestWithUser extends Request {
  user?: {
    userId: string;
    [key: string]: any;
  };
}
@Controller('mail-recipient')
export class MailRecipientController {
  constructor(private readonly mailRecipientService: MailRecipientService) {}

  // 전체 수신자 목록 (Admin/Manager용)
  @Get()
  async getAllRecipients() {
    return this.mailRecipientService.getAllRecipients();
  }

  // 시스템 수신자 목록 (읽기 전용)
  @Get('system')
  async getSystemRecipients() {
    return this.mailRecipientService.getSystemRecipients();
  }

  // 내가 등록한 수신자 목록
  @Get('my')
  async getMyRecipients(@Req() req: RequestWithUser) {
    const loginId = this.extractLoginId(req);
    return this.mailRecipientService.getMyRecipients(loginId);
  }

  // 수신자 추가
  @Post()
  async createRecipient(@Req() req: RequestWithUser, @Body() dto: CreateMailRecipientDto) {
    const loginId = this.extractLoginId(req);
    return this.mailRecipientService.createRecipient(loginId, dto);
  }

  // 수신자 수정
  @Put(':id')
  async updateRecipient(@Param('id') id: string, @Body() dto: UpdateMailRecipientDto) {
    return this.mailRecipientService.updateRecipient(Number(id), dto);
  }

  // 수신자 삭제
  @Delete(':id')
  async deleteRecipient(@Param('id') id: string) {
    return this.mailRecipientService.deleteRecipient(Number(id));
  }

  /**
   * JWT 토큰에서 loginId 추출
   * SSO 백엔드에서 전달된 Authorization 헤더의 JWT 토큰 디코딩
   */
  private extractLoginId(req: Request): string {
    const auth = req.headers.authorization;
    if (!auth) return '';

    try {
      const token = auth.replace('Bearer ', '');
      // JWT 페이로드 디코딩 (base64)
      const payload = JSON.parse(
        Buffer.from(token.split('.')[1], 'base64').toString(),
      );
      return payload.userId || payload.sub || '';
    } catch {
      return '';
    }
  }
}
