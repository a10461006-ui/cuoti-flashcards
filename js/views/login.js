import { api } from '../api.js';
import { navigate } from '../app.js';
import { state } from '../store.js';
import { clear, h, segmented } from '../ui.js';

export async function render({ root }) {
  if (state.user) { navigate('#/', { replace: true }); return; }
  let mode = 'login';
  let inviteRequired = false;
  try { inviteRequired = (await api.get('/api/auth/config')).inviteRequired; } catch { /* 預設不需要 */ }

  const formHost = h('div');
  const draw = () => {
    const err = h('div', { class: 'form-error', role: 'alert' });
    const username = h('input', { class: 'input', name: 'username', autocomplete: 'username', autocapitalize: 'off', spellcheck: 'false', required: true, minlength: 3, maxlength: 32 });
    const password = h('input', { class: 'input', type: 'password', name: 'password', autocomplete: mode === 'login' ? 'current-password' : 'new-password', required: true, minlength: mode === 'login' ? 1 : 6 });
    const displayName = h('input', { class: 'input', name: 'displayName', maxlength: 40, placeholder: '例如：小安' });
    const invite = h('input', { class: 'input', name: 'invite', autocomplete: 'off' });
    const submit = h('button', { class: 'btn btn-primary btn-block btn-lg', type: 'submit' }, mode === 'login' ? '登入' : '建立帳號');

    const onsubmit = async (e) => {
      e.preventDefault();
      err.textContent = '';
      submit.disabled = true;
      try {
        state.user = mode === 'login'
          ? await api.post('/api/auth/login', { username: username.value, password: password.value }, { allow401: true })
          : await api.post('/api/auth/register', {
            username: username.value, password: password.value,
            displayName: displayName.value, inviteCode: invite.value,
          });
        navigate('#/', { replace: true });
      } catch (ex) {
        err.textContent = ex.message;
        submit.disabled = false;
      }
    };

    clear(formHost, h('form', { class: 'card', onsubmit },
      h('label', { class: 'field' }, h('span', { class: 'lbl' }, '帳號', mode === 'register' ? h('span', { class: 'hint' }, '英文字母或數字，3–32 字') : null), username),
      h('label', { class: 'field' }, h('span', { class: 'lbl' }, '密碼', mode === 'register' ? h('span', { class: 'hint' }, '至少 6 個字元') : null), password),
      mode === 'register' ? h('label', { class: 'field' }, h('span', { class: 'lbl' }, '暱稱', h('span', { class: 'hint' }, '選填')), displayName) : null,
      mode === 'register' && inviteRequired ? h('label', { class: 'field' }, h('span', { class: 'lbl' }, '邀請碼'), invite) : null,
      err,
      submit,
    ));
  };

  clear(root, h('div', { class: 'auth-wrap' },
    h('div', { class: 'brand' },
      h('img', { src: 'icons/icon-192.png', alt: '' }),
      h('h1', null, '錯題閃卡'),
      h('p', null, '把錯題變成閃卡，隨機練習、間隔複習'),
    ),
    segmented([{ value: 'login', label: '登入' }, { value: 'register', label: '註冊新帳號' }], mode, (v) => { mode = v; draw(); }),
    h('div', { style: { height: '12px' } }),
    formHost,
  ));
  draw();
}
