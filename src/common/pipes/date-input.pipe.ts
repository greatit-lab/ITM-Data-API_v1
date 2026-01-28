// ITM-Data-API/src/common/pipes/date-input.pipe.ts
import { PipeTransform, Injectable, ArgumentMetadata } from '@nestjs/common';
import dayjs from 'dayjs';
import customParseFormat from 'dayjs/plugin/customParseFormat';

// 커스텀 포맷 파싱 플러그인 적용
dayjs.extend(customParseFormat);

@Injectable()
export class DateInputPipe implements PipeTransform {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  transform(value: unknown, _metadata: ArgumentMetadata) {
    if (value === null || value === undefined) {
      return value;
    }

    // 요청 데이터가 객체(Body, Query)일 경우 재귀적으로 탐색
    if (typeof value === 'object') {
      this.transformObject(value);
    }

    return value;
  }

  private transformObject(obj: unknown) {
    if (typeof obj !== 'object' || obj === null) {
      return;
    }

    // 안전한 접근을 위해 타입 단언(Type Assertion) 사용
    const record = obj as Record<string, unknown>;

    for (const key of Object.keys(record)) {
      const value = record[key];

      // 1. 문자열인 경우 날짜 형식인지 체크
      if (typeof value === 'string') {
        if (this.isDateFormat(value)) {
          const date = dayjs(value);
          if (date.isValid()) {
            // 원본 객체 값 갱신 (Date 객체로 변환)
            record[key] = date.toDate();
          }
        }
      }
      // 2. 중첩 객체/배열인 경우 재귀 호출
      else if (typeof value === 'object') {
        this.transformObject(value);
      }
    }
  }

  private isDateFormat(val: string): boolean {
    if (val.length < 8) return false;
    // YYYY-MM-DD HH:mm:ss 형식 매칭 (숫자와 구분자 패턴 확인)
    return /^\d{2,4}[-/]\d{1,2}[-/]\d{1,2}/.test(val);
  }
}
