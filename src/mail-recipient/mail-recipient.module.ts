// itm-data-api/src/mail-recipient/mail-recipient.module.ts
import { Module } from '@nestjs/common';
import { MailRecipientService } from './mail-recipient.service';
import { MailRecipientController } from './mail-recipient.controller';
import { PrismaService } from '../prisma.service';

@Module({
  controllers: [MailRecipientController],
  providers: [MailRecipientService, PrismaService],
  exports: [MailRecipientService],
})
export class MailRecipientModule {}
