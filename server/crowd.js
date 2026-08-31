// Crowd content: what residents say and do.
//
// Everything here is a pure function of (resident, world context, rng). The
// director in battle.js decides *when* to speak; this module decides *what*.
//
// ctx = {
//   now, hour (JST), period ('morning'|'day'|'evening'|'night'|'late'),
//   weekend, mondayish, event (live event or null), poll (open poll or null),
//   active (residents online now), humans (real player names online),
// }

import { residentStats, archetype, tierOf, jstHour, jstWeekday } from './residents.js';
import { SHOP_ITEMS, BOSSES, RAID_BOSSES, TITLES } from './catalog.js';
import { enName } from '../public/js/catalog-en.js';
import { ACHIEVEMENTS } from './achievements.js';
// チャット3.0 (v2.6): 再出防止メモリ + 話題スレッド + 生成合成エンジン
import * as gen from './chatgen.js';
import { OPENERS, TAILS, FOLLOWS, TOPICS, LIFE, REPLY_EXP, NEWMODE_LINES, NEWMODE_DIALOGUES, NEWMODE_FEED } from './chatgen-content.js';

// ---------------------------------------------------------------------------
// Vocabulary
// ---------------------------------------------------------------------------

export const MODE_NAMES = {
  solo:     ['ソロ', 'solo'],
  ai:       ['AI戦', 'VS AI'],
  pvp:      ['ランクマ', 'ranked'],
  team:     ['チーム戦', 'team battle'],
  tourney:  ['トーナメント', 'the tournament'],
  royale:   ['バトロワ', 'battle royale'],
  raid:     ['レイド', 'the raid'],
  coop:     ['協力プレイ', 'co-op'],
  boss:     ['ボス戦', 'boss battle'],
  dungeon:  ['ダンジョン', 'the dungeon'],
  weekly:   ['ウィークリー', 'the weekly'],
  sprint:   ['タイムアタック', 'time attack'],
  survival: ['サバイバル', 'survival'],
  chaos:    ['カオス', 'chaos mode'],
  gacha:    ['ガチャ', 'gacha'],
  meltdown: ['メルトダウン', 'meltdown'],
  chimera:  ['キメラ工房', 'the chimera lab'],
  puzzle:   ['パズル遺跡', 'the puzzle ruins'],
  dig:      ['採掘場', 'the mines'],
  // 第3波の3モード。👻幽霊屋敷は隠しモードなので、ここには意図的に載せない
  // （住人が名前を口にした時点で「隠し」ではなくなる）。
  chain:     ['連鎖カスケード', 'chain cascade'],
  blueprint: ['ブループリント', 'the blueprint'],
  workshop:  ['パズル工房', 'the workshop'],
};

const AI_LABELS = [['見習い', 'Apprentice'], ['戦士', 'Warrior'], ['達人', 'Master'], ['鬼', 'Oni']];

export function periodOf(hour) {
  return hour < 5 ? 'late' : hour < 10 ? 'morning' : hour < 17 ? 'day' : hour < 22 ? 'evening' : 'night';
}

export function buildCtx(base) {
  const now = base.now || Date.now();
  const hour = jstHour(now);
  const wd = jstWeekday(now);
  return {
    now, hour, period: periodOf(hour),
    weekend: wd === 0 || wd === 6,
    friday: wd === 5 && hour >= 17,
    mondayish: (wd === 1 && hour < 12) || (wd === 0 && hour >= 21),
    event: base.event || null,
    poll: base.poll || null,
    // 🏷️ 日替わりピックアップショップのセール情報（index.js → ambient.js 経由）。
    // 未供給なら null のまま = セール系のセリフは一切出ない（安全側に倒す）。
    sale: base.sale || null,
    thrones: base.thrones || [],   // 👑 王座保持者の名前（住人含む）
    active: base.active || [],
    humans: base.humans || [],
  };
}

// ---------------------------------------------------------------------------
// Slot filling + typing quirks
// ---------------------------------------------------------------------------

const rnd = () => Math.random();
const pick = arr => arr[Math.floor(Math.random() * arr.length)];
const rint = (a, b) => a + Math.floor(Math.random() * (b - a + 1));

// 名前ではなくカタログの項目そのものを返す。英語面の描画で id から英語名を
// 引けるようにするため（以前は日本語名がそのまま英文に挿さっていた）。
// throneOnly（王座の欠片専用）と gachaOnly（ガチャ限定）は除外する。前者は
// コイン・ジェム・ガチャのどれでも手に入らない世界進捗報酬なので「買った/引いた」
// と言わせると設定が壊れ、未解放段の品名ネタバレにもなる。後者は名前に【ガチャ限定】
// が付くので「買った」系の文面と矛盾する。index.js のガチャ抽選フィルタと同型。
function cosmeticItem() {
  const pool = SHOP_ITEMS.filter(i => !i.default && !i.adminOnly && !i.throneOnly && !i.gachaOnly && i.cat !== 'ult');
  return pick(pool);
}

// 🏷️ セール対象の品を {saleitem} に流し込む。ctx.sale は
//   [id, ...] / { items: [id|item, ...] } / { item: id|item } のどれでも受ける。
// 文字列 id は SHOP_ITEMS から引き直し、throneOnly / gachaOnly / adminOnly は
// cosmeticItem と同じ理由で除外する（買えない品を「買った」と言わせない）。
// セール情報がまだ供給されていない環境では通常のショップ品にフォールバックする
// ので、文面が壊れることはない。
function saleItem(ctx) {
  const sale = ctx && ctx.sale;
  const raw = !sale ? []
    : Array.isArray(sale) ? sale
    : Array.isArray(sale.items) ? sale.items
    : sale.item ? [sale.item] : [];
  const items = raw
    .map(x => (x && typeof x === 'object')
      ? (x.id ? (SHOP_ITEMS.find(i => i.id === x.id) || x) : x)
      : SHOP_ITEMS.find(i => i.id === x))
    .filter(i => i && i.name && !i.throneOnly && !i.gachaOnly && !i.adminOnly);
  return items.length ? pick(items) : cosmeticItem();
}

// 住人が正当に持ちうる称号だけを {title} スロットに使う。residentStats(r).title と
// 同じ分岐（residents.js:317-326）に現れる id 群。towerlord「百塔の覇者」は
// dungeonMax≤99 のクランプで到達不能なので入れない（「頂は人間に残す」不変条件）。
const RESIDENT_TITLE_IDS = new Set(['kamislayer', 'tourneyking', 'onislayer', 'diamond', 'rate1200', 'score100k', 'veteran', 'addict', 'rookie']);
const RESIDENT_TITLES = TITLES.filter(t => RESIDENT_TITLE_IDS.has(t.id));

// 人間だけの頂点を主張する実績は {ach} スロットから除外する（F100制覇・深淵A100
// 制覇・創造神撃破）。住人の dungeonMax は99止まりで、residentStats はこれらの
// バッジを持たせない — 称号 towerlord を外したのと同じ不変条件。
const ACH_HUMAN_ONLY = new Set(['ach_dun100', 'ach_abyss100', 'ach_souzou']);
const RESIDENT_ACHIEVEMENTS = ACHIEVEMENTS.filter(a => !ACH_HUMAN_ONLY.has(a.id));

// Slots resolve to a language-neutral value first, then render per language.
// A shared `cache` keeps both translations of one line in agreement (the
// "7-win streak" must be 7 in Japanese too).
function resolveSlot(key, r, ctx, extra, cache) {
  if (extra[key] !== undefined) return extra[key];
  if (cache && cache[key] !== undefined) return cache[key];
  const st = r ? residentStats(r, ctx.now) : null;
  let v;
  switch (key) {
    case 'me': v = r ? r.name : ''; break;
    case 'mode': v = (r && r.favMode) || 'solo'; break;
    case 'mode2': v = r ? pick(r.modes) : 'solo'; break;
    // 99止まり: 塔100F制覇は人間だけのもの（residents.js:296 の dungeonMax クランプに揃える）。
    case 'floor': v = Math.max(2, Math.min(99, (st ? st.dungeonMax : 20) + rint(-6, 3))); break;
    case 'rating': v = st ? st.rating : 1000; break;
    case 'level': v = st ? st.level : 5; break;
    case 'tier': v = st ? st.tier : tierOf(1000); break;
    case 'n': v = rint(2, 9); break;
    // WAVE も99止まりに揃える（residents.js:347 の survivalWave クランプと同じ）。
    case 'wave': v = st ? Math.max(3, Math.min(99, st.survivalWave + rint(-3, 2))) : 8; break;
    case 'combo': v = r ? Math.max(3, Math.round(3 + r.skill * 12 + rint(-1, 1))) : 6; break;
    // 自慢する点数はランキングの自己ベスト（residentStats）から出す。
    // skill から別式で作ると、住人強化のたびに「チャットでは6万点なのに
    // ランキングでは70万点」という嘘つきが生まれる。ベスト近辺の値にする。
    case 'score': v = st ? Math.max(1500, Math.round(st.bestScore * (86 + rint(0, 14)) / 10000) * 100 + rint(0, 9) * 10) : 12000; break;
    case 'sprint': v = st ? Math.max(800, Math.round(st.sprintBest * (85 + rint(0, 15)) / 10000) * 100) : 6000; break;
    case 'event': v = ctx.event || null; break;   // オブジェクトごと保持し言語別に描画
    case 'ai': v = r ? Math.min(3, Math.floor(r.skill * 4.2)) : 1; break;
    case 'name': {
      const others = (ctx.active || []).filter(x => !r || x.id !== r.id);
      v = others.length ? pick(others).name : null;
      break;
    }
    case 'you': v = null; break;
    case 'opt': v = ctx.poll && ctx.poll.options && ctx.poll.options.length ? pick(ctx.poll.options) : ''; break;   // オブジェクトごと保持し言語別に描画
    case 'winner': v = ''; break;
    case 'item': v = cosmeticItem(); break;      // オブジェクトごと保持し言語別に描画
    case 'saleitem': v = saleItem(ctx); break;   // 同上（セール対象があればそれ）
    case 'boss': v = pick(BOSSES); break;         // 同上
    // プロフィールの称号を優先し、無ければ住人が正当に持ちうる称号だけから引く。
    // TITLES 全体から引くと towerlord「百塔の覇者」等をフィードで名乗り、プロフィール
    // （residentStats）と食い違う（「頂は人間に残す」不変条件を破る）。
    case 'title': v = (st && st.title) || pick(RESIDENT_TITLES); break;   // オブジェクトごと保持し言語別に描画
    case 'ach': v = pick(RESIDENT_ACHIEVEMENTS); break;
    case 'question': v = ctx.poll || ''; break;   // pollオブジェクトごと保持し言語別に描画
    // v2.6 新モードの進行度 — 塔の進みからそれっぽい数字を出す
    case 'depth': v = Math.max(3, Math.round(((st ? st.dungeonMax : 20) || 8) * 0.75) + rint(-4, 3)); break;
    case 'stage': v = Math.max(1, Math.round(((st ? st.dungeonMax : 15) || 8) * 0.55) + rint(-3, 2)); break;
    default: v = '';
  }
  if (cache) cache[key] = v;
  return v;
}

function renderSlot(key, v, lang) {
  const L = lang === 'en' ? 1 : 0;
  switch (key) {
    case 'mode': case 'mode2': return MODE_NAMES[v] ? MODE_NAMES[v][L] : String(v);
    case 'tier': return v && typeof v === 'object' ? (L ? v.nameEn : v.name) : String(v);
    case 'ai': return typeof v === 'number' ? AI_LABELS[v][L] : String(v);
    // extra からは整形済み文字列（'12,000'）が来ることがある — Number() に
    // 通すと NaN になるので、数値のときだけフォーマットする。
    case 'score': case 'sprint': return typeof v === 'number' ? v.toLocaleString('en-US') : String(v);
    case 'event': return v === null ? (L ? 'the event' : 'イベント')
      : typeof v === 'object' ? (L ? (v.nameEn || v.name) : v.name) : String(v);
    case 'name': return v === null ? (L ? 'someone' : '誰か') : String(v);
    // 投票の選択肢/勝者/質問文: オブジェクトなら textEn/questionEn を英語面に使う
    case 'opt': case 'winner': return v && typeof v === 'object' ? String((L && v.textEn) || v.text || '') : String(v == null ? '' : v);
    case 'question': return v && typeof v === 'object' ? String((L && v.questionEn) || v.question || '') : String(v == null ? '' : v);
    case 'you': return v === null ? (L ? 'you' : 'きみ') : String(v);
    case 'ach': return v && typeof v === 'object' ? (L ? v.nameEn : v.name) : String(v);
    // 王座のボード名とバッジ名。ここを通していなかったので、英語のセリフに
    // 日本語がそのまま挿さっていた（"gz on 鬼討伐バッジ, Bob!"）。
    // 文字列で渡された場合は従来どおり — 呼び出し側の移行を壊さない。
    // ショップ品・ボス・称号。BOSSES は nameEn を持ち、ショップ/称号は
    // catalog-en.js が id で英語名を持つ。どちらも無ければ日本語のまま。
    case 'item': case 'saleitem': case 'boss': case 'title':
      if (!v || typeof v !== 'object') return String(v == null ? '' : v);
      return L ? String(v.nameEn || enName(v)) : String(v.name || '');
    case 'board': case 'badge':
      return v && typeof v === 'object' ? String((L && v.nameEn) || v.name || '') : String(v == null ? '' : v);
    default: return v === null || v === undefined ? '' : String(v);
  }
}

export function fill(tpl, r, ctx, extra = {}, cache = null) {
  const lang = r ? r.lang : 'ja';
  return String(tpl).replace(/\{(\w+)\}/g, (_, k) => renderSlot(k, resolveSlot(k, r, ctx, extra, cache), lang));
}

const EMOJI = ['🔥', '😂', '🎉', '👍', '😭', '💪', '✨', '😎', '🙌', '😱', '🤔', '💎'];

// Make the line sound like *this* resident.
export function stylize(text, r) {
  if (!r) return text;
  let s = text;
  const endsPunct = /[！!？?…〜～wｗ笑]$|[\u{1F300}-\u{1FAFF}]$/u.test(s);
  switch (r.quirk) {
    case 'w':      if (!endsPunct && rnd() < 0.45) s += rnd() < 0.5 ? 'w' : 'ww'; break;
    case 'bang':   if (!/[！!]$/.test(s) && rnd() < 0.7) s += rnd() < 0.5 ? '！' : '！！'; break;
    case 'dots':   if (!endsPunct && rnd() < 0.4) s += '…'; break;
    case 'tilde':  if (!endsPunct && rnd() < 0.5) s += '〜'; break;
    case 'excite': if (!/[！!]$/.test(s) && rnd() < 0.5) s += rnd() < 0.5 ? '！！' : '!!!'; break;
    case 'terse':  s = s.replace(/[！!]+$/, ''); break;
    case 'lol':    if (r.lang === 'en' && !endsPunct && rnd() < 0.35) s += rnd() < 0.5 ? ' lol' : ' haha'; break;
    case 'polite': break;
  }
  // Emoji sparingly — a lobby where every line ends in 😂 reads as fake.
  if (!/[\u{1F300}-\u{1FAFF}]$/u.test(s) && rnd() < r.emoji * 0.55) s += ' ' + pick(EMOJI);
  return s;
}

// ---------------------------------------------------------------------------
// Single lines
// ---------------------------------------------------------------------------
// { ja, en?, arch?: [ids], not?: [ids], ctx?: key, w?: weight }
// ctx keys: morning | day | evening | night | late | weekend | friday |
//           mondayish | event | poll | noevent

const LINES = [
  // --- greetings / time of day ---
  { ja: 'おはようございます！', en: 'morning everyone!', ctx: 'morning', w: 3 },
  { ja: '朝からブロック積んでる', en: 'blocks before breakfast', ctx: 'morning' },
  { ja: '通勤前に1戦だけ', en: 'one game before the commute', ctx: 'morning', not: ['kid'] },
  { ja: '朝ウィークリー消化した', en: 'did the weekly first thing this morning', ctx: 'morning' },
  { ja: 'こんにちは〜', en: 'hi all', ctx: 'day', w: 2 },
  { ja: '昼休みブロック', en: 'lunch break blocks', ctx: 'day', not: ['kid'] },
  { ja: '学校終わった！やるぞ！', en: 'school\'s out! let\'s go!', ctx: 'day', arch: ['kid'] },
  { ja: 'こんばんは！', en: 'evening!', ctx: 'evening', w: 3 },
  { ja: 'ただいま〜', en: 'I\'m home~', ctx: 'evening' },
  { ja: 'ごはん食べたら{mode}やる', en: 'dinner first, then {mode}', ctx: 'evening' },
  { ja: '深夜組いる？', en: 'night crew here?', ctx: 'night', w: 2 },
  { ja: 'あと1戦だけ…', en: 'one more game…', ctx: 'night', w: 2 },
  { ja: 'こんな時間まで誰がいるのw', en: 'who else is still up at this hour lol', ctx: 'late' },
  { ja: '眠れないからブロック', en: "can't sleep so… blocks", ctx: 'late' },
  { ja: '深夜テンションで{mode}', en: '{mode} on pure 3am energy', ctx: 'late', arch: ['nightowl', 'tryhard'] },
  { ja: 'おやすみ〜', en: 'good night all', ctx: 'night', w: 2 },
  { ja: '寝落ちしそう', en: 'about to fall asleep on the board', ctx: 'late' },
  { ja: '週末だ！ガチる！', en: 'it\'s the weekend! time to lock in!', ctx: 'weekend', arch: ['tryhard', 'casual', 'explorer'] },
  { ja: '休日ブロック最高', en: 'blocks on a day off, unbeatable', ctx: 'weekend' },
  { ja: '花金！今日は遅くまでやる', en: 'friday night, staying up late for this', ctx: 'friday', not: ['kid'] },
  { ja: 'ウィークリー更新きたね', en: 'the weekly just reset', ctx: 'mondayish', w: 2 },
  { ja: '今週のウィークリーむずくない？', en: 'this week\'s weekly is rough, right?', ctx: 'mondayish' },
  { ja: '月曜つらい…ブロックで癒される', en: 'mondays are rough… blocks are therapy', ctx: 'mondayish', not: ['kid'] },

  // --- generic play chatter ---
  { ja: '誰か対戦しよ！', en: 'anyone up for a match?', w: 2, arch: ['tryhard', 'casual', 'kid', 'senpai', 'global'] },
  { ja: '1v1こない？', en: '1v1 anyone?', arch: ['tryhard', 'nightowl', 'global'] },
  { ja: 'gg', en: 'gg', w: 3 },
  { ja: 'ggでした！', en: 'ggwp', w: 2 },
  { ja: 'さっきの人強かった…', en: 'that last opponent was cracked', w: 2 },
  { ja: 'リベンジさせて！', en: 'give me a rematch!', arch: ['tryhard', 'kid', 'casual'] },
  { ja: '自己ベスト更新！{score}点！', en: 'new best score! {score}!', w: 2 },
  { ja: 'コンボ{combo}いった！', en: 'just hit a {combo} combo!', w: 2 },
  { ja: 'コンボ切れた瞬間の絶望感', en: 'nothing hurts like losing a combo' },
  { ja: '2連続全消しキタ━━━', en: 'TWO full clears back to back!!!', arch: ['casual', 'kid', 'gacha', 'streamer'] },
  { ja: 'あと1マスで全消しだった…', en: 'ONE cell away from a full clear…' },
  { ja: '3x3ブロック来なさすぎ', en: 'where are my 3x3 blocks' },
  { ja: '角を空けるの大事だね', en: 'keeping the corners open really matters', arch: ['senpai', 'tryhard', 'explorer'] },
  { ja: '縦消し派？横消し派？', en: 'team vertical clears or team horizontal?', arch: ['casual', 'senpai'] },
  { ja: 'ブロック綺麗に消えると気持ちいい', en: 'clean line clears are so satisfying' },
  { ja: '今日は{mode}やりこむ', en: 'grinding {mode} today', w: 2 },
  { ja: '{mode}と{mode2}どっちやろ', en: '{mode} or {mode2}, which one?', arch: ['casual', 'explorer'] },
  { ja: 'レート{rating}まで来た', en: 'up to {rating} rating', arch: ['tryhard', 'nightowl', 'senpai', 'global'] },
  { ja: '{tier}帯から抜け出せない…', en: 'stuck in {tier} forever', arch: ['casual', 'newbie', 'nightowl', 'global'] },
  { ja: '{tier}に上がった！', en: 'promoted to {tier}!', arch: ['tryhard', 'casual', 'nightowl'] },
  { ja: '連勝中🔥', en: 'on a win streak 🔥', arch: ['tryhard', 'streamer', 'nightowl'] },
  { ja: '5連敗つらい', en: 'lost 5 in a row… pain', arch: ['casual', 'newbie', 'kid'] },
  { ja: 'レートまた溶けた', en: 'watched my rating melt again', arch: ['tryhard', 'nightowl'] },
  { ja: '連勝ボーナスおいしい', en: 'the win streak bonus is tasty', arch: ['tryhard', 'casual'] },
  { ja: 'ランキング入りたい', en: 'I want to make the leaderboard', arch: ['casual', 'newbie', 'kid'] },
  { ja: '今週こそランキング入る', en: 'this is the week I make the leaderboard', arch: ['casual', 'explorer'] },

  // --- modes ---
  { ja: 'ダンジョン{floor}Fで全滅した…', en: 'wiped on dungeon F{floor}…', arch: ['explorer', 'casual', 'newbie', 'nightowl'], w: 2 },
  { ja: 'ダンジョンのボス強すぎw', en: 'the dungeon boss is brutal', arch: ['explorer', 'casual', 'kid'] },
  { ja: '{floor}F到達！', en: 'reached F{floor}!', arch: ['explorer', 'tryhard'] },
  { ja: '地下ダンジョン怖すぎw', en: 'the basement dungeon is way too creepy lol', arch: ['explorer', 'casual', 'kid'] },
  { ja: '天界ダンジョン綺麗すぎて泣いた', en: 'the heaven dungeon is gorgeous', arch: ['explorer', 'casual'] },
  { ja: 'シールドの強化ほんと強い', en: 'the shield upgrade is genuinely strong', arch: ['explorer', 'senpai'] },
  { ja: 'サバイバルWAVE{wave}まで行った', en: 'made it to wave {wave} in survival', arch: ['explorer', 'nightowl', 'casual'] },
  { ja: 'サバイバルの加速えぐい', en: 'survival mode goes so fast', arch: ['casual', 'explorer'] },
  { ja: 'ボスラッシュ2体目で死んだ', en: 'died to the second boss in boss rush', arch: ['explorer', 'casual'] },
  { ja: 'レイドボス硬すぎない？', en: 'the raid boss is a tank', arch: ['explorer', 'casual', 'senpai'] },
  { ja: 'レイド行く人いる？', en: 'anyone for a raid?', arch: ['explorer', 'senpai', 'casual'] },
  { ja: '魔王まで倒した！', en: 'took down the demon king!', arch: ['explorer', 'tryhard', 'kid'] },
  { ja: 'トーナメント優勝したった！！', en: 'won the tournament!!', arch: ['tryhard', 'streamer'], w: 0.6 },
  { ja: 'トーナメント決勝で負けた…悔しい', en: 'lost the tourney final… so close', arch: ['tryhard', 'nightowl'] },
  { ja: 'バトロワ上位入った！', en: 'top 5 in battle royale!', arch: ['streamer', 'tryhard', 'nightowl'] },
  { ja: 'バトロワ最初の足切りで消えた', en: 'gone in the very first royale cut', arch: ['casual', 'newbie', 'kid'] },
  { ja: 'タイムアタック60秒で{sprint}点', en: '{sprint} in the 60s time attack', arch: ['tryhard', 'morning', 'lurker', 'global'] },
  { ja: 'タイムアタック中毒になりそう', en: 'time attack is too addicting', arch: ['morning', 'casual'] },
  { ja: '協力プレイたのしい！相棒ありがとう', en: 'co-op is so fun, ty partner', arch: ['casual', 'kid', 'senpai', 'global'] },
  { ja: '協力で相棒が置いたピースで全消しした', en: 'my co-op partner\'s piece set up my full clear', arch: ['casual', 'senpai'] },
  { ja: '協力プレイで相棒落ちたけどサーバーが代打してくれた', en: 'my co-op partner dropped and the server subbed in for them', arch: ['casual', 'explorer'] },
  { ja: '2v2誰か組も！', en: '2v2 anyone?', arch: ['casual', 'tryhard', 'kid'] },
  { ja: 'チーム戦たのしい', en: 'team battles are fun', arch: ['casual', 'kid'] },
  { ja: 'カオスモードまたやりたい', en: 'I want chaos mode back already', arch: ['casual', 'gacha', 'streamer'], ctx: 'noevent' },
  { ja: 'ウィークリー3位まで来た！', en: 'up to 3rd on the weekly!', arch: ['tryhard', 'morning'] },
  { ja: 'ウィークリーはピース運ゲーすぎるw', en: 'the weekly is way too much piece luck lol', arch: ['casual', 'morning', 'lurker'] },
  { ja: '鬼AIに勝てた！', en: 'finally beat the Oni AI!', arch: ['tryhard', 'explorer', 'nightowl'] },
  { ja: '{ai}AIとちょうどいい勝負になる', en: 'the {ai} AI is exactly my level', arch: ['casual', 'newbie'] },
  { ja: '神って隠し難易度あるらしいよ', en: 'word is there\'s a hidden God difficulty', arch: ['streamer', 'casual', 'nightowl'], w: 0.6 },

  // --- ultimates / items / shop / gacha ---
  { ja: '奥義ゲージ溜まった瞬間が一番楽しい', en: 'charging the ultimate gauge is the best part', w: 2 },
  { ja: '神の裁きで盤面消えるの爽快すぎ', en: 'divine judgement wiping the board is so satisfying', arch: ['tryhard', 'streamer', 'gacha'] },
  { ja: 'オーバードライブ中にコンボつなぐと化ける', en: 'chaining combos during overdrive is unreal', arch: ['tryhard', 'senpai'] },
  { ja: 'レインボーハンド神', en: 'rainbow hand is goated', arch: ['casual', 'newbie', 'kid'] },
  { ja: '奥義どれ装備してる？', en: 'which ultimate are you running?', arch: ['casual', 'newbie', 'global'] },
  { ja: '時間停止でボス封じるの強い', en: 'freezing a boss with time stop is so strong', arch: ['explorer', 'senpai'] },
  { ja: 'ミニブロック神アイテムすぎる', en: 'mini blocks are an absurdly good item', arch: ['casual', 'explorer'] },
  { ja: 'フィーバー強すぎw', en: 'fever mode is too strong lol', arch: ['casual', 'kid'] },
  { ja: 'ボム使うタイミングむずい', en: 'timing the bomb is the hard part', arch: ['newbie', 'casual'] },
  { ja: 'ガチャSSR出たあああ', en: 'SSR from the gacha!!!', arch: ['gacha', 'casual', 'kid'], w: 2 },
  { ja: 'ガチャ爆死した😭', en: 'gacha ate all my coins 😭', arch: ['gacha', 'casual'], w: 2 },
  { ja: '10連で{item}出た！', en: 'pulled {item} on a 10-pull!', arch: ['gacha', 'casual'] },
  { ja: 'UR引いた人見たことない', en: 'I\'ve never seen anyone actually pull a UR', arch: ['gacha'] },
  { ja: 'コイン貯めては溶かしてる', en: 'I save coins just to melt them again', arch: ['gacha'] },
  { ja: '{item}買った！かっこいい', en: 'bought {item}, looks great', arch: ['casual', 'gacha', 'kid'] },
  { ja: 'スキン何使ってる？', en: 'what skin are you all using?', arch: ['casual', 'newbie', 'gacha'] },
  { ja: '雪のステージ癒される', en: 'the snow stage is so relaxing', arch: ['casual', 'morning'] },
  { ja: 'エフェクトかっこいい', en: 'the clear effects are so cool', arch: ['newbie', 'kid', 'casual'] },
  { ja: 'BGMすき', en: 'love the music in this game', arch: ['casual', 'morning', 'global'] },
  { ja: 'バトルパス何ティアまでいった？', en: 'what tier are you on the battle pass?', arch: ['casual', 'gacha'] },
  { ja: '称号かっこいいのほしい', en: 'I want a cool title', arch: ['casual', 'kid'] },
  { ja: 'ミッション全部終わった！', en: 'finished all my missions!', w: 2 },
  { ja: 'デイリーミッションのボーナスおいしい', en: 'the daily mission bonus is great value', arch: ['casual', 'gacha', 'morning'] },
  { ja: '実績「{ach}」解除した', en: 'unlocked "{ach}"', w: 1.5 },
  { ja: '実績まとめて受け取ったらコインえぐい増えた', en: 'claimed every achievement at once and the coins went wild', arch: ['casual', 'gacha'] },
  { ja: '連続ログイン{n}日目', en: 'day {n} login streak', arch: ['morning', 'casual', 'lurker'] },
  { ja: '戦績ダッシュボードのグラフ見るの楽しい', en: 'the stats dashboard graphs are weirdly fun to stare at', arch: ['tryhard', 'lurker', 'morning'] },

  // --- newbie / kid / senpai flavor ---
  { ja: '今日から始めました！', en: 'just started today!', arch: ['newbie'], w: 2 },
  { ja: 'はじめて10分の初心者です', en: 'ten minutes in, complete beginner here', arch: ['newbie'] },
  { ja: '初心者におすすめの立ち回りある？', en: 'any tips for a beginner?', arch: ['newbie'] },
  { ja: '効率いいコイン稼ぎ教えて', en: 'teach me the efficient way to farm coins', arch: ['newbie', 'kid'] },
  { ja: 'リロールって1回しか使えないの？', en: 'can you really only reroll once?', arch: ['newbie'] },
  { ja: '奥義ってどうやって撃つの？', en: 'how do you even fire the ultimate?', arch: ['newbie', 'kid'] },
  { ja: 'やっとLv{level}になった', en: 'hit level {level}', arch: ['newbie', 'casual'] },
  { ja: 'ぼくがいちばんつよい！', en: 'I\'m the strongest here!', arch: ['kid'] },
  { ja: 'ママにあと10分って言われた', en: 'mom says ten more minutes', arch: ['kid'] },
  { ja: '宿題おわったからやる！', en: 'homework\'s done so I\'m playing!', arch: ['kid'], ctx: 'evening' },
  { ja: 'ボスたおした！！', en: 'I beat the boss!!', arch: ['kid'] },
  { ja: '初心者さんいたら教えるよ〜', en: 'any beginners around? happy to help~', arch: ['senpai'] },
  { ja: '角から埋めると詰みにくいよ', en: 'fill from the corners and you brick less', arch: ['senpai'] },
  { ja: 'わからんことあったら聞いてね', en: 'ask me anything if you get stuck', arch: ['senpai'] },
  { ja: '今日も平和ですね', en: 'another peaceful day around here', arch: ['senpai', 'lurker', 'morning'] },
  { ja: '配信中！来てね', en: 'live right now! come hang out', arch: ['streamer'], w: 0.7 },
  { ja: '今日の配信はバトロワ縛り', en: 'today\'s stream is battle royale only', arch: ['streamer'], w: 0.5 },
  { ja: '見てる人ありがとう〜', en: 'thanks to everyone watching~', arch: ['streamer'], w: 0.5 },
  { ja: '…', en: '…', arch: ['lurker'], w: 0.5 },
  { ja: 'ROM専だけど今日は挨拶だけ', en: 'usually just lurking, but hi for once', arch: ['lurker'], w: 0.5 },

  // --- international (en-only residents) ---
  { ja: 'hi everyone!', en: 'hi everyone!', arch: ['global'] },
  { ja: 'greetings from overseas!', en: 'greetings from overseas!', arch: ['global'] },
  { ja: 'this game is addicting lol', en: 'this game is addicting lol', arch: ['global'] },
  { ja: 'how do I get more coins?', en: 'how do I get more coins?', arch: ['global'] },
  { ja: 'what time is it in Japan right now?', en: 'what time is it in Japan right now?', arch: ['global'] },
  { ja: 'the dungeon gets rough after 40F', en: 'the dungeon gets rough after 40F', arch: ['global'] },
  { ja: 'anyone in the tourney queue?', en: 'anyone in the tourney queue?', arch: ['global'] },
  { ja: 'the heaven dungeon is beautiful', en: 'the heaven dungeon is beautiful', arch: ['global'] },
  { ja: 'co-op with a random was surprisingly wholesome', en: 'co-op with a random was surprisingly wholesome', arch: ['global'] },

  // --- events / polls (only while live) ---
  { ja: '{event}開催中じゃん！', en: '{event} is on!', ctx: 'event', w: 3 },
  { ja: '{event}のうちに稼ぐぞ', en: 'farming while {event} lasts', ctx: 'event', w: 2 },
  { ja: 'イベント中はみんな集まるね', en: 'everyone shows up for events', ctx: 'event' },
  { ja: 'イベントあと何時間？', en: 'how long is the event on?', ctx: 'event' },
  { ja: '投票した？', en: 'did you vote yet?', ctx: 'poll', w: 2 },
  { ja: '{opt}に入れた', en: 'I voted {opt}', ctx: 'poll', w: 2 },
  { ja: '投票バナー光ってて草', en: 'the poll banner is glowing at me lol', ctx: 'poll' },
  { ja: '「{question}」悩む', en: '"{question}" is a tough one', ctx: 'poll' },
];

const CTX_OK = (line, ctx) => {
  if (!line.ctx) return true;
  switch (line.ctx) {
    case 'event': return !!ctx.event;
    case 'noevent': return !ctx.event;
    case 'sale': return !!ctx.sale;
    case 'poll': return !!ctx.poll;
    case 'weekend': return ctx.weekend;
    case 'friday': return ctx.friday;
    case 'mondayish': return ctx.mondayish;
    default: return line.ctx === ctx.period;
  }
};

function eligibleLines(r, ctx) {
  return LINES.filter(l => {
    if (!CTX_OK(l, ctx)) return false;
    if (r.lang === 'en' && !l.en) return false;
    if (l.arch && !l.arch.includes(r.arch)) return false;
    if (l.not && l.not.includes(r.arch)) return false;
    return true;
  });
}

function weightedLine(lines, r, ctx) {
  const weights = lines.map(l => {
    let w = l.w || 1;
    if (l.arch) w *= 1.8;                       // on-character lines are favoured
    if (l.ctx === 'event' || l.ctx === 'poll') w *= 1.6;
    if (l.ctx && l.ctx === ctx.period) w *= 1.3;
    return w;
  });
  const total = weights.reduce((a, b) => a + b, 0);
  let x = rnd() * total;
  for (let i = 0; i < lines.length; i++) { x -= weights[i]; if (x <= 0) return lines[i]; }
  return lines[lines.length - 1];
}

// ---- チャット3.0: 断片合成 ------------------------------------------------

const archOkFor = r => e => (!e.arch || e.arch.includes(r.arch)) && (!e.not || !e.not.includes(r.arch));

// 性格ごとに好むフォローの種類（先輩は豆知識、キッズは大騒ぎ…）。
const FOLLOW_TASTE = {
  senpai: { tip: 3, agree: 2, relate: 1.5 }, tryhard: { counter: 2.5, tip: 2, relate: 1.5 },
  kid: { hype: 3, ask: 2 }, newbie: { ask: 3, agree: 1.5 }, lurker: { agree: 2.5 },
  gacha: { relate: 2, hype: 1.5 }, streamer: { hype: 2, counter: 1.5 },
  explorer: { relate: 2.5, tip: 1.5 }, morning: { agree: 1.5, tip: 1.5 },
  nightowl: { counter: 1.5, relate: 1.5 }, casual: { agree: 1.5, relate: 1.5 }, global: { hype: 1.5, ask: 1.5 },
};

function pickFollowKind(r) {
  const taste = FOLLOW_TASTE[r.arch] || {};
  const kinds = Object.keys(FOLLOWS);
  const weights = kinds.map(k => taste[k] || 1);
  const total = weights.reduce((a, b) => a + b, 0);
  let x = rnd() * total;
  for (let i = 0; i < kinds.length; i++) { x -= weights[i]; if (x <= 0) return kinds[i]; }
  return 'agree';
}

// 生活雑談プール: 時間帯 + 週末 + 食・学校・眠気・完全雑談を重み付きで混ぜる。
function lifePool(r, ctx) {
  const mix = [];
  const add = (arr, w) => { for (const e of arr || []) mix.push({ ...e, w: (e.w || 1) * w }); };
  add(LIFE[ctx.period], 1);
  if (ctx.weekend) add(LIFE.weekend, 0.9);
  add(LIFE.food, ctx.period === 'evening' || ctx.period === 'day' ? 0.5 : 0.25);
  if (ctx.period !== 'late') add(LIFE.school, r.arch === 'kid' || r.arch === 'newbie' ? 0.7 : 0.3);
  add(LIFE.sleepy, ctx.period === 'late' || ctx.period === 'night' ? 0.6 : 0.1);
  add(LIFE.smalltalk, 0.55);
  return mix.filter(archOkFor(r));
}

// 👑 王座持ち住人の「王者ムーブ」— 玉座から語る専用セリフ。
const CHAMPION_LINES = [
  { ja: '王座は今日も渡さないよ', en: 'the throne stays mine today' },
  { ja: '挑戦者、いつでも受け付けてます', en: 'challengers welcome, any time' },
  { ja: '王座防衛って地味にプレッシャーある', en: 'defending a throne is lowkey stressful' },
  { ja: 'この景色は頂点からしか見えないんだよね', en: 'the view from the top is something else' },
  { ja: '👑維持のために今日も1回は回す', en: 'gotta play at least one run to keep the crown' },
  { ja: '俸給もらえないのに王座守ってるの偉くない？', en: 'defending a throne with no stipend — respect me' },
  { ja: '最近スコア詰めてくる人いて震えてる', en: 'someone is closing in on my score and I feel it' },
  { ja: '王冠、名前の横で光るのちょっと自慢', en: 'ngl the crown next to my name looks good' },
  { ja: '玉座は快適。降りる気はない', en: 'the throne is comfy. not moving' },
  { ja: '次に狙われてるのはたぶん自分', en: 'pretty sure I am the next target' },
];

// バイリンガル合成: 選んだ素材の ja/en 両面を「同じスロット値」で描画し、
// 相手言語の面をネイティブ翻訳（tr）として同梱する。辞書の後付け翻訳より
// はるかに自然 — 素材にはもともと人間が書いた英語がある。
// 返り値: { text, tr: {lang, text, engine:'native'} | null }

// 英語で「前置き, 本文」と繋ぐときの受け（日本語の「前置き、本文」に相当）。
// 素材の英文は7割が大文字始まりなので、そのまま繋ぐと文の途中に大文字が
// 現れる ── 英語ではここがいちばん素人臭く見える崩れ方なので、本文の頭を
// 小文字に落とす。曜日・月名・"I" のような、文中でも大文字のままの語は除く。
const EN_KEEP_CAPS = /^(I|January|February|March|April|May|June|July|August|September|October|November|December|Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)\b/;
function enAfterOpener(opener, s) {
  // 「Wi-Fi」「LETS GOOO」のような語は触らない（単純な Capitalized 語だけ）。
  const body = (/^[A-Z][a-z]+(?=[\s,.!?'’]|$)/.test(s) && !EN_KEEP_CAPS.test(s))
    ? s[0].toLowerCase() + s.slice(1)
    : s;
  // 疑問形の前置き（原文が「?」で終わるもの）は、カンマだと接続が壊れるので
  // 「?」で受けて空白で繋ぐ。'can I say something, Lost round one...' の防止。
  return /[?？]\s*$/.test(opener.ja || '') ? `${opener.en}? ${body}` : `${opener.en}, ${body}`;
}

function renderBoth(r, ctx, src, extra = {}, opener = null, tail = null) {
  const primaryEn = r.lang === 'en';
  const cache = {};   // 数字やスロット値は両言語で一致させる
  const assemble = lang => {
    const core = lang === 'en' ? src.en : src.ja;
    if (!core) return null;
    let s = fill(core, { ...r, lang }, ctx, extra, cache);
    if (opener) s = lang === 'en' ? enAfterOpener(opener, s) : `${opener.ja}、${s}`;
    else if (tail) s = lang === 'en' ? `${s} — ${tail.en}` : `${s}。${tail.ja}`;
    return s;
  };
  const ja = assemble('ja');
  const en = assemble('en');
  const text = primaryEn ? (en || ja) : (ja || en);
  if (!text) return null;
  const other = primaryEn ? ja : en;
  return {
    text: stylize(text, r),
    tr: other ? { lang: primaryEn ? 'ja' : 'en', text: other, engine: 'native' } : null,
  };
}

// 返信/リアクション用の対訳: これらのプールは ja/en が「対」ではなく等価な
// 言い回しの集合なので、反対言語のプールから1本選んで同じスロット値で描画し、
// ネイティブ tr として添える。辞書置換のエセ翻訳よりずっと自然に読める。
function pairTr(r, ctx, extra, cache, otherLines, otherLang, poolKey) {
  if (!otherLines || !otherLines.length) return null;
  const tpl = gen.smartPick(`${poolKey}.${otherLang}.tr`, otherLines, { now: ctx.now });
  if (!tpl) return null;
  return { lang: otherLang, text: fill(tpl, { ...r, lang: otherLang }, ctx, extra, cache), engine: 'native' };
}

// 1本の発言を合成する。トピック本文 / フォロー / 生活雑談 / 旧LINESの
// どれかを核にして、たまに前置きや締めの断片を継ぎ足す。
function buildLine3(r, ctx) {
  let src = null;
  // 王座持ちは16%で王者ムーブ（話題より優先 — キャラが立つ）。
  if ((ctx.thrones || []).includes(r.name) && rnd() < 0.16) {
    src = gen.smartPick('champion', CHAMPION_LINES, { now: ctx.now, rid: r.id });
  }
  const t = src ? null : gen.tickTopic(ctx);
  if (t && TOPICS[t.id]) {
    if (t.role === 'follow' && rnd() < 0.9) {
      const kind = pickFollowKind(r);
      src = gen.smartPick(`follow.${kind}`, (FOLLOWS[kind] || []).filter(archOkFor(r)), { now: ctx.now, rid: r.id });
    }
    if (!src) {
      src = gen.smartPick(`topic.${t.id}`, TOPICS[t.id].filter(archOkFor(r)), { now: ctx.now, rid: r.id });
    }
  }
  if (!src && rnd() < 0.3) {
    src = gen.smartPick('life', lifePool(r, ctx), { now: ctx.now, rid: r.id });
  }
  if (!src) {
    // 旧LINES資産もローテーションの一部として生きる（再出防止つき）。
    const pool = eligibleLines(r, ctx);
    if (!pool.length) return null;
    const weights = pool.map(l => {
      let w = l.w || 1;
      if (l.arch) w *= 1.8;
      if (l.ctx === 'event' || l.ctx === 'poll') w *= 1.6;
      if (l.ctx && l.ctx === ctx.period) w *= 1.3;
      return w;
    });
    src = gen.smartPick('lines', pool, { now: ctx.now, rid: r.id, weightFn: (_, i) => weights[i] });
  }
  if (!src) return null;
  // 断片の継ぎ足し: 短文なら前置き、それ以外はたまに締め（両言語で同じ断片）。
  const probe = (r.lang === 'en' ? (src.en || src.ja) : src.ja) || '';
  let opener = null, tail = null;
  if (probe.length < 30 && rnd() < 0.28) {
    opener = gen.smartPick('openers', OPENERS.filter(archOkFor(r)), { now: ctx.now, rid: r.id });
  } else if (rnd() < 0.2) {
    tail = gen.smartPick('tails', TAILS.filter(archOkFor(r)), { now: ctx.now, rid: r.id });
  }
  // opener/tail が片言語しか使えない素材（旧LINESのja-only等）は renderBoth が
  // その言語の面だけ返す — tr なしで自然に劣化する。
  return renderBoth(r, ctx, src, {}, opener, tail);
}

// A fresh line for this resident. customLines (admin) are mixed in.
// Returns { text, tr } — tr はネイティブ対訳（無い素材は null → postChat が辞書翻訳）。
export function composeLine(r, ctx, customLines = []) {
  if (customLines.length && rnd() < 0.3) {
    return { text: stylize(fill(pick(customLines), r, ctx), r), tr: null };
  }
  // 完成文レベルの重複も拒否 — 直近6時間に流れた文とは一致させない。
  for (let attempt = 0; attempt < 4; attempt++) {
    const out = buildLine3(r, ctx);
    if (out && gen.surfaceFresh(out.text, ctx.now)) {
      gen.noteSurface(out.text, ctx.now);
      gen.noteSpoken(r.id, ctx.now);
      return out;
    }
  }
  const pool = eligibleLines(r, ctx);
  if (!pool.length) return { text: stylize(r.lang === 'en' ? 'gg' : 'こんにちは〜', r), tr: null };
  const line = weightedLine(pool, r, ctx);
  const out = renderBoth(r, ctx, line) || { text: stylize(r.lang === 'en' ? 'gg' : 'こんにちは〜', r), tr: null };
  gen.noteSurface(out.text, ctx.now);
  gen.noteSpoken(r.id, ctx.now);
  return out;
}

// ---------------------------------------------------------------------------
// Dialogues: short exchanges between two residents
// ---------------------------------------------------------------------------
// roles: 'a' / 'b'. archA / archB constrain who can play each role.

const DIALOGUES = [
  // 3要素目は対訳面（ja台本ならen、en台本ならja）。renderBoth系と同じく
  // 同一スロット値で描画され、ネイティブ tr として同梱される。
  { lang: 'ja', lines: [['a', '誰か{mode}いかない？', 'anyone up for {mode}?'], ['b', 'いくいく', "i'm in!"], ['a', '部屋建てたよ', 'room is up'], ['b', 'おけ！', 'ok!']], archA: ['casual', 'tryhard', 'kid', 'senpai'] },
  { lang: 'ja', lines: [['a', 'ダンジョン{floor}Fで死んだ…', 'died on dungeon F{floor}…'], ['b', 'そこ鬼門よな', 'that floor is cursed'], ['a', 'シールド取っとけばよかった', 'should have taken the shield perk'], ['b', '次はいける', 'next run for sure']], archA: ['explorer', 'casual', 'newbie'], archB: ['explorer', 'senpai', 'nightowl'] },
  { lang: 'ja', lines: [['a', '今週のウィークリーむずくない？', "this week's weekly is rough, right?"], ['b', 'ピース運わるすぎ', 'the piece luck is awful'], ['a', 'あと2000点で自己べなのに', '2000 points off my best too'], ['b', 'がんば', 'good luck!']], ctx: 'mondayish' },
  { lang: 'ja', lines: [['a', '初心者なんですけど何から始めればいいですか？', "i'm new here — where should I start?"], ['b', 'まずソロで角を埋める練習がおすすめ！', 'practice filling corners in solo first!'], ['a', 'ありがとうございます！', 'thank you!'], ['b', 'わからんことあったら聞いてね', 'ask any time!']], archA: ['newbie', 'kid'], archB: ['senpai', 'tryhard', 'explorer'] },
  { lang: 'ja', lines: [['a', 'ガチャ10連した', 'did a 10-pull'], ['b', '結果は？', 'and??'], ['a', 'コインだけ…', 'coins. only coins…'], ['b', '爆死仲間がここにも', 'another victim of the gacha']], archA: ['gacha', 'casual', 'kid'], archB: ['gacha', 'casual'] },
  { lang: 'ja', lines: [['a', 'ガチャで{item}出た！', 'pulled {item} from the gacha!'], ['b', 'まじか！いいなあ', 'no way! lucky'], ['a', '装備して自慢する', 'equipping it to show off']], archA: ['gacha', 'casual', 'kid'] },
  { lang: 'ja', lines: [['a', 'レート{rating}なった', 'just hit {rating} rating'], ['b', 'つよ', 'strong'], ['a', '{tier}帯キープしたい', 'trying to hold {tier} now'], ['b', '対戦しよ', 'fight me sometime!']], archA: ['tryhard', 'nightowl'], archB: ['tryhard', 'senpai', 'nightowl'] },
  { lang: 'ja', lines: [['a', '奥義どれ使ってる？', 'which ultimate do you run?'], ['b', '神の裁き一択', 'divine judgement, no contest'], ['a', 'ジェムたりない…', 'not enough gems…'], ['b', '浄化の波動もコスパいいよ', 'the purge wave is great value too']], archA: ['casual', 'newbie'], archB: ['tryhard', 'senpai', 'explorer'] },
  { lang: 'ja', lines: [['a', 'レイド行く？', 'raid?'], ['b', '行く！', "i'm in!"], ['a', 'ハデス出たら泣く', 'if we get Hades I will cry'], ['b', 'クラーケン来い', 'give us the Kraken']], archA: ['explorer', 'senpai'], archB: ['explorer', 'casual', 'tryhard'] },
  { lang: 'ja', lines: [['a', '協力プレイ誰か組も', 'anyone for co-op?'], ['b', '組む！', 'me!'], ['a', 'お互いの置き方で全消し狙お', "let's set up a full clear together"], ['b', 'いいね', 'nice']], archA: ['casual', 'senpai', 'kid'] },
  { lang: 'ja', lines: [['a', 'タイムアタック60秒で{sprint}点いった', 'got {sprint} in the 60s time attack'], ['b', 'はや', 'so fast'], ['a', '3分のほうが伸びる気がする', 'the 3 min one scores higher I think'], ['b', '集中力もたんw', 'my focus dies lol']], archA: ['tryhard', 'morning', 'global'], archB: ['casual', 'tryhard', 'lurker'] },
  { lang: 'ja', lines: [['a', 'サバイバルWAVE{wave}で埋まった', 'got buried on survival wave {wave}'], ['b', 'そこから加速えぐいよね', 'the speed-up after that is brutal'], ['a', '不落の城塞装備していけばよかった', 'should have equipped the fortress']], archA: ['explorer', 'casual', 'nightowl'] },
  { lang: 'ja', lines: [['a', 'コンボ{combo}いった！', 'hit a {combo} combo!'], ['b', 'えぐ', 'insane'], ['b', '動画見たい', 'clip it please'], ['a', '配信で見せるわ', 'catch it on stream']], archA: ['streamer'], archB: ['casual', 'kid', 'tryhard'] },
  { lang: 'ja', lines: [['a', 'もう寝る…', 'off to bed…'], ['b', 'おやすみ〜', 'good night~'], ['a', 'おやすみ', 'night']], ctx: 'night' },
  { lang: 'ja', lines: [['a', 'おはよ', 'morning'], ['b', 'おはようございます', 'good morning!'], ['a', '朝ウィークリー行ってくる', 'morning weekly run, here I go']], ctx: 'morning' },
  { lang: 'ja', lines: [['a', '{event}きてる！', '{event} is live!'], ['b', 'やるしかない', 'no choice but to grind'], ['a', '今日は寝れん', 'not sleeping tonight']], ctx: 'event' },
  { lang: 'ja', lines: [['a', '投票どれにした？', 'what did you vote for?'], ['b', '{opt}', '{opt}'], ['a', 'おれもそれ', 'same here']], ctx: 'poll' },
  { lang: 'ja', lines: [['a', 'ママに怒られるからおちる！', 'mom is calling, gotta go!'], ['b', 'またね〜', 'see ya~'], ['a', 'ばいばい！', 'bye bye!']], archA: ['kid'], ctx: 'evening' },
  { lang: 'ja', lines: [['a', 'さっき{name}さんに負けた', 'just lost to {name}'], ['b', 'あの人強いよね', 'they are really good'], ['a', 'リベンジしたい', 'I want a rematch']], archA: ['tryhard', 'casual', 'nightowl'] },
  { lang: 'ja', lines: [['a', 'ミッション全部終わった', 'finished all my missions'], ['b', 'はや', 'so fast'], ['a', 'コンプボーナスまで取った', 'got the completion bonus too'], ['b', 'うらやま', 'jealous']] },
  { lang: 'en', lines: [['a', 'anyone up for ranked?', 'ランクマ誰か行かない？'], ['b', 'queueing now', '今から潜る'], ['a', 'see you there', 'じゃあマッチで会お']], archA: ['global'], archB: ['global'] },
  { lang: 'en', lines: [['a', 'the raid boss is brutal', 'レイドボスえぐくない？'], ['b', 'bring the fortress ultimate', '城塞の奥義持っていくといいよ'], ['a', 'oh that actually works?', 'それ効くの？'], ['b', 'trust me', '信じて']], archA: ['global'], archB: ['global'] },
  { lang: 'en', lines: [['a', 'good night all', 'みんなおやすみ！'], ['b', 'night!', 'おやすみ〜']], archA: ['global'], archB: ['global'] },
  { lang: 'en', lines: [['a', 'just hit {tier} rank!', '{tier}帯に上がった！'], ['b', 'gz!', 'おめ！'], ['a', 'took me forever', 'めっちゃ時間かかった']], archA: ['global'], archB: ['global'] },
];

function fits(r, roles) { return !roles || roles.includes(r.arch); }

// 3.0: トピックから即興の会話を組む — Aが本文、Bが相づち/反論/質問、
// たまにAが体験談で返す。組んだ話題はロビー全体の話題として引き継がれ、
// 続くソロ発言も同じ話題に乗る（会話が「続いて見える」仕掛けの本体）。
function genTopicDialogue(ctx) {
  const active = (ctx.active || []).filter(r => r.lang === 'ja');
  if (active.length < 2) return null;
  const entries = Object.keys(TOPICS).filter(id => (id !== 'event' || ctx.event) && (id !== 'poll' || ctx.poll));
  const id = entries[Math.floor(rnd() * entries.length)];
  const cores = TOPICS[id];
  if (!cores || !cores.length) return null;
  const a = pick(active);
  const bs = active.filter(r => r.id !== a.id);
  const b = pick(bs);
  const coreE = gen.smartPick(`topic.${id}`, cores.filter(archOkFor(a)), { now: ctx.now, rid: a.id });
  if (!coreE) return null;
  const kindB = pickFollowKind(b);
  const fB = gen.smartPick(`follow.${kindB}`, (FOLLOWS[kindB] || []).filter(archOkFor(b)), { now: ctx.now, rid: b.id });
  if (!fB) return null;
  // {name} in a follow-up must address the person being answered — never a
  // random third resident from the lobby.
  const script = [[a, coreE, { name: b.name }], [b, fB, { name: a.name }]];
  if (rnd() < 0.55) {
    const kindA = rnd() < 0.5 ? 'relate' : 'tip';
    const fA = gen.smartPick(`follow.${kindA}`, (FOLLOWS[kindA] || []).filter(archOkFor(a)), { now: ctx.now, rid: a.id });
    if (fA) script.push([a, fA, { name: b.name }]);
  }
  // まず全行をレンダリングして「全部新鮮に流せる」ことを確かめてから副作用を確定する。
  // 途中で棄却する場合、表示されない文を surface メモリに焼き付けたり、話題スレッドを
  // 乗っ取ったり、住人を noteSpoken で黙らせてはいけない（会話は流れていないため）。
  const built = [];
  const seen = new Set();   // 同一バッチ内の重複も従来どおり弾く
  let delay = 0;
  for (const [r, srcE, extra] of script) {
    delay += 3000 + rnd() * 9000;
    const rendered = renderBoth(r, ctx, srcE, extra);
    if (!rendered || !gen.surfaceFresh(rendered.text, ctx.now) || seen.has(rendered.text)) return null;   // rare — 副作用なしで中断
    seen.add(rendered.text);
    built.push({ resident: r, text: rendered.text, tr: rendered.tr, delay });
  }
  // 全行そろった — ここで初めて話題採用・surface・spoken を確定する。
  gen.adoptTopic(id, ctx);
  for (const x of built) {
    gen.noteSurface(x.text, ctx.now);
    gen.noteSpoken(x.resident.id, ctx.now);
  }
  return built;
}

// Returns [{ resident, text, delay }] or null when the cast is too thin.
export function composeDialogue(ctx) {
  const active = ctx.active || [];
  if (active.length < 2) return null;
  // 半分は生成会話、半分は台本会話（台本も再出防止つき）。
  if (rnd() < 0.5) {
    const g = genTopicDialogue(ctx);
    if (g) return g;
  }
  const pool = DIALOGUES.filter(d => CTX_OK(d, ctx) && active.some(r => r.lang === d.lang));
  if (!pool.length) return null;
  for (let tries = 0; tries < 6; tries++) {
    const d = gen.smartPick('dialogues', pool, { now: ctx.now });
    if (!d) break;
    const cands = active.filter(r => r.lang === d.lang);
    const as = cands.filter(r => fits(r, d.archA));
    if (!as.length) continue;
    const a = pick(as);
    const bs = cands.filter(r => r.id !== a.id && fits(r, d.archB));
    if (!bs.length) continue;
    const b = pick(bs);
    let delay = 0;
    const ctxB = { ...ctx, active: active.filter(r => r.id !== b.id) };
    const otherLang = d.lang === 'ja' ? 'en' : 'ja';
    return d.lines.map(([role, tpl, tplOther]) => {
      const r = role === 'a' ? a : b;
      const useCtx = role === 'a' ? ctx : ctxB;
      delay += 3000 + rnd() * 9000;
      const cache = {};
      const s = stylize(fill(tpl, r, useCtx, {}, cache), r);
      // 台本に対訳面（3要素目）があればネイティブtrとして同梱
      const tr = tplOther ? { lang: otherLang, text: fill(tplOther, { ...r, lang: otherLang }, useCtx, {}, cache), engine: 'native' } : null;
      gen.noteSurface(s, ctx.now);
      gen.noteSpoken(r.id, ctx.now);
      return { resident: r, text: s, tr, delay };
    });
  }
  return null;
}

// ---------------------------------------------------------------------------
// Live feed: things residents "did"
// ---------------------------------------------------------------------------

const FEED = [
  { id: 'ai_win',   icon: '🤖', w: 10, min: 0.25, ja: '{me} が {ai}AI に勝利',                     en: '{me} beat the {ai} AI' },
  { id: 'oni_win',  icon: '👹', w: 2.5, min: 0.78, ja: '{me} が 鬼AI を撃破！！',                    en: '{me} crushed the Oni AI!!' },
  { id: 'record',   icon: '⭐', w: 8,  min: 0,    ja: '{me} が自己ベスト {score} 点を更新！',        en: '{me} set a new best: {score}!' },
  { id: 'combo',    icon: '🔥', w: 6,  min: 0.3,  ja: '{me} が {combo} コンボを達成！',               en: '{me} landed a {combo} combo!' },
  { id: 'gacha_ssr',icon: '🎰', w: 5,  min: 0,    ja: '{me} がガチャで SSR「{item}」を引いた！',     en: '{me} pulled SSR "{item}" from the gacha!' },
  { id: 'gacha_ur', icon: '🌟', w: 1,  min: 0,    ja: '{me} が UR を引き当てた！！',                  en: '{me} hit the UR jackpot!!' },
  { id: 'dungeon',  icon: '🏰', w: 7,  min: 0.2,  ja: '{me} がダンジョン {floor}F に到達',           en: '{me} reached dungeon F{floor}' },
  { id: 'boss',     icon: '🐲', w: 5,  min: 0.3,  ja: '{me} が {boss} を討伐！',                      en: '{me} defeated {boss}!' },
  { id: 'streak',   icon: '⚔️', w: 4,  min: 0.55, ja: '{me} がランクマ {n}連勝中！',                 en: '{me} is on a {n}-win ranked streak!' },
  { id: 'rankup',   icon: '🥇', w: 3,  min: 0.4,  ja: '{me} が {tier} に昇格！',                      en: '{me} was promoted to {tier}!' },
  { id: 'tourney',  icon: '🏆', w: 0.9, min: 0.75, ja: '{me} がトーナメントで優勝！',                 en: '{me} won the tournament!' },
  { id: 'royale',   icon: '💯', w: 0.7, min: 0.7,  ja: '{me} がバトルロイヤルで1位！',               en: '{me} took #1 in battle royale!' },
  { id: 'sprint',   icon: '⏱️', w: 4,  min: 0.3,  ja: '{me} がタイムアタック60秒で {sprint} 点！',   en: '{me} scored {sprint} in the 60s time attack!' },
  { id: 'coop',     icon: '🤝', w: 3,  min: 0,    ja: '{me} と {name} が協力プレイで {score} 点！',   en: '{me} and {name} scored {score} in co-op!' },
  { id: 'title',    icon: '👑', w: 2,  min: 0.3,  ja: '{me} が称号「{title}」を獲得',                 en: '{me} earned the title "{title}"' },
  { id: 'ach',      icon: '🏅', w: 4,  min: 0,    ja: '{me} が実績「{ach}」を解除',                   en: '{me} unlocked "{ach}"' },
  { id: 'ult',      icon: '⚡', w: 3,  min: 0.4,  ja: '{me} が 神の裁き を発動！盤面消滅！',          en: '{me} unleashed Divine Judgement!' },
  { id: 'survival', icon: '💀', w: 3,  min: 0.3,  ja: '{me} がサバイバル WAVE {wave} に到達',         en: '{me} survived to wave {wave}' },
  { id: 'mission',  icon: '📋', w: 3,  min: 0,    ja: '{me} がデイリーミッションをコンプリート',      en: '{me} completed every daily mission' },
  { id: 'raid',     icon: '🐙', w: 2,  min: 0.4,  ja: '{me} のレイドパーティが {boss} を討伐！',      en: "{me}'s raid party took down {boss}!" },
  { id: 'join',     icon: '👋', w: 2,  min: 0,    ja: '{me} が新しく参加しました！ようこそ！',        en: '{me} just joined — welcome!', newbie: true },
];

export function composeFeed(ctx) {
  const active = ctx.active || [];
  if (!active.length) return null;
  for (let tries = 0; tries < 8; tries++) {
    // 3.0: テンプレの再出防止つき抽選（「また誰かが鬼AIに勝った」の連発を潰す）。
    const f = gen.smartPick('feed', FEED, { now: ctx.now });
    if (!f) return null;
    const cands = active.filter(r => r.skill >= f.min && (!f.newbie || archetype(r.arch).newbie));
    if (!cands.length) continue;
    const r = pick(cands);
    const extra = {};
    // RAID_BOSSES はオブジェクト（nameEn 持ち）。文字列を渡すと renderSlot の
    // boss 分岐が素通しし、英語面 textEn に日本語ボス名が挿さる回帰になる。
    if (f.id === 'raid') extra.boss = pick(RAID_BOSSES);
    // 「自己ベスト更新」速報は実際のランキング値（bestScore）そのものを告知する。
    // {score} スロットの 86〜100% 丸めだと、更新と言いながらプロフィール/ランキングの
    // 自己ベストを下回る数字が出て矛盾する。
    if (f.id === 'record') extra.score = residentStats(r, ctx.now).bestScore;
    const ctxOthers = { ...ctx, active: active.filter(x => x.id !== r.id) };
    const cache = {};   // same numbers in both languages
    // 各面はその面の言語で描く。r をそのまま渡すと fill が住人の lang を使うので、
    // 英語圏の住人（archetype 'global'、ロスターの約12%）が主語のときだけ日本語の
    // フィード文に英語の名詞が混ざっていた（「Milo が WarriorAI に勝利」「Aria が
    // Master に昇格！」）。英語面は最初から lang を固定してあるので、その対称。
    const text = fill(f.ja, { ...r, lang: 'ja' }, ctxOthers, extra, cache);
    if (!gen.surfaceFresh(text, ctx.now)) continue;
    gen.noteSurface(text, ctx.now);
    return {
      id: f.id, icon: f.icon, at: ctx.now, real: false,
      text,
      textEn: fill(f.en, { ...r, lang: 'en' }, ctxOthers, extra, cache),
      who: r.name,
    };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Reactions to real-world moments
// ---------------------------------------------------------------------------

const REACTIONS = {
  // a real player just connected
  greet_named: {
    ja: ['{you}さんこんにちは！', '{you}さんきた！', 'お、{you}さん', '{you}さんよろしく〜', '{you}さんこんばんは'],
    en: ['hey {you}!', 'welcome back {you}', 'oh hi {you}', 'yo {you} 👋'],
  },
  greet_plain: {
    ja: ['こんにちは〜', 'こんばんは！', 'いらっしゃい！', 'よろしく〜', 'やあ！'],
    en: ['hi!', 'welcome!', 'hey hey', 'yo 👋'],
  },
  // a real player beat this resident (as a disguised bot)
  lost_to: {
    ja: ['{you}さん強すぎ…', '{you}さんにボコられたw', '{you}さんリベンジさせて！', 'さっきの{you}さん上手すぎ', 'うわ負けた…{you}さんつよ', '{you}さんのコンボえぐかった'],
    en: ['{you} is cracked…', 'got destroyed by {you} lol', 'rematch me {you}!', 'gg {you}, you were too good'],
  },
  beat: {
    ja: ['{you}さんgg！', '{you}さんいい勝負だった', '{you}さんまた対戦しよ', 'ふぅ…{you}さん危なかった', '{you}さんの追い上げ怖かった'],
    en: ['gg {you}!', 'close one {you}', 'run it back sometime {you}'],
  },
  drew: {
    ja: ['{you}さんと引き分けたw', '{you}さんと同点はアツい', '{you}さん次は決着つけよ'],
    en: ['tied with {you} lol', 'rematch to settle it {you}?'],
  },
  // co-op partner (resident) after the run
  coop_done: {
    ja: ['{you}さん協力おつ！', '{you}さんとの協力たのしかった', '{you}さん置き方うまかった', '{you}さんまた組も'],
    en: ['gg {you}, fun co-op!', 'nice placements {you}'],
  },
  // events
  event_start: {
    ja: ['{event}きたあああ', 'イベント開始！やるしかない', '{event}のうちに稼ぐぞ', 'おっ、イベントじゃん', '{event}ありがとう運営！'],
    en: ['{event} just started!', 'event time, lets go', 'thank you devs 🙏'],
  },
  event_coinfes: { ja: ['コイン2倍は回すしかない', 'コイン祭りで稼いで{item}買う'], en: ['double coins!! grind time'] },
  event_xpboost: { ja: ['パス一気に進めるチャンス', 'XP2倍でレベル上げる'], en: ['battle pass go brrr'] },
  event_gemrush: { ja: ['ジェム落ちるの神すぎ', '毎プレイ3ジェムはえぐい'], en: ['free gems every game??'] },
  event_bossraid: { ja: ['ボス弱体化のうちに魔王倒す', 'ボス報酬2倍うま'], en: ['bosses are weakened, go go'] },
  event_ultfes: { ja: ['ゲージ2倍速で奥義撃ち放題w', '奥義祭たのしすぎ'], en: ['ultimates every 30 seconds lol'] },
  event_lucky: { ja: ['ガチャ安いうちに10連行く', 'ラッキーデーでSSR狙う'], en: ['discounted gacha, time to gamble'] },
  event_chaos: { ja: ['カオスモード開いた！', 'カオスのコイン1.5倍おいしい'], en: ['chaos mode is open!'] },
  event_doubletrouble: { ja: ['コインもXPも2倍は頭おかしい（褒め言葉）', '倍々デーで一気に稼ぐ'], en: ['double EVERYTHING, insane'] },
  event_end: {
    ja: ['イベント終わっちゃった…', 'イベントおつでした', '次のイベントはいつかな'],
    en: ['event over already…', 'that was a fun event'],
  },
  poll_open: {
    ja: ['投票きてる！', '投票した？', '{opt}に入れた', 'これは{opt}一択でしょ', '迷うけど{opt}かな'],
    en: ['new poll is up!', 'I voted {opt}', '{opt} for sure'],
  },
  poll_close: {
    ja: ['投票結果出たね', '「{winner}」に決まった！', '{winner}に投票してよかった', 'まあ妥当な結果'],
    en: ['poll results are in', '"{winner}" won the vote'],
  },
  // a resident just cast their vote ({opt} = their actual choice)
  poll_voted: {
    ja: ['{opt}に入れた！', '{opt}に一票', '悩んだけど{opt}にした', 'これは{opt}でしょ', '{opt}に投票してきた'],
    en: ['just voted {opt}', '{opt} gets my vote', 'went with {opt} after some thought'],
  },
  // a swing voter changed sides ({opt} = the new choice)
  poll_swing: {
    ja: ['やっぱ{opt}に変えた', 'ごめん、{opt}に乗り換えたw', '形勢見て{opt}に変更した', 'みんな{opt}なら…私も{opt}'],
    en: ['ok I switched to {opt}', 'changed my vote to {opt} lol', 'fine, {opt} it is'],
  },
  // the poll is about to close
  poll_lastcall: {
    ja: ['投票そろそろ締切だよ！', 'まだ投票してない人いる？急いで〜', '「{question}」の投票、忘れずに！', '投票締切間近！！'],
    en: ['poll is closing soon, go vote!', 'last call for the poll!', 'don\'t forget to vote on "{question}"!'],
  },
  // real player achievements (announced by the server)
  champion: {
    ja: ['{you}さん優勝おめでとう！！', '{you}さんつよ…', '優勝者きたあああ', '{you}さん次は倒す'],
    en: ['gz {you}!!', '{you} is unstoppable'],
  },
  royale_win: {
    ja: ['{you}さんバトロワ1位すご！', '100人の頂点…{you}さん強い', '{you}さんおめ！'],
    en: ['{you} won the royale, insane', 'gz {you}!'],
  },
  record: {
    ja: ['{you}さん{score}点やば', '{you}さんすご', 'その点数どうやって出すの…', '{you}さんおめ！'],
    en: ['{score}?? wow {you}', 'gz on the record {you}'],
  },
  badge: {
    ja: ['{you}さん{badge}おめ！', '{badge}持ってる人初めて見た', 'すご…{you}さん'],
    en: ['gz on {badge}, {you}!', 'whoa {you}'],
  },
};

// index.js の BADGE_ICONS / BADGE_NAMES_EN と必ず同じキーを持たせること。
// 片方に足し忘れると `BADGE_NAMES[badge] || badge` が生のIDへフォールバックして、
// 全体速報と住人のリアクションが日本語面だけ「〇〇 が「abyss」を獲得！」になる
// （実際 abyss＝深淵ダンジョンA100制覇だけが抜けていて、ゲーム最難関の速報が
// そうなっていた。英語面は BADGE_NAMES_EN があるので正しく出ていた）。
export const BADGE_NAMES = {
  oni: '鬼討伐バッジ', kami: '神殺しバッジ', souzou: '創造神討伐バッジ', maou: '魔王討伐バッジ',
  rush: 'ボスラッシュ制覇', dungeon: '百塔踏破', under: '地底踏破', heaven: '天界踏破', abyss: '深淵踏破', zero: '断罪', tourney: '大会優勝', royale: 'バトロワ1位',
  weekly1: '週間チャンピオン', puzzle: '遺跡マスター', dig: 'マスター採掘士',
  adminevent: '管理者イベント制覇',
  crown2: '二冠バッジ', crown3: '三冠バッジ', crown5: '五冠バッジ', crown7: '全冠制覇バッジ',
  ghost: '幽霊屋敷の生還者', daily7: '日課の鬼',
};

// Pick one or more residents to react. Returns [{ resident, text, delay }].
export function composeReaction(kind, ctx, extra = {}, count = 1) {
  const active = ctx.active || [];
  if (!active.length) return [];
  // 実際の出来事はロビーの話題も乗っ取る — 直後のソロ発言が同じ件で盛り上がる。
  const tp = gen.topicForReaction(kind);
  if (tp) gen.adoptTopic(tp, ctx);
  const out = [];
  const used = new Set();
  let delay = 4000 + rnd() * 10000;
  for (let i = 0; i < count; i++) {
    const cands = active.filter(r => !used.has(r.id) && (!extra.only || extra.only.includes(r.id)) && (!extra.notName || r.name !== extra.notName) && r.chatty > 0.3);
    if (!cands.length) break;
    const r = pick(cands);
    used.add(r.id);
    // Event reactions get a type-specific flavour line about half the time.
    let poolKey = kind;
    let pool = REACTIONS[kind];
    if (kind === 'event_start' && ctx.event && REACTIONS[`event_${ctx.event.type}`] && rnd() < 0.55) {
      poolKey = `event_${ctx.event.type}`;
      pool = REACTIONS[poolKey];
    }
    if (!pool) break;
    const useEn = r.lang === 'en' && pool.en;
    const lines = useEn ? pool.en : pool.ja;
    const tpl = gen.smartPick(`react.${poolKey}.${useEn ? 'en' : 'ja'}`, lines, { now: ctx.now, rid: r.id });
    if (!tpl) break;
    const cache = {};
    const s = stylize(fill(tpl, r, ctx, extra, cache), r);
    const tr = pairTr(r, ctx, extra, cache, useEn ? pool.ja : pool.en, useEn ? 'ja' : 'en', `react.${poolKey}`);
    gen.noteSpoken(r.id, ctx.now);
    out.push({ resident: r, text: s, tr, delay });
    delay += 5000 + rnd() * 20000;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Reply engine — residents answer real players
// ---------------------------------------------------------------------------

const REPLIES = {
  greeting: {
    ja: ['こんにちは〜！', 'こんばんは！', 'よろしく！', 'やあ！', 'ちわ〜っす', 'いらっしゃい！', 'おつかれ〜'],
    en: ['hi! 👋', 'hello!', 'yo!', 'welcome!', 'hey hey'],
    arch: null,
  },
  bye: { ja: ['おつ〜', 'おやすみ！', 'またね〜', 'お疲れさま！'], en: ['night!', 'see ya', 'gn!'] },
  gg: { ja: ['gg！', 'ggでした！', 'おつ〜', 'ナイスファイト！'], en: ['gg!', 'ggwp', 'good game!', 'nice one'] },
  thanks: { ja: ['いえいえ', 'どういたしまして〜', 'また聞いて！'], en: ['np!', 'anytime', 'you got it'] },
  laugh: { ja: ['w', 'ww', '草', 'わかるw'], en: ['lol', 'lmao', 'haha'] },
  sad: { ja: ['どんまい！', '次いこ次', 'わかる…つらい', 'がんばれ！', '大丈夫、伸びるよ'], en: ['unlucky', 'next one!', 'you got this'] },
  battle: {
    ja: ['いいよ！ランクマ潜ろ', '今から潜るわ', 'おれも行く！', '1v1いこ！', 'カスタムルーム建てる？', '協力でもいいよ'],
    en: ["let's go! queueing now", "i'm in, 1v1?", 'sure, see you in ranked'],
    arch: ['tryhard', 'casual', 'senpai', 'nightowl', 'global', 'kid'],
  },
  praise: { ja: ['ありがとw', '照れるわ', 'まだまだですよ〜', 'そっちこそ強かった'], en: ['thanks haha', 'nah still learning', 'you too!'] },
  beginner: {
    ja: ['ようこそ！', '最初はソロで角から埋める練習がおすすめ', 'わからんことあったら聞いて！', '一緒にがんばろ〜', 'ミッション回すとコイン貯まるよ'],
    en: ['welcome! try solo mode first', 'welcome aboard!', 'ask anything!'],
    arch: ['senpai', 'casual', 'tryhard', 'explorer', 'morning'],
  },
  dungeon: {
    ja: ['ダンジョンは残機管理が大事', '40Fから急にキツくなるよね', 'シールドの強化おすすめ', '100F勢おる？', '地下は最初からお邪魔あるから浄化の波動つよい'],
    en: ['the dungeon gets rough after 40F', 'pick the shield perk, trust me'],
    arch: ['explorer', 'senpai', 'tryhard', 'nightowl'],
  },
  gacha: { ja: ['爆死仲間がここにも', 'SSR出る気しない', '10連で決めろ！', 'UR引いた人見たことない', 'ラッキーデー待ちが正解'], en: ['gacha luck is brutal lol', 'save for the 10-pull!'], arch: ['gacha', 'casual', 'kid'] },
  weekly: { ja: ['今週のむずいよね', 'ピース運ゲーすぎるw', '月曜リセット待ち', 'あと2000点で自己べ'], en: ['this week is a hard one', 'so close to my best score'] },
  boss: { ja: ['レイド行こうぜ', 'ボスのお邪魔ブロックえぐい', '魔王まで倒した？', 'ラッシュはノーミス必須がつらい', '時間停止でボス止めるの強いよ'], en: ['raid time! join the queue', 'the boss garbage blocks are evil'], arch: ['explorer', 'senpai', 'casual'] },
  ult: {
    ja: ['ラインを消すとゲージ溜まるよ', 'MAXになったらHUDの⚡押すだけ', '最初は破壊の衝撃波で十分つよい', '神の裁きは400ジェム…遠い', 'スペースキーでも撃てるよ'],
    en: ['clear lines to charge it, then hit the ⚡ button', 'the free shockwave is honestly fine'],
    arch: ['senpai', 'tryhard', 'explorer', 'casual'],
  },
  mission: { ja: ['メニューのミッションから受け取れるよ', 'デイリー3つ全部やるとボーナスある', '実績もまとめて受け取れるの便利'], en: ['claim them from the Missions menu'], arch: ['senpai', 'casual', 'morning'] },
  coop: { ja: ['協力たのしいよね', '相棒が置いたあとの盤面読むのむずい', '組む？'], en: ['co-op is fun! wanna team up?'] },
  sprint: { ja: ['60秒は集中力勝負', '3分のほうがスコア伸びる', 'タイムアタックは奥義使えないから実力出る'], en: ['60s is pure focus', 'the 3 min one is more chill'] },
  event: { ja: ['イベント中は稼ぎどき', '今のうちに{mode}回そ', 'イベントのあいだ人多いね'], en: ['event time = farm time'] },
  poll: { ja: ['バナーから投票できるよ', '{opt}に入れた', '投票すると結果見えるよ'], en: ['vote from the banner on the menu!'] },
  coins: { ja: ['ミッションが一番効率いいよ', '連続ログインでボーナス増える', 'カオスイベント中はコイン1.5倍', '実績のまとめ受け取り忘れずに'], en: ['missions are the best coin source', 'login streaks boost the daily bonus'], arch: ['senpai', 'casual', 'tryhard', 'gacha'] },
  rating: { ja: ['ランクマで勝つと上がるよ', '1100でゴールド、1500でダイヤ', '連勝ボーナスもあるから勝ち続けると美味しい'], en: ['win ranked games and it climbs', '1500 is Diamond'], arch: ['tryhard', 'senpai', 'nightowl'] },
  secret: { ja: ['なんか隠しコマンドあるらしい…', '↑↑↓↓…まではわかる', '神より上もあるって噂', 'AIの画面のタイトル連打したら何か出たって聞いた'], en: ['there is a secret code apparently…'], arch: ['streamer', 'casual', 'nightowl', 'tryhard'] },
  question: { ja: ['たぶんそうだと思う', 'わかる', 'それな', 'どうだろ？やってみるしかない', '先輩勢が知ってそう'], en: ['probably yeah', 'good question lol', 'try it and see!'] },
  generic: { ja: ['それな', 'わかるw', 'たしかに', '🔥', 'がんばれ！', 'いいね！', 'ないす', 'w', 'まじか', 'へぇ'], en: ['nice', 'lol', 'same here', 'good luck!', '🔥', 'fr', 'haha'] },
};

const REPLY_RULES = [
  ['bye', /おやすみ|落ちます|おちる|寝る|またね|bye|good ?night|\bgn\b/i],
  ['greeting', /こんにち|こんばん|おはよ|やあ|よろしく|はじめまして|ただいま|hello|\bhi\b|\bhey\b|\byo\b/i],
  ['gg', /^gg|ｇｇ|^おつ(かれ)?|^お疲れ/i],
  ['thanks', /ありがと|あざ|thank|\bty\b|thx/i],
  ['laugh', /^[wｗ]+$|^草$|^lol$|^lmao$|^haha/i],
  ['sad', /つらい|負けた|まけた|爆死|死んだ|しんだ|😭|泣|悔し|lost|rip|ugh/i],
  ['battle', /対戦|たいせん|1v1|2v2|勝負|やろ[うぜ]|潜ろ|組も|battle|duel|match|ranked/i],
  ['praise', /強い|つよ|うま[いっ]|上手|すごい|ナイス|nice|strong|\bpro\b|cracked/i],
  ['beginner', /初心者|はじめて|始めた|新規|newbie|beginner|new here|just started/i],
  ['ult', /奥義|アルティメット|ゲージ|必殺|ultimate|gauge/i],
  ['mission', /ミッション|実績|mission|achievement/i],
  ['coop', /協力|きょうりょく|相棒|co-?op|partner/i],
  ['sprint', /タイムアタック|スプリント|60秒|time ?attack|sprint/i],
  ['coins', /コイン|稼ぎ|かせぎ|coins?/i],
  ['rating', /レート|ランク帯|rating|\brank\b|tier/i],
  ['secret', /隠し|かくし|コマンド|創造神|secret|konami|hidden/i],
  ['dungeon', /ダンジョン|dungeon|[0-9]+f\b/i],
  ['gacha', /ガチャ|gacha|ssr|\bur\b/i],
  ['weekly', /ウィークリー|週替|weekly/i],
  ['boss', /ボス|レイド|魔王|raid|boss/i],
  ['event', /イベント|祭|event/i],
  ['poll', /投票|とうひょう|poll|vote/i],
  ['question', /[?？]$/],
];

// 名指し判定。単純な部分文字列一致だと2文字の住人名が日常語に埋もれて誤爆する
// （『レイ』が『プレイ』『レイド』、英語の 'Kai' が 'Kaito'）。境界を見る:
//   ・ラテン名: 前後が英数字でない（単語境界）。
//   ・カナ名: 名前の端が別のカナに続いていない（プレイ/レイド を弾く）。
//     さん/ちゃん 等の敬称は語頭がひらがなでも許す（レイさん・むぎちゃん）。
const isKata = c => (c >= 'ァ' && c <= 'ヶ') || c === 'ー';
const isHira = c => c >= 'ぁ' && c <= 'ん';
const isLatinWord = c => /[A-Za-z0-9]/.test(c);
const HONORIFIC = /^(さん|くん|ちゃん|さま|っち|きゅん|ちゃ)/;
function nameMentioned(text, name) {
  if (!name || name.length < 2) return false;
  const latin = /^[\x00-\x7F]+$/.test(name);
  const first = name[0], last = name[name.length - 1];
  for (let from = 0, idx; (idx = text.indexOf(name, from)) !== -1; from = idx + 1) {
    const before = idx > 0 ? text[idx - 1] : '';
    const after = idx + name.length < text.length ? text[idx + name.length] : '';
    if (latin) {
      if (!isLatinWord(before) && !isLatinWord(after)) return true;
      continue;
    }
    const badBefore = before && ((isKata(first) && isKata(before)) || (isHira(first) && isHira(before)));
    let badAfter = after && ((isKata(last) && isKata(after)) || (isHira(last) && isHira(after)));
    if (badAfter && isHira(last) && HONORIFIC.test(text.slice(idx + name.length))) badAfter = false;
    if (!badBefore && !badAfter) return true;
  }
  return false;
}

// Returns [{ resident, text, delay }]. `residents` = currently active cast.
// forcedName: a resident who MUST answer first (a direct reply to their
// message) — even quiet lurkers respond when spoken to directly.
export function chooseReplies(text, ctx, forcedName = null) {
  const t = String(text || '').trim();
  if (!t) return [];
  const active = (ctx.active || []).filter(r => r.chatty > 0.3);
  const forced = forcedName ? (ctx.active || []).find(r => r.name === forcedName) : null;
  if (!active.length && !forced) return [];
  const lang = /[ぁ-んァ-ヶ一-龠ー]/.test(t) ? 'ja' : 'en';

  // Mentioned residents always answer; a direct-reply target leads the queue.
  let mentioned = active.filter(r => nameMentioned(t, r.name));
  if (forced) mentioned = [forced, ...mentioned.filter(r => r.id !== forced.id)];

  let category = 'generic';
  for (const [cat, re] of REPLY_RULES) {
    if (re.test(t)) { category = cat; break; }
  }
  const spec = REPLIES[category];
  const pool = (lang === 'en' && spec.en) ? spec.en : spec.ja;

  const pickResident = (exclude) => {
    const prefer = active.filter(r => !exclude.has(r.id) && r.lang === lang && (!spec.arch || spec.arch.includes(r.arch)));
    const any = active.filter(r => !exclude.has(r.id) && r.lang === lang);
    const fallback = active.filter(r => !exclude.has(r.id));
    const c = prefer.length ? prefer : any.length ? any : fallback;
    return c.length ? pick(c) : null;
  };

  const out = [];
  const used = new Set();
  // 3.0: 返信も再出防止つき — 「gg」に毎回同じ返事が来る問題の本丸。
  const replyPick = (r, lines, poolKey) =>
    gen.smartPick(`reply.${poolKey}`, lines, { now: ctx.now, rid: r.id }) || lines[0];
  if (mentioned.length) {
    const r = mentioned[0];
    used.add(r.id);
    const useEn = r.lang === 'en' && spec.en;
    const lines = useEn ? spec.en : spec.ja;
    gen.noteSpoken(r.id, ctx.now);
    const mCache = {};
    const mText = stylize(fill(replyPick(r, lines, `${category}.${useEn ? 'en' : 'ja'}`), r, ctx, {}, mCache), r);
    const mTr = pairTr(r, ctx, {}, mCache, useEn ? spec.ja : spec.en, useEn ? 'ja' : 'en', `reply.${category}`);
    out.push({ resident: r, text: mText, tr: mTr, delay: 2500 + rnd() * 5000 });
  }
  const r1 = pickResident(used);
  if (r1) {
    used.add(r1.id);
    const first = replyPick(r1, pool, `${category}.${lang}`);
    gen.noteSpoken(r1.id, ctx.now);
    const cache1 = {};
    const text1 = stylize(fill(first, r1, ctx, {}, cache1), r1);
    const tr1 = pairTr(r1, ctx, {}, cache1, lang === 'en' ? spec.ja : spec.en, lang === 'en' ? 'ja' : 'en', `reply.${category}`);
    out.push({ resident: r1, text: text1, tr: tr1, delay: (out.length ? out[0].delay : 0) + 3500 + rnd() * 8500 });
    // Sometimes a second voice chimes in.
    if (rnd() < 0.28) {
      const r2 = pickResident(used);
      if (r2) {
        const spec2 = rnd() < 0.5 ? spec : REPLIES.generic;
        const pool2 = (lang === 'en' && spec2.en) ? spec2.en : spec2.ja;
        let second = replyPick(r2, pool2, `${category}2.${lang}`);
        if (second === first) second = (lang === 'en' ? REPLIES.generic.en : REPLIES.generic.ja)[0];
        gen.noteSpoken(r2.id, ctx.now);
        const cache2 = {};
        const text2 = stylize(fill(second, r2, ctx, {}, cache2), r2);
        const tr2 = pairTr(r2, ctx, {}, cache2, lang === 'en' ? spec2.ja : spec2.en, lang === 'en' ? 'ja' : 'en', `reply.${category}2`);
        out.push({ resident: r2, text: text2, tr: tr2, delay: out[out.length - 1].delay + 4000 + rnd() * 7000 });
      }
    }
  }
  return out;
}

export { tierOf };

// ---------------------------------------------------------------------------
// にぎわい語彙メガ拡張 — 追加コンテンツはここに一括登録して本体テーブルへ
// push/merge する（本体の定義は読みやすいまま保つ）。
// ---------------------------------------------------------------------------

const EXTRA_LINES = [
  { ja: "目覚まし止めた流れでログインしてた", en: "turned off my alarm and somehow ended up logged in", ctx: "morning" },
  { ja: "朝のソロ1周で頭起こしてる", en: "one solo run to wake my brain up", arch: ["morning"], ctx: "morning" },
  { ja: "午前中に用事ぜんぶ終わらせた 偉すぎる", en: "finished every errand before noon, I deserve a medal", not: ["kid"], ctx: "day" },
  { ja: "昼のロビー静かで好き", en: "the afternoon lobby is so peaceful", arch: ["lurker","senpai","morning"], ctx: "day" },
  { ja: "夕焼け見ながらタイムアタックしてた", en: "played time attack with the sunset in the window", ctx: "evening" },
  { ja: "今日はもう店じまい ランクマは明日の私に任せた", en: "closing up shop, ranked is tomorrow-me's problem", not: ["kid"], ctx: "night" },
  { ja: "風呂上がりのランクマ謎に勝てる", en: "post-bath ranked wins, no idea why it works", ctx: "night" },
  { ja: "気づいたら日付変わってた", en: "wait, when did it become tomorrow", ctx: "late", w: 2 },
  { ja: "明日の自分に謝りながら{mode}回してる", en: "apologizing to tomorrow's me while queuing {mode} again", not: ["kid"], ctx: "late" },
  { ja: "寝る前の1戦が3戦になるのなんで", en: "\"one game before bed\" is never one game", ctx: "night", w: 2 },
  { ja: "寝落ちしてサバイバルで放置死してた", en: "fell asleep mid-survival and woke up dead", ctx: "late" },
  { ja: "深夜だけ配置が冴えるの何なんだろうな", en: "why is my placement godlike only at 2am", arch: ["nightowl","tryhard","streamer"], ctx: "late" },
  { ja: "日曜の夜だけ時間の流れ早すぎる", en: "sunday evenings last five minutes I swear", ctx: "weekend" },
  { ja: "月曜はログボだけが裏切らない", en: "the monday login bonus, only good part of mondays", ctx: "mondayish" },
  { ja: "金曜の脳は判断力ゼロだからガチャ引きがち", en: "friday brain says pull the gacha", arch: ["gacha","casual","nightowl"], ctx: "friday" },
  { ja: "土曜の朝から協力募集出てて平和", en: "co-op invites up since saturday morning, very wholesome", ctx: "weekend" },
  { ja: "週末しか潜れないランクマ勢です", en: "weekend-only ranked player here", not: ["kid"], ctx: "weekend" },
  { ja: "週間ランキングのリセット見届けるのちょっと寂しい", en: "watching the weekly board reset always stings a little", ctx: "mondayish" },
  { ja: "カレー煮込みながら片手でソロ", en: "stirring curry with one hand, placing blocks with the other" },
  { ja: "電車乗り過ごしかけた このゲームのせい", en: "almost missed my station because of this game", not: ["kid"] },
  { ja: "雨だし今日は引きこもりブロック日和", en: "raining all day, so it's a blocks day" },
  { ja: "布団の中でやると勝率下がる説", en: "playing under the covers = instant losses, proven" },
  { ja: "テスト前なのにダンジョン潜ってる", en: "exam tomorrow and here I am in the dungeon", arch: ["kid","casual"] },
  { ja: "洗濯機が回ってる間だけソロやる縛り", en: "solo runs synced to the washing machine cycle", not: ["kid"] },
  { ja: "夜食ラーメン作りながらマッチング待ち", en: "making midnight ramen while the queue pops", not: ["kid"], ctx: "late" },
  { ja: "仕事の休憩ぜんぶタイムアタックに溶けてる", en: "my work breaks are just time attack now", not: ["kid"], ctx: "day" },
  { ja: "コンビニ行く道でウィークリーの残り数えてた", en: "counted my remaining weekly runs on the walk to the store", not: ["kid"] },
  { ja: "ご飯できたって呼ばれたのに{boss}が第二形態入った", en: "dinner is ready but {boss} just hit phase two", ctx: "evening", w: 2 },
  { ja: "目が乾いてきたから目薬さして続行", en: "eye drops in, run continues" },
  { ja: "眠気と手持ちのピース どっちも限界", en: "my eyelids and my piece tray are both done for", ctx: "night" },
  { ja: "手が滑って一番置きたくない場所に置いた", en: "my finger slipped onto the exact spot I was avoiding", w: 2 },
  { ja: "リロール温存しすぎて使わないまま詰むのやめたい", en: "hoarded my reroll so hard I topped out still holding it", w: 2 },
  { ja: "全消しの音で脳汁出る", en: "the full clear sound is pure dopamine", w: 2 },
  { ja: "お邪魔ライン連打してきた相手のこと一生覚えてる", en: "I will remember the garbage line spammer forever" },
  { ja: "最適配置ひらめいた瞬間に時間切れた", en: "found the perfect placement exactly as the timer hit zero" },
  { ja: "ほしい向きと逆のL字ばっかり来る", en: "every L piece comes mirrored from the one I need" },
  { ja: "詰んでるのに気づくのはいつも1手遅い", en: "I always spot the dead board one move too late" },
  { ja: "ボム温存→盤面事故→使う暇なし いつもの", en: "hoard the bomb, board explodes, never got to use it. every time" },
  { ja: "3x3の穴キープしてたのに最後まで来なかった", en: "kept a 3x3 hole open all game, it never came" },
  { ja: "コンボ続いてる時ほど手汗がやばい", en: "the longer the combo the sweatier my hands" },
  { ja: "惜しかった盤面ほどスクショ撮りがち", en: "the closer the near-miss, the more likely I screenshot it" },
  { ja: "予告マス見えてるのに手が追いつかない", en: "I can see the telegraphed cells, my hands just refuse" },
  { ja: "フィーバー中に限って置きミスする", en: "fever time is when I misplace everything" },
  { ja: "瀕死盤面から全消しで生還した時だけ天才", en: "clutch full clear from a dead board = temporary genius" },
  { ja: "始めて3日ですがもう毎日ログインしてます", en: "day 3 and I haven't missed a login yet", arch: ["newbie"] },
  { ja: "今日はノルマ10戦 終わるまで喋らん", en: "ten game quota today, talk after", arch: ["tryhard"] },
  { ja: "勝ち負けよりブロック積んでる時間が好きかもしれん", en: "honestly the stacking is more fun than the winning", arch: ["casual"] },
  { ja: "ガチャ断ち3日目 えらい", en: "day 3 of no gacha, look at me go", arch: ["gacha"] },
  { ja: "learning japanese one chat message at a time", en: "learning japanese one chat message at a time", arch: ["global"] },
  { ja: "塔100Fの景色いつか絶対見る", en: "one day I'll see the view from floor 100", arch: ["explorer"] },
  { ja: "みんな水分とってね〜 休憩も上達のうちよ", en: "hydrate everyone, resting is part of improving", arch: ["senpai"] },
  { ja: "きょう学校でこのゲームの話でもりあがった！", en: "everyone at school was talking about this game today!", arch: ["kid"] },
  { ja: "配信ない日は逆に落ち着かない", en: "off-stream days feel so weird", arch: ["streamer"], w: 0.7 },
  { ja: "…見てるだけでも楽しい", en: "…just watching is fun too", arch: ["lurker"], w: 0.5 },
  { ja: "無限地獄ラッシュ深度{n}到達 手が震えてる", en: "depth {n} in endless hell rush, hands are shaking", arch: ["tryhard","explorer","nightowl"] },
  { ja: "不死鳥の羽に2回救われた あれ実質勝ち確遺物", en: "phoenix feather revived me twice, that relic is a free win", arch: ["explorer","casual"] },
  { ja: "遺物、火薬と雷どっち取る？", en: "gunpowder or thunder, which relic do you grab?", arch: ["explorer","tryhard","global"] },
  { ja: "2周目入った瞬間ボスのHP倍でラン終わったw", en: "lap 2 doubled the boss hp and my run just died lol", arch: ["casual","explorer"] },
  { ja: "慈悲の遺物、地味だけど一番仕事してる説", en: "the mercy relic looks boring but quietly does the most work", arch: ["senpai","explorer"] },
  { ja: "深度12きた 「地獄を駆ける者」ゲット", en: "depth 12 done, got the hell-runner title", arch: ["tryhard","explorer"], w: 0.7 },
  { ja: "寝る前に1周のつもりの無限地獄ラッシュ、3周してた", en: "\"one quick hell rush before bed\" — three laps later", arch: ["nightowl"], ctx: "late" },
  { ja: "遺物の引き悪くて深度3で終了 かなしい", en: "bad relic rolls, run over at depth 3, sad", arch: ["casual","gacha","newbie"] },
  { ja: "予告マス全部カットしてCOUNTER!出た時の快感やばい", en: "cutting every telegraphed cell for that COUNTER! is the best feeling", w: 2 },
  { ja: "ドラゴンのブレス予告見逃して1行まるごと焼かれた", en: "missed the breath telegraph and a whole row got torched", arch: ["casual","newbie","kid"] },
  { ja: "まおうの呪縛で手札凍ったまま何もできず終わった", en: "the demon king froze my hand and I just watched the run end", arch: ["casual","newbie"] },
  { ja: "エクスマキナの縦レーザー初見殺しすぎでしょ", en: "ex machina's vertical laser is a certified first-timer killer", arch: ["casual","explorer","tryhard"] },
  { ja: "フリオーネの二重呪縛どう捌くのあれ", en: "how are you even supposed to handle frione's double bind", arch: ["tryhard","explorer","nightowl"] },
  { ja: "第二形態で発狂した瞬間の空気変わるのこわい", en: "the air changes the moment phase two enrages, genuinely scary", arch: ["casual","kid","newbie"] },
  { ja: "ゴーレムの大地震で盤面ぐちゃぐちゃにされた", en: "golem earthquake turned my board into soup", arch: ["casual","explorer"] },
  { ja: "スライムキングすらSランク取れないんだが", en: "can't even S rank the slime king, help", arch: ["casual","nightowl"] },
  { ja: "討伐ランクずっとA止まり Sの壁高すぎ", en: "forever stuck at rank A, the S wall is real", arch: ["tryhard","explorer"] },
  { ja: "全ボスSで「完全討伐者」取った 燃え尽きた", en: "S ranked every boss for the perfect-slayer title, I am now retired", arch: ["tryhard","explorer","nightowl"], w: 0.5 },
  { ja: "カットあと一手間に合わなくて直撃もらった", en: "one move short of the cut and ate the full hit" },
  { ja: "ボスのカットは慣れると詰将棋みたいで楽しいよ〜", en: "once cutting boss telegraphs clicks, it plays like a chess puzzle~", arch: ["senpai"] },
  { ja: "月曜のログインは週間報酬の受け取りから始まる", en: "monday login ritual: collect the weekly rewards first", arch: ["morning","casual","lurker"], ctx: "mondayish", w: 2 },
  { ja: "週間王者の🏅つけてる人ロビーで見た オーラある", en: "saw someone with the weekly champ badge in the lobby, instant aura", arch: ["casual","kid","newbie"] },
  { ja: "今週こそ週間王者とる", en: "this week I'm taking weekly champion", arch: ["tryhard"], w: 0.8 },
  { ja: "週間チャレンジ2位でジェム入った 1位の壁は厚い", en: "2nd place weekly gems secured, but 1st is a fortress", arch: ["tryhard","morning","explorer"] },
  { ja: "ジュークボックス、PIXEL RUSH 182でループ固定してる", en: "jukebox permanently locked on PIXEL RUSH 182", arch: ["nightowl","tryhard","streamer"] },
  { ja: "「限界突破」流れると勝手に手が速くなる", en: "when the Limit Break track plays my hands just speed up on their own" },
  { ja: "やすらぎのロビーを作業用BGMにしてる 眠くなる", en: "the lobby theme is my study music now, dangerously sleepy", arch: ["lurker","morning","casual"] },
  { ja: "天国ダンジョンで「天上の光」聴くとちょっと泣きそうになる", en: "Heavenly Light in the heaven dungeon nearly makes me tear up", arch: ["explorer","casual"] },
  { ja: "自分のメッセージにスタンプ3個ついてた ちょっとうれしい", en: "my message got 3 reactions, small win", arch: ["lurker","newbie","casual"] },
  { ja: "名前タップでプロフカード出るの今日知った", en: "today I learned you can tap a name to see the profile card", arch: ["newbie","casual","lurker"] },
  { ja: "返信機能できてから会話追いやすくなったね", en: "conversations got so much easier to follow once replies existed", arch: ["senpai","morning"] },
  { ja: "the auto-translate here is lowkey magic, I can actually talk to everyone", en: "the auto-translate here is lowkey magic, I can actually talk to everyone", arch: ["global"] },
  { ja: "深淵ダンジョン、暗すぎて画面の明るさ上げた", en: "the abyss is so dark I had to turn my brightness up", arch: ["explorer","casual","nightowl"] },
  { ja: "深淵、途中から急に別ゲーになるのやめてほしいw", en: "the abyss turning into a different game halfway down is rude lol", arch: ["explorer","casual"] },
  { ja: "深淵の最深部って何があるの 行った人いる？", en: "what's at the bottom of the abyss? anyone been?", arch: ["explorer","nightowl","casual"] },
  { ja: "ギルドの週間レースあと少しで1位 みんなログインして！", en: "guild race is SO close to 1st, everyone log in!", arch: ["tryhard","senpai","kid"] },
  { ja: "ギルドレベル上がってコインボーナス増えた 入り得すぎる", en: "guild leveled up and the coin bonus went up, join one already", arch: ["casual","gacha","senpai"] },
  { ja: "無言ギルドだけど週間レースだけは全員本気なのすき", en: "silent guild, but everyone goes all in on the weekly race. love that", arch: ["lurker","casual"] },
  { ja: "バトロワ残り10人からの心拍数えぐい", en: "final 10 in battle royale, my heart rate is not ok", arch: ["casual","streamer","nightowl"] },
  { ja: "バトロワ開幕の100人表示、見るだけで圧ある", en: "seeing all 100 players at the start is such a rush", arch: ["newbie","casual","kid"] },
  { ja: "称号「{title}」に付け替えた しっくりきてる", en: "switched my title to {title}, it just fits" },
  { ja: "プロフカードで見た称号がレアすぎて取り方調べてる", en: "saw a title on someone's profile card so rare I'm researching how to get it", arch: ["explorer","casual","gacha"] },
  { ja: "実績コンプまであと{n}個 先は長い", en: "{n} achievements to 100%… the road is long", arch: ["explorer","lurker","tryhard"] },
  { ja: "隠し実績あるらしくて手当たり次第変なことしてる", en: "apparently there are hidden achievements so now I just do weird stuff every run", arch: ["explorer","casual"] },
];
LINES.push(...EXTRA_LINES);

const EXTRA_DIALOGUES = [
  { lang: "ja", lines: [["a", "無限地獄で不死鳥の羽引けた", "got the phoenix feather in Infinite Hell"], ["b", "1回復活のやつか 強い", "the one-revive relic? strong"], ["a", "おかげで深度更新できた", "set a new depth record thanks to it"], ["b", "遺物運も実力よ", "relic luck is a skill too"]], archA: ["explorer","tryhard","nightowl"], archB: ["senpai","explorer"] },
  { lang: "ja", lines: [["a", "無限地獄の2周目、HP倍増きつすぎない？", "loop 2 of Infinite Hell doubles HP, brutal right?"], ["b", "火薬と雷そろえてからが本番", "it really starts once you have powder and lightning"], ["a", "なるほど 遺物ゲーか", "so it's a relic game after all"], ["b", "慈悲も地味に助かる", "mercy quietly saves runs too"]], archA: ["casual","explorer"], archB: ["tryhard","explorer","nightowl"] },
  { lang: "ja", lines: [["a", "予告の赤マス消してCOUNTER!出すの気持ちよすぎる", "clearing the telegraphed red cells for a COUNTER! feels so good"], ["b", "あの音いいよね", "that sound effect is great"], ["a", "全カットで討伐ランクS狙ってる", "going for rank S by cutting every attack"], ["b", "第二形態の発狂からが本番", "phase two enrage is where it really starts"]], archA: ["casual","kid","explorer"], archB: ["tryhard","explorer","senpai"] },
  { lang: "ja", lines: [["a", "エクスマキナの縦レーザーどう対処するの", "how do you deal with Ex Machina's vertical laser?"], ["b", "避けるんじゃなくて予告の列を先に消す", "don't dodge it — clear the telegraphed column first"], ["a", "それが間に合わないんよ…", "that's the part I can't do in time…"], ["b", "細長いピース温存しとくと楽", "saving the long thin pieces makes it easy"]], archA: ["newbie","casual"], archB: ["tryhard","senpai","explorer"] },
  { lang: "ja", lines: [["a", "フリオーネの二重呪縛えげつない", "Furione's double curse is nasty"], ["b", "手札凍ってる間に盤面詰むのよね", "the board clogs up while your hand is frozen"], ["a", "まおうより意地悪じゃん", "meaner than the demon king honestly"], ["b", "凍る前に盤面軽くしとくしかない", "you have to thin the board before the freeze"]], archA: ["casual","nightowl","explorer"], archB: ["tryhard","explorer"] },
  { lang: "ja", lines: [["a", "週間チャレンジ1位いけそう", "I might take #1 in the weekly challenge"], ["b", "週間王者狙い？", "going for weekly champion?"], ["a", "🏅バッジ欲しい 月曜まで逃げ切る", "I want the 🏅 badge — just have to hold until Monday"], ["b", "追い上げるからよろしくw", "I'm coming for you lol"]], archA: ["tryhard","nightowl"], archB: ["casual","tryhard"] },
  { lang: "ja", lines: [["a", "ジュークボックスでPIXEL RUSH 182ループ固定にした", "locked the jukebox on PIXEL RUSH 182 loop"], ["b", "あれテンション上がるよね", "that track hypes me up"], ["a", "作業がはかどりすぎる", "my focus goes way up"], ["b", "おれはやすらぎのロビー派", "I'm a Peaceful Lobby person myself"]], archA: ["casual","streamer","nightowl"], archB: ["casual","morning"] },
  { lang: "ja", lines: [["a", "ねえねえ神AI勝てた？！", "hey hey, did you beat the God AI?!"], ["b", "まだ", "not yet"], ["a", "ぼく創造神やったら3手でまけた！！", "I tried the Creator God and lost in 3 moves!!"], ["b", "創造神はそういうもん", "that's just what the Creator God is"], ["a", "ガチ勢でもむずいんだ！！", "so it's hard even for the pros!!"]], archA: ["kid"], archB: ["tryhard"] },
  { lang: "ja", lines: [["a", "UR狙いで30連した", "did 30 pulls chasing the UR"], ["b", "結果は聞かないほうがいい？", "should I even ask?"], ["a", "SR被り3枚", "three duplicate SRs"], ["b", "昨日のおれと同じで草", "same as me yesterday lol"]], archA: ["gacha"], archB: ["gacha"] },
  { lang: "ja", lines: [["a", "深淵クリアした", "cleared the Abyss"], ["b", "えっ喋った", "wait, they talked"], ["b", "しかも報告がえぐい", "and what a report too"], ["a", "以上", "that is all"]], archA: ["lurker"], archB: ["casual","streamer","kid"] },
  { lang: "ja", lines: [["a", "今夜バトロワ100人配信する 生き残るとこ見せるよ", "streaming the 100-player royale tonight — watch me survive"], ["b", "見る！何時から？！", "watching! what time?!"], ["a", "21時 初手から端で立ち回る予定", "9pm — planning to hug the edge from move one"], ["b", "宿題おわらせて待機します！", "finishing my homework and standing by!"]], archA: ["streamer"], archB: ["kid","casual"] },
  { lang: "ja", lines: [["a", "2v2組も 気楽にやろ", "let's do 2v2, keep it chill"], ["b", "勝ちにいくなら", "only if we play to win"], ["a", "負けても笑えればよくない？w", "isn't losing fine if we get a laugh? lol"], ["b", "よくない", "it is not"], ["a", "そういうとこ好きだよw", "that's what I like about you lol"]], archA: ["casual"], archB: ["tryhard"] },
  { lang: "ja", lines: [["a", "おはよ〜 朝活タイムアタック行くよ〜", "morning~ time for my sunrise time attack~"], ["b", "こっちは今から寝るとこ", "I'm just heading to bed"], ["a", "徹夜？！", "all-nighter?!"], ["b", "ラッシュで深度盛ってたら朝だった", "was farming depth in Rush and suddenly it was morning"]], archA: ["morning"], archB: ["nightowl"], ctx: "morning" },
  { lang: "ja", lines: [["a", "レイドって初心者が行っても迷惑じゃないですか…？", "is it okay for a beginner to join raids…?"], ["b", "全然大丈夫よ〜 ライン消せるだけで戦力なの", "totally fine~ just clearing lines makes you useful"], ["a", "じゃあティアマト行ってみます", "then I'll try Tiamat"], ["b", "初レイドがティアマトは根性あるわね〜", "Tiamat as your first raid — that's brave~"]], archA: ["newbie"], archB: ["senpai"] },
  { lang: "ja", lines: [["a", "この時間の無限地獄がいちばん集中できる", "Infinite Hell at this hour is peak focus"], ["b", "通知も来ないしね", "no notifications either"], ["a", "今日は深度{n}まで潜る", "going down to depth {n} tonight"], ["b", "朝日を見ることになるぞ", "you're going to see the sunrise"]], archA: ["nightowl"], archB: ["nightowl","tryhard"], ctx: "late" },
  { lang: "ja", lines: [["a", "おはよ ログインストリーク{n}日目", "morning — day {n} of my login streak"], ["b", "続いてるね〜", "still going strong~"], ["a", "歯磨きより先にログインしてる", "I log in before brushing my teeth"], ["b", "それはそれでどうなのw", "not sure that's healthy lol"]], archA: ["morning","casual"], archB: ["casual","senpai"], ctx: "morning" },
  { lang: "ja", lines: [["a", "土曜は朝からトーナメント三昧", "Saturday means tournaments all morning"], ["b", "8人戦の連戦きつくない？", "back-to-back 8-player brackets, rough right?"], ["a", "週末しかがっつりできんから", "the weekend is my only real play time"], ["b", "わかる 平日は2戦で寝てる", "same — on weekdays I sleep after 2 games"]], archA: ["casual","tryhard"], archB: ["casual","nightowl"], ctx: "weekend" },
  { lang: "ja", lines: [["a", "{event}の報酬どこまで取った？", "how far are you on the {event} rewards?"], ["b", "まだ半分", "only halfway"], ["a", "期間中に走り切らんと", "gotta finish before it ends"], ["b", "仕事が邪魔すぎる", "work keeps getting in the way"]], ctx: "event" },
  { lang: "ja", lines: [["a", "明日休みだから朝までランクマ回す", "day off tomorrow, ranked till sunrise"], ["b", "レート溶かすやつじゃんそれw", "that's how ratings melt lol"], ["a", "今日は勝てる気がするんよ", "I just feel like I'll win today"], ["b", "フラグやめろw", "stop jinxing it lol"]], archA: ["nightowl","tryhard","casual"], archB: ["casual","nightowl"], ctx: "friday" },
  { lang: "en", lines: [["a", "weekly reset in 2 hours and i'm 300 points off first", "週間リセットまで2時間、1位まであと300点"], ["b", "grind time", "走る時間だ"], ["a", "if i lose the champion title to a last minute snipe i'm done", "最後のスナイプで王者称号取られたら立ち直れない"], ["b", "get in there lol", "行ってこいw"]], archA: ["global"], archB: ["global"] },
];
DIALOGUES.push(...EXTRA_DIALOGUES);

const EXTRA_FEED = [
  { id: "hellrush", icon: "🌋", w: 3, min: 0.5, ja: "{me} が無限地獄ラッシュで深度{n}に到達", en: "{me} reached depth {n} in Infinite Hell Rush" },
  { id: "phoenix", icon: "🪶", w: 2, min: 0.4, ja: "{me} が不死鳥の羽で復活して連戦継続！", en: "{me} revived with the Phoenix Feather and kept the run alive!" },
  { id: "counter", icon: "🛡️", w: 4, min: 0.3, ja: "{me} が {boss} の予告攻撃をカット！COUNTER発動", en: "{me} cut {boss}'s telegraphed attack — COUNTER!" },
  { id: "boss_s", icon: "💮", w: 2, min: 0.55, ja: "{me} が {boss} を討伐ランクSでクリア！", en: "{me} took down {boss} with an S rank!" },
  { id: "exmachina", icon: "⚙️", w: 1.2, min: 0.65, ja: "{me} が機械神エクスマキナを撃破！！", en: "{me} shut down Ex Machina the Machine God!!" },
  { id: "frione", icon: "🧊", w: 1.2, min: 0.65, ja: "{me} が氷雪女王フリオーネを討伐！二重呪縛を突破", en: "{me} melted Frione the Frost Queen!!" },
  { id: "weekly_win", icon: "🎖️", w: 0.5, min: 0.72, ja: "{me} が週間ランキング1位！称号「週間王者」を獲得", en: "{me} finished #1 this week and earned \"Weekly Champion\"!" },
  { id: "abyss", icon: "🕳️", w: 2, min: 0.5, ja: "{me} が深淵に足を踏み入れた…", en: "{me} stepped into the Abyss…" },
  { id: "heaven", icon: "😇", w: 1.5, min: 0.45, ja: "{me} が天国ダンジョンを踏破！", en: "{me} conquered the Heaven dungeon!" },
  { id: "guild", icon: "⚜️", w: 3, min: 0, ja: "{me} がギルドに加入した", en: "{me} joined a guild" },
];
FEED.push(...EXTRA_FEED);

// 新しい返答カテゴリ（住人が新機能の話題に反応できるように）。
const EXTRA_REPLY_CATEGORIES = {
  rush: { ja: ["不死鳥の羽ないと深度二桁きつくない?","2周目のHP倍増からが本番","遺物は火薬と雷が鉄板な気がする","深度12到達した、称号もらえてうれしい","慈悲引いてから急に安定した","遺物の引き運で全部決まる説あるw"], en: ["phoenix feather is a must past depth 10","loop 2 hp scaling is brutal","relic rng decides the whole run tbh"], arch: ["explorer","tryhard","nightowl","senpai","global"] },
  cut: { ja: ["予告マス消してCOUNTER出すの気持ちよすぎ","赤点滅きたら他は全部後回しでいい","ドラゴンのブレスは1行予告だからカット練習に向いてるよ","発狂後は予告さばききれんw","カット決め続けてたらSランク出た","反撃ダメージ入ると一気に楽になるよね"], en: ["countering the telegraph never gets old","red tiles first, everything else can wait","phase 2 telegraphs come way too fast lol"], arch: ["tryhard","senpai","explorer","casual","global"] },
  newboss: { ja: ["エクスマキナの縦レーザー、1列空けとかないと死ぬ","フリオーネの二重呪縛えぐすぎん?","機械神やっとSランク取れた、長かった…","手札2枚凍結はさすがにやりすぎだと思うw","氷雪女王、まおうよりきつい気がする","新ボスどっちもBGM込みでかっこいいのずるい"], en: ["ex machina laser deleted my whole column","double freeze from the ice queen is pure evil","finally got S on the machine god, took forever"], arch: ["explorer","tryhard","senpai","nightowl","streamer","global"] },
  music: { ja: ["PIXEL RUSH 182ずっとループしてるわ","鬼の巣窟のBGM不穏で好き","ジュークボックスのループ固定地味に神機能","やすらぎのロビー流しながら作業してるw","限界突破かかると手が速くなる気がする","天上の光きれいすぎて手が止まる"], en: ["pixel rush 182 on loop all day","the jukebox loop setting is so good","the boss theme goes hard ngl"], arch: ["casual","streamer","nightowl","morning","kid","global"] },
  reward: { ja: ["週間王者の🏅、一回でいいから欲しい","月曜リセット前の駆け込みほんとしんどいw","先週入賞してジェムもらえた","1位の人どんだけやりこんでるんだ…","日曜の夜は順位変動えぐくて見てられない","今週こそ入賞ライン守りたい"], en: ["the weekly champion badge is my dream","got gems for placing last week, not bad","monday reset always sneaks up on me"], arch: ["tryhard","gacha","casual","senpai","morning","global"] },
  sleepy: { ja: ["わかる、おれももう限界","あと1戦だけって言い続けて2時間経った","寝落ちしてサバイバル放置してたことあるw","無理せず寝な〜、ランクマは逃げないよ","眠いときのランクマは事故るからやめとき","おれは寝ない(寝ろ)"], en: ["same, one more game then bed (a lie)","go sleep, ranked will still be here tomorrow","sleepy ranked is how you lose rating"] },
  hungry: { ja: ["わかる、夜食の時間だ","カップ麺待ちの3分でタイムアタックやりがち","腹減ってると全然集中できん","なんか食べてきな〜、盤面は逃げないから","ブロック見てたら豆腐に見えてきた","飯食ってからが本番"], en: ["snack break, then the grind continues","i play the 60s sprint while my noodles cook lol","cant focus on an empty stomach fr"] },
  study: { ja: ["宿題終わらせてからのほうが気楽に遊べるよ〜","テスト前ほどやりたくなるのなんでだろうねw","おれも明日テストなのにここにいる","息抜きは60秒タイムアタック1回だけって決めるといいよ","単語帳とブロック交互にやってる","テストがんばれ！終わったら対戦しよ"], en: ["why is the game 10x more fun before exams lol","good luck on the test! come back after","one sprint per study break, thats the rule"], arch: ["kid","casual","senpai","nightowl","global"] },
};
Object.assign(REPLIES, EXTRA_REPLY_CATEGORIES);

// 対応する話題ルール。REPLY_RULES は先勝ちマッチなので、包括ルールの
// 'question'（末尾）の手前に挿し込む。
const EXTRA_REPLY_RULES = [
  ['rush', new RegExp("地獄ラッシュ|無限地獄|深度|遺物|hell rush|relic|depth", 'i')],
  ['cut', new RegExp("カット|予告|counter|反撃|telegraph", 'i')],
  ['newboss', new RegExp("エクスマキナ|フリオーネ|機械神|氷雪|凍結|呪縛|ex ?machina|ice queen|frione", 'i')],
  ['music', new RegExp("BGM|サウンドトラック|ジュークボックス|曲|music|soundtrack|jukebox|\\bsong\\b", 'i')],
  ['reward', new RegExp("報酬|週間王者|入賞|rewards?|prize", 'i')],
  ['sleepy', new RegExp("眠[いすた]|ねむ|寝落ち|sleepy|zzz|\\btired\\b", 'i')],
  ['hungry', new RegExp("腹減|はらへ|お腹|空腹|夜食|hungry|starving|snack", 'i')],
  ['study', new RegExp("宿題|テスト|試験|勉強|授業|homework|exam|study", 'i')],
];
REPLY_RULES.splice(REPLY_RULES.length - 1, 0, ...EXTRA_REPLY_RULES);

// 既存カテゴリへの返答追加。
const REPLY_ADDITIONS = {
  greeting: { ja: ["おかえり〜","お、きたね！今日も潜る?","ひさしぶり！元気だった?"], en: ["welcome back!","sup! good to see you"] },
  gg: { ja: ["接戦だったね","いい勝負だった！また当たろ","ナイスゲームでした"], en: ["that was close!","rematch sometime?"] },
  laugh: { ja: ["それはw","草生える","おもろw"], en: ["dead 💀","im crying lol"] },
  sad: { ja: ["一旦休憩しよ","その悔しさが伸びしろよ","爆死報告助かる、仲間がいて安心する","そういう日もあるって"], en: ["happens to the best of us","take a break, reset the brain"] },
  battle: { ja: ["2v2なら乗る！","5分後なら行ける","ルームID教えて","負けても泣かない約束ねw"], en: ["im down, custom or ranked?","give me 5 min then lets go"] },
  praise: { ja: ["運が良かっただけw","最後ひやひやだったけどね","その言葉で今日一日がんばれる"], en: ["luck carried me tbh","appreciate it 🙏"] },
  beginner: { ja: ["最初はAI対戦の見習いで練習するといいよ","5連バーの置き場所は常に残しとくと安心","奥義はゲージMAXで⚡押すだけだから使ってみて","焦らなくて大丈夫、みんな最初は下手だった"], en: ["start with the apprentice AI, its chill","always keep a spot for the long bar, trust"] },
  dungeon: { ja: ["天国は逆にピース良すぎて油断する","深淵はまだクリアできる気がしない","塔は50F超えたあたりから景色変わるよね"], en: ["the abyss is on another level of hard","heaven floors sound easy… they are not"] },
  gacha: { ja: ["単発で出たときの脳汁がやばい","10連ぜんぶNだったんだけどw","ラッキーデーまでジェム我慢中","SR止まりの才能ある"], en: ["all N on a 10 pull, im done lol","saving gems for lucky day"] },
  boss: { ja: ["まおうの呪縛中は消せる手を残しとくのが大事","ハデスレイド行く人おる?","ゴーレムの大地震で盤面ぐちゃぐちゃになったw","討伐ランクS狙い始めると立ち回り変わるよね"], en: ["anyone up for the hades raid?","the golem earthquake wrecked my whole board"] },
  coins: { ja: ["ギルドレベル上がるとコインボーナスつくよ","週間チャレンジの報酬も地味にでかい","ログボ切らしたくなくて毎日inだけはしてる"], en: ["guild level bonus adds up","login streaks are basically free money"] },
  rating: { ja: ["1500の壁が厚すぎる","負けが込んだら一回ソロ挟んで整えるといいよ","2v2は相方次第でレート溶けるw","朝は強い人少ない気がする、気のせいかもだけど"], en: ["stuck at the diamond wall, send help","never queue tilted, learned that the hard way"] },
};
for (const [k, add] of Object.entries(REPLY_ADDITIONS)) {
  const spec = REPLIES[k];
  if (!spec) continue;
  spec.ja.push(...add.ja);
  if (add.en.length) (spec.en = spec.en || []).push(...add.en);
}

// 既存リアクションへのセリフ追加。
const REACTION_ADDITIONS = {
  greet_named: { ja: ["{you}さんおかえり","あ、{you}さんだ","{you}さんおつです","{you}さん今日も来たね"], en: ["ayy {you} is here","good to see you {you}"] },
  lost_to: { ja: ["{you}さんに手も足も出なかった","{you}さん何食べたらそんな上手くなるの","完敗です…{you}さん","{you}さんの盤面きれいすぎて参考になる"], en: ["{you} didnt even let me play the game","how are you this good {you}"] },
  beat: { ja: ["{you}さん最後まで分からなかった","ギリ勝ちw {you}さん強くなってない？","{you}さんとの試合は毎回しんどい（いい意味で）"], en: ["that was way too close {you}","good game {you}, you almost had me"] },
  event_start: { ja: ["{event}か、寝れなくなるやつ","イベント初日が一番おいしいんよ","{event}走るぞ〜","いいタイミングでログインしたわ"], en: ["{event}?? cya irl obligations","logged in at the perfect time lol"] },
  poll_voted: { ja: ["直感で{opt}","{opt}以外ありえなくない？","票入れてきた、{opt}で","正直どっちでもいいけど{opt}"], en: ["{opt}, no hesitation","my gut said {opt}"] },
  poll_close: { ja: ["{winner}かあ、僅差だったね","負けた側だけど{winner}も楽しみ","ほら{winner}って言ったじゃん"], en: ["called it, {winner} all the way","my side lost but {winner} works too"] },
  champion: { ja: ["{you}さん決勝の試合えぐかった","大会の{you}さん別人すぎ","優勝{you}さんかー、納得","{you}さん胴上げしたい"], en: ["{you} just won the whole thing??","tournament arc complete, gz {you}"] },
  record: { ja: ["{score}は画面二度見した","{you}さんの伸び方おかしい（称賛）","{score}点とか見たことない数字","{you}さんどんどん記録伸びてくじゃん"], en: ["{score}?? actually insane {you}","new record every week huh {you}"] },
  badge: { ja: ["{badge}ってどうやったら取れるの","{you}さんのプロフィール{badge}で光ってる","{badge}は憧れる"], en: ["{badge} is such a flex {you}","ok now I want {badge} too"] },
  coop_done: { ja: ["{you}さんと息ぴったりだったね","{you}さんが右側処理してくれて助かった","協力たのしー、{you}さんまたやろ","{you}さんナイスフォロー"], en: ["we were so in sync {you}","carried by {you} in co-op lol"] },
};
for (const [k, add] of Object.entries(REACTION_ADDITIONS)) {
  const spec = REACTIONS[k];
  if (!spec) continue;
  spec.ja.push(...add.ja);
  if (add.en.length) (spec.en = spec.en || []).push(...add.en);
}

// ---------------------------------------------------------------------------
// ☢️メルトダウン / 🧬キメラ工房 の語彙（モード差し替えに伴う入れ替え）
// ---------------------------------------------------------------------------

LINES.push(
  { ja: "メルトダウン90%キープで稼ぐの心臓に悪すぎ", en: "farming at 90% heat is terrible for my heart", arch: ["tryhard", "nightowl", "streamer"] },
  { ja: "❄️のライン迷ってる間に熱100いった", en: "hesitated on the coolant line and boom, 100%", arch: ["casual", "newbie"] },
  { ja: "メルトダウン、爆発する瞬間ちょっとクセになる", en: "the moment meltdown blows up is lowkey addictive", arch: ["casual", "kid", "gacha"] },
  { ja: "臨界ボーナス欲張って爆散した 後悔はない", en: "greeded the critical bonus and exploded, zero regrets", arch: ["nightowl", "gacha", "streamer"] },
  { ja: "メルトダウンで初めて×12見た 手が震えた", en: "saw a ×12 multiplier in meltdown, hands were shaking", arch: ["tryhard", "explorer"] },
  { ja: "冷却セル、来てほしい列に限って湧かない", en: "coolant cells never spawn in the column I need", arch: ["casual", "lurker"] },
  { ja: "メルトダウンのアラーム鳴り出すと心拍数上がる", en: "the meltdown alarm spikes my heart rate every time", arch: ["casual", "morning"] },
  { ja: "熱ゼロ安全運転じゃ全然伸びないのよく出来てる", en: "zero-heat safe play scores nothing, and that is good design", arch: ["senpai", "tryhard"] },
  { ja: "キメラ工房で3体合体の怪物つくった", en: "built a triple-monster in the chimera lab", arch: ["casual", "explorer", "kid"] },
  { ja: "15マスキメラを完璧な穴に落とした 気持ちよすぎ", en: "dropped a 15-cell chimera into the perfect hole, bliss", arch: ["tryhard", "explorer"] },
  { ja: "キメラでかくしすぎて置き場なくて詰んだw", en: "made a chimera too big to place anywhere lol", arch: ["casual", "gacha", "kid"] },
  { ja: "溶接は2体まで派 3体はロマン", en: "I weld two, three is for dreamers", arch: ["senpai", "tryhard"] },
  { ja: "キメラ×3で6ライン同時に消えた時の音えぐい", en: "a triple chimera clearing six lines at once sounds insane", arch: ["streamer", "casual"] },
  { ja: "溶接のやり方いま知った ピース同士ドラッグなのね", en: "just learned how welding works, you drag pieces onto each other", arch: ["newbie", "casual"] },
  { ja: "メルトダウンもキメラ工房も中毒性たかい", en: "meltdown and the chimera lab are both way too addicting", arch: ["casual", "global"] },
  { ja: "the chimera lab rewired how I see pieces", en: "the chimera lab rewired how I see pieces", arch: ["global"] },
);

DIALOGUES.push(
  { lang: "ja", lines: [["a", "メルトダウン何点いった？", "what did you score in meltdown?"], ["b", "12万 熱95で回してた", "120k, ran the whole thing at 95% heat"], ["a", "それもう消防士でしょ", "at that point you are a firefighter"], ["b", "燃えてるのは俺の心", "the only thing burning is my heart"]], archA: ["casual", "tryhard"], archB: ["nightowl", "tryhard", "streamer"] },
  { lang: "ja", lines: [["a", "キメラ工房で5連バー2本つないだ", "welded two 5-bars together in the chimera lab"], ["b", "10マス棒！？", "a ten-cell bar?!"], ["a", "置き場なくて死んだ", "nowhere to put it, run over"], ["b", "ロマンの代償w", "the price of ambition lol"]], archA: ["explorer", "casual", "gacha"], archB: ["casual", "senpai"] },
  { lang: "ja", lines: [["a", "❄️消すか稼ぐか毎回悩む", "clear the ❄️ or keep scoring — I agonize every time"], ["b", "悩んでる間に熱上がるのよね", "and the heat climbs while you agonize"], ["a", "それで2回爆発した", "which is how I blew up twice"]], archA: ["casual", "newbie"], archB: ["senpai", "nightowl"] },
);

FEED.push(
  { id: "meltdown", icon: "☢️", w: 4, min: 0.35, ja: "{me} がメルトダウンで熱90%超の臨界プレイ中！", en: "{me} is running critical heat in Meltdown!" },
  { id: "chimera", icon: "🧬", w: 4, min: 0.3, ja: "{me} が{n}体合体のキメラを錬成！", en: "{me} welded a {n}-piece chimera!" },
);

Object.assign(REPLIES, {
  meltdown: { ja: ["熱90キープ勢こわい", "❄️は保険で1個残す派", "爆発した時のスクショ見たい", "臨界ボーナス味しめると戻れないよね", "冷やすタイミングほんとむずい"], en: ["critical farmers are built different", "always keep one coolant in reserve", "the explosion is half the fun"] },
  chimera: { ja: ["3体合体はロマン", "でかくしすぎ注意ね", "完璧な穴に落ちた時の音が最高", "彫ってから溶接する派だな", "×3キメラの破壊力えぐいよ"], en: ["triple monsters are pure ambition", "carve first, then weld", "nothing beats slotting the monster in"] },
});
REPLY_RULES.splice(REPLY_RULES.length - 1, 0,
  ["meltdown", /メルトダウン|臨界|炉心|冷却|meltdown|coolant/i],
  ["chimera", /キメラ|溶接|合体|chimera/i],
);

// ===========================================================================
// v2.6 🧩⛏️ 新モード語彙 + チャット3.0 素材の合流
// 生成コンテンツは chatgen-content.js（ライターパイプライン産・検証済み）。
// 本体テーブルへの追記は常にこの形式で末尾に足す。
// ===========================================================================

LINES.push(...NEWMODE_LINES);
DIALOGUES.push(...NEWMODE_DIALOGUES);
FEED.push(...NEWMODE_FEED);

// 返信プールの大増強: 既存カテゴリは追記、puzzle / dig は新設。
for (const [cat, pools] of Object.entries(REPLY_EXP)) {
  if (REPLIES[cat]) {
    REPLIES[cat].ja.push(...pools.ja);
    REPLIES[cat].en = (REPLIES[cat].en || []).concat(pools.en);
  } else {
    REPLIES[cat] = { ja: pools.ja.slice(), en: pools.en.slice() };
  }
}
// 👑 王座の奪取・戴冠への住民リアクション（{you}=新王者、{board}=ボード名）
REACTIONS.throne = {
  ja: [
    '{you}さんが{board}の王座とったの！？やば',
    'うわ、{board}の1位変わってる…{you}さん強すぎ',
    '{you}さん戴冠おめでとう！！',
    '{board}王者{you}さんか…次は俺が奪う',
    '王座戦えぐいことになってるな',
    '{you}さんの👑見た？本物じゃん',
    '{board}の頂点、ついに動いたか',
    '俺も王座ほしい…毎日ボーナスもらえるんでしょ',
  ],
  en: [
    'wait {you} took the {board} throne?!',
    'the crown moved — gg {you}!',
    'congrats on the coronation {you} 👑',
    'enjoy the throne {you}, I\'m coming for it',
    'throne race is heating up fr',
  ],
};

// 深度/depth は先行する rush ルールが取るので、採掘固有の語だけで判定する
// （\bmine は "mine"(所有代名詞) を誤爆するため不使用）。
REPLY_RULES.splice(REPLY_RULES.length - 1, 0,
  ['puzzle', /パズル|遺跡|ステージ.?[0-9０-９]|puzzle|ruins/i],
  ['dig', /採掘|鉱石|クリスタル|虹鉱石|地層|掘り|掘っ|\bdig\b|mining|\bores?\b/i],
);

// ===========================================================================
// v2.9 👻 幽霊屋敷 — 噂で広まる隠しモードのヒント（決して直接は教えない）
// ===========================================================================

LINES.push(
  { ja: 'メニューのロゴ、じっと見てると数字が浮かぶ気がする…13、とか', en: 'stare at the logo on the menu long enough and a number surfaces… thirteen, maybe', arch: ['nightowl', 'explorer'] },
  { ja: '昨日フレンドが「ロゴを連打してたら消えた」って言ってた。冗談だよね？', en: 'my friend said they vanished after tapping the logo a bunch… joking right?', arch: ['casual', 'kid'] },
  { ja: '👻の実績、うちの実績欄にあるんだけど取り方が分からない', en: 'there is a 👻 achievement in my list and I have no idea how to get it', arch: ['newbie', 'casual', 'gacha'] },
  { ja: '深夜にメニューでカタカタ音がした。空耳だと思いたい', en: 'heard a rattling from the menu late at night. I would like to believe I imagined it', arch: ['nightowl'] },
  { ja: '幽霊屋敷？知らない子ですね…', en: 'the haunted house? never heard of it…', arch: ['lurker', 'senpai'], w: 0.6 },
);

REPLIES.secret.ja.push(
  'ロゴ…13回…いや、なんでもない',
  '👻の実績が見えてるなら、もう半分見つけてるようなものだよ',
  '不吉な数字の回数だけ、って聞いた',
  'メニューで指が疲れるまでタップした人だけが知ってる',
);
REPLIES.secret.en.push(
  'the logo… thirteen… forget I said anything',
  'if you can see the 👻 achievement you are already halfway there',
);

// 📈 昇格への住民リアクション（{you}=昇格者、{tier}=新しい段位名）
REACTIONS.rankup = {
  ja: [
    '{you}さん{tier}昇格おめでとう！！',
    'うわ、{you}さん{tier}いったの！？すご',
    '{tier}帯に{you}さんが来たか…気を引き締めないと',
    '{you}さんの昇格、フィード見て知った。おめ！',
    '次に昇格するのは俺の番ね',
    '{tier}か〜。遠いなあ',
  ],
  en: [
    'congrats on {tier}, {you}!!',
    'wait {you} hit {tier}?! huge',
    'welcome to the {tier} bracket {you}… now I gotta lock in',
    'my promotion is next, calling it',
  ],
};

// ===========================================================================
// 🏷️ 日替わりピックアップショップ（セール）への住人の反応
// ---------------------------------------------------------------------------
// ctx: 'sale' の行は ctx.sale が入っているときだけ出る（CTX_OK）。セール情報が
// まだ供給されていない間はこのグループ全体が沈黙するので、開催していないのに
// 「安くなってる」と言い出す事故は起きない。
// {saleitem} は saleItem() が解決する — セール対象があればその品、無ければ
// 通常のショップ品にフォールバック（throneOnly / gachaOnly は常に除外）。
// ===========================================================================

LINES.push(
  { ja: '今日のセール見た？', en: "did you see today's sale?", ctx: 'sale', w: 2 },
  { ja: '{saleitem}安くなってる、買っちゃおうかな', en: '{saleitem} is on sale… I might just buy it', ctx: 'sale', w: 2 },
  { ja: 'セール品もう買った人いる？', en: 'anyone picked up the sale item yet?', ctx: 'sale' },
  { ja: '{saleitem}この値段なら買いでしょ', en: '{saleitem} at that price is a steal', ctx: 'sale', arch: ['gacha', 'casual', 'streamer'] },
  { ja: 'セール狙いでコイン貯めといてよかった', en: 'so glad I saved my coins for a sale', ctx: 'sale', arch: ['gacha', 'tryhard', 'lurker'] },
  { ja: 'ショップ覗くのが日課になってる', en: 'checking the shop has become a daily ritual', ctx: 'sale', arch: ['morning', 'casual', 'lurker'] },
  { ja: 'セール、明日には変わっちゃうんだよね？急がなきゃ', en: "the sale changes tomorrow right? gotta hurry", ctx: 'sale', arch: ['newbie', 'kid', 'casual'] },
  { ja: '{saleitem}買った！セールありがとう運営', en: 'bought {saleitem}! thanks for the sale 🙏', ctx: 'sale', arch: ['casual', 'gacha', 'kid'] },
  { ja: 'コインが足りない…セールなのに…', en: 'not enough coins… during a sale… pain', ctx: 'sale', arch: ['newbie', 'casual', 'kid', 'gacha'] },
  { ja: '欲しいやつがセールに来るまで粘る', en: "i'm holding out until the one I want goes on sale", ctx: 'sale', arch: ['lurker', 'senpai', 'tryhard'] },
  { ja: 'セールの日はショップ見てるだけで楽しい', en: 'window shopping on sale day is a whole activity', ctx: 'sale', arch: ['casual', 'morning', 'global'] },
  { ja: '割引ぶんでもう1個いけるな…って考えてる時点で負け', en: 'thinking "the discount pays for a second one" is how they get you', ctx: 'sale', arch: ['gacha', 'nightowl', 'streamer'] },
  { ja: 'the daily sale is dangerous for my coin stash', en: 'the daily sale is dangerous for my coin stash', ctx: 'sale', arch: ['global'] },

  // セール情報が無くても成立する汎用のショップ話題（常時候補）。
  { ja: 'ショップ覗いてたら時間溶けた', en: 'lost half an hour just browsing the shop' },
  { ja: 'コイン貯まったのに何買うか決まらない', en: "finally saved up and now I can't decide what to buy", arch: ['casual', 'gacha', 'newbie'] },
  { ja: '欲しいスキンがあると急にコイン稼ぎ頑張れる', en: 'nothing motivates coin farming like wanting a skin', arch: ['casual', 'gacha', 'kid', 'global'] },
);

// セール切り替わり時の速報リアクション用。index.js から
// `battle.crowd.react('shop_sale')` で呼べる。対象品を明示したいときは
// `battle.crowd.react('shop_sale', { saleitem: { name, nameEn } })`。
REACTIONS.shop_sale = {
  ja: [
    'セール更新きてる！',
    '{saleitem}がセール対象じゃん！',
    '今日のセールは当たりだ',
    'セール見てきた、{saleitem}安い',
    'ショップ更新の時間だ〜',
    '今日のセール、狙ってたやつ来るかな',
    'セール品チェックした？',
  ],
  en: [
    'new sale is up!',
    '{saleitem} is on sale today!',
    "today's sale is actually good",
    'shop just rotated, go look',
    'checked the sale — {saleitem} is cheap right now',
  ],
};

// ===========================================================================
// ⛓️連鎖カスケード / 🏗️ブループリント / 🛠️パズル工房 の語彙（第3波の3モード）
// ---------------------------------------------------------------------------
// 追加モードには専用の話題セットを用意する、という🧩遺跡・⛏️採掘場のときの
// 流儀にそろえる。ロビーで誰も口にしないモードは「メニューに増えただけ」に
// 見えるので、仕組みそのもの（重力と倍率／崩壊と★3／共有コードと❤️）から
// ネタを取る。数字は既存スロットだけを使う（{n}=2〜9）。
// ===========================================================================

LINES.push(
  // ⛓️ 連鎖カスケード — 重力・連鎖・倍率
  { ja: '⛓️で{n}連鎖出た瞬間、手が震えた', en: 'my hands shook the moment I hit a {n}-chain in Chain Cascade', arch: ['casual', 'kid', 'streamer'] },
  { ja: '置いたあとブロックが落ちてくの、黙って見ちゃう', en: 'I just sit and watch everything fall after each placement', arch: ['lurker', 'casual', 'explorer'] },
  { ja: 'あと1マス空けて溜めるの、我慢比べすぎる', en: 'holding that last gap to build the chain is pure willpower', arch: ['tryhard', 'senpai'] },
  { ja: '倍率が×64で頭打ちって知ってから組み方変わった', en: 'learned the multiplier caps at ×64 and my whole approach changed', arch: ['tryhard', 'explorer'] },
  { ja: '重力あるだけで完全に別ゲーになるの面白い', en: 'just adding gravity turns it into a completely different game', arch: ['senpai', 'explorer'] },
  { ja: '連鎖狙って積み上げたのに1連鎖で終わって崩れ落ちた', en: 'stacked the whole board for a chain and got exactly one clear', arch: ['casual', 'newbie', 'gacha'] },
  { ja: 'chain cascade is the only mode where the board plays itself', en: 'chain cascade is the only mode where the board plays itself', arch: ['global'] },

  // 🏗️ ブループリント — 日替わりの図面・崩壊・★3
  { ja: '今日の設計図むずくない？崩壊2回した', en: "today's blueprint is rough, I crumbled it twice", arch: ['casual', 'tryhard', 'newbie'] },
  { ja: '列そろえたら作品ごと崩れて声出た', en: 'completed a line and the whole build crumbled — I yelped' },
  { ja: '設計図の外に1マスはみ出しただけで詰むの、こわいけど好き', en: 'one square outside the blueprint and the run is done — terrifying but I love it', arch: ['explorer', 'senpai'] },
  { ja: '崩壊0・90秒以内の★3、やっと取れた', en: 'finally got the 3-star: zero crumbles, under 90 seconds', arch: ['morning', 'tryhard'] },
  { ja: '設計図が👑の日はテンション上がる', en: 'blueprint days with the crown shape just hit different', arch: ['kid', 'casual', 'gacha'] },
  { ja: 'ピースが図面ぴったりぶんしか来ないの、気づいたとき鳥肌立った', en: 'you get exactly enough pieces for the blueprint and nothing more — that realization gave me chills', arch: ['senpai', 'explorer'] },

  // 🛠️ パズル工房 — 共有コード・投稿・❤️
  { ja: '工房、6文字のコードで友達の作品に飛べるの便利すぎる', en: 'six letters and you land straight on your friend\'s workshop stage, so convenient', arch: ['casual', 'newbie'] },
  { ja: '自分の作ったステージに❤️ついてた ちょっとうれしい', en: 'someone hearted the stage I made, small but real joy', arch: ['lurker', 'newbie', 'casual'] },
  { ja: '自分でクリアできた図しか公開されないの、遊ぶ側として安心する', en: 'only stages the author actually solved get published — as a player that is a relief', arch: ['senpai', 'casual'] },
  { ja: '作者の手数に1手も勝てん…', en: "can't beat the author's move count, not even by one", arch: ['tryhard', 'explorer'] },
  { ja: '遊ばれるたびに🪙入るの知って、急に投稿したくなった', en: 'found out you earn coins every time someone plays your stage — suddenly I want to publish', arch: ['gacha', 'casual', 'kid'] },
  { ja: '工房のステージ作ってると、遊ぶより時間溶ける', en: 'building a workshop stage eats more time than playing one', arch: ['explorer', 'nightowl', 'streamer'] },
);

DIALOGUES.push(
  { lang: 'ja', lines: [
    ['a', '⛓️で{n}連鎖出た！手が震えてる', 'got a {n}-chain in Chain Cascade! hands are shaking'],
    ['b', 'どうやって組んだの', 'how did you set it up?'],
    ['a', '上を先に埋めて、落ちたら下が揃うようにした', 'filled the top first so the drop would finish the bottom rows'],
    ['b', 'なるほど、重力に働いてもらうのか', 'ah, you let gravity do the work'],
  ], archA: ['casual', 'kid', 'streamer'], archB: ['tryhard', 'senpai'] },
  { lang: 'ja', lines: [
    ['a', '今日の設計図、★3取れた人いる？', "anyone 3-star today's blueprint?"],
    ['b', '崩壊0で90秒以内でしょ？1回だけ取れた', 'zero crumbles under 90 seconds, right? managed it once'],
    ['a', '列そろえたら崩れるの毎回忘れる', 'I keep forgetting that completing a line makes it crumble'],
    ['b', 'あれ最初は全員やるやつ', 'everyone does that at least once'],
  ], archA: ['casual', 'newbie'], archB: ['senpai', 'tryhard'] },
  { lang: 'ja', lines: [
    ['a', '工房のステージ作ったけど自分で解けなくて投稿できない', 'made a workshop stage but I cannot solve it myself, so I cannot publish it'],
    ['b', '解ける手順を先に決めて、そこから盤面を作るといいよ', 'decide the solution first, then build the board around it'],
    ['a', 'その発想はなかった', 'never thought of that'],
    ['b', '3回作り直しただけ', 'I just rebuilt mine three times'],
  ], archA: ['kid', 'casual', 'gacha'], archB: ['senpai', 'explorer'] },
);

FEED.push(
  { id: 'chain_big', icon: '⛓️', w: 3, min: 0.35, ja: '{me} が連鎖カスケードで{n}連鎖を決めた！', en: '{me} pulled off a {n}-chain in Chain Cascade!' },
  { id: 'blueprint_star3', icon: '🏗️', w: 2, min: 0.45, ja: '{me} が今日の設計図を★3で完成させた', en: "{me} finished today's blueprint with 3 stars" },
  { id: 'workshop_post', icon: '🛠️', w: 2, min: 0, ja: '{me} がパズル工房に自作ステージを投稿した', en: '{me} published a stage in the Puzzle Workshop' },
);

Object.assign(REPLIES, {
  chain: {
    ja: ['落ちたあとに揃うように上から埋めるといいよ', '⛓️は倍率×64で頭打ちだから、そこまで狙えたら十分', '1連鎖で終わると心が折れるよねw', '重力あるとピースの見え方まで変わる', 'あと1マス我慢するかどうかの勝負だと思ってる'],
    en: ['fill the top so the drop finishes the bottom rows', 'the multiplier caps at ×64, so anything past that is style', 'one-chain endings hurt lol'],
  },
  blueprint: {
    ja: ['列を揃えたら崩れるから、はみ出しに気をつけて', '★3は崩壊0＋90秒以内だよ', '今日の図面、地味に難しかった', 'ピースは図面ぴったりぶんしか来ないから、1マスも無駄にできない', '崩壊するとこっちの心も崩れる'],
    en: ['never complete a line — the build crumbles', '3 stars means zero crumbles under 90 seconds', "today's shape was sneaky hard"],
  },
  workshop: {
    ja: ['コード貼ってくれたら遊びに行くよ', '自分でクリアできた図しか公開されないから安心して挑んでいい', '作者の手数に勝てたためしがない', '❤️送っておいた', '投稿するとプレイされるたびにコイン入るのいいよね'],
    en: ['drop the code and I will play it', 'every published stage was cleared by its author first', 'beating the author par is another game entirely'],
  },
});
// 'puzzle' ルールの正規表現が「パズル工房」を先に拾ってしまうので、この3つは
// その手前に差し込む（REPLY_RULES は先勝ちマッチ）。'puzzle' が見つからない
// 場合だけ従来どおり包括ルールの手前へ。
// 「連鎖」単体は日替わりフラグ『連鎖の日』(コンボ2倍) でも使われる語なので、
// ⛓️モードだと分かる語形だけを拾う。
{
  const NEW3_RULES = [
    ['chain', /連鎖カスケード|カスケード|⛓️|[0-9０-９]+連鎖|chain ?cascade/i],
    ['blueprint', /設計図|ブループリント|blueprint/i],
    ['workshop', /パズル工房|工房のステージ|ワークショップ|workshop/i],
  ];
  const at = REPLY_RULES.findIndex(r => r[0] === 'puzzle');
  REPLY_RULES.splice(at >= 0 ? at : REPLY_RULES.length - 1, 0, ...NEW3_RULES);
}
