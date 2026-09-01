// 住人（AIプレイヤー）の正体を、**管理者以外へ渡す直前**に削ぎ落とす共通の関門。
//
// ■ なぜ1か所にまとめるのか
// 住人の正体は「1本の派手な穴」ではなく「あちこちに1文字ずつ落ちている粉」で
// 漏れる ── match_found の isBot、プロフィールの kind:'resident'、ギルドの
// ghost:true、キュー画面の botInSec という**フィールド名そのもの**。
// 送信箇所は数十あり、これからも増える。増えるたびに気づける人はいないので、
// 「非管理者へ出る最後の1点」で機械的に落とす関門を置く。
//
// ■ 手本
// server/polls.js の pollView(poll, userId, admin) ── admin フラグで正しく
// 出し分けている唯一の例。あれを「キー単位・再帰」に一般化したものがこれ。
//
// ■ 関門は保険であって設計ではない
// 個別の送信箇所でも「最初から出さない」のが正しい（index.js の /api/profile、
// battle.js の match_found などは実際にそう直してある）。関門の役目は
// 「将来また誰かがキーを足したとき」に事故を止めることであって、
// これがあるから雑に足してよい、という意味ではない。
//
// ■ 管理者には従来どおり全部返す
// 管理者パネルは住人と実プレイヤーを区別できないと仕事にならない（名簿・
// 投票の内訳・殿堂の顔ぶれ）。admin なら値をそのまま素通しする。
// /api/admin/* は経路ごと関門をバイパスする（secrecyMiddleware 参照）。

import crypto from 'crypto';

// ---------------------------------------------------------------------------
// 落とすキー
// ---------------------------------------------------------------------------
// 「その名前が出ている時点で正体を明かしている」キーだけを並べる。
// 値の中身は見ない ── isBot:false も、住人でない人にだけ付く印なので同罪
// （「この人にだけ isBot が無い」は「この人はボット」と同じ情報量）。
export const SECRET_KEYS = new Set([
  // 正体そのもの
  'isBot', 'bot', 'ai', 'resident', 'npc', 'fake', 'ghost', 'human',
  // アーキタイプ（「ガチ勢」「夜型」…）— 実プレイヤーには存在しない属性
  'archLabel', 'archLabelEn', 'arch', 'archs',
  // 住人の素の設定値
  'skill', 'chatty', 'quirk', 'custom', 'registered', 'fakeLevel', 'residentId',
  // フィールド名そのものが「相手はボット」と言っているもの
  'botInSec',
  // 投票の内訳（AI票／実プレイヤー票）は運営の数字
  'aiVoters', 'realVoters',
  // ライブフィードの ⭐ 印。実プレイヤーの出来事にだけ real:true が付くので、
  // 裏返すと「⭐が無い名前＝住人」の総当たり表になる。⭐ を消すのは惜しいが、
  // 「絶対にバレないように」と両立しない。
  'real',
]);

export function isSecretKey(key) {
  return SECRET_KEYS.has(key);
}

// ---------------------------------------------------------------------------
// id の匿名化
// ---------------------------------------------------------------------------
// 住人 `r12` / 追加住人 `x3` / ゴーストギルド `ghost0` / 王座の `res:r12` は、
// 形を見ただけで「連番＝生成物」と分かる。実ギルドの id は randomUUID なので、
// 同じ形（UUID）の不透明な値に置き換える。
//
// 塩は**プロセスごとにランダム**。固定の塩だと `r0`〜`r239` はたかだか数百通り
// なので、アルゴリズムを知っている人に総当たりで元の id を引き当てられる
// （＝匿名化になっていない）。ゴーストギルドの id は起動のたびに変わるが、
// 週間ポイントやクエストの進み具合は内部の seedKey で計算しているので数字は
// 動かない（guilds.js の ghostGuilds 参照）。
const ANON_SALT = crypto.randomBytes(24);
const anonCache = new Map();
const ANON_CACHE_MAX = 4000;

export function anonId(key) {
  const k = String(key);
  const hit = anonCache.get(k);
  if (hit) return hit;
  const h = crypto.createHmac('sha256', ANON_SALT).update(k).digest('hex');
  // 実ギルド/実ユーザーの id（randomUUID）と同じ見た目にそろえる。
  const v = `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
  // 名簿の入れ替えを繰り返すと際限なく増えるので、上限で丸ごと捨てる
  // （捨てても再計算できる ── 同じプロセスの間は同じ値に落ち着く）。
  if (anonCache.size >= ANON_CACHE_MAX) anonCache.clear();
  anonCache.set(k, v);
  return v;
}

// 連番 id かどうか。**キー名が id 系のときだけ**当てること ── ユーザー名は
// 2文字から作れるので「r12」というプレイヤーは実在しうる。username を
// この正規表現に通すと、その人だけ名前が UUID に化ける。
const RESIDENT_ID_RE = /^(?:res:)?(?:ghost|r|x)\d+$/;
const isIdKey = k => k === 'id' || (k.length > 2 && k.endsWith('Id'));

// 深すぎる入れ子と循環参照の保険。JSON にする値しか通らない想定だが、
// 関門で無限ループして全プレイヤーの通信が止まる、が最悪の失敗なので必ず止める。
const MAX_DEPTH = 32;

// 変更が要らなければ**元のオブジェクトをそのまま返す**（copy-on-write）。
// send() は royale_state を毎秒×人数ぶん通すので、素通しの回で確保が走ると
// そのまま GC の負荷になる。
function scrubValue(v, depth, seen) {
  if (v === null || typeof v !== 'object') return v;
  if (depth > MAX_DEPTH || seen.has(v)) return Array.isArray(v) ? [] : {};
  seen.add(v);
  try {
    if (Array.isArray(v)) {
      let out = v;
      for (let i = 0; i < v.length; i++) {
        const nv = scrubValue(v[i], depth + 1, seen);
        if (nv !== v[i]) {
          if (out === v) out = v.slice();
          out[i] = nv;
        }
      }
      return out;
    }
    let out = v;
    const touch = () => { if (out === v) out = { ...v }; return out; };
    for (const k of Object.keys(v)) {
      const raw = v[k];
      if (SECRET_KEYS.has(k)) { delete touch()[k]; continue; }
      // kind:'resident' は値のほうが正体を明かす（/api/profile）。
      if (k === 'kind' && raw === 'resident') { touch()[k] = 'player'; continue; }
      if (typeof raw === 'string') {
        if (isIdKey(k) && RESIDENT_ID_RE.test(raw)) touch()[k] = anonId(raw);
        continue;
      }
      const nv = scrubValue(raw, depth + 1, seen);
      if (nv !== raw) touch()[k] = nv;
    }
    return out;
  } finally {
    seen.delete(v);
  }
}

// 非管理者へ返す形。渡した値は書き換えない（chatHistory のような
// サーバー側の実体をそのまま通すので、破壊すると保存まで巻き添えになる）。
export function scrub(value) {
  return scrubValue(value, 0, new Set());
}

export function scrubFor(admin, value) {
  return admin ? value : scrub(value);
}

// ---------------------------------------------------------------------------
// Express の関門
// ---------------------------------------------------------------------------
// res.json を1枚かぶせて、返す直前に通す。
//   ・/api/admin/* は丸ごとバイパス（管理者パネルが壊れる）
//   ・それ以外は req.user.role === 'admin' のときだけ素通し
// authMiddleware より **後** に登録すること（req.user が要る）。
export function secrecyMiddleware(isAdmin, { bypass = /^\/api\/admin\// } = {}) {
  return function secrecyGate(req, res, next) {
    if (bypass.test(req.path)) return next();
    const orig = res.json.bind(res);
    res.json = body => orig(scrubFor(!!isAdmin(req), body));
    next();
  };
}
