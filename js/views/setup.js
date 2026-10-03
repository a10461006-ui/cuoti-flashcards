// 第一次使用的設定精靈：Google 註冊 → 暱稱 → 考試／科目 → 練習設定 → 資料存放位置
import { api } from '../api.js';
import { navigate } from '../app.js';
import { googleConfigured, googleRequired, googleUsable, renderGoogleButton, sendRegistration } from '../google.js';
import { invalidateSubjects, state } from '../store.js';
import { clear, h, icon, segmented, showError, switchInput, toast } from '../ui.js';

const EXAMS = [
  {
    id: 'judicial', name: '司法官／律師',
    subjects: ['民法', '民事訴訟法', '刑法', '刑事訴訟法', '憲法', '行政法', '公司法', '保險法', '票據法',
      '證券交易法', '強制執行法', '國際公法', '國際私法', '法律倫理', '法學英文'],
  },
  {
    id: 'pt', name: '物理治療師',
    subjects: ['物理治療基礎學', '物理治療學概論', '物理治療技術學', '神經疾病物理治療學', '骨科疾病物理治療學',
      '心肺疾病與小兒疾病物理治療學'],
  },
  { id: 'other', name: '其他考試', subjects: [] },
];
const STEPS = ['註冊', '暱稱', '考試科目', '練習', '資料位置'];
// LINE、Facebook、Instagram、微信的內建瀏覽器：Google 不允許在裡面登入，資料也可能被清除
const IN_APP_BROWSER = /\bLine\/|FBAN|FBAV|Instagram|MicroMessenger/.test(navigator.userAgent);

function inAppWarning() {
  const copy = async (e) => {
    try {
      await navigator.clipboard.writeText(location.href.replace(/[?&]openExternalBrowser=1/, ''));
      e.currentTarget.textContent = '已複製';
    } catch {
      toast('無法自動複製，請長按網址列手動複製', 'bad');
    }
  };
  return h('div', { class: 'banner', style: { marginBottom: '14px' } }, icon('alert'),
    h('div', null,
      h('div', { class: 't' }, '請改用手機的瀏覽器開啟'),
      h('div', { class: 'd' }, '在 LINE、Facebook 裡面開啟時，無法用 Google 登入，資料也可能被清除。請點右上角「⋯」→「用預設瀏覽器開啟」（iPhone 建議用 Safari），或複製網址貼到瀏覽器。'),
      h('button', { class: 'btn btn-sm', style: { marginTop: '8px' }, onclick: copy }, icon('clipboard'), '複製網址')));
}

export async function render({ root }) {
  const me = state.user || {};
  const knownExam = EXAMS.find((e) => e.name === me.exam);
  const s = {
    step: 0,
    google: me.google || null,
    idToken: null,
    nickname: me.displayName && me.displayName !== '同學' ? me.displayName : '',
    examId: knownExam ? knownExam.id : me.exam ? 'other' : 'judicial',
    otherExam: knownExam ? '' : me.exam || '',
    picked: new Set(knownExam ? knownExam.subjects : EXAMS[0].subjects),
    custom: [],
    newPerDay: me.settings?.newPerDay ?? 20,
    shuffle: me.settings?.shuffleOptions ?? true,
    storage: 'device',
  };
  const wrap = h('div', { class: 'auth-wrap setup' });
  clear(root, wrap);

  const go = (step) => { s.step = step; draw(); window.scrollTo(0, 0); };
  const exam = () => EXAMS.find((e) => e.id === s.examId);
  const examName = () => (s.examId === 'other' ? s.otherExam.trim() : exam().name);

  function header() {
    return h('div', null,
      h('div', { class: 'setup-steps', 'aria-label': `步驟 ${s.step + 1}／${STEPS.length}` },
        STEPS.map((name, i) => h('span', { class: i < s.step ? 'done' : i === s.step ? 'on' : '' }, name))),
    );
  }

  function nav(next, { label = '下一步', disabled = false } = {}) {
    return h('div', { class: 'btn-row', style: { marginTop: '18px' } },
      s.step > 0 ? h('button', { class: 'btn', onclick: () => go(s.step - 1) }, '上一步') : null,
      h('button', { class: 'btn btn-primary', disabled, onclick: next }, label),
    );
  }

  function draw() {
    const body = [stepRegister, stepNickname, stepExam, stepPractice, stepStorage][s.step]();
    clear(wrap, s.step === 0 ? null : header(), body);
  }

  // ---- 0. 註冊
  function stepRegister() {
    const btnHost = h('div', { class: 'gbtn-host' });
    const card = h('div', { class: 'card stack' });
    const signedIn = s.google ? h('div', { class: 'signed-in' },
      s.google.picture ? h('img', { src: s.google.picture, alt: '', referrerpolicy: 'no-referrer' }) : h('span', { class: 'avatar' }, (s.google.name || '?').slice(0, 1)),
      h('div', { class: 'grow' }, h('b', null, s.google.name), h('div', { class: 'small muted' }, s.google.email)),
      icon('check'),
    ) : null;

    if (googleUsable()) {
      clear(card,
        h('b', null, '用 Google 帳號註冊'),
        signedIn || btnHost,
        h('p', { class: 'small muted', style: { margin: 0 } },
          '登入後，你的 Google 名稱與 Email 會登記到開發者的使用者名單，只用來了解使用人數與聯絡；你的題目與練習紀錄只存在你自己的裝置，不會上傳。',
          h('a', { href: 'privacy.html', target: '_blank', rel: 'noopener' }, '隱私權政策')),
        nav(() => go(1), { disabled: googleRequired() && !s.google, label: s.google ? '下一步' : googleRequired() ? '請先登入' : '略過，直接開始' }),
      );
      if (!s.google) {
        renderGoogleButton(btnHost, ({ idToken, profile }) => {
          s.google = profile;
          s.idToken = idToken;
          if (!s.nickname) s.nickname = profile.name;
          draw();
        }).catch((err) => clear(btnHost, h('div', { class: 'form-error' }, err.message)));
      }
    } else {
      clear(card,
        h('b', null, '開始設定'),
        h('p', { class: 'small muted', style: { margin: 0 } }, googleConfigured()
          ? 'Google 註冊需要用正式網址（https）開啟。現在是測試網址，可以先略過。'
          : '（開發者尚未設定 Google 登入，先直接開始）'),
        nav(() => go(1), { label: '開始設定' }),
      );
    }
    return h('div', null,
      h('div', { class: 'brand' },
        h('img', { src: 'icons/icon-192.png', alt: '' }),
        h('h1', null, '歡迎使用錯題閃卡'),
        h('p', null, '把錯題與考古題變成閃卡，隨機練習、間隔複習'),
      ),
      h('ul', { class: 'intro-list' },
        h('li', null, icon('book'), '題庫自己匯入：Excel 訂正本、考古題 PDF／Word'),
        h('li', null, icon('check'), '資料存在你的裝置，沒網路也能練習'),
        h('li', null, icon('shuffle'), '選項每次重新洗牌，避免背答案位置'),
      ),
      IN_APP_BROWSER ? inAppWarning() : null,
      card,
    );
  }

  // ---- 1. 暱稱
  function stepNickname() {
    const input = h('input', { class: 'input', value: s.nickname, maxlength: 40, placeholder: '例如：小安', autofocus: true });
    input.addEventListener('input', () => { s.nickname = input.value; });
    return h('div', { class: 'card' },
      h('h2', null, '怎麼稱呼你？'),
      h('label', { class: 'field' }, h('span', { class: 'lbl' }, '暱稱', h('span', { class: 'hint' }, '顯示在首頁，之後可在設定修改')), input),
      nav(() => go(2)),
    );
  }

  // ---- 2. 考試與科目
  function stepExam() {
    const chips = h('div', { class: 'chips' });
    const drawChips = () => clear(chips, [...exam().subjects, ...s.custom].map((name) => h('button', {
      class: `chip ${s.picked.has(name) ? 'on' : ''}`, 'aria-pressed': String(s.picked.has(name)),
      onclick: () => { if (s.picked.has(name)) s.picked.delete(name); else s.picked.add(name); drawChips(); },
    }, s.picked.has(name) ? icon('check') : null, name)));
    drawChips();

    const addInput = h('input', { class: 'input', placeholder: '新增其他科目，例如：海商法', maxlength: 40 });
    const add = () => {
      const name = addInput.value.trim();
      if (!name) return;
      if (!s.custom.includes(name) && !exam().subjects.includes(name)) s.custom.push(name);
      s.picked.add(name);
      addInput.value = '';
      drawChips();
    };
    addInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); add(); } });
    const other = h('input', { class: 'input', value: s.otherExam, maxlength: 40, placeholder: '例如：會計師、護理師' });
    other.addEventListener('input', () => { s.otherExam = other.value; });

    return h('div', { class: 'card' },
      h('h2', null, '要準備哪一種考試？'),
      h('div', { class: 'exam-cards' }, EXAMS.map((e) => h('button', {
        class: `exam-card ${s.examId === e.id ? 'on' : ''}`, 'aria-pressed': String(s.examId === e.id),
        onclick: () => { s.examId = e.id; s.picked = new Set([...e.subjects, ...s.custom]); draw(); },
      }, e.name))),
      s.examId === 'other' ? h('label', { class: 'field', style: { marginTop: '14px' } }, h('span', { class: 'lbl' }, '考試名稱'), other) : null,
      h('div', { class: 'lbl-row' }, h('b', null, '先建立哪些科目？'), h('span', { class: 'small muted' }, '點一下可取消，之後也能再改')),
      chips,
      h('div', { class: 'row-flex', style: { marginTop: '12px' } }, h('div', { class: 'grow' }, addInput),
        h('button', { class: 'btn', onclick: add }, icon('plus'), '加入')),
      nav(() => {
        if (s.examId === 'other' && !s.otherExam.trim()) { toast('請輸入考試名稱', 'bad'); return; }
        go(3);
      }),
    );
  }

  // ---- 3. 練習設定
  function stepPractice() {
    const num = h('input', { class: 'input', type: 'number', min: 0, max: 200, inputmode: 'numeric', value: s.newPerDay, style: { width: '110px', textAlign: 'center' } });
    num.addEventListener('input', () => { s.newPerDay = Math.max(0, Math.min(200, Number(num.value) || 0)); });
    return h('div', { class: 'card' },
      h('h2', null, '練習設定'),
      h('div', { class: 'field' },
        h('div', { class: 'lbl' }, '每日新題數量', h('span', { class: 'hint' }, '「今日複習」每天加入幾題沒練過的題目')),
        h('div', { class: 'row-flex' },
          segmented([10, 20, 30, 50].map((n) => ({ value: n, label: String(n) })), s.newPerDay, (v) => { s.newPerDay = v; num.value = v; }),
          num),
      ),
      h('label', { class: 'row-flex', style: { margin: '6px 0 4px' } },
        h('div', { class: 'grow' }, h('b', null, '選項隨機洗牌'), h('div', { class: 'small muted' }, '每次出現都重新排列並重新編號，避免背答案位置')),
        switchInput(s.shuffle, (v) => { s.shuffle = v; }, '選項隨機洗牌')),
      nav(() => go(4)),
    );
  }

  // ---- 4. 資料存放位置
  function stepStorage() {
    const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
    const installed = matchMedia('(display-mode: standalone)').matches || navigator.standalone;
    const finishBtn = h('button', { class: 'btn btn-primary btn-lg btn-block', onclick: finish }, icon('check'), '完成，開始使用');
    return h('div', { class: 'card' },
      h('h2', null, '題庫要存在哪裡？'),
      h('div', { class: 'stack' },
        h('button', { class: `storage-opt ${s.storage === 'device' ? 'on' : ''}`, onclick: () => { s.storage = 'device'; draw(); } },
          h('span', { class: 'radio' }), h('span', { class: 'grow' },
            h('b', null, '這台裝置（預設）'),
            h('span', { class: 'd' }, '匯入一次就會記住，沒有網路也能練習。手機和電腦的資料各自獨立，可用「設定 → 匯出備份」搬到其他裝置。'))),
        h('div', { class: 'storage-opt disabled', 'aria-disabled': 'true' },
          h('span', { class: 'radio' }), h('span', { class: 'grow' },
            h('b', null, '我的 Google 雲端硬碟 ', h('span', { class: 'badge muted' }, '下一版開放')),
            h('span', { class: 'd' }, '題庫存在你自己的雲端硬碟，手機、平板、電腦自動同步。'))),
      ),
      !installed ? h('div', { class: 'banner info', style: { marginTop: '14px' } }, icon('download'),
        h('div', null, h('div', { class: 't' }, '建議安裝到主畫面'),
          h('div', { class: 'd' }, isIOS
            ? 'iPhone／iPad：用 Safari 點下方「分享」→「加入主畫面」。沒有加到主畫面的話，Safari 可能會在一段時間沒使用後清除資料。'
            : 'Android／電腦：瀏覽器選單裡的「安裝應用程式」或「加到主畫面」，之後就像一般 App 一樣開啟。'))) : null,
      h('div', { style: { marginTop: '18px' } }, finishBtn),
      h('div', { class: 'btn-row', style: { marginTop: '10px' } }, h('button', { class: 'btn btn-ghost', onclick: () => go(3) }, '上一步')),
    );
  }

  async function finish(e) {
    const btn = e.currentTarget;
    btn.disabled = true;
    const subjects = [...s.picked];
    try {
      state.user = await api.post('/api/setup', {
        nickname: s.nickname.trim() || s.google?.name || '', exam: examName(), subjects,
        newPerDay: s.newPerDay, shuffleOptions: s.shuffle, storage: s.storage, google: s.google,
      });
      invalidateSubjects();
      if (s.google && s.idToken) {
        const res = await sendRegistration({
          idToken: s.idToken, nickname: state.user.displayName, exam: examName(),
          subjectCount: subjects.length, newPerDay: s.newPerDay, storage: s.storage,
        });
        if (res.ok) state.user = await api.put('/api/profile/google', { google: { ...s.google, registeredAt: new Date().toISOString() } });
        else if (!res.skipped) toast('註冊登記稍後會自動補送', '');
      }
      toast('設定完成！先匯入題庫吧', 'ok');
      navigate('#/', { replace: true });
    } catch (err) {
      showError(err);
      btn.disabled = false;
    }
  }

  draw();
}
