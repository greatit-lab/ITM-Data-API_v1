// ecosystem.data.config.js
module.exports = {
  apps: [
    {
      name: "itm-data-api",       // PM2 프로세스 이름
      cwd: ".",                   // [중요] 현재 폴더(루트)를 기준으로 실행
      script: "dist/main.js",     // 실행 스크립트 경로 (루트 기준)
      env: {
        NODE_ENV: "production",
        PORT: 8081                // Data API 포트
      },
      instances: 1,
      exec_mode: "fork"
    },
  ],
};
