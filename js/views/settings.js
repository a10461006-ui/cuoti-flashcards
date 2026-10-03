import { api, MODE } from '../api.js';
import { navigate } from '../app.js';
import { googleUsable, renderGoogleButton, sendRegistration } from '../google.js';
import { invalidateSubjects, loadSubjects, prefs, state } from '../store.js';
import {
  clear, confirmDialog, downloadBlob, downloadTemplate, h, icon, openSheet, promptDialog, segmented, showError, switchInput, toast, topbar,
} from '../ui.js';

const LOCAL = MODE === 'local';

export async function render({ root }) {
  const main = h('main', { class: 'page' });
  clear(root, topbar({ title: '設定' }), main);

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

      h('div', { class: 'section-title' }, '資料'),
      h('div', { class: 'list' },
        LOCAL ? h('div', { class: 'row' }, icon('book'),
          h('span', { class: 'grow' }, h('div', null, '存放位置：這台裝置'),
            h('div', { class: 'sub' }, '題庫與紀錄只存在這個瀏覽器／App 裡。換裝置或重灌前請先匯出備份；Google 雲端同步下一版開放。'))) : null,
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
      h('p', { class: 'center small muted', style: { marginTop: '24px' } }, `錯題閃卡 v${window.FC_CONFIG?.appVersion || ''}`),
    );
  };

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
        title: '從備份還原？', message: `會用「${file.name}」取代這台裝置上目前所有的題目、考古題與練習紀錄。`, ok: '還原', danger: true,
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
    const ok = await confirmDialog({
      title: '清除所有題目與紀錄？', message: '這台裝置上的科目、題目、考古題與練習紀錄會全部刪除，無法復原。建議先匯出備份。', ok: '全部清除', danger: true,
    });
    if (!ok) return;
    try {
      await api.post('/api/data/clear');
      invalidateSubjects();
      toast('已清除');
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
}
