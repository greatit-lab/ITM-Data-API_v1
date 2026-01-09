// ITM-Data-API/src/auth/auth.interface.ts

// [수정] DTO는 NestJS 데코레이터와 호환되도록 Class로 정의해야 합니다.
export class LoginDto {
  username!: string; // '!'는 초기화 없이 사용함을 명시 (Strict Property Initialization)
  password?: string;
}

// UserPayload는 타입 정의용이므로 interface로 유지해도 됩니다.
export interface UserPayload {
  username: string;
  role: string;
  sub?: string;
}
