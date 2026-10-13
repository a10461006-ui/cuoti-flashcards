import { api, MODE } from '../api.js';
import { navigate } from '../app.js';
import {
  agoText, cloudAvailable, cloudStatus, connectDrive, onCloudStatus, refreshCloudStatus, syncNow, turnOffSync, useOtherAccount,
} from '../cloud.js';
import { googleUsable, renderGoogleButton, sendRegistration } from '../google.js';
import { invalidateSubjects, loadSubjects, prefs, state } from '../store.js';
import {
  clear, confirmDialog, downloadBlob, downloadTemplate, h, icon, openSheet, promptDialog, segmented, showError, switchInput, toast, topbar,
} from '../ui.js';

const LOCAL = MODE === 'local';

export async function render({ root }) {
  const main = h('main', { class: 'page' });
  clear(root, topbar({ title: '設定' }), main);
  let offCloud = null;

  const draw = async () => {
    const user = state.user;
    const subjects = await loadSubjects(true);
    const st = user.settings;
    const installed = matchMedia('(display-mode: standalone)').matches || navigator.standalone;

    const saveSettings = async (patch) => {
      try { state.user = await api.put('/api/auth/me', { settings: patch }); } catch (err) { showError(err); }
    };

    const fontRange = h('input', {
      type: 'range', min: 0.85, max: 1.45, step: 0.05, value: prefs.fontScale, style: { width: '100%' }, 'aria-label': '字體大小',
    });
    const fontLabel = h('span', { class: 'muted small' }, `${Math.round(prefs.fontScale * 100)}%`);
    fontRange.addEventListener('input', () => {
      prefs.fontScale = Number(fontRange.value);
      fontLabel.textContent = `${Math.round(prefs.fontScale * 100)}%`;
    });

    const newPerDay = h('input', {
      class: 'input', type: 'number', min: 0, max: 500, inputmode: 'numeric', value: st.newPerDay,
      style: { width: '92px', textAlign: 'center' }, 'aria-label': '每日新題上限',
    });
    newPerDay.addEventListener('change', () => {
      const v = Math.max(0, Math.min(500, Number(newPerDay.value) || 0));
      newPerDay.value = v;
      saveSettings({ newPerDay: v }).then(() => toast('已更新'));
    });

    clear(main,
      h('div', { class: 'section-title' }, '個人資料'),
      h('div', { class: 'list' },
        h('button', { class: 'row', onclick: editName },
          h('span', { class: 'grow' }, h('div', null, user.displayName),
            h('div', { class: 'sub' }, LOCAL ? `準備考試：${user.exam || '未設定'}` : `帳號：${user.username}`)),
          icon('edit')),
        LOCAL ? googleRow(user) : null,
      ),

      h('div', { class: 'section-title' }, '練習'),
      h('div', { class: 'list' },
        h('div', { class: 'row' },
          h('span', { class: 'grow' }, h('div', null, '每日新題上限'), h('div', { class: 'sub' }, '「今日複習」每天加入幾題沒練過的題目')),
          newPerDay),
        h('label', { class: 'row' },
          h('span', { class: 'grow' }, h('div', null, '選項隨機洗牌'),
            h('div', { class: 'sub' }, '每次出現都重新排列並重新編號 A–D，避免背答案位置；「以上皆是」等選項固定不動')),
          switchInput(st.shuffleOptions, (v) => saveSettings({ shuffleOptions: v }), '選項隨機洗牌')),
      ),

      h('div', { class: 'section-title' }, '顯示'),
      h('div', { class: 'card stack' },
        h('div', { class: 'row-flex' }, h('b', { class: 'grow' }, '題目字體大小'), fontLabel),
        fontRange,
        h('div', { class: 'rich', style: { fontSize: 'var(--fs-read)', lineHeight: 1.8, color: 'var(--text-2)' } },
          '預覽：甲將其土地設定普通抵押權於乙，嗣後甲將該土地設定普通地上權於丙建築房屋。'),
        h('b', null, '主題'),
        segmented([{ value: 'auto', label: '跟隨系統' }, { value: 'light', label: '淺色' }, { value: 'dark', label: '深色' }],
          prefs.theme, (v) => { prefs.theme = v; }),
      ),

      h('div', { class: 'section-title' },
        h('span', null, '科目管理'),
        h('button', { class: 'btn btn-ghost btn-sm', onclick: addSubject }, icon('plus'), '新增科目'),
      ),
      subjects.length ? h('div', { class: 'list' }, subjects.map((s) => h('button', { class: 'row', onclick: () => editSubject(s) },
        h('span', { class: 'grow' }, h('div', null, s.name), h('div', { class: 'sub' }, `${s.total} 題${s.category ? ` · 分類：${s.category}` : ''}`)),
        icon('chevron'),
      ))) : h('div', { class: 'card muted small' }, '還沒有科目，新增題目或匯入題庫時會自動建立。'),

      LOCAL ? h('div', { class: 'section-title' }, '雲端同步') : null,
      LOCAL ? cloudSection() : null,

      h('div', { class: 'section-title' }, '資料'),
      h('div', { class: 'list' },
        h('a', { class: 'row', href: '#/import' }, icon('upload'), h('span', { class: 'grow' }, '匯入 Excel 訂正本'), icon('chevron')),
        h('a', { class: 'row', href: '#/papers/upload' }, icon('file'), h('span', { class: 'grow' }, '上傳考古題'), icon('chevron')),
        h('button', { class: 'row', onclick: () => downloadTemplate().catch(showError) }, icon('file'), h('span', { class: 'grow' }, '下載 Excel 匯入範本'), icon('chevron')),
        h('button', { class: 'row', onclick: exportBackup }, icon('download'),
          h('span', { class: 'grow' }, h('div', null, '匯出備份'), h('div', { class: 'sub' }, '存成一個檔案，可在其他裝置還原')), icon('chevron')),
        LOCAL ? h('button', { class: 'row', onclick: restoreBackup }, icon('refresh'),
          h('span', { class: 'grow' }, h('div', null, '從備份還原'), h('div', { class: 'sub' }, '會取代這台裝置上的所有題目與紀錄')), icon('chevron')) : null,
      ),

      LOCAL && !installed ? h('div', { class: 'section-title' }, '安裝') : null,
      LOCAL && !installed ? h('div', { class: 'list' }, installRow()) : null,

      h('div', { class: 'section-title' }, LOCAL ? '其他' : '安全'),
      h('div', { class: 'list' },
        LOCAL ? h('button', { class: 'row', onclick: rerunSetup }, icon('sliders'), h('span', { class: 'grow' }, '重新執行首次設定'), icon('chevron')) : null,
        LOCAL ? h('button', { class: 'row danger', onclick: clearAll }, icon('trash'), h('span', { class: 'grow' }, '清除這台裝置的所有題目與紀錄')) : null,
        !LOCAL ? h('button', { class: 'row', onclick: changePassword }, icon('key'), h('span', { class: 'grow' }, '修改密碼'), icon('chevron')) : null,
        !LOCAL ? h('button', { class: 'row danger', onclick: logout }, icon('logout'), h('span', { class: 'grow' }, '登出')) : null,
      ),
      h('p', { class: 'center small muted', style: { marginTop: '24px' } }, `錯題閃卡 v${window.FC_CONFIG?.appVersion || ''}`,
        LOCAL ? ' · ' : null, LOCAL ? h('a', { href: 'privacy.html', target: '_blank', rel: 'noopener' }, '隱私權政策與使用條款') : null),
    );
  };

  // ---- 雲端同步
  function cloudSection() {
    const host = h('div');
    offCloud?.();
    offCloud = onCloudStatus((st) => clear(host, cloudRows(st)));
    clear(host, cloudRows(cloudStatus()));
    return host;
  }

  function cloudRows(st) {
    if (!cloudAvailable()) {
      return h('div', { class: 'list' }, h('div', { class: 'row' }, icon('book'),
        h('span', { class: 'grow' }, h('div', null, '存放位置：這台裝置'),
          h('div', { class: 'sub' }, window.FC_CONFIG?.googleClientId
            ? '雲端同步需要用正式網址（https）開啟。換裝置或重灌前請先匯出備份。'
            : '開發者尚未設定 Google 登入，暫時不能使用雲端同步。換裝置或重灌前請先匯出備份。'))));
    }
    if (!st.enabled) {
      return h('div', { class: 'list' }, h('button', { class: 'row', onclick: openEnable }, icon('cloud'),
        h('span', { class: 'grow' }, h('div', null, '開啟 Google 雲端硬碟同步'),
          h('div', { class: 'sub' }, '目前資料只存在這台裝置。開啟後，手機、平板、電腦都用同一份題庫和練習紀錄')),
        icon('chevron')));
    }
    const busy = st.phase === 'syncing';
    const detail = busy ? st.progress || '同步中…'
      : st.phase === 'needs-auth' ? (st.pending ? '有新的變動還沒同步，請按「同步」' : 'Google 授權約 1 小時有效，按「同步」繼續')
        : st.phase === 'error' ? st.message
          : `上次同步：${agoText(st.lastSyncAt)}`;
    return h('div', { class: 'list' },
      h('div', { class: 'row' }, icon(st.phase === 'error' ? 'alert' : 'cloud'),
        h('span', { class: 'grow' }, h('div', null, '雲端同步：開啟'),
          h('div', { class: 'sub' }, st.email || 'Google 雲端硬碟'),
          h('div', { class: busy ? 'cloud-progress' : 'sub' }, detail)),
        h('button', { class: 'btn btn-sm', disabled: busy, onclick: () => syncNow({ interactive: true }) }, icon('refresh'), busy ? '同步中' : '同步')),
      st.code === 'account' ? h('div', { class: 'row' }, h('span', { class: 'grow' },
        h('div', { class: 'sub' }, '要改用這個帳號同步嗎？這台裝置的資料會合併到新帳號的雲端；或重新選擇原本的帳號。'),
        h('div', { class: 'btn-row', style: { marginTop: '8px', justifyContent: 'flex-start' } },
          h('button', { class: 'btn btn-sm btn-primary', onclick: () => useOtherAccount() }, `改用 ${st.otherEmail}`),
          h('button', { class: 'btn btn-sm', onclick: () => connectDrive({ intent: 'sync', back: '#/settings', selectAccount: true }) }, '重新選擇帳號')))) : null,
      st.code === 'api-disabled' ? h('div', { class: 'row' }, h('span', { class: 'grow' }, h('div', { class: 'sub' },
        'Google Cloud 還沒開啟「Google Drive API」。請通知開發者照《上線步驟》第 5 步設定，資料仍然保存在這台裝置，不會遺失。'))) : null,
      h('button', { class: 'row', onclick: openDisable }, icon('cloudOff'), h('span', { class: 'grow' }, '關閉這台裝置的雲端同步'), icon('chevron')),
    );
  }

  function openEnable() {
    openSheet((close) => h('div', null,
      h('h3', null, '開啟 Google 雲端硬碟同步'),
      h('p', { class: 'msg small' },
        '題目、考古題、筆記和練習紀錄會存到你自己的 Google 雲端硬碟裡一個「App 專用」的隱藏資料夾：只有錯題閃卡讀得到，開發者看不到；App 也看不到你雲端硬碟裡的其他檔案。'),
      h('ol', { class: 'cloud-steps' },
        h('li', null, '按下面的按鈕會跳到 Google，選擇帳號後按「繼續」或「允許」'),
        h('li', null, '每一台要用的裝置（手機、電腦）都要開啟一次，而且要選同一個 Google 帳號'),
        h('li', null, '這台裝置原本的題目會和雲端合併，不會被刪掉；兩邊都有的同一題會合成一題'),
        h('li', null, 'Google 的授權大約 1 小時有效，之後打開 App 時點一下「同步」就好，不用重新輸入密碼'),
      ),
      h('div', { class: 'btn-row' },
        h('button', { class: 'btn', onclick: () => close() }, '取消'),
        h('button', { class: 'btn btn-primary', onclick: () => { close(); connectDrive({ intent: 'enable', back: '#/settings' }); } }, icon('cloud'), '前往 Google 授權')),
    ));
  }

  function openDisable() {
    openSheet((close) => {
      const off = async (deleteCloud) => {
        close();
        if (deleteCloud && !(await confirmDialog({
          title: '刪除雲端硬碟裡的資料？', ok: '刪除雲端資料', danger: true,
          message: '雲端硬碟裡的錯題閃卡資料會全部刪除，其他裝置也無法再同步這些資料；這台裝置上的題目和紀錄會保留。',
        }))) return;
        try {
          if (await turnOffSync({ deleteCloud })) toast(deleteCloud ? '已關閉同步，並刪除雲端資料' : '已關閉這台裝置的雲端同步', 'ok');
          draw();
        } catch (err) { showError(err); }
      };
      return h('div', null,
        h('h3', null, '關閉雲端同步？'),
        h('p', { class: 'msg small' }, '這台裝置的題目和紀錄會保留，之後只存在這台裝置；雲端硬碟裡的資料也會保留，其他裝置照常同步。'),
        h('div', { class: 'btn-row' },
          h('button', { class: 'btn', onclick: () => close() }, '取消'),
          h('button', { class: 'btn btn-primary', onclick: () => off(false) }, '關閉同步')),
        h('button', { class: 'btn btn-ghost btn-block', style: { marginTop: '10px', color: 'var(--bad)' }, onclick: () => off(true) },
          icon('trash'), '關閉並刪除雲端硬碟裡的資料'),
      );
    });
  }

  function googleRow(user) {
    const g = user.google;
    if (g) {
      return h('div', { class: 'row' },
        g.picture ? h('img', { class: 'row-avatar', src: g.picture, alt: '', referrerpolicy: 'no-referrer' }) : icon('check'),
        h('span', { class: 'grow' }, h('div', null, g.email),
          h('div', { class: 'sub' }, g.registeredAt ? '已用 Google 帳號註冊' : '註冊登記尚未完成，下次開啟會自動補送')),
        g.registeredAt || !googleUsable() ? null : h('button', { class: 'btn btn-sm', onclick: signIn }, '重新登記'));
    }
    return h('button', { class: 'row', onclick: signIn, disabled: !googleUsable() }, icon('key'),
      h('span', { class: 'grow' }, h('div', null, '用 Google 帳號註冊'),
        h('div', { class: 'sub' }, googleUsable() ? '登記名稱與 Email 到開發者的使用者名單' : '需要用正式網址（https）開啟才能使用')),
      icon('chevron'));
  }

  function signIn() {
    openSheet((close) => {
      const host = h('div', { class: 'gbtn-host' });
      renderGoogleButton(host, async ({ idToken, profile }) => {
        close();
        try {
          const res = await sendRegistration({ idToken, nickname: state.user.displayName, exam: state.user.exam, storage: state.user.storage });
          state.user = await api.put('/api/profile/google', { google: { ...profile, registeredAt: res.ok ? new Date().toISOString() : null } });
          toast(res.ok ? '已完成註冊' : '已登入，登記稍後自動補送', res.ok ? 'ok' : '');
          draw();
        } catch (err) { showError(err); }
      }).catch((err) => clear(host, h('div', { class: 'form-error' }, err.message)));
      return h('div', null,
        h('h3', null, '用 Google 帳號註冊'),
        h('p', { class: 'msg small' }, '你的 Google 名稱與 Email 會登記到開發者的使用者名單；題目與練習紀錄不會上傳。'),
        host,
      );
    });
  }

  function installRow() {
    const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
    if (state.installPrompt) {
      return h('button', { class: 'row', onclick: async () => {
        state.installPrompt.prompt();
        await state.installPrompt.userChoice.catch(() => null);
        state.installPrompt = null;
        draw();
      } }, icon('download'), h('span', { class: 'grow' }, h('div', null, '安裝到這台裝置'), h('div', { class: 'sub' }, '像一般 App 一樣從主畫面或桌面開啟')), icon('chevron'));
    }
    return h('div', { class: 'row' }, icon('download'), h('span', { class: 'grow' },
      h('div', null, '安裝到主畫面'),
      h('div', { class: 'sub' }, isIOS ? 'Safari 點下方「分享」→「加入主畫面」。安裝後資料才會長期保存。'
        : '瀏覽器選單 →「安裝應用程式」或「加到主畫面」')));
  }

  async function editName() {
    const name = await promptDialog({ title: '修改暱稱', value: state.user.displayName, ok: '儲存' });
    if (!name) return;
    try {
      state.user = await api.put('/api/auth/me', { displayName: name });
      toast('已更新');
      draw();
    } catch (err) { showError(err); }
  }

  async function addSubject() {
    const name = await promptDialog({ title: '新增科目', label: '科目名稱', placeholder: '例如：刑法、神經疾病物理治療學' });
    if (!name) return;
    try {
      await api.post('/api/subjects', { name, category: LOCAL ? state.user.exam || '' : '' });
      invalidateSubjects();
      toast('已新增科目');
      draw();
    } catch (err) { showError(err); }
  }

  function editSubject(s) {
    openSheet((close) => {
      const name = h('input', { class: 'input', value: s.name, maxlength: 40 });
      const category = h('input', { class: 'input', value: s.category, maxlength: 40, placeholder: '例如：司法官、物理治療師' });
      const save = async (e) => {
        e.preventDefault();
        try {
          await api.patch(`/api/subjects/${s.id}`, { name: name.value.trim(), category: category.value.trim() });
          invalidateSubjects();
          close();
          toast('已更新');
          draw();
        } catch (err) { showError(err); }
      };
      const remove = async () => {
        close();
        const ok = await confirmDialog({
          title: `刪除「${s.name}」？`, message: `這個科目底下的 ${s.total} 題與練習紀錄都會一併刪除，無法復原。`, ok: '刪除', danger: true,
        });
        if (!ok) return;
        try {
          await api.del(`/api/subjects/${s.id}`);
          invalidateSubjects();
          toast('已刪除科目');
          draw();
        } catch (err) { showError(err); }
      };
      return h('form', { onsubmit: save },
        h('h3', null, '編輯科目'),
        h('label', { class: 'field' }, h('span', { class: 'lbl' }, '名稱'), name),
        h('label', { class: 'field' }, h('span', { class: 'lbl' }, '分類', h('span', { class: 'hint' }, '用來把科目分組，選填')), category),
        h('div', { class: 'btn-row' },
          h('button', { type: 'button', class: 'btn btn-danger', onclick: remove }, icon('trash'), '刪除'),
          h('button', { type: 'submit', class: 'btn btn-primary' }, '儲存'),
        ),
      );
    });
  }

  async function exportBackup() {
    try {
      const data = await api.get('/api/export');
      downloadBlob(new Blob([JSON.stringify(data)], { type: 'application/json' }),
        `錯題閃卡備份-${new Date().toISOString().slice(0, 10)}.json`);
    } catch (err) { showError(err); }
  }

  function restoreBackup() {
    const input = h('input', { type: 'file', accept: '.json,application/json', hidden: true });
    input.addEventListener('change', async () => {
      const file = input.files[0];
      input.remove();
      if (!file) return;
      const ok = await confirmDialog({
        title: '從備份還原？', ok: '還原', danger: true,
        message: `會用「${file.name}」取代這台裝置上目前所有的題目、考古題與練習紀錄。${cloudStatus().enabled
          ? '已開啟雲端同步：還原的資料會和雲端合併，雲端上其他的題目也會同步回來。' : ''}`,
      });
      if (!ok) return;
      try {
        const res = await api.post('/api/backup/restore', file);
        invalidateSubjects();
        toast(`已還原：${res.subjects} 個科目、${res.questions} 題`, 'ok');
        draw();
      } catch (err) { showError(err); }
    });
    document.body.append(input);
    input.click();
  }

  async function rerunSetup() {
    if (!(await confirmDialog({ title: '重新執行首次設定？', message: '可以重新選擇考試與科目；已經有的題目與紀錄不會被刪除。', ok: '開始' }))) return;
    navigate('#/setup');
  }

  async function clearAll() {
    const syncing = cloudStatus().enabled;
    const ok = await confirmDialog({
      title: '清除所有題目與紀錄？', ok: '全部清除', danger: true,
      message: `這台裝置上的科目、題目、考古題與練習紀錄會全部刪除，無法復原。建議先匯出備份。${syncing
        ? '這台裝置的雲端同步也會關閉；雲端硬碟裡的資料不會被刪除（要刪除請用「關閉這台裝置的雲端同步」裡的選項）。' : ''}`,
    });
    if (!ok) return;
    try {
      const res = await api.post('/api/data/clear');
      invalidateSubjects();
      await refreshCloudStatus();
      toast(res.syncStopped ? '已清除；這台裝置的雲端同步已關閉' : '已清除');
      draw();
    } catch (err) { showError(err); }
  }

  function changePassword() {
    openSheet((close) => {
      const oldPw = h('input', { class: 'input', type: 'password', autocomplete: 'current-password', required: true });
      const newPw = h('input', { class: 'input', type: 'password', autocomplete: 'new-password', minlength: 6, required: true });
      const err = h('div', { class: 'form-error' });
      const submit = async (e) => {
        e.preventDefault();
        try {
          await api.put('/api/auth/password', { oldPassword: oldPw.value, newPassword: newPw.value });
          close();
          toast('密碼已更新', 'ok');
        } catch (ex) { err.textContent = ex.message; }
      };
      return h('form', { onsubmit: submit },
        h('h3', null, '修改密碼'),
        h('label', { class: 'field' }, h('span', { class: 'lbl' }, '目前密碼'), oldPw),
        h('label', { class: 'field' }, h('span', { class: 'lbl' }, '新密碼', h('span', { class: 'hint' }, '至少 6 個字元')), newPw),
        err,
        h('div', { class: 'btn-row' },
          h('button', { type: 'button', class: 'btn', onclick: () => close() }, '取消'),
          h('button', { type: 'submit', class: 'btn btn-primary' }, '更新密碼'),
        ),
      );
    });
  }

  async function logout() {
    if (!(await confirmDialog({ title: '確定要登出？', ok: '登出' }))) return;
    try { await api.post('/api/auth/logout'); } catch { /* 仍然清除本機狀態 */ }
    state.user = null;
    state.subjects = null;
    navigate('#/login', { replace: true });
  }

  await draw();
  return () => offCloud?.();
}
