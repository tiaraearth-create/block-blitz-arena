// 👁️ 断罪 ── 管理者ゼロ
//
// このファイルは**純粋な計算と台詞だけ**を持つ。db もソケットも時計も触らない。
// 依存が無いので単体テストが書けるし、台詞を足すのに他を壊す心配がない。
// セッションの進行そのものは server/battle.js の initZero が持つ。
//
// ■ このイベントの中核
// 段のHPは7割までしか点数で削れない。残り3割には「封印」があり、
// 通常ダメージが一切通らない。封印を貫通するのは、30秒ごとに来る
// 【断罪】を斬った一撃だけで、AI住人には斬れない。
//   住人 ＝ 火力（7割を削る）
//   人間 ＝ 鍵  （残り3割を割る）
// これで「人が少ないと壊れる／多いと人間が要らなくなる」を、
// 数字の調整ではなく役割の壁で解いている。
//
// ■ 数字の出どころ
// 下の DAN は scripts/sim-zero.mjs が実測して決めた値。
// 本物のエンジンとAIを走らせて住人の火力を測った結果、当初の設計案は
// 約4分の1しかなく、初心者がソロでも7段全部割れてしまう状態だった。
// 触るときは必ず `node scripts/sim-zero.mjs` を回してから。

// ---------------------------------------------------------------------------
// 段
// ---------------------------------------------------------------------------

// 王座ボードはちょうど7つ。ゼロはその7つを人質に取っている。
// 段が1つ割れるたびに王座が1つ返ってくる。
export const ZERO_BOARDS = ['score', 'rating', 'sprint', 'dungeon', 'weekly', 'puzzle', 'dig'];

export const SEAL_RATIO = 0.30;        // 人間しか割れない割合
export const SEATS_MIN = 12;           // 席の下限（住人で埋める）
export const SEATS_MAX = 24;
export const MIN_BOT_SEATS = 4;        // 住人の席は最低これだけ残す
export const HP_PER_EXTRA_HUMAN = 0.20;
export const LANE_PER_HUMANS = 3;      // 何人につき断罪1本
export const MAX_LANES = 10;
// 断罪を落としたとき／トップアウトしたときに、ゼロが回復する量（段HP比）。
//
// 当初この2つを 2% / 3% にしていたが、実際に30分ぶん回すと破綻した:
// 断罪は30秒ごとに来るので1枠で約60回。一度も斬らないと 60×2% = 段HPの
// 120% が回復し、住人の火力が丸ごと打ち消されて、点が永久に溜まらなかった
// （実測: 住人が合計489,000点入れたのに run.dealt が17,523しか残らない）。
// 罰は効いてほしいが、火力を無意味にしてはいけない。1枠ぶん全部落としても
// 点の2割程度に収まる量にする。
// ※ 回復量は同時に走る断罪の本数で割る。割らないと人数に比例して膨らみ、
//   50人の回では回復が段HPの349%に達して何も進まなくなった（実測）。
//   本数で割れば、何人居ても1枠あたりの回復量がほぼ一定になる。
export const MISS_HEAL = 0.003;        // 断罪を落とす（本数で割る前の値）
export const TOPOUT_HEAL = 0.010;      // トップアウト（60秒に1回が上限）
export const REVIVE_SEC = 60;          // トップアウトからの自動復帰
export const EXECUTIONS_PER_SLOT = 3;  // 1枠で処刑される住人の上限
export const EXECUTIONS_PER_DAY = 9;

export const DAN = [
  { n: 1, hp:   400_000, everyMs: 30_000, warnMs: 3500, cut: 0.0130, cells: 5 },
  { n: 2, hp:   480_000, everyMs: 30_000, warnMs: 3500, cut: 0.0142, cells: 5 },
  { n: 3, hp:   576_000, everyMs: 26_000, warnMs: 3500, cut: 0.0153, cells: 6 },
  { n: 4, hp:   692_000, everyMs: 26_000, warnMs: 3200, cut: 0.0165, cells: 6 },
  { n: 5, hp:   828_000, everyMs: 22_000, warnMs: 3000, cut: 0.0177, cells: 7 },
  { n: 6, hp:   996_000, everyMs: 22_000, warnMs: 3000, cut: 0.0188, cells: 7 },
  { n: 7, hp: 1_196_000, everyMs: 18_000, warnMs: 3000, cut: 0.0200, cells: 8 },
];

export function danAt(index) {
  return DAN[Math.max(0, Math.min(DAN.length - 1, index | 0))];
}

// 人数ぶん段を重くする。人が増えると同時に走る断罪の本数も増えるので、
// この2つは噛み合っていないと「人が増えるほど進まない」逆転が起きる。
export function danHpFor(index, humans, run) {
  const d = danAt(index);
  const base = Math.round(d.hp * (1 + HP_PER_EXTRA_HUMAN * Math.max(0, (humans | 0) - 1)));
  // 取引「この段のHPを半分にしてやる」
  return run && run.dealHalve ? Math.round(base / 2) : base;
}

// 取引で封印が4割に上がることがある（run.dealSeal）。
export function sealRatioOf(run) {
  const r = run && Number(run.dealSeal);
  return Number.isFinite(r) && r > 0 && r <= 0.6 ? r : SEAL_RATIO;
}

export function sealHpFor(index, humans, run) {
  return Math.round(danHpFor(index, humans, run) * sealRatioOf(run));
}

// 点数で削れる上限（＝ここから先は人間が斬らないと1ミリも減らない）
export function softCapFor(index, humans, run) {
  return danHpFor(index, humans, run) - sealHpFor(index, humans, run);
}

export function cutDamageFor(index, humans, { keystone = false, run = null } = {}) {
  const d = danAt(index);
  const base = Math.round(danHpFor(index, humans, run) * d.cut);
  return keystone ? base * 2 : base;      // 急所（金マス）を含めて斬れば倍
}

// 断罪を1回落としたときにゼロが回復する量。
export function missHealFor(index, humans, run) {
  return Math.round(danHpFor(index, humans, run) * MISS_HEAL / lanesFor(humans));
}

export function cutsNeededFor(index) {
  return Math.ceil(SEAL_RATIO / danAt(index).cut);
}

export function seatsFor(humans) {
  return Math.min(SEATS_MAX, Math.max(SEATS_MIN, (humans | 0) + MIN_BOT_SEATS));
}

export function lanesFor(humans) {
  return Math.max(1, Math.min(MAX_LANES, Math.ceil(Math.max(1, humans | 0) / LANE_PER_HUMANS)));
}

// ---------------------------------------------------------------------------
// 態度
// ---------------------------------------------------------------------------
//
// 段が進むほど、ゼロの言葉づかいが崩れていく。丁寧 → 苛立ち → 剥き出し。
// これが「HPバーではなくキャラクター」の実体。

export const MOODS = ['polite', 'annoyed', 'raw'];

export function moodFor(danIndex) {
  if (danIndex <= 1) return 'polite';
  if (danIndex <= 4) return 'annoyed';
  return 'raw';
}

// ---------------------------------------------------------------------------
// 台詞
// ---------------------------------------------------------------------------
//
// {you} 名指しした人 / {name} 誰か / {dan} 段 / {n} 数
// 型に実名と実数値が入るので、同じ型でも文脈は毎回違う。
// 運用として毎週10行ずつ足す想定。同じ台詞を2回目に見た瞬間にゼロは死ぬ。

const L = (ja, en) => ({ ja, en });

export const ZERO_LINES = {
  // 開幕
  open: {
    polite: [
      L('定例メンテナンスのお時間です。……冗談です。今日は七つの王座を回収しに参りました',
        'Time for scheduled maintenance. …I jest. I am here to collect all seven thrones.'),
      L('ようこそ。座席はご用意してあります。逃げ道はご用意しておりません',
        'Welcome. Your seats are prepared. Your exits are not.'),
    ],
    annoyed: [
      L('まだやるんですか。……いいでしょう、続けます',
        'Still at it? …Very well. We continue.'),
      L('{n}つ返しましたね。数え間違いでなければ',
        'You have taken back {n}. Assuming I counted correctly.'),
    ],
    raw: [
      L('もう敬語はやめだ。ここから先は削り合いだ',
        'No more pleasantries. From here it is attrition.'),
      L('よくここまで来た。だが残りは渡さない',
        'You came far. You get no further.'),
    ],
  },
  // ソロ（実プレイヤーが1人）
  solo: {
    polite: [
      L('今日は、あなたひとりですか', 'Only you today?'),
      L('……ならば、あなただけを断罪します', '…Then I shall condemn you alone.'),
    ],
    annoyed: [
      L('ひとりでよくやっています。認めます', 'Alone, and still standing. I acknowledge it.'),
      L('封印を割れるのは、この世界であなただけです', 'You are the only one in this world who can break the seal.'),
    ],
    raw: [
      L('お前ひとりだ。誰も助けに来ない', 'You are alone. No one is coming.'),
      L('お前が斬らなければ、何も起きない', 'If you do not cut, nothing happens.'),
    ],
  },
  // 断罪の宣告
  verdict: {
    polite: [
      L('👁️ 断罪 ── {you}', '👁️ CONDEMNED ── {you}'),
      L('{you}。あなたです', '{you}. You.'),
    ],
    annoyed: [
      L('{you}、逃げられると思いましたか', '{you}. Did you think you could slip past?'),
      L('次は {you} だ', '{you} is next.'),
    ],
    raw: [
      L('{you}', '{you}'),
      L('お前だ、{you}', 'You. {you}.'),
    ],
  },
  // 斬られた
  cut: {
    polite: [
      L('……見事です', '…Well struck.'),
      L('{you}。記録しておきます', '{you}. I am making a note.'),
    ],
    annoyed: [
      L('ちっ', 'Tsk.'),
      L('{you}、そのコンボ、覚えました', '{you}. I will remember that combo.'),
    ],
    raw: [
      L('まだ立つのか', 'Still standing.'),
      L('……いい腕だ', '…Good hands.'),
    ],
  },
  // 落とされた
  missed: {
    polite: [
      L('残念でしたね', 'A pity.'),
      L('{you} が落としました。……{name}、あなたは彼のせいで消えます',
        '{you} let it slip. …{name}, you go because of them.'),
    ],
    annoyed: [
      L('遅い', 'Too slow.'),
      L('また一人、減りましたね', 'One fewer. Again.'),
    ],
    raw: [
      L('消えろ', 'Be gone.'),
      L('{name} は {you} のせいで消えた', '{name} is gone because of {you}.'),
    ],
  },
  // 段が割れた
  danBroken: {
    polite: [L('……一つ、返します', '…One. Returned.')],
    annoyed: [L('……{dan}段目。数えていますよ', '…Stage {dan}. I am counting.')],
    raw: [L('……くそ', '…Damn.')],
  },
  // 復活
  revive: {
    polite: [L('お戻りなさい', 'Welcome back.')],
    annoyed: [L('一人、減りましたね', 'One fewer.')],
    raw: [L('また来たか', 'Back again.')],
  },
  // 取引を持ちかける
  deal: {
    polite: [L('……ひとつ、取引をしましょう。60秒差し上げます', '…A bargain, then. You have sixty seconds.')],
    annoyed: [L('取引だ。断ってもいいが、後悔はするな', 'A deal. Refuse if you like — do not complain later.')],
    raw: [L('選べ。60秒だ', 'Choose. Sixty seconds.')],
  },
  dealYes: {
    polite: [L('……賢明です。では、約束どおりに', '…Wise. As agreed, then.')],
    annoyed: [L('飲みましたね。覚えておきます', 'You took it. I will remember.')],
    raw: [L('取引成立だ', 'Done.')],
  },
  dealNo: {
    polite: [L('断りましたか。……いいでしょう', 'Refused. …Very well.')],
    annoyed: [L('断ったか。ならば、このまま続けます', 'Refused. Then we continue as we are.')],
    raw: [L('……そうか', '…I see.')],
  },
  // 総括
  wrap: {
    polite: [L('本日はここまで。{n}段、返されました', 'That is all for now. {n} stages returned.')],
    annoyed: [L('{n}段。……次の方に期待します', '{n} stages. …I shall expect more from the next.')],
    raw: [L('{n}段だ。まだ足りない', '{n} stages. Not enough.')],
  },
};

// 決定的な選び方（同じ状況で同じ台詞が出る＝リプレイが再現できる）
function strHash(s) {
  let h = 1779033703 ^ String(s).length;
  for (let i = 0; i < String(s).length; i++) {
    h = Math.imul(h ^ String(s).charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  return (h ^ (h >>> 16)) >>> 0;
}

// kind と mood から1行選び、{you} などを埋めて ja/en 両方を返す。
// 台詞は必ず両言語で返す — 直近の仕事が「翻訳総仕上げ」だったので、
// ここで片方だけにすると英語面がまた壊れる。
export function zeroSay(kind, mood, ctx = {}) {
  const group = ZERO_LINES[kind];
  if (!group) return null;
  const pool = group[mood] || group.polite || [];
  if (!pool.length) return null;
  const seed = strHash(`${kind}|${mood}|${ctx.seed != null ? ctx.seed : ''}|${ctx.you || ''}|${ctx.n || 0}`);
  const line = pool[seed % pool.length];
  const fill = (t) => String(t)
    .replace(/\{you\}/g, ctx.you || 'あなた')
    .replace(/\{name\}/g, ctx.name || '誰か')
    .replace(/\{dan\}/g, String(ctx.dan != null ? ctx.dan : ''))
    .replace(/\{n\}/g, String(ctx.n != null ? ctx.n : ''));
  const fillEn = (t) => String(t)
    .replace(/\{you\}/g, ctx.you || 'you')
    .replace(/\{name\}/g, ctx.name || 'someone')
    .replace(/\{dan\}/g, String(ctx.dan != null ? ctx.dan : ''))
    .replace(/\{n\}/g, String(ctx.n != null ? ctx.n : ''));
  return { ja: fill(line.ja), en: fillEn(line.en) };
}


// ---------------------------------------------------------------------------
// 🤝 取引 ── 20分地点の60秒
// ---------------------------------------------------------------------------
//
// ゼロが2択を出し、**あなたと、いまオンラインの住人全員が本当に投票する**。
// 投票のクセ（同調・逆張り・ギルド連帯・締切間際の鞍替え）は polls.js の
// residentChoice がすでに全部持っているので、そのまま使う。
// だから毎回結果が違う。
//
// なぜこれを切らないか:
// 台詞は必ず尽きる。250行書いても3回目には読まれる。取引は「毎週書き換える
// 2択」だけで展開が自動で変わるので、賞味期限を延ばすのはここしかない。
//
// 人間の1票 ＝ 住人5票ぶん。ソロなら「あなた5票 対 住人14票」。
// あなた1人では決まらないが、住人の票が割れれば**あなたが決定打になる**。
export const HUMAN_VOTE_WEIGHT = 5;
// 枠の20分地点。動作確認のときだけ ZERO_DEAL_AT で早められる
// （20分待たないと一度も見られないので、確認の手が止まる）。
export const DEAL_AT_SEC = Number(process.env.ZERO_DEAL_AT) > 0
  ? Number(process.env.ZERO_DEAL_AT) : 20 * 60;
export const DEAL_SEC = 60;

// 毎週差し替える想定。効果は「代償つきの得」で統一する ——
// ただ得なだけの選択肢は、選んで終わりで見世物にならない。
export const DEALS = [
  {
    id: 'halve',
    q: 'この段のHPを半分にしてやる。かわりに、残り時間は断罪の予告を1秒縮める',
    qEn: 'I will halve this stage. In exchange, your warning shrinks by one second.',
    yes: { text: '飲む', textEn: 'Take it' },
    no: { text: '断る', textEn: 'Refuse' },
    apply: run => { run.dealHalve = true; run.dealWarnCut = 1000; },
  },
  {
    id: 'revive',
    q: '処刑した住人を全員、席に戻してやる。かわりに、この段の封印を4割に上げる',
    qEn: 'I will return everyone I executed. In exchange, this stage’s seal rises to 40%.',
    yes: { text: '飲む', textEn: 'Take it' },
    no: { text: '断る', textEn: 'Refuse' },
    apply: run => { run.dealRevive = true; run.dealSeal = 0.40; },
  },
  {
    id: 'markall',
    q: '今夜の的を八列すべてにしてやる。どの列を縦に消しても杭が入る。かわりに、必要な杭を三本から五本に増やす',
    qEn: 'I will mark all eight columns — any column you clear vertically drives a stake. In exchange, you will need five stakes instead of three.',
    yes: { text: '飲む', textEn: 'Take it' },
    no: { text: '断る', textEn: 'Refuse' },
    // 得も代償も、書いたとおりに効かせる。以前は代償が既定値と同じ 3 で
    // 完全な無効果、得のほうは「的が無くなる」になっていて、
    // 読むと得に見えるのに実際は純粋な損、という状態だった。
    apply: run => { run.dealMarkAll = true; run.dealStakeCost = 5; },
  },
];

export function dealForDay(dayKey) {
  let h = 0;
  for (const ch of String(dayKey)) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return DEALS[h % DEALS.length];
}

// 取引の投票箱。polls.js の residentChoice にそのまま渡せる形にしておく。
export function makeDeal(dayKey, danIndex, now) {
  const d = dealForDay(dayKey);
  return {
    id: `zero-deal-${dayKey}-${danIndex}`,
    kind: 'zero',
    dealId: d.id,
    q: d.q, qEn: d.qEn,
    options: [
      { id: 'yes', text: d.yes.text, textEn: d.yes.textEn, votes: 0 },
      { id: 'no', text: d.no.text, textEn: d.no.textEn, votes: 0 },
    ],
    opensAt: now,
    closesAt: now + DEAL_SEC * 1000,
    humanVotes: {},        // userId -> 'yes' | 'no'
    residentVoted: {},     // residentId -> true
    settled: false,
  };
}

export function dealTally(deal) {
  const out = { yes: 0, no: 0 };
  for (const o of deal.options) out[o.id] = o.votes;
  for (const v of Object.values(deal.humanVotes)) out[v] += HUMAN_VOTE_WEIGHT;
  return out;
}

export function dealWinner(deal) {
  const t = dealTally(deal);
  // 同数は「断る」。ゼロの申し出は、押し切られない限り通らない。
  return t.yes > t.no ? 'yes' : 'no';
}

// 段が変わったら取引の効果は切れる（1段ぶんの取引なので）
export function clearDealEffects(run) {
  delete run.dealHalve; delete run.dealWarnCut; delete run.dealRevive;
  delete run.dealSeal; delete run.dealMarkAll; delete run.dealStakeCost;
}

// ---------------------------------------------------------------------------
// 断罪の的
// ---------------------------------------------------------------------------
//
// 盤面の空きマスから赤マスを選ぶ。うち1つが金（急所）。
// 「今夜の的」に指定された列には6割を寄せる ── ここが効く。
// 特定の1列を縦に消すのは点効率が悪いので、
// 「点を稼ぐ置き方」と「斬りやすくする置き方」が同じ手番の中で衝突する。

export const SIZE = 8;

export function pickVerdictCells(grid, danIndex, targetCol, rnd = Math.random) {
  const d = danAt(danIndex);
  const empty = [];
  for (let i = 0; i < SIZE * SIZE; i++) if (!grid || !grid[i]) empty.push(i);
  if (!empty.length) return { cells: [], keystone: -1 };

  const inTarget = empty.filter(i => (i % SIZE) === targetCol);
  const others = empty.filter(i => (i % SIZE) !== targetCol);
  const want = Math.min(d.cells, empty.length);
  const wantTarget = Math.min(inTarget.length, Math.round(want * 0.6));

  const take = (arr, n) => {
    const pool = arr.slice();
    const out = [];
    while (out.length < n && pool.length) {
      out.push(pool.splice(Math.floor(rnd() * pool.length), 1)[0]);
    }
    return out;
  };
  const cells = [...take(inTarget, wantTarget), ...take(others, want - wantTarget)];
  const keystone = cells.length ? cells[Math.floor(rnd() * cells.length)] : -1;
  return { cells, keystone };
}

// 申告されたカットが成立するか。
// 人間の盤面はサーバーが持っていないので判定はクライアント申告になるが、
// 構造的な安全弁がある: 斬れる回数は断罪の発生回数（＝経過時間）で決まり、
// 1回の貫通量にも上限がある。つまり申告できる最大値が時間で頭打ちになる。
// そのうえで「発生から予告時間内に届いたものだけ」を受け付ける。
export function verdictAccepts(verdict, now, clearedCells) {
  if (!verdict || verdict.resolved) return { ok: false, why: 'no-verdict' };
  if (now > verdict.at + verdict.warnMs) return { ok: false, why: 'too-late' };
  if (!Array.isArray(clearedCells) || !clearedCells.length) return { ok: false, why: 'no-cells' };
  const hit = new Set(clearedCells.map(n => n | 0));
  const covered = verdict.cells.filter(c => hit.has(c));
  if (!covered.length) return { ok: false, why: 'missed' };
  return { ok: true, keystone: hit.has(verdict.keystone) };
}
