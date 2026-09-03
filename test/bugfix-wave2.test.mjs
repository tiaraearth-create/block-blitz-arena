// リポジトリのルートから:  node test/bugfix-wave2.test.mjs
//
// 🐛 バグ探し 第2波（断罪・オンライン・深淵・サバイバル・翻訳・ギルド）の回帰。
//
// 純ロジックとソース検査だけなので安い組で回してよい。サーバーを立てないと
// 確かめられないもの（ギルドの合言葉・称号）は bugfix-wave1 側にある。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
// 改行は必ず \n に正規化してから見る。このリポジトリのソースは CRLF なので、
// '\n' を含む検索文字列がそのままでは一致しない（切り出しが空振りして、
// 直っているのにテストだけ落ちる）。
const read = p => fs.readFileSync(path.join(ROOT, p), 'utf8').replace(/\r\n/g, '\n');

const results = [];
const check = (name, ok, detail = '') => {
  results.push([ok ? '✅' : '❌', name, detail]);
  if (!ok) process.exitCode = 1;
};

// ===========================================================================
// A. 盤面が「置いた以外の理由」で死んだことに気づけるか
//
// engine.over は addGarbage() でも立つ（engine.js）。ところが onGameOver を
// 鳴らすのは applyResult＝1手置いたときだけだったので、お邪魔で埋まって詰むと
// 「置けない → applyResult が走らない → 誰も気づかない」で走行が固まった。
// いちばん重かったのが 👁️断罪 ── サーバー側の席が生きたままなので、動けない
// 本人に断罪が飛び続け、斬れないので毎回「落とした」になり、段のHPが回復し、
// 住人がその人の名前で処刑されていった。
// ===========================================================================
{
  const game = read('public/js/game.js');
  const engine = read('public/js/engine.js');

  check('A-0(前提) addGarbage が over を立てる',
    /addGarbage\(n\)[\s\S]{0,900}?if \(!this\.hasAnyMove\(\)\) this\.over = true;/.test(engine), '');
  check('A-1 毎コマの見張りがある', /_checkOver\(\)\s*\{/.test(game), '');
  check('A-2 update() が見張りを回している',
    /update\(dt\) \{[\s\S]{0,200}?this\._checkOver\(\);/.test(game), '');
  check('A-3 死の処理が1本にまとまっている（handleOver）', /handleOver\(\) \{/.test(game), '');
  check('A-4 置いた直後も同じ入口を通る（二度鳴らさない）',
    /if \(result\.over\) this\._checkOver\(\);/.test(game), '');

  // 発火の回数を、盤面クラス無しで論理だけ再現して確かめる。
  const mk = () => ({
    engine: { over: false }, fired: 0, _wasOver: false,
    handleOver() { this.fired++; },
    _checkOver() {
      const o = !!(this.engine && this.engine.over);
      if (o && !this._wasOver) { this._wasOver = true; this.handleOver(); }
      else if (!o) this._wasOver = false;
    },
  });
  const v = mk();
  v._checkOver(); v._checkOver();
  check('A-5 生きている間は鳴らない', v.fired === 0, `${v.fired}回`);
  v.engine.over = true; v._checkOver(); v._checkOver(); v._checkOver();
  check('A-6 死んだら1回だけ鳴る（毎コマ鳴らさない）', v.fired === 1, `${v.fired}回`);
  v.engine.over = false; v._checkOver();
  check('A-7 生き返ると印が戻る', v._wasOver === false, '');
  v.engine.over = true; v._checkOver();
  check('A-8 二度目の死も鳴る', v.fired === 2, `${v.fired}回`);
}

// ===========================================================================
// B. 👁️断罪 — 置き去りにしない／持ち越さない
// ===========================================================================
{
  const zs = read('server/zero-session.js');
  const topOut = zs.slice(zs.indexOf('export function topOut'));
  const body = topOut.slice(0, topOut.indexOf('\n}\n'));
  // 席を倒すのが、クールダウンの判定より前にあること。
  const iDown = body.indexOf('e.alive = false');
  const iCool = body.indexOf('run.topoutAt[userId]');
  check('B-1 席は必ず倒す（クールダウンより前）', iDown >= 0 && iCool >= 0 && iDown < iCool,
    `倒す@${iDown} / 上限@${iCool}`);
  check('B-2 断るのは「ゼロの回復」だけ', /let heal = true;/.test(body) && /if \(heal\) \{/.test(body), '');
  check('B-3 復帰の予約（downUntil）は必ず立つ', /e\.downUntil = t \+ REVIVE_SEC \* 1000;/.test(body), '');

  const addH = zs.slice(zs.indexOf('export function addHuman'));
  const addBody = addH.slice(0, addH.indexOf('\n  // 抜けたきり'));
  check('B-4 走行をまたいだ再着席を見分けている', /const rejoining = !!seat\.left;/.test(addBody), '');
  check('B-5 前の走行のダウンを持ち越さない',
    /if \(rejoining\) \{[\s\S]{0,600}?seat\.downUntil = 0;/.test(addBody), '');

  check('B-6 処刑の上限を枠（slot）で数える',
    /run\.fallen\.filter\(f => f && \(f\.slot \|\| 0\) === slotKey\)/.test(zs), '');
  check('B-7 処刑の記録に枠を刻む', /slot: slotKey/.test(zs), '');

  const ae = read('server/adminevent.js');
  check('B-8 枠が変わったら slotStartsAt を引き直す',
    /if \(run\.slotStartsAt !== startsAt\) \{/.test(ae), '');
  check('B-9 枠が変わったら取引の状態も解く',
    /run\.dealDoneFor = undefined;[\s\S]{0,60}run\.deal = null;/.test(ae), '');
}

// ===========================================================================
// C. オンライン — 文面と見た目が裁定と食い違わない
// ===========================================================================
{
  const modes = read('public/js/modes.js');
  const quit = modes.slice(modes.indexOf('  quit() {\n    if (this.inMatch'));
  const quitBody = quit.slice(0, quit.indexOf('\n  }\n'));
  check('C-1 何だったのかを destroy() より前に控える',
    /const wasSpectating = this\.spectatingRoom;/.test(quitBody), '');
  check('C-2 トーストは控えた値で分岐する',
    /toast\(wasSpectating/.test(quitBody) && /wasRoyaleDead/.test(quitBody), '');
  check('C-3 destroy() は控えたあと', quitBody.indexOf('const wasSpectating') < quitBody.indexOf('this.destroy()'), '');

  check('C-4 合言葉ルームの「ルームへ」は部屋に残る',
    /if \(this\.kind === 'custom'\) \{[\s\S]{0,200}?showScreen\('room'\);/.test(modes), '');
  check('C-5 相手パネルの盤面の控えも毎試合作り直す',
    /this\.lastGrids = \{\};/.test(modes), '');
  check('C-6 陣取りのスコアは動いたときだけ跳ねる',
    /if \(sc !== this\._lastLandScore\)/.test(modes), '');
  check('C-7 ロイヤルは復活待ちの間に二度送らない',
    /if \(this\.royaleTopoutPending\) return;/.test(modes)
    && /this\.royaleTopoutPending = false;/.test(modes), '');
}

// ===========================================================================
// D. 深淵・サバイバル・タイムアタック
// ===========================================================================
{
  const modes = read('public/js/modes.js');
  check('D-1 盲目の呪いはバーも隠す', /\$\('#bossHp'\)\.style\.width = blind \? '100%'/.test(modes), '');
  check('D-2 盲目の呪いはダメージ数値も隠す',
    /this\.curse === 'blind' \? '-\?\?\?'/.test(modes), '');
  check('D-3 再開ボーナスがレルムの刻み幅を使う',
    /const step = this\.realm\.bossEvery \|\| 10;[\s\S]{0,120}?startFloor - 1\) \/ step/.test(modes), '');
  check('D-4 再開の文面は「再開かどうか」で決まる',
    /toast\(this\.startFloor > 1/.test(modes), '');
  check('D-5 サバイバルはウェーブで NEW RECORD を決める',
    /const isBest = this\.wave > this\.bestWave\(\);/.test(modes), '');
  check('D-6 スコアの自己ベストも画面に出す（見えない記録にしない）',
    /const scoreBest = e\.score > this\.best\(\);/.test(modes) && /scoreBest && e\.score > 0/.test(modes), '');
  check('D-7 HUDの赤点滅をメニューへ持ち越さない',
    /hudTimer\.classList\.remove\('urgent'\)/.test(modes), '');
  check('D-8 タイムアタックは 3-2-1 を分母に入れない',
    /this\.playStartedAt = Date\.now\(\);/.test(modes)
    && /this\.playStartedAt \|\| this\.startedAt/.test(modes), '');
}

// ===========================================================================
// E. 翻訳 — 意味を反転させない／中身の無い訳を配らない
// ===========================================================================
{
  const tr = await import('../server/translate.js');
  const cases = [
    ['lets go now', 'ja', s => !/いや/.test(s), '末尾の w を食って no→「いや」に反転しない'],
    ['i know', 'ja', s => !/いや/.test(s), '同上（know）'],
    ['how', 'ja', s => s === 'どう', 'how が正しく訳される'],
  ];
  for (const [src, to, ok, label] of cases) {
    const r = tr.translateLocal(src, to);
    const text = r ? r.text : '';
    check(`E-1 ${label}`, ok(text), `${JSON.stringify(src)} -> ${JSON.stringify(text)}`);
  }
  // 日本語の「草」はこれまでどおり末尾に残す。
  const w = tr.translateLocal('すごいwww', 'en');
  check('E-2 日本語の w（草）はこれまでどおり', !!w && /lol/.test(w.text), w ? w.text : '(訳さない)');

  // 原文を小文字にしただけのものは「翻訳」ではない。
  for (const s of ['Hades', 'Kaito']) {
    check(`E-3 ${s} に中身の無い訳を配らない`, tr.translateLocal(s, 'ja') === null,
      JSON.stringify((tr.translateLocal(s, 'ja') || {}).text));
  }
  // 効きすぎていないこと ── 表にある語はちゃんと訳す。
  const nice = tr.translateLocal('NICE', 'ja');
  check('E-4 表にある語は大文字でも訳す', !!nice && nice.text === 'ナイス', nice ? nice.text : '(訳さない)');
}

// ===========================================================================
// F. ギルド週間クエスト — pt クエストの達成が検出される
// ===========================================================================
{
  const g = read('server/guilds.js');
  check('F-1 達成前の値を復元するために minus を受ける',
    /function questProgress\(guild, weekId, q, def, minus = 0\)/.test(g), '');
  check('F-2 pt クエストは直前に足したぶんを引く',
    /Math\.max\(0, total - \(minus \|\| 0\)\)/.test(g), '');
  check('F-3 trackGuildQuests が event.points を読む',
    /const justAdded = Math\.max\(0, Number\(event\.points\) \|\| 0\);/.test(g), '');
  const idx = read('server/index.js');
  check('F-4 呼び出し側が直前に足したptを渡す', /points: guildPts,/.test(idx), '');
}

// ===========================================================================
// G. チャット履歴の並び
// ===========================================================================
{
  const b = read('server/battle.js');
  check('G-1 起動時のシードを時刻順に並べ直す',
    /chatHistory\.sort\(\(a, b\) => \(a\.at \|\| 0\) - \(b\.at \|\| 0\)\);/.test(b), '');
  check('G-2 並べ直したあと上限に収める',
    /if \(chatHistory\.length > 60\) chatHistory\.splice\(0, chatHistory\.length - 60\);/.test(b), '');
}

const pass = results.filter(r => r[0] === '✅').length;
console.log(`\n🐛 バグ修正 第2波  [${pass}/${results.length}]`);
for (const [mark, name, detail] of results) {
  console.log(`   ${mark} ${name}${detail ? ` — ${detail}` : ''}`);
}
if (pass !== results.length) console.log(`\n❌ ${results.length - pass} 件が失敗しました`);
