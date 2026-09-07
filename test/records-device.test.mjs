// リポジトリのルートから:  node test/records-device.test.mjs
//
// 🧾 端末に残る記録／📜 実績の受け取りの絞り／🎰 コンプ後のガチャ。
//
// ■ ① 取り消しても端末の控えが残っていた
// 運営の取り消しはサーバーの stats を 0 にするだけで、端末の localStorage には
// 届かない。しかも持ち主が変わるときに bba_arch:<持ち主> へ**仕舞われて
// 戻ってくる**ので、ログインし直すだけで自己ベストが復活していた。
// まだ送っていない結果の控え（bba_result_queue）も残るので、取り消した直後に
// **正規の経路で**記録が戻ることすらあった。
//
// ■ ② 実績の一括受け取りに絞りが無かった
// id:'*' は条件を満たしている実績を1リクエストで満額払う。全実績の合計は
// 図鑑（90,500🪙＋612💎）の何倍もあるのに、絞りは金額の小さい図鑑側にだけ
// 付いていた。実績を足した日に、条件を満たしている古参が一斉に受け取る。
//
// ★ このファイルの本題は A-3（仕舞いからも消す）と B-2（大物が詰まない）。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { dropDeviceRecords, RECORD_KEYS, OWNED_KEYS } from '../public/js/localdata.js';
import { ACHIEVEMENTS, claimAchievement, achievementClaimRoom,
  ACH_CLAIM_COIN_DAY, ACH_CLAIM_GEM_DAY } from '../server/achievements.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const src = f => fs.readFileSync(path.join(ROOT, f), 'utf8').replace(/\r\n/g, '\n');

const results = [];
const check = (name, ok, detail = '') => {
  results.push([ok ? '✅' : '❌', name, detail]);
  if (!ok) process.exitCode = 1;
};

// 端末を模した store（localStorage と同じ length / key(i) を持つ）
function fakeStore(seed = {}) {
  const bag = { ...seed };
  return {
    bag,
    get length() { return Object.keys(bag).length; },
    key: i => Object.keys(bag)[i] ?? null,
    getItem: k => (k in bag ? bag[k] : null),
    setItem: (k, v) => { bag[k] = String(v); },
    removeItem: k => { delete bag[k]; },
  };
}

// ===========================================================================
// A. 🧾 端末に残る記録
// ===========================================================================
{
  const store = fakeStore({
    bba_best: '1000000',
    bba_dungeon_max: '100',
    bba_sprint_60: '55000',
    bba_result_queue: '[{"body":{"score":999999}}]',
    bba_puzzle_stars: '42',       // ★ サーバーに控えが無い ── 消してはいけない
    bba_items: '{"item_bomb":3}', // 持ち物 ── 記録ではない
    bba_bookmark: '{}',           // 途中の1本 ── 記録ではない
    'bba_arch:u:abc': JSON.stringify({
      bba_best: 900000, bba_sprint_60: 1, bba_puzzle_stars: 7, bba_items: '{}',
    }),
  });
  const out = dropDeviceRecords(store);

  check('A-1 自己ベストを落とす', store.getItem('bba_best') === null, String(store.getItem('bba_best')));
  check('A-2 前方一致ぶん（bba_sprint_*）も落とす',
    store.getItem('bba_sprint_60') === null, String(store.getItem('bba_sprint_60')));

  // ★本題。仕舞いを残すと、ログインし直した瞬間に戻ってくる
  //   （test/localkeys.test.mjs が「Aが戻ってきたら記録が戻る」を保証している）。
  const arch = JSON.parse(store.getItem('bba_arch:u:abc') || '{}');
  check('A-3 ★仕舞ってあるぶんからも消す（戻さない）',
    arch.bba_best === undefined && arch.bba_sprint_60 === undefined,
    JSON.stringify(arch));

  // ⚠ 消してはいけないもの。★はサーバーに控えが無く、消すと本当に失われる。
  check('A-4 ★パズルの★は消さない（サーバーに控えが無い）',
    store.getItem('bba_puzzle_stars') === '42' && arch.bba_puzzle_stars === 7,
    `${store.getItem('bba_puzzle_stars')} / ${arch.bba_puzzle_stars}`);
  check('A-5 持ち物・しおりは消さない（記録ではない）',
    store.getItem('bba_items') !== null && store.getItem('bba_bookmark') !== null, '');

  // 📴 未送信の控えを残すと、取り消した直後に正規の経路で記録が戻る。
  check('A-6 ★未送信の結果の控えも落とす',
    store.getItem('bba_result_queue') === null, String(store.getItem('bba_result_queue')));
  check('A-7 件数を返す', out.dropped >= 4 && out.stashed >= 2, JSON.stringify(out));
}
{
  // 分類漏れを作らない。持ち主ごとに仕舞う棚に入っていること。
  check('A-8 反映の印が持ち主ごとの棚にある',
    OWNED_KEYS.includes('bba_records_cleared_at'), '');
  const net = src('public/js/net.js');
  check('A-9 サーバーの印を見て一度だけ落とす',
    /recordsClearedAt/.test(net) && /dropDeviceRecords\(\)/.test(net), '');
  check('A-10 端末の控え（bba_me_cache）も捨てる',
    /removeItem\('bba_me_cache'\)/.test(net), '');
  const admin = src('server/routes/admin.js');
  check('A-11 ★下げたときだけ印を打つ（上げたときは打たない）',
    /const lowered = Object\.keys\(before\)[\s\S]{0,200}?< before\[k\]\);/.test(admin)
    && /if \(lowered \|\| purged\) target\.recordsClearedAt = Date\.now\(\);/.test(admin), '');
}

// ===========================================================================
// B. 📜 実績の受け取りの絞り
// ===========================================================================
const allDone = () => ({
  coins: 0, gems: 0, achievements: [], owned: [], badges: [], collections: [],
  stats: {
    bestScore: 9e8, gamesPlayed: 999999, totalScore: 9e9, totalLines: 9e6, maxCombo: 999,
    pvpWins: 99999, aiWins: 99999, rating: 5000, ratingBest: 5000, coinsBest: 9e8, playSecs: 9e8,
    dungeonMax: 100, underMax: 100, heavenMax: 100, abyssMax: 100, bossMax: 6, puzzleStage: 9999,
    digDepth: 9999, survivalWave: 999, loginStreakBest: 3650, royaleBest: 1, royaleKills: 99999,
    championWins: 9999, logins: 99999, dailyLogins: 9999, loginStreak: 3650, totalWins: 99999,
    gachaPulls: 9999, gachaSSR: 99, ultsUsed: 99999, soloBest: 9e7, meltdownBest: 9e7,
    chimeraBest: 9e7, chainBest: 9e7, chainMax: 9999, rushDepth: 9999, blueprintClears: 9999,
    ghostBest: 9e7,
  },
});
{
  const u = allDone();
  const r = claimAchievement(u, '*');
  check('B-1 ★1日で全部は受け取れない', r.left > 0,
    `${r.ids.length}件 ${r.coins.toLocaleString()}🪙 ${r.gems}💎 / 残り${r.left}件`);
  check('B-1b 上限をおおむね超えない',
    r.coins <= ACH_CLAIM_COIN_DAY * 1.5 && r.gems <= ACH_CLAIM_GEM_DAY * 1.5,
    `${r.coins}🪙 ${r.gems}💎（上限 ${ACH_CLAIM_COIN_DAY}/${ACH_CLAIM_GEM_DAY}）`);
}
{
  // ★★ 1回だけ呼んで満足しない。**リクエストを分けても**上限が効くこと。
  //
  // ⚠ ここが v2.79 の抜けだった。詰み防止の保険が『1リクエストにつき必ず1件』
  //   だったので、"*" を43回押すだけで 287,150🪙 / 2,396💎（上限の9.6倍/8.0倍）が
  //   取れていた。B-1 は1回しか呼んでいなかったので**緑のまま通っていた**。
  //   「1回呼んで正しい」は「上限が効いている」の証明にならない。
  const u = allDone();
  let c = 0, g = 0, calls = 0;
  for (let i = 0; i < 200; i++) {
    const r = claimAchievement(u, '*');
    if (r.error) break;
    c += r.coins; g += r.gems; calls++;
  }
  check('B-1c ★同じ日に何度呼んでも上限を超えない',
    c <= ACH_CLAIM_COIN_DAY && g <= ACH_CLAIM_GEM_DAY,
    `${calls}回で ${c.toLocaleString()}🪙 ${g}💎（上限 ${ACH_CLAIM_COIN_DAY}/${ACH_CLAIM_GEM_DAY}）`);
}
{
  // ★ 実績カードの個別「受取」も同じ上限を通ること。
  //   こちらは ready が常に1件なので、『1リクエストにつき1件』の保険だと
  //   **上限が一度も適用されない**（画面から普通に押せる経路）。
  const u = allDone();
  let c = 0, g = 0, n = 0;
  for (const a of ACHIEVEMENTS) {
    const r = claimAchievement(u, a.id);
    if (r.error) continue;
    c += r.coins; g += r.gems; n++;
  }
  check('B-1d ★1件ずつ受け取っても上限を超えない',
    c <= ACH_CLAIM_COIN_DAY && g <= ACH_CLAIM_GEM_DAY,
    `${n}件で ${c.toLocaleString()}🪙 ${g}💎`);
}
{
  // 📖 収集実績の分子も図鑑と同じ物差しで数える（v2.70 で ach_own45 だけ直して
  //    ach_own5/15/30 が取り残されていた）。既定装備4点だけを持つ新規が、
  //    交換所で1点引き換えただけで『5種所持』にならないこと。
  const fresh = {
    owned: ['skin_default', 'board_default', 'fx_default', 'ult_blast', 'board_glass'],
    achievements: [], badges: [], collections: [], coins: 0, gems: 0, stats: {},
  };
  const own5 = ACHIEVEMENTS.find(a => a.id === 'ach_own5');
  check('B-1e ★収集実績が図鑑に数えない品で埋まらない',
    !!own5 && Number(own5.value(fresh)) < own5.goal,
    own5 ? `${own5.value(fresh)}/${own5.goal}（既定4点＋交換所限定1点）` : 'ach_own5 が無い');
}
{
  // ★本題は2つ。**枠は守る**が、**永久に詰ませない**。
  //
  // ⚠ ここは以前「枠が尽きていても必ず1件は通る」を確かめていた。それは
  //   まさに上限を無効にしていた穴（1リクエスト1件）の追認で、テストが
  //   バグを守っていた。詰み防止が要るのは「**単品で1日の枠に収まらない**」
  //   実績だけ ── 収まるものは今日ダメでも明日取れるので、詰んでいない。
  const day = () => new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10);
  const big = ACHIEVEMENTS.slice().sort((a, b) => b.coins - a.coins)[0];

  // ① 枠に収まる実績は、枠を使い切っていれば今日は通さない。
  const u1 = allDone();
  u1.achievements = ACHIEVEMENTS.filter(a => a.id !== big.id).map(a => a.id);
  u1.stats.achClaimDay = { day: day(), coins: ACH_CLAIM_COIN_DAY, gems: ACH_CLAIM_GEM_DAY };
  const spent = claimAchievement(u1, '*');
  check('B-2 ★枠を使い切ったら、その日はもう払わない',
    !!spent.error || (spent.ids && spent.ids.length === 0),
    `${big.id} ${big.coins}🪙${big.gems}💎 → ${JSON.stringify(spent.ids || spent.error)}`);

  // ② 翌日になれば取れる（権利は消えていない）。
  const u2 = allDone();
  u2.achievements = ACHIEVEMENTS.filter(a => a.id !== big.id).map(a => a.id);
  const fresh = claimAchievement(u2, '*');
  check('B-2b ★枠が空いていれば取れる（権利は消えない）',
    fresh.ids && fresh.ids.includes(big.id), JSON.stringify(fresh.ids));

  // ③ 単品で1日の枠に収まらない実績があれば、まっさらな日に必ず通す。
  //    （いまの表には無いので、あるときだけ確かめる）
  const huge = ACHIEVEMENTS.find(a => a.coins > ACH_CLAIM_COIN_DAY || a.gems > ACH_CLAIM_GEM_DAY);
  if (huge) {
    const u3 = allDone();
    u3.achievements = ACHIEVEMENTS.filter(a => a.id !== huge.id).map(a => a.id);
    const r3 = claimAchievement(u3, '*');
    check('B-2c ★枠に収まらない実績は、まっさらな日に必ず通す（詰まない）',
      r3.ids && r3.ids.includes(huge.id), JSON.stringify(r3.ids));
  } else {
    check('B-2c 前提: いまの表に枠を超える実績は無い', true,
      `最大 ${big.id} ${big.coins}🪙${big.gems}💎 / 枠 ${ACH_CLAIM_COIN_DAY}🪙${ACH_CLAIM_GEM_DAY}💎`);
  }
}
{
  // 権利は消えない（明日また受け取れる）。数日に均すだけ。
  const u = allDone();
  // ⚠ 母数は「この人が実際に達成しているもの」で数える。ACHIEVEMENTS.length と
  //   比べると、所持品やバッジが要る実績（この模擬プレイヤーは持っていない）を
  //   数え込んで、実装が正しくても永久に赤くなる。
  const ready = ACHIEVEMENTS.filter(a => (Number(a.value(u)) || 0) >= a.goal).length;
  let days = 0, total = 0;
  for (let i = 0; i < 40; i++) {
    const r = claimAchievement(u, '*');
    if (r.error) break;
    days++; total += r.ids.length;
    u.stats.achClaimDay = null;   // 翌日
  }
  // ⚠ total が ready を**上回る**のは正しい。受け取ったコインで
  //   「コインを◯◯貯める」系の実績が途中から達成になるため。
  check('B-3 何日かで全部受け取れる（権利は消えない）',
    ready > 0 && total >= ready && days > 1 && days <= 25,
    `${days}日で${total}件（開始時に達成済み ${ready}件 / 実績表は全${ACHIEVEMENTS.length}件）`);
}
{
  const u = allDone();
  claimAchievement(u, '*');
  const room = achievementClaimRoom(u);
  check('B-4 きょうの残り枠を返す（画面が案内できる）',
    room && room.coins < ACH_CLAIM_COIN_DAY, JSON.stringify(room));
  // ⚠ 止め金は user.stats の下（復元マージの輪が拾う場所）。
  check('B-5 ★止め金が stats の下にある（復元で開き直さない）',
    !!(u.stats && u.stats.achClaimDay), Object.keys(u).filter(k => /achClaim/i.test(k)).join(','));
  check('B-6 復元マージの輪に入っている',
    /\['achClaimDay', \['coins', 'gems'\]\]/.test(src('server/backup.js')), '');
}

// ===========================================================================
// C. 🎰 図鑑コンプ後のガチャ
// ===========================================================================
{
  const shop = src('server/routes/shop.js');
  // 無作為に3個だと、山ほど持っている品が当たって「回す意味が無い」。
  check('C-1 ★いちばん少ない持ち物を補充する',
    /const held = id => Number\(user\.items\[id\]\) \|\| 0;/.test(shop)
    && /sort\(\(a, b\) => \(held\(a\.id\) - held\(b\.id\)\)/.test(shop), '');
  check('C-2 同数なら id 順で安定させる（引くたび揺れない）',
    /\|\| \(a\.id < b\.id \? -1 : a\.id > b\.id \? 1 : 0\)\)\[0\]/.test(shop), '');
  // ⚠ 配りすぎると出口でなくなる。5個＝平均325🪙×5×7% ＝ 1回転あたり114🪙。
  //   1回転 500🪙 なので吸う側のまま。
  const qty = (shop.match(/const qty = (\d+);/) || [])[1];
  check('C-3 ★配る数が出口を壊さない範囲（5個まで）',
    Number(qty) > 0 && Number(qty) <= 5, `${qty}個`);
  check('C-4 運営専用は配らない',
    /BOOST_ITEMS\.filter\(i => !i\.adminOnly && Number\(i\.price\) > 0\)/.test(shop), '');
}

for (const [mark, name, detail] of results) console.log(`${mark} ${name}${detail ? ' — ' + detail : ''}`);
const failed = results.filter(r => r[0] === '❌').length;
console.log(`\n${results.length - failed}/${results.length} 件`);
if (failed) console.log(`❌ ${failed}件`);
