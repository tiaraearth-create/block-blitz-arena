// Backup / restore + local snapshots.
//
// The hosting tier this game runs on has an ephemeral filesystem: a redeploy
// wipes server/data. The admin panel can download a backup before deploying
// and upload it again afterwards — this module validates and applies it.
//
// Restore defaults to MERGE, because players may have registered again in the
// window between the wipe and the restore; merging keeps both populations and,
// for a username that exists on both sides, keeps whichever record has more
// progress. `replace` is available when you really want the file to win.

import fs from 'fs';
import path from 'path';
import { DATA_DIR } from './db.js';
import { GUILD_ICONS } from './guilds.js';
// 🗒 住人の戦績の差分表の上限。写経すると実装とズレるので実体から読む。
import { pruneResidentRecords } from './residents.js';

const SNAP_DIR = path.join(DATA_DIR, 'snapshots');
// 保持は「全体で12件」だけだった。ところが自動で撮られるのは起動時の1件で、
// デプロイのたびに1枠を食う。実際、この機体の snapshots は12件すべてが _boot
// （うち2件は90秒差）になっていて、復元前(pre-restore)・巻き戻し前(pre-rollback)・
// 手動(manual) の退避は1件も残っていなかった ── いちばん要るときに戻れない。
//
// そこで「自動で増える種類」にだけ枠を切り、残りを退避のために空けておく。
// 全体の枠も少し広げる（1件あたり db.json 1本ぶんなので、いまの規模で数百KB）。
const KEEP_SNAPSHOTS = 16;
// ラベルごとの上限。ここに載っているものだけが「自動で増える」種類で、
// 全体の枠が足りなくなったときも先に捨てられる側。pre-restore / pre-rollback /
// manual は載せない（＝押し出されるのは最後）。
const LABEL_KEEP = { boot: 3, hourly: 6 };

export const BACKUP_VERSION = 2;

// --- validation -----------------------------------------------------------

// Returns { ok: true, stats } or { ok: false, error }.
// 復元で受け付けるユーザー数の上限。
//
// ここは 20,000 だった。だがこの門より手前に「本文のバイト数」の門があり
// （index.js の RESTORE_LIMIT_MB）、1人あたりの実測は
//   新規 1,351B / 遊び込み 2,403B / 全解放 6,152B
// なので、20,000人ぶんは最も軽い見積りでも 27MB になる。つまり件数の上限には
// 決して到達せず、『ユーザー数が多すぎます』という具体的な案内は一度も
// 表示されなかった（必ず先に 413 のバイト数エラーで落ちる）。
//
// この上限が本来守っているのは**メモリではなく CPU** ── 復元の後段には
// ユーザー1人あたり pbkdf2（1回13ms前後）が回り、Node は1本の処理列なので、
// その間サーバー全体が何も応答できない。20,000件なら260秒。バイト数の門
// （12MB ≒ 最も軽い見積りで約9,300人）より内側に置いて初めて意味を持つので、
// 「実際に到達しうる件数」まで下げる。8,000件でも pbkdf2 だけで約100秒 ——
// これ以上を1回で流し込ませない、が意図。
export const MAX_RESTORE_USERS = 8_000;

// 📏 復元の「合流(union)」で配列を切る上限。書き込み口と同じ値でなければ
// 意味が無いが、その定数は index.js / routes/shop.js にあり、どちらも
// backup.js を import する側なので、こちらから読むと循環参照になる。
// そこで値はここに置き、**ズレたら落ちるように** test/persist-registry の
// 検査が両方のソースを読んで突き合わせている（写経の危険をテストで塞ぐ）。
//   NEWS_CAP             … index.js の `if (db.news.length > 200) db.news.shift()`
//   TX_CAP               … routes/shop.js の TX_KEEP
//   BUGREPORT_CAP_MIRROR … index.js の BUGREPORT_CAP
export const NEWS_CAP = 200;
export const TX_CAP = 200;
export const BUGREPORT_CAP_MIRROR = 300;

export function validateBackup(data) {
  if (!data || typeof data !== 'object') return { ok: false, error: 'バックアップの形式が不正です' };
  if (!data.users || typeof data.users !== 'object' || Array.isArray(data.users)) {
    return { ok: false, error: 'users が見つかりません（正しいバックアップファイルですか？）' };
  }
  const users = Object.values(data.users);
  if (users.length === 0) return { ok: false, error: 'ユーザーが0件です。安全のため復元を中止しました' };
  // 件数の上限。復元の後段にはユーザー1人あたり pbkdf2 を回す処理があり
  // （1回13ms前後）、Node は1本の処理列で動くので、その間サーバー全体が
  // 何も応答できなくなる。5万件詰めたファイルを1回投げるだけで10分以上
  // 止められた。実在しうる規模から充分に離れた位置で頭を打たせる。
  if (users.length > MAX_RESTORE_USERS) {
    return { ok: false, error: `ユーザー数が多すぎます（${users.length}件 / 上限${MAX_RESTORE_USERS}件）` };
  }
  for (const u of users) {
    if (!u || typeof u !== 'object' || !u.id || !u.username || !u.passHash || !u.salt) {
      return { ok: false, error: 'ユーザーレコードが壊れています（id/username/パスワードハッシュが必要）' };
    }
  }
  return {
    ok: true,
    stats: {
      users: users.length,
      admins: users.filter(u => u.role === 'admin').length,
      tokens: data.tokens ? Object.keys(data.tokens).length : 0,
      transactions: Array.isArray(data.transactions) ? data.transactions.length : 0,
      savedAt: data.meta && data.meta.backupAt ? data.meta.backupAt : null,
    },
  };
}

// 復元で入ってくるギルドは、これまで一切検証されていなかった。
// 名前・タグ・説明はクライアント側でエスケープされているのに、アイコンだけが
// 素通しで innerHTML に入るため、細工したアイコンを仕込んだデータを流し込むと、
// ギルドランキング（ログイン不要で誰でも開ける）を見た全員に影響しえた。
// 表示側も直したが、そもそも入れさせない。
// 直すのはアイコンだけで、他の欄は **わざと** そのまま通す（spread）。
// ここを「通してよい欄の一覧」にしてはいけない ── db.meta で一度やらかした
// のと同じ形で、後から増えた欄（guild.quests＝週ごとのギルドクエストの進行と
// 達成時刻）が復元のたびに黙って消える。
function sanitizeGuilds(guilds) {
  const out = {};
  for (const [id, g] of Object.entries(guilds)) {
    if (!g || typeof g !== 'object') continue;
    if (!Object.prototype.hasOwnProperty.call(guilds, id)) continue;
    out[id] = { ...g, icon: GUILD_ICONS.includes(g.icon) ? g.icon : GUILD_ICONS[0] };
  }
  return out;
}

const isPlainObj = o => !!o && typeof o === 'object' && !Array.isArray(o);
// JSON.parse は "__proto__" を素の own プロパティとして作る。ファイル由来の
// キーで新しい入れ物を組み立てるときは必ずここを通す。
const unsafeKey = k => k === '__proto__' || k === 'constructor' || k === 'prototype';

// --- 🧩 パズル工房と 🎞 デイリーリプレイ（db.meta 配下）の合流 ----------------
//
// この2つは db.meta の他のキーと違って「片方だけを採る」では済まない。
// db.meta の既定の規則は『生きている側がまだ値を持っていないキーだけ採用する』
// なので、ディスクが飛んだあと復元するまでの窓で誰かが1つでもステージを
// 投稿すると（＝live 側に db.meta.workshop ができると）、**バックアップに
// 入っていた全ステージが丸ごと落ちる**。プレイヤーの作品が復元で消えるのは
// このファイルが防ぐべき事故の中でも最悪の部類なので、中身を突き合わせて
// 合流させる。
//
// 工房のデータは全部 db.meta.workshop の中にある（ユーザーのレコード側には
// 投稿数もいいね履歴も還元記録も持っていない ── 投稿数は stages を by で
// 数え、いいね済みは stage.likedBy、還元は payout.by で見ている）。
// だから mergeEarned ではなくここが工房の保全の全てになる。
const WS_CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';  // index.js の WS_CODE_CHARS と同じ表
const WS_CODE_LEN = 6;
const WS_LIKE_MAX = 3000;                 // index.js の WS_LIKE_MAX
const WS_AUTHOR_COIN_DAY_CAP = 300;       // index.js の WS_AUTHOR_COIN_DAY_CAP
const DAILY_REPLAY_KEEP = 60;             // index.js の DAILY_REPLAY_KEEP
const DAILY_REPLAY_DAYS = 2;              // index.js の DAILY_REPLAY_DAYS
// 🧩 パズル遺跡の「その日その番号は勝利1回まで」の印が覚えるステージ数。
// index.js の PUZ_WIN_DAY_KEEP と同じ意味。ここは合流時の頭押さえにしか
// 使わないので、実装側と多少ずれても止め金としての性質は変わらない
// （細工したファイルで配列を無限に伸ばさせない、が目的）。
const PUZ_WIN_DAY_KEEP = 200;

// 🕒 在席区間ログ（user.stats.online = [{ at, ms }]）が覚えておく件数の上限。
//
// なぜ**この**ファイルに置いてあるのか:
//   記録するのは server/battle.js（hello / close）、合流するのはここ。
//   2箇所で違う数を持つと「復元のたびに件数が増える／減る」になるので、
//   ひとつの定数を両方から読みたい。逆向き（battle.js に置いて backup.js が
//   読む）にすると、backup.js を単体で import しているテスト
//   （test/dbsafety.test.mjs）が WebSocket サーバーごと読み込むことになる。
//   battle.js → backup.js の向きなら循環もしない（backup.js が引くのは
//   fs / db.js / guilds.js / residents.js だけ）。
//
// db.json は保存のたびに丸ごと書き出されるので、ここは**必ず**上限が要る。
// 1人30件（1件あたり2つの数値）なら1万人でも数MB以内に収まる。
// 環境変数はテスト用（上限そのものを外せないよう 5〜200 に丸める）。
export const ONLINE_SPANS_MAX = (() => {
  const v = Number(process.env.ONLINE_SPANS_MAX);
  return Number.isFinite(v) ? Math.max(5, Math.min(200, Math.floor(v))) : 30;
})();

// 共有コードが空いているものを引く（衝突した作品の引っ越し先）。
function freeWorkshopCode(stages) {
  for (let tries = 0; tries < 200; tries++) {
    let c = '';
    for (let i = 0; i < WS_CODE_LEN; i++) c += WS_CODE_CHARS[Math.floor(Math.random() * WS_CODE_CHARS.length)];
    if (!stages[c]) return c;
  }
  return null;
}

// 同じ作品か。共有コードは6文字のランダムなので、別々の機体で同じコードが
// 振られる可能性はゼロではない。作者と投稿時刻で見分ける。
const sameStage = (a, b) => a.by === b.by && a.at === b.at;

// 同じ1作品の2つのコピーを1つにまとめる。
function unionStage(cur, inc) {
  // ❤️ いいね済みは **和集合**。ここが二重いいねを止めている唯一の記録なので、
  // 片方に入っていた人を落とすと、復元後にその人がもう一度♡を押せてしまう。
  const a = Array.isArray(cur.likedBy) ? cur.likedBy : (cur.likedBy = []);
  const seen = new Set(a);
  for (const id of (Array.isArray(inc.likedBy) ? inc.likedBy : [])) {
    if (!id || seen.has(id) || a.length >= WS_LIKE_MAX) continue;
    a.push(id); seen.add(id);
  }
  // likes は表示用の数。和集合の件数と、両側が申告している数の大きいほうを採る
  // （古い記録が likedBy を持っていない場合に♡が減って見えないように）。
  cur.likes = Math.max(a.length, Number(cur.likes) || 0, Number(inc.likes) || 0);
  cur.plays = Math.max(Number(cur.plays) || 0, Number(inc.plays) || 0);
  // 片方の作品データが欠けていたら補う。盤面が無いステージは遊べない＝
  // 事実上失われたのと同じなので、拾えるものは拾う。
  if (!Array.isArray(cur.board) && Array.isArray(inc.board)) cur.board = inc.board;
  if (!Array.isArray(cur.pieces) && Array.isArray(inc.pieces)) cur.pieces = inc.pieces;
  if (!Array.isArray(cur.solution) && Array.isArray(inc.solution)) cur.solution = inc.solution;
  if (!cur.title && inc.title) cur.title = inc.title;
  if (!cur.byName && inc.byName) cur.byName = inc.byName;
}

// db.meta.workshop の合流。live を書き換えて返す。
function mergeWorkshop(live, inc) {
  if (!isPlainObj(inc)) return isPlainObj(live) ? live : undefined;
  if (!isPlainObj(live)) live = {};
  const stages = isPlainObj(live.stages) ? live.stages : (live.stages = {});
  for (const [code, s] of Object.entries(isPlainObj(inc.stages) ? inc.stages : {})) {
    if (!isPlainObj(s) || unsafeKey(code)) continue;
    const cur = stages[code];
    if (!cur || !isPlainObj(cur)) { stages[code] = { ...s, code }; continue; }
    if (sameStage(cur, s)) { unionStage(cur, s); continue; }
    // 同じコードに別の作品が座っている。片方を捨てるのは「プレイヤーの作品を
    // 失う」ことなので、空いているコードへ移して両方残す（共有された古い
    // コードは live 側の作品を指したままになるが、作品自体は消えない）。
    const moved = freeWorkshopCode(stages);
    if (moved) stages[moved] = { ...s, code: moved };
  }
  // 🪙 作者への還元記録（その日いくら払ったか）。同じ日なら **足して** から
  // 1日の上限で止める ── ディスクが飛んだあとに払った分とファイルに残って
  // いる分は別の支払いなので、大きいほうを採ると上限をもう一周できてしまう。
  // 迷ったら閉じる側。日が違うときは新しい日の記録を残す（古い日の記録は
  // index.js の workshopPayoutDay が次の支払いで作り直すので止め金にならない）。
  const lp = live.payout, ip = inc.payout;
  if (isPlainObj(ip)) {
    if (!isPlainObj(lp)) live.payout = ip;
    else if (String(lp.day) === String(ip.day)) {
      const by = isPlainObj(lp.by) ? lp.by : (lp.by = {});
      for (const [uid, n] of Object.entries(isPlainObj(ip.by) ? ip.by : {})) {
        if (unsafeKey(uid)) continue;
        by[uid] = Math.min(WS_AUTHOR_COIN_DAY_CAP, (Number(by[uid]) || 0) + (Number(n) || 0));
      }
    } else if (String(ip.day) > String(lp.day)) {   // 'YYYY-MM-DD' は辞書順＝時系列順
      live.payout = ip;
    }
  }
  return live;
}

// db.meta.dailyReplays の合流。
// 日替わりで捨てられる一時データなので「絶対に失ってはいけない」類ではないが、
// 落とすと 👻ゴースト盤面がその日いっぱい空になる（＝復元直後にちょうど
// 見に来た人にだけ機能が消えて見える）。突き合わせは1日ぶんを uid で束ねる
// だけで済むので保全する。上限は index.js と同じ「新しい2日 × 60件」で
// 押さえるので、細工したファイルで db.json を膨らませることはできない。
function mergeDailyReplays(live, inc) {
  if (!isPlainObj(inc)) return isPlainObj(live) ? live : undefined;
  if (!isPlainObj(live)) live = {};
  for (const [day, rows] of Object.entries(inc)) {
    // 日付キーの形を必ず確かめる（"__proto__" もここで落ちる）。
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || !Array.isArray(rows)) continue;
    const cur = Array.isArray(live[day]) ? live[day] : (live[day] = []);
    const byUid = new Map();
    for (const r of cur) if (r && r.uid) byUid.set(r.uid, r);
    for (const r of rows) {
      if (!r || !r.uid || !Array.isArray(r.moves)) continue;
      const have = byUid.get(r.uid);
      if (!have) { cur.push(r); byUid.set(r.uid, r); continue; }
      // 1人1行。よいほうの回を残す（ボードに載るのはその人のベスト）。
      if ((Number(r.score) || 0) > (Number(have.score) || 0)) Object.assign(have, r);
    }
    live[day] = cur
      .sort((a, b) => ((b.score || 0) - (a.score || 0)) || ((a.at || 0) - (b.at || 0)))
      .slice(0, DAILY_REPLAY_KEEP);
  }
  for (const d of Object.keys(live).sort().reverse().slice(DAILY_REPLAY_DAYS)) delete live[d];
  return live;
}

// db.meta.residentRecords（🗒 住人の戦績の差分）の合流。
//
// これも「片方だけを採る」では守れない。db.meta の既定の規則は
// 『live 側がまだ値を持っていないキーだけ採用する』なので、ディスクが飛んで
// から復元するまでの窓で **誰か1人がレート戦を1回終えるだけ** で live 側に
// この欄ができ、バックアップに入っていた住人の戦績が丸ごと落ちる。
// 落ちると「昨日1敗つけた相手が、今日は無敗に戻っている」が起きる ──
// この機構が守ろうとしている「住人が人間に見えること」そのものを壊す。
//
// 突き合わせの規則（キーは住人の**名前**。理由は residents.js の台帳の節）:
//   ・勝敗と自己ベストは増える一方の数なので、両側の大きいほう。
//     足し算にすると、同じ試合が両側に入っているぶんだけ復元のたびに
//     戦績が水増しされる（＝復元を2回やった住人だけ倍の敗戦を背負う）。
//   ・レートの差分(rd)と当日の連戦カウンタ(d/dn)は、新しい側（at が大きいほう）。
//     こちらは「合計」ではなく「今の状態」なので、混ぜずに片方を採る。
//   ・上限は residents.js の RESIDENT_RECORD_MAX。細工したファイルで
//     db.json を膨らませられないよう、合流のあとに必ず切る。
function mergeResidentRecords(live, inc) {
  if (!isPlainObj(inc)) return isPlainObj(live) ? live : undefined;
  if (!isPlainObj(live)) live = {};
  const n = v => (Number.isFinite(Number(v)) ? Number(v) : 0);
  for (const [name, row] of Object.entries(inc)) {
    if (unsafeKey(name) || !isPlainObj(row)) continue;
    const cur = live[name];
    if (!isPlainObj(cur)) { live[name] = row; continue; }
    const newer = n(row.at) > n(cur.at) ? row : cur;
    live[name] = {
      w: Math.max(n(cur.w), n(row.w)),
      l: Math.max(n(cur.l), n(row.l)),
      bs: Math.max(n(cur.bs), n(row.bs)),
      rd: n(newer.rd),
      at: Math.max(n(cur.at), n(row.at)),
      d: n(newer.d), dn: n(newer.dn),
    };
  }
  pruneResidentRecords(live);
  return live;
}

// 名前で照合して id が入れ替わった人を、db.meta 側の記録でも読み替える。
// 工房の作者(by)・いいね済み(likedBy)・還元記録(payout.by)と、リプレイの uid は
// すべてユーザー id なので、やらないと「自分の作品なのに削除できない」
// 「一度押した♡をもう一度押せる」「還元の1日上限がリセットされる」が起きる。
function remapMetaIds(meta, idRemap) {
  if (!isPlainObj(meta) || !idRemap || !idRemap.size) return;
  const w = meta.workshop;
  if (isPlainObj(w)) {
    if (isPlainObj(w.stages)) {
      for (const s of Object.values(w.stages)) {
        if (!isPlainObj(s)) continue;
        if (s.by && idRemap.has(s.by)) s.by = idRemap.get(s.by);
        if (Array.isArray(s.likedBy)) {
          const out = [];
          for (const id of s.likedBy) {
            const n = idRemap.get(id) || id;
            if (n && !out.includes(n)) out.push(n);
          }
          s.likedBy = out;
          s.likes = Math.max(Number(s.likes) || 0, out.length);
        }
      }
    }
    if (isPlainObj(w.payout) && isPlainObj(w.payout.by)) {
      const by = {};
      for (const [id, n] of Object.entries(w.payout.by)) {
        const k = idRemap.get(id) || id;
        if (unsafeKey(k)) continue;
        // 同じ人の2つの id が1つに畳まれたら、払った額は足す（上限で止める）。
        by[k] = Math.min(WS_AUTHOR_COIN_DAY_CAP, (Number(by[k]) || 0) + (Number(n) || 0));
      }
      w.payout.by = by;
    }
  }
  const dr = meta.dailyReplays;
  if (isPlainObj(dr)) {
    for (const [day, rows] of Object.entries(dr)) {
      if (!Array.isArray(rows)) continue;
      const seen = new Map();
      for (const r of rows) {
        if (!r || !r.uid) continue;
        r.uid = idRemap.get(r.uid) || r.uid;
        const have = seen.get(r.uid);
        // 付け替えで同じ人の行が2つになることがある。よいほうだけ残す。
        if (!have || (Number(r.score) || 0) > (Number(have.score) || 0)) seen.set(r.uid, r);
      }
      dr[day] = rows.filter(r => r && r.uid && seen.get(r.uid) === r);
    }
  }
}

// How "far along" a user record is — used to pick a winner on username clashes.
function progressOf(u) {
  const s = (u && u.stats) || {};
  return (s.gamesPlayed || 0) * 1e9
    + (s.totalScore || 0)
    + (u.coins || 0) + (u.gems || 0) * 10 + (u.xp || 0);
}

// Claimed achievements, badges, owned cosmetics, item counts and battle-pass
// progress are EARNED — the winner-takes-the-record merge must not un-earn
// them just because the other copy of the account had more raw progress.
// (This was why "アップデートのたびに実績をもう一度受け取り" happened whenever
// the losing side of a merge held the claimed list.)
// Known tradeoff: if the LOSING copy bought something, the winner keeps its
// own (pre-purchase) currency while the purchase is unioned in — a one-time
// windfall for that player. Acceptable: losing purchases outright is worse,
// and the boot-time seed merge only ever applies a given seed once.
// 名前は「稼いだもの」だが、BAN／ミュートの和集合もここに置いてある。
// 勝ち負けのどちらの枝からも必ず通る唯一の場所だから（下の理由を参照）。
function mergeEarned(winner, loser) {
  if (!winner || !loser) return;
  // 🚫 BAN／ミュートは勝ち負けと無関係に和集合を採る。ここに置いてあるのは、
  // 呼び出しの向きが枝によって逆になるから ── 以前は「バックアップ側が勝った」
  // 枝にしか union が無く、生きている側が勝つと（＝ディスクが飛んでから復元
  // されるまでの窓で、同じ名前を取り直して BAN 前より多く遊んだ場合）
  // ファイルに残っていた BAN が黙って解けていた。しかも同じ枝の合流は実績も
  // 所持品も引き継ぐので、「報酬の面では同一人物、処分の面だけ別人」という
  // 都合のよいマージになっていた。
  // 解除の向きには倒さない（union なので BAN が外れることはない）。
  // 一度余分に BAN がかかるほうが、処分が静かに消えるよりましだからで、
  // これはこのファイルの他の合流と同じ「迷ったら閉じる」判断。
  if (loser.banned) winner.banned = true;
  if (loser.muted) winner.muted = true;
  // 🤝 フレンドとブロックも合流させる。とくに blocked は本人が身を守るために
  // 付けたもので、進行度で負けたほうのコピーに入っていても落としてはいけない
  // （BAN/ミュートを union しているのと同じ理由）。
  // 📚 collections は「図鑑のセットコンプ報酬を受け取った印」で、二重受取を
  // 止めているのはこの配列だけ（catalog.js の claimCollection）。落とすと
  // 復元のたびに同じセットの報酬をもう一度受け取れる。
  for (const k of ['achievements', 'badges', 'owned', 'friends', 'blocked', 'collections', 'wsLiked']) {
    const a = Array.isArray(winner[k]) ? winner[k] : (winner[k] = []);
    for (const v of (Array.isArray(loser[k]) ? loser[k] : [])) if (!a.includes(v)) a.push(v);
  }
  if (loser.items && typeof loser.items === 'object') {
    winner.items = winner.items || {};
    for (const [id, n] of Object.entries(loser.items)) {
      winner.items[id] = Math.max(winner.items[id] || 0, Number(n) || 0);
    }
  }
  // 👑 管理者イベントの予約は「進行度」に出ないので、進行度で負けたコピーが
  // 持っていると消えてしまう。新しいほうの予約を残す。
  const wr = winner.adminEvent, lr = loser.adminEvent;
  if (lr && (!wr || (lr.reservedAt || 0) > (wr.reservedAt || 0))) winner.adminEvent = lr;

  // 受け取りの設定は「厳しいほう」を採る。安全に関わる設定は、
  // 迷ったら閉じる側に倒す。
  // 勝った側にこの欄が無いときは、負けた側のものをそのまま引き継ぐ。
  // 両方そろっているときだけ比べていたので、勝ったレコードが古くて
  // social を持っていないと、閉めてあった扉が黙って開いていた。
  const ls = loser.social;
  if (ls && !winner.social) {
    winner.social = { ...ls };
  } else if (ls && winner.social) {
    const ws2 = winner.social;
    const rank = { none: 2, friends: 1, all: 0 };
    // 値が壊れている／欠けている場合は「いちばん閉じている」とみなさない。
    // 既定（requests:'all' / invites:'friends'）に寄せてから比べる。
    const r = (v, def) => (rank[v] === undefined ? rank[def] : rank[v]);
    if (r(ls.requests, 'all') > r(ws2.requests, 'all')) ws2.requests = ls.requests;
    if (r(ls.invites, 'friends') > r(ws2.invites, 'friends')) ws2.invites = ls.invites;
  }
  // 申請と断りの記録は合流させない。あれは一時的なもので、
  // union すると一度断った申請が復活する。

  const wb = winner.battlePass, lb = loser.battlePass;
  if (wb && lb && wb.season === lb.season) {
    wb.xp = Math.max(wb.xp || 0, lb.xp || 0);
    wb.premium = !!(wb.premium || lb.premium);
    wb.claimed = [...new Set([...(wb.claimed || []), ...(lb.claimed || [])])];
  }

  // 🏆 週間ランキング報酬の受け取り状況も EARNED として引き継ぐ。復元時に
  // db.meta.lastRankRewardWeek を消して finalizeWeeklyRankings を再実行する
  // 仕組み（restore 側）は、各レコードの「支払い済み」印だけを頼りに二重払いを
  // 防いでいる。ところが勝ったレコードが（バックアップ側で）その印より古いと、
  // 印と未受取の報酬が両方消え、同じ週がもう一度支払われて別人が「今週の優勝」に
  // なり、受け取り前だった報酬は逆に消えていた。
  //   ・同じ週なら「一度でも支払っていれば支払い済み」に倒す（best は大きいほう）
  //   ・勝った側にその週の記録が無ければ、負けた側のものをそのまま引き継ぐ
  //   ・保留中の順位報酬は id で和集合（受け取り前の分を落とさない）
  const ww = winner.stats && winner.stats.weekly;
  const lw = loser.stats && loser.stats.weekly;
  if (lw && winner.stats) {
    if (!ww) winner.stats.weekly = { ...lw };
    else if (lw.week === ww.week) {
      ww.rewarded = !!(ww.rewarded || lw.rewarded);
      ww.best = Math.max(ww.best || 0, lw.best || 0);
    } else {
      //   ・違う週どうしのときは stats.weekly が1週ぶんしか持てないので、まだ
      //     支払っていない順位報酬（rewarded:false かつ best>0）を抱えたほうを残す。
      //     落とせば finalizeWeeklyRankings も値が無く払えず、順位報酬が永久に消える。
      //     両方が保留中なら「古い週」を優先する（そちらが今すぐ支払われる対象で、
      //     新しい＝今週ぶんは生きている本人が遊べば作り直される）。
      const pending = r => r && !r.rewarded && (r.best || 0) > 0;
      const wkNum = w => { const n = parseInt(String(w).replace(/^\D+/, ''), 10); return Number.isFinite(n) ? n : Infinity; };
      if (pending(lw) && (!pending(ww) || wkNum(lw.week) < wkNum(ww.week))) {
        winner.stats.weekly = { ...lw };
      }
    }
  }
  const wrr = Array.isArray(winner.rankRewards) ? winner.rankRewards : (winner.rankRewards = []);
  if (Array.isArray(loser.rankRewards)) {
    const seenRR = new Set(wrr.map(r => r && r.id));
    for (const r of loser.rankRewards) {
      if (r && r.id && !seenRR.has(r.id)) { wrr.push(r); seenRR.add(r.id); }
    }
  }

  // 🏰 ギルド金庫の受取記録（guilds.js の user.guildQuests）。
  // { week, gid, claimed:[questId], badge } を今週ぶんだけ持つ入れ物で、
  // 二重受取を止めているのは claimed の中身だけ。落とすと復元後に同じ週の
  // 金庫をもう一度開けられる（コインとジェムが二重に出る）。
  //   ・同じ週・同じギルドなら claimed は和集合、badge は OR
  //   ・勝った側に記録が無ければ、負けた側のものをそのまま引き継ぐ
  //   ・同じ週で別ギルドなら「印のあるほう」を残す。claimGuildQuest は
  //     「今週は別のギルドで開けた」を rec の中身で判定するので、空のほうを
  //     残すと gid が付け替わって二度目が通ってしまう（迷ったら閉じる側）。
  //   ・週が違うときは新しい週のほうを残す。古い週の記録は memberQuestRec が
  //     次の受け取りで作り直す＝止め金にならないので、残しても意味がない。
  const lgq = loser.guildQuests;
  if (lgq && typeof lgq === 'object' && !Array.isArray(lgq)) {
    const wgq = winner.guildQuests;
    // 週の比較は weekly と同じく数値部で（'W9999' → 'W10000' の桁またぎ）。
    // ただしここは「読めない週」を Infinity に倒すと壊れた値が正しい記録を
    // 押し出してしまうので、逆（いちばん古い）に倒す。
    const qWk = w => { const n = parseInt(String(w).replace(/^\D+/, ''), 10); return Number.isFinite(n) ? n : -Infinity; };
    const marked = r => !!(r && ((Array.isArray(r.claimed) && r.claimed.length) || r.badge));
    const copyRec = r => ({ ...r, claimed: [...new Set(Array.isArray(r.claimed) ? r.claimed : [])] });
    if (!wgq || typeof wgq !== 'object' || Array.isArray(wgq)) {
      winner.guildQuests = copyRec(lgq);
    } else if (wgq.week === lgq.week && wgq.gid === lgq.gid) {
      wgq.claimed = [...new Set([
        ...(Array.isArray(wgq.claimed) ? wgq.claimed : []),
        ...(Array.isArray(lgq.claimed) ? lgq.claimed : []),
      ])];
      wgq.badge = !!(wgq.badge || lgq.badge);
    } else if (wgq.week === lgq.week) {
      if (!marked(wgq) && marked(lgq)) winner.guildQuests = copyRec(lgq);
    } else if (qWk(lgq.week) > qWk(wgq.week)) {
      winner.guildQuests = copyRec(lgq);
    }
  }

  // 📦 ゲスト記録の引き継ぎ（index.js の /api/me/import-guest は1アカウント
  // 1回だけ）。止め金は stats.guestImportedAt だけなので、進行度で負けた
  // コピーがそれを握っていると、復元後にもう一度取り込める＝ブースターを
  // 何度でも増やせる。中身（stats.guestImport＝表示用のベスト）も一緒に運ぶ。
  // 印だけ残って中身が消えると、二度と取り込めないのに画面が空のままになる。
  const lst = loser.stats;
  if (lst && typeof lst === 'object' && (lst.guestImportedAt || lst.guestImport)) {
    const wst = winner.stats || (winner.stats = {});
    // 実際に取り込んだのは最初の1回。両方に印があるときは古いほうを正とする。
    if (lst.guestImportedAt && (!wst.guestImportedAt || lst.guestImportedAt < wst.guestImportedAt)) {
      wst.guestImportedAt = lst.guestImportedAt;
      if (lst.guestImport) wst.guestImport = lst.guestImport;
    } else if (!wst.guestImport && lst.guestImport) {
      wst.guestImport = lst.guestImport;
    }
  }

  // 🔓 隠し要素の解放（index.js の user.stats.unlocks = ['kami','souzou','ghost']）。
  //
  // これは「稼いだもの」なので、進行度で負けたコピーが持っていても落とさない
  // ── 和集合を採る。落とすと、再デプロイのたびに 神／創造神／幽霊屋敷 が
  // 閉じ直り、隠しコマンドをもう一度打たされる（しかもスマホの人は打てない）。
  //
  // ⚠ **オブジェクトではなく文字列の配列**であることに意味がある。
  //   sanitize.js の SECRET_KEYS が 'ghost' という**キー**を落とすので、
  //   { ghost:true } の形にすると幽霊屋敷の解放だけが送信時に消える。
  //   ここで形を変えてはいけない。
  //
  // 上限: 一覧に無い id は index.js の normalizeUnlocks が落とすが、復元は
  // 外から来たファイルを読むので、こちら側でも必ず頭を押さえる（ここを
  // 素通しにすると、細工したバックアップ1本で全ユーザーの stats を
  // 好きなだけ太らせられる ── db.json は保存のたびに丸ごと書き出される）。
  const UNLOCK_KEEP = 8;   // index.js の UNLOCK_IDS（3件）より少し広い保険
  const lun = loser.stats && loser.stats.unlocks;
  if (Array.isArray(lun) && lun.length) {
    const wst14 = winner.stats || (winner.stats = {});
    const a = Array.isArray(wst14.unlocks) ? wst14.unlocks : (wst14.unlocks = []);
    for (const id of lun) {
      if (typeof id !== 'string' || !id || id.length > 24) continue;
      if (a.includes(id) || a.length >= UNLOCK_KEEP) continue;
      a.push(id);
    }
  }
  // 「localStorage からの引き継ぎは1アカウント1回」の止め金。
  // 二重取り防止の印なので、片方でも使っていれば使用済みに倒す（迷ったら
  // 閉じる ── guestImportedAt とまったく同じ性格）。
  const lui = loser.stats && loser.stats.unlockImportedAt;
  if (lui) {
    const wst15 = winner.stats || (winner.stats = {});
    if (!wst15.unlockImportedAt || lui < wst15.unlockImportedAt) wst15.unlockImportedAt = lui;
  }

  // 📕 図鑑の「1日1セット受け取り枠」(catalog.js collectionQuota / claimCollection)。
  // user.collectionClaims = { day:'YYYY-MM-DD', n } で、その日に何セット受け取った
  // かを持つ。二重受取を止めているのは n だけなので、落とすと復元後にその日ぶんを
  // もう一度受け取れる（collections と同じ性格の止め金）。
  //   ・同じ日なら n の大きいほう（迷ったら閉じる）
  //   ・勝った側に無ければ負けた側のものを引き継ぐ
  //   ・日が違うときは新しい日のほう。古い日は collectionQuota が次の受け取りで
  //     作り直す＝止め金にならないので残しても意味がない。
  const okDay = d => /^\d{4}-\d{2}-\d{2}$/.test(String(d));
  const lcc = loser.collectionClaims;
  if (isPlainObj(lcc) && okDay(lcc.day)) {
    const wcc = winner.collectionClaims;
    const ln = Math.max(0, Math.floor(Number(lcc.n) || 0));
    if (!isPlainObj(wcc) || !okDay(wcc.day) || String(lcc.day) > String(wcc.day)) {
      winner.collectionClaims = { day: String(lcc.day), n: ln };
    } else if (String(wcc.day) === String(lcc.day)) {
      wcc.n = Math.max(Math.floor(Number(wcc.n) || 0), ln);
    }
  }

  // 🧩 パズル遺跡の「同じステージの勝利はJST1日1回まで」の印
  // (index.js applyGameResult の puzWinDay = { day, stages:[番号] })。
  // ステージは番号だけで決まる決定論的な盤面なので、手順を覚えれば何度でも
  // won:true を送れる。それを止めているのはこの配列だけなので、落とすと
  // 復元後に同じステージぶんの勝利報酬をもう一度受け取れる。
  //   ・同じ日なら和集合（迷ったら閉じる）
  //   ・勝った側に無ければ負けた側のものを引き継ぐ
  //   ・日が違うときは新しい日のほう（古い日は次の勝利で作り直される＝止め金にならない）
  const lpw = loser.stats && loser.stats.puzWinDay;
  if (isPlainObj(lpw) && okDay(lpw.day)) {
    const wst3 = winner.stats || (winner.stats = {});
    const lstg = (Array.isArray(lpw.stages) ? lpw.stages : []).filter(n => Number.isFinite(n));
    const wpw = wst3.puzWinDay;
    if (!isPlainObj(wpw) || !okDay(wpw.day) || String(lpw.day) > String(wpw.day)) {
      wst3.puzWinDay = { day: String(lpw.day), stages: [...new Set(lstg)].slice(-PUZ_WIN_DAY_KEEP) };
    } else if (String(wpw.day) === String(lpw.day)) {
      const cur = Array.isArray(wpw.stages) ? wpw.stages.filter(n => Number.isFinite(n)) : [];
      wpw.stages = [...new Set([...cur, ...lstg])].slice(-PUZ_WIN_DAY_KEEP);
    }
  }

  // 🪙 1日の稼ぎの上限カウンタ (index.js applyGameResult の
  // grindDay = { day, coins, bpXp, accXp } / 上限は GRIND_DAILY_CAP)と、
  // 💎ドロップの1日の受取総額 (eventGemDay = { day, got } / GEMDROP_DAILY_CAP)。
  // どちらも「1日にいくらまで湧くか」を止めている唯一の記録なので、落とすと
  // 復元した日だけ上限がまるごと1本ぶん増える（＝偽の結果の連投がその日だけ
  // 通り放題になる）。日付つきの止め金は他と同じ扱いにする:
  //   ・同じ日なら大きいほう（迷ったら閉じる）
  //   ・勝った側に無ければ負けた側のものを引き継ぐ
  //   ・日が違うときは新しい日のほう（古い日は次の結果で作り直される）
  for (const [key, fields] of [['grindDay', ['coins', 'bpXp', 'accXp']], ['eventGemDay', ['got']]]) {
    const ld = loser.stats && loser.stats[key];
    if (!isPlainObj(ld) || !okDay(ld.day)) continue;
    const wst4 = winner.stats || (winner.stats = {});
    const wd = wst4[key];
    const num = (o, f) => Math.max(0, Math.floor(Number(o && o[f]) || 0));
    if (!isPlainObj(wd) || !okDay(wd.day) || String(ld.day) > String(wd.day)) {
      const next = { day: String(ld.day) };
      for (const f of fields) next[f] = num(ld, f);
      wst4[key] = next;
    } else if (String(wd.day) === String(ld.day)) {
      for (const f of fields) wd[f] = Math.max(num(wd, f), num(ld, f));
    }
  }

  // 👑 王者（住人の頂点）を倒した回数 (battle.js の championWins)。
  // これは「稼いだもの」── 称号が「一度でも倒したか」で決まるので、進行度で
  // 負けたコピーが持っていると復元のたびに称号が消える。大きいほうを採る。
  const lcw = Number(loser.stats && loser.stats.championWins);
  if (Number.isFinite(lcw) && lcw > 0) {
    const wst6 = winner.stats || (winner.stats = {});
    wst6.championWins = Math.max(Number(wst6.championWins) || 0, Math.floor(lcw));
  }

  // 📈 段位の昇格を「どこまで全体告知したか」の印 (battle.js の rankAnnounced /
  // 値は帯の下限レート)。1700付近を往復するだけで同じ昇格が何度も全体配信される
  // のを止めているのはこれだけなので、落とすと復元のたびにまた鳴る。
  // 降ろす向きには倒さない ＝ 大きいほう（迷ったら閉じる）。
  const lra = Number(loser.stats && loser.stats.rankAnnounced);
  if (Number.isFinite(lra) && lra > 0) {
    const wst5 = winner.stats || (winner.stats = {});
    wst5.rankAnnounced = Math.max(Number(wst5.rankAnnounced) || 0, Math.floor(lra));
  }

  // 👑 「王者を倒した」の全体速報を今日もう流したかの印
  // (index.js announceChampionFall / user.stats.champAnnDay = 'YYYY-MM-DD' JST)。
  // 1人1日1回に絞っているのはこの印だけなので、落とすと**復元した日に
  // もう一度全体速報が鳴る**。上の rankAnnounced とまったく同じ性格なので
  // 同じ扱い ＝ 新しい日のほうを採る（古い日付は次の撃破で上書きされるだけで
  // 止め金にならない）。勝った側に無ければ負けた側のものを引き継ぐ。
  const lca = loser.stats && loser.stats.champAnnDay;
  if (okDay(lca)) {
    const wst7 = winner.stats || (winner.stats = {});
    if (!okDay(wst7.champAnnDay) || String(lca) > String(wst7.champAnnDay)) {
      wst7.champAnnDay = String(lca);
    }
  }

  // 🎁 ショップの1日1回の無料ギフト受領印 (routes/shop.js giftClaimedDay)。
  // user.stats.shopGiftDay = 'YYYY-MM-DD'。二重受取を止めているのはこの印だけ
  // なので、落とすと同じ日にもう一度ギフトを受け取れる。新しい日付（＝いま
  // 閉じている日）のほうを残す ── 古い日付は次の受け取りで上書きされるだけで
  // 止め金にならない。
  const lsg = loser.stats && loser.stats.shopGiftDay;
  if (okDay(lsg)) {
    const wst2 = winner.stats || (winner.stats = {});
    if (!okDay(wst2.shopGiftDay) || String(lsg) > String(wst2.shopGiftDay)) {
      wst2.shopGiftDay = String(lsg);
    }
  }

  // 🏗️ ブループリント（その日じゅう全員同じ固定盤面）の勝利ぶんの上積みを
  // 「その日の初回だけ」に絞っている印 (index.js applyGameResult の
  // bpDay = { day, cleared })。止めているのは +50🪙 / bpXp+100 / accXp+80 /
  // ギルド週間pt+25 / totalWins / ミッションの 'win'。落とすと復元した日に
  // もう一度受け取れる。性格は puzWinDay・shopGiftDay とまったく同じ:
  //   ・勝った側に無ければ負けた側のものを引き継ぐ
  //   ・同じ日なら cleared を OR（迷ったら閉じる）
  //   ・日が違うときは新しい日のほう
  const lbp = loser.stats && loser.stats.bpDay;
  if (isPlainObj(lbp) && okDay(lbp.day)) {
    const wst13 = winner.stats || (winner.stats = {});
    const wbp = wst13.bpDay;
    if (!isPlainObj(wbp) || !okDay(wbp.day) || String(lbp.day) > String(wbp.day)) {
      wst13.bpDay = { day: String(lbp.day), cleared: !!lbp.cleared };
    } else if (String(wbp.day) === String(lbp.day)) {
      wbp.cleared = !!wbp.cleared || !!lbp.cleared;
    }
  }

  // 🎲 ミッションの引き直し使用回数 (missions.js rerollCounts)。
  // user.missions.rerolls = { '<日付キー>':{daily,weekly}, '<週キー W35>':{daily,weekly} }
  // の2階建てで、無料＋有料の引き直し回数を数える唯一の rate-limit 記録。落とすと
  // 復元後に回数がリセットされ、余分に引き直せる。キーごと・スコープごとに多いほう
  // （迷ったら閉じる）。古いキーは syncMissions / rerollCounts が当日・今週ぶん以外を
  // 捨てるので溜まらない。勝った側に missions がまだ無いときは触らない ── day/week の
  // 文脈が無いと syncMissions が次回に丸ごと作り直すので、片端の rerolls を足しても
  // 意味がなく、壊れた missions を残す危険だけが増える（実害は次の期に0回に戻るだけ）。
  const lms = loser.missions;
  if (isPlainObj(lms) && isPlainObj(lms.rerolls) && isPlainObj(winner.missions)) {
    const wm = winner.missions;
    const wrr2 = isPlainObj(wm.rerolls) ? wm.rerolls : (wm.rerolls = {});
    for (const [key, lc] of Object.entries(lms.rerolls)) {
      if (unsafeKey(key) || !isPlainObj(lc)) continue;
      // 日付キー（YYYY-MM-DD）か週キー（W＋数字）だけ通す。細工した巨大キーを弾く。
      if (!/^\d{4}-\d{2}-\d{2}$/.test(key) && !/^W\d+$/.test(key)) continue;
      const wc = isPlainObj(wrr2[key]) ? wrr2[key] : (wrr2[key] = { daily: 0, weekly: 0 });
      for (const s of ['daily', 'weekly']) {
        wc[s] = Math.max(Math.floor(Number(wc[s]) || 0), Math.floor(Number(lc[s]) || 0), 0);
      }
    }
  }

  // 🕒 在席の記録（battle.js の hello / close）。
  //   stats.sessions … 通算セッション数
  //   stats.online   … 直近の在席区間 [{ at, ms }]（上限 ONLINE_SPANS_MAX）
  // どちらも「その人がいつ来ていたか」を運営が読むための材料で、進行度では
  // 決まらない。合流で落とすと、ディスクが飛んでから復元するまでの窓で1回
  // つないだだけの新しいレコードが勝った瞬間に、それ以前の在席の記録が
  // 丸ごと消える（＝復元したのに履歴が無い、がいちばん困る使い方）。
  //   ・sessions は大きいほう（回数は減らない性質のもの）
  //   ・online は開始時刻 at で和集合 → 時系列に並べ替えて新しいほうから上限件
  const lonSt = loser.stats;
  if (isPlainObj(lonSt)) {
    const ls2 = Number(lonSt.sessions);
    if (Number.isFinite(ls2) && ls2 > 0) {
      const wst8 = winner.stats || (winner.stats = {});
      wst8.sessions = Math.max(Math.floor(Number(wst8.sessions) || 0), Math.floor(ls2));
    }
    if (Array.isArray(lonSt.online) && lonSt.online.length) {
      const wst9 = winner.stats || (winner.stats = {});
      const cur = Array.isArray(wst9.online) ? wst9.online : [];
      // 開始時刻を鍵に重複を落とす。同じ区間が両側にあるときは長いほうを採る
      // （片方だけ close を取りこぼしていた、を拾える）。
      const by = new Map();
      for (const sp of [...cur, ...lonSt.online]) {
        if (!isPlainObj(sp)) continue;
        const at = Math.floor(Number(sp.at) || 0);
        const ms = Math.floor(Number(sp.ms) || 0);
        if (at <= 0 || ms <= 0) continue;             // 壊れた行は持ち込まない
        const prev = by.get(at);
        if (!prev || ms > prev.ms) by.set(at, { at, ms });
      }
      wst9.online = [...by.values()].sort((a, b) => a.at - b.at).slice(-ONLINE_SPANS_MAX);
    }
    // 🔑 ログインの記録（auth.js の recordLogin）。stats.sessions とまったく
    // 同じ理由で合流が要る ── ディスクが飛んでから復元するまでの窓で1回
    // ログインしただけの新しいレコードが勝つと、それ以前のログイン回数と
    // 最終ログイン時刻が丸ごと消える。どちらも「増えるだけ／新しいほど正しい」
    // 種類の値なので、大きいほうを採る。
    //   ・logins      … 通算回数（減らない）
    //   ・lastLoginAt … 最後にログインした時刻（進むだけ）
    const ll = Math.floor(Number(lonSt.logins) || 0);
    if (ll > 0) {
      const wst11 = winner.stats || (winner.stats = {});
      wst11.logins = Math.max(Math.floor(Number(wst11.logins) || 0), ll);
    }
    const lla = Math.floor(Number(lonSt.lastLoginAt) || 0);
    if (lla > 0) {
      const wst12 = winner.stats || (winner.stats = {});
      wst12.lastLoginAt = Math.max(Math.floor(Number(wst12.lastLoginAt) || 0), lla);
    }
  }

  // 🔌 再接続の猶予を使った回数（battle.js の RECONNECT_GRACE_PER_DAY）。
  // user.stats.dcGrace = { day:'YYYY-MM-DD', n, total }。
  // 「切断を戦術に使う人には猶予を出さない」を止めているのは n だけなので、
  // 落とすと復元した日だけ回数がまるごと1本ぶん戻る。他の日付つきの止め金
  // （grindDay / shopGiftDay …）とまったく同じ扱いにする:
  //   ・同じ日なら多いほう（迷ったら閉じる）
  //   ・勝った側に無ければ負けた側のものを引き継ぐ
  //   ・日が違うときは新しい日のほう（古い日は次の切断で作り直される）
  //   ・total は通算なので常に大きいほう
  const ldg = loser.stats && loser.stats.dcGrace;
  if (isPlainObj(ldg) && okDay(ldg.day)) {
    const wst10 = winner.stats || (winner.stats = {});
    const wdg = wst10.dcGrace;
    const n = Math.max(0, Math.floor(Number(ldg.n) || 0));
    const tot = Math.max(0, Math.floor(Number(ldg.total) || 0));
    if (!isPlainObj(wdg) || !okDay(wdg.day) || String(ldg.day) > String(wdg.day)) {
      wst10.dcGrace = {
        day: String(ldg.day), n,
        total: Math.max(tot, Math.max(0, Math.floor(Number(wdg && wdg.total) || 0))),
      };
    } else {
      if (String(wdg.day) === String(ldg.day)) wdg.n = Math.max(Math.floor(Number(wdg.n) || 0), n);
      wdg.total = Math.max(Math.floor(Number(wdg.total) || 0), tot);
    }
  }
}

// --- 🏰 ギルド名簿の整合 -----------------------------------------------------
//
// user.guildId と guild.members は同じ事実の二重持ちで、これまで直していたのは
// 片方向（users→guilds）だけだった。名簿に死んだ id が残っても誰も落とさない
// のに、読み手は生の length を見ている:
//   ・guilds.js の満員判定は `guild.members.length >= GUILD_MAX_MEMBERS`(=20)
//     ── 幽霊がそのまま1枠を占め、「20/20 なのに誰も居ない」ギルドができる
//   ・所有権の委譲は生存者が尽きると `|| guild.members[0]` に落ちる
//     ── 死んだ id がオーナーになると、そのギルドは誰にも触れなくなる
// これは index.js の DELETE /api/me のコメントが「一度やらかしている事故」と
// して記録している形そのもの。削除の経路は塞がれたが、復元／マージ経路と、
// すでに幽霊を抱えている本番の db は塞がれていなかった。
//
// db を書き換えて { ghosts, disbanded, owners, pointers } を返す。
// 起動時にも呼べる（同じ関数を通せば、既存の壊れた名簿も次の再起動で直る）。
export function healGuildRosters(db) {
  const out = { ghosts: 0, disbanded: 0, owners: 0, pointers: 0 };
  if (!db || !isPlainObj(db.guilds)) return out;
  const users = isPlainObj(db.users) ? db.users : {};
  for (const [gid, g] of Object.entries(db.guilds)) {
    if (!isPlainObj(g)) { delete db.guilds[gid]; out.disbanded++; continue; }
    const before = Array.isArray(g.members) ? g.members : [];
    // 幽霊（db.users に居ない id）と重複を落とす。
    const seen = new Set();
    const members = [];
    for (const id of before) {
      if (!id || seen.has(id) || !users[id]) continue;
      seen.add(id);
      members.push(id);
    }
    out.ghosts += before.length - members.length;
    g.members = members;
    if (!members.length) {
      // 名簿が空になったギルドは解散扱い（guilds.js の leaveGuild と同じ）。
      delete db.guilds[gid];
      out.disbanded++;
      continue;
    }
    // オーナーが幽霊なら、いちばん古株の生存者に引き継ぐ（leaveGuild と同型）。
    if (!g.ownerId || !users[g.ownerId] || !members.includes(g.ownerId)) {
      g.ownerId = members
        .map(id => users[id]).filter(Boolean)
        .sort((a, b) => (a.guildJoinedAt || 0) - (b.guildJoinedAt || 0))[0]?.id || members[0];
      out.owners++;
    }
    if (Array.isArray(g.applicants)) {
      g.applicants = [...new Set(g.applicants.filter(id => id && users[id]))];
    }
  }
  // ポインタ側（従来の処理）。名簿を掃除したあとにやる。
  const memberOf = {};
  for (const g of Object.values(db.guilds)) {
    for (const id of (Array.isArray(g.members) ? g.members : [])) memberOf[id] = g.id;
  }
  for (const u of Object.values(users)) {
    if (!u) continue;
    const want = memberOf[u.id] || null;
    if (u.guildId && !db.guilds[u.guildId]) { u.guildId = want; out.pointers++; }
    else if (!u.guildId && want) { u.guildId = want; out.pointers++; }
  }
  return out;
}

// --- snapshots ------------------------------------------------------------

export function snapshot(db, label = 'auto') {
  try {
    fs.mkdirSync(SNAP_DIR, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const file = path.join(SNAP_DIR, `${stamp}_${label}.json`);
    fs.writeFileSync(file, JSON.stringify(db));
    prune();
    return path.basename(file);
  } catch (err) {
    console.error('[backup] snapshot failed:', err.message);
    return null;
  }
}

// ファイル名は `${ISO時刻}_${label}.json`。ラベルは最後の '_' の後ろ
//（'pre-restore' のように '-' を含むものがあるので '-' では割らない）。
function labelOf(file) {
  const m = /_([^_]+)\.json$/.exec(file);
  return m ? m[1] : '';
}

function prune() {
  try {
    // 名前の頭は ISO 時刻なので、辞書順＝時系列順（古い順）。
    const files = fs.readdirSync(SNAP_DIR).filter(f => f.endsWith('.json')).sort();
    const drop = new Set();
    // ① 自動で増える種類は、種類ごとの枠を越えたぶんを古い順に落とす。
    for (const [label, keep] of Object.entries(LABEL_KEEP)) {
      const mine = files.filter(f => labelOf(f) === label);
      for (const f of mine.slice(0, Math.max(0, mine.length - keep))) drop.add(f);
    }
    // ② それでも全体の枠を越えるなら、古いものから落とす。①で自動ぶんは
    //    すでに頭を押さえてあるので、ここで消えるのは本当に古い退避だけ。
    const left = files.filter(f => !drop.has(f));
    let remaining = left.length;
    for (const f of left) {
      if (remaining <= KEEP_SNAPSHOTS) break;
      drop.add(f);
      remaining--;
    }
    for (const f of drop) {
      try { fs.unlinkSync(path.join(SNAP_DIR, f)); } catch { /* best effort */ }
    }
  } catch { /* best effort */ }
}

export function listSnapshots() {
  try {
    return fs.readdirSync(SNAP_DIR)
      .filter(f => f.endsWith('.json'))
      .sort()
      .reverse()
      .map(name => {
        const st = fs.statSync(path.join(SNAP_DIR, name));
        return { name, size: st.size, at: st.mtimeMs };
      });
  } catch {
    return [];
  }
}

export function readSnapshot(name) {
  // Defend against path traversal — only plain file names from listSnapshots.
  if (!/^[\w.-]+\.json$/.test(name)) return null;
  try {
    return JSON.parse(fs.readFileSync(path.join(SNAP_DIR, name), 'utf8'));
  } catch {
    return null;
  }
}

// --- restore --------------------------------------------------------------

// Mutates `db` in place (db.js holds the same object reference).
// mode: 'merge' (default) | 'replace'
// opts.protectLiveCredentials: アップロード者がファイルの中身を握っている
// 経路（未ログインでの復元）で真にする。生きているアカウントのパスワード・
// 権限をファイル側に上書きさせない。
export function applyRestore(db, data, mode = 'merge', opts = {}) {
  const protectLiveCredentials = !!opts.protectLiveCredentials;
  const before = Object.keys(db.users || {}).length;
  const report = { mode, added: 0, updated: 0, kept: 0, tokens: 0, before, after: 0 };

  if (mode === 'replace') {
    db.users = data.users;
    db.tokens = data.tokens && typeof data.tokens === 'object' ? data.tokens : {};
    if (data.season) db.season = data.season;
    if (Array.isArray(data.transactions)) db.transactions = data.transactions;
    if (data.guilds && typeof data.guilds === 'object') db.guilds = sanitizeGuilds(data.guilds);
    if (Array.isArray(data.news)) db.news = data.news;
    if (Array.isArray(data.bugreports)) db.bugreports = data.bugreports;
    if (data.revoked && typeof data.revoked === 'object') db.revoked = data.revoked;
    if (data.deleted && typeof data.deleted === 'object') db.deleted = data.deleted;
    if (data.meta && typeof data.meta === 'object') {
      // seedHash は「同梱 seed をもう適用したか」の記録で、この機体の履歴に
      // 属するもの。バックアップ側の値で上書きしてはいけない。
      // /api/admin/backup は db 全体を書き出すので seedHash も入っており、
      // 古いバックアップを replace で流し込むと記録が当時に巻き戻る。
      // すると次の起動で同梱 seed が「未適用」と判定されて再適用され、
      // 復元したばかりのデータの上に古い seed が被さる。
      const keepSeedHash = db.meta ? db.meta.seedHash : undefined;
      // 🛠 メンテナンスも同じ理由でこの機体のもの。README の更新手順が
      // 「🛠メンテナンス → 💾バックアップDL」の順なので、ファイル側はほぼ必ず
      // true を持っている。それを被せると、復元は成功しているのに
      // プレイヤーだけが締め出されたまま復帰する（merge 側も同じ扱い）。
      const keepMaintenance = db.meta ? db.meta.maintenance : undefined;
      db.meta = { ...db.meta, ...data.meta };
      if (keepSeedHash === undefined) delete db.meta.seedHash;
      else db.meta.seedHash = keepSeedHash;
      if (keepMaintenance === undefined) delete db.meta.maintenance;
      else db.meta.maintenance = keepMaintenance;
    }
    report.added = Object.keys(db.users).length;
    report.tokens = Object.keys(db.tokens).length;
    report.after = report.added;
    return report;
  }

  // ---- merge ----
  db.users = db.users || {};
  const byName = new Map();
  for (const u of Object.values(db.users)) byName.set(u.username.toLowerCase(), u);

  const idRemap = new Map();   // 旧id -> 新id（下の付け替えで使う）
  for (const inc of Object.values(data.users)) {
    // Tombstone: an account the operator deleted stays deleted — a stale
    // backup/seed must not resurrect it (db.deleted survives merges below).
    if (db.deleted && db.deleted[inc.id]) continue;
    const live = db.users[inc.id] || byName.get(inc.username.toLowerCase());
    if (!live) {
      db.users[inc.id] = inc;
      byName.set(inc.username.toLowerCase(), inc);
      report.added++;
      continue;
    }
    if (progressOf(inc) >= progressOf(live)) {
      // The backup is at least as far along (ties go to the backup — that is
      // the account everyone actually had, e.g. the real admin vs the one
      // re-seeded after a wipe). It wins AND keeps its own id: every session
      // signed before the wipe references that id, so logins come straight
      // back. Only the few sessions issued in the wipe→restore window lose.
      mergeEarned(inc, live);
      // Moderation and credentials are OPERATOR state, not player progress —
      // they must not roll back just because the backup copy had more score.
      // A newer sessionsSince marks newer credentials (password changes bump
      // it). BAN／ミュートの union は上の mergeEarned に移した（勝敗の
      // どちらの枝からも必ず通る場所なので、片方向だけ、が起きない）。
      // sessionsSince はファイル側が自由に決められる値なので、これだけを
      // 根拠にすると「巨大な sessionsSince を書いた偽レコード」に負ける。
      // アップロード者がファイルの中身を握っている経路（未ログインでの復元）
      // では、生きている資格情報を無条件で優先する。
      if (protectLiveCredentials || (live.sessionsSince || 0) > (inc.sessionsSince || 0)) {
        inc.passHash = live.passHash;
        inc.salt = live.salt;
        inc.sessionsSince = live.sessionsSince;
      }
      // 権限も同じ。生きているアカウントの role をファイル側に書き換えさせない。
      if (protectLiveCredentials) inc.role = live.role;
      // 名前で照合して勝ったレコードは **id ごと** 入れ替わる。
      // 他の人の friends / blocked / 申請には古い id が残ったままなので、
      // ここで対応表に控えて、あとでまとめて付け替える。
      // これをやらないと、復元のたびに黙って縁が切れ、しかも
      // ブロックが「存在しない id をブロックしている」＝無効になる。
      if (live.id !== inc.id) idRemap.set(live.id, inc.id);
      delete db.users[live.id];
      db.users[inc.id] = inc;
      byName.set(inc.username.toLowerCase(), inc);
      for (const [tk, rec] of Object.entries(db.tokens || {})) {
        if (rec && rec.userId === live.id) delete db.tokens[tk];
      }
      report.updated++;
    } else {
      mergeEarned(live, inc);
      // 生きている側が勝った場合も、ファイル側の id は捨てられる。
      // ファイルの中の他の人は相手をその古い id で覚えているので、
      // 逆向きの対応も控えておかないと、取り込んだ縁が宙に浮いて
      // healSocial に「片側だけ」と判断され、両側から消される。
      if (live.id !== inc.id) idRemap.set(inc.id, live.id);
      report.kept++;
    }
  }

  // 🤝 付け替えの実行。全員の friends / blocked / 申請を新しい id に読み替える。
  if (idRemap.size) {
    const fix = arr => {
      if (!Array.isArray(arr)) return arr;
      const out = [];
      for (const v of arr) {
        const id = idRemap.get(v) || v;
        if (!out.includes(id)) out.push(id);
      }
      return out;
    };
    // 付け替えの結果、自分自身が相手として残ることがある
    // （旧idの自分と新idの自分が両方入っていた場合）。落とす。
    const notSelf = (u, arr) => (Array.isArray(arr) ? arr.filter(id => id !== u.id) : arr);
    for (const u of Object.values(db.users)) {
      if (!u) continue;
      u.friends = notSelf(u, fix(u.friends));
      u.blocked = notSelf(u, fix(u.blocked));
      u.friendReqOut = notSelf(u, fix(u.friendReqOut));
      if (Array.isArray(u.friendReqIn)) {
        const seen = new Set();
        u.friendReqIn = u.friendReqIn.filter(r => {
          if (!r) return false;
          r.from = idRemap.get(r.from) || r.from;
          if (seen.has(r.from)) return false;
          seen.add(r.from);
          return true;
        });
      }
      if (u.friendDeclines && typeof u.friendDeclines === 'object') {
        for (const [old, at] of Object.entries(u.friendDeclines)) {
          const nid = idRemap.get(old);
          if (nid) { u.friendDeclines[nid] = at; delete u.friendDeclines[old]; }
        }
      }
    }
    report.remapped = idRemap.size;
  }

  // Tokens: union, dropping any that no longer point at a real user.
  db.tokens = db.tokens || {};
  if (data.tokens && typeof data.tokens === 'object') {
    for (const [tk, rec] of Object.entries(data.tokens)) {
      if (rec && db.users[rec.userId] && !db.tokens[tk]) db.tokens[tk] = rec;
    }
  }
  for (const [tk, rec] of Object.entries(db.tokens)) {
    if (!rec || !db.users[rec.userId]) delete db.tokens[tk];
  }
  report.tokens = Object.keys(db.tokens).length;

  // Session bookkeeping: logged-out tokens stay logged out, deleted accounts
  // stay deleted, even across a wipe. Guilds come back by id (live wins a
  // clash); news is unioned by id.
  for (const key of ['revoked', 'deleted', 'guilds']) {
    if (data[key] && typeof data[key] === 'object' && !Array.isArray(data[key])) {
      const incoming = key === 'guilds' ? sanitizeGuilds(data[key]) : data[key];
      db[key] = { ...incoming, ...(db[key] || {}) };
    }
  }
  if (Array.isArray(data.news)) {
    db.news = db.news || [];
    const seen = new Set(db.news.map(n => n && n.id));
    // Identical title+body means the same announcement even under a different
    // random id (seedNews used to mint fresh UUIDs every boot — without this,
    // the four launch posts multiplied on every wipe→restore cycle).
    const seenBody = new Set(db.news.map(n => n && `${n.title}${n.body}`));
    for (const n of data.news) {
      if (!n || !n.id || seen.has(n.id)) continue;
      const key = `${n.title}${n.body}`;
      if (seenBody.has(key)) continue;
      db.news.push(n);
      seen.add(n.id);
      seenBody.add(key);
    }
    // 上限まで切る。書き込み口(index.js)は1件足すごとに shift しているが、
    // 合流だけは切っていなかった ── live とファイルで中身が違うぶんだけ
    // 配列が上限を越え、db.json は保存のたびに丸ごと書き出すので、
    // 「再デプロイのたびに保存が重くなる」方向にしか動かない。
    // 新しいほうを残す（お知らせは末尾が新しい）。
    if (db.news.length > NEWS_CAP) db.news = db.news.slice(-NEWS_CAP);
  }

  // db.meta: a fresh post-deploy instance holds only trivial meta — adopt the
  // backup's world state (event, poll+votes, crowd scale/config, season
  // override, throne progress) for every key the live side hasn't set
  // since boot. メンテナンススイッチだけは持ち込まない（下記）。
  if (data.meta && typeof data.meta === 'object') {
    db.meta = db.meta || {};
    // ここは以前「持ち込んでよいキーの一覧」だった。「新しい db.meta のキーを
    // 足したらこの一覧にも足すこと」と但し書きを付けていたが、実際には守られず
    // throneMax（世界がこれまでに割った最高段）が漏れていた。これが落ちると
    // 👑王座ショップは棚が max >= dan でしか開かないので、ディスクが飛ぶ
    // 再デプロイ ── まさにこの復元機構が存在する理由 ── のたびに7品すべてが
    // 買えなくなる。欠片は各ユーザーのレコードに残るので消えはしないが、
    // 管理者が /api/admin/throne で段を手で戻すまで使い道が無い。
    // newsUnpinned も同じ理由で漏れており、unpinOldReleaseNotes の「一度きり」
    // が毎回リセットされて、📌し直したお知らせが起動のたびに剥がされていた。
    //
    // そこで一覧を「落とすキー」に反転させる。書き足し忘れたときの既定が
    // 「持ち越す」側になるので、同じ事故がもう一度起きない。
    //   seedHash              … この機体が同梱 seed を適用済みかの記録。ファイル側の
    //                           値で巻き戻すと次の起動で古い seed が再適用される
    //   lastRankRewardWeek    … 復元後に消すのが目的（すぐ下でそうしている）
    //   backupAt/backupVersion … バックアップファイル自身の情報で、世界の状態ではない
    //   backupTrimmed         … 同上（4MB の復元上限に収めるために書き出し側が
    //                           何を落としたかの記録。db に持ち込む意味は無い）
    //   maintenance           … 「今この機体を止めているか」の運用スイッチで、世界の
    //                           状態ではない。README が案内する更新手順が
    //                           「🛠メンテナンス → 💾バックアップDL」の順なので、
    //                           正規の手順で取ったファイルはほぼ必ず true を含む。
    //                           持ち込むと、復元は成功して管理画面も正常に見えるのに
    //                           プレイヤーだけがメンテナンス表示で入れなくなる
    //                           （復元の応答にもログにも出ないので気づけない）。
    //                           止めたいなら復元後に管理画面から入れ直す。
    //
    // 🏛 hallOfFame（歴代シーズンの永久記録）と seasonMark（シーズン切替の検知印）は
    // **わざとここに入れない**。hallOfFame が落ちれば、この機構が存在する理由その
    // ものである再デプロイのたびに歴代の記録が消える。seasonMark が落ちると
    // settleSeasonHallOfFame が「印が無い＝初回」と見なして、直前に終わった
    // シーズンを表彰しないまま印だけ進めるので、1シーズンぶんが無言で飛ぶ。
    // 古い seasonMark が入って「シーズンが巻き戻った」ように見えても二重に
    // 殿堂入りはしない ── index.js 側に
    // `hallOfFame.some(e => e.season === prev.id)` の重複チェックがあり、
    // 記録済みのシーズンなら印を進めるだけで戻る（報酬もそこで止まる）。
    //   resultRuns            … 🧾 結果送信の冪等キー（runId → 前回の応答）の控え。
    //                           24時間で消える再送よけの帳面で、世界の状態ではない。
    //                           持ち込むほうが**危ない**: 復元はデータが飛んだ後に
    //                           走るので、ユーザーのレコードはバックアップ時点まで
    //                           巻き戻る。そこへ「その runId は処理済み」という印だけ
    //                           持ち込むと、巻き戻った回を再送しても前回の応答が
    //                           返るだけで、報酬が**永久に入らない**。
    //                           帳面は普通に遊べば数秒で作り直される。
    const META_NOT_RESTORED = new Set(['seedHash', 'lastRankRewardWeek', 'backupAt', 'backupVersion', 'backupTrimmed', 'maintenance', 'resultRuns']);
    // 🧩 workshop と 🎞 dailyReplays は「片方だけを採る」では守れない。
    // 既定の規則は『live 側がまだ値を持っていないキーだけ採用する』なので、
    // 復元までの窓で誰か1人がステージを投稿しただけで、バックアップ側の
    // 全ステージ（＝プレイヤーの作品）が丸ごと落ちる。中身を突き合わせる。
    // 🗒 residentRecords（住人の戦績の差分）も同じ理由で突き合わせる ──
    // 復元までの窓でレート戦が1回終わるだけで、live 側にこの欄ができて
    // バックアップ側の住人の戦績が丸ごと落ちる（＝つけたはずの1敗が
    // 復元のたびに無かったことになる）。
    const META_MERGED = new Map([
      ['workshop', mergeWorkshop],
      ['dailyReplays', mergeDailyReplays],
      ['residentRecords', mergeResidentRecords],
    ]);
    for (const k of Object.keys(data.meta)) {
      if (META_NOT_RESTORED.has(k)) continue;
      // ファイルの中身は外から来る。JSON.parse は "__proto__" を素の own プロパティ
      // として作るが、代入するとプロトタイプの setter が動いてしまうので通さない。
      if (k === '__proto__' || k === 'constructor' || k === 'prototype') continue;
      const merge = META_MERGED.get(k);
      if (merge && isPlainObj(data.meta[k])) {
        const merged = merge(db.meta[k], data.meta[k]);
        if (merged !== undefined) db.meta[k] = merged;
        continue;
      }
      if (db.meta[k] == null && data.meta[k] != null) db.meta[k] = data.meta[k];
    }
    // Weekly payouts: an empty post-deploy boot may have stamped the current
    // week with nobody in it. Clearing the stamp lets finalizeWeeklyRankings
    // re-run for the restored users (per-record `rewarded` flags keep it safe).
    delete db.meta.lastRankRewardWeek;
  }
  // 🧩🎞 db.meta の中にもユーザー id を持つ記録がある（工房の作者・いいね済み・
  // 還元記録、リプレイの uid）。ここでやるのは、上の合流で両側の記録が
  // db.meta に揃った直後だから。ギルド名簿の付け替えと同じ理由・同じ形。
  remapMetaIds(db.meta, idRemap);
  // 🤝 ギルドの名簿にも同じ付け替えを効かせる。ここでやるのは、
  // ギルドが db.guilds に入るのがこの直前だから。
  // やらないと、id が入れ替わった人が名簿の中で存在しない id になり
  // （名簿は埋まっているのに誰も居ない）、その人が所有者だった場合は
  // ギルドが誰にも触れなくなる ── 一度やらかしている事故と同じ形。
  if (idRemap.size && db.guilds) {
    for (const g of Object.values(db.guilds)) {
      if (!g) continue;
      if (Array.isArray(g.members)) {
        const out = [];
        for (const id of g.members) {
          const n = idRemap.get(id) || id;
          if (!out.includes(n)) out.push(n);
        }
        g.members = out;
      }
      if (g.ownerId && idRemap.has(g.ownerId)) g.ownerId = idRemap.get(g.ownerId);
      if (Array.isArray(g.applicants)) {
        g.applicants = [...new Set(g.applicants.map(id => idRemap.get(id) || id))];
      }
    }
  }

  // 🏰 ギルド名簿とメンバーのポインタを突き合わせる。以前はポインタ側
  //（users→guilds）しか直しておらず、名簿に残った幽霊 id は誰も落とさなかった。
  const guildFix = healGuildRosters(db);
  if (guildFix.ghosts || guildFix.disbanded || guildFix.owners) report.guilds = guildFix;

  // Purchase history is append-only: union by transaction id.
  if (Array.isArray(data.transactions)) {
    db.transactions = db.transactions || [];
    const seen = new Set(db.transactions.map(t => t && t.id).filter(Boolean));
    for (const t of data.transactions) {
      if (t && t.id && !seen.has(t.id)) { db.transactions.push(t); seen.add(t.id); }
    }
    // 上限まで切る（理由は上の news と同じ）。取引は routes/shop.js が
    // TX_KEEP 件を残して書庫へローテーションする ── ここでは古いぶんを
    // 落とすだけにする（書庫への追い出しは復元の仕事ではない）。
    if (db.transactions.length > TX_CAP) db.transactions = db.transactions.slice(-TX_CAP);
  }

  // Bug reports: union by id so player reports survive a wipe too.
  if (Array.isArray(data.bugreports)) {
    db.bugreports = db.bugreports || [];
    const seen = new Set(db.bugreports.map(b => b && b.id).filter(Boolean));
    for (const b of data.bugreports) {
      if (b && b.id && !seen.has(b.id)) { db.bugreports.push(b); seen.add(b.id); }
    }
    // 上限まで切る（理由は上の news と同じ）。
    if (db.bugreports.length > BUGREPORT_CAP_MIRROR) db.bugreports = db.bugreports.slice(-BUGREPORT_CAP_MIRROR);
  }

  report.after = Object.keys(db.users).length;
  return report;
}

export { SNAP_DIR };
