// ITM-Data-API_v1/src/board/board.service.ts
import { Injectable, NotFoundException, Logger, InternalServerErrorException } from '@nestjs/common';
import { PrismaService } from '../prisma.service';
import { AlertService } from '../alert/alert.service';
import { CreatePostDto, CreateCommentDto } from './dto/board.dto';
import dayjs from 'dayjs';
import utc from 'dayjs/plugin/utc';

dayjs.extend(utc);

@Injectable()
export class BoardService {
  private readonly logger = new Logger(BoardService.name);

  constructor(
    private prisma: PrismaService,
    private alertService: AlertService,
  ) {}

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
      if (data.category === 'NOTICE' && data.isPopup === 'Y') {
        await this.prisma.sysBoard.updateMany({
          where: { category: 'NOTICE', isPopup: 'Y' },
          data: { isPopup: 'N' }
        });
      }

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

      // [추가] 공지사항(NOTICE) 등록 시 전체 사용자에게 알림 일괄 발송
      if (newPost.category === 'NOTICE') {
        try {
          // 모든 사용자 ID 조회
          const allUsers = await this.prisma.sysUser.findMany({ select: { loginId: true } });
          const alertData = allUsers.map(user => ({
            userId: user.loginId,
            type: 'NOTICE_POST',
            message: `[새로운 공지사항] ${newPost.title}`,
            link: `/support/qna/${newPost.postId}`,
            isRead: false
          }));
          
          if (alertData.length > 0) {
            await this.prisma.sysAlert.createMany({ data: alertData });
          }
        } catch (alertError) {
          this.logger.error(`Failed to send notice alerts: ${alertError.message}`);
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

  // 7. 댓글 작성 (알림 발송 포함)
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

      // 댓글 작성자가 원글 작성자가 아닐 경우 원글 작성자에게 알림 발송 (기존 정상 로직 유지)
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
