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
import { SHOP_ITEMS, BOSSES, TITLES } from './catalog.js';
import { ACHIEVEMENTS } from './achievements.js';

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

function cosmeticName() {
  const pool = SHOP_ITEMS.filter(i => !i.default && !i.adminOnly && i.cat !== 'ult');
  return pick(pool).name;
}

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
    case 'floor': v = Math.max(2, Math.min(100, (st ? st.dungeonMax : 20) + rint(-6, 3))); break;
    case 'rating': v = st ? st.rating : 1000; break;
    case 'level': v = st ? st.level : 5; break;
    case 'tier': v = st ? st.tier : tierOf(1000); break;
    case 'n': v = rint(2, 9); break;
    case 'wave': v = st ? Math.max(3, st.survivalWave + rint(-3, 2)) : 8; break;
    case 'combo': v = r ? Math.max(3, Math.round(3 + r.skill * 12 + rint(-1, 1))) : 6; break;
    case 'score': v = r ? Math.round((4000 + r.skill * r.skill * 60000) / 100) * 100 + rint(0, 99) * 10 : 12000; break;
    case 'sprint': v = r ? Math.round((1500 + r.skill * r.skill * 14000) / 100) * 100 : 6000; break;
    case 'event': v = ctx.event ? ctx.event.name : null; break;
    case 'ai': v = r ? Math.min(3, Math.floor(r.skill * 4.2)) : 1; break;
    case 'name': {
      const others = (ctx.active || []).filter(x => !r || x.id !== r.id);
      v = others.length ? pick(others).name : null;
      break;
    }
    case 'you': v = null; break;
    case 'opt': v = ctx.poll && ctx.poll.options && ctx.poll.options.length ? pick(ctx.poll.options).text : ''; break;
    case 'winner': v = ''; break;
    case 'item': v = cosmeticName(); break;
    case 'boss': v = pick(BOSSES).name; break;
    case 'title': v = pick(TITLES).name; break;
    case 'ach': v = pick(ACHIEVEMENTS); break;
    case 'question': v = ctx.poll ? ctx.poll.question : ''; break;
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
    case 'score': case 'sprint': return Number(v).toLocaleString('en-US');
    case 'event': return v === null ? (L ? 'the event' : 'イベント') : String(v);
    case 'name': return v === null ? (L ? 'someone' : '誰か') : String(v);
    case 'you': return v === null ? (L ? 'you' : 'きみ') : String(v);
    case 'ach': return v && typeof v === 'object' ? (L ? v.nameEn : v.name) : String(v);
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
  { ja: '通勤前に1戦だけ', ctx: 'morning', not: ['kid'] },
  { ja: '朝ウィークリー消化した', ctx: 'morning' },
  { ja: 'こんにちは〜', en: 'hi all', ctx: 'day', w: 2 },
  { ja: '昼休みブロック', ctx: 'day', not: ['kid'] },
  { ja: '学校終わった！やるぞ！', ctx: 'day', arch: ['kid'] },
  { ja: 'こんばんは！', en: 'evening!', ctx: 'evening', w: 3 },
  { ja: 'ただいま〜', ctx: 'evening' },
  { ja: 'ごはん食べたら{mode}やる', ctx: 'evening' },
  { ja: '深夜組いる？', en: 'night crew here?', ctx: 'night', w: 2 },
  { ja: 'あと1戦だけ…', en: 'one more game…', ctx: 'night', w: 2 },
  { ja: 'こんな時間まで誰がいるのw', ctx: 'late' },
  { ja: '眠れないからブロック', en: "can't sleep so… blocks", ctx: 'late' },
  { ja: '深夜テンションで{mode}', ctx: 'late', arch: ['nightowl', 'tryhard'] },
  { ja: 'おやすみ〜', en: 'good night all', ctx: 'night', w: 2 },
  { ja: '寝落ちしそう', ctx: 'late' },
  { ja: '週末だ！ガチる！', ctx: 'weekend', arch: ['tryhard', 'casual', 'explorer'] },
  { ja: '休日ブロック最高', ctx: 'weekend' },
  { ja: '花金！今日は遅くまでやる', ctx: 'friday', not: ['kid'] },
  { ja: 'ウィークリー更新きたね', ctx: 'mondayish', w: 2 },
  { ja: '今週のウィークリーむずくない？', ctx: 'mondayish' },
  { ja: '月曜つらい…ブロックで癒される', ctx: 'mondayish', not: ['kid'] },

  // --- generic play chatter ---
  { ja: '誰か対戦しよ！', en: 'anyone up for a match?', w: 2, arch: ['tryhard', 'casual', 'kid', 'senpai', 'global'] },
  { ja: '1v1こない？', en: '1v1 anyone?', arch: ['tryhard', 'nightowl', 'global'] },
  { ja: 'gg', en: 'gg', w: 3 },
  { ja: 'ggでした！', en: 'ggwp', w: 2 },
  { ja: 'さっきの人強かった…', en: 'that last opponent was cracked', w: 2 },
  { ja: 'リベンジさせて！', arch: ['tryhard', 'kid', 'casual'] },
  { ja: '自己ベスト更新！{score}点！', en: 'new best score! {score}!', w: 2 },
  { ja: 'コンボ{combo}いった！', en: 'just hit a {combo} combo!', w: 2 },
  { ja: 'コンボ切れた瞬間の絶望感', en: 'nothing hurts like losing a combo' },
  { ja: '2連続全消しキタ━━━', arch: ['casual', 'kid', 'gacha', 'streamer'] },
  { ja: 'あと1マスで全消しだった…', en: 'ONE cell away from a full clear…' },
  { ja: '3x3ブロック来なさすぎ', en: 'where are my 3x3 blocks' },
  { ja: '角を空けるの大事だね', arch: ['senpai', 'tryhard', 'explorer'] },
  { ja: '縦消し派？横消し派？', arch: ['casual', 'senpai'] },
  { ja: 'ブロック綺麗に消えると気持ちいい', en: 'clean line clears are so satisfying' },
  { ja: '今日は{mode}やりこむ', en: 'grinding {mode} today', w: 2 },
  { ja: '{mode}と{mode2}どっちやろ', arch: ['casual', 'explorer'] },
  { ja: 'レート{rating}まで来た', en: 'up to {rating} rating', arch: ['tryhard', 'nightowl', 'senpai', 'global'] },
  { ja: '{tier}帯から抜け出せない…', en: 'stuck in {tier} forever', arch: ['casual', 'newbie', 'nightowl', 'global'] },
  { ja: '{tier}に上がった！', en: 'promoted to {tier}!', arch: ['tryhard', 'casual', 'nightowl'] },
  { ja: '連勝中🔥', en: 'on a win streak 🔥', arch: ['tryhard', 'streamer', 'nightowl'] },
  { ja: '5連敗つらい', en: 'lost 5 in a row… pain', arch: ['casual', 'newbie', 'kid'] },
  { ja: 'レートまた溶けた', arch: ['tryhard', 'nightowl'] },
  { ja: '連勝ボーナスおいしい', arch: ['tryhard', 'casual'] },
  { ja: 'ランキング入りたい', en: 'I want to make the leaderboard', arch: ['casual', 'newbie', 'kid'] },
  { ja: '今週こそランキング入る', arch: ['casual', 'explorer'] },

  // --- modes ---
  { ja: 'ダンジョン{floor}Fで全滅した…', en: 'wiped on dungeon F{floor}…', arch: ['explorer', 'casual', 'newbie', 'nightowl'], w: 2 },
  { ja: 'ダンジョンのボス強すぎw', en: 'the dungeon boss is brutal', arch: ['explorer', 'casual', 'kid'] },
  { ja: '{floor}F到達！', en: 'reached F{floor}!', arch: ['explorer', 'tryhard'] },
  { ja: '地下ダンジョン怖すぎw', arch: ['explorer', 'casual', 'kid'] },
  { ja: '天界ダンジョン綺麗すぎて泣いた', en: 'the heaven dungeon is gorgeous', arch: ['explorer', 'casual'] },
  { ja: 'シールドの強化ほんと強い', arch: ['explorer', 'senpai'] },
  { ja: 'サバイバルWAVE{wave}まで行った', en: 'made it to wave {wave} in survival', arch: ['explorer', 'nightowl', 'casual'] },
  { ja: 'サバイバルの加速えぐい', en: 'survival mode goes so fast', arch: ['casual', 'explorer'] },
  { ja: 'ボスラッシュ2体目で死んだ', arch: ['explorer', 'casual'] },
  { ja: 'レイドボス硬すぎない？', en: 'the raid boss is a tank', arch: ['explorer', 'casual', 'senpai'] },
  { ja: 'レイド行く人いる？', en: 'anyone for a raid?', arch: ['explorer', 'senpai', 'casual'] },
  { ja: '魔王まで倒した！', arch: ['explorer', 'tryhard', 'kid'] },
  { ja: 'トーナメント優勝したった！！', en: 'won the tournament!!', arch: ['tryhard', 'streamer'], w: 0.6 },
  { ja: 'トーナメント決勝で負けた…悔しい', en: 'lost the tourney final… so close', arch: ['tryhard', 'nightowl'] },
  { ja: 'バトロワ上位入った！', en: 'top 5 in battle royale!', arch: ['streamer', 'tryhard', 'nightowl'] },
  { ja: 'バトロワ最初の足切りで消えた', arch: ['casual', 'newbie', 'kid'] },
  { ja: 'タイムアタック60秒で{sprint}点', en: '{sprint} in the 60s time attack', arch: ['tryhard', 'morning', 'lurker', 'global'] },
  { ja: 'タイムアタック中毒になりそう', en: 'time attack is too addicting', arch: ['morning', 'casual'] },
  { ja: '協力プレイたのしい！相棒ありがとう', en: 'co-op is so fun, ty partner', arch: ['casual', 'kid', 'senpai', 'global'] },
  { ja: '協力で相棒が置いたピースで全消しした', arch: ['casual', 'senpai'] },
  { ja: '協力プレイで相棒落ちたけどサーバーが代打してくれた', arch: ['casual', 'explorer'] },
  { ja: '2v2誰か組も！', en: '2v2 anyone?', arch: ['casual', 'tryhard', 'kid'] },
  { ja: 'チーム戦たのしい', en: 'team battles are fun', arch: ['casual', 'kid'] },
  { ja: 'カオスモードまたやりたい', arch: ['casual', 'gacha', 'streamer'], ctx: 'noevent' },
  { ja: 'ウィークリー3位まで来た！', arch: ['tryhard', 'morning'] },
  { ja: 'ウィークリーはピース運ゲーすぎるw', arch: ['casual', 'morning', 'lurker'] },
  { ja: '鬼AIに勝てた！', en: 'finally beat the Oni AI!', arch: ['tryhard', 'explorer', 'nightowl'] },
  { ja: '{ai}AIとちょうどいい勝負になる', arch: ['casual', 'newbie'] },
  { ja: '神って隠し難易度あるらしいよ', arch: ['streamer', 'casual', 'nightowl'], w: 0.6 },

  // --- ultimates / items / shop / gacha ---
  { ja: '奥義ゲージ溜まった瞬間が一番楽しい', en: 'charging the ultimate gauge is the best part', w: 2 },
  { ja: '神の裁きで盤面消えるの爽快すぎ', en: 'divine judgement wiping the board is so satisfying', arch: ['tryhard', 'streamer', 'gacha'] },
  { ja: 'オーバードライブ中にコンボつなぐと化ける', arch: ['tryhard', 'senpai'] },
  { ja: 'レインボーハンド神', arch: ['casual', 'newbie', 'kid'] },
  { ja: '奥義どれ装備してる？', en: 'which ultimate are you running?', arch: ['casual', 'newbie', 'global'] },
  { ja: '時間停止でボス封じるの強い', arch: ['explorer', 'senpai'] },
  { ja: 'ミニブロック神アイテムすぎる', arch: ['casual', 'explorer'] },
  { ja: 'フィーバー強すぎw', arch: ['casual', 'kid'] },
  { ja: 'ボム使うタイミングむずい', arch: ['newbie', 'casual'] },
  { ja: 'ガチャSSR出たあああ', en: 'SSR from the gacha!!!', arch: ['gacha', 'casual', 'kid'], w: 2 },
  { ja: 'ガチャ爆死した😭', en: 'gacha ate all my coins 😭', arch: ['gacha', 'casual'], w: 2 },
  { ja: '10連で{item}出た！', en: 'pulled {item} on a 10-pull!', arch: ['gacha', 'casual'] },
  { ja: 'UR引いた人見たことない', arch: ['gacha'] },
  { ja: 'コイン貯めては溶かしてる', arch: ['gacha'] },
  { ja: '{item}買った！かっこいい', en: 'bought {item}, looks great', arch: ['casual', 'gacha', 'kid'] },
  { ja: 'スキン何使ってる？', en: 'what skin are you all using?', arch: ['casual', 'newbie', 'gacha'] },
  { ja: '雪のステージ癒される', arch: ['casual', 'morning'] },
  { ja: 'エフェクトかっこいい', en: 'the clear effects are so cool', arch: ['newbie', 'kid', 'casual'] },
  { ja: 'BGMすき', en: 'love the music in this game', arch: ['casual', 'morning', 'global'] },
  { ja: 'バトルパス何ティアまでいった？', arch: ['casual', 'gacha'] },
  { ja: '称号かっこいいのほしい', arch: ['casual', 'kid'] },
  { ja: 'ミッション全部終わった！', en: 'finished all my missions!', w: 2 },
  { ja: 'デイリーミッションのボーナスおいしい', arch: ['casual', 'gacha', 'morning'] },
  { ja: '実績「{ach}」解除した', en: 'unlocked "{ach}"', w: 1.5 },
  { ja: '実績まとめて受け取ったらコインえぐい増えた', arch: ['casual', 'gacha'] },
  { ja: '連続ログイン{n}日目', en: 'day {n} login streak', arch: ['morning', 'casual', 'lurker'] },
  { ja: '戦績ダッシュボードのグラフ見るの楽しい', arch: ['tryhard', 'lurker', 'morning'] },

  // --- newbie / kid / senpai flavor ---
  { ja: '今日から始めました！', en: 'just started today!', arch: ['newbie'], w: 2 },
  { ja: 'はじめて10分の初心者です', arch: ['newbie'] },
  { ja: '初心者におすすめの立ち回りある？', en: 'any tips for a beginner?', arch: ['newbie'] },
  { ja: '効率いいコイン稼ぎ教えて', arch: ['newbie', 'kid'] },
  { ja: 'リロールって1回しか使えないの？', arch: ['newbie'] },
  { ja: '奥義ってどうやって撃つの？', arch: ['newbie', 'kid'] },
  { ja: 'やっとLv{level}になった', en: 'hit level {level}', arch: ['newbie', 'casual'] },
  { ja: 'ぼくがいちばんつよい！', arch: ['kid'] },
  { ja: 'ママにあと10分って言われた', arch: ['kid'] },
  { ja: '宿題おわったからやる！', arch: ['kid'], ctx: 'evening' },
  { ja: 'ボスたおした！！', arch: ['kid'] },
  { ja: '初心者さんいたら教えるよ〜', arch: ['senpai'] },
  { ja: '角から埋めると詰みにくいよ', arch: ['senpai'] },
  { ja: 'わからんことあったら聞いてね', arch: ['senpai'] },
  { ja: '今日も平和ですね', arch: ['senpai', 'lurker', 'morning'] },
  { ja: '配信中！来てね', arch: ['streamer'], w: 0.7 },
  { ja: '今日の配信はバトロワ縛り', arch: ['streamer'], w: 0.5 },
  { ja: '見てる人ありがとう〜', arch: ['streamer'], w: 0.5 },
  { ja: '…', arch: ['lurker'], w: 0.5 },
  { ja: 'ROM専だけど今日は挨拶だけ', arch: ['lurker'], w: 0.5 },

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
  { ja: '投票バナー光ってて草', ctx: 'poll' },
  { ja: '「{question}」悩む', ctx: 'poll' },
];

const CTX_OK = (line, ctx) => {
  if (!line.ctx) return true;
  switch (line.ctx) {
    case 'event': return !!ctx.event;
    case 'noevent': return !ctx.event;
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

// A fresh line for this resident. customLines (admin) are mixed in.
export function composeLine(r, ctx, customLines = []) {
  if (customLines.length && rnd() < 0.35) return stylize(fill(pick(customLines), r, ctx), r);
  const pool = eligibleLines(r, ctx);
  if (!pool.length) return stylize(r.lang === 'en' ? 'gg' : 'こんにちは〜', r);
  const line = weightedLine(pool, r, ctx);
  const tpl = r.lang === 'en' ? line.en : line.ja;
  return stylize(fill(tpl, r, ctx), r);
}

// ---------------------------------------------------------------------------
// Dialogues: short exchanges between two residents
// ---------------------------------------------------------------------------
// roles: 'a' / 'b'. archA / archB constrain who can play each role.

const DIALOGUES = [
  { lang: 'ja', lines: [['a', '誰か{mode}いかない？'], ['b', 'いくいく'], ['a', '部屋建てたよ'], ['b', 'おけ！']], archA: ['casual', 'tryhard', 'kid', 'senpai'] },
  { lang: 'ja', lines: [['a', 'ダンジョン{floor}Fで死んだ…'], ['b', 'そこ鬼門よな'], ['a', 'シールド取っとけばよかった'], ['b', '次はいける']], archA: ['explorer', 'casual', 'newbie'], archB: ['explorer', 'senpai', 'nightowl'] },
  { lang: 'ja', lines: [['a', '今週のウィークリーむずくない？'], ['b', 'ピース運わるすぎ'], ['a', 'あと2000点で自己べなのに'], ['b', 'がんば']], ctx: 'mondayish' },
  { lang: 'ja', lines: [['a', '初心者なんですけど何から始めればいいですか？'], ['b', 'まずソロで角を埋める練習がおすすめ！'], ['a', 'ありがとうございます！'], ['b', 'わからんことあったら聞いてね']], archA: ['newbie', 'kid'], archB: ['senpai', 'tryhard', 'explorer'] },
  { lang: 'ja', lines: [['a', 'ガチャ10連した'], ['b', '結果は？'], ['a', 'コインだけ…'], ['b', '爆死仲間がここにも']], archA: ['gacha', 'casual', 'kid'], archB: ['gacha', 'casual'] },
  { lang: 'ja', lines: [['a', 'ガチャで{item}出た！'], ['b', 'まじか！いいなあ'], ['a', '装備して自慢する']], archA: ['gacha', 'casual', 'kid'] },
  { lang: 'ja', lines: [['a', 'レート{rating}なった'], ['b', 'つよ'], ['a', '{tier}帯キープしたい'], ['b', '対戦しよ']], archA: ['tryhard', 'nightowl'], archB: ['tryhard', 'senpai', 'nightowl'] },
  { lang: 'ja', lines: [['a', '奥義どれ使ってる？'], ['b', '神の裁き一択'], ['a', 'ジェムたりない…'], ['b', '浄化の波動もコスパいいよ']], archA: ['casual', 'newbie'], archB: ['tryhard', 'senpai', 'explorer'] },
  { lang: 'ja', lines: [['a', 'レイド行く？'], ['b', '行く！'], ['a', 'ハデス出たら泣く'], ['b', 'クラーケン来い']], archA: ['explorer', 'senpai'], archB: ['explorer', 'casual', 'tryhard'] },
  { lang: 'ja', lines: [['a', '協力プレイ誰か組も'], ['b', '組む！'], ['a', 'お互いの置き方で全消し狙お'], ['b', 'いいね']], archA: ['casual', 'senpai', 'kid'] },
  { lang: 'ja', lines: [['a', 'タイムアタック60秒で{sprint}点いった'], ['b', 'はや'], ['a', '3分のほうが伸びる気がする'], ['b', '集中力もたんw']], archA: ['tryhard', 'morning', 'global'], archB: ['casual', 'tryhard', 'lurker'] },
  { lang: 'ja', lines: [['a', 'サバイバルWAVE{wave}で埋まった'], ['b', 'そこから加速えぐいよね'], ['a', '不落の城塞装備していけばよかった']], archA: ['explorer', 'casual', 'nightowl'] },
  { lang: 'ja', lines: [['a', 'コンボ{combo}いった！'], ['b', 'えぐ'], ['b', '動画見たい'], ['a', '配信で見せるわ']], archA: ['streamer'], archB: ['casual', 'kid', 'tryhard'] },
  { lang: 'ja', lines: [['a', 'もう寝る…'], ['b', 'おやすみ〜'], ['a', 'おやすみ']], ctx: 'night' },
  { lang: 'ja', lines: [['a', 'おはよ'], ['b', 'おはようございます'], ['a', '朝ウィークリー行ってくる']], ctx: 'morning' },
  { lang: 'ja', lines: [['a', '{event}きてる！'], ['b', 'やるしかない'], ['a', '今日は寝れん']], ctx: 'event' },
  { lang: 'ja', lines: [['a', '投票どれにした？'], ['b', '{opt}'], ['a', 'おれもそれ']], ctx: 'poll' },
  { lang: 'ja', lines: [['a', 'ママに怒られるからおちる！'], ['b', 'またね〜'], ['a', 'ばいばい！']], archA: ['kid'], ctx: 'evening' },
  { lang: 'ja', lines: [['a', 'さっき{name}さんに負けた'], ['b', 'あの人強いよね'], ['a', 'リベンジしたい']], archA: ['tryhard', 'casual', 'nightowl'] },
  { lang: 'ja', lines: [['a', 'ミッション全部終わった'], ['b', 'はや'], ['a', 'コンプボーナスまで取った'], ['b', 'うらやま']] },
  { lang: 'en', lines: [['a', 'anyone up for ranked?'], ['b', 'queueing now'], ['a', 'see you there']], archA: ['global'], archB: ['global'] },
  { lang: 'en', lines: [['a', 'the raid boss is brutal'], ['b', 'bring the fortress ultimate'], ['a', 'oh that actually works?'], ['b', 'trust me']], archA: ['global'], archB: ['global'] },
  { lang: 'en', lines: [['a', 'good night all'], ['b', 'night!']], archA: ['global'], archB: ['global'] },
  { lang: 'en', lines: [['a', 'just hit {tier} rank!'], ['b', 'gz!'], ['a', 'took me forever']], archA: ['global'], archB: ['global'] },
];

function fits(r, roles) { return !roles || roles.includes(r.arch); }

// Returns [{ resident, text, delay }] or null when the cast is too thin.
export function composeDialogue(ctx) {
  const active = ctx.active || [];
  if (active.length < 2) return null;
  const pool = DIALOGUES.filter(d => CTX_OK(d, ctx) && active.some(r => r.lang === d.lang));
  if (!pool.length) return null;
  for (let tries = 0; tries < 6; tries++) {
    const d = pick(pool);
    const cands = active.filter(r => r.lang === d.lang);
    const as = cands.filter(r => fits(r, d.archA));
    if (!as.length) continue;
    const a = pick(as);
    const bs = cands.filter(r => r.id !== a.id && fits(r, d.archB));
    if (!bs.length) continue;
    const b = pick(bs);
    let delay = 0;
    const ctxB = { ...ctx, active: active.filter(r => r.id !== b.id) };
    return d.lines.map(([role, tpl]) => {
      const r = role === 'a' ? a : b;
      delay += 3000 + rnd() * 9000;
      return { resident: r, text: stylize(fill(tpl, r, role === 'a' ? ctx : ctxB), r), delay };
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

const RAID_NAMES = ['深海のクラーケン', '魔竜ティアマト', '冥王ハデス'];

export function composeFeed(ctx) {
  const active = ctx.active || [];
  if (!active.length) return null;
  for (let tries = 0; tries < 8; tries++) {
    const total = FEED.reduce((a, f) => a + f.w, 0);
    let x = rnd() * total;
    let f = FEED[FEED.length - 1];
    for (const c of FEED) { x -= c.w; if (x <= 0) { f = c; break; } }
    const cands = active.filter(r => r.skill >= f.min && (!f.newbie || archetype(r.arch).newbie));
    if (!cands.length) continue;
    const r = pick(cands);
    const extra = {};
    if (f.id === 'raid') extra.boss = pick(RAID_NAMES);
    const ctxOthers = { ...ctx, active: active.filter(x => x.id !== r.id) };
    const cache = {};   // same numbers in both languages
    return {
      id: f.id, icon: f.icon, at: ctx.now, real: false,
      text: fill(f.ja, r, ctxOthers, extra, cache),
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

export const BADGE_NAMES = {
  oni: '鬼討伐バッジ', kami: '神殺しバッジ', souzou: '創造神討伐バッジ', maou: '魔王討伐バッジ',
  rush: 'ボスラッシュ制覇', dungeon: '百塔踏破', tourney: '大会優勝', royale: 'バトロワ1位',
};

// Pick one or more residents to react. Returns [{ resident, text, delay }].
export function composeReaction(kind, ctx, extra = {}, count = 1) {
  const active = ctx.active || [];
  if (!active.length) return [];
  const out = [];
  const used = new Set();
  let delay = 4000 + rnd() * 10000;
  for (let i = 0; i < count; i++) {
    const cands = active.filter(r => !used.has(r.id) && (!extra.only || extra.only.includes(r.id)) && r.chatty > 0.3);
    if (!cands.length) break;
    const r = pick(cands);
    used.add(r.id);
    // Event reactions get a type-specific flavour line about half the time.
    let pool = REACTIONS[kind];
    if (kind === 'event_start' && ctx.event && REACTIONS[`event_${ctx.event.type}`] && rnd() < 0.55) {
      pool = REACTIONS[`event_${ctx.event.type}`];
    }
    if (!pool) break;
    const lines = (r.lang === 'en' && pool.en) ? pool.en : pool.ja;
    out.push({ resident: r, text: stylize(fill(pick(lines), r, ctx, extra), r), delay });
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

// Returns [{ resident, text, delay }]. `residents` = currently active cast.
export function chooseReplies(text, ctx) {
  const t = String(text || '').trim();
  if (!t) return [];
  const active = (ctx.active || []).filter(r => r.chatty > 0.3);
  if (!active.length) return [];
  const lang = /[ぁ-んァ-ヶ一-龠ー]/.test(t) ? 'ja' : 'en';

  // Mentioned residents always answer.
  const mentioned = active.filter(r => r.name.length >= 2 && t.includes(r.name));

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
  if (mentioned.length) {
    const r = mentioned[0];
    used.add(r.id);
    const lines = (r.lang === 'en' && spec.en) ? spec.en : spec.ja;
    out.push({ resident: r, text: stylize(fill(pick(lines), r, ctx), r), delay: 2500 + rnd() * 5000 });
  }
  const r1 = pickResident(used);
  if (r1) {
    used.add(r1.id);
    const first = pick(pool);
    out.push({ resident: r1, text: stylize(fill(first, r1, ctx), r1), delay: (out.length ? out[0].delay : 0) + 3500 + rnd() * 8500 });
    // Sometimes a second voice chimes in.
    if (rnd() < 0.28) {
      const r2 = pickResident(used);
      if (r2) {
        const pool2 = rnd() < 0.5 ? pool : ((lang === 'en' && REPLIES.generic.en) || REPLIES.generic.ja);
        let second = pick(pool2);
        if (second === first) second = REPLIES.generic.ja[0];
        out.push({ resident: r2, text: stylize(fill(second, r2, ctx), r2), delay: out[out.length - 1].delay + 4000 + rnd() * 7000 });
      }
    }
  }
  return out;
}

export { tierOf };
