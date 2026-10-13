// Google 雲端硬碟（Drive API v3）：只使用「App 專用資料夾」（appDataFolder）。
// 這個資料夾在使用者的雲端硬碟裡看不到，也只有錯題閃卡讀得到；App 也看不到使用者的其他檔案。
const API = 'https://www.googleapis.com/drive/v3';
const UPLOAD = 'https://www.googleapis.com/upload/drive/v3';
const SIMPLE_LIMIT = 4 * 1024 * 1024; // 超過就改用「可續傳上傳」（一般上傳上限 5 MB）
const FIELDS = 'id,name,version,modifiedTime,size';

export class DriveError extends Error {
  constructor(message, code, status = 0) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** getToken：回傳目前的存取權杖（過期由呼叫端處理） */
export function driveClient(getToken) {
  async function call(url, init = {}, { raw = false, retries = 3 } = {}) {
    for (let i = 0; ; i += 1) {
      const token = getToken();
      if (!token) throw new DriveError('Google 授權已過期，請重新連接', 'auth', 401);
      let res;
      try {
        res = await fetch(url, { ...init, headers: { ...(init.headers || {}), Authorization: `Bearer ${token}` } });
      } catch {
        if (i < retries) { await sleep(800 * 2 ** i); continue; }
        throw new DriveError('無法連線到 Google 雲端硬碟，請確認網路後再試', 'network');
      }
      if (res.ok) return raw ? res : res.status === 204 ? null : res.json().catch(() => null);
      const data = await res.json().catch(() => null);
      const reason = `${data?.error?.errors?.[0]?.reason || ''} ${data?.error?.status || ''} ${data?.error?.message || ''}`;
      const retryable = res.status === 429 || res.status >= 500 || /rateLimit/i.test(reason);
      if (retryable && i < retries) { await sleep(1000 * 2 ** i); continue; }
      if (res.status === 401) throw new DriveError('Google 授權已過期，請重新連接', 'auth', 401);
      if (/accessNotConfigured|SERVICE_DISABLED|has not been used|is disabled/i.test(reason)) {
        throw new DriveError('開發者還沒有開啟 Google 雲端硬碟功能（Google Drive API），請通知開發者', 'api-disabled', res.status);
      }
      if (/storageQuotaExceeded/i.test(reason)) throw new DriveError('你的 Google 雲端硬碟空間已滿，請先清出空間', 'quota', res.status);
      if (/insufficient|scope|PERMISSION_DENIED/i.test(reason)) {
        throw new DriveError('沒有取得雲端硬碟的權限，請重新連接，並在 Google 畫面勾選允許', 'scope', res.status);
      }
      if (res.status === 404) throw new DriveError('找不到雲端的檔案', 'not-found', 404);
      throw new DriveError(`Google 雲端硬碟發生錯誤（${res.status}），請稍後再試`, 'http', res.status);
    }
  }

  async function upload(id, name, blob) {
    const type = blob.type || 'application/octet-stream';
    const meta = id ? {} : { name, parents: ['appDataFolder'] };
    if (blob.size <= SIMPLE_LIMIT) {
      if (id) {
        return call(`${UPLOAD}/files/${id}?uploadType=media&fields=${FIELDS}`, { method: 'PATCH', headers: { 'Content-Type': type }, body: blob });
      }
      const boundary = `fc${Math.random().toString(16).slice(2)}`;
      const body = new Blob([
        `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(meta)}\r\n`,
        `--${boundary}\r\nContent-Type: ${type}\r\n\r\n`, blob, `\r\n--${boundary}--`,
      ]);
      return call(`${UPLOAD}/files?uploadType=multipart&fields=${FIELDS}`, {
        method: 'POST', headers: { 'Content-Type': `multipart/related; boundary=${boundary}` }, body,
      });
    }
    // 大檔案：先建立上傳工作階段，再一次送出內容
    const start = await call(`${UPLOAD}/files${id ? `/${id}` : ''}?uploadType=resumable&fields=${FIELDS}`, {
      method: id ? 'PATCH' : 'POST',
      headers: { 'Content-Type': 'application/json; charset=UTF-8', 'X-Upload-Content-Type': type, 'X-Upload-Content-Length': String(blob.size) },
      body: JSON.stringify(meta),
    }, { raw: true });
    const session = start.headers.get('Location');
    if (!session) throw new DriveError('上傳到 Google 雲端硬碟失敗，請稍後再試', 'upload');
    return call(session, { method: 'PUT', headers: { 'Content-Type': type }, body: blob });
  }

  return {
    async listAll() {
      const files = [];
      let pageToken = '';
      do {
        const qs = new URLSearchParams({ spaces: 'appDataFolder', fields: `nextPageToken,files(${FIELDS})`, pageSize: '1000' });
        if (pageToken) qs.set('pageToken', pageToken);
        const data = await call(`${API}/files?${qs}`);
        files.push(...(data?.files || []));
        pageToken = data?.nextPageToken || '';
      } while (pageToken);
      return files;
    },
    getMeta: (id) => call(`${API}/files/${id}?fields=${FIELDS}`),
    download: async (id) => (await call(`${API}/files/${id}?alt=media`, {}, { raw: true })).arrayBuffer(),
    downloadText: async (id) => (await call(`${API}/files/${id}?alt=media`, {}, { raw: true })).text(),
    create: (name, blob) => upload(null, name, blob),
    update: (id, blob) => upload(id, null, blob),
    remove: (id) => call(`${API}/files/${id}`, { method: 'DELETE' }, { retries: 1 }),
    /** 目前授權的 Google 帳號（用來確認每台裝置連的是同一個帳號） */
    about: () => call(`${API}/about?fields=user(emailAddress,displayName)`),
  };
}
