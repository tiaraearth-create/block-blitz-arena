// リポジトリのルートから:  node test/deadwiring.test.mjs
//
// 🧹 「繋いだつもりで繋がっていなかった」配線の回帰。
//
// 新要素の案出しをしたときに、案の「最初の1コミット」がことごとく
// 既存のバグ修正から始まることが分かった。どれも壊れ方が同じで、
//   ・片側だけ実装されている（クライアントは送るのにサーバーが受け取らない）
//   ・欄の名前が実際と違う（res.id / e.pick / mode.icon）
//   ・呼ぶ場所がどこにも無い（REACTIONS.shop_sale / ctx.humans / onIllegal）
//   ・APIはあるのに画面が無い（curl 専用）
// **エラーも警告も出ない**ので、動いているつもりのまま何ヶ月も残る。
// 一度潰したら、もう一度開かないように機械で見張る。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const read = p => fs.readFileSync(path.join(ROOT, p), 'utf8').replace(/\r\n/g, '\n');

const results = [];
const check = (name, ok, detail = '') => {
  results.push([ok ? '✅' : '❌', name, detail]);
  if (!ok) process.exitCode = 1;
};

const idx = read('server/index.js');
const modes = read('public/js/modes.js');
const game = read('public/js/game.js');
const crowd = read('server/crowd.js');
const ambient = read('server/ambient.js');
const zs = read('server/zero-session.js');
const ae = read('server/adminevent.js');
const aeClient = read('public/js/adminevent.js');
const screens = read('public/js/screens.js');

// ===========================================================================
// ① クライアントが送る欄は、サーバーの写し取り一覧に載っていること
//
// pickResultFields は RESULT_FIELDS に載っている欄しか写さない。載せ忘れると
// **黙って捨てられる**（400にもならない）。stageCode が2ヶ月これだった。
// ===========================================================================
{
  // submitResult に渡している欄を機械で数え上げ、RESULT_FIELDS と突き合わせる。
  const fieldsBlock = idx.slice(idx.indexOf('const RESULT_FIELDS = ['), idx.indexOf('];', idx.indexOf('const RESULT_FIELDS = [')));
  const declared = new Set([...fieldsBlock.matchAll(/'([a-zA-Z]+)'/g)].map(m => m[1]));
  check('①-0(前提) RESULT_FIELDS を読めた', declared.size > 15, `${declared.size}欄`);

  // クライアント側 submitResult(...) の呼び出しから、渡している欄名を拾う。
  const sent = new Set();
  for (const m of modes.matchAll(/submitResult\(\{([\s\S]{0,900}?)\}\)/g)) {
    for (const k of m[1].matchAll(/(?:^|[\s{,])([a-zA-Z][a-zA-Z0-9]*)\s*:/g)) sent.add(k[1]);
    // `...(cond ? { stageCode: x } : {})` の形も拾う
    for (const k of m[1].matchAll(/\{\s*([a-zA-Z][a-zA-Z0-9]*)\s*:/g)) sent.add(k[1]);
  }
  // 送信の器そのもの（body/method）や、モード側だけで使う名前は対象外。
  const IGNORE = new Set(['method', 'body', 'replay', 'seed', 'moves', 'score2']);
  const missing = [...sent].filter(k => !declared.has(k) && !IGNORE.has(k));
  check('①-1 送っている欄がすべて RESULT_FIELDS にある',
    missing.length === 0,
    missing.length ? `捨てられている: ${missing.join(', ')}` : `${sent.size}欄を照合`);
  check('①-2 stageCode が載っている（工房の初回クリア判定の前提）', declared.has('stageCode'), '');
  check('①-3 工房は「その日そのステージの初回だけ」勝ち扱い',
    /ww\.codes\.includes\(code\)/.test(idx), '');
  check('①-4 コードが無い回は従来どおり時間の上限で受ける',
    /rateLimit\(`wswin:\$\{user\.id\}`, 40, 60 \* 60 \* 1000\)/.test(idx), '');
}

// ===========================================================================
// ② 欄の名前が、実際に書き込んでいる側と合っていること
// ===========================================================================
{
  // pickResidentBot は { resident, name, registered, rating, level } を返す。
  // `res.id` は存在しないので、zero-session が読む先は res.resident.id。
  const ret = ambient.slice(ambient.indexOf('export function pickResidentBot'));
  const retLine = ret.slice(0, ret.indexOf('\n}')).match(/return \{[^}]*\}/);
  check('②-0(前提) pickResidentBot の返り値を読めた', !!retLine, retLine ? retLine[0].slice(0, 60) : '');
  check('②-1 返り値に id は無い（読み違えの前提）',
    !!retLine && !/(^|[\s{,])id\s*:/.test(retLine[0]), retLine ? retLine[0].slice(0, 80) : '');
  check('②-2 断罪は res.resident.id から住人idを取る',
    /residentId: \(res && res\.resident && res\.resident\.id\) \|\| null,/.test(zs), '');
  check('②-3 res.id を読む書き方が残っていない', !/residentId: res \? res\.id : null/.test(zs), '');

  // chronicle(run,'deal', {win, tally, q}) が書くのは win。e.pick は存在しない。
  check('②-4 取引の記録は win を書いている', /chronicle\(run, 'deal', \{ win, tally/.test(zs), '');
  check('②-5 断罪録は win を読む（pick ではない）',
    /const yes = e\.win === 'yes';/.test(aeClient) && !/\$\{e\.pick \?/.test(aeClient), '');

  // AE_MODES が持つのは iconName。mode.icon は存在しない欄だった。
  check('②-6 AE_MODES は iconName を持つ', /iconName: 'mode_adminevent'/.test(ae), '');
  check('②-7 playerView が iconName から埋める',
    /id: mode\.id, icon: mode\.iconName \|\| null, iconName: mode\.iconName \|\| null,/.test(ae), '');
}

// ===========================================================================
// ③ 書いた仕掛けに、呼ぶ場所があること
// ===========================================================================
{
  // onIllegal: 宣言だけあって代入も呼び出しも無い、が2ヶ月続いていた。
  check('③-1 onIllegal を呼ぶ場所がある', /if \(this\.onIllegal\) \{ try \{ this\.onIllegal\(index, r, c\); \}/.test(game), '');
  check('③-2 呼ぶのは「置けない場所へ落とした」ときだけ',
    /if \(!\(r >= 0 && c >= 0\) \|\| !this\.engine\.canPlace\(piece, r, c\)\) \{[\s\S]{0,200}?this\.onIllegal\(/.test(game), '');
  check('③-3 合図の失敗で走行を止めない', /catch \{ \/\* 合図で走行を止めない \*\/ \}/.test(game), '');

  // REACTIONS.shop_sale: 日英13本＋{saleitem} まで揃って、呼ぶ場所がゼロだった。
  check('③-4 shop_sale の台詞がある', /REACTIONS\.shop_sale = \{/.test(crowd), '');
  check('③-5 セール入れ替わりで鳴らす場所がある',
    /battle\.crowd\.react\('shop_sale'/.test(idx), '');
  check('③-6 鳴らすのは日付が変わった1回だけ',
    /if \(day === lastSaleDay\) return;\n\s+lastSaleDay = day;/.test(idx), '');

  // ctx.humans: buildCtx まで配線済みで、供給元も読み手も無かった。
  check('③-7 humans を供給する口がある', /export function setHumansProvider\(fn\)/.test(ambient), '');
  check('③-8 worldCtx が供給された humans を載せる',
    /active: activeResidents\(now\), humans: extra\.humans \|\| liveHumans\(\),/.test(ambient), '');
  check('③-9 index.js が実プレイヤーを流し込む', /setHumansProvider\(\(\) => \{/.test(idx), '');
  check('③-10 1本のソケットを二度数えない', /if \(c\.secondary \|\| c\.isBot\) continue;/.test(idx), '');
  check('③-11 humans を読む台詞の条件がある',
    /case 'busy': return \(ctx\.humans \|\| \[\]\)\.length >= 2;/.test(crowd)
    && /case 'quiet': return \(ctx\.humans \|\| \[\]\)\.length <= 1;/.test(crowd), '');
  check('③-12 その条件を使う台詞が実在する',
    /ctx: 'busy'/.test(crowd) && /ctx: 'quiet'/.test(crowd), '');
  // 🔒 秘匿: 人数そのものを言う台詞を作らないこと（住人の頭数が逆算できる）。
  const busyLines = [...crowd.matchAll(/\{ ja: '([^']*)'[^}]*ctx: '(busy|quiet)'/g)].map(m => m[1]);
  check('③-13 賑わいの台詞が人数を言わない',
    busyLines.length > 0 && !busyLines.some(l => /\d|\{n\}|人が\d/.test(l)),
    `${busyLines.length}本を照合`);
}

// ===========================================================================
// ④ APIがあるのに画面が無い、を作らない
// ===========================================================================
{
  const admin = read('server/routes/admin.js');
  const aeRoutes = read('server/routes/adminevent.js');
  check('④-0(前提) 3本のAPIが実在する',
    /'\/api\/admin\/zero\/say'/.test(admin) && /'\/api\/admin\/zero\/speak'/.test(admin)
    && /'\/api\/admin\/throne'/.test(aeRoutes), '');
  check('④-1 運営卓の画面がある', /async function showZeroDeskModal\(\) \{/.test(screens), '');
  check('④-2 3本とも卓から呼んでいる',
    /'\/api\/admin\/zero\/say'/.test(screens) && /'\/api\/admin\/zero\/speak'/.test(screens)
    && /'\/api\/admin\/throne'/.test(screens), '');
  check('④-3 管理パネルに入口がある', /zb\.id = 'btnZeroDesk';/.test(screens), '');
  check('④-4 現在の到達段を出せる（/api/status が返す）', /throneMax: aeThroneMax\(db\),/.test(idx), '');
  check('④-5 二度押しで二重に投げない', /if \(btn\.disabled\) return;\n\s+btn\.disabled = true;/.test(screens), '');
}

const pass = results.filter(r => r[0] === '✅').length;
console.log(`\n🧹 死んでいた配線  [${pass}/${results.length}]`);
for (const [mark, name, detail] of results) {
  console.log(`   ${mark} ${name}${detail ? ` — ${detail}` : ''}`);
}
if (pass !== results.length) console.log(`\n❌ ${results.length - pass} 件が失敗しました`);
