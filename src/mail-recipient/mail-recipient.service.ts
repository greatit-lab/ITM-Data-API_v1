// itm-data-api/src/mail-recipient/mail-recipient.service.ts
import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma.service';
import { CreateMailRecipientDto, UpdateMailRecipientDto } from './dto/mail-recipient.dto';

@Injectable()
export class MailRecipientService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * 전체 수신자 목록 조회 (Admin/Manager용)
   */
  async getAllRecipients() {
    return this.prisma.cfgMailRecipient.findMany({
      where: { isActive: true },
      orderBy: { createdAt: 'desc' },
    });
  }

  /**
   * 시스템 수신자 목록 조회 (읽기 전용)
   */
  async getSystemRecipients() {
    return this.prisma.cfgMailRecipient.findMany({
      where: { recipientType: 'SYSTEM', isActive: true },
      orderBy: { createdAt: 'desc' },
    });
  }

  /**
   * 내가 등록한 수신자 목록 조회
   */
  async getMyRecipients(loginId: string) {
    return this.prisma.cfgMailRecipient.findMany({
      where: { loginId, isActive: true },
      orderBy: { createdAt: 'desc' },
    });
  }

  /**
   * 활성 수신자 이메일 목록 조회 (메일 발송용)
   * - SYSTEM 수신자 + USER 수신자 모두 포함
   */
  async getActiveRecipientEmails() {
    const recipients = await this.prisma.cfgMailRecipient.findMany({
      where: { isActive: true },
      select: { recipientEmail: true },
    });
    return recipients.map((r) => r.recipientEmail);
  }

  /**
   * 수신자 추가
   */
  async createRecipient(
    loginId: string,
    dto: CreateMailRecipientDto,
  ) {
    return this.prisma.cfgMailRecipient.create({
      data: {
        loginId,
        recipientEmail: dto.recipientEmail,
        recipientName: dto.recipientName,
        recipientType: dto.recipientType || 'USER',
      },
    });
  }

  /**
   * 수신자 수정
   */
  async updateRecipient(id: number, dto: UpdateMailRecipientDto) {
    const recipient = await this.prisma.cfgMailRecipient.findUnique({
      where: { id },
    });
    if (!recipient) {
      throw new NotFoundException(`Recipient with ID ${id} not found`);
    }
    return this.prisma.cfgMailRecipient.update({
      where: { id },
      data: dto,
    });
  }

  /**
   * 수신자 삭제 (소프트 삭제: isActive = false)
   */
  async deleteRecipient(id: number) {
    const recipient = await this.prisma.cfgMailRecipient.findUnique({
      where: { id },
    });
    if (!recipient) {
      throw new NotFoundException(`Recipient with ID ${id} not found`);
    }
    return this.prisma.cfgMailRecipient.update({
      where: { id },
      data: { isActive: false },
    });
  }
}
