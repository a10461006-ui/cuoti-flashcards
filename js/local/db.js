// 本機資料庫（IndexedDB）：啟動時整份載入記憶體，寫入時同步存回。
// 題目數量通常在幾千題以內，全部放在記憶體查詢最快也最簡單。
// IndexedDB 的自動編號不會重複使用，刪除題目後新題目不會沿用舊編號。

// 測試頁會設定 window.FC_DB_NAME，使用獨立的資料庫，不會動到真正的資料
const DB_NAME = window.FC_DB_NAME || 'cuoti-flashcards';
const VERSION = 1;
export const STORES = {
  meta: { keyPath: 'key' },
  subjects: { keyPath: 'id', autoIncrement: true },
  questions: { keyPath: 'id', autoIncrement: true },
  cards: { keyPath: 'questionId' },
  reviews: { keyPath: 'id', autoIncrement: true },
  papers: { keyPath: 'id', autoIncrement: true },
};

export const mem = Object.fromEntries(Object.keys(STORES).map((name) => [name, new Map()]));
let db = null;
let opening = null;

const done = (request) => new Promise((resolve, reject) => {
  request.onsuccess = () => resolve(request.result);
  request.onerror = () => reject(request.error);
});

export function openDb() {
  if (!opening) {
    opening = (async () => {
      if (!('indexedDB' in window)) throw new Error('這個瀏覽器不支援本機資料儲存，請改用 Chrome、Safari 或 Edge');
      db = await new Promise((resolve, reject) => {
        const request = indexedDB.open(DB_NAME, VERSION);
        request.onupgradeneeded = () => {
          for (const [name, options] of Object.entries(STORES)) {
            if (!request.result.objectStoreNames.contains(name)) request.result.createObjectStore(name, options);
          }
        };
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error || new Error('無法開啟本機資料庫'));
        request.onblocked = () => reject(new Error('請關閉其他開著這個 App 的分頁，再重新整理'));
      });
      db.onversionchange = () => { db.close(); location.reload(); };
      const tx = db.transaction(Object.keys(STORES), 'readonly');
      await Promise.all(Object.keys(STORES).map(async (name) => {
        const rows = await done(tx.objectStore(name).getAll());
        const key = STORES[name].keyPath;
        mem[name] = new Map(rows.map((row) => [row[key], row]));
      }));
    })().catch((err) => { opening = null; throw err; });
  }
  return opening;
}

/**
 * 在同一個交易中寫入多筆：ops = [{ op: 'put' | 'add' | 'delete' | 'clear', store, value?, key? }]
 * 交易成功後才更新記憶體；回傳每個 add 產生的編號（依順序）。
 */
export function write(ops) {
  if (!ops.length) return Promise.resolve([]);
  const names = [...new Set(ops.map((o) => o.store))];
  return new Promise((resolve, reject) => {
    const tx = db.transaction(names, 'readwrite');
    const ids = [];
    const apply = [];
    for (const o of ops) {
      const store = tx.objectStore(o.store);
      const keyPath = STORES[o.store].keyPath;
      if (o.op === 'delete') {
        store.delete(o.key);
        apply.push(() => mem[o.store].delete(o.key));
      } else if (o.op === 'clear') {
        store.clear();
        apply.push(() => mem[o.store].clear());
      } else {
        const value = o.value;
        const request = o.op === 'add' ? store.add(value) : store.put(value);
        const slot = o.op === 'add' ? ids.push(null) - 1 : -1;
        request.onsuccess = () => {
          if (value[keyPath] == null) value[keyPath] = request.result;
          if (slot >= 0) ids[slot] = request.result;
        };
        apply.push(() => mem[o.store].set(value[keyPath], value));
      }
    }
    tx.oncomplete = () => { apply.forEach((fn) => fn()); resolve(ids); };
    tx.onerror = () => reject(tx.error || new Error('寫入本機資料失敗'));
    tx.onabort = () => reject(tx.error || new Error('寫入本機資料失敗（儲存空間可能不足）'));
  });
}

export const all = (store) => [...mem[store].values()];

/** 關閉連線（測試頁刪除測試資料庫前使用，避免觸發 onversionchange 重新整理） */
export function closeDb() {
  if (db) { db.onversionchange = null; db.close(); }
  db = null;
  opening = null;
}

/** 請瀏覽器把資料標成「持續保存」，降低空間不足時被自動清除的機會 */
export async function requestPersistence() {
  try {
    if (navigator.storage?.persist && !(await navigator.storage.persisted())) return await navigator.storage.persist();
    return true;
  } catch {
    return false;
  }
}
