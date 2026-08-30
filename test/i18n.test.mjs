// リポジトリのルートから:  node test/i18n.test.mjs
// 英語で遊んだときに日本語が出てこないかを見る。
//
// この手の抜けは自分からは絶対に気づけない。trServer は表に無い文字列を
// そのまま返すので、英訳を足し忘れても何も壊れず、英語の画面に日本語の
// トーストが出るだけ ── 日本語で遊んでいる限り一生見えない。
// だから機械で見張る。

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..');
const read = p => fs.readFileSync(path.join(root, p), 'utf8');

const results = [];
const check = (name, ok, detail = '') => { results.push([ok ? '✅' : '❌', name, detail]); if (!ok) process.exitCode = 1; };

const i18n = read('public/js/i18n.js');
const translated = new Set([...i18n.matchAll(/^\s*'([^']+)':\s*'/gm)].map(m => m[1]));
const hasJa = s => /[ぁ-んァ-ヶ一-龠]/.test(s);

// ---------------------------------------------------------------------------
// 1. プレイヤーに届くサーバーメッセージ
// ---------------------------------------------------------------------------
// 管理者専用の窓口（requireAdmin / requireMod の中）は対象外にする ──
// あそこを読むのは運営だけで、運営は日本語で読んでいる。
const PLAYER_FILES = ['server/party.js', 'server/friends.js'];
// ルート定義は server/routes/ に分割されたので、プレイヤー向けの文言も
// index.js だけには残っていない。「表に載っている英訳が本当にサーバーから
// 出ているか」を見る検査なので、探す範囲は広げるだけでよい（狭いままだと、
// 生きている対訳を死んだ対訳と誤判定する）。
const MIXED_FILES = ['server/index.js', 'server/battle.js',
  ...fs.readdirSync(path.join(root, 'server', 'routes'))
    .filter(f => f.endsWith('.js')).map(f => `server/routes/${f}`)];

let missing = [];
for (const f of PLAYER_FILES) {
  // コメント行は飛ばす。説明文の中の例（`{ error: '日本語' }` など）を
  // 本物のメッセージと数えると、直しようのない失敗が出続ける。
  for (const line of read(f).split('\n')) {
    if (/^\s*(\/\/|\*|\/\*)/.test(line)) continue;
    for (const m of line.matchAll(/(?:error|message):\s*'([^']*)'/g)) {
      const txt = m[1];
      if (hasJa(txt) && !translated.has(txt)) missing.push(`${f}: ${txt}`);
    }
  }
}
check('フレンド／パーティーのメッセージに英訳の抜けがない',
  missing.length === 0, missing.slice(0, 6).join(' / '));

// index.js / battle.js は管理者用と混ざっているので、
// 「明らかにプレイヤーが踏むもの」だけを名指しで見る。
const MUST_HAVE = [
  'いまはあなたの枠の時間ではありません',
  '受け取れる報酬がありません',
  'この回に参加していません',
  'アイテムを持っていません',
  '所持していないアイテムです',
  'まだ獲得していない称号です',
  'その名前は使えません。別の名前でどうぞ',
  '接続数が上限に達しています。しばらくしてからお試しください',
  '同じアカウントの接続が多すぎます',
  '連投しすぎです。少し待ってください',
  'アリーナが満席です。次の枠でお待ちしています',
  '👑 管理者イベント専用ショップの品です（王座の欠片でのみ交換）',
];
const notYet = MUST_HAVE.filter(x => !translated.has(x));
check('プレイヤーがよく踏むメッセージがすべて英訳ずみ',
  notYet.length === 0, notYet.join(' / '));

// 実際にサーバーがその文字列を出しているか（表だけ育って本体と離れないように）
const serverSrc = MIXED_FILES.map(read).join('\n');
const orphan = MUST_HAVE.filter(x => !serverSrc.includes(x));
check('英訳の対象がサーバー側に実在する（死んだ対訳を溜めない）',
  orphan.length === 0, orphan.join(' / '));

// ---------------------------------------------------------------------------
// 2. 画面の静的な文字
// ---------------------------------------------------------------------------
// applyStaticI18n が触っていない画面は、丸ごと日本語のまま残る。
// 🎒インベントリが実際にそうなっていた。
const NEED_STATIC = [
  ['#screen-inventory .sub-header h2', 'インベントリ'],
  ['[data-inv="gear"]', '装備'],
  ['[data-inv="item"]', 'アイテム'],
  ['[data-inv="title"]', '称号'],
  ['[data-inv="badge"]', 'バッジ'],
  ['#screen-friends .sub-header h2', 'フレンド'],
  ['[data-fr="list"]', 'フレンド'],
  ['[data-fr="requests"]', '申請'],
  ['[data-fr="find"]', 'さがす'],
  ['[data-fr="settings"]', '設定'],
];
const noStatic = NEED_STATIC.filter(([sel]) => !i18n.includes(`set('${sel}'`));
check('インベントリとフレンドの静的な文字が英語化されている',
  noStatic.length === 0, noStatic.map(x => x[0]).join(' / '));

// ナビゲーションのボタン
for (const id of ['btnInventory', 'btnFriends']) {
  check(`ナビの ${id} が英語表に載っている`, new RegExp(`${id}:\\s*'`).test(i18n), '');
}

// ---------------------------------------------------------------------------
// 3. エラーの出しかた
// ---------------------------------------------------------------------------
// 生の文字列をそのまま toast すると、英語の画面に日本語が出る。
const modes = read('public/js/modes.js');
check('modes.js のエラーは trServer を通している',
  !/toast\(m\.error\b(?!\s*\?)/.test(modes.replace(/trServer\(m\.error\)/g, 'OK')),
  '');
check('OnlineMode に error の受け口がある',
  /\.on\('error', m => \{ if \(m\.error\) toast\(trServer/.test(modes), '');
const party = read('public/js/party.js');
check('party.js のエラーも trServer を通している',
  /toast\(trServer\(msg\.error\)/.test(party), '');

// ---------------------------------------------------------------------------
// 4. カタログ
// ---------------------------------------------------------------------------
// 新しい装備を足したのに英語名を足し忘れると、英語面に日本語の品名が出る。
const catalogEn = read('public/js/catalog-en.js');
const catalog = read('server/catalog.js');
const ids = [...catalog.matchAll(/\{ id: '([a-z_0-9]+)',\s*cat:/g)].map(m => m[1]);
const noEn = ids.filter(id => !catalogEn.includes(`${id}:`));
check('すべての装備に英語名がある', noEn.length === 0, noEn.join(', '));

for (const [ok, name, detail] of results) console.log(ok, name, detail ? `— ${detail}` : '');
