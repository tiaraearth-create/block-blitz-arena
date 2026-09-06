// Visual definitions for block skins, board themes and clear effects.
import { getSettings } from './settings.js';

// Base palette: colorIndex 1..8
export const PALETTE = [
  null,
  ['#ff5d5d', '#c22f3d'], // red
  ['#ffa93d', '#d8721a'], // orange
  ['#ffe14d', '#dfa11f'], // yellow
  ['#5ee86e', '#27a83c'], // green
  ['#43d9e8', '#1a8fb8'], // cyan
  ['#5b8bff', '#2f4fd0'], // blue
  ['#b06bff', '#7434d0'], // purple
  ['#ff6bd4', '#c72b96'], // pink
  ['#8d97ad', '#4a5265'], // 9: garbage (boss attacks)
];

export const BOARDS = {
  board_default: {
    bg: ['#141a33', '#0b0e1f'],
    cell: 'rgba(255,255,255,0.055)',
    cellLine: 'rgba(255,255,255,0.07)',
    accent: '#5b8bff',
    stars: true,
  },
  board_ocean: {
    scene: 'waves',
    bg: ['#04365c', '#021423'],
    cell: 'rgba(120,220,255,0.08)',
    cellLine: 'rgba(120,220,255,0.10)',
    accent: '#43d9e8',
    bubbles: true,
  },
  board_sunset: {
    scene: 'clouds',
    bg: ['#5c2a4d', '#1f0f2e'],
    cell: 'rgba(255,180,120,0.09)',
    cellLine: 'rgba(255,180,120,0.10)',
    accent: '#ffa93d',
    stars: true,
  },
  board_forest: {
    scene: 'forest',
    bg: ['#12402a', '#06180f'],
    cell: 'rgba(150,255,180,0.07)',
    cellLine: 'rgba(150,255,180,0.09)',
    accent: '#5ee86e',
    fireflies: true,
  },
  board_galaxy: {
    bg: ['#2b1655', '#08041a'],
    cell: 'rgba(200,150,255,0.09)',
    cellLine: 'rgba(200,150,255,0.11)',
    accent: '#b06bff',
    stars: true,
    nebula: true,
  },
  board_sakura: {
    bg: ['#5c3a52', '#241322'],
    cell: 'rgba(255,190,220,0.10)',
    cellLine: 'rgba(255,190,220,0.12)',
    accent: '#ff9ecb',
    petals: true,
  },
  board_volcano: {
    scene: 'firelight',
    bg: ['#4a1e08', '#160702'],
    cell: 'rgba(255,150,90,0.10)',
    cellLine: 'rgba(255,150,90,0.12)',
    accent: '#ff8a5c',
    embers: true,
  },
  board_snow: {
    scene: 'clouds',
    bg: ['#2e4460', '#0e1826'],
    cell: 'rgba(220,240,255,0.09)',
    cellLine: 'rgba(220,240,255,0.11)',
    accent: '#bfe3ff',
    snow: true,
  },
  board_cyber: {
    scene: 'city',
    bg: ['#03251a', '#010a07'],
    cell: 'rgba(94,232,110,0.08)',
    cellLine: 'rgba(94,232,110,0.13)',
    accent: '#5ee86e',
    digital: true,
  },
  // ガチャ限定ステージ
  board_aurora: {
    bg: ['#0a2438', '#050914'],
    cell: 'rgba(140,255,220,0.08)',
    cellLine: 'rgba(140,255,220,0.11)',
    accent: '#7cf5c8',
    aurora: true,
    stars: true,
  },
  // Admin-exclusive stage
  board_admin: {
    bg: ['#3c2a58', '#120a20'],
    cell: 'rgba(255,215,94,0.10)',
    cellLine: 'rgba(255,215,94,0.16)',
    accent: '#ffd75e',
    holy: true,
    stars: true,
  },
  // Special stage themes (not purchasable — used by difficulties / bosses)
  board_oni: {
    scene: 'firelight',
    bg: ['#4a0d12', '#120306'],
    cell: 'rgba(255,110,110,0.10)',
    cellLine: 'rgba(255,110,110,0.13)',
    accent: '#ff5d5d',
    embers: true,
  },
  board_kami: {
    bg: ['#5a4a15', '#171004'],
    cell: 'rgba(255,230,150,0.10)',
    cellLine: 'rgba(255,230,150,0.14)',
    accent: '#ffd75e',
    holy: true,
  },

  // ---- 🏮 運営専用のステージ（v2.69）------------------------------------
  // 🏮 宵宮の社。祭りの前夜、灯の落ちた参道。上端は提灯に照らされた木肌の
  // くすんだ橙で、下へ行くほど藍の夜に沈む。
  //
  // 既存の暖色ステージ（砂漠の夜 #5a3d18 / 夜明け #5c3410 / 熾火の夜 #341c17 /
  // ボルケーノ #4a1e08）はどれも「暖色 → 暖色の黒」で終わる。ここだけ
  // **暖色 → 藍**へ渡すので、棚のタイル（drawBoardPreview は斜めに両端を出す）
  // でも一目で別物に見える。いちばん近い砂漠の夜とは dE=16.1（既存29枚どうしの
  // 最近傍は 3.7〜18.6）。彩度も s58 → s26 と半分以下に落として、「砂の乾き」
  // ではなく「灯に照らされた煤」に寄せてある。
  //
  // 装飾は fireflies。drawBackground は fireflies を bubbles と同じ枝で扱うので
  // 緑の粒（#b8ff9e）がゆっくり**昇る** ── 宵闇の社に蛍が立つ絵になる。
  // fireflies を持つ既存2枚（フォレスト / ミントの森）はどちらも緑〜青緑の地
  // なので、暖色の地に蛍が乗るのはここだけ。
  //
  // ⚠ 明るさ Y=0.0610（board_kami 0.0713 と同じ「暗い側」の帯。既存で最も明るい
  //    のは硝子の間 Y≒0.125 と和紙の間で、その2枚だけが合図の沈みと戦っている。
  //    ここはその心配が要らない側にいる）。合図の実測（空きマスの地＝cell を
  //    敷いた面を基準にした値）:
  //    置けないマスの赤(#ff4444 α0.25) ΔE=19.3〜（既存の最悪は逢魔が時の下端
  //    14.7）/ 揃う線の白帯 ΔL*=17.1〜36.2 / 空きマス ΔL*=6.4〜9.0（既存6前後）/
  //    お邪魔ブロック(PALETTE[9]) との dE=18.3（満ち潮の注記の下限14以上）。
  board_yomiya: {
    scene: 'torii',
    bg: ['#5a4035', '#0e1434'],
    cell: 'rgba(255,222,186,0.095)',
    cellLine: 'rgba(255,222,186,0.145)',
    accent: '#f7c98a',
    fireflies: true,
  },
  // 🌺 彼岸の岸。曼珠沙華の紅から、暮れ方の菫へ沈む岸辺。
  //
  // ⚠ 朱をこれ以上明るくしてはいけない。「置けないマス」の赤は game.js の
  //    drawGhost / drawSelection に '#ff4444' α0.25 でベタ書きされていて、赤い地
  //    の上では「置ける／置けない」が色で言えなくなる。実測: 明るい朱 #7e150e
  //    だと ΔE=11.0 まで落ちて、既存29枚の最悪（逢魔が時の下端 14.7）を割る。
  //    L* を 17 まで落とした #570a0a で ΔE=16.1 を確保してある（盤面が載る帯で
  //    サンプルしても最小 16.2）。しかも**指でドラッグ中のゴーストは枠を
  //    描かない**（#ff6b6b の枠が出るのは、タップやキーボードで選んだときの
  //    drawSelection だけ）ので、この赤が唯一の合図になる。
  //
  // 装飾は petals。既存の petals 2枚（桜の間 h318 / ルビー h331）はどちらも
  // 桃〜紅紫の地で、こちらは純赤 h0（dE=35.6 / 25.4）。粒の色は drawBackground
  // が #ffc0dc / #ff9ecb に固定していて盤面ごとには選べないが、紅の地に淡桃が
  // 落ちるので曼珠沙華の花びらとして読める（地との dE=65〜73）。
  //
  // 棚に並ぶ既存品との最近傍は、上端がボルケーノ dE=14.5（あちらは embers で、
  // 底も暖色の黒）、下端がサンセット dE=9.5 ── ただしサンセットは上端が
  // dE=34.4 離れているので、盤面ぜんたいでは取り違えない。鬼 #4a0d12 とは
  // 上端 dE=9.7 と近いが、あれは難易度／ボス専用で棚には並ばない
  // （このファイルの「Special stage themes」の並び）。
  //
  // ⚠ 明るさ Y=0.0227。既存で最も暗い側に属する（board_kami 0.0713 /
  //    board_glass 0.125 / board_paper 0.59 はいずれもこれより明るい）。
  //    空きマス ΔL*=7.1〜8.6 / 白帯 ΔL*=20.5（α0.25）〜37.0（α0.40）/
  //    お邪魔ブロックとの dE=33.6〜49.8。
  board_higan: {
    scene: 'torii',
    bg: ['#570a0a', '#2c1440'],
    cell: 'rgba(255,214,204,0.105)',
    cellLine: 'rgba(255,214,204,0.155)',
    accent: '#e8402f',
    petals: true,
  },
  // 🌌 常夜の境。藍（#12167e h238）から菫（#4b1a6c h276）へ、**明るさをほぼ
  // 変えずに色相だけ**が渡る。L* は 16.5→21.3（|ΔL*|=4.7）。既存29枚はほぼ
  // 全部が「上が明るく下が暗い」（満ち潮だけが逆）。明度がほとんど動かないのは
  // 逢魔が時（|ΔL*|=3.1）とマトリクス（3.7）の2枚だけだが、マトリクスは
  // L* 5.0→1.3 で両端とも黒に沈んでいて「色が渡る」絵にならず、逢魔が時は
  // Δh=120° で「菫の空と燃え残りの橙という別々の空が接する」絵。こちらは
  // Δh=38° に抑えて、一続きの藍から紫へ移る**境目そのもの**を盤面に置いている。
  // 棚の最近傍はその逢魔が時で dE=21.1、次がギャラクシー dE=25.5。
  //
  // 装飾は stars だけ。ギャラクシーは stars に nebula を重ねているので
  // drawBackground / drawBoardPreview とも粒が紫（#d9b8ff）になる。ここは
  // nebula を立てないので粒は白（#cfe0ff）のまま ── 地の色が近い相手とは
  // 粒の色でも分かれる（逢魔が時は embers なので粒が橙に動く）。
  //
  // ⚠ 明るさは上端 Y=0.0221 / 下端 Y=0.0332（board_kami の 0.0713 以下）。
  //    ただし**下へ行くほどわずかに明るい**ので、空きマスの白は下段ほど薄く
  //    なる（ΔL*=5.5→5.4）。cell / cellLine は既存の青系（真夜中 0.06/0.09、
  //    標準 0.055/0.07）より濃い 0.085 / 0.13 にしてある。ここを薄くすると
  //    棚のプレビューで下段のマス目が消える（満ち潮の注記と同じ理由）。
  //    白帯 ΔL*=19.1〜32.2 / 置けない赤 ΔE=21.3 / お邪魔との dE=46.8。
  board_tokoyo: {
    scene: 'torii',
    bg: ['#12167e', '#4b1a6c'],
    cell: 'rgba(206,212,255,0.085)',
    cellLine: 'rgba(206,212,255,0.13)',
    accent: '#6d63e0',
    stars: true,
  },

  // ---- 🔄 交換所限定のステージ（v2.67）----------------------------------
  // コインとジェムの使い道として、週替わりで交換所にだけ並ぶ。
  // ⚠ 明るさは「game.js が盤面に重ねる合図」が沈まない範囲で決めてある
  //    （消える線の白帯・置けないマスの赤・空きマスの白は α がベタ書きで、
  //     盤面ごとに変えられない）。地を明るくするときは必ずコントラストを測ること。
  // 🪟 硝子の間。23枚で唯一の「中間トーンの盤面」── 上端に薄い青緑を残し、
  // 底へ向かって深い硝子色に沈む。気泡がゆっくり昇る。
  // ⚠ 明るさは Y≒0.125（既存で最も明るい board_kami の1.8倍）で止めてある。
  //   これ以上明るくすると、game.js が盤面に重ねる合図（消える線の白帯 α0.25〜
  //   0.40／置けないマスの赤 α0.25／空きマスの白 α0.12）が地に沈む。α は
  //   game.js 側のベタ書きで盤面ごとに変えられないので、明るさはここで抑える。
  board_glass: {
    scene: 'waves',
    bg: ['#446a67', '#15282e'],
    cell: 'rgba(235,255,255,0.12)',
    cellLine: 'rgba(235,255,255,0.16)',
    accent: '#a7d8d2',
    bubbles: true,
  },
  // 🔥 熾火の夜。灰をかぶった赤褐色の炭。ボルケーノの半分の彩度で、底はほぼ黒。
  board_ember: {
    scene: 'firelight',
    bg: ['#341c17', '#0a0504'],
    cell: 'rgba(255,146,104,0.085)',
    cellLine: 'rgba(255,146,104,0.125)',
    accent: '#e0623c',
    embers: true,
  },
  // 📜 和紙の間。既存23枚で唯一の明るい盤面。空マスだけ墨を敷いて駒と分ける。
  //
  // ⚠ 明度は「盤面が乗る範囲」で数えること。drawBackground のグラデーションは
  //    createLinearGradient(0,0,0,H) で **canvas 全体**に掛かるが、縦持ちの盤面は
  //    layout() が boardY=6 / side=min(W-12, H-trayH-16) と置くので、上から
  //    **約55%まで**しか使わない（下の暗い側は手札の帯が持っていく）。
  //    つまり遊ぶ面は bg[0] 寄りの明るい側に寄る。横持ちだけが下端まで使う。
  //    生成り(#e4d8bd)のままだと盤面が HSL 82%→70% で狙いより明るくなるので、
  //    上端を一段落として、盤面の面が 75%→66% に収まるようにした。
  //
  // ⚠ game.js の合図（揃う線の白帯・ゴースト非表示時の白マス・氷）は #ffffff
  //    固定で、明るい面では必ず効きが落ちる。実測 ΔL*: 暗い盤の白帯が約30に対し
  //    ここは 8.5（上端）〜11.8（下端）。墨を契約の上限側（0.12）まで濃くして
  //    空マスの分離（ΔL* 7.2〜6.0＝既存の6前後と同等）と外枠の読みを確保している。
  //    これ以上明るくすると合図が消え、これ以上暗くすると「明るい盤」でなくなる。
  //
  // stars は「紙に漉き込んだ雲母」。game.js はフラグ無しでも既定色 #cfe0ff で
  // 粒を描くのに screens.js の drawBoardPreview はフラグが無いと1粒も描かないので、
  // 明示しないと棚と実物が食い違う。ただし #cfe0ff はこの紙の上では 1.0〜1.2:1 で
  // ほぼ見えない（契約の10フラグに暗い粒色は無い）。気配だけの雲母と割り切る。
  //
  // accent は盤面に出ない（参照は screens.js の棚タイルの枠・文字色・乱数シードだけ）。
  // 墨黒だと暗い棚で枠が消えるので朱にしてある。
  board_paper: {
    bg: ['#d7c9a8', '#a3906f'],
    cell: 'rgba(45,36,26,0.12)',
    cellLine: 'rgba(45,36,26,0.20)',
    accent: '#b04a35',
    stars: true,
  },
  // 🌊 満ち潮。夜の海面 ── 深い藍から、月に洗われた青銀へ。ocean / deepsea が
  // 「下へ行くほど暗い水中」なのに対し、こちらは下へ行くほど明るい**水面**
  // （bg[1] の L* は 47。既存23枚の下端は最も明るい sakura でも 8.6 なので、
  //   「下が明るい」のはここだけ）。
  //
  // ⚠ 下端を銀灰（#596d85）にしてはいけない。お邪魔ブロック（PALETTE[9]
  //   '#8d97ad'/'#4a5265'）と同じ灰青なので、盤面が載る帯の下端で ΔE が 7 まで
  //   落ちて背景に溶ける（既存23枚の最小は snow の 14、多くは 26〜31）。
  //   しかも modes.js の aeRiseRow は g[(n-1)*n+c] = 9 でお邪魔を**最下行に
  //   直接書く**ので、いちばん溶ける場所に必ず出る。青へ寄せて ΔE 14 を確保する。
  //
  // ⚠ 下端が明るいぶん、白っぽい空きマスは薄くなる。cell / cellLine を既存より
  //   濃いめ（0.11 / 0.18）にしてある。ここを 0.085 にすると、実ゲームでは
  //   まだ読めても**棚のプレビューでマス目が下段で消える**
  //   （drawBoardPreview はタイル全面にグラデを敷き、4×4 を pad 0.11〜0.89 に
  //     置くので、下段が bg[1] のほぼ素の明るさに載る）。
  //
  // bubbles はゆっくり上へ流れる粒。潮が満ちてくる動きに読み替えている。
  // 粒の色は drawBackground が '#cfe0ff' に固定していて ocean / deepsea と同じ
  // （bubbles 専用の色分岐は無い）ので、読み分けは背景の明暗だけが担う。
  board_tide: {
    bg: ['#0a1a44', '#55719a'],
    cell: 'rgba(216,233,248,0.11)',
    cellLine: 'rgba(216,233,248,0.18)',
    accent: '#dfe6ee',
    bubbles: true,
  },
  // 🔌 基板。オリーブ寄りの黄緑の絶縁膜に、はんだの金がゆっくり光る。
  // cyber / matrix と同じ「緑」だが、色相を 97°（黄緑）まで振り、装飾も
  // digital（落ちる緑の雨）ではなく holy（金の点がふくらんで消える）にして、
  // はんだの光沢として読ませる ── 描画は既存のまま、配色と装飾だけで別物にする。
  board_circuit: {
    scene: 'city',
    bg: ['#2a4718', '#0b1606'],
    cell: 'rgba(226,240,178,0.075)',
    cellLine: 'rgba(226,240,178,0.125)',
    accent: '#c8e04a',
    holy: true,
  },
  // 🌆 逢魔が時。上は冷たい青紫、下は燃え残りの橙 ── その境目が盤面の中に来る。
  // sunset は暖かい梅紫(315°)＋静止した星。こちらは色相 258° の菫から降りて、
  // 装飾も embers（立ちのぼる火の粉）にして「動く不穏な時刻」に振り分けた。
  board_dusk: {
    scene: 'firelight',
    bg: ['#43307d', '#652009'],
    cell: 'rgba(232,206,255,0.08)',
    cellLine: 'rgba(232,206,255,0.12)',
    accent: '#ff6a3d',
    embers: true,
  },
  // 👑 王座の宝物庫。第2段を割った世界でだけ棚に並ぶ。
  board_throne: {
    bg: ['#3a2c08', '#120c02'],
    cell: 'rgba(240,180,41,0.075)',
    cellLine: 'rgba(240,180,41,0.11)',
    accent: '#f0b429',
    stars: true,
  },
  // 断罪録の間。紫の封印色で、記録がずっと流れている壁。
  board_chronicle: {
    bg: ['#241a4a', '#0a0714'],
    cell: 'rgba(139,108,255,0.08)',
    cellLine: 'rgba(139,108,255,0.12)',
    accent: '#8b6cff',
    nebula: true,
  },
  // --- v2.30 追加ステージ -----------------------------------------------------
  // 装飾フラグ（stars / bubbles / fireflies / nebula / petals / embers / snow /
  // digital / aurora / holy）は既存の描画をそのまま使う。新しい絵を足すのでは
  // なく、配色と装飾の組み合わせで「別の場所」を作る ── 描画を増やすと低スペック
  // 端末の負荷が増えるが、配色だけなら追加コストがゼロで済む。
  board_deepsea: {
    scene: 'waves',
    bg: ['#021d33', '#000a14'],
    cell: 'rgba(90,190,255,0.07)',
    cellLine: 'rgba(90,190,255,0.10)',
    accent: '#3aa0e8',
    bubbles: true,
  },
  board_desert: {
    bg: ['#5a3d18', '#1c1206'],
    cell: 'rgba(255,214,150,0.09)',
    cellLine: 'rgba(255,214,150,0.12)',
    accent: '#e8b25c',
    embers: true,
  },
  board_mint: {
    scene: 'forest',
    bg: ['#123f3a', '#061715'],
    cell: 'rgba(160,255,235,0.08)',
    cellLine: 'rgba(160,255,235,0.11)',
    accent: '#5fe8cf',
    fireflies: true,
  },
  board_midnight: {
    scene: 'clouds',
    bg: ['#161a2e', '#05060d'],
    cell: 'rgba(190,200,255,0.06)',
    cellLine: 'rgba(190,200,255,0.09)',
    accent: '#8f9dff',
    stars: true,
    snow: true,
  },
  board_ruby: {
    bg: ['#4a0f2c', '#170410'],
    cell: 'rgba(255,140,190,0.09)',
    cellLine: 'rgba(255,140,190,0.12)',
    accent: '#ff5d8f',
    petals: true,
  },
  board_matrix: {
    scene: 'city',
    bg: ['#04140a', '#010603'],
    cell: 'rgba(80,255,140,0.07)',
    cellLine: 'rgba(80,255,140,0.14)',
    accent: '#3cff8a',
    digital: true,
    stars: true,
  },
  board_sunrise: {
    scene: 'clouds',
    bg: ['#5c3410', '#1f1206'],
    cell: 'rgba(255,200,140,0.10)',
    cellLine: 'rgba(255,200,140,0.13)',
    accent: '#ffb35c',
    holy: true,
  },
  board_nebula: {
    bg: ['#1d0e42', '#070316'],
    cell: 'rgba(180,140,255,0.08)',
    cellLine: 'rgba(180,140,255,0.12)',
    accent: '#a06bff',
    nebula: true,
    aurora: true,
  },
};

// ---------------------------------------------------------------------------
// Block skins: each is a draw(ctx, x, y, s, colorIndex, alpha) function.
// ---------------------------------------------------------------------------

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function drawClassic(ctx, x, y, s, ci, alpha = 1) {
  const [light, dark] = PALETTE[ci];
  const pad = s * 0.04, r = s * 0.18;
  ctx.globalAlpha = alpha;
  const g = ctx.createLinearGradient(x, y, x, y + s);
  g.addColorStop(0, light); g.addColorStop(1, dark);
  ctx.fillStyle = g;
  roundRect(ctx, x + pad, y + pad, s - pad * 2, s - pad * 2, r);
  ctx.fill();
  // top gloss
  ctx.fillStyle = 'rgba(255,255,255,0.28)';
  roundRect(ctx, x + pad + s * 0.08, y + pad + s * 0.06, s - pad * 2 - s * 0.16, s * 0.22, r * 0.6);
  ctx.fill();
  ctx.globalAlpha = 1;
}

function drawNeon(ctx, x, y, s, ci, alpha = 1) {
  const [light, dark] = PALETTE[ci];
  const pad = s * 0.10, r = s * 0.2;
  ctx.globalAlpha = alpha;
  ctx.save();
  ctx.shadowColor = light;
  ctx.shadowBlur = s * 0.45;
  ctx.fillStyle = dark;
  roundRect(ctx, x + pad, y + pad, s - pad * 2, s - pad * 2, r);
  ctx.fill();
  ctx.shadowBlur = 0;
  ctx.lineWidth = Math.max(1.5, s * 0.07);
  ctx.strokeStyle = light;
  roundRect(ctx, x + pad, y + pad, s - pad * 2, s - pad * 2, r);
  ctx.stroke();
  ctx.restore();
  ctx.globalAlpha = 1;
}

function drawCandy(ctx, x, y, s, ci, alpha = 1) {
  const [light, dark] = PALETTE[ci];
  const pad = s * 0.05, r = s * 0.32;
  ctx.globalAlpha = alpha;
  const g = ctx.createRadialGradient(x + s * 0.35, y + s * 0.3, s * 0.1, x + s * 0.5, y + s * 0.55, s * 0.75);
  g.addColorStop(0, light); g.addColorStop(1, dark);
  ctx.fillStyle = g;
  roundRect(ctx, x + pad, y + pad, s - pad * 2, s - pad * 2, r);
  ctx.fill();
  ctx.fillStyle = 'rgba(255,255,255,0.55)';
  ctx.beginPath();
  ctx.ellipse(x + s * 0.34, y + s * 0.28, s * 0.14, s * 0.09, -0.6, 0, Math.PI * 2);
  ctx.fill();
  ctx.globalAlpha = 1;
}

function drawPixel(ctx, x, y, s, ci, alpha = 1) {
  const [light, dark] = PALETTE[ci];
  const pad = Math.max(1, s * 0.06);
  ctx.globalAlpha = alpha;
  ctx.fillStyle = dark;
  ctx.fillRect(x + pad, y + pad, s - pad * 2, s - pad * 2);
  ctx.fillStyle = light;
  const b = Math.max(2, s * 0.12);
  ctx.fillRect(x + pad, y + pad, s - pad * 2, b);                    // top light bevel
  ctx.fillRect(x + pad, y + pad, b, s - pad * 2);                    // left
  ctx.fillStyle = 'rgba(0,0,0,0.35)';
  ctx.fillRect(x + pad, y + s - pad - b, s - pad * 2, b);            // bottom shade
  ctx.fillRect(x + s - pad - b, y + pad, b, s - pad * 2);            // right
  ctx.globalAlpha = 1;
}

function drawCrystal(ctx, x, y, s, ci, alpha = 1) {
  const [light, dark] = PALETTE[ci];
  const pad = s * 0.07, r = s * 0.14;
  ctx.globalAlpha = alpha * 0.9;
  const g = ctx.createLinearGradient(x, y, x + s, y + s);
  g.addColorStop(0, light); g.addColorStop(0.5, dark); g.addColorStop(1, light);
  ctx.fillStyle = g;
  roundRect(ctx, x + pad, y + pad, s - pad * 2, s - pad * 2, r);
  ctx.fill();
  // facets
  ctx.strokeStyle = 'rgba(255,255,255,0.5)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(x + pad, y + s * 0.5); ctx.lineTo(x + s * 0.5, y + pad);
  ctx.moveTo(x + s * 0.5, y + s - pad); ctx.lineTo(x + s - pad, y + s * 0.5);
  ctx.stroke();
  ctx.fillStyle = 'rgba(255,255,255,0.35)';
  ctx.beginPath();
  ctx.moveTo(x + s * 0.28, y + pad + 1);
  ctx.lineTo(x + s * 0.52, y + pad + 1);
  ctx.lineTo(x + pad + 1, y + s * 0.52);
  ctx.lineTo(x + pad + 1, y + s * 0.28);
  ctx.closePath();
  ctx.fill();
  ctx.globalAlpha = 1;
}

function drawGold(ctx, x, y, s, ci, alpha = 1) {
  const pad = s * 0.05, r = s * 0.18;
  ctx.globalAlpha = alpha;
  const g = ctx.createLinearGradient(x, y, x + s, y + s);
  g.addColorStop(0, '#fff3b0');
  g.addColorStop(0.35, '#ffd75e');
  g.addColorStop(0.6, '#c8871a');
  g.addColorStop(1, '#ffdf7e');
  ctx.fillStyle = g;
  roundRect(ctx, x + pad, y + pad, s - pad * 2, s - pad * 2, r);
  ctx.fill();
  // tint by color so pieces remain distinguishable
  const [light] = PALETTE[ci];
  ctx.globalAlpha = alpha * 0.30;
  ctx.fillStyle = light;
  roundRect(ctx, x + pad, y + pad, s - pad * 2, s - pad * 2, r);
  ctx.fill();
  ctx.globalAlpha = alpha;
  ctx.strokeStyle = 'rgba(120,70,0,0.55)';
  ctx.lineWidth = Math.max(1, s * 0.035);
  roundRect(ctx, x + pad, y + pad, s - pad * 2, s - pad * 2, r);
  ctx.stroke();
  ctx.globalAlpha = 1;
}

function drawShadow(ctx, x, y, s, ci, alpha = 1) {
  const [light] = PALETTE[ci];
  const pad = s * 0.08, r = s * 0.2;
  ctx.globalAlpha = alpha;
  ctx.save();
  ctx.fillStyle = '#0c0e18';
  roundRect(ctx, x + pad, y + pad, s - pad * 2, s - pad * 2, r);
  ctx.fill();
  ctx.shadowColor = light;
  ctx.shadowBlur = s * 0.3;
  ctx.lineWidth = Math.max(1.5, s * 0.055);
  ctx.strokeStyle = light;
  roundRect(ctx, x + pad, y + pad, s - pad * 2, s - pad * 2, r);
  ctx.stroke();
  // inner spark
  ctx.shadowBlur = 0;
  ctx.fillStyle = light;
  ctx.globalAlpha = alpha * 0.6;
  ctx.beginPath();
  ctx.arc(x + s * 0.5, y + s * 0.5, s * 0.07, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
  ctx.globalAlpha = 1;
}

function drawPastel(ctx, x, y, s, ci, alpha = 1) {
  const [light] = PALETTE[ci];
  const pad = s * 0.06, r = s * 0.3;
  ctx.globalAlpha = alpha;
  // soften the base color toward white
  ctx.fillStyle = light;
  roundRect(ctx, x + pad, y + pad, s - pad * 2, s - pad * 2, r);
  ctx.fill();
  ctx.fillStyle = 'rgba(255,255,255,0.45)';
  roundRect(ctx, x + pad, y + pad, s - pad * 2, s - pad * 2, r);
  ctx.fill();
  ctx.fillStyle = light;
  ctx.globalAlpha = alpha * 0.85;
  roundRect(ctx, x + pad + s * 0.1, y + pad + s * 0.1, s - pad * 2 - s * 0.2, s - pad * 2 - s * 0.2, r * 0.7);
  ctx.fill();
  ctx.globalAlpha = 1;
}

function drawMagma(ctx, x, y, s, ci, alpha = 1) {
  const [light] = PALETTE[ci];
  const pad = s * 0.06, r = s * 0.16;
  ctx.globalAlpha = alpha;
  // dark volcanic rock base
  const g = ctx.createLinearGradient(x, y, x, y + s);
  g.addColorStop(0, '#3a2724'); g.addColorStop(1, '#17100e');
  ctx.fillStyle = g;
  roundRect(ctx, x + pad, y + pad, s - pad * 2, s - pad * 2, r);
  ctx.fill();
  // glowing cracks, tinted by the piece color so pieces stay readable
  ctx.save();
  ctx.shadowColor = light;
  ctx.shadowBlur = s * 0.25;
  ctx.strokeStyle = light;
  ctx.lineWidth = Math.max(1.2, s * 0.05);
  ctx.beginPath();
  ctx.moveTo(x + s * 0.2, y + s * 0.75);
  ctx.lineTo(x + s * 0.42, y + s * 0.5);
  ctx.lineTo(x + s * 0.35, y + s * 0.28);
  ctx.moveTo(x + s * 0.42, y + s * 0.5);
  ctx.lineTo(x + s * 0.72, y + s * 0.62);
  ctx.moveTo(x + s * 0.6, y + s * 0.22);
  ctx.lineTo(x + s * 0.72, y + s * 0.62);
  ctx.lineTo(x + s * 0.82, y + s * 0.8);
  ctx.stroke();
  ctx.restore();
  ctx.strokeStyle = 'rgba(0,0,0,0.5)';
  ctx.lineWidth = Math.max(1, s * 0.03);
  roundRect(ctx, x + pad, y + pad, s - pad * 2, s - pad * 2, r);
  ctx.stroke();
  ctx.globalAlpha = 1;
}

function drawDot(ctx, x, y, s, ci, alpha = 1) {
  const [light, dark] = PALETTE[ci];
  const pad = s * 0.05, r = s * 0.26;
  ctx.globalAlpha = alpha;
  ctx.fillStyle = dark;
  roundRect(ctx, x + pad, y + pad, s - pad * 2, s - pad * 2, r);
  ctx.fill();
  // polka dots
  ctx.fillStyle = light;
  const dr = s * 0.09;
  for (const [fx, fy] of [[0.3, 0.3], [0.7, 0.3], [0.5, 0.55], [0.3, 0.78], [0.7, 0.78]]) {
    ctx.beginPath();
    ctx.arc(x + s * fx, y + s * fy, dr, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.fillStyle = 'rgba(255,255,255,0.25)';
  roundRect(ctx, x + pad + s * 0.07, y + pad + s * 0.05, s - pad * 2 - s * 0.14, s * 0.16, r * 0.6);
  ctx.fill();
  ctx.globalAlpha = 1;
}

// ガチャ限定: 光を分解するプリズム — 面ごとに色相のずれた輝面を持つ宝石カット
function drawPrism(ctx, x, y, s, ci, alpha = 1) {
  const [light, dark] = PALETTE[ci];
  const pad = s * 0.06, r = s * 0.14;
  const hue = Math.round(((x * 0.9 + y * 1.3) / 2.6) % 360);
  ctx.globalAlpha = alpha;
  const g = ctx.createLinearGradient(x, y, x + s, y + s);
  g.addColorStop(0, dark);
  g.addColorStop(1, '#1a1030');
  ctx.fillStyle = g;
  roundRect(ctx, x + pad, y + pad, s - pad * 2, s - pad * 2, r);
  ctx.fill();
  // three refracted facets, hue-shifted like split light
  const facets = [
    [[0.5, 0.12], [0.88, 0.5], [0.5, 0.5]],
    [[0.5, 0.5], [0.88, 0.5], [0.5, 0.88]],
    [[0.12, 0.5], [0.5, 0.12], [0.5, 0.88]],
  ];
  facets.forEach((f, i) => {
    ctx.fillStyle = `hsla(${(hue + i * 55) % 360}, 90%, 62%, 0.55)`;
    ctx.beginPath();
    ctx.moveTo(x + s * f[0][0], y + s * f[0][1]);
    ctx.lineTo(x + s * f[1][0], y + s * f[1][1]);
    ctx.lineTo(x + s * f[2][0], y + s * f[2][1]);
    ctx.closePath();
    ctx.fill();
  });
  // piece-color rim keeps shapes readable
  ctx.strokeStyle = light;
  ctx.lineWidth = Math.max(1.4, s * 0.055);
  roundRect(ctx, x + pad, y + pad, s - pad * 2, s - pad * 2, r);
  ctx.stroke();
  ctx.fillStyle = 'rgba(255,255,255,0.4)';
  roundRect(ctx, x + pad + s * 0.08, y + pad + s * 0.05, s - pad * 2 - s * 0.16, s * 0.14, r * 0.6);
  ctx.fill();
  ctx.globalAlpha = 1;
}

function drawAdminRainbow(ctx, x, y, s, ci, alpha = 1) {
  const pad = s * 0.05, r = s * 0.2;
  ctx.globalAlpha = alpha;
  // position-shifted rainbow so the board shimmers across cells
  const hue = Math.round(((x + y) / 2.2) % 360);
  const g = ctx.createLinearGradient(x, y, x + s, y + s);
  g.addColorStop(0, `hsl(${hue}, 92%, 62%)`);
  g.addColorStop(0.5, `hsl(${(hue + 70) % 360}, 92%, 58%)`);
  g.addColorStop(1, `hsl(${(hue + 140) % 360}, 92%, 60%)`);
  ctx.fillStyle = g;
  roundRect(ctx, x + pad, y + pad, s - pad * 2, s - pad * 2, r);
  ctx.fill();
  // piece-color ring keeps shapes readable
  const [light] = PALETTE[ci];
  ctx.strokeStyle = light;
  ctx.lineWidth = Math.max(1.5, s * 0.06);
  roundRect(ctx, x + pad + s * 0.03, y + pad + s * 0.03, s - pad * 2 - s * 0.06, s - pad * 2 - s * 0.06, r * 0.8);
  ctx.stroke();
  ctx.fillStyle = 'rgba(255,255,255,0.35)';
  roundRect(ctx, x + pad + s * 0.08, y + pad + s * 0.06, s - pad * 2 - s * 0.16, s * 0.2, r * 0.6);
  ctx.fill();
  ctx.globalAlpha = 1;
}

// 👑 断罪の刻印: 赤い判決線が斜めに1本、どのブロックにも入っている。
// スキンの呼び出し規約は (ctx, x, y, s, colorIndex, alpha)。ここだけ6番目を
// 角丸半径として受け取っていたため、ゴースト(0.35)・ライン消しのフェード・
// 置けない手札の減光(0.3)がすべて無効化され、ついでに角丸半径が
// alpha の値(1px未満)になって直角の四角に見えていた。他スキンに揃える。
function drawVerdict(ctx, x, y, s, colorIndex, alpha = 1) {
  const [light, dark] = PALETTE[colorIndex] || PALETTE[6];
  const r = s * 0.18;
  ctx.globalAlpha = alpha;
  const g = ctx.createLinearGradient(x, y, x, y + s);
  g.addColorStop(0, dark); g.addColorStop(1, '#14060a');
  ctx.fillStyle = g;
  roundRect(ctx, x + 1, y + 1, s - 2, s - 2, r);
  ctx.fill();
  ctx.strokeStyle = light; ctx.lineWidth = Math.max(1, s * 0.05);
  roundRect(ctx, x + 1, y + 1, s - 2, s - 2, r);
  ctx.stroke();
  ctx.save();
  ctx.beginPath(); roundRect(ctx, x + 1, y + 1, s - 2, s - 2, r); ctx.clip();
  ctx.strokeStyle = '#e03546'; ctx.lineWidth = Math.max(1.4, s * 0.09);
  ctx.globalAlpha = alpha * 0.9;   // 判決線だけ少し薄い。alpha を掛けないと半透明時に線だけ濃く残る
  ctx.beginPath(); ctx.moveTo(x + s * 0.12, y + s * 0.82); ctx.lineTo(x + s * 0.88, y + s * 0.18); ctx.stroke();
  ctx.restore();
  ctx.globalAlpha = 1;
}

// 👁️ ゼロの眼: 見返してくる。虹彩の色だけピースの色に染まる。
// drawVerdict と同じく6番目が alpha（角丸半径ではない）。
function drawZeroEye(ctx, x, y, s, colorIndex, alpha = 1) {
  const [light, dark] = PALETTE[colorIndex] || PALETTE[6];
  const r = s * 0.18;
  ctx.globalAlpha = alpha;
  ctx.fillStyle = '#120d16';
  roundRect(ctx, x + 1, y + 1, s - 2, s - 2, r);
  ctx.fill();
  ctx.strokeStyle = dark; ctx.lineWidth = Math.max(1, s * 0.05);
  roundRect(ctx, x + 1, y + 1, s - 2, s - 2, r);
  ctx.stroke();
  const cx = x + s / 2, cy = y + s / 2;
  ctx.fillStyle = '#efeaf5';
  ctx.beginPath(); ctx.ellipse(cx, cy, s * 0.34, s * 0.21, 0, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = light;
  ctx.beginPath(); ctx.arc(cx, cy, s * 0.155, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = '#0a0610';
  ctx.beginPath(); ctx.ellipse(cx, cy, s * 0.055, s * 0.135, 0, 0, Math.PI * 2); ctx.fill();
  ctx.globalAlpha = 1;
}

// --- v2.30 追加スキン ---------------------------------------------------------
// 既存と同じ約束: (ctx, x, y, s, ci, alpha) を受け、PALETTE[ci] の [light, dark]
// だけで色を作る。パレットを直に書かないのは、色覚サポート（colorMarks）や
// テーマ切り替えが PALETTE 側で効くようにするため。

// 🧊 氷塊。角が透けて、内側に霜のひび。
function drawIce(ctx, x, y, s, ci, alpha = 1) {
  const [light, dark] = PALETTE[ci];
  const pad = s * 0.06, r = s * 0.14;
  ctx.globalAlpha = alpha;
  const g = ctx.createLinearGradient(x, y, x + s, y + s);
  g.addColorStop(0, light); g.addColorStop(0.55, dark); g.addColorStop(1, light);
  ctx.fillStyle = g;
  roundRect(ctx, x + pad, y + pad, s - pad * 2, s - pad * 2, r);
  ctx.fill();
  ctx.strokeStyle = 'rgba(255,255,255,0.45)';
  ctx.lineWidth = Math.max(1, s * 0.035);
  ctx.beginPath();
  ctx.moveTo(x + s * 0.28, y + s * 0.18);
  ctx.lineTo(x + s * 0.52, y + s * 0.54);
  ctx.lineTo(x + s * 0.38, y + s * 0.82);
  ctx.moveTo(x + s * 0.62, y + s * 0.3);
  ctx.lineTo(x + s * 0.52, y + s * 0.54);
  ctx.stroke();
  ctx.globalAlpha = 1;
}

// 🪵 木彫り。年輪が浅く入った、あたたかい面。
function drawWood(ctx, x, y, s, ci, alpha = 1) {
  const [light, dark] = PALETTE[ci];
  const pad = s * 0.06, r = s * 0.12;
  ctx.globalAlpha = alpha;
  ctx.fillStyle = dark;
  roundRect(ctx, x + pad, y + pad, s - pad * 2, s - pad * 2, r);
  ctx.fill();
  ctx.save();
  roundRect(ctx, x + pad, y + pad, s - pad * 2, s - pad * 2, r);
  ctx.clip();
  ctx.strokeStyle = light;
  ctx.globalAlpha = alpha * 0.35;
  ctx.lineWidth = Math.max(1, s * 0.05);
  for (let i = 0; i < 3; i++) {
    ctx.beginPath();
    ctx.arc(x + s * 0.18, y + s * 0.85, s * (0.28 + i * 0.24), -0.9, 0.35);
    ctx.stroke();
  }
  ctx.restore();
  ctx.globalAlpha = alpha * 0.9;
  ctx.strokeStyle = 'rgba(0,0,0,0.35)';
  ctx.lineWidth = Math.max(1, s * 0.03);
  roundRect(ctx, x + pad, y + pad, s - pad * 2, s - pad * 2, r);
  ctx.stroke();
  ctx.globalAlpha = 1;
}

// 🫧 ゼリー。ぷるんとした厚みと、下に落ちるハイライト。
function drawJelly(ctx, x, y, s, ci, alpha = 1) {
  const [light, dark] = PALETTE[ci];
  const pad = s * 0.07, r = s * 0.3;
  ctx.globalAlpha = alpha * 0.92;
  const g = ctx.createLinearGradient(x, y + s, x, y);
  g.addColorStop(0, dark); g.addColorStop(1, light);
  ctx.fillStyle = g;
  roundRect(ctx, x + pad, y + pad, s - pad * 2, s - pad * 2, r);
  ctx.fill();
  ctx.globalAlpha = alpha * 0.5;
  ctx.fillStyle = light;
  roundRect(ctx, x + pad * 1.8, y + s * 0.52, s - pad * 3.6, s * 0.3, r * 0.7);
  ctx.fill();
  ctx.globalAlpha = alpha * 0.75;
  ctx.fillStyle = 'rgba(255,255,255,0.6)';
  ctx.beginPath();
  ctx.ellipse(x + s * 0.36, y + s * 0.3, s * 0.16, s * 0.1, -0.5, 0, Math.PI * 2);
  ctx.fill();
  ctx.globalAlpha = 1;
}

// ⚙️ 鋼鉄。斜めのヘアラインと、四隅のリベット。
function drawSteel(ctx, x, y, s, ci, alpha = 1) {
  const [light, dark] = PALETTE[ci];
  const pad = s * 0.05, r = s * 0.1;
  ctx.globalAlpha = alpha;
  const g = ctx.createLinearGradient(x, y, x + s, y + s);
  g.addColorStop(0, light); g.addColorStop(0.5, dark); g.addColorStop(1, light);
  ctx.fillStyle = g;
  roundRect(ctx, x + pad, y + pad, s - pad * 2, s - pad * 2, r);
  ctx.fill();
  ctx.save();
  roundRect(ctx, x + pad, y + pad, s - pad * 2, s - pad * 2, r);
  ctx.clip();
  ctx.globalAlpha = alpha * 0.18;
  ctx.strokeStyle = '#ffffff';
  ctx.lineWidth = Math.max(1, s * 0.025);
  for (let i = -1; i < 4; i++) {
    ctx.beginPath();
    ctx.moveTo(x + s * (i * 0.3), y);
    ctx.lineTo(x + s * (i * 0.3 + 0.5), y + s);
    ctx.stroke();
  }
  ctx.restore();
  ctx.globalAlpha = alpha * 0.7;
  ctx.fillStyle = 'rgba(255,255,255,0.55)';
  const rv = s * 0.055;
  for (const [dx, dy] of [[0.2, 0.2], [0.8, 0.2], [0.2, 0.8], [0.8, 0.8]]) {
    ctx.beginPath();
    ctx.arc(x + s * dx, y + s * dy, rv, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.globalAlpha = 1;
}

// 🌌 星屑。夜空を閉じ込めた、粒の浮かぶ面。粒の位置は色ごとに固定（毎フレーム
// 抽選すると盤面がチカチカして酔う）。
const STARDUST_PTS = [[0.28, 0.3], [0.62, 0.22], [0.44, 0.55], [0.74, 0.62], [0.3, 0.74]];
function drawStardust(ctx, x, y, s, ci, alpha = 1) {
  const [light, dark] = PALETTE[ci];
  const pad = s * 0.05, r = s * 0.2;
  ctx.globalAlpha = alpha;
  const g = ctx.createRadialGradient(x + s * 0.5, y + s * 0.5, s * 0.05, x + s * 0.5, y + s * 0.5, s * 0.7);
  g.addColorStop(0, light); g.addColorStop(1, dark);
  ctx.fillStyle = g;
  roundRect(ctx, x + pad, y + pad, s - pad * 2, s - pad * 2, r);
  ctx.fill();
  ctx.fillStyle = 'rgba(255,255,255,0.85)';
  for (let i = 0; i < STARDUST_PTS.length; i++) {
    const [px, py] = STARDUST_PTS[(i + ci) % STARDUST_PTS.length];
    ctx.globalAlpha = alpha * (i % 2 ? 0.55 : 0.85);
    ctx.beginPath();
    ctx.arc(x + s * px, y + s * py, s * (i % 2 ? 0.028 : 0.042), 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.globalAlpha = 1;
}

// ---- 🏮 運営専用のブロック（v2.69）--------------------------------------
// 🪧 御札。縦長の紙に朱の帯を巻き、墨で一筆だけ入れてある。
// 紙は左右だけを大きく空けて縦長にする（横 0.75s / 縦 0.93s）。上下を詰めてあるので
// 縦につながった塊は「一枚の長い札」に、横に並ぶと「札が貼り並べてある面」に見える。
// 色はピース色で紙を染めて出す（drawGold の tint と同じ考え方。ただし地が生成りなので
// 明度側でも分かれる）。染めた紙どうしの最小差は ci2 橙 と ci3 黄 の ΔE76≒13 なので、
// 0.42 の tint はこれ以上薄くしないこと。
// 固定色は朱の帯 #b0332b だけ。墨線は PALETTE[ci] の dark を使う（紙が明るいぶん、
// 一本調子の黒より色の見分けが増える）。
function drawTalisman(ctx, x, y, s, ci, alpha = 1) {
  const [light, dark] = PALETTE[ci];
  const px = s * 0.125, py = s * 0.035, r = s * 0.07;
  const w = s - px * 2, h = s - py * 2;
  ctx.globalAlpha = alpha;
  // 生成りの紙
  const g = ctx.createLinearGradient(x, y, x, y + s);
  g.addColorStop(0, '#f3e8d0'); g.addColorStop(1, '#d8c6a1');
  ctx.fillStyle = g;
  roundRect(ctx, x + px, y + py, w, h, r);
  ctx.fill();
  // ピース色で紙を染める。色の見分けはここが担うので薄くしすぎない
  ctx.globalAlpha = alpha * 0.42;
  ctx.fillStyle = light;
  roundRect(ctx, x + px, y + py, w, h, r);
  ctx.fill();
  // 朱の帯。角丸（r = 0.07s）が終わる下から引くので、丸みからはみ出さない
  ctx.globalAlpha = alpha;
  ctx.fillStyle = '#b0332b';
  ctx.fillRect(x + px, y + py + h * 0.11, w, h * 0.14);
  // 墨の一筆。縦線1本と横線2本だけ ── 文字は書かない（小さいマスで潰れて汚れに見える）。
  // 線の色はピース色の dark。上の tint と合わせて、ここが色の見分けを担う。
  ctx.globalAlpha = alpha * 0.85;
  ctx.strokeStyle = dark;
  ctx.lineWidth = Math.max(1, s * 0.05);
  ctx.beginPath();
  ctx.moveTo(x + px + w * 0.5, y + py + h * 0.36);
  ctx.lineTo(x + px + w * 0.5, y + py + h * 0.9);
  ctx.moveTo(x + px + w * 0.2, y + py + h * 0.53);
  ctx.lineTo(x + px + w * 0.8, y + py + h * 0.53);
  ctx.moveTo(x + px + w * 0.3, y + py + h * 0.73);
  ctx.lineTo(x + px + w * 0.7, y + py + h * 0.73);
  ctx.stroke();
  // 紙の縁。札の輪郭を締めるための飾りで、マスの境そのものは上下 0.07s の隙間
  // （暗い地が覗く）と朱の帯が担っている。board_paper で外して実測しても、
  // 縦に並んだ同色札の境目は ΔE76 28.2 → 26.6 としか変わらない。
  // 描画が重くなったら最初に落としてよいのはこの一本。
  ctx.globalAlpha = alpha * 0.55;
  ctx.strokeStyle = 'rgba(58,40,24,0.9)';
  ctx.lineWidth = Math.max(1, s * 0.03);
  roundRect(ctx, x + px, y + py, w, h, r);
  ctx.stroke();
  ctx.globalAlpha = 1;
}

// 🔵 狐火。夜色の地に、青白い火がひとつ灯る。色は火そのものではなく、
// まわりの暈（かさ）で出す ── 火は常に青白いまま、暈だけがピース色に染まる。
//
// 暈を 'rgba(0,0,0,0)' で終わらせると縁が黒くにじむ。かといって毎セルで
// 'rgba(...)' を組み立てると 64マス＋手札ぶん文字列を作ることになるので、
// PALETTE の明色を rgba に開いた表を先に作っておく。
const FOXFIRE_FADE = PALETTE.map(p => {
  if (!p) return null;
  const n = parseInt(p[0].slice(1), 16);
  const rgb = `${(n >> 16) & 255},${(n >> 8) & 255},${n & 255}`;
  return [`rgba(${rgb},0.6)`, `rgba(${rgb},0)`];
});

function drawFoxfire(ctx, x, y, s, ci, alpha = 1) {
  const [, dark] = PALETTE[ci];
  const [mid, edge] = FOXFIRE_FADE[ci];
  const pad = s * 0.05, r = s * 0.22;
  ctx.globalAlpha = alpha;
  ctx.fillStyle = '#0a1120';
  roundRect(ctx, x + pad, y + pad, s - pad * 2, s - pad * 2, r);
  ctx.fill();
  ctx.globalAlpha = alpha * 0.5;
  ctx.fillStyle = dark;
  roundRect(ctx, x + pad, y + pad, s - pad * 2, s - pad * 2, r);
  ctx.fill();
  // 火の暈。中心を少し下に置くと、上へ伸びる炎に見える
  const cx = x + s * 0.5, cy = y + s * 0.56;
  ctx.globalAlpha = alpha;
  const g = ctx.createRadialGradient(cx, cy, s * 0.03, cx, cy, s * 0.46);
  g.addColorStop(0, 'rgba(232,247,255,0.95)');
  g.addColorStop(0.42, mid);
  g.addColorStop(1, edge);
  ctx.fillStyle = g;
  roundRect(ctx, x + pad, y + pad, s - pad * 2, s - pad * 2, r);
  ctx.fill();
  // 火そのもの（しずく形）。クリップは要らない ── 形は x 0.31〜0.69 / y 0.19〜0.76 に収まる
  ctx.globalAlpha = alpha * 0.92;
  ctx.fillStyle = 'rgba(238,250,255,0.95)';
  ctx.beginPath();
  ctx.moveTo(cx, y + s * 0.19);
  ctx.bezierCurveTo(cx + s * 0.19, y + s * 0.41, cx + s * 0.15, y + s * 0.75, cx, y + s * 0.76);
  ctx.bezierCurveTo(cx - s * 0.15, y + s * 0.75, cx - s * 0.19, y + s * 0.41, cx, y + s * 0.19);
  ctx.closePath();
  ctx.fill();
  // 連れの小さい火。暈の薄い外側に置く（中央寄りだと白に埋もれて見えない）
  ctx.globalAlpha = alpha * 0.85;
  ctx.beginPath();
  ctx.arc(x + s * 0.775, y + s * 0.245, s * 0.05, 0, Math.PI * 2);
  ctx.fill();
  ctx.globalAlpha = 1;
}

// ⬡ 結界。薄く透ける硝子のなかに、六角の護符が浮かぶ。
// 六角は1マスに1つ。マスが並ぶと同じ大きさの六角が等間隔に整列して、盤面が
// 護符を敷き詰めた結界のように見える ── そこが狙い。
// ⚠ 隣のマスの六角と辺が繋がるわけではない（外接半径 s*0.34 だと左右の平辺は
//    中心から 0.294s、上下の頂点でも 0.34s。マスの間隔は s なので 0.3〜0.4s の
//    隙間が残る）。繋げるには外接半径 s*0.577 が要り、面の 0.88s からはみ出す
//    ので取らない。
// 頂点は毎フレーム三角関数を回さないよう、単位六角形を先に作っておく。
const WARD_HEX = Array.from({ length: 6 }, (_, i) => {
  const a = -Math.PI / 2 + i * Math.PI / 3;
  return [Math.cos(a), Math.sin(a)];
});
function wardHex(ctx, cx, cy, rad) {
  ctx.beginPath();
  for (let i = 0; i < 6; i++) {
    const [ux, uy] = WARD_HEX[i];
    if (i === 0) ctx.moveTo(cx + ux * rad, cy + uy * rad);
    else ctx.lineTo(cx + ux * rad, cy + uy * rad);
  }
  ctx.closePath();
}

function drawWard(ctx, x, y, s, ci, alpha = 1) {
  const [light, dark] = PALETTE[ci];
  const pad = s * 0.06, r = s * 0.16;
  const cx = x + s * 0.5, cy = y + s * 0.5;
  // 硝子なので少し透ける。縦2段グラデは「上が暗い」── 既存は classic / jelly が
  // 上を light、crystal / ice / steel が斜め3段、candy / stardust が放射なので、
  // 面の見え方だけで既存と混ざらない。
  ctx.globalAlpha = alpha * 0.9;
  const g = ctx.createLinearGradient(x, y, x, y + s);
  g.addColorStop(0, dark); g.addColorStop(1, light);
  ctx.fillStyle = g;
  roundRect(ctx, x + pad, y + pad, s - pad * 2, s - pad * 2, r);
  ctx.fill();
  // 浮かぶ護符。内外2重の六角形。
  // lineJoin は既定の miter のまま触らない（120°では尖らないし、ctx は使い回しなので
  // 書き換えると他のスキンの描画にそのまま漏れる）。
  ctx.globalAlpha = alpha * 0.16;
  ctx.fillStyle = '#ffffff';
  wardHex(ctx, cx, cy, s * 0.34);
  ctx.fill();
  ctx.globalAlpha = alpha * 0.85;
  ctx.strokeStyle = 'rgba(238,250,255,0.9)';
  ctx.lineWidth = Math.max(1, s * 0.042);
  wardHex(ctx, cx, cy, s * 0.34);
  ctx.stroke();
  // 内側の六角は strokeStyle を上から引き継ぐ（同じ淡青白）。太さだけ落とす。
  ctx.globalAlpha = alpha * 0.45;
  ctx.lineWidth = Math.max(1, s * 0.028);
  wardHex(ctx, cx, cy, s * 0.18);
  ctx.stroke();
  // 硝子の縁
  ctx.globalAlpha = alpha * 0.5;
  ctx.strokeStyle = 'rgba(255,255,255,0.5)';
  ctx.lineWidth = Math.max(1, s * 0.03);
  roundRect(ctx, x + pad, y + pad, s - pad * 2, s - pad * 2, r);
  ctx.stroke();
  ctx.globalAlpha = 1;
}

export const SKINS = {
  skin_default: drawClassic,
  skin_neon: drawNeon,
  skin_candy: drawCandy,
  skin_pixel: drawPixel,
  skin_crystal: drawCrystal,
  skin_gold: drawGold,
  skin_shadow: drawShadow,
  skin_pastel: drawPastel,
  skin_magma: drawMagma,
  skin_dot: drawDot,
  skin_prism: drawPrism,
  skin_admin: drawAdminRainbow,
  skin_verdict: drawVerdict,
  skin_zero: drawZeroEye,
  skin_ice: drawIce,
  skin_wood: drawWood,
  skin_jelly: drawJelly,
  skin_steel: drawSteel,
  skin_stardust: drawStardust,
  skin_talisman: drawTalisman,
  skin_foxfire: drawFoxfire,
  skin_ward: drawWard,
};

// ---------------------------------------------------------------------------
// 🌳 動く風景（scene）
// ---------------------------------------------------------------------------
// いままで背景で動いていたのは**粒**（星・泡・花びら・火の粉…）だけで、
// 景色そのものは静止していた。ここは「木が揺れる」「波が寄せる」のような、
// 形のあるものを動かす層。BOARDS の `scene: '…'` で選ぶ。
//
// ■ 守ること（ここを外すと盤面が読めなくなる）
//  1. **盤面より奥にいること。** 描くのは drawBackground の中、粒より前
//     （粒が風景の手前に浮く）。盤面の升目・駒はさらに手前に描かれる。
//  2. **薄く、暗く。** 盤面に重ねる合図（消える線の白帯 α0.25〜0.40 /
//     置けないマスの赤 / 空きマスの白）は α がベタ書きで盤面ごとに変えられない。
//     風景が明るいとそれらが沈む。globalAlpha は 0.30 を超えないこと。
//  3. **毎フレーム走る。** 60fps で盤面の描画と同居するので、1回あたりの
//     パス数は数十まで。ループの中で createLinearGradient を呼ばないこと。
//  4. **時計は渡された t だけを見る。** t は設定「エフェクト量」と OS の
//     「視差効果を減らす」を通した後の時計（game.js の _decoTime）で、
//     「視差効果を減らす」では止まる＝風景も静止する。Date.now() を使わない。
//  5. 描き終わりに globalAlpha を 1 に戻す。
//
// 引数: (ctx, w, h, t, theme)
//   w,h … 描いてよい範囲（キャンバス全体）。盤面はこの中央に載る
//   t   … 秒。上記の装飾時計
//   theme … BOARDS の1件（accent などを借りたいとき用）
export const SCENES = {};

SCENES.forest = (ctx, w, h, t, theme) => {
  // 下端に木立を並べ、風で幹と葉をゆっくり傾がせる。木ごとに位相と速さを変える。
  // 盤面は中央に載るので、木は「盤面の下に残る余白」の中だけで背を伸ばす。
  //
  // ■ 丈は min(w,h) ではなく**余白**から決める。
  //   game.js の置き方（sizeTo）はこうなっている:
  //     縦持ち … boardY=6 / side=min(w-12, h-trayH-16)  → 盤面の下に h-6-side の余白
  //     横持ち … boardY=(h-side)/2 / side=min(h-12, …) → 盤面が高さをほぼ埋め、余白は上下6px
  //   min(w,h) の 44% を丈にすると、
  //     ・横持ちは必ず盤面の下半分（グリッド行4〜7・面積の15〜18%）に木が載る
  //     ・縦持ちでも 768x1024 のような「縦だが幅もある」画面で最下段に69px食い込む
  //   ので、縦持ちは (h-w)/2（盤面が上寄せでも中央でも足りる見積り）、
  //   横持ちは下端の帯だけ、で頭打ちにする。
  const land = w > h * 1.25;                      // game.js の sideTray と同じ判定
  const free = land ? h * 0.18 : (h - w) * 0.5;   // 盤面の下に残る余白の見積り
  const tall = Math.max(h * 0.10, Math.min(Math.min(w, h) * 0.44, free));  // いちばん高い木
  const n = 9, step = w / n;
  const gust = 0.6 + 0.4 * Math.sin(t * 0.29);    // 風の強弱。林全体でそろう
  ctx.fillStyle = (theme && theme.accent) || '#5ee86e';
  for (let layer = 0; layer < 2; layer++) {
    // ■ 塗りは**層に1回だけ**。木を1本ずつ fill すると、隣の木と重なった画素で
    //   α が二重に乗る（0.18 → 0.328、奥の層も足すと 0.395）。ctx.globalAlpha は
    //   0.18 のままでも、目に見える濃さは上限 0.30 を超えてしまう
    //   ── 置けないマスの赤(α0.25)の明度差が 22.1→4.8 まで潰れる。
    //   ひとつのパスにまとめれば、同じ向きに巻いた形どうしは重ねても濃くならず、
    //   林全体の輪郭だけが1つの影になる（狙いどおり）。塗りは 9回 → 2回。
    ctx.globalAlpha = layer ? 0.18 : 0.10;        // 0=奥（薄い）を先に、1=手前を後に
    ctx.beginPath();
    for (let i = layer; i < n; i += 2) {
      // 乱数は使わない（毎フレーム形が変わるとちらつく）。添字から決まる値で散らす。
      // ※ sin(i*12.9898) は i=0..8 では山を折り返さず、値がほぼ単調に減る
      //   （高さも速さも左から右へ一直線に小さくなる）。折り返す係数にする。
      const s1 = Math.sin(i * 91.37 + 4.1) * 33712.221, a = s1 - Math.floor(s1);
      const s2 = Math.sin(i * 78.233 + 2.7) * 24634.6345, b = s2 - Math.floor(s2);
      const th = tall * (layer ? 0.68 + 0.32 * a : 0.45 + 0.14 * a);  // 木の高さ
      const bx = (i + 0.5) * step + (b - 0.5) * step * 0.8;           // 根元のx
      const tw = th * (layer ? 0.040 : 0.030);                        // 幹の太さ
      const top = h - th;
      // 根元は動かさず、上へ行くほど大きく傾く。速さ(a)と位相(b)が木ごとに違う。
      const wob = t * (0.5 + 0.35 * a) + b * 6.2832;
      const amp = gust * th * (layer ? 0.075 : 0.05);
      const lean = Math.sin(wob) * amp;             // 幹
      const leaf = Math.sin(wob - 0.5) * amp;       // 葉は幹に**遅れて**追う（位相差0.5rad）
      const cw = th * (0.30 + 0.08 * b);            // 葉のひろがり
      ctx.moveTo(bx - tw, h + 4);
      ctx.quadraticCurveTo(bx - tw * 0.55 + lean * 0.3, h - th * 0.45, bx + lean - tw * 0.42, top + th * 0.26);
      ctx.lineTo(bx + lean + tw * 0.42, top + th * 0.26);
      ctx.quadraticCurveTo(bx + tw * 0.55 + lean * 0.3, h - th * 0.45, bx + tw, h + 4);
      ctx.closePath();
      // 葉は幹の1.4〜1.7倍振れる。ellipse の前に moveTo を置いて subpath を切る
      // （置かないと直前の点から直線でつながる）。始点は角度0の位置ぴったりに取る。
      ctx.moveTo(bx + leaf * 1.4 + cw, top + th * 0.30);
      ctx.ellipse(bx + leaf * 1.4, top + th * 0.30, cw, th * 0.24, 0, 0, 6.2832);
      ctx.moveTo(bx + leaf * 1.7 + cw * 0.62, top + th * 0.12);
      ctx.ellipse(bx + leaf * 1.7, top + th * 0.12, cw * 0.62, th * 0.16, 0, 0, 6.2832);
    }
    ctx.fill();
  }
  ctx.globalAlpha = 1;
};

SCENES.waves = (ctx, w, h, t, theme) => {
  // 下端に3本の波。横へ流しながら上下にうねる。奥（上）の線ほど遅く・薄く・小さい。
  // 1本＝パス1つ: 稜線を stroke したあと、そのまま下端まで閉じて fill する。
  // 点は1度しか作らないので、2回描いても座標の計算は1本ぶんで済む。
  const accent = (theme && theme.accent) || '#43d9e8';
  // ⚠ 刻みを px で決めてはいけない（前は max(20, w / 30) だった）。2つ壊れる:
  //  ・右端 ── (w + 40) が刻みで割り切れないと最後の点が右端の手前で止まる。
  //    stroke() は skirt の lineTo より前なので稜線がそこで切れ、水面だけが
  //    右下隅へ斜めに落ちる。w を 280〜1920 まで1pxずつ試すと44%の幅で起き、
  //    最大 20px（例: w=1201 は x=1181 で終わる）。#gameCanvas は width:100% で
  //    #app に max-width が無いので、デスクトップのこの幅は普通に出る。
  //  ・狭い側 ── 波長は w に比例するのに刻みが 20px に張り付くので、点の密度が
  //    幅とともに落ちる。棚のミニ盤面（168px。screens.js の drawBoardPreview も
  //    drawScene を呼ぶ）では 1波長あたり1.5点しか取れず、波ではなく鋸歯になる。
  // 点の数を固定して刻みを (w + 40) / N にすると、最後の点がちょうど w + 20 に
  // 乗り（N が2の冪なので誤差なし）、1波長あたりの点数も 168px〜1920px を通して
  // 5.6〜6.8 に保たれる。1フレームの命令数も幅によらず一定になる。
  const N = 32;
  const step = (w + 40) / N;
  ctx.lineWidth = Math.max(1.2, Math.min(3, h * 0.004));
  ctx.lineJoin = 'round';
  ctx.strokeStyle = accent;
  ctx.fillStyle = accent;
  for (let i = 0; i < 3; i++) {
    const base = h * (0.72 + i * 0.09);       // 手前ほど下
    const amp = h * (0.016 + 0.008 * i);      // 手前ほど大きくうねる
    const sp = 0.16 + 0.13 * i;               // 手前ほど速く流れる
    const k1 = 6.2832 * (2.1 + 0.4 * i) / w;  // 波長は画面幅ぶんで決める
    const k2 = 6.2832 * (3.7 + 0.9 * i) / w;
    const ph = i * 1.7;
    ctx.beginPath();
    for (let n = 0; n <= N; n++) {
      const x = -20 + n * step;
      // 周期の違う2つを足すと、見ていて繰り返しに気づかないうねりになる
      const y = base
        + Math.sin(x * k1 - t * sp * 2.2 + ph) * amp
        + Math.sin(x * k2 + t * sp * 1.1 + ph * 2) * amp * 0.42;
      if (n === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.globalAlpha = 0.15 + 0.04 * i;        // 波がしら。細い線なので少し強く
    ctx.stroke();
    ctx.lineTo(w + 20, h + 20);
    ctx.lineTo(-20, h + 20);
    ctx.closePath();
    // 水の面。⚠ これは「下の余白」に敷かれるとは限らない ── 横持ちの盤面は
    // 画面の高さをほぼ使い切る（812x375 で boardY=6 / side=363 / 下端 y=369）ので、
    // h * 0.72〜0.90 の3枚は**盤面の下3段の真下**に入り、最下行（modes.js の
    // aeRiseRow が妨害ブロックを必ず書く行）には3枚とも乗る。
    // 前の 0.05 / 0.065 / 0.08（合成 0.183）だと board_ocean の最下行で
    // 空きマスの地が L* 14.6→28.1 まで明るくなり、PALETTE[9] の暗色 '#4a5265'
    // （drawClassic は light→dark の縦グラデなのでブロックの下半分がこの色）との
    // 色差が ΔE76 で 21.2→13.6 に落ちた。board_tide を外した理由と同じ現象で、
    // themes.js が定めた床（ΔE 14）を割る。合成 0.12 まで下げると 19 台に戻り、
    // 波の見えかたは変わらない。稜線の線は面積が無いので元の濃さのまま。
    ctx.globalAlpha = 0.032 + 0.010 * i;      // 水の面。3枚重なっても合成 0.12
    ctx.fill();
  }
  ctx.globalAlpha = 1;
};

SCENES.clouds = (ctx, w, h, t, theme) => {
  // 上空をゆっくり横切る雲。遠いものほど小さく・遅く・薄い。
  // 縦持ちは盤面が上端(y=6)から載るので、高さを 0.07h〜0.83h に散らして
  // 下の余白にも必ず近い雲が来るようにする（横持ちは左右の余白で全部見える）。
  const u = Math.min(w, h);
  ctx.fillStyle = (theme && theme.accent) || '#cfe0ff';
  for (let i = 0; i < 6; i++) {
    const d = (i % 3) / 2;                                   // 0=遠 0.5 1=近
    const yf = 0.07 + (i * 0.152) % 0.80;                    // 高さ。等間隔に散らして重ねない
    // 乱数は使わない。添字から決まる値で雲ごとに形を変える（同じ絵が6枚並ばないように）
    const s1 = Math.sin(i * 45.233 + 0.7) * 12547.317, v = s1 - Math.floor(s1);
    const sp = 0.010 + 0.022 * d;                            // 1周（画面1.6個ぶん）の速さ
    const cx = ((i * 0.41 + t * sp) % 1) * (w * 1.6) - w * 0.3;
    const cy = h * yf + Math.sin(t * 0.21 + i * 1.9) * u * 0.006;   // ごくゆっくり上下
    const rx = u * (0.10 + 0.085 * d);
    const ry = rx * 0.34;
    const puff = 1 + 0.05 * Math.sin(t * 0.23 + i * 2.3);     // 息をするようなふくらみ
    ctx.globalAlpha = 0.08 + 0.09 * d;                        // 最大 0.17
    // ふくらみ4つを同じ回り方で1つのパスに入れて塗り1回。重なった所が濃くならない。
    // ellipse の前の moveTo は必ず角度0の点（中心x+半径x, 中心y）に置く。
    const x2 = cx - rx * (0.44 - 0.10 * v), y2 = cy - ry * 0.52, r2 = rx * 0.48;
    const x3 = cx + rx * (0.20 + 0.18 * v), y3 = cy - ry * (0.70 + 0.25 * v), r3 = rx * 0.40;
    const x4 = cx + rx * 0.72, y4 = cy - ry * 0.30, r4 = rx * 0.30;
    ctx.beginPath();
    ctx.moveTo(cx + rx * puff, cy);
    ctx.ellipse(cx, cy, rx * puff, ry, 0, 0, 6.2832);        // 土台。底は平ら
    ctx.moveTo(x2 + r2, y2);
    ctx.ellipse(x2, y2, r2, ry * (0.85 + 0.25 * v), 0, 0, 6.2832);
    ctx.moveTo(x3 + r3, y3);
    ctx.ellipse(x3, y3, r3, ry * 0.78, 0, 0, 6.2832);
    ctx.moveTo(x4 + r4, y4);
    ctx.ellipse(x4, y4, r4, ry * 0.62, 0, 0, 6.2832);
    ctx.fill();
  }
  ctx.globalAlpha = 1;
};

// 手前のビルの座標は「影」と「窓」の二か所で要る。同じ式を二度書くと必ずズレるので、
// 1フレームぶんをここに置いて使い回す（毎フレーム新しい配列は作らない）。
const _cityFront = new Float64Array(18);   // [x, 幅, 高さ] × 手前6棟

// 遠い街 ── 二層のビル影を並べ、窓がゆっくり明るくなって、また暗くなる。
// 0↔1 で切り替える「点滅」はしない（明滅は過去に苦情が出ている）。窓1つの
// 一往復は 9〜18 秒。塔の航空灯は 5.5 秒でふくらんで、しぼむ（消えきらない）。
//
// ■ どこに立てるか ── 「盤面が来ない帯」だけ。
//   game.js の layout() は
//     縦持ち: 盤面を y=6 から min(w-12, h-trayH-16) に置く（trayH=min(h*0.24,130)）
//             → 盤面の下に帯が残る。そこに立てる。
//     横持ち: 盤面が高さいっぱいに降りてくる（上下の余白は6px）。代わりに
//             盤面＋手札の外側に左右の帯が残る。そこに立てる。
//   街の高さを h の割合だけで決めると盤面に入る。盤面の下の余白は h に比例せず
//   trayH+10（最大140px）で頭打ちになるので、正方形に近い縦持ち（900x1000 等）
//   では 0.22h の街が最下段に食い込む。横持ちはもっとはっきりしていて、街を
//   何倍に畳んでも下端は盤面の中 ── 812x375 / 1280x720 / 1366x1024 のいずれも
//   盤面0.8行ぶんが黒 α0.26 で沈み、差し色の稜線が cellLine とまったく同じ色
//   （board_cyber なら rgb(94,232,110)）・同じ向きの線として升目の中に出ていた。
//   なので下端に置けるのは縦持ちだけ、横持ちは左右の帯へ回す。
//   （盤面の位置は GameView.layout() と揃えること。showTray は常に true ──
//     GameView を作るのは modes.js の1か所だけで、オプションを渡していない）
SCENES.city = (ctx, w, h, t, theme) => {
  const accent = (theme && theme.accent) || '#5ee86e';
  // 添字から作る決定論的な散らし（Math.random は毎フレーム形が変わるので使わない）
  const hash = i => { const x = Math.sin(i * 127.1 + 43.7) * 43758.5453; return x - Math.floor(x); };
  const land = w > h * 1.25;                    // 横持ち＝盤面が下端まで来る

  // 立てる帯を先に決める。ここが取れなければ何も描かない（盤面に重ねるくらいなら出さない）。
  let gut = 0, tall;
  if (land) {
    // 盤面＋手札の外側に残る幅。盤面は最大 h-12、間が10px、手札は最大170px。
    // 実際の boardX 以下になるように見積もり、さらに6px 内側で止める。
    gut = (w - (h - 12) - 10 - 170) / 2 - 6;
    if (gut < 48) return;                       // 正方形に近い横持ち。立てる幅が無い
    tall = h * 0.22;
  } else {
    const trayH = Math.min(h * 0.24, 130);
    const room = h - 6 - Math.min(w - 12, h - trayH - 16) - 8;   // 盤面の下の余白（縁の分を引く）
    if (room < 24) return;
    tall = Math.min(h * 0.22, room);            // 端末が縦長なら 0.22h のまま
  }
  const unit = land ? gut : w;                  // 横方向の物差し（帯の幅／画面幅）

  // ビルの影。層ごとに1パスへまとめ、塗り1回＋稜線の線1回で描く。
  // 影は暗くするだけ。地が暗い盤面でも輪郭が読めるように、稜線だけ差し色で起こす。
  for (let L = 0; L < 2; L++) {
    const n = L ? 6 : 8;
    const per = land ? n / 2 : n;               // 横持ちは左右の帯へ半分ずつ
    const slot = unit / per;
    ctx.beginPath();
    for (let i = 0; i < n; i++) {
      const r1 = hash(i + L * 31), r2 = hash(i * 3.7 + L * 57);
      const sx = land && i >= per ? w - gut : 0;
      const bw = slot * (0.44 + 0.30 * r1);
      let bx = sx + (i % per) * slot + (L ? slot * 0.5 : 0) + (slot - bw) * 0.5 * r2;
      if (land) bx = Math.min(bx, sx + gut - bw);   // 帯からはみ出させない（はみ出た先が盤面）
      const bh = tall * (L ? 0.41 + 0.59 * r2 : 0.23 + 0.36 * r1);
      if (L) { const o = i * 3; _cityFront[o] = bx; _cityFront[o + 1] = bw; _cityFront[o + 2] = bh; }
      ctx.rect(bx, h - bh, bw, bh + 4);
    }
    ctx.fillStyle = '#000';
    ctx.globalAlpha = L ? 0.26 : 0.16;
    ctx.fill();
    ctx.strokeStyle = accent;
    ctx.lineWidth = 1;
    ctx.globalAlpha = L ? 0.16 : 0.09;
    ctx.stroke();
  }

  // 窓。手前の6棟に5つずつ。位置も明滅の速さも添字から決まる。
  // ビルの座標は上で控えた値をそのまま使う（描いた影と必ず同じ場所に出す）。
  //
  // ⚠ 最初は 2×2px の窓を3つ、明るさの振れも 0.04〜0.24、周期 9〜18秒 にしていた。
  //   ちらつきを避ける狙いは正しかったが、行き過ぎて **20秒眺めて12画素しか
  //   変わらない＝止まって見える**状態だった（実測）。
  //   窓を大きく・数を増やし、明るさの振れを広げ、周期を 4〜8秒 に上げる。
  //   それでも 1つの窓が明→暗→明するのは最速 0.25回/秒で、
  //   火の粉で問題になった 1.9回/秒 の 1/7。ちらつきの心配は無い。
  const ww = Math.max(3, unit * 0.011), wh = Math.max(3, h * 0.011);
  ctx.fillStyle = accent;
  for (let i = 0; i < 6; i++) {
    const o = i * 3, bx = _cityFront[o], bw = _cityFront[o + 1], bh = _cityFront[o + 2];
    for (let k = 0; k < 5; k++) {
      const q = hash(i * 7.3 + k * 2.1 + 11), q2 = hash(i * 5.1 + k * 3.9 + 71);
      const lit = 0.5 + 0.5 * Math.sin(t * (0.78 + 0.80 * q) + q2 * 6.28);   // 4〜8秒で一往復
      ctx.globalAlpha = 0.06 + 0.05 * q2 + (0.18 + 0.22 * q) * lit;
      ctx.fillRect(bx + bw * (0.14 + 0.72 * q), h - bh * (0.12 + 0.76 * q2), ww, wh);
    }
  }

  // 塔の頂の航空灯。周期5.5秒でふくらんで、しぼむ（消えない）。
  ctx.globalAlpha = 0.10 + 0.14 * (0.5 + 0.5 * Math.sin(t * 1.15));
  ctx.beginPath();
  ctx.arc(_cityFront[6] + _cityFront[7] * 0.5, h - _cityFront[8] - Math.max(2, h * 0.006),
    Math.max(1.5, unit * 0.004), 0, Math.PI * 2);
  ctx.fill();

  ctx.globalAlpha = 1;
};

// 揺らめく火明かり ── 炎の形は描かない（粒の火の粉と喧嘩するため）。下端に
// 3つの「光だまり」を置き、横の流れ・大きさ・明るさを別々の周期で揺らす。
// 同じ楕円を6枚重ねて中心ほど明るくする（毎フレームのグラデーション生成を避ける）。
//
// ⚠ 重なりを数えること。楕円は rx≒0.295〜0.356w あるのに中心の間隔は 0.32w しか
//    ないので、下端では2〜3つの光だまりが重なる。「1つぶんの6枚＝実効0.12」では
//    なく、総当たり実測で最大 0.173（横持ちの盤面内は 0.146）。
//    1回あたりの globalAlpha は最大 0.040＝契約（0.30以下）の内側。
//
// ⚠ 横持ちは下端が全部「盤面の下」。game.js の sideTray（W > H*1.25）は
//    boardY=6 / side=min(H-12, W-130) なので、盤面が画面高の98〜99%を占め、
//    この効果が載る下端13%は丸ごと盤面の中に入る。ry を縮めるだけでは盤面の上に
//    橙を敷いたままなので、**明るさと火の口の高さにも同じ係数を掛ける**。
//    実測（board_dusk・盤面内の実効α）: 掛けないと 0.20 で、置けないマスの赤
//    α0.25 の ΔL* が 9.2→6.7（読みの下限）まで落ちる。掛ければ 0.15／ΔL* 7.3。
SCENES.firelight = (ctx, w, h, t, theme) => {
  const glow = (theme && theme.accent) || '#ff8a5c';
  const sq = w > h * 1.25 ? 0.7 : 1;            // 横持ちは盤面が下端まで来るので低く＆薄く
  ctx.fillStyle = glow;
  for (let i = 0; i < 3; i++) {
    const ph = i * 2.1;
    const cx = w * (0.18 + i * 0.32) + Math.sin(t * 0.37 + ph) * w * 0.05
      + Math.sin(t * 0.61 + ph * 1.7) * w * 0.02;
    // 0.44〜1.12。速い成分(2.3rad/s＝0.37Hz)は振れ幅を小さくして、ちらつきにしない。
    const puff = 0.78 + 0.22 * Math.sin(t * 1.1 + ph) + 0.12 * Math.sin(t * 2.3 + ph * 2.3);
    const rx = w * 0.30 * (0.85 + 0.30 * puff);
    const ry = h * sq * 0.19 * puff;
    // 外側ほど薄い6枚。外周の段差は 0.012。内側の縁は各層のα（最大0.040）ぶん
    // 段差が出るが、曲がった縁なので線には見えない ── まっすぐな縁だけが目に付く。
    for (let k = 0; k < 6; k++) {
      const lv = 0.30 + 0.14 * k;
      ctx.globalAlpha = (0.030 + 0.010 * Math.sin(t * 0.9 + ph + k * 0.5)) * lv * sq;   // 最大 0.040
      ctx.beginPath();
      ctx.ellipse(cx, h + h * 0.02, rx * (1 - k * 0.155), ry * (1 - k * 0.155), 0, 0, Math.PI * 2);
      ctx.fill();
    }
  }
  // 火の口。下端の帯だけ、少し強く息をする。
  // ⚠ 同じ濃さの帯を2枚重ねてはいけない。2枚目は1枚目の縦の範囲に丸ごと入るので、
  //    上辺で実効αが 0.106→0.183 に1pxで跳ね、**画面を横切るまっすぐな線**になる
  //    （実測 ΔL* 6.1／1px）。薄い帯の上辺を少しずつ下げて5枚重ね、1本あたりの
  //    段差を 0.014（ΔL* 約1.0）まで落とす。合計の濃さと息の振れ幅は据え置き。
  const mouth = (0.009 + 0.005 * Math.sin(t * 1.3 + 0.8)) * sq;   // 5枚合計で 0.020〜0.068
  const band = h * sq * 0.075;
  ctx.globalAlpha = mouth;
  for (let j = 0; j < 5; j++) ctx.fillRect(0, h - band * (1 - j * 0.2), w, band + h * 0.02);
  ctx.globalAlpha = 1;
};

// 鳥居と提灯 ── 奥に鳥居の影（静止）、手前の提灯が4つ、別々の周期で揺れる。
//
// ⚠ 提灯の置き場所を「w の決め打ち」（0.175w のような比）で決めてはいけない。
//   scene には boardX / boardY / boardSize が渡ってこないので、game.js の
//   layout() と**同じ式**で盤面（横持ちは手札まで）が載る帯をここに引き直し、
//   その外側に置く。決め打ちだと実機で盤面の上に提灯が出る:
//     横 667×375 → 盤面 x=65〜428 / 手札 438〜602。4つのうち3つが盤面か手札の上
//     横 812×375 → 0.175w=142 が盤面（138〜501）の中
//     縦 810×1080 → 盤面の下端が 0.744h まで降り、0.71h の提灯を飲み込む
//     縦 600×600 / 1000×1000（分割画面・PCの縦長窓）も同じく4つとも盤面の上
//   盤面のマスは theme.cell が α0.055〜0.12 の半透明なので、**盤面は背景を
//   隠さない**。上に出た提灯（火袋 α0.20 の暖色）はそのまま盤面に乗って、
//   「置けないマスの赤 α0.25」とコントラストを食い合う。
//   横持ちで比が 1.3 前後の画面は盤面＋手札で幅を使い切り、余白が 6px しか
//   残らない。そこは提灯を縮めてから薄くして消す ── 盤面に載せるよりよい。
SCENES.torii = (ctx, w, h, t, theme) => {
  const land = w > h * 1.25;                    // 横持ち＝盤面が高さを使い切る
  const f = land ? 0.7 : 1;                     // 横持ちの鳥居は盤面に重なるので薄く
  const pad = Math.max(4, Math.min(w, h) * 0.012);

  // ── 盤面（横持ちは手札まで）が載る帯。game.js layout() と同じ式 ──────
  let bBot = h;                                 // 盤面の下端（縦持ちで使う）
  let mL = 0, mR = 0, bx1 = w;                  // 左右の余白と右端（横持ちで使う）
  if (land) {
    let side = Math.min(h - 12, w - 130);
    const trayW = Math.max(96, Math.min(side * 0.45, 170));
    if (side + 10 + trayW > w - 12) side = Math.max(96, w - 22 - trayW);
    const total = side + 10 + trayW;            // 盤面＋隙間＋手札
    mL = Math.max(6, (w - total) / 2);
    bx1 = mL + total;
    mR = Math.max(0, w - bx1);
  } else {
    bBot = 6 + Math.min(w - 12, h - Math.min(h * 0.24, 130) - 16);
  }

  const gy = h * 0.98;                          // 鳥居の足元
  const sq = land ? 0.62 : 1;                   // 横持ちは低く畳んで、
  let th = Math.min(h * 0.30, w * 0.34) * sq;   // 高さ（縦横どちらでも収まる）
  // 縦持ちは笠木が盤面の最下段に掛からないところまで畳む（畳まないと
  // 810×1080 で 21px 食い込む）。横持ちは畳む先が無いので薄さ（f）で守る。
  if (!land) th = Math.min(th, Math.max(h * 0.06, gy - bBot - pad));
  const ty = gy - th;
  const pw = Math.max(3, th * 0.075);           // 柱の太さ
  const cx = w * 0.5;

  // 地面の靄。ゆっくり濃くなって薄くなるだけの帯。
  // 横は画面の外まで引く ── 揺れ（render の translate、最大 ±12px）で
  // 端に地の色の筋が出ないように。
  ctx.fillStyle = '#dfe6ee';
  ctx.globalAlpha = (0.035 + 0.020 * Math.sin(t * 0.28)) * f;
  ctx.fillRect(-20, gy - th * 0.16, w + 40, th * 0.26);

  // 鳥居。柱2本＋笠木＋貫＋額束を1パスにまとめて1回で塗る。
  // 朱は落として（α0.13）、盤面に重なる下段で「置けないマスの赤」と紛れないようにする。
  ctx.fillStyle = '#b5503a';
  ctx.globalAlpha = 0.13 * f;
  ctx.beginPath();
  ctx.rect(cx - th * 0.42 - pw * 0.5, ty, pw, th);
  ctx.rect(cx + th * 0.42 - pw * 0.5, ty, pw, th);
  ctx.rect(cx - th * 0.56, ty, th * 1.12, pw * 0.9);
  ctx.rect(cx - th * 0.50, ty + th * 0.16, th * 1.00, pw * 0.7);
  ctx.rect(cx - pw * 0.35, ty + pw, pw * 0.7, th * 0.16);
  ctx.fill();
  ctx.globalAlpha = 0.07 * f;                   // 笠木だけ一段起こす
  ctx.beginPath();
  ctx.rect(cx - th * 0.58, ty - pw * 0.35, th * 1.16, pw * 0.55);
  ctx.fill();

  // ── 提灯。余白の中に収まる大きさを先に決める ────────────────────
  // 収まらない画面では縮め、それでも収まらないぶんだけ薄くして消す。
  const r0 = Math.min(w, h) * 0.030;            // 本来の大きさ
  const rMin = r0 * 0.30;                       // これ以上は縮めない（縮めず薄くする）
  let r, lf, cord = h * 0.055, ay0;
  if (land) {
    // 左右の余白をそれぞれ2つ分に割る。暈（半径 2.3r）が持ち分に収まる r。
    const fit = Math.min(mL, mR) * 0.28 / 2.3;
    r = Math.min(r0, Math.max(fit, rMin));
    const q = Math.max(0, Math.min(1, fit / rMin));
    lf = q * q;                                 // 余白が足りないほど速く消える
    ay0 = h * 0.655;
  } else {
    // 盤面の下端から画面の下まで。紐＋火袋＋暈＋ずらしぶんが入る r。
    const top = bBot + pad;
    const band = Math.max(0, h - pad - top);
    cord = Math.min(cord, band * 0.30);
    const fit = (band - cord) / 3.6;
    r = Math.min(r0, Math.max(fit, rMin));
    const q = Math.max(0, Math.min(1, fit / rMin));
    lf = q * q;
    ay0 = top + Math.max(0, (band - (cord + 3.6 * r)) * 0.45);
  }

  if (lf > 0.02) {
    for (let i = 0; i < 4; i++) {
      // 横持ちは左右の余白の中、縦持ちは手札の帯の中（盤面の下）。
      const lx = land
        ? (i < 2 ? mL * (i === 0 ? 0.28 : 0.72) : bx1 + mR * (i === 2 ? 0.28 : 0.72))
        : w * (i === 0 ? 0.085 : i === 1 ? 0.175 : i === 2 ? 0.825 : 0.915);
      const ay = ay0 + (i & 1 ? (land ? h * 0.04 : r * 0.6) : 0);
      const len = cord + r;
      const ph = i * 1.7;
      const ang = 0.10 * Math.sin(t * 0.52 + ph) + 0.035 * Math.sin(t * 0.81 + ph * 1.6);
      ctx.save();
      ctx.translate(lx, ay);
      ctx.rotate(ang);
      // 吊り紐。暗い地では黒い線は見えないので、生成りを薄く引く。
      ctx.strokeStyle = '#e8c9a0';
      ctx.globalAlpha = 0.11 * lf;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(0, 0);
      ctx.lineTo(0, len - r * 1.2);
      ctx.stroke();
      // 灯りの暈
      const beat = 0.5 + 0.5 * Math.sin(t * 0.9 + ph);   // 周期7秒（0.14回/秒）
      ctx.fillStyle = '#ffb96b';
      ctx.globalAlpha = (0.035 + 0.025 * beat) * lf;
      ctx.beginPath();
      ctx.ellipse(0, len, r * 2.3, r * 2.0, 0, 0, Math.PI * 2);
      ctx.fill();
      // 火袋
      ctx.fillStyle = '#ffcf8a';
      ctx.globalAlpha = (0.15 + 0.05 * beat) * lf;
      ctx.beginPath();
      ctx.ellipse(0, len, r, r * 1.25, 0, 0, Math.PI * 2);
      ctx.fill();
      // 上下の輪
      ctx.fillStyle = '#000';
      ctx.globalAlpha = 0.18 * lf;
      ctx.beginPath();
      ctx.rect(-r * 0.45, len - r * 1.32, r * 0.9, r * 0.22);
      ctx.rect(-r * 0.40, len + r * 1.12, r * 0.8, r * 0.20);
      ctx.fill();
      // 骨（横に2本）
      ctx.strokeStyle = '#000';
      ctx.globalAlpha = 0.10 * lf;
      ctx.beginPath();
      ctx.moveTo(-r * 0.82, len - r * 0.42); ctx.lineTo(r * 0.82, len - r * 0.42);
      ctx.moveTo(-r * 0.82, len + r * 0.42); ctx.lineTo(r * 0.82, len + r * 0.42);
      ctx.stroke();
      ctx.restore();
    }
  }
  ctx.globalAlpha = 1;
};

// 風景を一度描いておく紙。大きさが変わったときだけ作り直す。
let _sceneBuf = null, _sceneCtx = null;

/**
 * 盤面に風景があれば描く。無ければ何もしない。
 *
 * ■ なぜ一度別の紙に描いてから重ねるのか
 * 「globalAlpha は 0.30 まで」と決めても、**図形どうしが重なった画素では
 * α が二重に乗る**（0.18 の木が2本重なれば 1-(1-0.18)² = 0.33）。
 * 実測でも 街 0.48 / 鳥居 0.41 / 波 0.32 と上限を超えていた。
 * 作者が毎回気をつける約束にすると、風景を足すたびに破れる。
 *
 * そこで **素の濃さで別の紙に描き、最後に1回だけ薄くして重ねる**。
 * こうすると内部でいくら重なっても、盤面に載る濃さは必ず SCENE_ALPHA 以下になる。
 * 盤面に重ねる合図（消える線の白帯 α0.25〜0.40 / 置けないマスの赤 / 空きマスの白）は
 * α が game.js にベタ書きで盤面ごとに変えられないので、ここが唯一の歯止め。
 */
export const SCENE_ALPHA = 0.28;

// 紙の中で使う濃さの倍率。
//
// 風景は「そのまま盤面に重ねる」つもりで書かれていて、中の globalAlpha は
// 0.03〜0.26 と薄い。ところが上の仕組みでは**紙は不透明**なので、その薄さの
// まま描くと、最後に SCENE_ALPHA を掛けたときに二重に薄くなって
// ほとんど見えなくなる（実測で最大 0.047〜0.133 まで落ちた）。
// 紙の中では濃く描いて、薄さの決定は最後の1回に任せる。
// 風景どうしの濃さの釣り合い（作者が決めた relative な強弱）はそのまま残る。
const SCENE_GAIN = 3.2;

// Proxy は毎フレーム作らない（1フレームに数十回の描画呼び出しが通るので、
// そのたびに束縛した関数を作ると無駄に散らかる）。
let _sceneProxy = null, _sceneBound = null;
function gainCtx(c) {
  if (_sceneProxy && _sceneProxy.__for === c) return _sceneProxy.p;
  _sceneBound = new Map();
  const p = new Proxy(c, {
    get(o, k) {
      const v = o[k];
      if (typeof v !== 'function') return v;
      let b = _sceneBound.get(k);
      if (!b) { b = v.bind(o); _sceneBound.set(k, b); }
      return b;
    },
    set(o, k, v) {
      o[k] = (k === 'globalAlpha' ? Math.max(0, Math.min(1, v * SCENE_GAIN)) : v);
      return true;
    },
  });
  _sceneProxy = { __for: c, p };
  return p;
}

export function drawScene(ctx, w, h, t, theme) {
  const fn = theme && theme.scene ? SCENES[theme.scene] : null;
  if (!fn) return;
  if (!(w > 0) || !(h > 0)) return;
  const W = Math.ceil(w), H = Math.ceil(h);
  try {
    if (!_sceneBuf) {
      _sceneBuf = document.createElement('canvas');
      _sceneCtx = _sceneBuf.getContext('2d');
    }
    // 大きさが変わったときだけ作り直す（毎フレーム作ると重い）。
    if (_sceneBuf.width !== W || _sceneBuf.height !== H) {
      _sceneBuf.width = W; _sceneBuf.height = H;
    } else {
      _sceneCtx.clearRect(0, 0, W, H);
    }
    _sceneCtx.save();
    _sceneCtx.globalAlpha = 1;
    fn(gainCtx(_sceneCtx), W, H, t, theme);
    _sceneCtx.restore();
    const a = ctx.globalAlpha;
    ctx.globalAlpha = SCENE_ALPHA;
    ctx.drawImage(_sceneBuf, 0, 0);
    ctx.globalAlpha = a;
  } catch {
    // 風景が壊れても盤面は描く。紙も捨てて、次のコマで作り直させる。
    _sceneBuf = null; _sceneCtx = null;
    ctx.globalAlpha = 1;
  }
}

// fx ids map to particle presets handled in particles.js
export const FX_IDS = ['fx_default', 'fx_fireworks', 'fx_thunder', 'fx_sakura'];

// ---------------------------------------------------------------------------
// 色覚サポート: 色 index ごとの記号をブロック中央に薄く重ねる。
// 設定 colorMarks が ON のときだけ、getSkin() が返す描画関数をラップして
// 適用する。こうすると盤面・ゴースト・手札・ミニ盤面・ショップのプレビューまで
// getSkin() 経由の描画すべてに自動で波及し、呼び出し側は一切触らずに済む。
// ---------------------------------------------------------------------------

// PALETTE と同じ添字（0 は未使用 / 9 は妨害ブロック）。
const COLOR_MARKS = [null, '▲', '●', '■', '◆', '✚', '★', '▼', '◐', '✕'];
// 記号の色。白一色だと **明るい面（2橙・3黄・4緑・5シアン）でほとんど
// 見えず**、色覚サポートを入れた人にだけ「印が出ない色がある」状態だった。
// 添字は COLOR_MARKS / PALETTE と同じ。
const MARK_INK = [null, '#fff', '#000', '#000', '#000', '#000', '#fff', '#fff', '#fff', '#fff'];

// フォント文字列の組み立ては毎セル走るのでサイズ単位でキャッシュする。
let _markPx = -1, _markFont = '';
function markFont(s) {
  const px = Math.max(6, Math.round(s * 0.46));
  if (px !== _markPx) { _markPx = px; _markFont = `${px}px "Segoe UI Symbol", "Noto Sans Symbols 2", sans-serif`; }
  return _markFont;
}

// 記号はテキスト描画1回だけ（影・縁取りなし）でコストを抑える。
function drawColorMark(ctx, x, y, s, ci, alpha) {
  const mark = COLOR_MARKS[ci];
  if (!mark || !(s > 0)) return;
  const a = Math.max(0, Math.min(1, Number(alpha) >= 0 ? Number(alpha) : 1));
  if (a <= 0.02) return;
  ctx.save();
  ctx.shadowBlur = 0;                       // ライン消し前のグロー描画に巻き込まれないように
  ctx.globalAlpha = a * 0.5;                // 「薄く重ねる」: 元の絵柄を潰さない濃さ
  ctx.fillStyle = MARK_INK[ci] === '#000' ? 'rgba(0,0,0,0.92)' : 'rgba(255,255,255,0.92)';
  ctx.font = markFont(s);
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(mark, x + s / 2, y + s / 2);
  ctx.restore();
}

// 元の描画関数ごとにラッパを1つだけ作って使い回す（毎フレーム生成しない）。
const _markedSkins = new Map();
function withColorMarks(draw) {
  let wrapped = _markedSkins.get(draw);
  if (!wrapped) {
    wrapped = function (ctx, x, y, s, ci, alpha = 1) {
      draw(ctx, x, y, s, ci, alpha);
      drawColorMark(ctx, x, y, s, ci, alpha);
    };
    _markedSkins.set(draw, wrapped);
  }
  return wrapped;
}

export function getSkin(id) {
  const draw = SKINS[id] || SKINS.skin_default;
  let on = false;
  try { on = getSettings().colorMarks === true; } catch { /* 設定が読めなければ素のスキン */ }
  return on ? withColorMarks(draw) : draw;
}
export function getBoard(id) { return BOARDS[id] || BOARDS.board_default; }
