// ITM-DATA-API/src/alert/alert.service.ts
import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma.service';

@Injectable()
export class AlertService {
  // 로그 추적을 위한 Logger 인스턴스 생성
  private readonly logger = new Logger(AlertService.name);

  constructor(private prisma: PrismaService) {}

  // 1. 알림 생성
  async createAlert(userId: string, message: string, link: string) {
    try {
      return await this.prisma.sysAlert.create({
        data: {
          userId,
          type: 'BOARD_REPLY',
          message,
          link,
          isRead: false,
        },
      });
    } catch (error) {
      // 알림 생성 실패는 핵심 로직(게시글 작성 등)을 방해하면 안 됨 -> 로그만 남김
      this.logger.error(`[CreateAlert Error] User: ${userId} | Msg: ${error.message}`, error.stack);
      return null;
    }
  }

  // 2. 내 알림 목록 조회 (안 읽은 것 우선)
  async getMyAlerts(userId: string) {
    try {
      // 테이블이 없으면 여기서 에러가 발생함
      return await this.prisma.sysAlert.findMany({
        where: { userId },
        orderBy: [
          { isRead: 'asc' },      // 안 읽은 것 먼저
          { createdAt: 'desc' },  // 최신순
        ],
        take: 20, // 최근 20개만 조회
      });
    } catch (error) {
      this.logger.error(`[GetMyAlerts Error] User: ${userId} | Msg: ${error.message}`, error.stack);
      // 에러 발생 시 500 에러 대신 빈 배열 반환하여 프론트엔드 정상 렌더링 유지
      return [];
    }
  }

  // 3. 알림 읽음 처리
  async readAlert(alertId: number) {
    try {
      return await this.prisma.sysAlert.update({
        where: { id: alertId },
        data: { isRead: true },
      });
    } catch (error) {
      this.logger.error(`[ReadAlert Error] ID: ${alertId} | Msg: ${error.message}`, error.stack);
      return null;
    }
  }

  // 4. 안 읽은 알림 개수
  async getUnreadCount(userId: string) {
    try {
      return await this.prisma.sysAlert.count({
        where: {
          userId,
          isRead: false,
        },
      });
    } catch (error) {
      this.logger.error(`[UnreadCount Error] User: ${userId} | Msg: ${error.message}`, error.stack);
      // 에러 시 0개로 반환
      return 0;
    }
  }
}
