// 間隔重複排程（SM-2 變形，規則與 server/srs.py 相同）
// grade：again（答錯）/ hard（猜對）/ good（答對）/ easy
// - 答錯：10 分鐘後再出現，熟練度歸零、ease 下降
// - 答對：第一次 1 天、第二次 3 天，之後間隔 × ease
// - 還沒到期就答對（例如隨機練習時）不改排程；答錯一律重來
export const MASTERED_DAYS = 21;
const MIN_EASE = 1.3;
const MAX_INTERVAL = 365;
const RELEARN_MINUTES = 10;
export const GRADES = ['again', 'hard', 'good', 'easy'];

export function newCard(questionId) {
  return { questionId, reps: 0, interval: 0, ease: 2.5, dueAt: null, lapses: 0, attempts: 0, correct: 0, lastResult: null, lastAt: null };
}

const round = (v, digits) => Math.round(v * 10 ** digits) / 10 ** digits;

export function schedule(card, grade, now = new Date()) {
  const c = { ...card };
  c.attempts += 1;
  c.lastAt = now.toISOString();
  if (grade === 'again') {
    if (c.reps > 0) c.lapses += 1;
    c.reps = 0;
    c.interval = 0;
    c.ease = Math.max(MIN_EASE, c.ease - 0.2);
    c.dueAt = new Date(now.getTime() + RELEARN_MINUTES * 60000).toISOString();
    c.lastResult = 0;
    return c;
  }
  c.correct += 1;
  c.lastResult = 1;
  if (c.reps > 0 && c.dueAt && new Date(c.dueAt) > now) return c; // 提早複習且答對：排程不動

  let { reps, interval, ease } = c;
  if (grade === 'hard') {
    ease = Math.max(MIN_EASE, ease - 0.15);
    interval = reps === 0 ? 1 : Math.max(interval * 1.2, interval + 1);
  } else if (grade === 'good') {
    interval = reps === 0 ? 1 : reps === 1 ? 3 : interval * ease;
  } else {
    ease += 0.15;
    interval = reps === 0 ? 3 : Math.max(interval * ease * 1.3, 4);
  }
  c.reps = reps + 1;
  c.ease = round(ease, 3);
  c.interval = round(Math.min(interval, MAX_INTERVAL), 2);
  c.dueAt = new Date(now.getTime() + c.interval * 86400000).toISOString();
  return c;
}
