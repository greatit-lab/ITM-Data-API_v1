// itm-data-api/src/mail-recipient/dto/mail-recipient.dto.ts
import { IsBoolean, IsNotEmpty, IsOptional, IsString } from 'class-validator';

export class CreateMailRecipientDto {
  @IsString()
  @IsNotEmpty()
  recipientEmail: string; // 수신자 이메일 (abc123@samsung.com)

  @IsString()
  @IsOptional()
  recipientName?: string; // 수신자 이름 (참고용)

  @IsString()
  @IsOptional()
  recipientType?: string; // SYSTEM | USER (기본값: USER)
}

export class UpdateMailRecipientDto {
  @IsString()
  @IsOptional()
  recipientEmail?: string;

  @IsString()
  @IsOptional()
  recipientName?: string;

  @IsBoolean()
  @IsOptional()
  isActive?: boolean;
}
