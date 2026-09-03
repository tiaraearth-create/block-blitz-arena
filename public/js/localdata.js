// ---------------------------------------------------------------------------
// 🗄 端末に置いてある bba_* を1か所にまとめる
// ---------------------------------------------------------------------------
//
// ■ 何が問題だったか
//   ログアウトも「アカウントを完全削除」も、端末の localStorage を1つも
//   消していなかった（消えるのは bba_token と bba_me_cache だけ）。
//   各モードのベスト記録・解放状態・パズルの★・所持アイテムは、ログイン中でも
//   端末に書かれるので、**前の人の記録が次の人の画面にそのまま出る**。
//   逃げ道は設定の「ローカルデータをリセット」だけだが、あちらは
//   手書きの消去リストが実在キー（46種）から25種ぶん取り残されていたうえ、
//   消える側は音量も言語も一緒に飛ぶ ── 「全部消すか、何も消えないか」の
//   二択しか無かった。
//
// ■ どう直したか
//   キーを3つのバケツに分ける。
//     device … この端末の好み（音量・言語・既読・チュートリアル済み）。
//              持ち主が変わっても残す。消えると毎回チュートリアルが出る。
//     owned  … 「いま遊んでいる人」のもの（記録・解放・所持品・パズルの★）。
//              持ち主が変わったら **消すのではなく仕舞う**（下記）。
//     unlock … 隠し要素の解放印。持ち主とは別の規則で動くので独立させる。
//
//   owned は消さずに `bba_arch:<持ち主>` へ仕舞い、その人が戻ってきたら
//   戻す。消してしまうと、サーバーに控えが無いもの（パズルの★・カオスの
//   自己ベスト・サバイバルの最高得点・週間ベスト・デイリーの記録）が
//   本当に失われる ── 「前の人のデータが残る」を直すために
//   「自分のデータが消える」を作っては本末転倒なので、仕舞って戻す。
//
// ■ 増やすときは必ずここに足すこと
//   足し忘れは test/localkeys.test.mjs が落とす（public/ 全体から bba_* を
//   機械抽出して、この表と突き合わせている）。コメントで約束するのではなく
//   テストで落とすようにしてあるのは、前回まさに「コメントには2本から呼ぶと
//   書いてあるのに1本しか呼んでいない」で事故ったため。
// ---------------------------------------------------------------------------

// この端末の好み。持ち主が変わっても残る。
export const DEVICE_KEYS = [
  'bba_settings',        // 音量・パーティクル・画面シェイク等
  'bba_lang',            // 表示言語
  'bba_staff_ui',        // 運営専用ボタンの表示切替
  'bba_chaos_prefs',     // カオスの時間・変異間隔の既定
  'bba_opp_density',     // 相手ミニ盤面の出し方
  'bba_guest_name',      // ゲストとして名乗る名前（端末の設定であって記録ではない）
  'bba_clip_hint',       // クリップ書き出しの案内を見た
  'bba_rules_seen',      // 遊び方を見た
  'bba_news_seen',       // お知らせの既読位置
  'bba_tut_done',        // チュートリアル済み
  'bba_tut_vs_done',     // 対戦チュートリアル済み
  'bba_atk_lesson_taken',  // アタック戦の「お邪魔が来た」解説を見た
  'bba_atk_lesson_sent',   // アタック戦の「お邪魔を送った」解説を見た
];

// 「いま遊んでいる人」のもの。持ち主が変わったら仕舞う。
export const OWNED_KEYS = [
  // 各モードのベスト・到達記録
  'bba_best', 'bba_meltdown_best', 'bba_chimera_best', 'bba_dig_best',
  'bba_ghost_best', 'bba_chaos_best', 'bba_coop_best', 'bba_survival_best',
  'bba_survival_wave', 'bba_boss_max', 'bba_rush_depth', 'bba_weekly_best',
  'bba_daily_record', 'bba_chain_best', 'bba_chain_max',
  'bba_blueprint_clears', 'bba_blueprint_record',
  // ダンジョン4領域（塔・地下・天界・深淵）。以前は深淵だけが消去対象で、
  // 残り3つが端末に残っていた ＝ 次の人が到達階を引き継げた。
  'bba_dungeon_max', 'bba_dungeon_under_max', 'bba_dungeon_heaven_max', 'bba_dungeon_abyss_max',
  // パズル遺跡（★はサーバーに控えが無い ── 消すと本当に失われる）
  'bba_puzzle_stars', 'bba_puzzle_stage',
  // ゲストの所持品・選んだ必殺技
  'bba_items', 'bba_ult',
  // その人の操作の続き
  'bba_workshop_liked',  // 工房で♡した作品
  'bba_last_party',      // 直前に組んだ人（他人の名前とIDが入る）
  'bba_result_queue',    // 圏外で送れなかった結果の控え
];

// 前方一致で owned 扱いにするもの（キー名に値が混ざるため列挙できない）。
export const OWNED_PREFIXES = ['bba_sprint_'];

// 隠し要素の解放印。owned とは別規則（下の switchOwner のコメント参照）。
export const UNLOCK_KEYS = ['bba_kami', 'bba_souzou', 'bba_ghost'];

// この仕組み自身が使うキー。
export const OWNER_KEY = 'bba_owner';        // いまの持ち主（'guest' か 'u:<id>'）
export const UNLOCK_SRC_KEY = 'bba_unlock_src';  // 解放印をどこから得たか
export const ARCH_PREFIX = 'bba_arch:';      // 仕舞ってある持ち主ぶん
// 触らないもの（別の担当が持っている）。
export const EXTERNAL_KEYS = [
  'bba_token',       // net.js の setToken が持つ
  'bba_me_cache',    // dom.js の控え（持ち主が変わる瞬間に別途捨てる）
];

// 仕舞っておく持ち主の数。端末を家族で回すと際限なく増えるので上限を置く
// （溢れたら古い順に捨てる ── 捨てても遊べなくはならない類の記録だけ）。
const ARCHIVE_MAX_OWNERS = 4;

const ls = () => {
  try { return typeof localStorage !== 'undefined' ? localStorage : null; }
  catch { return null; }   // プライベートモード等でアクセス自体が投げる
};

/** その人を表す持ち主キー。ログインしていなければ 'guest'。 */
export function ownerKeyOf(user) {
  return user && user.id ? `u:${user.id}` : 'guest';
}

/** 実在する bba_* を全部数え上げる（store の中身を見る）。 */
function allKeys(store) {
  const out = [];
  for (let i = store.length - 1; i >= 0; i--) {
    const k = store.key(i);
    if (k && k.startsWith('bba_')) out.push(k);
  }
  return out;
}

const isOwnedKey = k => OWNED_KEYS.includes(k) || OWNED_PREFIXES.some(p => k.startsWith(p));

/**
 * キーの分類。テストと設定画面の説明文が同じ表を見るための入口。
 * 'device' | 'owned' | 'unlock' | 'internal' | 'external' | 'unknown'
 */
export function classify(key) {
  if (DEVICE_KEYS.includes(key)) return 'device';
  if (isOwnedKey(key)) return 'owned';
  if (UNLOCK_KEYS.includes(key)) return 'unlock';
  if (key === OWNER_KEY || key === UNLOCK_SRC_KEY || key.startsWith(ARCH_PREFIX)) return 'internal';
  if (EXTERNAL_KEYS.includes(key)) return 'external';
  return 'unknown';
}

// --- 解放印の出どころ -------------------------------------------------------
//
// 「この端末で自分で見つけた」のか「ログインしたアカウントから写ってきた」のかを
// 覚えておく。これが無いと、Aが解放した神・創造神が端末に残り、次にログインした
// Bのアカウントへ carryOverLocalUnlocks が恒久コピーしてしまう（しかもBの
// 一度きりの引き継ぎ枠まで使い切る）。

function readSrc(store) {
  try { return JSON.parse(store.getItem(UNLOCK_SRC_KEY) || '{}') || {}; }
  catch { return {}; }
}
function writeSrc(store, src) {
  const keys = Object.keys(src);
  if (!keys.length) store.removeItem(UNLOCK_SRC_KEY);
  else store.setItem(UNLOCK_SRC_KEY, JSON.stringify(src));
}

/** 解放印の出どころを記録する。owner は 'local'（自力）か 'u:<id>'（写し）。 */
export function noteUnlockSource(key, owner, store = ls()) {
  if (!store || !UNLOCK_KEYS.includes(key)) return;
  try {
    const src = readSrc(store);
    // 自力で見つけたものは、あとから写しで上書きしない（自力のほうが強い）。
    if (src[key] === 'local') return;
    src[key] = owner;
    writeSrc(store, src);
  } catch { /* 保存できなくても遊べる */ }
}

/** この端末で自力で解放したものだけ（アカウントへの引き継ぎ対象）。 */
export function locallyEarnedUnlocks(store = ls()) {
  if (!store) return [];
  const src = readSrc(store);
  return UNLOCK_KEYS.filter(k => {
    try { return store.getItem(k) === '1' && src[k] !== undefined && src[k] === 'local'; }
    catch { return false; }
  });
}

// --- 持ち主の入れ替え -------------------------------------------------------

function pruneArchives(store) {
  const owners = allKeys(store).filter(k => k.startsWith(ARCH_PREFIX));
  if (owners.length <= ARCHIVE_MAX_OWNERS) return;
  // 中身に仕舞った時刻を持たせていないので、localStorage の並び（古いほうが先）を
  // そのまま使う。厳密な最古でなくてよい ── 目的は「際限なく増やさない」こと。
  for (const k of owners.slice(0, owners.length - ARCHIVE_MAX_OWNERS)) store.removeItem(k);
}

/**
 * 持ち主が変わった（ログイン／ログアウト／アカウント切替）。
 *
 *   ・いまの持ち主の owned を `bba_arch:<持ち主>` へ仕舞う
 *   ・いまの持ち主から**写してきた**解放印を落とす（自力ぶんは残す ──
 *     残さないと「ゲストで見つけて登録する」引き継ぎが成立しない）
 *   ・次の持ち主の控えがあれば戻す
 *
 * 返り値は何をしたかの内訳（テストと開発時の確認用）。
 */
export function switchOwner(next, store = ls()) {
  const done = { from: null, to: next, stashed: 0, restored: 0, unlocksDropped: 0, adopted: 0 };
  if (!store) return done;
  try {
    const first = store.getItem(OWNER_KEY) === null;
    const cur = store.getItem(OWNER_KEY) || 'guest';
    done.from = cur;

    // 🕰 初回だけの移行。この仕組みが入る前の端末には解放印の出どころが
    //    記録されていない。「いま誰なのか」で埋めるのがいちばん当たる ──
    //    ログイン中なら、その解放はアカウントから写ってきたぶん。ゲストなら
    //    自分で見つけたぶん。埋めておかないと、既存ユーザーの
    //    「ゲストで見つけて、登録して引き継ぐ」が黙って動かなくなる。
    //    cur === next で下に抜けるより前に済ませること（ゲストのままだと
    //    切替が起きず、いつまでも埋まらない）。
    if (first) {
      const presumed = next === 'guest' ? 'local' : next;
      const src = readSrc(store);
      for (const k of UNLOCK_KEYS) {
        if (src[k] !== undefined) continue;
        if (store.getItem(k) !== '1') continue;
        src[k] = presumed;
        done.adopted++;
      }
      if (done.adopted) writeSrc(store, src);
    }

    if (cur === next) {
      if (first) store.setItem(OWNER_KEY, next);
      return done;
    }

    // 1) いまの持ち主のぶんを仕舞う
    const stash = {};
    for (const k of allKeys(store)) {
      if (!isOwnedKey(k)) continue;
      const v = store.getItem(k);
      if (v === null) continue;
      stash[k] = v;
      store.removeItem(k);
    }
    done.stashed = Object.keys(stash).length;
    if (done.stashed) store.setItem(ARCH_PREFIX + cur, JSON.stringify(stash));
    else store.removeItem(ARCH_PREFIX + cur);

    // 2) 写してきた解放印だけ落とす
    const src = readSrc(store);
    for (const k of UNLOCK_KEYS) {
      if (src[k] !== cur) continue;      // 'local'（自力）と他人ぶんは触らない
      store.removeItem(k);
      delete src[k];
      done.unlocksDropped++;
    }
    writeSrc(store, src);

    // 3) 次の持ち主の控えを戻す
    let saved = null;
    try { saved = JSON.parse(store.getItem(ARCH_PREFIX + next) || 'null'); }
    catch { saved = null; }
    if (saved && typeof saved === 'object' && !Array.isArray(saved)) {
      for (const [k, v] of Object.entries(saved)) {
        if (!isOwnedKey(k) || typeof v !== 'string') continue;
        store.setItem(k, v);
        done.restored++;
      }
      store.removeItem(ARCH_PREFIX + next);
    }

    store.setItem(OWNER_KEY, next);
    pruneArchives(store);
  } catch { /* 容量超過・プライベートモード。仕舞えなくても遊べる */ }
  return done;
}

/**
 * その持ち主を端末から完全に忘れる（アカウントを削除したとき）。
 * 仕舞ってある控えごと捨てる ── 戻す先のアカウントがもう無いので、
 * 残しておく意味が無い（残すと「消したはずの記録」が端末に残り続ける）。
 */
export function forgetOwner(owner, store = ls()) {
  if (!store) return 0;
  let n = 0;
  try {
    const cur = store.getItem(OWNER_KEY) || 'guest';
    if (cur === owner) {
      for (const k of allKeys(store)) {
        if (!isOwnedKey(k)) continue;
        store.removeItem(k); n++;
      }
      const src = readSrc(store);
      for (const k of UNLOCK_KEYS) {
        if (src[k] !== owner) continue;
        store.removeItem(k); delete src[k]; n++;
      }
      writeSrc(store, src);
      store.setItem(OWNER_KEY, 'guest');
    }
    if (store.getItem(ARCH_PREFIX + owner) !== null) { store.removeItem(ARCH_PREFIX + owner); n++; }
  } catch { /* ignore */ }
  return n;
}

// --- 設定画面のリセット -----------------------------------------------------

/**
 * mode:
 *   'records' … 記録・解放・所持品だけ消す（音量・言語・既読は残す）
 *   'all'     … bba_* を丸ごと消す（ログイン状態＝bba_token だけは残す）
 *
 * 'all' は**列挙ではなく前方一致**で消す。手書きの一覧は必ず取り残しが出る
 * （実際、直す前は46キー中25キーが消し残されていた）。
 */
export function resetLocal(mode, store = ls()) {
  const removed = [];
  if (!store) return removed;
  try {
    for (const k of allKeys(store)) {
      const kind = classify(k);
      if (mode === 'all') {
        if (k === 'bba_token') continue;      // ここで消すとログアウト扱いになる
      } else if (kind !== 'owned' && kind !== 'unlock' && !k.startsWith(ARCH_PREFIX)) {
        continue;
      }
      store.removeItem(k);
      removed.push(k);
    }
    if (mode !== 'all') store.removeItem(UNLOCK_SRC_KEY);
  } catch { /* ignore */ }
  return removed;
}
