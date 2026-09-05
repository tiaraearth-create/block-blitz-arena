// ---------------------------------------------------------------------------
// 遊び方（ルール）
//
// なぜ作ったか
//   実際に友達に遊んでもらったところ「2ライン同時消しで相手を攻撃できる」を
//   まったく知らないまま終わった。調べたら当然で、**このゲームにはルールを
//   説明する場所が1つも無かった**:
//     ・初回チュートリアルは4ステップだけ、しかも1人用モードでしか動かない
//       （modes.js の TUT_MODES）。攻撃の話は一度も出てこない。
//     ・オンライン対戦の選択画面はボタンが8個並ぶだけで説明文ゼロ。
//     ・「遊び方」「ヘルプ」に相当する画面が存在しない。
//   しかもモードによってルールが違う（攻撃があるのは一部だけ）のに、
//   その違いがどこにも書かれていなかった。
//
// このファイルの役割
//   ルールの「内容」だけをここに集める。画面の作りからは独立させてあるので、
//   ・メニューの「遊び方」画面
//   ・オンライン対戦の選択画面に出す1行説明
//   ・試合中の実地ガイド
//   のどれからでも同じ文言を引ける。**数字を直すときはここ1か所**で済む。
//
// ⚠️ 数字は実装から写したもの。ズレたら嘘を教えることになるので、
//    変更するときは必ず出典（下記）と突き合わせること。
//    ・得点とコンボ … public/js/engine.js の place()
//    ・攻撃の量     … server/battle.js の attackCells()
//    test/rules.test.mjs がこの2つの一致を機械的に見張っている。
// ---------------------------------------------------------------------------

import { t } from './i18n.js';

// ---------------------------------------------------------------------------
// 攻撃の量（server/battle.js の attackCells と同じ式）
//
//   function attackCells(lines, combo) {
//     if (lines < 2) return 0;
//     const base = lines >= 4 ? 6 : lines === 3 ? 4 : 2;
//     return Math.min(9, base + Math.min(3, Math.floor(combo / 3)));
//   }
//
// クライアントで再現しているのは「これから何個送れるか」を先に見せるため。
// 実際に送る量を決めるのは**サーバー**（ここでの計算は表示専用）。
// ---------------------------------------------------------------------------
export function attackCellsFor(lines, combo = 0) {
  if (lines < 2) return 0;
  const base = lines >= 4 ? 6 : lines === 3 ? 4 : 2;
  return Math.min(9, base + Math.min(3, Math.floor(combo / 3)));
}

// 得点（engine.js の place() と同じ式）。
// 置いたマス1個につき1点＋ラインを消したら lineCount² × 100 × コンボ倍率。
export function comboMult(streak) {
  return 1 + 0.5 * Math.max(0, streak - 1);
}
export function lineScore(lineCount, streak = 1) {
  if (lineCount <= 0) return 0;
  return Math.round(lineCount * lineCount * 100 * comboMult(streak));
}

// ---------------------------------------------------------------------------
// オンライン対戦の1行説明
//
// 選択画面のボタンの下に出す。「押す前に何が起きるか分かる」ことがすべてなので、
// 雰囲気ではなく**ルールそのもの**を書く。
//
// ⚠️ 内部の呼び名について
//   サーバーとテストは 'duel'（攻撃なし）と 'attack'（攻撃あり）という名前を
//   使っている。表の名前だけを入れ替えると混乱するので、**内部名はそのまま**にし、
//   プレイヤーに見せる名前だけをここで決める:
//     attack → 「1v1 ランクマッチ」（対戦の本流。攻撃あり）
//     duel   → 「クラシック」（攻撃なしのスコア勝負）
// ---------------------------------------------------------------------------
export const ONLINE_MODES = [
  {
    kind: 'attack',
    icon: 'mode_online',
    name: () => t('1v1 ランクマッチ', '1v1 Ranked'),
    line: () => t('2ライン同時消しで相手の盤面にお邪魔ブロックを送り込む、殴り合いの1対1。',
      'Head-to-head duel: clear 2+ lines at once to dump garbage on your opponent.'),
    tag: () => t('対戦の本流', 'The main event'),
    rated: true,
  },
  {
    kind: 'duel',
    icon: 'mode_sprint',
    name: () => t('クラシック', 'Classic'),
    line: () => t('攻撃なし。まったく同じピースが両者に配られる、純粋なスコア勝負。',
      'No attacks. Both players get the exact same pieces — pure score contest.'),
    tag: () => t('静かな勝負', 'Quiet duel'),
    rated: true,
  },
  {
    kind: 'team',
    icon: 'friends',
    name: () => t('2v2 チーム戦', '2v2 Team Battle'),
    line: () => t('2人組のスコア合計で勝負。人数が足りなければ自動で埋まる。',
      'Two-on-two: the higher combined score wins. Empty seats are filled automatically.'),
    rated: false,
  },
  {
    kind: 'tourney',
    icon: 'mode_tourney',
    name: () => t('トーナメント（8人制）', 'Tournament (8 players)'),
    line: () => t('準々決勝→準決勝→決勝の勝ち抜き。負けたらそこで終わり。',
      'Quarters, semis, final. One loss and you are out.'),
    rated: false,
  },
  {
    kind: 'royale',
    icon: 'mode_royale',
    name: () => t('バトルロイヤル（100人）', 'Battle Royale (100 players)'),
    // 脱落しても観戦に移れる（server/battle.js の royale_result が
    // spectate:true を返し、生き残りの盤面が royale_state で届き続ける）。
    // 「脱落＝画面が終わる」と思って抜けてしまう人がいたので1行に足す。
    line: () => t('100人で最後の1人を目指す。2ライン同時消しで誰かを攻撃できる。脱落してもそのまま観戦できる。',
      '100 players, last one standing. Clearing 2+ lines attacks someone here too — and you can keep watching after you are out.'),
    rated: false,
  },
  {
    kind: 'raid',
    icon: 'mode_raid',
    name: () => t('レイドボス戦（協力）', 'Raid Boss (co-op)'),
    line: () => t('最大4人で1体のボスを削る協力戦。スコアがそのままダメージ。',
      'Up to four players chip down one boss. Your score is your damage.'),
    rated: false,
  },
  {
    kind: 'coop',
    icon: 'mode_coop',
    name: () => t('協力プレイ（2人で1盤面）', 'Co-op (2 players, 1 board)'),
    line: () => t('1つの盤面を2人で交互に操作。相棒が落ちても最後まで遊べる。',
      'Two players take turns on a single board. It keeps going even if your partner drops.'),
    rated: false,
  },
  {
    kind: 'custom',
    icon: 'mode_room',
    name: () => t('カスタムルーム', 'Custom Room'),
    // 定員は server/battle.js の ROOM_MAX（=8）。対戦席（1v1なら2・2v2なら4）
    // からあふれた人は観戦席に座る ── 以前は対戦席ぶんしか入れず、5人で
    // 集まると3人が入室すらできなかった。ここは「何人で集まれるか」を
    // 知りたくて読む行なので、席の内訳より先に定員を書く。
    line: () => t('4文字の合言葉で最大16人まで集合。対戦する人数もホストが決められる（1v1は2〜16人、2v2チームは2〜16人）。対戦席からあふれた人は観戦席で見られる。',
      'Gather up to 16 friends with a 4-letter code. The host also picks how many actually play (2–16 for 1v1 and for 2v2 teams). Anyone past the playing seats watches from the stands.'),
    rated: false,
  },
];

export function onlineModeLine(kind) {
  const m = ONLINE_MODES.find(x => x.kind === kind);
  return m ? m.line() : '';
}

/**
 * プレイヤーに見せるモード名（内部名 → 表の名前）。
 *
 * 試合前の対戦カード（modes.js の showVersusCard）が「いま何の試合なのか」を
 * 1語で出すために引く。名前を画面側で手書きすると、ここの表と2つになった
 * 瞬間に「選択画面ではクラシック、試合前はデュエル」という食い違いが出る
 * ── 内部名 'duel' がそのまま出ていたのが元の状態だった。
 * 知らない kind（AI戦の 'ai' など）では空文字を返すので、呼ぶ側は
 * 「あれば出す」で書けばよい。
 */
export function onlineModeName(kind) {
  const m = ONLINE_MODES.find(x => x.kind === kind);
  return m ? m.name() : '';
}

// ---------------------------------------------------------------------------
// 「遊び方」画面の中身
//
// 節ごとに { title, rows } を返す。rows は文字列か、表（{ head, body }）。
// 画面側はこれを並べるだけでよい ── 文言を画面のコードに埋めないのは、
// 同じ説明をチュートリアルや選択画面からも引くため。
// ---------------------------------------------------------------------------
export function rulesSections() {
  return [
    {
      id: 'basics',
      icon: 'mode_solo',
      title: t('基本', 'The basics'),
      rows: [
        t('8×8の盤面に、下（横持ちなら右）の「手札」3つをドラッグして置きます。',
          'Drag the three pieces from your hand onto the 8x8 board.'),
        t('たて または よこ の8マスが埋まると、その列がまるごと消えて得点。',
          'Fill all 8 squares of a row or column and it clears for points.'),
        t('置ける場所が1つも無くなったら終わりです。回転はできません。',
          'The game ends when no piece in your hand fits anywhere. Pieces cannot be rotated.'),
        t('ドラッグ中は落ちる位置が半透明で見え、消える列は白く光って予告されます。',
          'While dragging you see a ghost of the landing spot, and lines that will clear glow white.'),
      ],
    },
    {
      id: 'score',
      icon: 'leaderboard',
      title: t('得点とコンボ', 'Score and combos'),
      rows: [
        t('置いたマス1個につき1点。ラインを消すと大きく入ります。',
          'One point per square placed — clearing lines is where the real score comes from.'),
        {
          head: [t('同時に消したライン', 'Lines cleared at once'), t('基本点', 'Base points')],
          body: [
            ['1', '100'],
            ['2', `400 ${t('（1ラインの4倍）', '(4x a single line)')}`],
            ['3', `900 ${t('（9倍）', '(9x)')}`],
            ['4', `1,600 ${t('（16倍）', '(16x)')}`],
          ],
        },
        t('まとめて消すほど得です。1ラインずつ4回消すより、4ライン同時のほうが4倍の点になります。',
          'Clearing together pays: four lines at once scores 4x what four separate single lines do.'),
        t('コンボ＝ラインを消す手を連続で決めた回数。消さない手を1回打つと0に戻ります。',
          'Combo = consecutive placements that cleared something. One placement without a clear resets it to zero.'),
        {
          head: [t('コンボ', 'Combo'), t('得点の倍率', 'Score multiplier')],
          body: [
            ['1', '×1.0'],
            ['2', '×1.5'],
            ['3', '×2.0'],
            ['5', '×3.0'],
            ['9', '×5.0'],
          ],
        },
      ],
    },
    {
      id: 'battle',
      icon: 'mode_online',
      title: t('対戦のルール（いちばん知られていない所）', 'Battle rules (the part nobody knows)'),
      rows: [
        t('「1v1 ランクマッチ」と「バトルロイヤル」では、2ライン以上を同時に消すと相手の盤面にお邪魔ブロックを送り込めます。',
          'In 1v1 Ranked and Battle Royale, clearing 2 or more lines at once dumps garbage blocks onto your opponent.'),
        t('1ラインだけでは攻撃になりません。まとめて消すのが攻撃の条件です。',
          'A single line does nothing. You have to clear them together.'),
        {
          head: [t('同時に消したライン', 'Lines at once'), t('送るお邪魔', 'Garbage sent')],
          body: [
            ['1', t('0個（攻撃にならない）', 'none')],
            ['2', t('2個', '2 blocks')],
            ['3', t('4個', '4 blocks')],
            ['4', t('6個', '6 blocks')],
          ],
        },
        t('さらにコンボ3回ごとに+1個（最大+3個）。1回に送れるのは9個までです。',
          'Every 3 combo adds one more block, up to +3. A single hit sends at most 9.'),
        t('お邪魔ブロックは消せません。消えるのは、それを含む列を8マスすべて埋めたときだけです。',
          'Garbage blocks cannot be removed on their own — only by completing a full line that contains them.'),
        // 第5波で足した予告帯（modes.js の warnIncoming / .atk-strip）の説明。
        // 画面に出るものは、遊び方にも書いておかないと「何の帯？」で終わる。
        t('相手が撃つと、着弾の直前に盤面の上の帯で「お邪魔 +N」と予告が出ます。撃った数・受けた数もその帯で数えています。',
          'When your opponent fires, a strip above the board warns you (“+N garbage”) just before it lands. The same strip tallies what you have sent and taken.'),
        t('「クラシック」と「2v2」には攻撃がありません。同じピースが配られる純粋なスコア勝負です。',
          'Classic and 2v2 have no attacks — same pieces for everyone, highest score wins.'),
      ],
    },
    // -----------------------------------------------------------------------
    // オンライン対戦まわりの「知らないと損をする」話
    //
    // ルール（何をすると点が入るか）ではなく**場の作法**をここにまとめる。
    // 第3波・第4波で作りが変わったのに、変わったことがどこにも書かれて
    // いなかった3件が入り口:
    //   ・脱落／あふれても観戦できるようになった（前は画面が終わるだけ）
    //   ・カスタムルームが8人になった（前は対戦席ぶんしか入れなかった）
    //   ・通信が切れても席が少し残るようになった
    // -----------------------------------------------------------------------
    {
      id: 'online',
      icon: 'spectate',
      title: t('オンライン対戦の作法', 'Playing online'),
      rows: [
        // 出典: server/battle.js の royale_result（spectate）と
        //       roomWatchExtra（watch / watchable）
        t('バトルロイヤルは脱落しても終わりではありません。そのまま残った人の盤面を観戦できます。',
          'Getting knocked out of Battle Royale is not the end — you keep watching the survivors play.'),
        // 出典: server/battle.js の ROOM_MAX（=8）と reseat()
        t('カスタムルームは1部屋16人まで。対戦する人数はホストが選べます（1v1と2v2チームは2〜16人。攻撃戦・協力・陣取りは盤面の作り上2人固定）。あふれた人は観戦席に座り、試合をそのまま見られます。2v2チームでは席ごとにA/Bを入れ替えられます。',
          'A custom room holds 8. Anyone past the playing seats (2 for 1v1, 4 for 2v2) sits in the stands and watches the match live.'),
        t('ホストは席をいつでも入れ替えられます。交代で遊ぶときは、待っている人が観戦席で見ていられます。',
          'The host can move people between seats at any time, so whoever is waiting their turn can watch instead of sitting out.'),
        // ⚠️ 再接続の猶予は別担当の実装。**入らなかった場合に嘘にならない**
        //    書き方にすること、という取り決めがあるので、
        //      ・変わらない土台（離脱＝敗北／戻らなければ敗北）を先に断言し、
        //      ・救済は「〜できる場合があります」＋条件つき
        //      ・運営が切っていることがある（RECONNECT_GRACE_PER_DAY=0 で
        //        本当に無効化できる env なので、これは方便ではなく事実）
        //    の3段で書く。こうしておけば、機能が無い環境でも文が嘘にならない。
        t('自分から抜けるのは敗北です（相手の不戦勝）。これは変わりません。',
          'Leaving on purpose is a loss and hands your opponent the win. That never changes.'),
        t('回線が落ちただけなら、すぐ戻れば同じ試合に復帰できる場合があります。アカウントでログインしているときだけで、待てる時間にも1日の回数にも上限があり、間に合わなければ従来どおり敗北です（この救済は運営の設定で無効になっていることがあります）。',
          'If you merely drop offline, you may be able to rejoin the same match — signed-in accounts only, with a short hold and a daily limit. Miss the window and it is still a loss. (Operators can turn this rescue off entirely.)'),
        t('猶予のあいだも試合の時計は止まりません。戻ったときには、その間に進んだぶんの差がついています。',
          'The match clock keeps running while you are away, so you come back to whatever gap opened up.'),
      ],
    },
    {
      id: 'tools',
      icon: 'cat_ult',
      title: t('切り札', 'Your lifelines'),
      rows: [
        t('リロール … 手札3つを丸ごと引き直せます。1試合に1回だけ。置き場所が無くなりそうなときに。',
          'Reroll: swap your entire hand. Once per game — save it for when you are running out of room.'),
        t('奥義 … ラインを消すとゲージが溜まり、100%で発動できます。装備は1つだけ選べます。',
          'Ultimate: clearing lines charges the gauge. Fire it at 100%. You equip one at a time.'),
        t('ブースター … 事前に買っておく道具。1人用のモードでだけ使えます。',
          'Boosters: consumables you buy in advance. Usable in solo modes only.'),
        t('公平のため、ランクマッチ・クラシック・2v2・タイムアタック・ウィークリーでは奥義もブースターも使えません。',
          'For fairness, ultimates and boosters are disabled in ranked, classic, 2v2, time attack and weekly.'),
      ],
    },
  ];
}
