// ITM-Data-API/src/main.ts
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { Logger } from '@nestjs/common';
import { json, urlencoded } from 'express';

async function bootstrap() {
  const logger = new Logger('Bootstrap');

  // [중요 수정] bodyParser: false 옵션 추가
  // NestJS의 기본 BodyParser(100kb 제한)를 비활성화해야 
  // 아래의 app.use(json({ limit: '50mb' })) 설정이 올바르게 적용됩니다.
  const app = await NestFactory.create(AppModule, {
    bodyParser: false, 
  });

  // [설정] 요청 본문(Body) 크기 제한을 50MB로 증가 (이미지 붙여넣기 대응)
  app.use(json({ limit: '50mb' }));
  app.use(urlencoded({ extended: true, limit: '50mb' }));

  // 1. Global Prefix 설정
  app.setGlobalPrefix('api');

  // 2. CORS 설정
  app.enableCors({
    origin: true,
    methods: 'GET,HEAD,PUT,PATCH,POST,DELETE,OPTIONS',
    credentials: true,
  });

  // 3. 포트 설정
  const port = process.env.PORT || 8081;

  // 4. 서버 시작
  await app.listen(port, '0.0.0.0');

  logger.log(`🚀 ITM Data API is running on: http://0.0.0.0:${port}/api`);
}

bootstrap().catch((err) => {
  console.error('Fatal Error during bootstrap:', err);
  process.exit(1);
});
