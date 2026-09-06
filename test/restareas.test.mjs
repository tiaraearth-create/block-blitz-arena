// リポジトリのルートから:  node test/restareas.test.mjs
//
// 🔍 未監査だった5領域（管理者ツール・👁️断罪・にぎわい/翻訳/投票・
//    フレンド/パーティ・オフライン/PWA）で見つかったバグの回帰テスト。
//
//   A. 断罪: 処刑の上限に達したあとは、落としてもお邪魔が1マスも降らなかった
//   B. オフライン: 控えを2件以上まとめて送ると2件目以降のスコアが92秒ぶんに切られた
//   C. 管理者: staffExtras を OFF にしてもゴッドモードが止まらず、解除もできない
//   D. 管理者: 総入れ替えで引退させた追加住人が復活する／喋らせた口だけ監査ログ無し
//   E. にぎわい: URの速報が2回流れる／テストボタン3つが静かな時間帯に何もしない
//   F. 翻訳: 英→日の「訳し残しなら配らない」歯止めが、いちばん多い形で発動しない
//   G. 投票: 8種のイベントのうち毎回ランダムに2種が候補から欠ける
//   H. フレンド: 挑戦状の「消す」が画面のデータを壊す／送った申請に期限が効かない
//   I. 退会: ギルドチャットとリアクションの名前一覧にだけ実名が残る
//   J. オフライン: 控えの掃除が新しい順／送信前に外す／捨てた理由がデイリー固定
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as translate from '../server/translate.js';
import * as polls from '../server/polls.js';
import { EVENT_TYPES } from '../server/events.js';
import * as friends from '../server/friends.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const read = f => fs.readFileSync(path.join(ROOT, f), 'utf8').replace(/\r\n/g, '\n');
const stripComments = src => src.replace(/\r\n/g, '\n')
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^\s*\/\/.*$/gm, '');

const results = [];
const check = (name, ok, detail = '') => {
  results.push([ok ? '✅' : '❌', name, detail]);
  if (process.env.TEST_VERBOSE) console.log(ok ? '✅' : '❌', name, detail ? `— ${detail}` : '');
  if (!ok) process.exitCode = 1;
};

const modes = stripComments(read('public/js/modes.js'));
const index = stripComments(read('server/index.js'));
const battle = stripComments(read('server/battle.js'));
const admin = stripComments(read('server/routes/admin.js'));
const admintools = stripComments(read('public/js/admintools.js'));
const screens = stripComments(read('public/js/screens.js'));
const zeroSess = stripComments(read('server/zero-session.js'));
const social = stripComments(read('server/routes/social.js'));
const friendsSrc = stripComments(read('server/friends.js'));
const localdata = stripComments(read('public/js/localdata.js'));
const net = stripComments(read('public/js/net.js'));
const mainJs = stripComments(read('public/js/main.js'));
const i18n = stripComments(read('public/js/i18n.js'));
const advent = stripComments(read('public/js/adminevent.js'));

// ===========================================================================
// A. 断罪のお邪魔
// ===========================================================================
{
  const fn = modes.match(/onSomeoneMissed\(m\) \{[\s\S]*?\n {2}\}/);
  check('A-0 onSomeoneMissed を取り出せる', !!fn, '');
  if (fn) {
    check('A-1 victim が無くても引き返さない', !/^\s*if \(!m\.victim\) return;/m.test(fn[0]), '');
    check('A-2 処刑の告知は victim があるときだけ', /if \(m\.victim\) \{/.test(fn[0]), '');
    check('A-3 お邪魔は「自分が落としたか」で決まる',
      /if \(m\.mine === true && Array\.isArray\(m\.cells\)/.test(fn[0]), '');
    // 告知の分岐がお邪魔の分岐より前にあり、どちらも独立していること。
    check('A-4 2つの条件が入れ子になっていない',
      fn[0].indexOf('if (m.victim) {') < fn[0].indexOf('if (m.mine === true'), '');
  }
}

// ===========================================================================
// B. オフライン控えの壁時計クランプ
// ===========================================================================
check('B-1 基準を now へ倒さず、受け付けたぶんだけ進める',
  /user\.stats\.lastResultAt = Math\.min\(now, last \+ Math\.ceil\(duration\) \* 1000\);/.test(index), '');
{
  // 実際の式を通す（控えを3件まとめて送っても、各回の duration が残るか）。
  const clamp = (last, now, duration) => {
    const elapsed = (now - last) / 1000 + 90;
    const d = duration > elapsed ? Math.max(1, Math.floor(elapsed)) : duration;
    return { d, next: Math.min(now, last + Math.ceil(d) * 1000) };
  };
  // 圏外で 300 秒ずつ3回遊び、20分後に 2.5 秒間隔で送る。
  const T0 = 1_000_000_000_000;
  let last = T0;                    // 最後の提出＝圏外に入る直前
  const got = [];
  for (let i = 0; i < 3; i++) {
    const now = T0 + 20 * 60_000 + i * 2500;
    const r = clamp(last, now, 300);
    got.push(r.d);
    last = r.next;
  }
  check('B-2 3件とも本来の長さを保つ', JSON.stringify(got) === JSON.stringify([300, 300, 300]), JSON.stringify(got));
  // 不正防止の性質（合計は実時間を超えない）も残っているか。
  const T1 = 2_000_000_000_000;
  let l2 = T1, sum = 0;
  for (let i = 0; i < 10; i++) {
    const now = T1 + 60_000 + i * 100;   // 実際には1分しか経っていない
    const r = clamp(l2, now, 7200);
    sum += r.d;
    l2 = r.next;
  }
  check('B-3 実時間を大きく超える申告は通らない', sum <= 60 + 90 * 10 + 5, `合計 ${sum}秒`);
}

// ===========================================================================
// C/D. 管理者ツール
// ===========================================================================
check('C-1 ゴッドのループが staffExtras を見る',
  /function applyGod\(\) \{[\s\S]{0,400}?if \(!isAdmin\(\)\) \{/.test(admintools), '');
check('C-2 OFF にしたら自分が書いた分を畳む',
  /if \(!isAdmin\(\)\) \{[\s\S]{0,700}?god\.mult = 1;/.test(admintools), '');
check('C-3 オートパイロットも一緒に止める',
  /if \(!isAdmin\(\)\) \{[\s\S]{0,800}?if \(autopilot\.on\) stopAutopilot\(\);/.test(admintools), '');
check('D-1 総入れ替えで追加住人の引退を持ち越す',
  /const keptCustom = \(Array\.isArray\(cur\.removed\) \? cur\.removed : \[\]\)\s*\n\s*\.filter\(id => String\(id\)\.startsWith\('x'\)\);/.test(admin), '');
check('D-2 住人に喋らせた口も監査ログに残す',
  /adminLog\(req, 'chat_say', entry\.from/.test(admin), '');
check('D-3 王座の欠片が管理画面に見える', /shards: Number\(u\.shards\) \|\| 0,/.test(admin)
  && /num\('ueShards', '王座の欠片'/.test(screens), '');
check('D-4 欠片は差分（grantShards）で送る', /body\.grantShards = d;/.test(screens), '');
check('D-5 ゼロの卓の kind が台詞表とそろっている',
  /const KINDS = \['open', 'solo', 'verdict', 'cut', 'missed', 'danBroken', 'revive', 'deal', 'dealYes', 'dealNo', 'wrap'\];/.test(screens), '');
{
  // 台詞表の実キーと本当に一致しているか（写経がズレたら赤くする）。
  const zero = read('server/zero.js');
  const table = zero.match(/ZERO_LINES = \{[\s\S]*?\n\};/);
  const keys = table ? [...table[0].matchAll(/^ {2}([A-Za-z][\w]*):/gm)].map(m => m[1]) : [];
  const listed = (screens.match(/const KINDS = \[([^\]]*)\]/) || [])[1] || '';
  const inUi = listed.split(',').map(x => x.trim().replace(/'/g, '')).filter(Boolean);
  const missing = keys.filter(k => !inUi.includes(k));
  const bogus = inUi.filter(k => !keys.includes(k));
  check('D-6 台詞表に無い kind が並んでいない', bogus.length === 0, bogus.join(','));
  check('D-7 台詞表の kind が全部出せる', keys.length > 0 && missing.length === 0, `keys=${keys.length} 欠け=${missing.join(',')}`);
}
check('D-8 断罪録に伝言の枝がある', /case 'will':/.test(advent), '');

// ===========================================================================
// E. にぎわい
// ===========================================================================
check('E-1 always 行が2回流れない',
  /notes\.filter\(n => !n\.react && !n\.always\)/.test(index), '');
check('E-2 テストの3つが静かな時間帯も流す',
  /function performScript\(script, key = 'chat', force = false\)/.test(battle)
  && /if \(!force && !crowdOn\(key\)\) return;/.test(battle), '');
check('E-3 テストフックが force を渡している',
  (battle.match(/performScript\([^;]*, null, true\)/g) || []).length === 3,
  String((battle.match(/performScript\([^;]*, null, true\)/g) || []).length));
check('E-4 リアクションの流量がアカウント単位でも効く',
  /userRate\(`react:\$\{ws\.user \? ws\.user\.id : sockIp\(ws\)\}`, 12, 10_000\)/.test(battle), '');

// ===========================================================================
// F. 翻訳（実物の関数を通す）
// ===========================================================================
{
  const tl = translate.translateLocal;
  const half = ['i finally beat the demon king', 'can someone explain how mines work', 'when does weekly reset'];
  const bad = half.filter(s => tl(s, 'ja') !== null);
  check('F-1 訳し残しのある文は配らない', bad.length === 0, bad.join(' / '));
  // まともに訳せる短文は今までどおり通る。
  const fine = ['hello', 'thanks'].filter(s => tl(s, 'ja') !== null);
  check('F-2 訳せる文はちゃんと配る', fine.length === 2, fine.join(','));
  check('F-3 判定が文字数で書かれている',
    /const latin = \(out\.match\(\/\[A-Za-z\]\/g\) \|\| \[\]\)\.length;/.test(stripComments(read('server/translate.js'))), '');
  // 日→英の歯止めは触っていない。
  check('F-4 日→英の歯止めは残っている', /if \(to === 'en' && HAS_JA\.test\(out\)\) return null;/.test(stripComments(read('server/translate.js'))), '');
}

// ===========================================================================
// G. 投票の候補（実物の関数を通す）
// ===========================================================================
{
  const all = polls.eventPollOptions(EVENT_TYPES.length);
  check('G-1 全種類が候補に出る', all.length === EVENT_TYPES.length, `${all.length} / ${EVENT_TYPES.length}`);
  const ids = new Set(all.map(o => o.eventType));
  check('G-2 取りこぼしが無い', EVENT_TYPES.every(t => ids.has(t.id)),
    EVENT_TYPES.filter(t => !ids.has(t.id)).map(t => t.id).join(','));
  check('G-3 少なく頼めば少なく返る', polls.eventPollOptions(3).length === 3, '');
  check('G-4 何度呼んでも全部そろう',
    Array.from({ length: 20 }, () => polls.eventPollOptions(EVENT_TYPES.length).length)
      .every(n => n === EVENT_TYPES.length), '');
}

// ===========================================================================
// H. フレンドまわり
// ===========================================================================
check('H-1 挑戦状の「消す」も friendsView を返す',
  /const r = dismissChallenge\(db, req\.user, fromId\);[\s\S]{0,600}?res\.json\(friendsView\(db, req\.user, levelOf, friendStatus\(\)\)\);/.test(social), '');
check('H-2 送信控えの期限を見る口がある', /export function liveReqTo\(to, fromId\)/.test(friendsSrc), '');
check('H-3 sendRequest が腐った控えを捨てる',
  /if \(from\.friendReqOut\.includes\(toId\)\) \{[\s\S]{0,220}?from\.friendReqOut = from\.friendReqOut\.filter\(id => id !== toId\);/.test(friendsSrc), '');
check('H-4 「送った申請」も生きているものだけ出す',
  /\.filter\(id => liveReqTo\(userOf\(db, id\), user\.id\)\)/.test(friendsSrc), '');
{
  // ⚠ まだ関数が無い木でも**落とさずに赤くする**（無ければ常に false を返す代役）。
  //    素の名前つき呼び出しだと TypeError でファイルごと止まり、
  //    「直す前は落ちる」の確かめができない。
  const liveReqTo = typeof friends.liveReqTo === 'function' ? friends.liveReqTo : () => false;
  const now = Date.now();
  const fresh = { friendReqIn: [{ from: 'me', at: now - 1000 }] };
  const stale = { friendReqIn: [{ from: 'me', at: now - 15 * 24 * 3600 * 1000 }] };
  check('H-5 生きた申請は見つかる', liveReqTo(fresh, 'me') === true, '');
  check('H-6 14日を過ぎた申請は無いものとして扱う', liveReqTo(stale, 'me') === false, '');
  check('H-7 相手が居ないときも落ちない', liveReqTo(null, 'me') === false, '');
}
check('H-8 フレンド系の上限に英訳がある',
  /\^フレンドは\(\\d\+\)人までです\$/.test(i18n)
  && /\^申請は同時に\(\\d\+\)件までです\$/.test(i18n)
  && /\^ブロックは\(\\d\+\)人までです\$/.test(i18n), '');
check('H-9 パーティー通報の中身が管理画面に出る',
  /b\.kind === 'party' && b\.party \?/.test(screens), '');

// ===========================================================================
// I. 退会したアカウントの名前
// ===========================================================================
check('I-1 ギルドチャットの名前も伏せる',
  /if \(db\.guilds\) \{[\s\S]{0,500}?c\.from = TX_ANON_NAME; c\.fromId = null; chat\+\+;/.test(admin), '');
check('I-2 リアクションの持ち主一覧も伏せる',
  /const scrubReacts = e => \{/.test(battle) && /e\.reacts\[k\] = e\.reacts\[k\]\.map\(x => \(x === name \? replacement : x\)\);/.test(battle), '');
check('I-3 メモリ側の所有者表も直す',
  /for \(const owners of reactOwners\.values\(\)\) \{/.test(battle), '');

// ===========================================================================
// J. オフライン・端末の控え
// ===========================================================================
check('J-1 仕舞った控えは古いほうから捨てる',
  /for \(const k of owners\.slice\(ARCHIVE_MAX_OWNERS\)\) store\.removeItem\(k\);/.test(localdata), '');
check('J-2 退会後にゲスト時代の控えを戻す',
  /ARCH_PREFIX \+ 'guest'[\s\S]{0,400}?store\.removeItem\(ARCH_PREFIX \+ 'guest'\);/.test(localdata), '');
check('J-3 控えを外すのは送信の後',
  /const drop = \(\) => writeResultQueue\(readResultQueue\(\)\.filter\(e => e\.body\.runId !== entry\.body\.runId\)\);/.test(net)
  && /queueOffline: false \}\);\s*\n\s*drop\(\);/.test(net), '');
// v2.74 で判定を RETRY_LATER（0/429/503 の1つの表）にまとめた。
// 見るべき性質は同じ「一時的な失敗では控えを消さない」で、式の書き方だけが
// 変わっている。表そのものの中身と、送る前／送り直しの両方が同じ表を見て
// いることは test/opplayout.test.mjs の B節が押さえている。
check('J-4 一時的な失敗では控えを消さない',
  /if \(RETRY_LATER\.has\(err\.status\)\) break;/.test(net)
  && /RETRY_LATER = new Set\(\[0, 429, 503\]\)/.test(net), '');
check('J-5 捨てたときの知らせにモードを載せる',
  /function noteResultsDropped\(count, reason, mode\)/.test(net), '');
check('J-6 デイリー以外は専用の文面にしない',
  /const isDaily = d\.mode === 'daily';/.test(mainJs) && /件ぶんの記録を送れませんでした/.test(mainJs), '');

// ===========================================================================
// K. 断罪（取引・的・杭）
// ===========================================================================
check('K-1 段が割れたら取引の締めを知らせる',
  /if \(emit && run\.deal && !run\.deal\.settled\) \{[\s\S]{0,220}?type: 'zero_deal_done'/.test(zeroSess), '');
check('K-2 画面は取引パネルを二重に出さない',
  /const stale = document\.getElementById\('zeroDeal'\);\s*\n\s*if \(stale\) stale\.remove\(\);/.test(modes), '');
check('K-3 「今夜の的」を枠へ預ける',
  /targetCol: \(run && Number\.isInteger\(run\.targetCol\)\) \? run\.targetCol : Math\.floor\(random\(\) \* SIZE\)/.test(zeroSess)
  && /run\.targetCol = s\.targetCol;/.test(zeroSess), '');
check('K-4 杭の本数も枠へ預ける',
  /run\.stakes2 = s\.stakes2;/.test(zeroSess) && /run\.stakes2 = 0;/.test(zeroSess), '');
check('K-5 杭に盤面の裏づけがある',
  /const colFilled = \(g, c\) => \{/.test(zeroSess) && /if \(!okCol\) return \{ ok: false \};/.test(zeroSess), '');
check('K-6 同期が無いときは通す（正当なプレイヤーを弾かない）',
  /if \(grids\.length\) \{/.test(zeroSess), '');

for (const [mark, name, detail] of results) console.log(mark, name, detail ? `— ${detail}` : '');
const bad = results.filter(r => r[0] === '❌').length;
console.log(`\n${results.length - bad}/${results.length} 件 OK`);
