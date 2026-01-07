// itm-data-api/src/app.module.ts
import { Module } from '@nestjs/common';
import { WaferModule } from './wafer/wafer.module'; // [1] import 추가

@Module({
  imports: [WaferModule], // [2] imports에 등록
  controllers: [],
  providers: [],
})
export class AppModule {}
