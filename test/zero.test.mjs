// Run from the repo root:  node test/zero.test.mjs
//
// 👁️ 断罪（管理者ゼロ）の計算部分を固定する。
// server/zero.js は db もソケットも時計も触らない純粋な計算と台詞だけなので、
// サーバーを立てずに検証できる。
//
// ここで守りたいのは「この設計の核が壊れていないこと」:
//   * 段のHPは7割までしか点数で削れない（残り3割は人間しか割れない）
//   * 人が増えても段の到達が逆転しない
//   * 台詞が必ず日英そろっている（片方だけだと英語面がまた壊れる）
//   * 断罪の判定が、予告時間を過ぎた申告を受け付けない
import fs from 'fs';
import {
  DAN, ZERO_BOARDS, SEAL_RATIO, SEATS_MIN, SEATS_MAX, MIN_BOT_SEATS,
  danAt, danHpFor, sealHpFor, softCapFor, cutDamageFor, cutsNeededFor,
  seatsFor, lanesFor, moodFor, MOODS, zeroSay, ZERO_LINES,
  pickVerdictCells, verdictAccepts, SIZE,
} from '../server/zero.js';

const results = [];
const check = (name, ok, detail = '') => { results.push([ok ? '✅' : '❌', name, detail]); if (!ok) process.exitCode = 1; };

// ---- 段 --------------------------------------------------------------------
check('段は7つ（王座の数と一致）', DAN.length === 7 && ZERO_BOARDS.length === 7,
  `段${DAN.length} / 王座${ZERO_BOARDS.length}`);
check('段は進むほど重くなる', DAN.every((d, i) => i === 0 || d.hp > DAN[i - 1].hp), '');
check('段が進むほど断罪が速くなる', DAN[6].everyMs < DAN[0].everyMs, `${DAN[0].everyMs}→${DAN[6].everyMs}ms`);
check('段が進むほど1斬りが重くなる', DAN.every((d, i) => i === 0 || d.cut > DAN[i - 1].cut), '');
check('段の範囲外を渡しても落ちない', danAt(-5).n === 1 && danAt(99).n === 7, '');

// ---- 封印（この設計の核） ---------------------------------------------------
{
  const hp = danHpFor(0, 1);
  const soft = softCapFor(0, 1);
  const seal = sealHpFor(0, 1);
  check('封印は3割', Math.abs(seal / hp - SEAL_RATIO) < 0.001, `${(seal / hp * 100).toFixed(1)}%`);
  check('点で削れるのは7割', soft + seal === hp, `${soft}+${seal}=${hp}`);
  // 「点数をいくら積んでも段は落ちない」= この設計の全部
  check('点だけでは段を落とせない', soft < hp, `${soft} < ${hp}`);
}

// ---- 斬る回数 --------------------------------------------------------------
{
  const need = DAN.map((_, i) => cutsNeededFor(i));
  check('1段あたり15〜24回斬る必要がある', need.every(n => n >= 15 && n <= 24), need.join(','));
  check('段が進むほど必要な斬り数は減る（刃が鋭くなる）',
    need.every((n, i) => i === 0 || n <= need[i - 1]), need.join(','));
  // 実際に必要回数ぶん斬れば封印がちょうど割れる
  for (let i = 0; i < DAN.length; i++) {
    const total = cutDamageFor(i, 1) * cutsNeededFor(i);
    if (total < sealHpFor(i, 1)) { check(`段${i + 1}: 必要回数で封印が割れる`, false, `${total} < ${sealHpFor(i, 1)}`); break; }
    if (i === DAN.length - 1) check('必要回数ぶん斬れば全段の封印が割れる', true, '');
  }
  check('急所（金マス）は貫通が倍', cutDamageFor(0, 1, { keystone: true }) === cutDamageFor(0, 1) * 2, '');
}

// ---- 人数スケール（逆転しないこと） -----------------------------------------
{
  check('席は最低12', seatsFor(1) === SEATS_MIN && seatsFor(0) === SEATS_MIN, `${seatsFor(1)}`);
  check('席は最大24', seatsFor(100) === SEATS_MAX, `${seatsFor(100)}`);
  check('住人の席が必ず残る', seatsFor(50) - Math.min(50, seatsFor(50) - MIN_BOT_SEATS) >= MIN_BOT_SEATS, '');
  check('人が増えるとHPが重くなる', danHpFor(0, 10) > danHpFor(0, 1), `${danHpFor(0, 1)}→${danHpFor(0, 10)}`);
  check('人が増えると断罪の本数も増える', lanesFor(30) > lanesFor(1), `${lanesFor(1)}→${lanesFor(30)}`);
  // ここが噛み合っていないと「人が増えるほど進まない」逆転が起きる。
  // 1人あたりの負担（HP ÷ 斬る本数）が、人数とともに増え続けないこと。
  const load = n => danHpFor(0, n) / lanesFor(n);
  check('1本あたりの負担が人数とともに膨らみ続けない',
    load(50) <= load(1) * 2.2, `1人=${Math.round(load(1))} / 50人=${Math.round(load(50))}`);
  check('断罪の本数に上限がある', lanesFor(1000) <= 10, `${lanesFor(1000)}`);
}

// ---- 態度 ------------------------------------------------------------------
check('段が進むと言葉づかいが崩れる',
  moodFor(0) === 'polite' && moodFor(3) === 'annoyed' && moodFor(6) === 'raw',
  `${moodFor(0)}/${moodFor(3)}/${moodFor(6)}`);
check('すべての段で態度が決まる', DAN.every((_, i) => MOODS.includes(moodFor(i))), '');

// ---- 台詞 ------------------------------------------------------------------
{
  const kinds = Object.keys(ZERO_LINES);
  check('台詞の種類がそろっている', kinds.length >= 8, kinds.join(','));
  let n = 0, bad = [];
  for (const kind of kinds) {
    for (const mood of MOODS) {
      const s = zeroSay(kind, mood, { you: 'テスト太郎', name: 'ゆきんこ', dan: 3, n: 2, seed: 7 });
      if (!s) { bad.push(`${kind}/${mood}: 出ない`); continue; }
      n++;
      if (!s.ja || !s.en) bad.push(`${kind}/${mood}: 片方が空`);
      if (/\{(you|name|dan|n)\}/.test(s.ja + s.en)) bad.push(`${kind}/${mood}: 差し込みが残った`);
      // 差し込みを外した本文が空になる行（例: 断罪の宣告は名前だけ）は
      // 日英が一致していて正しい。本文がある行だけ、訳し忘れを疑う。
      const bare = t => t.replace(/\{(you|name|dan|n)\}/g, '').replace(/[\s。、.,!！?？ー─「」“”"]/g, '');
      const tpl = ZERO_LINES[kind][mood].find(x => x);
      if (tpl && bare(tpl.ja) && bare(tpl.en) && tpl.ja === tpl.en) bad.push(`${kind}/${mood}: 訳し忘れ`);
    }
  }
  check('台詞は必ず日英そろっている（差し込み残りなし）', bad.length === 0, bad.slice(0, 3).join(' / ') || `${n}通り`);
  check('知らない種類を渡しても落ちない', zeroSay('nope', 'polite', {}) === null, '');
  // 同じ状況なら同じ台詞（リプレイが再現できる）
  const a = zeroSay('verdict', 'raw', { you: 'A', seed: 1 });
  const b = zeroSay('verdict', 'raw', { you: 'A', seed: 1 });
  check('同じ状況なら同じ台詞が出る', a.ja === b.ja, '');
  const c = zeroSay('verdict', 'raw', { you: 'A', seed: 2 });
  check('状況が違えば変わりうる', typeof c.ja === 'string', '');
  // 名指しは必ず名前が入る
  const v = zeroSay('verdict', 'polite', { you: 'ミサキ', seed: 3 });
  check('断罪の宣告に名前が入る', v.ja.includes('ミサキ') && v.en.includes('ミサキ'), v.ja);
}

// ---- 断罪の的 --------------------------------------------------------------
{
  const empty = new Array(SIZE * SIZE).fill(0);
  let rnd = (() => { let s = 42; return () => (s = (s * 1103515245 + 12345) % 2147483648) / 2147483648; })();
  const { cells, keystone } = pickVerdictCells(empty, 6, 3, rnd);
  check('赤マスが出る', cells.length === DAN[6].cells, `${cells.length}個`);
  check('赤マスは重複しない', new Set(cells).size === cells.length, '');
  check('急所は赤マスの中から選ばれる', cells.includes(keystone), `${keystone}`);
  const inTarget = cells.filter(i => i % SIZE === 3).length;
  check('「今夜の的」の列に6割が寄る', inTarget >= Math.floor(cells.length * 0.5),
    `${inTarget}/${cells.length} が第3列`);

  // 盤面が埋まっていたら赤マスは出ない（落ちない）
  const full = new Array(SIZE * SIZE).fill(1);
  const r2 = pickVerdictCells(full, 0, 0, rnd);
  check('盤面が満杯でも落ちない', r2.cells.length === 0 && r2.keystone === -1, '');
}

// ---- カットの受付 ----------------------------------------------------------
{
  const verdict = { at: 1000, warnMs: 3500, cells: [10, 11, 12], keystone: 11, resolved: false };
  check('予告時間内に赤マスを消せば通る', verdictAccepts(verdict, 2000, [10, 20]).ok, '');
  check('急所を含めば keystone が立つ', verdictAccepts(verdict, 2000, [11]).keystone === true, '');
  check('急所を含まなければ立たない', verdictAccepts(verdict, 2000, [10]).keystone === false, '');
  check('赤マスを外したら通らない', !verdictAccepts(verdict, 2000, [30, 31]).ok, '');
  // これが無いと、あとから好きなだけ斬ったことにできる
  check('予告時間を過ぎた申告は通らない', !verdictAccepts(verdict, 9000, [10]).ok,
    verdictAccepts(verdict, 9000, [10]).why);
  check('処理済みの断罪は二度受け付けない',
    !verdictAccepts({ ...verdict, resolved: true }, 2000, [10]).ok, '');
  check('断罪が無いときは通らない', !verdictAccepts(null, 2000, [10]).ok, '');
  check('空の申告は通らない', !verdictAccepts(verdict, 2000, []).ok, '');
  check('配列でない申告は通らない', !verdictAccepts(verdict, 2000, 'ぜんぶ').ok, '');
}

// ---- 画面の作りが壊れないこと（レビューで見つかった重大な2件）------------
//
// ① ZeroMode が #bossPanel の中身を innerHTML で置き換えていたので、
//    断罪を1回遊ぶと、同じタブでボス戦・ダンジョン・レイド・他の管理者イベントが
//    起動時に落ちるようになっていた（index.html にしかない要素が消えるため）。
//    専用の箱(#zeroArena)を足して、元の中身は隠すだけにした。
// ② セッションの後始末が無く、1本のソケットから部屋が並走し続けた。
//
// どちらもコードの形でしか固定できないので、ソースを読んで確かめる。
{
  const modes = fs.readFileSync(new URL('../public/js/modes.js', import.meta.url), 'utf8');
  const html = fs.readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
  const battle = fs.readFileSync(new URL('../server/battle.js', import.meta.url), 'utf8');

  const zi = modes.indexOf('class ZeroMode');
  const zEnd = modes.indexOf('export function startAdminEventMode', zi);
  const zero = modes.slice(zi, zEnd > 0 ? zEnd : undefined);
  check('ZeroMode がある', zi > 0, '');
  check('#bossPanel の中身を innerHTML で潰していない',
    !/panel.innerHTMLs*=/.test(zero), '');
  check('専用の箱に描いている', zero.includes('#zeroArena'), '');
  // 素直に数える（正規表現のエスケープは経路で欠けやすい）
  const restores = zero.split('restoreBossPanel()').length - 1;
  check('抜けるときに元の中身を戻す', restores >= 3, `${restores}箇所（定義1＋呼び出し2）`);

  // index.html 側の要素が、いまも1か所にしか無いことを確かめる
  for (const id of ['bossEmoji', 'bossName', 'bossHp', 'bossHpText', 'bossAtkBar']) {
    if ((html.match(new RegExp('id="' + id + '"', 'g')) || []).length !== 1) {
      check(`#${id} が index.html に1つある`, false, '数が違う');
    }
  }
  check('ボス戦の要素は index.html にしか無い（消すと復元できない）', true, '');

  // セッションの後始末
  check('部屋を畳む関数がある', battle.includes('function endZeroSession'), '');
  check('席を外す関数がある', battle.includes('function zeroSeatOut'), '');
  check('抜けた人は「見ている」に数えない', battle.includes('e.human && !e.left'), '');
  // 正規表現ではなく素直な文字列で見る（バックスラッシュは経路で欠けやすい）
  {
    const di = battle.indexOf('dropRematchesFor(ws);   //');
    check('切断時に席から外す', di > 0 && battle.slice(di, di + 160).includes('zeroSeatOut(ws)'), '');
    const ji = battle.indexOf('zeroSeatOut(ws);                 //');
    check('参加時に前の部屋を残さない', ji > 0 && battle.slice(ji, ji + 120).includes('startZeroSession'), '');
  }

  // 参加条件（予約・枠・モード）
  check('枠を取れていない人には run を返さない', battle.includes('if (!live) return null;'), '');
  check('断罪の回でなければ参加させない', battle.includes("live.occ.modeId !== 'zero'"), '');

  // レート制限が全メッセージに付いていること
  for (const m of ['zero_join', 'zero_cut', 'zero_stake', 'zero_vote', 'zero_will', 'zero_topout']) {
    const i = battle.indexOf(`case '${m}':`);
    const seg = i > 0 ? battle.slice(i, i + 420) : '';
    if (i > 0 && !seg.includes('sockRate')) { check(`${m} にレート制限がある`, false, '無い'); }
  }
  check('断罪の全メッセージにレート制限がある', true, '');

  // 離脱処理が case 'state' に紛れ込んでいないこと（実際に一度そうなった）
  const si = battle.indexOf("case 'state': {");
  const seg = si > 0 ? battle.slice(si, si + 500) : '';
  check('離脱処理が state の中に紛れ込んでいない', !seg.includes('zeroSeatOut') && !seg.includes('e.left = true'), '');
}
for (const [ok, name, detail] of results) console.log(ok, name, detail ? `— ${detail}` : '');
