// リポジトリのルートから:  node test/criticals.test.mjs
//
// 🚨 本番に出ていた重大4件（v2.63.2 のホットフィックス）。
//    うち2件は、直前の波（v2.60 / v2.62）で**自分が開けた穴**。
//
//   A. 🏗 ブループリントの「1日1回」が、申告日を today↔yday と交互に名乗るだけで
//      無限に戻っていた。blueprintClears は順位表の部門なので、板がそのまま偽装できた。
//   B. 🎁 初回に配る「持ち時間」を1件目で使い切らずに持ち越せた。1秒の捨て結果を
//      1件投げると、2件目はもう「生涯の初回」ではないので低い天井が外れ、
//      残り 1,890秒 ぶん（× レート上限 2,000/秒 = 3,780,000点）を丸ごと名乗れた。
//   C. 🕵 住人の対訳だけ tr.engine が 'native' だった。chat.js は
//      `engine !== 'table'` で「翻訳」/「簡易翻訳」を出し分けるので、
//      **チャット1行ごとに100%当たる住人の判別器**になっていた。
//   D. 🕵 ゴーストギルドのクエスト目標だけ人数で縮んでいなかった（実ギルドは v2.63 から
//      必ず縮む）。「20人未満なのに目標が満額のギルド＝住人のギルド」で総当たりできた。
//   E. 🔌 ロイヤルの再接続猶予に**回数の関門が無く**、猶予中のお邪魔は捨てられ、
//      さらに「離脱」の速報が実プレイヤーにしか出ない出来事だった。
//
// A と B は挙動で見る（サーバーを立てて実際に叩く）。C・D は関数を直接呼ぶ。
// E は経路が長いので実装の形で見る。
import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';
import { freePort } from './_port.mjs';
import { jstDayKey } from '../server/adminevent.js';
import { TRANSLATE_ENGINE } from '../server/translate.js';
import { buildRoster } from '../server/residents.js';
import { buildCtx, composeLine, composeDialogue, composeFeed, composeReaction } from '../server/crowd.js';
import {
  ghostGuildViews, guildQuestView, questGoalOf, createGuild,
  QUEST_POOL, GUILD_MAX_MEMBERS,
} from '../server/guilds.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const PORT = await freePort();
const BASE = `http://localhost:${PORT}`;
const DIR = path.join(os.tmpdir(), `bba-criticals-test-${PORT}`);
const sleep = ms => new Promise(r => setTimeout(r, ms));

const results = [];
const check = (name, ok, detail = '') => {
  results.push([ok ? '✅' : '❌', name, detail]);
  if (process.env.TEST_VERBOSE) console.log(ok ? '✅' : '❌', name, detail ? `— ${detail}` : '');
  if (!ok) process.exitCode = 1;
};

const j = async (p, opt = {}, token) => {
  const r = await fetch(BASE + p, {
    ...opt,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: opt.body ? JSON.stringify(opt.body) : undefined,
  });
  let d = {}; try { d = await r.json(); } catch { /* 本文なしもある */ }
  return { status: r.status, ...d };
};

const read = f => fs.readFileSync(path.join(ROOT, f), 'utf8').replace(/\r\n/g, '\n');
// 自分で書いた説明文が根拠にならないように、コメントは落としてから見る。
const stripComments = src => src.replace(/\r\n/g, '\n').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

let proc = null;
async function start() {
  proc = spawn(process.execPath, ['server/index.js'], {
    cwd: ROOT,
    env: {
      ...process.env, PORT: String(PORT), DATA_DIR: DIR, POP_SCALE: '0',
      SESSION_SECRET: 'criticals-test', SEED_RESTORE: '0',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  for (let i = 0; i < 80; i++) {
    await sleep(250);
    if (proc.exitCode !== null || proc.signalCode !== null) throw new Error(`サーバーが起動直後に終了しました (code=${proc.exitCode})`);
    try { const r = await fetch(BASE + '/api/status'); if (r.ok) return; } catch { /* まだ */ }
  }
  throw new Error('サーバーが起動しませんでした');
}
async function stop() {
  if (!proc) return;
  const p = proc; proc = null;
  await new Promise(res => { p.on('exit', res); p.kill(); });
  await sleep(400);
}

try {
  fs.rmSync(DIR, { recursive: true, force: true });
  await start();

  // =========================================================================
  // A. 🏗 ブループリントの「1日1回」が申告日で戻らない
  // =========================================================================
  //
  // 直し方は「日付を戻さない（単調）」の一条件だけ。昨日ぶんの遅れた提出は
  // 通したままにしたいので、「昨日を禁止する」ではなく「今日を記録したあとに
  // 昨日へ戻れない」にしてある。
  {
    const today = jstDayKey();
    const yday = jstDayKey(Date.now() - 86400000);
    const reg = await j('/api/register', { method: 'POST', body: { username: '設計図検証', password: 'pw-criticals-1' } });
    check('A-0 前提: 登録できた', !!reg.token, JSON.stringify(reg).slice(0, 90));
    const tok = reg.token;
    const play = { mode: 'blueprint', score: 4000, lines: 12, duration: 90, pieces: 40, won: true };

    const r1 = await j('/api/game/result', { method: 'POST', body: { ...play, day: today } }, tok);
    check('A-1 今日の初回は勝利ぶんが付く', r1.status === 200 && !(r1.rewards && r1.rewards.capped),
      `capped=${r1.rewards && r1.rewards.capped}`);

    const r2 = await j('/api/game/result', { method: 'POST', body: { ...play, day: today } }, tok);
    check('A-2 同じ日の2回目は「今日ぶんは受け取り済み」',
      !!(r2.rewards && r2.rewards.capped === 'blueprint_day'), `capped=${r2.rewards && r2.rewards.capped}`);

    // ⚠ ここが穴だった。today を記録したあとに yday を名乗ると bpDay が変わり、
    //   止め金 { day, cleared } が丸ごと作り直されて cleared が false に戻る。
    const r3 = await j('/api/game/result', { method: 'POST', body: { ...play, day: yday } }, tok);
    check('A-3 今日のあとに「昨日」を名乗っても枠は戻らない',
      !!(r3.rewards && r3.rewards.capped === 'blueprint_day'), `capped=${r3.rewards && r3.rewards.capped}`);

    // today ↔ yday の往復を何度繰り返しても増えないこと（穴の使い方そのもの）。
    for (let i = 0; i < 4; i++) {
      await j('/api/game/result', { method: 'POST', body: { ...play, day: i % 2 ? yday : today } }, tok);
    }
    const me = await j('/api/me', {}, tok);
    const clears = (me.user && me.user.stats && me.user.stats.blueprintClears)
      || (me.stats && me.stats.blueprintClears) || 0;
    check('A-4 交互申告を7回投げても達成数は1のまま', clears === 1, `blueprintClears=${clears}`);
  }

  // =========================================================================
  // B. 🎁 初回に配った「持ち時間」を次のリクエストへ持ち越せない
  // =========================================================================
  //
  // 穴を再現するにはアカウントに**年齢**が要る（贈り物は min(年齢, 30分)）。
  // 登録直後は 0 なので、いったんサーバーを止めて createdAt を 40分前に
  // 書き換えてから起動し直す。
  {
    const reg = await j('/api/register', { method: 'POST', body: { username: '初回天井検証', password: 'pw-criticals-2' } });
    check('B-0 前提: 登録できた', !!reg.token, JSON.stringify(reg).slice(0, 90));
    const tok = reg.token;
    const uid = reg.user && reg.user.id;

    // 保存は 250ms の debounce。**この人が** db.json に現れるまで待つ
    // （ファイルの有無だけを見ると、A節の書き出しですでにあるので素通りする）。
    const dbPath = path.join(DIR, 'db.json');
    const hasUser = () => {
      try { return !!JSON.parse(fs.readFileSync(dbPath, 'utf8')).users[uid]; } catch { return false; }
    };
    for (let i = 0; i < 40 && !hasUser(); i++) await sleep(150);
    await stop();
    check('B-1 前提: db.json にこの人が書き出されている', hasUser(), dbPath);
    const db = JSON.parse(fs.readFileSync(dbPath, 'utf8'));
    const rec = db.users[uid];
    check('B-2 前提: 保存済みのレコードを引けた', !!rec, String(uid));
    if (rec) {
      rec.createdAt = Date.now() - 40 * 60 * 1000;      // 40分前に作られたことにする
      if (rec.stats) { delete rec.stats.lastResultAt; delete rec.stats.graceUntil; }
      fs.writeFileSync(dbPath, JSON.stringify(db));
    }
    await start();

    // 1件目 ── 1秒の捨て結果。ここで贈り物を1秒しか使わせない、が攻撃の狙い。
    const r1 = await j('/api/game/result', { method: 'POST', body: { mode: 'solo', score: 10, lines: 1, duration: 1, pieces: 3 } }, tok);
    check('B-3 前提: 1件目が通った', r1.status === 200, JSON.stringify(r1).slice(0, 90));

    // 2件目 ── 「生涯の初回」ではないので、直す前は天井が外れていた。
    const HUGE = 2_000_000;
    const r2 = await j('/api/game/result', { method: 'POST', body: { mode: 'solo', score: HUGE, lines: 900, duration: 1800, pieces: 3000 } }, tok);
    check('B-4 前提: 2件目も通った（拒否ではなく頭押さえで守る）', r2.status === 200, JSON.stringify(r2).slice(0, 90));

    const me = await j('/api/me', {}, tok);
    const best = (me.user && me.user.stats && me.user.stats.bestScore)
      || (me.stats && me.stats.bestScore) || 0;
    // FIRST_RESULT_SCORE_CAP は 300,000。実装から読む（写経しない）。
    const capSrc = read('server/index.js').match(/const FIRST_RESULT_SCORE_CAP = ([\d_]+)/);
    const CAP = capSrc ? Number(capSrc[1].replace(/_/g, '')) : 300000;
    check('B-5 前提: 初回上限の値を実装から読めた', CAP > 0, String(CAP));
    check('B-6 捨て結果で温存した持ち時間を2件目に積めない', best <= CAP, `bestScore=${best} / 上限=${CAP}`);
    check('B-7 2件目が丸ごと素通ししていない', best < HUGE, `bestScore=${best}`);
  }

  await stop();

  // =========================================================================
  // C. 🕵 tr.engine が住人の判別器になっていない
  // =========================================================================
  //
  // 実プレイヤーの自動翻訳は translate.js の TRANSLATE_ENGINE（既定 'table'）を
  // 名乗る。住人の対訳だけ 'native' だったので、chat.js のラベルが
  // 「翻訳」と「簡易翻訳」に割れ、1行ごとに素性が確定していた。
  {
    const srcServer = ['server/crowd.js', 'server/battle.js', 'server/ambient.js', 'server/zero.js']
      .filter(f => fs.existsSync(path.join(ROOT, f)))
      .map(f => `\n/* ${f} */\n` + stripComments(read(f))).join('');
    check('C-1 サーバーのどこにも engine: \'native\' が残っていない',
      !/engine:\s*'native'/.test(srcServer),
      (srcServer.match(/.{0,60}engine:\s*'native'.{0,20}/) || [''])[0]);

    // chat.js のラベルは engine で割れる ── だからこそ値がそろっていないといけない。
    const chat = read('public/js/chat.js');
    check('C-2 前提: chat.js は engine でラベルを出し分けている',
      /engine !== 'table'/.test(chat) && /簡易翻訳/.test(chat), '');

    const roster = buildRoster('v1', 240);
    const ctx = buildCtx({ now: Date.UTC(2026, 7, 26, 10, 30), active: roster.slice(0, 48), humans: ['テスト太郎'] });
    const engines = new Set();
    let trCount = 0;
    const note = tr => { if (tr && tr.engine !== undefined) { engines.add(tr.engine); trCount++; } };
    for (let i = 0; i < 400; i++) note(composeLine(roster[i % roster.length], ctx).tr);
    for (let i = 0; i < 200; i++) {
      const d = composeDialogue(ctx);
      if (Array.isArray(d)) for (const line of d) note(line && line.tr);
    }
    for (let i = 0; i < 200; i++) {
      const f = composeFeed(ctx);
      if (f) note(f.tr);
    }
    for (const kind of ['level', 'throne', 'badge', 'win']) {
      for (let i = 0; i < 40; i++) {
        const rr = composeReaction(kind, ctx, { name: 'テスト太郎', badge: 'guildquest' }, 1);
        if (Array.isArray(rr)) for (const line of rr) note(line && line.tr);
        else note(rr && rr.tr);
      }
    }
    check('C-3 前提: 住人の対訳を十分な数だけ集められた', trCount >= 30, `${trCount}本`);
    check('C-4 住人の対訳の engine が実プレイヤーとまったく同じ値',
      engines.size === 1 && engines.has(TRANSLATE_ENGINE),
      `住人=[${[...engines].join(',')}] / 実プレイヤー=${TRANSLATE_ENGINE}`);
  }

  // =========================================================================
  // D. 🕵 ゴーストギルドのクエストが実ギルドとまったく同じ形
  // =========================================================================
  {
    const weekId = 'W2954';
    const defById = new Map(QUEST_POOL.map(d => [d.id, d]));
    const views = ghostGuildViews(weekId, Date.UTC(2026, 7, 26, 10, 0), { detailed: true });
    check('D-0 前提: 住人のギルドを詳細で引けた', views.length >= 3 && !!views[0].quests, `${views.length}件`);

    const badGoal = [];
    let scaled = 0, small = 0;
    for (const v of views) {
      const n = v.memberCount;
      if (n < GUILD_MAX_MEMBERS) small++;
      for (const q of (v.quests.quests || [])) {
        const def = defById.get(q.id);
        if (!def) { badGoal.push(`${v.tag}:${q.id}:定義なし`); continue; }
        const want = questGoalOf(def, n);
        if (q.goal !== want) badGoal.push(`${v.tag}:${q.id} goal=${q.goal} 期待=${want}(人数${n})`);
        if (q.goal < def.goal) scaled++;
        if (q.progress > q.goal) badGoal.push(`${v.tag}:${q.id} progress>${q.goal}`);
      }
    }
    check('D-1 前提: 20人未満の住人ギルドが居る', small > 0, `${small}件`);
    check('D-2 住人のギルドの目標が人数ぶんに縮んでいる（実ギルドと同じ式）',
      badGoal.length === 0, badGoal.slice(0, 3).join(' / '));
    check('D-3 前提: 実際に縮んだ行がある（式が素通しでない）', scaled > 0, `${scaled}行`);

    // 欄の並びも実ギルドとそろえる。片方にしか無い欄は、それだけで目印になる。
    const db = { users: {}, guilds: {}, meta: {} };
    const owner = { id: 'u-critical', username: 'ギルド検証', coins: 999999, gems: 0, stats: {}, badges: [] };
    db.users[owner.id] = owner;
    const made = createGuild(db, owner, { name: 'テストギルド', tag: 'TST', icon: '🏰', desc: 'テスト' });
    const guild = (made && made.guild) || (owner.guildId ? db.guilds[owner.guildId] : null);
    check('D-4 前提: 実ギルドを1つ作れた', !!guild, JSON.stringify(made).slice(0, 90));
    if (guild) {
      const realView = guildQuestView(guild, weekId, owner);
      const missing = Object.keys(realView).filter(k => !(k in views[0].quests));
      const extra = Object.keys(views[0].quests).filter(k => !(k in realView));
      check('D-5 住人のギルドに欠けている欄が無い', missing.length === 0, missing.join(', '));
      check('D-6 住人のギルドにだけ有る欄が無い', extra.length === 0, extra.join(', '));
      const rq = realView.quests[0] || {};
      const gq = (views[0].quests.quests || [])[0] || {};
      const qMissing = Object.keys(rq).filter(k => !(k in gq));
      check('D-7 クエスト1行ぶんの欄もそろっている', qMissing.length === 0, qMissing.join(', '));
    }
  }

  // =========================================================================
  // E. 🔌 ロイヤルの再接続猶予（回数・お邪魔・速報）
  // =========================================================================
  {
    const battle = stripComments(read('server/battle.js'));

    // E-1 猶予に回数の関門があるか。close ハンドラの royale ブロックを切り出して見る。
    // `if (ws.royaleId) {` は5か所ある（観戦・足抜け・切断…）。
    // 見たいのは猶予を立てる切断ハンドラなので、dcUntil を代入している塊を選ぶ。
    let block = '';
    for (let at = battle.indexOf('if (ws.royaleId) {'); at >= 0; at = battle.indexOf('if (ws.royaleId) {', at + 1)) {
      const cand = battle.slice(at, at + 1800);
      if (/dcUntil\s*=/.test(cand)) { block = cand; break; }
    }
    check('E-0 前提: 切断ハンドラのロイヤル部分を切り出せた', block.includes('dcUntil'), `${block.length}文字`);
    check('E-1 ロイヤルの猶予も回数の関門（takeGraceQuota）をくぐる',
      /takeGraceQuota\(/.test(block), '');
    check('E-2 残り時間が無い試合には猶予を出さない',
      /RECONNECT_GRACE_MIN_MS/.test(block), '');

    // E-3 猶予中のお邪魔を捨てていないか。
    const hitAt = battle.indexOf('function royaleHit(');
    const hit = hitAt >= 0 ? battle.slice(hitAt, hitAt + 900) : '';
    check('E-3 前提: royaleHit を切り出せた', hit.includes('royale_garbage'), `${hit.length}文字`);
    check('E-4 猶予中に飛んできたお邪魔を預かっている',
      /dcUntil/.test(hit) && /pending/.test(hit), '');

    const resAt = battle.indexOf('function resumeRoyale(');
    const res = resAt >= 0 ? battle.slice(resAt, resAt + 1200) : '';
    check('E-5 復帰したときに預かったお邪魔を降らせている',
      /pending/.test(res) && /royale_garbage/.test(res), '');

    // E-6 「離脱」は実プレイヤーにしか起きない出来事なので速報に出さない。
    check('E-6 ロイヤルの速報に kind:\'left\' を送っていない',
      !/kind:\s*'left'/.test(battle),
      (battle.match(/.{0,60}kind:\s*'left'.{0,40}/) || [''])[0]);
  }

  // =========================================================================
  // F. 画面側の重い10件のうち、残り6件（どれも「触れないまま損をする」形）
  // =========================================================================
  {
    const clip = stripComments(read('public/js/clipexport.js'));
    const css = read('public/css/style.css');
    const dom = stripComments(read('public/js/dom.js'));
    const screens = stripComments(read('public/js/screens.js'));
    const mainJs = stripComments(read('public/js/main.js'));
    const modes = stripComments(read('public/js/modes.js'));

    // --- F-1 録画の完成が、ゲームオーバーの結果モーダルを消していた -------
    //   `!m.ended` を見ると「結果を読んでいる最中」がいちばん安全と判定され、
    //   そこへクリップのモーダルを出しに行く。showModal は先頭で closeModal を
    //   呼ぶので、結果モーダルは #rAgain / #rMenu ごと消えていた。
    const glAt = clip.indexOf('function gameIsLive()');
    const gl = glAt >= 0 ? clip.slice(glAt, clip.indexOf('function deliver(', glAt)) : '';
    check('F-1 前提: gameIsLive を切り出せた', gl.length > 20, `${gl.length}文字`);
    check('F-2 クリップの完成判定が m.ended を見ていない', !/\.ended/.test(gl), gl.replace(/\s+/g, ' ').slice(0, 90));
    check('F-3 ゲーム画面にいる間は帯で待たせる', /dataset\.screen === 'game'/.test(gl), '');

    // --- F-4 長い名前でトップバーの ⚙ が画面外へ出る ----------------------
    check('F-4 #userName が縮む（省略記号つき）',
      /#userName \{[\s\S]{0,200}?text-overflow: ellipsis;/.test(css)
      && /#userName \{[\s\S]{0,200}?white-space: nowrap;/.test(css), '');
    check('F-5 #userChip の自動最小幅を切ってある', /#userChip \{ min-width: 0; \}/.test(css), '');

    // --- F-6 端末の戻るで履歴が1つ余計に巻き戻る --------------------------
    //   leaveViaScreenButton() は showScreen('menu') まで同期で走り、
    //   その中で history.go(-screenStack.length) を呼ぶ。降ろす前に呼ぶと
    //   popstate が消費した1つと二重になる。
    const popAt = dom.indexOf("window.addEventListener('popstate'");
    const pop = popAt >= 0 ? dom.slice(popAt, popAt + 2600) : '';
    check('F-6 前提: popstate ハンドラを切り出せた', pop.includes('leaveViaScreenButton'), `${pop.length}文字`);
    check('F-7 画面を動かす前に screenStack を1枚降ろしている',
      pop.indexOf("const to = screenStack.pop()") > 0
      && pop.indexOf("const to = screenStack.pop()") < pop.indexOf('if (leaveViaScreenButton()) return;'), '');
    check('F-8 降ろす場所が1か所だけ（二重に降ろさない）',
      (pop.match(/screenStack\.pop\(\)/g) || []).length === 1, '');

    // --- F-9 ミッション／実績の一覧が古いまま出続ける ---------------------
    const dotAt = screens.indexOf('export async function refreshMissionDot()');
    const dot = dotAt >= 0 ? screens.slice(dotAt, dotAt + 1400) : '';
    check('F-9 前提: refreshMissionDot を切り出せた', dot.includes('/api/missions'), `${dot.length}文字`);
    check('F-10 赤いドットの取得結果で一覧の控えも入れ替える',
      /missionsCache = ms;/.test(dot) && /achCache = ach;/.test(dot), '');

    // --- F-11 ⚙の子ダイアログへ移ると盤面が覆われたまま再開する -----------
    check('F-11 モーダルが残っている間は走行を再開しない',
      /if \(root && root\.firstChild\) \{ onModalClosed\(later\); return; \}/.test(mainJs), '');

    // --- F-12 ダイアログ中も AI（と残像）だけが打ち続ける ------------------
    //   自走する setTimeout の鎖は PAUSABLE_DEADLINES では止まらない。
    check('F-12 止めるときにモード側の口を呼ぶ',
      /if \(typeof m\.pauseTimers === 'function'\)/.test(modes), '');
    check('F-13 再開するときも呼ぶ', /if \(typeof m\.resumeTimers === 'function'\)/.test(modes), '');
    check('F-14 AI対戦が手番の鎖を畳める',
      /pauseTimers\(\) \{ clearTimeout\(this\.aiTimer\); this\.aiTimer = null; \}/.test(modes), '');
    check('F-15 AI対戦が閉じたら打ち直す',
      /resumeTimers\(\) \{ if \(!this\.ended && !this\.aiTimer\) this\.aiLoop\(\); \}/.test(modes), '');
    check('F-16 残像の予約が1か所にまとまっている（残り時間ごと畳める）',
      /ghostSchedule\(ms\) \{/.test(modes)
      && (modes.match(/this\.ghostTimer = setTimeout\(/g) || []).length === 1
      && modes.indexOf('ghostSchedule(ms) {') < modes.indexOf('this.ghostTimer = setTimeout('), '');
  }
} finally {
  await stop();
  fs.rmSync(DIR, { recursive: true, force: true });
}

const failed = results.filter(r => r[0] === '❌');
for (const [mark, name, detail] of results) console.log(`${mark} ${name}${detail ? ' — ' + detail : ''}`);
console.log(`\n${results.length - failed.length}/${results.length} 件`);
if (failed.length) console.log(`❌ ${failed.length}件`);
