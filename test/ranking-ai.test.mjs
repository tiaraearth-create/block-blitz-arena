// Run from the repo root:  node test/ranking-ai.test.mjs
//
// 🏆 ランキングに並ぶ住人（AIプレイヤー）の成績が「生きているか」を検証する。
//
// v2.11 以前は skill と age だけの閉じた式で、実測すると:
//   ・タイムアタックとサバイバルは一生変わらない定数（14日測っても同じ値）
//   ・ハイスコアは毎日きっかり同じ幅で伸びる直線
//   ・レートは ±45 の滑らかな sin 波
//   ・skill が1つなので、強い住人は全ボードで一律に強い
// つまり数字を見るだけで「誰もプレイしていない」ことが分かってしまった。
//
// 作り直したので、ここでは相反する2種類の性質を同時に押さえる:
//   動いていること（日々変化し、階段状に伸び、得意分野が分かれる）と、
//   壊れていないこと（同じ日なら何度読んでも同じ＝ランキングが揺れない、
//   自己ベストは下がらない、計算が十分速い）。
import { buildRoster, residentStats } from '../server/residents.js';

const results = [];
const check = (name, ok, detail = '') => { results.push([ok ? '✅' : '❌', name, detail]); if (!ok) process.exitCode = 1; };

const DAY = 86400000;
// JST 正午に固定。+数時間しても同じ JST 日のままなので、日付境界の影響を受けない。
const NOON_JST = Date.UTC(2026, 7, 26, 3, 0);
const roster = buildRoster('v1', 240);
const registered = roster.filter(r => r.registered);
const snap = t => roster.map(r => JSON.stringify(residentStats(r, t, 'W100')));

// ---- 揺れないこと: 同じ日なら何度読んでも同じ ------------------------------
{
  const a = snap(NOON_JST);
  check('同一JST日で安定（1分後）', a.every((v, i) => v === snap(NOON_JST + 60000)[i]));
  const late = snap(NOON_JST + 11 * 3600000);
  check('同一JST日で安定（11時間後・同日23時）', a.every((v, i) => v === late[i]));
  const next = snap(NOON_JST + DAY);
  const moved = a.filter((v, i) => v !== next[i]).length;
  check('翌日には全員なにか動く', moved === roster.length, `${moved}/${roster.length}人`);
}

// ---- 生きていること: 止まっている数字がない ---------------------------------
{
  const r = registered.find(x => x.skill > 0.7) || registered[0];
  const series = [];
  for (let d = 0; d < 21; d++) series.push(residentStats(r, NOON_JST + d * DAY, 'W100'));
  const distinct = k => new Set(series.map(s => s[k])).size;
  for (const [k, label] of [['sprintBest', 'タイムアタック'], ['survivalWave', 'サバイバル'], ['bestScore', 'ハイスコア'], ['dungeonMax', 'ダンジョン']]) {
    check(`${label}が21日のあいだに更新される`, distinct(k) >= 2, `${distinct(k)}種類の値`);
  }
  // 階段であること: 毎日ちょっとずつではなく、伸びない日が大半で時々跳ねる。
  const jumps = series.filter((s, i) => i > 0 && s.bestScore > series[i - 1].bestScore).length;
  check('ハイスコアは毎日ではなく時々伸びる（階段状）', jumps >= 1 && jumps <= 12, `21日中${jumps}日で更新`);
  // レートは上下する（sin波の頃は14日で数ptしか動かなかった）
  const rt = series.map(s => s.rating);
  const swing = Math.max(...rt) - Math.min(...rt);
  const downs = rt.filter((v, i) => i > 0 && v < rt[i - 1]).length;
  check('レートが意味のある幅で動く', swing >= 40, `${swing}pt`);
  check('レートは下がる日もある（連勝／スランプ）', downs > 0, `${downs}日下落`);
}

// ---- 壊れていないこと: 自己ベストは下がらない -------------------------------
{
  let violations = 0;
  const KEYS = ['bestScore', 'sprintBest', 'sprint180', 'survivalWave', 'dungeonMax'];
  for (const r of roster.slice(0, 80)) {
    let prev = null;
    for (let d = 0; d < 90; d++) {
      const s = residentStats(r, NOON_JST + d * DAY, 'W100');
      if (prev) for (const k of KEYS) if (s[k] < prev[k]) violations++;
      prev = s;
    }
  }
  check('自己ベストは一度も下がらない（80人×90日）', violations === 0, `違反${violations}件`);
}

// ---- 数字が壊れていないこと ------------------------------------------------
{
  let bad = [];
  for (const r of roster) {
    const s = residentStats(r, NOON_JST, 'W100');
    for (const [k, v] of Object.entries(s)) {
      if (typeof v === 'number' && !Number.isFinite(v)) bad.push(`${r.name}.${k}=${v}`);
    }
    if (s.rating < 0 || s.rating > 5000) bad.push(`${r.name}.rating=${s.rating}`);
    if (s.dungeonMax > 100 || s.dungeonMax < 1) bad.push(`${r.name}.dungeonMax=${s.dungeonMax}`);
    if (s.survivalWave < 1 || s.survivalWave > 99) bad.push(`${r.name}.survivalWave=${s.survivalWave}`);
    if (s.level < 1 || s.level > 60) bad.push(`${r.name}.level=${s.level}`);
  }
  check('全住人の数値が有限かつ範囲内', bad.length === 0, bad.slice(0, 3).join(' / '));
}

// ---- 得意分野: ボードごとに顔ぶれが変わる -----------------------------------
{
  const st = registered.map(r => ({ r, s: residentStats(r, NOON_JST, 'W100') }));
  const topArchs = (key, n = 15) => {
    const t = st.slice().sort((a, b) => b.s[key] - a.s[key]).slice(0, n);
    const c = {};
    for (const x of t) c[x.r.arch] = (c[x.r.arch] || 0) + 1;
    return c;
  };
  const rate = topArchs('rating');
  const dung = topArchs('dungeonMax');
  // ガチ勢は modes に pvp を持つのでレート上位に、探索者/夜型は dungeon 持ち。
  check('レート上位はPvP志向の住人が占める', (rate.tryhard || 0) >= 4, JSON.stringify(rate));
  check('ダンジョン上位は探索志向の住人が占める', (dung.explorer || 0) + (dung.nightowl || 0) >= 4, JSON.stringify(dung));
  const rateTop = new Set(st.slice().sort((a, b) => b.s.rating - a.s.rating).slice(0, 15).map(x => x.r.id));
  const dungTop = st.slice().sort((a, b) => b.s.dungeonMax - a.s.dungeonMax).slice(0, 15).map(x => x.r.id);
  const overlap = dungTop.filter(id => rateTop.has(id)).length;
  check('ボードごとに顔ぶれが違う（上位15の重複が半分未満）', overlap < 8, `重複${overlap}/15人`);
}

// ---- 人間が勝てる余地があること --------------------------------------------
//
// 住人は日が経つほど強くなる設計なので、上限を明示していないと半年後には
// 人間が到達しうる値を追い越してしまう。「いま」だけでなく1000日後も
// 頭打ちになっていることを確かめる。
{
  for (const days of [0, 90, 365, 1000]) {
    const at = NOON_JST + days * DAY;
    const st = registered.map(r => residentStats(r, at, 'W100'));
    const top = k => Math.max(...st.map(s => s[k]));
    check(`+${days}日: ハイスコアが上限内`, top('bestScore') <= 160000, `最高 ${top('bestScore')}`);
    check(`+${days}日: レートが上限1900以内`, top('rating') <= 1900, `最高 ${top('rating')}`);
    check(`+${days}日: 塔100Fは人間だけ（住人は95F止まり）`, top('dungeonMax') <= 95, `最高 ${top('dungeonMax')}F`);
    check(`+${days}日: タイムアタックは人間の射程内`, top('sprintBest') < 60000, `最高 ${top('sprintBest')}`);
  }
}

// ---- 速度: ランキングは頻繁に叩かれる ---------------------------------------
{
  const t0 = process.hrtime.bigint();
  for (let i = 0; i < 20; i++) roster.forEach(r => residentStats(r, NOON_JST, 'W100'));
  const ms = Number(process.hrtime.bigint() - t0) / 1e6 / 20;
  check('240人ぶんの計算が5ms未満', ms < 5, `${ms.toFixed(2)}ms / リクエスト`);
}

for (const [ok, name, detail] of results) console.log(ok, name, detail ? `— ${detail}` : '');
