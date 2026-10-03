// 部署設定（上線前填入，步驟見 docs/上線步驟.md）
window.FC_CONFIG = {
  // 'local'：資料存在每台裝置（預設）；'server'：使用 Python 伺服器的資料庫
  backend: 'local',
  // Google Cloud「OAuth 用戶端 ID」，例如 1234567890-abc.apps.googleusercontent.com；留空 = 不使用 Google 登入
  googleClientId: '',
  // Apps Script「網頁應用程式」網址（註冊名單寫到你的 Google 試算表）
  registrationUrl: '',
  // true：第一次使用必須用 Google 帳號註冊（只在 https 正式網址生效；本機測試時可略過）
  requireGoogleSignIn: true,
  appVersion: '0.3.0',
};
