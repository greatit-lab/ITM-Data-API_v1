// ITM-Data-API_v1/src/board/board.service.ts
import { Injectable, NotFoundException, Logger, InternalServerErrorException } from '@nestjs/common';
import { PrismaService } from '../prisma.service';
import { AlertService } from '../alert/alert.service';
import { CreatePostDto, CreateCommentDto } from './dto/board.dto';
import dayjs from 'dayjs';
import utc from 'dayjs/plugin/utc';

// [설정] UTC 플러그인 활성화
dayjs.extend(utc);

@Injectable()
export class BoardService {
  private readonly logger = new Logger(BoardService.name);

  constructor(
    private prisma: PrismaService,
    private alertService: AlertService,
  ) {}

  /**
   * [Helper] 현재 시간을 KST(한국 시간) 기준 Date 객체로 변환
   */
  private getKstDate(): Date {
    return dayjs().utc().add(9, 'hour').toDate();
  }

  // 1. 게시글 목록 조회
  async getPosts(page: number, limit: number, category?: string, search?: string) {
    try {
      const skip = (page - 1) * limit;
      
      const whereCondition: any = {};
      if (category && category !== 'ALL') {
        whereCondition.category = category;
      }
      if (search) {
        whereCondition.OR = [
          { title: { contains: search, mode: 'insensitive' } },
          { content: { contains: search, mode: 'insensitive' } },
          { authorId: { contains: search, mode: 'insensitive' } },
        ];
      }

      const [total, posts] = await Promise.all([
        this.prisma.sysBoard.count({ where: whereCondition }),
        this.prisma.sysBoard.findMany({
          where: whereCondition,
          skip,
          take: limit,
          orderBy: { createdAt: 'desc' },
          include: {
            _count: { select: { comments: true } },
            author: true, 
          },
        }),
      ]);

      const authorIds = [...new Set(posts.map(p => p.authorId))];
      const adminUsers = await this.prisma.cfgAdminUser.findMany({
        where: { loginId: { in: authorIds } },
        select: { loginId: true, role: true }
      });

      const roleMap = new Map(adminUsers.map(u => [u.loginId, u.role]));

      const mappedPosts = posts.map(post => ({
        ...post,
        user: { 
          ...post.author,
          role: roleMap.get(post.authorId) || 'USER'
        }
      }));

      return {
        data: mappedPosts,
        meta: {
          total,
          page,
          lastPage: Math.ceil(total / limit),
        },
      };
    } catch (error) {
      this.logger.error(`Failed to getPosts: ${error.message}`, error.stack);
      throw new InternalServerErrorException('게시글 목록을 불러오는 중 오류가 발생했습니다.');
    }
  }

  // 2. 게시글 상세 조회
  async getPostById(postId: number) {
    try {
      const post = await this.prisma.sysBoard.findUnique({
        where: { postId },
        include: {
          author: true,
          comments: {
            orderBy: { createdAt: 'asc' },
            include: {
              author: true
            }
          },
          files: true,
        },
      });

      if (!post) throw new NotFoundException(`Post #${postId} not found`);

      // 조회수 증가
      this.prisma.sysBoard.update({
        where: { postId },
        data: { views: { increment: 1 } },
      }).catch(e => this.logger.warn(`Failed to update views: ${e.message}`));

      const userIds = new Set<string>();
      userIds.add(post.authorId);
      post.comments.forEach(c => userIds.add(c.authorId));

      const adminUsers = await this.prisma.cfgAdminUser.findMany({
        where: { loginId: { in: [...userIds] } },
        select: { loginId: true, role: true }
      });
      const roleMap = new Map(adminUsers.map(u => [u.loginId, u.role]));

      const mappedPost = {
        ...post,
        user: { 
          ...post.author,
          role: roleMap.get(post.authorId) || 'USER'
        },
        comments: post.comments.map(comment => ({
          ...comment,
          user: { 
            ...comment.author,
            role: roleMap.get(comment.authorId) || 'USER'
          }
        }))
      };

      return mappedPost;
    } catch (error) {
      if (error instanceof NotFoundException) throw error;
      this.logger.error(`Failed to getPostById(${postId}): ${error.message}`, error.stack);
      throw new InternalServerErrorException('게시글 상세 정보를 불러오는 중 오류가 발생했습니다.');
    }
  }

  // 3. 게시글 작성 (알림 타겟팅 고도화 적용)
  async createPost(data: CreatePostDto) {
    try {
      let initialStatus: string | undefined = undefined;
      if (data.category === 'NOTICE') {
        initialStatus = 'ANSWERED';
      }

      const nowKst = this.getKstDate();

      const newPost = await this.prisma.sysBoard.create({
        data: {
          title: data.title,
          content: data.content,
          authorId: data.authorId,
          category: data.category || 'QNA',
          isSecret: data.isSecret || 'N',
          isPopup: data.isPopup || 'N',
          status: initialStatus,
          createdAt: nowKst,
        },
      });

      // ==========================================
      // [알림 발송 로직 분기 처리]
      // ==========================================
      if (newPost.category === 'NOTICE') {
        // 분기 1: 공지사항인 경우 -> I:Vision의 모든 사용자(관리자, 매니저, 유저, 게스트)에게 발송
        try {
          // 1-1. 시스템 접속 이력이 있는 모든 사용자
          const allUsers = await this.prisma.sysUser.findMany({ select: { loginId: true } });
          // 1-2. 아직 접속 이력이 없는 승인된 게스트 계정들까지 모두 긁어옴
          const allGuests = await this.prisma.cfgGuestAccess.findMany({ select: { loginId: true } });
          
          // 중복 제거를 위해 Set 사용
          const uniqueUserIds = new Set([
            ...allUsers.map(u => u.loginId),
            ...allGuests.map(g => g.loginId)
          ]);

          // 작성자 본인 제외 (선택 사항이지만 일반적으로 본인이 쓴 글의 알림은 받지 않음)
          uniqueUserIds.delete(newPost.authorId);

          const alertData = Array.from(uniqueUserIds).map(userId => ({
            userId: userId,
            type: 'NOTICE_POST',
            message: `[새로운 공지사항] ${newPost.title}`,
            link: `/support/qna/${newPost.postId}`,
            isRead: false,
            createdAt: nowKst
          }));
          
          if (alertData.length > 0) {
            await this.prisma.sysAlert.createMany({ data: alertData });
          }
        } catch (alertError) {
          this.logger.error(`전체 공지 알림 발송 실패: ${alertError.message}`);
        }

      } else {
        // 분기 2: 일반 게시글(QnA, 버그 리포트 등)인 경우 -> '관리자' 및 '매니저' 권한 보유자에게만 발송
        try {
          const adminUsers = await this.prisma.cfgAdminUser.findMany({
            // 역할이 Admin 이거나 Manager 인 사용자 조회
            where: { role: { in: ['ADMIN', 'MANAGER'] } },
            select: { loginId: true }
          });

          // 본인이 관리자/매니저인데 스스로 문의글을 남긴 경우 자기 자신에게는 알림이 안 가도록 필터링
          const targetAdmins = adminUsers
            .map(u => u.loginId)
            .filter(id => id !== newPost.authorId);

          if (targetAdmins.length > 0) {
            const alertData = targetAdmins.map(adminId => ({
              userId: adminId,
              type: 'NEW_BOARD_POST',
              message: `[새로운 게시글 등록] ${newPost.title}`,
              link: `/support/qna/${newPost.postId}`,
              isRead: false,
              createdAt: nowKst
            }));
            
            await this.prisma.sysAlert.createMany({ data: alertData });
          }
        } catch (adminAlertError) {
           this.logger.error(`관리자 새 글 알림 발송 실패: ${adminAlertError.message}`);
        }
      }

      return newPost;
    } catch (error) {
      this.logger.error(`Failed to createPost: ${error.message}`, error.stack);
      throw new InternalServerErrorException('게시글 작성 중 오류가 발생했습니다.');
    }
  }

  // 4. 게시글 수정
  async updatePost(postId: number, data: any) {
    try {
      const nowKst = this.getKstDate();

      return await this.prisma.sysBoard.update({
        where: { postId },
        data: {
          title: data.title,
          content: data.content,
          category: data.category,
          isSecret: data.isSecret,
          isPopup: data.isPopup,
          updatedAt: nowKst, 
        },
      });
    } catch (error) {
      this.logger.error(`Failed to updatePost: ${error.message}`, error.stack);
      throw new InternalServerErrorException('게시글 수정 중 오류가 발생했습니다.');
    }
  }

  // 5. 게시글 상태 변경
  async updateStatus(postId: number, status: string) {
    try {
      const board = await this.prisma.sysBoard.findUnique({ where: { postId } });
      if (!board) throw new NotFoundException('게시글을 찾을 수 없습니다.');

      const nowKst = this.getKstDate();

      const updated = await this.prisma.sysBoard.update({
        where: { postId },
        data: { 
          status,
          updatedAt: nowKst 
        },
      });

      // 게시글이 처리 완료되었을 때 작성자에게 알림 발송
      if ((status === 'Complete' || status === 'ANSWERED') && board.status !== status) {
        await this.alertService.createAlert(
          board.authorId,
          `문의하신 게시글 [${board.title}]이(가) 완료 처리되었습니다.`,
          `/support/qna/${postId}`
        );
      }

      return updated;
    } catch (error) {
      this.logger.error(`Failed to updateStatus: ${error.message}`, error.stack);
      throw new InternalServerErrorException('상태 변경 중 오류가 발생했습니다.');
    }
  }

  // 6. 게시글 삭제
  async deletePost(postId: number) {
    try {
      return await this.prisma.$transaction([
        this.prisma.sysBoardComment.deleteMany({ where: { postId } }),
        this.prisma.sysBoard.delete({ where: { postId } }),
      ]);
    } catch (error) {
      this.logger.error(`Failed to deletePost: ${error.message}`, error.stack);
      throw new InternalServerErrorException('게시글 삭제 중 오류가 발생했습니다.');
    }
  }

  // 7. 댓글 작성
  async createComment(data: CreateCommentDto) {
    try {
      const board = await this.prisma.sysBoard.findUnique({ where: { postId: Number(data.postId) } });
      if (!board) throw new NotFoundException('게시글을 찾을 수 없습니다.');

      const nowKst = this.getKstDate();

      const result = await this.prisma.$transaction(async (tx) => {
        const comment = await tx.sysBoardComment.create({
          data: {
            postId: Number(data.postId),
            authorId: data.authorId,
            content: data.content,
            parentId: data.parentId ? Number(data.parentId) : null,
            createdAt: nowKst, 
          },
        });

        if (data.status) {
          await tx.sysBoard.update({
            where: { postId: Number(data.postId) },
            data: { 
              status: data.status,
              updatedAt: nowKst 
            },
          });
        }

        return comment;
      });

      // [작동 확인] 댓글 작성자가 원글 작성자가 아닐 경우에만 원글 작성자에게 알림 발송 (완벽 작동 중)
      if (board.authorId !== data.authorId) {
        await this.alertService.createAlert(
          board.authorId,
          `작성하신 게시글 [${board.title}]에 새로운 답변/댓글이 등록되었습니다.`,
          `/support/qna/${data.postId}`
        );
      }

      return result;
    } catch (error) {
      this.logger.error(`Failed to createComment: ${error.message}`, error.stack);
      throw new InternalServerErrorException('댓글 작성 중 오류가 발생했습니다.');
    }
  }

  // 8. 댓글 수정
  async updateComment(commentId: number, content: string) {
    try {
      return await this.prisma.sysBoardComment.update({
        where: { commentId },
        data: { content },
      });
    } catch (error) {
      this.logger.error(`Failed to updateComment: ${error.message}`, error.stack);
      throw new InternalServerErrorException('댓글 수정 중 오류가 발생했습니다.');
    }
  }

  // 9. 댓글 삭제
  async deleteComment(commentId: number) {
    try {
      return await this.prisma.sysBoardComment.delete({
        where: { commentId },
      });
    } catch (error) {
      this.logger.error(`Failed to deleteComment: ${error.message}`, error.stack);
      throw new InternalServerErrorException('댓글 삭제 중 오류가 발생했습니다.');
    }
  }

  // 10. 팝업 공지 조회
  async getPopupNotices() {
    try {
      return await this.prisma.sysBoard.findMany({
        where: {
          category: 'NOTICE',
          isPopup: 'Y',
        },
        orderBy: { createdAt: 'desc' },
      });
    } catch (error) {
      this.logger.error(`Failed to getPopupNotices: ${error.message}`, error.stack);
      throw new InternalServerErrorException('팝업 공지 조회 중 오류가 발생했습니다.');
    }
  }
}
