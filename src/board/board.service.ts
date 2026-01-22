// ITM-Data-API/src/board/board.service.ts
import { Injectable, NotFoundException, Logger, InternalServerErrorException } from '@nestjs/common';
import { PrismaService } from '../prisma.service';
import { AlertService } from '../alert/alert.service'; // [추가] 알림 서비스
import { CreatePostDto, CreateCommentDto } from './dto/board.dto';

@Injectable()
export class BoardService {
  private readonly logger = new Logger(BoardService.name);

  constructor(
    private prisma: PrismaService,
    private alertService: AlertService, // [추가] 주입
  ) {}

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

  // 3. 게시글 작성
  async createPost(data: CreatePostDto) {
    try {
      // [팝업 공지 자동 해제] 팝업 공지가 선택된 경우, 기존 공지들의 팝업 설정을 모두 해제
      if (data.category === 'NOTICE' && data.isPopup === 'Y') {
        await this.prisma.sysBoard.updateMany({
          where: { category: 'NOTICE', isPopup: 'Y' },
          data: { isPopup: 'N' }
        });
      }

      // [관리자 공지 자동 완료] 공지사항(NOTICE)일 경우 자동으로 '완료(ANSWERED)' 상태로 설정
      let initialStatus: string | undefined = undefined;
      
      if (data.category === 'NOTICE') {
        initialStatus = 'ANSWERED';
      }

      return await this.prisma.sysBoard.create({
        data: {
          title: data.title,
          content: data.content,
          authorId: data.authorId,
          category: data.category || 'QNA',
          isSecret: data.isSecret || 'N',
          isPopup: data.isPopup || 'N',
          status: initialStatus,
        },
      });
    } catch (error) {
      this.logger.error(`Failed to createPost: ${error.message}`, error.stack);
      throw new InternalServerErrorException('게시글 작성 중 오류가 발생했습니다.');
    }
  }

  // 4. 게시글 수정
  async updatePost(postId: number, data: any) {
    try {
      // [팝업 공지 자동 해제]
      if (data.category === 'NOTICE' && data.isPopup === 'Y') {
        await this.prisma.sysBoard.updateMany({
          where: { 
            category: 'NOTICE', 
            isPopup: 'Y',
            postId: { not: postId } 
          },
          data: { isPopup: 'N' }
        });
      }

      return await this.prisma.sysBoard.update({
        where: { postId },
        data: {
          title: data.title,
          content: data.content,
          category: data.category,
          isSecret: data.isSecret,
          isPopup: data.isPopup,
        },
      });
    } catch (error) {
      this.logger.error(`Failed to updatePost: ${error.message}`, error.stack);
      throw new InternalServerErrorException('게시글 수정 중 오류가 발생했습니다.');
    }
  }

  // 5. 게시글 상태 변경 (알림 로직 포함)
  async updateStatus(postId: number, status: string) {
    try {
      const board = await this.prisma.sysBoard.findUnique({ where: { postId } });
      if (!board) throw new NotFoundException('게시글을 찾을 수 없습니다.');

      const updated = await this.prisma.sysBoard.update({
        where: { postId },
        data: { status },
      });

      // [알림 발송] 상태가 'Complete' 또는 'ANSWERED'로 변경된 경우 (작성자가 아닌 관리자가 변경했다고 가정)
      if ((status === 'Complete' || status === 'ANSWERED') && board.status !== status) {
        // 본인이 본인 글의 상태를 바꾸는 경우는 제외할 수도 있으나, 보통 관리자가 처리하므로 알림 발송
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

  // 7. 댓글 작성 (트랜잭션 및 알림 적용)
  async createComment(data: CreateCommentDto) {
    try {
      // 게시글 정보 조회 (작성자 ID 필요)
      const board = await this.prisma.sysBoard.findUnique({ where: { postId: Number(data.postId) } });
      if (!board) throw new NotFoundException('게시글을 찾을 수 없습니다.');

      // [댓글/답변 트랜잭션]
      const result = await this.prisma.$transaction(async (tx) => {
        // 1. 댓글 생성
        const comment = await tx.sysBoardComment.create({
          data: {
            postId: Number(data.postId),
            authorId: data.authorId,
            content: data.content,
            parentId: data.parentId ? Number(data.parentId) : null,
          },
        });

        // 2. 게시글 상태 업데이트 (옵션)
        if (data.status) {
          await tx.sysBoard.update({
            where: { postId: Number(data.postId) },
            data: { status: data.status },
          });
        }

        return comment;
      });

      // [알림 발송] 댓글 작성자가 게시글 작성자와 다를 경우 (즉, 관리자 답변)
      if (board.authorId !== data.authorId) {
        // 1) 답변 등록 알림
        await this.alertService.createAlert(
          board.authorId,
          `문의하신 게시글 [${board.title}]에 답변이 등록되었습니다.`,
          `/support/qna/${data.postId}`
        );

        // 2) 상태가 완료로 변경되었으면 추가 알림 또는 위 알림으로 갈음
        // 여기서는 '답변 등록' 알림 하나만 보내거나, 상태 변경이 있을 경우 로직을 통합할 수 있음.
        // 위 updateStatus에서도 알림을 보내므로 중복 방지를 위해 여기서는 '상태 변경'이 없을 때만 보내거나 메시지를 구분함.
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

  // 10. 팝업 공지사항 조회
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
