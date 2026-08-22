// Chat auto-translation (JA ⇄ EN).
//
// No API key needed: a phrase table + a gaming vocabulary handles the kind of
// short messages a game lobby produces ("gg", "誰か対戦しよ", "ダンジョン40Fで
// 死んだ"). Resident lines come from ja/en template pairs, so those translate
// perfectly; real players' free text gets a best-effort phrase/word mapping
// and is labelled as machine-translated on the client.
//
// Set TRANSLATE_URL to a LibreTranslate-compatible endpoint to use a real
// engine instead (the table stays as the fallback when it is slow or down).

const EXTERNAL = String(process.env.TRANSLATE_URL || '').trim();
const EXTERNAL_KEY = String(process.env.TRANSLATE_KEY || '').trim();

export function detectLang(text) {
  return /[ぁ-んァ-ヶ一-龠ー]/.test(String(text)) ? 'ja' : 'en';
}

// --- phrase table (exact / substring matches, longest first) ---------------

const PHRASES = [
  ['こんにちは', 'hello'], ['こんばんは', 'good evening'], ['おはようございます', 'good morning'], ['おはよう', 'morning'],
  ['よろしくお願いします', 'nice to meet you'], ['よろしく', 'nice to meet you'], ['はじめまして', 'nice to meet you'],
  ['ただいま', "I'm back"], ['おやすみなさい', 'good night'], ['おやすみ', 'good night'], ['またね', 'see you'],
  ['お疲れさまでした', 'good game, thanks'], ['お疲れさま', 'gg, thanks'], ['おつかれ', 'gg'], ['おつ', 'gg'],
  ['ありがとうございます', 'thank you'], ['ありがとう', 'thanks'], ['あざす', 'thx'], ['ごめん', 'sorry'], ['すみません', 'sorry'],
  ['誰か対戦しよ', 'anyone up for a match'], ['対戦しよ', "let's battle"], ['対戦しない？', 'wanna battle?'],
  ['1v1こない？', '1v1 anyone?'], ['誰か', 'anyone'], ['いく人', 'anyone going'], ['行く人', 'anyone going'],
  ['組も', "let's team up"], ['組まない？', 'wanna team up?'], ['部屋建てた', 'made a room'], ['部屋建てる', "I'll make a room"],
  ['コード送る', "I'll send the code"], ['ルームコード', 'room code'],
  ['強すぎ', 'way too strong'], ['つよすぎ', 'way too strong'], ['強い', 'strong'], ['つよい', 'strong'], ['つよ', 'strong'],
  ['上手い', 'skilled'], ['うまい', 'skilled'], ['うますぎ', 'so skilled'], ['すごい', 'awesome'], ['すげー', 'wow'], ['やばい', 'insane'], ['やば', 'insane'],
  ['ナイス', 'nice'], ['ないす', 'nice'], ['えぐい', 'insane'], ['えぐ', 'insane'], ['神', 'godlike'],
  ['リベンジさせて', 'rematch me'], ['リベンジ', 'rematch'], ['もう一回', 'one more'], ['もう一戦', 'one more game'],
  ['負けた', 'I lost'], ['まけた', 'I lost'], ['勝った', 'I won'], ['かった', 'I won'], ['引き分け', 'draw'],
  ['自己ベスト更新', 'new personal best'], ['自己ベスト', 'personal best'], ['自己べ', 'personal best'], ['新記録', 'new record'],
  ['コンボ切れた', 'lost my combo'], ['コンボ', 'combo'], ['全消し', 'full clear'], ['ライン消し', 'line clear'],
  ['盤面埋まった', 'board filled up'], ['埋まった', 'filled up'], ['死んだ', 'died'], ['全滅した', 'got wiped'], ['全滅', 'wiped'],
  ['初心者です', "I'm a beginner"], ['初心者', 'beginner'], ['今日から始めました', 'just started today'], ['始めたばかり', 'just started'],
  ['おすすめ', 'recommended'], ['教えて', 'tell me'], ['教えてください', 'please tell me'], ['どうやって', 'how do I'], ['どうやったら', 'how do I'],
  ['稼ぎ', 'farming'], ['稼げる', 'can earn'], ['貯まらない', "can't save up"], ['貯まらん', "can't save up"],
  ['ランクマ', 'ranked'], ['ランクマッチ', 'ranked'], ['チーム戦', 'team battle'], ['トーナメント', 'the tournament'], ['バトロワ', 'battle royale'],
  ['バトルロイヤル', 'battle royale'], ['レイド', 'the raid'], ['協力プレイ', 'co-op'], ['協力', 'co-op'], ['ボス戦', 'boss battle'], ['ボスラッシュ', 'boss rush'],
  ['ダンジョン', 'the dungeon'], ['地下', 'underground'], ['天国', 'heaven'], ['深淵', 'the abyss'], ['ウィークリー', 'the weekly'],
  ['タイムアタック', 'time attack'], ['サバイバル', 'survival'], ['カオス', 'chaos mode'], ['ソロ', 'solo'], ['AI戦', 'VS AI'],
  ['カスタムルーム', 'custom room'], ['ガチャ', 'gacha'], ['爆死', 'gacha fail'], ['10連', '10-pull'], ['単発', 'single pull'],
  ['スキン', 'skin'], ['ボード', 'board'], ['エフェクト', 'effect'], ['バトルパス', 'battle pass'], ['称号', 'title'], ['実績', 'achievement'],
  ['ミッション', 'mission'], ['デイリー', 'daily'], ['奥義', 'ultimate'], ['アルティメット', 'ultimate'], ['ゲージ', 'gauge'], ['必殺技', 'ultimate'],
  ['神の裁き', 'Divine Judgement'], ['オーバードライブ', 'Overdrive'], ['レインボーハンド', 'Rainbow Hand'], ['浄化の波動', 'Purifying Wave'],
  ['時間停止', 'Time Stop'], ['不落の城塞', 'Fortress'], ['メテオストライク', 'Meteor Strike'], ['破壊の衝撃波', 'Shockwave'],
  ['フィーバー', 'fever'], ['ボム', 'bomb'], ['クリーナー', 'cleaner'], ['ミニブロック', 'mini blocks'], ['リロール', 'reroll'],
  ['お邪魔ブロック', 'garbage blocks'], ['お邪魔', 'garbage'], ['ブロック', 'blocks'], ['ピース', 'pieces'], ['盤面', 'board'],
  ['レート', 'rating'], ['ランク', 'rank'], ['ブロンズ', 'Bronze'], ['シルバー', 'Silver'], ['ゴールド', 'Gold'], ['プラチナ', 'Platinum'], ['ダイヤ', 'Diamond'], ['マスター', 'Master'],
  ['連勝', 'win streak'], ['連敗', 'losing streak'], ['勝利', 'win'], ['敗北', 'loss'], ['優勝', 'won the tournament'], ['1位', '#1'],
  ['コイン', 'coins'], ['ジェム', 'gems'], ['レベル', 'level'], ['経験値', 'XP'], ['報酬', 'rewards'], ['ボーナス', 'bonus'],
  ['イベント', 'event'], ['投票', 'vote'], ['開催中', 'is on'], ['終わった', 'ended'], ['始まった', 'started'], ['きた', 'is here'],
  ['楽しい', 'fun'], ['たのしい', 'fun'], ['面白い', 'fun'], ['おもしろい', 'fun'], ['難しい', 'hard'], ['むずい', 'hard'], ['むずかしい', 'hard'],
  ['簡単', 'easy'], ['かんたん', 'easy'], ['つらい', 'rough'], ['つらみ', 'rough'], ['眠い', 'sleepy'], ['ねむい', 'sleepy'], ['疲れた', 'tired'],
  ['休憩', 'break'], ['落ちます', 'logging off'], ['落ちる', 'logging off'], ['寝る', 'going to sleep'], ['風呂', 'bath'], ['ご飯', 'dinner'],
  ['今日', 'today'], ['明日', 'tomorrow'], ['昨日', 'yesterday'], ['今週', 'this week'], ['週末', 'weekend'], ['深夜', 'late night'], ['朝', 'morning'], ['夜', 'night'],
  ['みんな', 'everyone'], ['俺', 'I'], ['おれ', 'I'], ['私', 'I'], ['わたし', 'I'], ['自分', 'I'], ['あなた', 'you'], ['さん', ''],
  ['何時', 'what time'], ['何人', 'how many people'], ['いる？', 'here?'], ['いますか', 'anyone here?'], ['ある？', 'is there?'],
  ['できた', 'did it'], ['できない', "can't"], ['わからない', "don't know"], ['わからん', 'no idea'], ['わかる', 'I get it'], ['それな', 'true that'],
  ['たしかに', 'true'], ['まじで', 'seriously'], ['まじ', 'seriously'], ['ほんと', 'really'], ['本当', 'really'], ['うそ', 'no way'], ['草', 'lol'],
  ['笑', 'lol'], ['泣', 'crying'], ['がんばれ', 'good luck'], ['がんばる', "I'll do my best"], ['頑張る', "I'll do my best"], ['いいね', 'nice'],
  ['好き', 'love it'], ['すき', 'love it'], ['最高', 'the best'], ['かっこいい', 'cool'], ['かわいい', 'cute'], ['きれい', 'beautiful'], ['綺麗', 'beautiful'],
  ['買った', 'bought'], ['買う', 'will buy'], ['欲しい', 'want'], ['ほしい', 'want'], ['出た', 'got it'], ['当たった', 'pulled it'],
  ['到達', 'reached'], ['階', 'F'], ['点', ' pts'], ['人', ' players'], ['回', ' times'], ['秒', 's'], ['分', 'min'], ['時間', 'h'],
  ['です', ''], ['ます', ''], ['ました', ''], ['ですね', ''], ['だね', ''], ['かな', '?'], ['けど', ' but'], ['でも', ' but'], ['から', ' so'],
  ['また', 'again'], ['まだ', 'still'], ['もう', 'already'], ['すぐ', 'soon'], ['ちょっと', 'a bit'], ['とても', 'very'], ['めっちゃ', 'super'], ['超', 'super'],
  ['稼ぎ方', 'how to earn'], ['稼ぐ', 'earn'], ['溜まった', 'charged'], ['溜まる', 'charges'], ['瞬間', 'moment'], ['一番', 'the most'], ['気持ちいい', 'satisfying'],
  ['上がった', 'went up'], ['下がった', 'went down'], ['勝てた', 'beat it'], ['倒した', 'beat'], ['倒せない', "can't beat"], ['行こう', "let's go"], ['行く', 'going'],
  ['やろう', "let's do it"], ['待って', 'wait'], ['来て', 'come'], ['見て', 'look'], ['やばすぎ', 'insanely good'], ['おめでとう', 'congrats'], ['おめ', 'gz'], ['乙', 'gg'],
  ['了解', 'roger'], ['おけ', 'ok'], ['りょ', 'ok'], ['なるほど', 'I see'], ['へー', 'oh'], ['ふむ', 'hmm'], ['ウェーブ', 'wave'], ['フロア', 'floor'], ['残機', 'lives'],
  ['ギルド', 'guild'], ['メンバー', 'members'], ['リーダー', 'leader'], ['参加', 'join'], ['脱退', 'leave'], ['募集', 'recruiting'], ['歓迎', 'welcome'],
];

// English → Japanese (a separate list: natural phrasing, not a mirror).
const PHRASES_EN = [
  ['good morning', 'おはよう'], ['good evening', 'こんばんは'], ['good night', 'おやすみ'], ['good game', 'ナイスゲーム'], ['nice to meet you', 'よろしく'],
  ['hello everyone', 'みんなこんにちは'], ['hi everyone', 'みんなこんにちは'], ['hello', 'こんにちは'], ['hi all', 'みんなこんにちは'], ['hi', 'やあ'], ['hey', 'やあ'], ['yo', 'よう'],
  ['ggwp', 'ggでした'], ['gg', 'gg'], ['well played', 'ナイスプレイ'], ['nice one', 'ナイス'], ['nice', 'ナイス'], ['thanks', 'ありがとう'], ['thank you', 'ありがとう'], ['thx', 'あざす'], ['ty', 'あざす'],
  ['sorry', 'ごめん'], ['see you', 'またね'], ['bye', 'ばいばい'], ['brb', 'ちょっと離席'], ['afk', '離席中'], ['lol', 'w'], ['lmao', '草'], ['haha', 'はは'],
  ['anyone up for', '誰か一緒に'], ['anyone for', '誰か'], ['anyone', '誰か'], ['wanna', 'しない？'], ["let's go", '行こう'], ['lets go', '行こう'], ["let's", 'しよう'],
  ['rematch', 'リベンジ'], ['one more', 'もう一回'], ['1v1', '1v1'], ['team up', '組もう'], ['queue', 'マッチング'], ['queueing', 'マッチング中'],
  ['ranked', 'ランクマ'], ['team battle', 'チーム戦'], ['tournament', 'トーナメント'], ['battle royale', 'バトロワ'], ['raid', 'レイド'], ['co-op', '協力プレイ'], ['coop', '協力プレイ'],
  ['boss battle', 'ボス戦'], ['boss rush', 'ボスラッシュ'], ['boss', 'ボス'], ['dungeon', 'ダンジョン'], ['abyss', '深淵'], ['weekly', 'ウィークリー'], ['time attack', 'タイムアタック'],
  ['survival', 'サバイバル'], ['chaos', 'カオス'], ['solo', 'ソロ'], ['custom room', 'カスタムルーム'], ['room code', 'ルームコード'], ['gacha', 'ガチャ'],
  ['skin', 'スキン'], ['battle pass', 'バトルパス'], ['achievement', '実績'], ['mission', 'ミッション'], ['ultimate', '奥義'], ['gauge', 'ゲージ'], ['fever', 'フィーバー'],
  ['garbage', 'お邪魔ブロック'], ['blocks', 'ブロック'], ['block', 'ブロック'], ['pieces', 'ピース'], ['piece', 'ピース'], ['board', '盤面'], ['combo', 'コンボ'],
  ['full clear', '全消し'], ['line clear', 'ライン消し'], ['rating', 'レート'], ['rank', 'ランク'], ['win streak', '連勝'], ['streak', '連続'],
  ['personal best', '自己ベスト'], ['new best', '自己ベスト更新'], ['new record', '新記録'], ['high score', 'ハイスコア'], ['score', 'スコア'], ['points', '点'],
  ['coins', 'コイン'], ['gems', 'ジェム'], ['level', 'レベル'], ['xp', '経験値'], ['rewards', '報酬'], ['event', 'イベント'], ['vote', '投票'], ['poll', '投票'],
  ['beginner', '初心者'], ['newbie', '初心者'], ['just started', '始めたばかり'], ['tips', 'コツ'], ['how do i', 'どうやって'], ['how to', 'どうやって'], ['how', 'どう'],
  ['what', '何'], ['where', 'どこ'], ['when', 'いつ'], ['who', '誰'], ['why', 'なぜ'], ['which', 'どれ'],
  ['strong', '強い'], ['too strong', '強すぎ'], ['cracked', '強すぎ'], ['insane', 'やばい'], ['crazy', 'やばい'], ['awesome', 'すごい'], ['amazing', 'すごい'], ['wow', 'すご'],
  ['fun', '楽しい'], ['addicting', '中毒性ある'], ['addictive', '中毒性ある'], ['hard', '難しい'], ['difficult', '難しい'], ['easy', '簡単'], ['brutal', 'えぐい'], ['rough', 'つらい'],
  ['tired', '疲れた'], ['sleepy', '眠い'], ['break', '休憩'], ['logging off', '落ちます'], ['going to sleep', '寝る'],
  ['i lost', '負けた'], ['lost', '負けた'], ['i won', '勝った'], ['won', '勝った'], ['draw', '引き分け'], ['died', '死んだ'], ['wiped', '全滅した'],
  ['love', '好き'], ['like', '好き'], ['best', '最高'], ['cool', 'かっこいい'], ['cute', 'かわいい'], ['beautiful', 'きれい'], ['music', 'BGM'], ['bgm', 'BGM'],
  ['today', '今日'], ['tomorrow', '明日'], ['tonight', '今夜'], ['weekend', '週末'], ['morning', '朝'], ['night', '夜'], ['late', '遅い'],
  ['everyone', 'みんな'], ['anyone here', '誰かいる？'], ['is here', 'いる'], ['here', 'ここ'], ['please', 'お願い'], ['pls', 'お願い'],
  ['good luck', 'がんばれ'], ['gl', 'がんばれ'], ['hf', '楽しんで'], ['same', '同じ'], ['same here', '自分も'], ['me too', '自分も'], ['true', 'たしかに'], ['fr', 'まじで'],
  ['really', 'ほんと'], ['seriously', 'まじで'], ['no way', 'うそ'], ['yes', 'うん'], ['yeah', 'うん'], ['yep', 'うん'], ['no', 'いや'], ['nope', 'いや'], ['ok', 'おけ'], ['okay', 'おけ'],
  ['again', 'また'], ['still', 'まだ'], ['already', 'もう'], ['soon', 'すぐ'], ['now', '今'], ['very', 'とても'], ['so', 'すごく'], ['super', '超'],
  ['reached', '到達'], ['floor', '階'], ['wave', 'ウェーブ'], ['got', 'ゲット'], ['pulled', '引いた'], ['bought', '買った'], ['want', '欲しい'], ['need', '必要'],
  ['players', '人'], ['player', 'プレイヤー'], ['game', 'ゲーム'], ['games', 'ゲーム'], ['match', '試合'], ['opponent', '相手'], ['partner', '相棒'], ['friend', 'フレンド'],
  ['and', 'と'], ['with', 'と'], ['for', 'のため'], ['the', ''], ['a', ''], ['an', ''], ['is', ''], ['are', ''], ['am', ''], ['i', '自分'], ['you', 'あなた'], ['my', '自分の'], ['your', 'あなたの'],
  ['this', 'この'], ['that', 'その'], ['it', 'それ'], ['in', 'で'], ['on', 'で'], ['to', 'に'], ['of', 'の'], ['at', 'で'], ['from', 'から'], ['up', ''],
  ['were', 'だった'], ['was', 'だった'], ['get', 'ゲット'], ['more', 'もっと'], ['all', 'みんな'], ['just', 'ちょうど'], ['hit', '到達'], ['reach', '到達'], ['finally', 'ついに'],
  ['first', '初'], ['time', '時間'], ['congrats', 'おめでとう'], ['gz', 'おめ'], ['wait', '待って'], ['come', '来て'], ['look', '見て'], ['go', '行く'], ['play', '遊ぶ'],
  ['playing', 'プレイ中'], ['win', '勝つ'], ['lose', '負ける'], ['help', '助けて'], ['tip', 'コツ'], ['tricks', 'コツ'], ['someone', '誰か'], ['people', '人'],
  ['omg', 'まじか'], ['ez', '楽勝'], ['rip', '南無'], ['pog', 'すご'], ['guild', 'ギルド'], ['members', 'メンバー'], ['leader', 'リーダー'], ['join', '参加'], ['leave', '脱退'],
  ['recruiting', '募集中'], ['welcome', 'ようこそ'], ['lives', '残機'], ['floor', '階'], ['boss fight', 'ボス戦'],
];

const JA_SORTED = PHRASES.slice().sort((a, b) => b[0].length - a[0].length);
const EN_MAP = new Map(PHRASES_EN.map(([en, ja]) => [en.toLowerCase(), ja]));
const EN_MULTI = PHRASES_EN.filter(([en]) => en.includes(' ')).sort((a, b) => b[0].length - a[0].length);

// Trailing chat quirks (w, 草, ！, emoji) are kept as-is on the end.
function splitTail(text) {
  const m = String(text).match(/^(.*?)([wｗ笑草！!?？…〜~。、\s\p{Extended_Pictographic}]*)$/su);
  return m ? [m[1], m[2]] : [text, ''];
}

function jaToEn(text) {
  const [body, tail] = splitTail(text);
  let out = '';
  let i = 0;
  while (i < body.length) {
    let hit = null;
    for (const [ja, en] of JA_SORTED) {
      if (body.startsWith(ja, i)) { hit = [ja, en]; break; }
    }
    if (hit) {
      if (hit[1]) out += (out && !out.endsWith(' ') && !/^[\s,.!?']/.test(hit[1]) ? ' ' : '') + hit[1];
      i += hit[0].length;
    } else {
      const ch = body[i];
      // untranslated Japanese runs are dropped from the English line only if
      // they are particles; everything else (numbers, latin, names) passes through
      if (/[0-9A-Za-z\s.,!?'"#%&()+:;<=>@\[\]^_`{|}~\-]/.test(ch)) out += ch;
      else if (!/[はがをにでとのもねよ]/.test(ch)) out += ch;
      i++;
    }
  }
  out = out.replace(/！/g, '!').replace(/？/g, '?').replace(/、/g, ', ').replace(/。/g, '. ')
    .replace(/\s+/g, ' ').replace(/\s+([,.!?])/g, '$1').trim();
  return (out + tail.replace(/[wｗ]+/g, ' lol').replace(/草/g, ' lol').replace(/笑/g, ' lol').replace(/！/g, '!').replace(/？/g, '?')).replace(/\s+/g, ' ').trim();
}

const MARK = '';   // wraps already-translated multi-word phrases

function enToJa(text) {
  const [body, tail] = splitTail(String(text));
  let lower = body.toLowerCase();
  // multi-word phrases first
  for (const [en, ja] of EN_MULTI) {
    const re = new RegExp(`\\b${en.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'gi');
    lower = lower.replace(re, `${MARK}${ja}${MARK}`);
  }
  const parts = lower.split(new RegExp(`(${MARK}[^${MARK}]*${MARK}|\\s+|[,.!?;:]+)`)).filter(x => x !== undefined && x !== '');
  let out = '';
  const push = (str, latin) => {
    // keep a space between two untranslated latin words ("just hit gold")
    if (latin && /[A-Za-z0-9]$/.test(out)) out += ' ';
    out += str;
  };
  for (const p of parts) {
    if (p.startsWith(MARK)) { push(p.slice(1, -1), false); continue; }
    if (/^\s+$/.test(p)) continue;
    if (/^[,.!?;:]+$/.test(p)) { out += p.replace(/,/g, '、').replace(/\./g, '。').replace(/!/g, '！').replace(/\?/g, '？'); continue; }
    const w = p.replace(/^[^a-z0-9']+|[^a-z0-9']+$/g, '');
    if (!w) { out += p; continue; }
    if (EN_MAP.has(w)) push(EN_MAP.get(w), false);
    else push(w, true);   // names, numbers, unknown slang: keep as-is
  }
  return (out + tail.replace(/lol/gi, 'w')).trim();
}

// Local table translation — synchronous and instant.
export function translateLocal(text, to) {
  const from = detectLang(text);
  if (from === to) return null;
  const out = to === 'en' ? jaToEn(text) : enToJa(text);
  if (!out || out === String(text).trim()) return null;
  return { lang: to, text: out, engine: 'table' };
}

// Optional real engine (LibreTranslate-compatible): POST {q, source, target}.
async function translateExternal(text, from, to) {
  if (!EXTERNAL) return null;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 2500);
  try {
    const r = await fetch(EXTERNAL, {
      method: 'POST', signal: ctrl.signal,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ q: text, source: from, target: to, format: 'text', ...(EXTERNAL_KEY ? { api_key: EXTERNAL_KEY } : {}) }),
    });
    if (!r.ok) return null;
    const d = await r.json();
    const out = d.translatedText || (d.data && d.data.translations && d.data.translations[0] && d.data.translations[0].translatedText);
    return out ? { lang: to, text: String(out), engine: 'api' } : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// Translate a chat line into the other language. Resolves to
// { lang, text, engine } or null when nothing useful could be produced.
export async function translateChat(text) {
  const from = detectLang(text);
  const to = from === 'ja' ? 'en' : 'ja';
  const ext = await translateExternal(text, from, to);
  if (ext) return ext;
  return translateLocal(text, to);
}

export const TRANSLATE_ENGINE = EXTERNAL ? 'api' : 'table';
