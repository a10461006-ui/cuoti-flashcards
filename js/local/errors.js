// 與伺服器版相同的錯誤型別：status 對應 HTTP 狀態碼，畫面依此顯示訊息
export class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}
