// ITM-Data-API/src/board/board.service.ts
import { Injectable, NotFoundException, Logger, InternalServerErrorException } from '@nestjs/common';
import { PrismaService } from '../prisma.service';
import { CreatePostDto, CreateCommentDto } from './dto/board.dto';

@Injectable()
export class BoardService {
  // [개선] 로그 출력을 위한 Logger 인스턴스 생성
  private readonly logger = new Logger(BoardService.name);

  constructor(private prisma: PrismaService) {}

  // 1. 게시글 목록 조회 (검색 및 페이징 포함)
  async getPosts(page: number, limit: number, category?: string, search?: string) {
    try {
      const skip = (page - 1) * limit;
      
      // 검색 조건 구성
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

      // 데이터 조회
      const [total, posts] = await Promise.all([
        this.prisma.sysBoard.count({ where: whereCondition }),
        this.prisma.sysBoard.findMany({
          where: whereCondition,
          skip,
          take: limit,
          orderBy: { createdAt: 'desc' },
          include: {
            _count: { select: { comments: true } }, // 댓글 수 포함
          },
        }),
      ]);

      return {
        data: posts,
        meta: {
          total,
          page,
          lastPage: Math.ceil(total / limit),
        },
      };
    } catch (error) {
      // [개선] 에러 발생 시 정확한 원인을 로그로 출력
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
          comments: {
            orderBy: { createdAt: 'asc' }, // 댓글은 작성순
          },
          files: true, // 첨부 파일 포함
        },
      });

      if (!post) throw new NotFoundException(`Post #${postId} not found`);

      // 조회수 증가 (비동기 처리 - 에러나도 무시)
      this.prisma.sysBoard.update({
        where: { postId },
        data: { views: { increment: 1 } },
      }).catch(e => this.logger.warn(`Failed to update views: ${e.message}`));

      return post;
    } catch (error) {
      if (error instanceof NotFoundException) throw error;
      this.logger.error(`Failed to getPostById(${postId}): ${error.message}`, error.stack);
      throw new InternalServerErrorException('게시글 상세 정보를 불러오는 중 오류가 발생했습니다.');
    }
  }

  // 3. 게시글 작성
  async createPost(data: CreatePostDto) {
    try {
      return await this.prisma.sysBoard.create({
        data: {
          title: data.title,
          content: data.content,
          authorId: data.authorId,
          category: data.category || 'QNA',
          isSecret: data.isSecret || 'N',
        },
      });
    } catch (error) {
      this.logger.error(`Failed to createPost: ${error.message}`, error.stack);
      throw new InternalServerErrorException('게시글 작성 중 오류가 발생했습니다.');
    }
  }

  // 4. [추가] 게시글 수정
  async updatePost(postId: number, data: any) {
    try {
      return await this.prisma.sysBoard.update({
        where: { postId },
        data: {
          title: data.title,
          content: data.content,
          category: data.category,
          isSecret: data.isSecret,
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
      return await this.prisma.sysBoard.update({
        where: { postId },
        data: { status },
      });
    } catch (error) {
      this.logger.error(`Failed to updateStatus: ${error.message}`, error.stack);
      throw new InternalServerErrorException('상태 변경 중 오류가 발생했습니다.');
    }
  }

  // 6. [수정] 게시글 삭제 (트랜잭션 적용)
  async deletePost(postId: number) {
    try {
      // 댓글이 있는 게시글 삭제 시 FK 제약조건 오류를 방지하기 위해 트랜잭션 사용
      return await this.prisma.$transaction([
        // 1. 해당 게시글의 모든 댓글 먼저 삭제
        this.prisma.sysBoardComment.deleteMany({
          where: { postId },
        }),
        // 2. 게시글 삭제
        this.prisma.sysBoard.delete({
          where: { postId },
        }),
      ]);
    } catch (error) {
      this.logger.error(`Failed to deletePost: ${error.message}`, error.stack);
      throw new InternalServerErrorException('게시글 삭제 중 오류가 발생했습니다.');
    }
  }

  // 7. 댓글 작성
  async createComment(data: CreateCommentDto) {
    try {
      return await this.prisma.sysBoardComment.create({
        data: {
          postId: Number(data.postId),
          authorId: data.authorId,
          content: data.content,
          parentId: data.parentId ? Number(data.parentId) : null,
        },
      });
    } catch (error) {
      this.logger.error(`Failed to createComment: ${error.message}`, error.stack);
      throw new InternalServerErrorException('댓글 작성 중 오류가 발생했습니다.');
    }
  }
}
