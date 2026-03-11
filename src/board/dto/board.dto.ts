// ITM-Data-API_v1/src/board/dto/board.dto.ts
import { IsString, IsOptional, IsNotEmpty, IsEnum } from 'class-validator';

// 게시글 생성 DTO
export class CreatePostDto {
  @IsString()
  @IsNotEmpty()
  title: string;

  @IsString()
  @IsNotEmpty()
  content: string; // HTML 태그 포함

  @IsString()
  @IsNotEmpty()
  authorId: string; // 작성자 ID (Login ID)

  @IsString()
  @IsOptional()
  @IsEnum(['QNA', 'NOTICE', 'BUG', 'IDEA'])
  category?: string;

  @IsString()
  @IsOptional()
  @IsEnum(['Y', 'N'])
  isSecret?: string;

  @IsString()
  @IsOptional()
  @IsEnum(['Y', 'N'])
  isPopup?: string;
}

// 댓글 생성 DTO
export class CreateCommentDto {
  @IsNotEmpty()
  postId: number;

  @IsString()
  @IsNotEmpty()
  authorId: string;

  @IsString()
  @IsNotEmpty()
  content: string;

  @IsOptional()
  parentId?: number; // 대댓글일 경우 부모 ID

  // 댓글 작성 시 게시글 상태 변경 옵션 (예: 'ANSWERED')
  @IsString()
  @IsOptional()
  status?: string;
}
