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
    line: () => t('100人で最後の1人を目指す。ここも2ライン同時消しで誰かを攻撃できる。',
      '100 players, last one standing. Clearing 2+ lines attacks someone here too.'),
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
    line: () => t('4文字の合言葉で友達と対戦。ルールはホストが決める。',
      'Play with friends using a 4-letter code. The host picks the rules.'),
    rated: false,
  },
];

export function onlineModeLine(kind) {
  const m = ONLINE_MODES.find(x => x.kind === kind);
  return m ? m.line() : '';
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
        t('「クラシック」と「2v2」には攻撃がありません。同じピースが配られる純粋なスコア勝負です。',
          'Classic and 2v2 have no attacks — same pieces for everyone, highest score wins.'),
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
