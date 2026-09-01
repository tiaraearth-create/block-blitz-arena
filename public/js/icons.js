// ---------------------------------------------------------------------------
// Block Blitz Arena — オリジナルアイコン
//
// なぜ作ったか
//   絵文字は「同じ絵が別の意味で使い回される」のを止められない。実際、
//   🛡️ は奥義「不落の城塞」と管理者ブースター「絶対防御」の両方、
//   ☄️ は「メテオストライク」と「天変地異」の両方に付いていて、
//   ショップの棚で見分けが付かなかった。端末やOSごとに絵が変わるのも、
//   商品として並べるには具合が悪い（同じ商品が人によって別の絵に見える）。
//
//   ここで定義したアイコンは 24×24 のベクターで、どの端末でも同じ形になり、
//   id が違えば必ず絵も違う。増やすときは ICONS に足すだけ。
//
// 使い方
//   import { icon } from './icons.js';
//   el.innerHTML = icon('coins');                 // 既定 20px
//   el.innerHTML = icon('ult_meteor', { size: 34 });
//   el.appendChild(iconEl('shop'));               // DOM ノードが欲しいとき
//
//   HTML 文字列に差し込む用途が多いので、既定は「文字列を返す」。
//   innerHTML に入る前提なので、name は必ずこのファイルの中の固定キーだけを
//   受け取ること（外部入力をそのまま渡さない ── 未知の名前は placeholder に
//   落ちるので描画は壊れないが、色の指定だけは属性値に入るため）。
//
// 設計のきまり
//   ・viewBox は 0 0 24 24 固定。線の太さは 1.8 を基準にする。
//   ・色は2色まで（a=主役 / b=陰・差し色）。3色目が要るなら形で描き分ける。
//   ・塗りは fill="var(--ic-a)" のように CSS 変数を経由する。これで
//     ボタンの :hover などから上書きできる。
//   ・シルエットで見分けが付くこと。色を落として真っ白にしても
//     「どれがどれか」が分かる形にする（色覚特性・高コントラスト設定対策）。
// ---------------------------------------------------------------------------

// 段位の帯（色・アイコン名）は public/js/ranks.js が唯一の正解。
// ここでしきい値を持たないための import。
import { bandOf } from './ranks.js';

// name -> { a, b, p }
//   a: 主役の色 / b: 差し色 / p: <svg> の中身
const ICONS = {
  // ===== 通貨・資源 =========================================================
  coins: {
    a: '#ffd75e', b: '#b7820f',
    p: `<circle cx="12" cy="12" r="8.5" fill="var(--ic-b)"/>
        <circle cx="12" cy="12" r="7" fill="var(--ic-a)"/>
        <path d="M12 7.4v9.2M9.6 9.4h3.6a1.9 1.9 0 0 1 0 3.8H9.6h3.9a1.9 1.9 0 0 1 0 3.8H9.6" fill="none" stroke="var(--ic-b)" stroke-width="1.6" stroke-linecap="round"/>`,
  },
  gems: {
    a: '#57e0ff', b: '#1c7fa8',
    p: `<path d="M6.2 4h11.6l3.2 5-9 11-9-11z" fill="var(--ic-a)"/>
        <path d="M6.2 4 9 9l3-5zM17.8 4 15 9l-3-5zM3 9h18l-9 11z" fill="var(--ic-b)" opacity=".55"/>
        <path d="M3 9h18M9 9l3 11 3-11" fill="none" stroke="#e8fbff" stroke-width="1.1" opacity=".8"/>`,
  },
  // 👑 王座の欠片。通貨だが、割れた冠の破片であることが分かる形にする。
  shards: {
    a: '#f0b429', b: '#7a4d05',
    p: `<path d="M4 15 2.6 7.4l4.2 3 2.6-4.2 1.4 8.8z" fill="var(--ic-a)"/>
        <path d="M13.2 15 14.6 6.2l2.6 4.2 4.2-3L20 15z" fill="var(--ic-a)" opacity=".75"/>
        <path d="M3.6 17.2h7.2M13.2 17.2h7.2" stroke="var(--ic-b)" stroke-width="2" stroke-linecap="round"/>`,
  },
  xp: {
    a: '#8b6cff', b: '#3d2a80',
    p: `<circle cx="12" cy="12" r="8.5" fill="var(--ic-b)"/>
        <path d="M12 4.6a7.4 7.4 0 0 1 7.4 7.4h-3.2A4.2 4.2 0 0 0 12 7.8z" fill="var(--ic-a)"/>
        <path d="m8.4 9.6 2.2 5.4 1.4-3.2 1.4 3.2 2.2-5.4" fill="none" stroke="#fff" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>`,
  },

  // ===== トップバー・ナビ ===================================================
  user: {
    a: '#9fb0d4', b: '#38425c',
    p: `<circle cx="12" cy="8.4" r="3.9" fill="var(--ic-a)"/>
        <path d="M4.6 20a7.4 7.4 0 0 1 14.8 0z" fill="var(--ic-a)"/>
        <path d="M4.6 20a7.4 7.4 0 0 1 3.1-6 7.4 7.4 0 0 0 8.6 0 7.4 7.4 0 0 1 3.1 6z" fill="var(--ic-b)" opacity=".45"/>`,
  },
  // 未ログイン。user と同じ人型だが「輪郭だけ・中身が無い」形にして、
  // 塗りつぶしの user（＝アカウントがある人）と一目で違うようにする。
  // 色も落として、トップバーで自分から目立たないようにしてある。
  user_guest: {
    a: '#6b7594', b: '#38425c',
    p: `<circle cx="12" cy="8.4" r="3.9" fill="none" stroke="var(--ic-a)" stroke-width="1.9"/>
        <path d="M5.2 19.9a6.8 6.8 0 0 1 13.6 0" fill="none" stroke="var(--ic-a)" stroke-width="1.9" stroke-linecap="round"/>`,
  },
  // モデレーター。admin（盾＋王冠）とは別物。工具＝「手入れをする人」。
  // 盾を借りると運営(admin)と同じ形になるので、意図的に系統を変えている。
  mod: {
    a: '#43d9e8', b: '#0d5a66',
    p: `<path d="M20.4 4.6 17 8l-1.4-1.4 3.4-3.4a5.4 5.4 0 0 0-6.8 6.6L4.4 16.6a2.1 2.1 0 0 0 3 3l6.8-7.8a5.4 5.4 0 0 0 6.2-7.2z" fill="var(--ic-a)"/>
        <circle cx="6.3" cy="17.7" r="1.35" fill="var(--ic-b)"/>`,
  },
  settings: {
    a: '#9fb0d4', b: '#38425c',
    p: `<path d="M12 2.8l1.9 2.1 2.8-.6.6 2.8 2.5 1.4-1.3 2.5 1.3 2.5-2.5 1.4-.6 2.8-2.8-.6L12 21.2l-1.9-2.1-2.8.6-.6-2.8-2.5-1.4 1.3-2.5-1.3-2.5 2.5-1.4.6-2.8 2.8.6z" fill="var(--ic-a)"/>
        <circle cx="12" cy="12" r="3.4" fill="var(--ic-b)"/>`,
  },
  missions: {
    a: '#5b8bff', b: '#22315e',
    p: `<rect x="5" y="3.2" width="14" height="17.6" rx="2.4" fill="var(--ic-a)"/>
        <rect x="8.6" y="1.8" width="6.8" height="3.4" rx="1.7" fill="var(--ic-b)"/>
        <path d="m8.2 11 2 2 4-4.4M8.2 16.2h7.6" fill="none" stroke="#fff" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>`,
  },
  friends: {
    a: '#5ee86e', b: '#1d6b2c',
    p: `<circle cx="8.6" cy="8.4" r="3.4" fill="var(--ic-a)"/>
        <circle cx="16.2" cy="9.6" r="2.8" fill="var(--ic-b)"/>
        <path d="M2.6 19.4a6 6 0 0 1 12 0z" fill="var(--ic-a)"/>
        <path d="M13.4 19.4a5 5 0 0 1 8.2-3.9 5 5 0 0 1 1.6 3.9z" fill="var(--ic-b)"/>`,
  },
  // 十字を白で描いていたので、色を落とすと盾の地色と同化して
  // ult_fortress（同じ盾型）と見分けが付かなかった。差し色（暗いほう）で描く。
  guild: {
    a: '#ff9d3d', b: '#8a4708',
    p: `<path d="M12 2.6 20.4 6v6.2c0 4.6-3.4 8-8.4 9.2-5-1.2-8.4-4.6-8.4-9.2V6z" fill="var(--ic-a)"/>
        <path d="M12 2.6 20.4 6v6.2c0 4.6-3.4 8-8.4 9.2z" fill="var(--ic-b)" opacity=".5"/>
        <path d="M8.6 12.4h6.8M12 9v6.8" stroke="var(--ic-b)" stroke-width="2.1" stroke-linecap="round"/>`,
  },
  // 📖 遊び方。missions（チェック付きクリップボード）は流用できない ──
  // あれは 📋ミッションの絵そのもので、ナビに同じ絵が2つ並ぶことになる。
  // 開いた本＋「？」で「読んで分かるもの」だと分かる形にした。
  // main.js が ['rules','help','howto'].find(hasIcon) で拾う。
  rules: {
    a: '#ffd75e', b: '#6b4a00',
    p: `<path d="M2.6 5.2c2.8-1.1 5.6-1.1 8.4 0v14c-2.8-1.1-5.6-1.1-8.4 0zM21.4 5.2c-2.8-1.1-5.6-1.1-8.4 0v14c2.8-1.1 5.6-1.1 8.4 0z" fill="var(--ic-a)"/>
        <path d="M12 5.6v13.4" stroke="var(--ic-b)" stroke-width="1.5"/>
        <path d="M14.6 9.4a2.1 2.1 0 1 1 2.8 2c-.6.3-.9.8-.9 1.5" fill="none" stroke="var(--ic-b)" stroke-width="1.6" stroke-linecap="round"/>
        <circle cx="16.5" cy="15.5" r="1" fill="var(--ic-b)"/>`,
  },
  news: {
    a: '#43d9e8', b: '#0d5a66',
    p: `<path d="M3.4 5.6h13.2v12.8a2 2 0 0 1-2 2H5.4a2 2 0 0 1-2-2z" fill="var(--ic-a)"/>
        <path d="M16.6 8.4h2.6a1.8 1.8 0 0 1 1.8 1.8v8.2a2 2 0 0 1-2 2h-2.4z" fill="var(--ic-b)"/>
        <path d="M6.2 8.8h7.6M6.2 12h7.6M6.2 15.2h4.6" stroke="#04222a" stroke-width="1.6" stroke-linecap="round"/>`,
  },
  leaderboard: {
    a: '#ffd75e', b: '#8a6206',
    p: `<rect x="9.2" y="4.2" width="5.6" height="16" rx="1.2" fill="var(--ic-a)"/>
        <rect x="2.6" y="10.4" width="5.6" height="9.8" rx="1.2" fill="var(--ic-b)"/>
        <rect x="15.8" y="13" width="5.6" height="7.2" rx="1.2" fill="var(--ic-b)"/>
        <path d="m12 5.6.9 1.9 2 .3-1.5 1.4.4 2-1.8-1-1.8 1 .4-2L9.1 7.8l2-.3z" fill="#4a3200"/>`,
  },
  hall: {
    a: '#e0c98a', b: '#7a6320',
    p: `<path d="M12 2.6 21.4 8H2.6z" fill="var(--ic-a)"/>
        <path d="M5 9.4h2.6v8.2H5zM10.7 9.4h2.6v8.2h-2.6zM16.4 9.4H19v8.2h-2.6z" fill="var(--ic-a)"/>
        <rect x="2.6" y="18.2" width="18.8" height="2.8" rx="1.2" fill="var(--ic-b)"/>`,
  },
  inventory: {
    a: '#b07a4a', b: '#5a3819',
    p: `<path d="M3.4 8.6h17.2v10.2a2 2 0 0 1-2 2H5.4a2 2 0 0 1-2-2z" fill="var(--ic-a)"/>
        <rect x="2.4" y="5.6" width="19.2" height="4.4" rx="1.6" fill="var(--ic-b)"/>
        <path d="M8.4 5.6a3.6 3.6 0 0 1 7.2 0" fill="none" stroke="var(--ic-b)" stroke-width="1.9"/>
        <rect x="10.4" y="11.4" width="3.2" height="4" rx="1" fill="#ffe6b8"/>`,
  },
  shop: {
    a: '#ff6bd4', b: '#8a1e69',
    p: `<path d="M4.2 8.6h15.6l-1.2 10.6a2 2 0 0 1-2 1.8H7.4a2 2 0 0 1-2-1.8z" fill="var(--ic-a)"/>
        <path d="M8.4 10V7.4a3.6 3.6 0 0 1 7.2 0V10" fill="none" stroke="var(--ic-b)" stroke-width="2" stroke-linecap="round"/>
        <path d="M4.2 8.6h15.6l-.3 2.6H4.5z" fill="var(--ic-b)" opacity=".5"/>`,
  },
  gacha: {
    a: '#ff5d5d', b: '#7a1414',
    p: `<path d="M12 2.8a7.6 7.6 0 0 1 7.6 7.6H4.4A7.6 7.6 0 0 1 12 2.8z" fill="var(--ic-a)"/>
        <rect x="3.6" y="10.4" width="16.8" height="10.6" rx="2.2" fill="var(--ic-b)"/>
        <circle cx="12" cy="15.8" r="3" fill="var(--ic-a)"/>
        <circle cx="12" cy="15.8" r="1.2" fill="#fff"/>`,
  },
  gemshop: {
    a: '#57e0ff', b: '#c2410c',
    p: `<path d="M7 4.6h10l2.6 4.2-7.6 10.6L4.4 8.8z" fill="var(--ic-a)"/>
        <path d="M4.4 8.8h15.2" stroke="#e8fbff" stroke-width="1.2"/>
        <circle cx="18.4" cy="17.6" r="4.2" fill="var(--ic-b)"/>
        <path d="M18.4 15.2v4.8M16.6 16.4h2.6a1 1 0 0 1 0 2h-1.6a1 1 0 0 0 0 2h2.4" fill="none" stroke="#fff" stroke-width="1.2" stroke-linecap="round"/>`,
  },
  battlepass: {
    a: '#8b6cff', b: '#3d2a80',
    p: `<rect x="2.6" y="6" width="18.8" height="12" rx="2.4" fill="var(--ic-a)"/>
        <path d="M2.6 10.2h18.8v3.6H2.6z" fill="var(--ic-b)"/>
        <circle cx="7.4" cy="12" r="2.2" fill="#fff"/>
        <path d="M13 12h5.6" stroke="#fff" stroke-width="1.8" stroke-linecap="round"/>`,
  },
  admin: {
    a: '#ffd75e', b: '#6b4a00',
    p: `<path d="M12 2.6 20 6v6.4c0 4.4-3.2 7.8-8 9-4.8-1.2-8-4.6-8-9V6z" fill="var(--ic-a)"/>
        <path d="m7.4 11.4 2.2-3.4 2.4 3 2.4-3 2.2 3.4-1 5.2H8.4z" fill="var(--ic-b)"/>`,
  },

  // ===== ゲーム中の HUD =====================================================
  quit: {
    a: '#ff8080', b: '#5a1414',
    p: `<circle cx="12" cy="12" r="9" fill="var(--ic-b)"/>
        <path d="m8.4 8.4 7.2 7.2M15.6 8.4l-7.2 7.2" stroke="var(--ic-a)" stroke-width="2.4" stroke-linecap="round"/>`,
  },
  reroll: {
    a: '#5b8bff', b: '#1c2b55',
    p: `<circle cx="12" cy="12" r="9" fill="var(--ic-b)"/>
        <path d="M16.6 10.4a5.2 5.2 0 1 0 .3 3.4" fill="none" stroke="var(--ic-a)" stroke-width="2" stroke-linecap="round"/>
        <path d="M17.4 6.4v4.2h-4.2" fill="none" stroke="var(--ic-a)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>`,
  },
  ultimate: {
    a: '#ffd75e', b: '#6b4a00',
    p: `<circle cx="12" cy="12" r="9" fill="var(--ic-b)"/>
        <path d="M13.4 3.6 6.6 13h4.2l-1.2 7.4L17.4 11h-4.2z" fill="var(--ic-a)"/>`,
  },
  autopilot: {
    a: '#43d9e8', b: '#0d3a44',
    p: `<rect x="4" y="7.4" width="16" height="11.2" rx="3" fill="var(--ic-a)"/>
        <circle cx="9" cy="12.6" r="1.7" fill="var(--ic-b)"/><circle cx="15" cy="12.6" r="1.7" fill="var(--ic-b)"/>
        <path d="M9.4 16.4h5.2" stroke="var(--ic-b)" stroke-width="1.6" stroke-linecap="round"/>
        <path d="M12 3v4.4M6.4 6 8 8M17.6 6 16 8" stroke="var(--ic-a)" stroke-width="1.8" stroke-linecap="round"/>`,
  },
  emote: {
    a: '#ffd75e', b: '#6b4a00',
    p: `<circle cx="12" cy="12" r="9" fill="var(--ic-a)"/>
        <circle cx="9" cy="10.2" r="1.5" fill="var(--ic-b)"/><circle cx="15" cy="10.2" r="1.5" fill="var(--ic-b)"/>
        <path d="M7.8 14.2a4.8 4.8 0 0 0 8.4 0" fill="none" stroke="var(--ic-b)" stroke-width="1.9" stroke-linecap="round"/>`,
  },
  clip: {
    a: '#ff6bd4', b: '#4a1038',
    p: `<rect x="2.6" y="6.4" width="14.4" height="11.2" rx="2.2" fill="var(--ic-a)"/>
        <path d="m17.6 11 3.8-2.6v7.2L17.6 13z" fill="var(--ic-b)"/>
        <circle cx="9.8" cy="12" r="2.6" fill="#fff" opacity=".85"/>`,
  },
  admincmd: {
    a: '#ffd75e', b: '#6b4a00',
    p: `<rect x="2.8" y="4.6" width="18.4" height="14.8" rx="2.6" fill="var(--ic-b)"/>
        <path d="m6.6 9.4 3 2.8-3 2.8" fill="none" stroke="var(--ic-a)" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"/>
        <path d="M11.8 15.2h5.6" stroke="var(--ic-a)" stroke-width="1.9" stroke-linecap="round"/>`,
  },
  offline: {
    a: '#9fb0d4', b: '#ff5d5d',
    p: `<path d="M12 18.8a1.9 1.9 0 1 0 0-3.8 1.9 1.9 0 0 0 0 3.8z" fill="var(--ic-a)"/>
        <path d="M6.6 11.6a8 8 0 0 1 10.8 0M3.2 8a12.6 12.6 0 0 1 17.6 0" fill="none" stroke="var(--ic-a)" stroke-width="1.9" stroke-linecap="round"/>
        <path d="m3.6 3.6 16.8 16.8" stroke="var(--ic-b)" stroke-width="2.2" stroke-linecap="round"/>`,
  },
  chat: {
    a: '#5b8bff', b: '#22315e',
    p: `<path d="M3.4 6a2.4 2.4 0 0 1 2.4-2.4h12.4A2.4 2.4 0 0 1 20.6 6v7.6a2.4 2.4 0 0 1-2.4 2.4H9l-5.6 4z" fill="var(--ic-a)"/>
        <path d="M7.4 8.4h9.2M7.4 11.8h6" stroke="var(--ic-b)" stroke-width="1.7" stroke-linecap="round"/>`,
  },

  // ===== モード =============================================================
  mode_solo: {
    a: '#5b8bff', b: '#a8c0ff',
    p: `<rect x="3.4" y="3.4" width="7.6" height="7.6" rx="1.8" fill="var(--ic-a)"/>
        <rect x="13" y="3.4" width="7.6" height="7.6" rx="1.8" fill="var(--ic-b)"/>
        <rect x="3.4" y="13" width="7.6" height="7.6" rx="1.8" fill="var(--ic-b)"/>
        <rect x="13" y="13" width="7.6" height="7.6" rx="1.8" fill="var(--ic-a)"/>`,
  },
  mode_ai: {
    a: '#ff8a5c', b: '#5c2408',
    p: `<rect x="4.2" y="6.6" width="15.6" height="12" rx="3.2" fill="var(--ic-a)"/>
        <path d="M12 2.6v4" stroke="var(--ic-a)" stroke-width="1.9" stroke-linecap="round"/>
        <circle cx="12" cy="2.6" r="1.6" fill="var(--ic-a)"/>
        <rect x="7.6" y="10.2" width="3" height="3.6" rx="1.5" fill="var(--ic-b)"/>
        <rect x="13.4" y="10.2" width="3" height="3.6" rx="1.5" fill="var(--ic-b)"/>
        <path d="M9.4 15.8h5.2" stroke="var(--ic-b)" stroke-width="1.7" stroke-linecap="round"/>`,
  },
  mode_boss: {
    a: '#b06bff', b: '#3d1170',
    p: `<path d="M4 9.6 7 4.4l3.2 3 1.8-3.4 1.8 3.4 3.2-3 3 5.2v5.6c0 3-2.6 5.2-8 5.2s-8-2.2-8-5.2z" fill="var(--ic-a)"/>
        <circle cx="9" cy="12.6" r="1.7" fill="var(--ic-b)"/><circle cx="15" cy="12.6" r="1.7" fill="var(--ic-b)"/>
        <path d="M9.4 16.6h5.2" stroke="var(--ic-b)" stroke-width="1.7" stroke-linecap="round"/>`,
  },
  mode_dungeon: {
    a: '#9fb0d4', b: '#39415c',
    p: `<path d="M3.6 20.4V8.6l4-2.4V3.4h3v1.4l1.4-.8 1.4.8V3.4h3v2.8l4 2.4v12z" fill="var(--ic-a)"/>
        <path d="M9.6 20.4v-5.2a2.4 2.4 0 0 1 4.8 0v5.2z" fill="var(--ic-b)"/>
        <path d="M6.4 10.6h2.2v2.4H6.4zM15.4 10.6h2.2v2.4h-2.2z" fill="var(--ic-b)"/>`,
  },
  mode_sprint: {
    a: '#43d9e8', b: '#0d3a44',
    p: `<circle cx="12" cy="13.4" r="8.2" fill="var(--ic-a)"/>
        <circle cx="12" cy="13.4" r="6.2" fill="var(--ic-b)"/>
        <path d="M12 9v4.4l3 2" fill="none" stroke="#fff" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"/>
        <path d="M9.4 2.6h5.2" stroke="var(--ic-a)" stroke-width="2.2" stroke-linecap="round"/>`,
  },
  // 的＋刺さった矢。以前は「同心円＋斜め線」だけで、mode_royale（同心円＋十字の
  // 目盛り）と白一色にしたときに区別が付かなかった。的を左下へ寄せ、矢羽根を
  // 円の外へ出すことで、シルエットの外形そのものを変えている。
  mode_weekly: {
    a: '#5ee86e', b: '#1d6b2c',
    p: `<circle cx="10.6" cy="13.4" r="8.2" fill="var(--ic-b)"/>
        <circle cx="10.6" cy="13.4" r="5" fill="var(--ic-a)"/>
        <circle cx="10.6" cy="13.4" r="1.8" fill="var(--ic-b)"/>
        <path d="M10.6 13.4 21.4 2.6" stroke="var(--ic-a)" stroke-width="2.2" stroke-linecap="round"/>
        <path d="M17.4 2.6h4v4" fill="none" stroke="var(--ic-a)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>`,
  },
  mode_daily: {
    a: '#ff9d3d', b: '#8a4708',
    p: `<rect x="3.4" y="5" width="17.2" height="15.6" rx="2.6" fill="var(--ic-a)"/>
        <path d="M3.4 9.6h17.2" stroke="var(--ic-b)" stroke-width="2"/>
        <path d="M7.6 3.2v3.6M16.4 3.2v3.6" stroke="var(--ic-b)" stroke-width="2.2" stroke-linecap="round"/>
        <rect x="10.4" y="12.4" width="3.4" height="3.4" rx="1" fill="var(--ic-b)"/>`,
  },
  mode_survival: {
    a: '#e8e8f0', b: '#3a1c1c',
    p: `<path d="M12 2.8c4.6 0 7.8 3.2 7.8 7.4 0 2.6-1.2 4-2.4 5v2.2a1.8 1.8 0 0 1-1.8 1.8H8.4a1.8 1.8 0 0 1-1.8-1.8v-2.2c-1.2-1-2.4-2.4-2.4-5C4.2 6 7.4 2.8 12 2.8z" fill="var(--ic-a)"/>
        <circle cx="9.2" cy="10.4" r="2" fill="var(--ic-b)"/><circle cx="14.8" cy="10.4" r="2" fill="var(--ic-b)"/>
        <path d="M10.4 21.2v-2M13.6 21.2v-2" stroke="var(--ic-a)" stroke-width="1.9" stroke-linecap="round"/>`,
  },
  mode_meltdown: {
    a: '#c6ff4a', b: '#2e3a06',
    p: `<circle cx="12" cy="12" r="9" fill="var(--ic-a)"/>
        <circle cx="12" cy="12" r="2.3" fill="var(--ic-b)"/>
        <path d="M12 3.6a8.4 8.4 0 0 1 4.2 1.1l-3 5.2a2.4 2.4 0 0 0-1.2-.3zM4.6 16.2a8.4 8.4 0 0 1-.2-7.4l5.2 3a2.4 2.4 0 0 0 0 1.2zM19.4 16.2a8.4 8.4 0 0 1-6.4 4.2l0-6a2.4 2.4 0 0 0 1-.6z" fill="var(--ic-b)"/>`,
  },
  mode_chimera: {
    a: '#b06bff', b: '#3d1170',
    p: `<path d="M8.4 3.6a4.4 4.4 0 0 1 0 8.8 4.4 4.4 0 0 0 0 8.8" fill="none" stroke="var(--ic-a)" stroke-width="2.3" stroke-linecap="round"/>
        <path d="M15.6 3.6a4.4 4.4 0 0 0 0 8.8 4.4 4.4 0 0 1 0 8.8" fill="none" stroke="var(--ic-b)" stroke-width="2.3" stroke-linecap="round"/>
        <circle cx="12" cy="12" r="2.2" fill="var(--ic-a)"/>`,
  },
  mode_chain: {
    a: '#57e0ff', b: '#1c7fa8',
    p: `<rect x="2.6" y="8.4" width="9" height="7.2" rx="3.6" fill="none" stroke="var(--ic-a)" stroke-width="2.2"/>
        <rect x="12.4" y="8.4" width="9" height="7.2" rx="3.6" fill="none" stroke="var(--ic-b)" stroke-width="2.2"/>
        <path d="M9.4 12h5.2" stroke="var(--ic-a)" stroke-width="2.2" stroke-linecap="round"/>`,
  },
  mode_blueprint: {
    a: '#5b8bff', b: '#0d1c40',
    p: `<rect x="3" y="4.4" width="18" height="15.2" rx="2.2" fill="var(--ic-b)"/>
        <path d="M3 9h18M8.4 4.4v15.2M14.4 9v10.6" stroke="var(--ic-a)" stroke-width="1.3" opacity=".55"/>
        <path d="M10.4 11.4h5.6v5.6h-5.6z" fill="none" stroke="var(--ic-a)" stroke-width="2"/>`,
  },
  mode_puzzle: {
    a: '#5ee86e', b: '#1d6b2c',
    p: `<path d="M4.4 4.4h6v1.8a1.8 1.8 0 0 0 3.6 0V4.4h5.6v5.6h-1.8a1.8 1.8 0 0 0 0 3.6h1.8v6h-6v-1.8a1.8 1.8 0 0 0-3.6 0v1.8H4.4z" fill="var(--ic-a)"/>
        <path d="M10.4 10.4h3.2v3.2h-3.2z" fill="var(--ic-b)"/>`,
  },
  mode_workshop: {
    a: '#ff9d3d', b: '#5c2f06',
    p: `<path d="m4.4 16.4 7.2-7.2a4.6 4.6 0 0 1 5.6-5.6l-2.6 2.6 2 2 2.6-2.6a4.6 4.6 0 0 1-5.6 5.6l-7.2 7.2z" fill="var(--ic-a)"/>
        <circle cx="6" cy="18" r="2.2" fill="var(--ic-b)"/>
        <path d="m14.6 14.6 5 5" stroke="var(--ic-b)" stroke-width="2.4" stroke-linecap="round"/>`,
  },
  mode_dig: {
    a: '#b07a4a', b: '#3d2410',
    p: `<path d="M3.4 6.6c4-3 12.6-3 17.2 0-2.6.6-5 2.2-6.4 4.2L11 8.4C9 7.2 6.2 6.6 3.4 6.6z" fill="var(--ic-a)"/>
        <path d="m10.4 10 3.2 3.2-7 7a2.3 2.3 0 0 1-3.2-3.2z" fill="var(--ic-b)"/>`,
  },
  mode_ghost: {
    a: '#dfe6ff', b: '#2b3358',
    p: `<path d="M12 2.8a7.4 7.4 0 0 1 7.4 7.4v10.4l-2.5-1.8-2.4 1.8-2.5-1.8-2.5 1.8-2.4-1.8-2.5 1.8V10.2A7.4 7.4 0 0 1 12 2.8z" fill="var(--ic-a)"/>
        <circle cx="9.4" cy="10" r="1.7" fill="var(--ic-b)"/><circle cx="14.6" cy="10" r="1.7" fill="var(--ic-b)"/>`,
  },
  mode_chaos: {
    a: '#ff6bd4', b: '#5a1244',
    p: `<path d="M3.4 6.6h11.2a3 3 0 1 0-2.6-4.4" fill="none" stroke="var(--ic-a)" stroke-width="2.2" stroke-linecap="round"/>
        <path d="M2.6 12h15a3.2 3.2 0 1 1-2.8 4.8" fill="none" stroke="var(--ic-b)" stroke-width="2.2" stroke-linecap="round"/>
        <path d="M4.4 17.6h6.8" stroke="var(--ic-a)" stroke-width="2.2" stroke-linecap="round"/>`,
  },
  mode_online: {
    a: '#5ee86e', b: '#124d22',
    p: `<circle cx="12" cy="12" r="9" fill="var(--ic-a)"/>
        <path d="M3 12h18M12 3c2.6 2.6 2.6 15 0 18M12 3c-2.6 2.6-2.6 15 0 18" fill="none" stroke="var(--ic-b)" stroke-width="1.6"/>`,
  },
  mode_royale: {
    a: '#ff5d5d', b: '#5a1414',
    p: `<circle cx="12" cy="12" r="9" fill="none" stroke="var(--ic-b)" stroke-width="2"/>
        <circle cx="12" cy="12" r="5.2" fill="none" stroke="var(--ic-a)" stroke-width="2"/>
        <circle cx="12" cy="12" r="1.8" fill="var(--ic-a)"/>
        <path d="M12 1.6v3.4M12 19v3.4M1.6 12H5M19 12h3.4" stroke="var(--ic-a)" stroke-width="2" stroke-linecap="round"/>`,
  },
  mode_tourney: {
    a: '#ffd75e', b: '#6b4a00',
    p: `<path d="M7.4 3.6h9.2v4.6a4.6 4.6 0 0 1-9.2 0z" fill="var(--ic-a)"/>
        <path d="M7.4 4.8H4.6v1.6a3.4 3.4 0 0 0 3 3.4M16.6 4.8h2.8v1.6a3.4 3.4 0 0 1-3 3.4" fill="none" stroke="var(--ic-a)" stroke-width="1.8"/>
        <path d="M10.4 12.6h3.2v3.4h-3.2z" fill="var(--ic-b)"/>
        <rect x="6.6" y="17.6" width="10.8" height="2.8" rx="1.3" fill="var(--ic-b)"/>`,
  },
  mode_coop: {
    a: '#5ee86e', b: '#1d6b2c',
    p: `<path d="M12 20.4 4.8 14a4.6 4.6 0 0 1 7.2-5.6A4.6 4.6 0 0 1 19.2 14z" fill="var(--ic-a)"/>
        <path d="M12 8.4A4.6 4.6 0 0 1 19.2 14L12 20.4z" fill="var(--ic-b)" opacity=".55"/>`,
  },
  mode_raid: {
    a: '#43d9e8', b: '#0d3a44',
    p: `<path d="M12 2.6c4 2 6.4 4.6 6.4 8.6 0 3-1.8 5.4-4 6.6l1 3.6H8.6l1-3.6c-2.2-1.2-4-3.6-4-6.6 0-4 2.4-6.6 6.4-8.6z" fill="var(--ic-a)"/>
        <circle cx="9.6" cy="10.4" r="1.6" fill="var(--ic-b)"/><circle cx="14.4" cy="10.4" r="1.6" fill="var(--ic-b)"/>
        <path d="M9.8 14.2h4.4" stroke="var(--ic-b)" stroke-width="1.7" stroke-linecap="round"/>`,
  },
  mode_abyss: {
    a: '#8b6cff', b: '#160a33',
    p: `<circle cx="12" cy="12" r="9" fill="var(--ic-b)"/>
        <path d="M12 3.4a8.6 8.6 0 0 1 0 17.2 5.6 5.6 0 0 0 0-17.2z" fill="var(--ic-a)"/>
        <circle cx="12" cy="12" r="2.6" fill="var(--ic-a)"/>`,
  },
  mode_bossrush: {
    a: '#ff5d5d', b: '#5a1414',
    p: `<path d="M2.6 12 6 5.4l2.4 2.6L10 5.2l1.6 2.8 2.4-2.6L17.4 12v3.4c0 2.4-2.6 4-7.4 4s-7.4-1.6-7.4-4z" fill="var(--ic-a)"/>
        <path d="M18.4 6.6 22 12l-3.6 5.4" fill="none" stroke="var(--ic-b)" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/>
        <circle cx="7.4" cy="12.6" r="1.5" fill="var(--ic-b)"/><circle cx="12.6" cy="12.6" r="1.5" fill="var(--ic-b)"/>`,
  },
  mode_adminevent: {
    a: '#ffd75e', b: '#6b4a00',
    p: `<path d="m3.4 17.6 1.4-10 4.6 3.6L12 5.4l2.6 5.8 4.6-3.6 1.4 10z" fill="var(--ic-a)"/>
        <rect x="3.4" y="18" width="17.2" height="2.8" rx="1.3" fill="var(--ic-b)"/>
        <circle cx="12" cy="4" r="1.7" fill="var(--ic-b)"/>`,
  },
  mode_room: {
    a: '#9fb0d4', b: '#38425c',
    p: `<rect x="3" y="6.6" width="18" height="12.8" rx="2.6" fill="var(--ic-a)"/>
        <path d="M7.4 6.6V5a2 2 0 0 1 2-2h5.2a2 2 0 0 1 2 2v1.6" fill="none" stroke="var(--ic-a)" stroke-width="2"/>
        <path d="M7.4 11.4h9.2M7.4 15h5.6" stroke="var(--ic-b)" stroke-width="1.9" stroke-linecap="round"/>`,
  },

  // ===== 順位・王座 =========================================================
  //
  // 🥇🥈🥉 の置き換え。絵文字のメダルは端末によって金と銅がほとんど同じ色に
  // 見えることがあり（特に小さい行の中では 13px まで縮む）、色だけに頼ると
  // 1位と3位が読み分けられない。ここでは **リボンの形** も段で変える:
  //   1位 … リボン2本＋星     2位 … リボン2本＋横2本    3位 … リボン1本＋横1本
  // 色を落としても順位が読めることが条件（tools/icons-preview.html の SOLID CHECK）。
  medal_1: {
    a: '#ffd75e', b: '#8a6206',
    p: `<path d="M6.2 1.6 9.8 8.2 7 9.8 3.4 3.2zM17.8 1.6 14.2 8.2 17 9.8l3.6-6.6z" fill="var(--ic-b)"/>
        <circle cx="12" cy="15.2" r="6.8" fill="var(--ic-a)"/>
        <path d="m12 10.4 1.5 3 3.3.5-2.4 2.3.6 3.3-3-1.6-3 1.6.6-3.3-2.4-2.3 3.3-.5z" fill="var(--ic-b)"/>`,
  },
  medal_2: {
    a: '#c9d4e4', b: '#5a6577',
    p: `<path d="M6.2 1.6 9.8 8.2 7 9.8 3.4 3.2zM17.8 1.6 14.2 8.2 17 9.8l3.6-6.6z" fill="var(--ic-b)"/>
        <circle cx="12" cy="15.2" r="6.8" fill="var(--ic-a)"/>
        <path d="M8.6 13.2h6.8M8.6 17.2h6.8" stroke="var(--ic-b)" stroke-width="2.2" stroke-linecap="round"/>`,
  },
  medal_3: {
    a: '#cd7f32', b: '#6b3d12',
    p: `<path d="M8.2 1.6 12 8.6 9.2 10.2 5.4 3.2z" fill="var(--ic-b)"/>
        <circle cx="12" cy="15.2" r="6.8" fill="var(--ic-a)"/>
        <path d="M8.6 15.2h6.8" stroke="var(--ic-b)" stroke-width="2.4" stroke-linecap="round"/>`,
  },
  // 👑 いま王座に座っている人の印。N冠バッジ（badge_crown2/3/5/7）とは別物で、
  // あちらは「いくつ取ったか」を玉の数で数える持ち物、こちらは1つの席の主。
  // 台座を敷いて「座っている」ことを形で出し、冠だけの badge_crown* と分ける。
  throne: {
    a: '#ffd75e', b: '#6b4a00',
    p: `<path d="M3.4 5.4 7.6 9.4 12 3.2l4.4 6.2 4.2-4-1.6 9.2H5z" fill="var(--ic-a)"/>
        <circle cx="3.4" cy="4.2" r="1.5" fill="var(--ic-b)"/><circle cx="20.6" cy="4.2" r="1.5" fill="var(--ic-b)"/><circle cx="12" cy="2.4" r="1.6" fill="var(--ic-b)"/>
        <rect x="4" y="16.4" width="16" height="2.6" rx="1.3" fill="var(--ic-a)"/>
        <rect x="2.4" y="20.2" width="19.2" height="2.6" rx="1.3" fill="var(--ic-b)"/>`,
  },

  // ===== 汎用 ===============================================================
  back: {
    a: 'currentColor', b: 'currentColor',
    p: `<path d="M14.6 5.4 8 12l6.6 6.6" fill="none" stroke="var(--ic-a)" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/>`,
  },
  close: {
    a: 'currentColor', b: 'currentColor',
    p: `<path d="m6.6 6.6 10.8 10.8M17.4 6.6 6.6 17.4" fill="none" stroke="var(--ic-a)" stroke-width="2.4" stroke-linecap="round"/>`,
  },
  lock: {
    a: '#9fb0d4', b: '#38425c',
    p: `<rect x="4.6" y="10.4" width="14.8" height="10" rx="2.4" fill="var(--ic-a)"/>
        <path d="M7.8 10.4V7.8a4.2 4.2 0 0 1 8.4 0v2.6" fill="none" stroke="var(--ic-a)" stroke-width="2.2"/>
        <circle cx="12" cy="15" r="1.9" fill="var(--ic-b)"/>`,
  },
  check: {
    a: '#5ee86e', b: '#124d22',
    p: `<circle cx="12" cy="12" r="9" fill="var(--ic-b)"/>
        <path d="m7.6 12.2 3 3 5.8-6.4" fill="none" stroke="var(--ic-a)" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/>`,
  },
  warn: {
    a: '#ffd75e', b: '#6b4a00',
    p: `<path d="M12 3.2 22 20H2z" fill="var(--ic-a)"/>
        <path d="M12 9v4.6" stroke="var(--ic-b)" stroke-width="2.2" stroke-linecap="round"/>
        <circle cx="12" cy="17" r="1.3" fill="var(--ic-b)"/>`,
  },
  placeholder: {
    a: '#6b7690', b: '#39415c',
    p: `<rect x="4" y="4" width="16" height="16" rx="3.4" fill="var(--ic-b)"/>
        <circle cx="12" cy="12" r="3.2" fill="var(--ic-a)"/>`,
  },
};

// ---------------------------------------------------------------------------
// ランク帯（🥉🥈🥇💠💎👑 を置き換える）
//
// 絵文字のままだと問題が2つあった:
//   ・💎 が「ジェム（通貨）」とダイヤ帯の両方で使われていて、所持ジェムと
//     段位が同じ絵になっていた。
//   ・👑 がマスター帯・奥義「全能【管理者】」・AI難易度「達人」の三重複。
//
// ここでは6帯すべてを同じ盾型で描き、帯ごとに「色」だけでなく
// **下辺のピップの数**（0〜5個）で段位が読めるようにする。色だけで分けると、
// 色覚特性のある人や白黒表示で区別が付かない。
// しきい値は dom.js rankOf / server/battle.js RANK_TIERS と一致させること。
// ---------------------------------------------------------------------------
// 帯の色は public/js/ranks.js（段位の唯一の正解）に合わせること。
// pips = 盾の下に並ぶ玉の数。0〜7 で帯の高さが数えられる。
// 上位3帯は玉だけだと数えづらいので、盾の中の紋章も足して段違いに見せる。
const RANK_TIERS = [
  ['rank_bronze',      '#cd7f32', '#6b3d12', 0, ''],
  ['rank_silver',      '#c9d4e4', '#5a6577', 1, ''],
  ['rank_gold',        '#ffd75e', '#8a6206', 2, ''],
  ['rank_platinum',    '#9fd8ff', '#2a5a7a', 3, ''],
  ['rank_diamond',     '#57e0ff', '#1c7fa8', 4, ''],
  // マスター … 小さな冠
  ['rank_master',      '#ff6bd4', '#6b1050', 5, '<path d="m8.4 9.4 1.8 2 1.8-2.4 1.8 2.4 1.8-2 .6 3.6H7.8z" fill="var(--ic-a)"/>'],
  // グランドマスター … 冠＋台座（マスターの一段上だと形で分かる）
  ['rank_grandmaster', '#b06bff', '#33146b', 6, '<path d="m8.2 9 1.9 2.1 1.9-2.5 1.9 2.5L15.8 9l.6 3.4H7.6z" fill="var(--ic-a)"/><path d="M8 13.4h8v1.5H8z" fill="var(--ic-a)"/>'],
  // レジェンド … 八芒星（冠の系統から外して、最上位だと一目で分かる形に）
  ['rank_legend',      '#ff8a5c', '#6b2408', 7, '<path d="m12 6.6 1.5 3.3 3.3 1.5-3.3 1.5-1.5 3.3-1.5-3.3-3.3-1.5 3.3-1.5z" fill="var(--ic-a)"/><path d="M12 7.4 10.7 11 12 14.6 13.3 11z" fill="#fff" opacity=".45"/>'],
];
for (const [name, a, b, pips, crest] of RANK_TIERS) {
  // 中央のメダル＋下辺に並ぶピップ（0〜7個）で帯が読める。
  // 玉が7個だと間隔が詰まるので、数に応じて詰め幅を縮める。
  const gap = pips >= 6 ? 2.9 : 3.4;
  const dots = Array.from({ length: pips }, (_, i) => {
    const x = 12 + (i - (pips - 1) / 2) * gap;
    return `<circle cx="${x.toFixed(1)}" cy="20.4" r="1.2" fill="var(--ic-a)"/>`;
  }).join('');
  ICONS[name] = {
    a, b,
    p: `<path d="M12 2.6 20 7v6.4L12 18 4 13.4V7z" fill="var(--ic-a)"/>
        <path d="M12 5.8 16.8 8.6v4.2L12 15.6 7.2 12.8V8.6z" fill="var(--ic-b)"/>
        ${crest}
        ${dots}`,
  };
}

// ---------------------------------------------------------------------------
// 奥義（アルティメット）
// ---------------------------------------------------------------------------
Object.assign(ICONS, {
  ult_blast: {
    a: '#ff8a5c', b: '#7a2708',
    p: `<path d="M12 2.4 14.6 8l6-1.4-3.4 5.2 3.4 5.2-6-1.4L12 21.2 9.4 15.6l-6 1.4 3.4-5.2L3.4 6.6l6 1.4z" fill="var(--ic-a)"/>
        <circle cx="12" cy="11.8" r="2.8" fill="var(--ic-b)"/>`,
  },
  ult_purify: {
    a: '#57e0ff', b: '#0d5a7a',
    p: `<path d="M12 2.6c3.6 4.4 6.4 7.6 6.4 11a6.4 6.4 0 0 1-12.8 0c0-3.4 2.8-6.6 6.4-11z" fill="var(--ic-a)"/>
        <path d="M8.6 14.4a3.4 3.4 0 0 0 6.8 0 3.4 3.4 0 0 1-6.8 0z" fill="var(--ic-b)"/>
        <path d="M5.2 18.6c1.6 1.4 3.2 1.4 4.8 0s3.2-1.4 4.8 0 3.2 1.4 4.8 0" fill="none" stroke="var(--ic-b)" stroke-width="1.7" stroke-linecap="round"/>`,
  },
  ult_gravity: {
    a: '#b06bff', b: '#3d1170',
    p: `<path d="M12 2.6v9.8M8.2 9l3.8 3.8L15.8 9" fill="none" stroke="var(--ic-a)" stroke-width="2.3" stroke-linecap="round" stroke-linejoin="round"/>
        <rect x="3.6" y="15.4" width="16.8" height="5.2" rx="1.8" fill="var(--ic-b)"/>
        <path d="M7.4 15.4v5.2M12 15.4v5.2M16.6 15.4v5.2" stroke="var(--ic-a)" stroke-width="1.3" opacity=".6"/>`,
  },
  // スコア3倍。⚡だと「神の裁き」と見分けが付かないので、
  // 振り切れたメーターと ×3 の目盛りで「倍率」だと分かる形にする。
  ult_overdrive: {
    a: '#ff5d5d', b: '#6b0e0e',
    p: `<path d="M3.4 18.4a9.4 9.4 0 1 1 17.2 0z" fill="var(--ic-b)"/>
        <path d="M12 18.4 18.6 8.6" stroke="var(--ic-a)" stroke-width="2.6" stroke-linecap="round"/>
        <circle cx="12" cy="18.4" r="2.2" fill="var(--ic-a)"/>
        <path d="M5.6 15.4h1.8M7.4 11h1.8M11.2 8.6h1.6M16.6 15.4h1.8" stroke="var(--ic-a)" stroke-width="1.6" stroke-linecap="round" opacity=".85"/>`,
  },
  ult_meteor: {
    a: '#ffb347', b: '#7a3a08',
    p: `<circle cx="16.4" cy="7.6" r="4.4" fill="var(--ic-a)"/>
        <circle cx="15" cy="6.4" r="1.3" fill="var(--ic-b)"/><circle cx="18" cy="9" r="1" fill="var(--ic-b)"/>
        <path d="m12.6 11.4-9 9M9.6 7.6l-5 5M16.4 15.4l-5 5" fill="none" stroke="var(--ic-a)" stroke-width="2.1" stroke-linecap="round"/>`,
  },
  ult_rainbow: {
    a: '#ff6bd4', b: '#57e0ff',
    p: `<path d="M3.4 19.4a8.6 8.6 0 0 1 17.2 0" fill="none" stroke="var(--ic-a)" stroke-width="2.6" stroke-linecap="round"/>
        <path d="M6.6 19.4a5.4 5.4 0 0 1 10.8 0" fill="none" stroke="#ffd75e" stroke-width="2.6" stroke-linecap="round"/>
        <path d="M9.8 19.4a2.2 2.2 0 0 1 4.4 0" fill="none" stroke="var(--ic-b)" stroke-width="2.6" stroke-linecap="round"/>`,
  },
  // 不落の城塞。ただの盾だと guild / admin / item_god_shield と外形が同じで、
  // 中の1本線は色を落とすと消えていた。上辺を狭間（銃眼）にして
  // **外形そのもの**を城壁に変え、石積みの目地で中身も埋める。
  ult_fortress: {
    a: '#43d9e8', b: '#0d3a44',
    p: `<path d="M3.6 3.6H7v2h3.3v-2h3.4v2H17v-2h3.4v8.6c0 4.2-3.4 7.4-8.4 8.8-5-1.4-8.4-4.6-8.4-8.8z" fill="var(--ic-a)"/>
        <path d="M3.6 9.6h16.8M12 9.6v11.4M7.8 9.6V5.6M16.2 9.6V5.6M7.6 15.4h8.8" stroke="var(--ic-b)" stroke-width="1.6"/>`,
  },
  ult_timestop: {
    a: '#dfe6ff', b: '#3a4468',
    p: `<path d="M6.6 2.8h10.8v3.6L12 11l5.4 4.6v3.6H6.6v-3.6L12 11 6.6 6.4z" fill="var(--ic-a)"/>
        <path d="M9.4 17.4h5.2L12 14.4z" fill="var(--ic-b)"/>
        <path d="M4.6 2.8h14.8M4.6 19.2h14.8" stroke="var(--ic-b)" stroke-width="2.2" stroke-linecap="round"/>`,
  },
  // 神の裁き。雷だけだと ultimate（HUDの発動ボタン）・cat_ult（棚の見出し）と
  // 3つとも「稲妻」になり、ショップで見出しと商品が同じ絵で並んでいた。
  // 「落ちた先の地面が割れている」を足して、雷そのものではなく“裁きの結果”に
  // 見えるようにする。
  ult_judgement: {
    a: '#ffd75e', b: '#ff9d3d',
    p: `<path d="M13.6 1.8 6.2 12.4h4.4L9 18.8 17.4 8h-4.4z" fill="var(--ic-a)"/>
        <path d="M2.6 20.8h4.8l2-2.6 2 2.6 2-2.6 2 2.6h6" fill="none" stroke="var(--ic-b)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>`,
  },
  ult_condemn: {
    a: '#8b6cff', b: '#2a1060',
    p: `<path d="M2.6 12S6.4 5.6 12 5.6 21.4 12 21.4 12 17.6 18.4 12 18.4 2.6 12 2.6 12z" fill="var(--ic-a)"/>
        <circle cx="12" cy="12" r="3.6" fill="var(--ic-b)"/>
        <path d="m4.6 4.6 14.8 14.8" stroke="#ff5d5d" stroke-width="2.2" stroke-linecap="round"/>`,
  },
  // 全能【管理者】。王冠にすると管理者イベント（mode_adminevent）と、
  // 光輪にすると管理者ブースター「神の一撃」（item_god_wipe）と同じ絵になる。
  // どちらとも被らないよう「∞（無限＝ゲージが尽きない）」で描き分ける。
  ult_admin: {
    a: '#ffd75e', b: '#6b4a00',
    p: `<circle cx="12" cy="12" r="9" fill="var(--ic-b)"/>
        <path d="M9 12a2.6 2.6 0 1 1 2.6 2.6c-2 0-2.6-5.2-4.6-5.2a2.6 2.6 0 0 0 0 5.2c2 0 2.6-5.2 4.6-5.2a2.6 2.6 0 0 1 0 5.2" fill="none" stroke="var(--ic-a)" stroke-width="2.1" stroke-linecap="round"/>`,
  },
});

// ---------------------------------------------------------------------------
// ブースター（消費アイテム）
// ---------------------------------------------------------------------------
Object.assign(ICONS, {
  item_bomb: {
    a: '#9aa6c4', b: '#2b3149',
    p: `<circle cx="11" cy="14.4" r="6.6" fill="var(--ic-a)"/>
        <circle cx="8.8" cy="12.2" r="1.8" fill="#fff" opacity=".55"/>
        <path d="M15.4 9.4 17.2 7.4a2.8 2.8 0 0 1 4-.2" fill="none" stroke="#ffb347" stroke-width="1.9" stroke-linecap="round"/>
        <path d="M21.4 4.4v3.4M19.4 5.2l1.4 1.4M23 5.2l-1.4 1.4" stroke="#ffd75e" stroke-width="1.6" stroke-linecap="round"/>`,
  },
  item_cleaner: {
    a: '#5ee86e', b: '#3d2a10',
    p: `<path d="m13.4 3.4 3.2 3.2-6 6-3.2-3.2z" fill="var(--ic-b)"/>
        <path d="M7.4 9.4 10.6 12.6 6 21l-3.4-3.4z" fill="var(--ic-a)"/>
        <path d="M17.4 4.6a4 4 0 0 1 3.2 3.2" fill="none" stroke="var(--ic-b)" stroke-width="1.8" stroke-linecap="round"/>`,
  },
  item_fever: {
    a: '#ffd75e', b: '#8a6206',
    p: `<path d="m12 2.4 2.9 6 6.5.9-4.7 4.6 1.1 6.5L12 17.4l-5.8 3 1.1-6.5-4.7-4.6 6.5-.9z" fill="var(--ic-a)"/>
        <path d="m12 6.4 1.6 3.4 3.6.5-2.6 2.6.6 3.6L12 14.8z" fill="var(--ic-b)" opacity=".5"/>`,
  },
  item_mini: {
    a: '#5ee86e', b: '#124d22',
    p: `<rect x="3.4" y="3.4" width="6.4" height="6.4" rx="1.5" fill="var(--ic-a)"/>
        <rect x="13" y="13" width="4.2" height="4.2" rx="1.2" fill="var(--ic-b)"/>
        <rect x="18" y="18" width="2.8" height="2.8" rx=".9" fill="var(--ic-b)"/>
        <path d="M11.4 8.2 17.6 2" fill="none" stroke="var(--ic-b)" stroke-width="1.8" stroke-linecap="round"/>`,
  },
  // ---- 管理者専用ブースター（絵文字だと奥義と丸かぶりしていた6つ） -------
  item_god_wipe: {
    a: '#ff5d5d', b: '#4a0808',
    p: `<circle cx="12" cy="12" r="4.4" fill="var(--ic-a)"/>
        <path d="M12 1.6v4M12 18.4v4M1.6 12h4M18.4 12h4M4.6 4.6l2.8 2.8M16.6 16.6l2.8 2.8M19.4 4.6l-2.8 2.8M7.4 16.6l-2.8 2.8" stroke="var(--ic-a)" stroke-width="2.2" stroke-linecap="round"/>
        <circle cx="12" cy="12" r="1.8" fill="var(--ic-b)"/>`,
  },
  // 時の支配（制限時間+120秒）。以前は「文字盤＋上の飾り」で、mode_sprint の
  // ストップウォッチと白一色にすると同じ丸時計だった。時計を左上へ寄せて
  // 右下に「＋」の玉を足し、外形に出っ張りを作って見分けが付くようにする。
  item_god_time: {
    a: '#57e0ff', b: '#0d3a44',
    p: `<circle cx="10.6" cy="11" r="8.4" fill="var(--ic-b)"/>
        <circle cx="10.6" cy="11" r="6.2" fill="var(--ic-a)"/>
        <path d="M10.6 6.8V11l3 2.2" fill="none" stroke="var(--ic-b)" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"/>
        <circle cx="18.8" cy="18.8" r="4.6" fill="var(--ic-a)"/>
        <path d="M18.8 16.2v5.2M16.2 18.8h5.2" stroke="var(--ic-b)" stroke-width="2" stroke-linecap="round"/>`,
  },
  item_god_hand: {
    a: '#ff9d3d', b: '#5c2f06',
    p: `<rect x="2.6" y="6.6" width="8" height="11" rx="1.8" transform="rotate(-12 6.6 12)" fill="var(--ic-a)"/>
        <rect x="8.4" y="5.6" width="8" height="11.6" rx="1.8" fill="var(--ic-b)"/>
        <rect x="14" y="6.6" width="8" height="11" rx="1.8" transform="rotate(12 18 12)" fill="var(--ic-a)"/>
        <path d="M12 8.8v5.2M9.8 11.4h4.4" stroke="#fff" stroke-width="1.7" stroke-linecap="round"/>`,
  },
  // 神威（30秒スコア10倍）。星のままだと item_fever（15秒2倍）と同じ絵で、
  // 「どっちが強いのか」が絵から読めなかった。星を小さくして下に山形を
  // 2枚積み、“倍率が段で上がっていく”ことをシルエットに出す。
  item_god_mult: {
    a: '#ffd75e', b: '#ff9d3d',
    p: `<path d="m12 1.8 2 4.2 4.6.6-3.4 3.2.9 4.6L12 12.2 7.9 14.4l.9-4.6L5.4 6.6 10 6z" fill="var(--ic-a)"/>
        <path d="m5.4 18.2 6.6-3.4 6.6 3.4" fill="none" stroke="var(--ic-b)" stroke-width="2.3" stroke-linecap="round" stroke-linejoin="round"/>
        <path d="m5.4 21.8 6.6-3.4 6.6 3.4" fill="none" stroke="var(--ic-b)" stroke-width="2.3" stroke-linecap="round" stroke-linejoin="round"/>`,
  },
  item_god_shield: {
    a: '#dfe6ff', b: '#2b3358',
    p: `<path d="M12 2.4 20.4 5.6v6.8c0 4.4-3.4 7.8-8.4 9.2-5-1.4-8.4-4.8-8.4-9.2V5.6z" fill="var(--ic-a)"/>
        <path d="m8.2 12.2 2.6 2.8 5-5.6" fill="none" stroke="var(--ic-b)" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/>`,
  },
  item_god_nuke: {
    a: '#ff8a5c', b: '#4a1408',
    p: `<path d="M2.6 20.4c3-6.4 7-11 12-14.4" fill="none" stroke="var(--ic-a)" stroke-width="2.4" stroke-linecap="round"/>
        <circle cx="17.6" cy="5.6" r="3.4" fill="var(--ic-a)"/>
        <path d="M4.6 20.4h15.2" stroke="var(--ic-b)" stroke-width="2.4" stroke-linecap="round"/>
        <path d="M7.6 16.4c2 1.6 4.4 1.6 6.4 0" fill="none" stroke="var(--ic-b)" stroke-width="1.8" stroke-linecap="round"/>`,
  },
});

// ---------------------------------------------------------------------------
// ショップのカテゴリ見出し
// ---------------------------------------------------------------------------
Object.assign(ICONS, {
  cat_skin: {
    a: '#5b8bff', b: '#22315e',
    p: `<rect x="3.4" y="3.4" width="8.2" height="8.2" rx="2" fill="var(--ic-a)"/>
        <rect x="12.4" y="12.4" width="8.2" height="8.2" rx="2" fill="var(--ic-b)"/>
        <rect x="12.4" y="3.4" width="8.2" height="8.2" rx="2" fill="var(--ic-b)" opacity=".55"/>
        <rect x="3.4" y="12.4" width="8.2" height="8.2" rx="2" fill="var(--ic-a)" opacity=".55"/>`,
  },
  cat_board: {
    a: '#43d9e8', b: '#0d3a44',
    p: `<rect x="2.6" y="4.4" width="18.8" height="15.2" rx="2.6" fill="var(--ic-b)"/>
        <path d="M2.6 14.4 8 9.6l4.2 3.8 3.4-2.8 5.8 5.2v1.4a2.6 2.6 0 0 1-2.6 2.6H5.2a2.6 2.6 0 0 1-2.6-2.6z" fill="var(--ic-a)"/>
        <circle cx="8" cy="8.6" r="1.8" fill="var(--ic-a)"/>`,
  },
  cat_fx: {
    a: '#ff6bd4', b: '#ffd75e',
    p: `<path d="m9 2.6 1.7 3.9 3.9 1.7-3.9 1.7L9 13.8 7.3 9.9 3.4 8.2l3.9-1.7z" fill="var(--ic-a)"/>
        <path d="m17 12 1.1 2.5 2.5 1.1-2.5 1.1L17 19.2l-1.1-2.5-2.5-1.1 2.5-1.1z" fill="var(--ic-b)"/>
        <circle cx="5.6" cy="17.6" r="1.7" fill="var(--ic-b)"/>`,
  },
  // 奥義の棚。丸い枠に雷だと HUD の ultimate（発動ボタン）と外形が同じで、
  // ショップの「見出し」と「商品」が同じ絵に見えた。奥義書（巻物）にすると
  // 横長になり、丸い仲間から完全に外れる。
  cat_ult: {
    a: '#ffd75e', b: '#6b4a00',
    p: `<rect x="3.4" y="5" width="17.2" height="14" rx="1.8" fill="var(--ic-b)"/>
        <rect x="2.2" y="3.4" width="3.8" height="17.2" rx="1.9" fill="var(--ic-a)"/>
        <rect x="18" y="3.4" width="3.8" height="17.2" rx="1.9" fill="var(--ic-a)"/>
        <path d="M14.2 6.8 8.2 13.6h3.6l-1.2 5.2 6-7.2h-3.6z" fill="var(--ic-a)"/>`,
  },
  // ブースター（消費アイテム）の棚。以前は炎とも雫とも取れる形で、
  // 商品側の fx_flame（炎）と外形が同じだった。フラスコにすると
  // 「使うと減るもの」であることまで絵で伝わる。
  cat_boost: {
    a: '#5ee86e', b: '#124d22',
    p: `<path d="M10.2 3.4h3.6v5.2l4.6 8a3.4 3.4 0 0 1-2.9 5.2H8.5a3.4 3.4 0 0 1-2.9-5.2l4.6-8z" fill="var(--ic-a)"/>
        <path d="M7.8 15.2h8.4l2 3.4a2.8 2.8 0 0 1-2.5 3.2H8.3a2.8 2.8 0 0 1-2.5-3.2z" fill="var(--ic-b)"/>
        <path d="M9 2.4h6" stroke="var(--ic-a)" stroke-width="2.4" stroke-linecap="round"/>`,
  },
});

// ---------------------------------------------------------------------------
// 消去エフェクト（cat === 'fx'）
//
// ここがこのファイルを作った直接の原因。15品のうち8品が同じ ✨ で、
// ショップの棚では「値段だけが違う同じ商品」が8つ並んで見えていた。
// さらにガチャの結果表示はカテゴリ共通アイコンだったので、何を引いても
// エフェクトは全部 ✨。当たりの嬉しさが絵から消えていた。
//
// なので id ごとに**効果そのものを描く**。名前と説明文（「花火」「稲妻が走る」
// 「花びらが舞い散る」…）を読めば、どれがどの絵かが一対一で分かるようにしてある。
// 商品を足すときは、ここに1つ足すまでが1セット（忘れると
// test/icons.test.mjs が落ちる）。
// ---------------------------------------------------------------------------
Object.assign(ICONS, {
  // スパーク（標準）。中央の四芒星＋四隅の短い火花。cat_fx（見出し）は
  // 大小2つの星を斜めに置いた構図なので、並んでも取り違えない。
  fx_default: {
    a: '#ffd75e', b: '#fff3b0',
    p: `<path d="M12 2.4 14.1 9.9 21.6 12l-7.5 2.1L12 21.6 9.9 14.1 2.4 12l7.5-2.1z" fill="var(--ic-a)"/>
        <path d="M5 5 7.4 7.4M19 5l-2.4 2.4M5 19l2.4-2.4M19 19l-2.4-2.4" stroke="var(--ic-b)" stroke-width="1.9" stroke-linecap="round"/>`,
  },
  // 花火：打ち上げの軌跡＋放射状に散る光の粒。
  fx_fireworks: {
    a: '#ff6bd4', b: '#ffd75e',
    p: `<path d="M13 9.6V3.4M13 9.6 8.6 5.2M13 9.6l4.4-4.4M13 9.6H6.8M13 9.6h6.2M13 9.6l-4 4.4M13 9.6l4 4.4" stroke="var(--ic-a)" stroke-width="1.7" stroke-linecap="round"/>
        <circle cx="13" cy="2.4" r="1.2" fill="var(--ic-b)"/><circle cx="7.6" cy="4.2" r="1.2" fill="var(--ic-b)"/><circle cx="18.4" cy="4.2" r="1.2" fill="var(--ic-b)"/>
        <circle cx="5.8" cy="9.6" r="1.2" fill="var(--ic-b)"/><circle cx="20.2" cy="9.6" r="1.2" fill="var(--ic-b)"/>
        <circle cx="8.2" cy="14.8" r="1.2" fill="var(--ic-b)"/><circle cx="17.8" cy="14.8" r="1.2" fill="var(--ic-b)"/>
        <path d="M2.4 21.6c1.8-2.9 4-5.4 6.6-7.4" fill="none" stroke="var(--ic-b)" stroke-width="1.9" stroke-linecap="round"/>`,
  },
  // サンダー：稲妻が「走る」ので、大小2本を斜めに並べて連なりを出す。
  // 1本だけだと ult_judgement（神の裁き）と同じ絵になる。
  fx_thunder: {
    a: '#ffe14d', b: '#ffb347',
    p: `<path d="M9.2 1.4 2 12.4h4.4L5 22 13.4 10.2H8.6z" fill="var(--ic-a)"/>
        <path d="M20.6 2.4 13.6 11.6h3.8l-1.3 7.4 6.9-9.8h-4z" fill="var(--ic-b)"/>`,
  },
  // 桜吹雪：五弁の花＋散っていく花びら2枚。
  fx_sakura: {
    a: '#ffb3d9', b: '#c2185b',
    p: `<ellipse cx="10" cy="4.8" rx="2.5" ry="3.6" fill="var(--ic-a)"/>
        <ellipse cx="15.1" cy="8.5" rx="2.5" ry="3.6" fill="var(--ic-a)" transform="rotate(72 15.1 8.5)"/>
        <ellipse cx="13.2" cy="14.5" rx="2.5" ry="3.6" fill="var(--ic-a)" transform="rotate(144 13.2 14.5)"/>
        <ellipse cx="6.8" cy="14.5" rx="2.5" ry="3.6" fill="var(--ic-a)" transform="rotate(216 6.8 14.5)"/>
        <ellipse cx="4.9" cy="8.5" rx="2.5" ry="3.6" fill="var(--ic-a)" transform="rotate(288 4.9 8.5)"/>
        <circle cx="10" cy="9.6" r="1.8" fill="var(--ic-b)"/>
        <ellipse cx="19.2" cy="17.6" rx="1.7" ry="2.6" fill="var(--ic-a)" transform="rotate(38 19.2 17.6)"/>
        <ellipse cx="14.8" cy="21.2" rx="1.3" ry="2.1" fill="var(--ic-a)" transform="rotate(-32 14.8 21.2)"/>`,
  },
  // バブル：はじけた瞬間なので、輪を割って破片を飛ばす。
  // fx_foam（立ちのぼる泡）とは「割れた輪」と「積み上がった丸」で描き分ける。
  fx_bubble: {
    a: '#8fd8ff', b: '#57e0ff',
    p: `<path d="M4.6 13a7.4 7.4 0 0 1 12.6-5.2" fill="none" stroke="var(--ic-a)" stroke-width="2.4" stroke-linecap="round"/>
        <path d="M18.8 11.4a7.4 7.4 0 0 1-10 9.4" fill="none" stroke="var(--ic-a)" stroke-width="2.4" stroke-linecap="round"/>
        <circle cx="9" cy="9.4" r="2" fill="var(--ic-a)"/>
        <circle cx="20.6" cy="4.4" r="1.6" fill="var(--ic-b)"/><circle cx="3.4" cy="4.8" r="1.3" fill="var(--ic-b)"/><circle cx="21" cy="19.6" r="1.2" fill="var(--ic-b)"/>`,
  },
  // スターダスト：星屑なので、大→小と流れる3つの星で「散っていく」を出す。
  fx_star: {
    a: '#ffe14d', b: '#ffb347',
    p: `<path d="m8.4 2 1.9 4.3 4.7.5-3.5 3.2.9 4.6-4-2.4-4 2.4.9-4.6-3.5-3.2 4.7-.5z" fill="var(--ic-a)"/>
        <path d="m17.4 11.4 1.2 2.6 2.8.3-2.1 1.9.6 2.8-2.5-1.4-2.5 1.4.6-2.8-2.1-1.9 2.8-.3z" fill="var(--ic-a)"/>
        <path d="m11.8 18.6.8 1.7 1.8.2-1.3 1.2.4 1.8-1.7-.9-1.7.9.4-1.8L9.2 20.5l1.8-.2z" fill="var(--ic-b)"/>`,
  },
  // フレイム：3つ又の炎。cat_boost をフラスコに変えたので、炎はここだけ。
  // 両脇に小さな舌を足して、外形が「ただの雫」にならないようにしている
  // （そうしないと ult_purify（浄化の波動＝水滴）と輪郭が同じになる）。
  fx_flame: {
    a: '#ff8a3d', b: '#ffd75e',
    p: `<path d="M12 1.6c.9 3.6 3.2 4.9 4.9 7.4 2.5 3.6 1.4 8.5-2.1 10.8-3.4 2.1-8.3 1-10-2.8-1.9-4.2 1.9-6.1 3-10.3 1.7 1 2.1 2.7 2.1 4.2C11.5 8.5 12 4.9 12 1.6z" fill="var(--ic-a)"/>
        <path d="M4.8 9.4c-1.8 2.5-2.1 5.2 0 7.8-.5-2.8.3-4.9 1.6-6.5zM19.2 9.4c1.8 2.5 2.1 5.2 0 7.8.5-2.8-.3-4.9-1.6-6.5z" fill="var(--ic-a)"/>
        <path d="M12 11.4c1.5 1.7 2.8 3.2 2.8 5.1a2.9 2.9 0 0 1-5.7 1c-.4-1.9 1.5-3.8 2.9-6.1z" fill="var(--ic-b)"/>`,
  },
  // スノウ：六方の雪の結晶＋こぼれた粉雪。
  fx_snow: {
    a: '#bfe9ff', b: '#4aa8d8',
    p: `<path d="M10.8 2.4v19.2M2.5 7.2l16.6 9.6M19.1 7.2 2.5 16.8" stroke="var(--ic-a)" stroke-width="1.9" stroke-linecap="round"/>
        <path d="M8 5.2 10.8 7.4 13.6 5.2M8 18.8l2.8-2.2 2.8 2.2" fill="none" stroke="var(--ic-a)" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/>
        <circle cx="10.8" cy="12" r="1.9" fill="var(--ic-b)"/>
        <circle cx="20.8" cy="20.4" r="1.5" fill="var(--ic-a)"/>`,
  },
  // リーフ：葉脈のある一枚＋ひらひら落ちる小さな葉。桜（丸い花弁）と対になる。
  fx_leaf: {
    a: '#5ee86e', b: '#1d6b2c',
    p: `<path d="M20.6 3.2c1.2 8.8-3.2 14.2-9.6 14.2-3.2 0-5.7-1.5-6.8-3.6C6.2 6.2 12.5 2.5 20.6 3.2z" fill="var(--ic-a)"/>
        <path d="M18.4 5.4C13.4 7.3 9.2 11 6.4 15.8" fill="none" stroke="var(--ic-b)" stroke-width="1.7" stroke-linecap="round"/>
        <path d="M7.4 20.8c-2.2.7-3.9-.2-4.3-2 1.5-1.7 3.7-1.7 4.3 2z" fill="var(--ic-a)"/>`,
  },
  // プリズム：三角柱に光が入って、虹色の光片が3方向へ弾ける。
  fx_prism: {
    a: '#dfe6ff', b: '#ff6bd4',
    p: `<path d="M7.4 3.6 14.6 16.4H.2z" fill="var(--ic-a)"/>
        <path d="M.8 8.6h5.4" stroke="var(--ic-b)" stroke-width="1.9" stroke-linecap="round"/>
        <path d="M13.4 6.8 22.8 3.4M12.6 11.2h11M13.4 15.4l9.4 3.2" stroke="var(--ic-b)" stroke-width="1.9" stroke-linecap="round"/>`,
  },
  // フォーム：水面に泡が盛り上がり、ふわりと立ちのぼる。
  fx_foam: {
    a: '#a8e6ff', b: '#57e0ff',
    p: `<path d="M2.4 20.8h19.2" stroke="var(--ic-b)" stroke-width="2.2" stroke-linecap="round"/>
        <circle cx="7" cy="16.6" r="4" fill="var(--ic-a)"/>
        <circle cx="14.6" cy="17.4" r="3.2" fill="var(--ic-a)"/>
        <circle cx="19.6" cy="15.2" r="2.4" fill="var(--ic-a)"/>
        <circle cx="10.2" cy="9.4" r="2.6" fill="var(--ic-a)"/>
        <circle cx="16.6" cy="5.4" r="1.9" fill="var(--ic-b)"/>
        <circle cx="6" cy="4.2" r="1.4" fill="var(--ic-b)"/>`,
  },
  // 彗星【ガチャ限定】：四芒星の核＋後ろへ広がる塗りの尾。
  // ult_meteor は「クレーターのある丸い岩＋細い線3本」なので作りから違う。
  // 尾を1枚の葉のような形にすると fx_leaf と紛らわしくなるので、
  // 核を星にして「岩ではなく光」だと分かるようにしてある。
  fx_comet: {
    a: '#9fd8ff', b: '#ffd75e',
    p: `<path d="M15.2 10.2C10.4 12.6 5.6 16.4 1 22c5.8-1.6 10.8-4.1 15.2-7.5z" fill="var(--ic-a)"/>
        <path d="M8.6 12.6c-1.6 1.4-3.2 3-4.8 4.8" fill="none" stroke="var(--ic-a)" stroke-width="1.8" stroke-linecap="round"/>
        <path d="m18.6 1.4 1.8 4.2 4.2 1.8-4.2 1.8-1.8 4.2-1.8-4.2-4.2-1.8 4.2-1.8z" fill="var(--ic-b)"/>`,
  },
  // 封印砕き【👑王座】：紫の封印の輪が縦に割れ、破片が飛ぶ。
  fx_seal: {
    a: '#b06bff', b: '#e6ccff',
    p: `<path d="M10.6 3.4a8.6 8.6 0 0 0 0 17.2" fill="none" stroke="var(--ic-a)" stroke-width="2.6" stroke-linecap="round"/>
        <path d="M14 3.9a8.6 8.6 0 0 1 0 16.2" fill="none" stroke="var(--ic-a)" stroke-width="2.6" stroke-linecap="round"/>
        <path d="M12.8 2.4 10.4 8l3 3.4-2.8 3.4 2 5.8" fill="none" stroke="var(--ic-b)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
        <circle cx="20.8" cy="6.2" r="1.3" fill="var(--ic-a)"/><circle cx="3.4" cy="18.6" r="1.1" fill="var(--ic-a)"/>`,
  },
  // 王冠還る【👑王座】：砕けた3片が土台の上へ組み上がる途中。
  // shards（通貨・割れた冠2片）とも mode_adminevent（continuousな冠）とも
  // 「隙間の空いた3片」で区別する。
  fx_crown: {
    a: '#ffd75e', b: '#ff9d3d',
    p: `<path d="M3.6 15.6 2.2 7.4l4.6 3.4 1.6-2.8z" fill="var(--ic-a)"/>
        <path d="M9.8 16.4 12 3.8l2.2 12.6z" fill="var(--ic-a)"/>
        <path d="M20.4 15.6 21.8 7.4l-4.6 3.4-1.6-2.8z" fill="var(--ic-a)"/>
        <path d="M5.6 20.4h12.8" stroke="var(--ic-b)" stroke-width="2.2" stroke-linecap="round"/>
        <path d="m4 18.8 1.4-1.8M20 18.8l-1.4-1.8" stroke="var(--ic-b)" stroke-width="1.8" stroke-linecap="round"/>`,
  },
  // 虹の祝福【管理者】：虹の粒子が降ってくる。ult_rainbow は「塗りつぶした
  // 3本の弧」なので、こちらは破線の弧＋粒で、白一色でも texture が違う。
  fx_admin: {
    a: '#ff6bd4', b: '#57e0ff',
    p: `<path d="M3.4 13a8.6 8.6 0 0 1 17.2 0" fill="none" stroke="var(--ic-a)" stroke-width="2.4" stroke-linecap="round" stroke-dasharray="2.4 2.8"/>
        <circle cx="6.4" cy="17.6" r="1.5" fill="var(--ic-b)"/>
        <circle cx="12" cy="19.6" r="1.9" fill="var(--ic-b)"/>
        <circle cx="17.6" cy="17" r="1.4" fill="var(--ic-b)"/>
        <circle cx="9.4" cy="21.8" r="1.1" fill="var(--ic-a)"/>
        <circle cx="15.2" cy="22" r="1" fill="var(--ic-a)"/>`,
  },
});

// ---------------------------------------------------------------------------
// ボス（server/catalog.js の BOSSES / RAID_BOSSES ＋ 深淵の最下層ボス）
//
// ボスは絵文字がそのまま看板になっている（ボス選択の一覧と、戦闘中の
// #bossEmoji ＝ 画面でいちばん大きい絵）。端末によって 🟢 や 🗿 の絵が変わると
// 「同じボスなのに顔が違う」ので、ここでベクターにしておく。
// 名前は boss_<id>。深淵王だけは modes.js の ABYSS_BANDS 側の存在なので
// boss_abysszero としてある。
// ---------------------------------------------------------------------------
Object.assign(ICONS, {
  // スライムキング：垂れた粘体＋小さな王冠。
  boss_slime: {
    a: '#5ee86e', b: '#124d22',
    p: `<path d="M12 6.6c4.7 0 8.4 4 8.4 8.6 0 2.2-1 3.6-2.6 3.6-1.2 0-1.8-.9-3-.9s-1.8 1.1-3 1.1-1.8-1.1-3-1.1-1.6.9-2.8.9c-1.6 0-2.4-1.4-2.4-3.6 0-4.6 3.7-8.6 8.4-8.6z" fill="var(--ic-a)"/>
        <path d="M8.4 5.8 7.2 1.6l3 2L12 .8l1.8 2.8 3-2-1.2 4.2z" fill="var(--ic-a)"/>
        <circle cx="9.4" cy="12.6" r="1.6" fill="var(--ic-b)"/><circle cx="14.6" cy="12.6" r="1.6" fill="var(--ic-b)"/>`,
  },
  // アイアンゴーレム：頭・胴・脚が離れた石のかたまり。
  boss_golem: {
    a: '#9aa6c4', b: '#3b4460',
    p: `<rect x="7.4" y="2.4" width="9.2" height="6.4" rx="1.2" fill="var(--ic-a)"/>
        <rect x="3.2" y="10" width="17.6" height="8.6" rx="1.6" fill="var(--ic-a)"/>
        <rect x="5.4" y="19.6" width="4.6" height="2.6" rx="1" fill="var(--ic-a)"/>
        <rect x="14" y="19.6" width="4.6" height="2.6" rx="1" fill="var(--ic-a)"/>
        <path d="M9.6 5.6h1.6M12.8 5.6h1.6" stroke="var(--ic-b)" stroke-width="2" stroke-linecap="round"/>
        <path d="M12 10v8.6M3.2 14.4h17.6" stroke="var(--ic-b)" stroke-width="1.5"/>`,
  },
  // ドラゴン：横顔＋後ろへ流れた角。上あごと下あごを別の形に割って
  // 「口を開けている」と読ませる。1枚の塊で描くと魚の頭に見えた。
  boss_dragon: {
    a: '#ff7a45', b: '#5c2408',
    p: `<path d="M1.4 11.8 6.6 8.8V6.2l4 1.8c1-.7 2.3-1 3.6-1 1 0 1.9.2 2.7.5L21 3.8l-1.1 4.6 3.5 1.2-3.8 1.9c.1.4.1.8.1 1.2 0 1-.2 1.9-.6 2.7H4.4C2.6 14.4 1.4 13.2 1.4 11.8z" fill="var(--ic-a)"/>
        <path d="M4.4 16.6h14.4c-1.5 2.4-4.1 3.9-7.2 3.9s-5.8-1.5-7.2-3.9z" fill="var(--ic-a)"/>
        <circle cx="13.8" cy="10.4" r="1.7" fill="var(--ic-b)"/>
        <path d="M4 12h4.4" stroke="var(--ic-b)" stroke-width="1.6" stroke-linecap="round"/>`,
  },
  // まおう：太い2本の角＋あごの尖った顔＋牙。角を線で描くと細くて
  // 触角に見えたので、根元が太い塗りにしてある。
  boss_maou: {
    a: '#c94dff', b: '#3d1170',
    p: `<path d="M2.8 1.4c4.2.7 6.7 3.4 7.4 8.2l-3.2.9C6.4 6.6 5 3.8 2.8 1.4zM21.2 1.4c-4.2.7-6.7 3.4-7.4 8.2l3.2.9c.6-3.9 2-6.7 4.2-9.1z" fill="var(--ic-a)"/>
        <path d="M12 5.6c4 0 7 2.8 7 6.6 0 3.9-3 9.4-7 9.4s-7-5.5-7-9.4c0-3.8 3-6.6 7-6.6z" fill="var(--ic-a)"/>
        <path d="m8 11.4 3 1.4-3 1M16 11.4l-3 1.4 3 1" fill="none" stroke="var(--ic-b)" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/>
        <path d="M9.4 16.2h5.2l-1.4 2.2h-2.4z" fill="var(--ic-b)"/>`,
  },
  // 機械神エクスマキナ：3本のアンテナ＋横一文字のバイザー＋グリル。
  // mode_ai（丸い目が2つのロボット）と混ざらないよう、目は1本のスリットにする。
  boss_mecha: {
    a: '#9fd8ff', b: '#1c3550',
    p: `<path d="M6 4.6h12l2 4.4V16a2.4 2.4 0 0 1-2.4 2.4H6.4A2.4 2.4 0 0 1 4 16V9z" fill="var(--ic-a)"/>
        <rect x="6.6" y="8.8" width="10.8" height="3.4" rx="1.2" fill="var(--ic-b)"/>
        <path d="M7.6 15h8.8M7.6 17h8.8" stroke="var(--ic-b)" stroke-width="1.5" stroke-linecap="round"/>
        <path d="M7.4 4.6 5.4 1.4M16.6 4.6l2-3.2M12 4.6V1.2" stroke="var(--ic-a)" stroke-width="1.9" stroke-linecap="round"/>`,
  },
  // 氷雪女王フリオーネ：氷柱の生えた氷の玉座。
  boss_frost: {
    a: '#bfe9ff', b: '#1c7fa8',
    p: `<path d="M12 1.2 16.4 13H7.6z" fill="var(--ic-a)"/>
        <path d="M5.2 6.6 9 15.6 2.2 13.8z" fill="var(--ic-a)"/>
        <path d="M18.8 6.6 15 15.6l6.8-1.8z" fill="var(--ic-a)"/>
        <rect x="2.8" y="16.2" width="18.4" height="2.8" rx="1" fill="var(--ic-b)"/>
        <path d="M6.4 19h2.2v2.6l-1.1 1.6-1.1-1.6zM15.4 19h2.2v2.2l-1.1 1.4-1.1-1.4z" fill="var(--ic-a)"/>`,
  },
  // 深海のクラーケン（レイド）：丸い胴＋うねる触手4本。
  boss_kraken: {
    a: '#b06bff', b: '#3d1170',
    p: `<path d="M12 2.4c4.4 0 7.6 3.3 7.6 7.4v3.2H4.4V9.8C4.4 5.7 7.6 2.4 12 2.4z" fill="var(--ic-a)"/>
        <circle cx="9" cy="9.2" r="1.7" fill="var(--ic-b)"/><circle cx="15" cy="9.2" r="1.7" fill="var(--ic-b)"/>
        <path d="M5.4 13.4c-1.4 2.6-1.6 5.2-.6 7.8M9.2 13.4c-.6 2.8-.2 5.4 1.2 7.8M14.8 13.4c.6 2.8.2 5.4-1.2 7.8M18.6 13.4c1.4 2.6 1.6 5.2.6 7.8" fill="none" stroke="var(--ic-a)" stroke-width="2.1" stroke-linecap="round"/>`,
  },
  // 魔竜ティアマト（レイド）：首が3本。boss_dragon（横顔1つ）と対になる。
  // 首をまっすぐ生やすと王冠（badge_crown* / mode_adminevent）に見えたので、
  // 外の2本はS字に曲げ、頭には口の割れ目を入れて「顔が3つある」と読ませる。
  boss_tiamat: {
    a: '#ff5d5d', b: '#5a1414',
    p: `<path d="M12 22c-4.2 0-7.4-2-7.4-4.4 0-2.2 3.3-3.7 7.4-3.7s7.4 1.5 7.4 3.7c0 2.4-3.2 4.4-7.4 4.4z" fill="var(--ic-a)"/>
        <path d="M12 14.4V9.6M7 15.4C4.4 13.8 3 11.6 3.6 8.6M17 15.4c2.6-1.6 4-3.8 3.4-6.8" fill="none" stroke="var(--ic-a)" stroke-width="2.3" stroke-linecap="round"/>
        <path d="M9.2 7.2c0-1.7 1.3-3 2.8-3s2.8 1.3 2.8 3c0 1.2-1.3 2-2.8 2s-2.8-.8-2.8-2z" fill="var(--ic-a)"/>
        <path d="M.9 5.4c.4-1.7 1.9-2.7 3.4-2.3 1.4.4 2.3 1.9 1.9 3.5-.3 1.1-1.7 1.4-3.1 1S.6 6.4.9 5.4z" fill="var(--ic-a)"/>
        <path d="M23.1 5.4c-.4-1.7-1.9-2.7-3.4-2.3-1.4.4-2.3 1.9-1.9 3.5.3 1.1 1.7 1.4 3.1 1s2.5-1.2 2.2-2.2z" fill="var(--ic-a)"/>
        <path d="M10.2 8.2h3.6M2.4 6.6l3-.8M21.6 6.6l-3-.8M9.4 18.6h5.2" stroke="var(--ic-b)" stroke-width="1.5" stroke-linecap="round"/>`,
  },
  // 冥王ハデス（レイド）：T字のスリットが開いた兜＋立ちのぼる冥火。
  // mode_survival（丸い目のドクロ）とは面のつくりから違う。
  boss_hades: {
    a: '#8b6cff', b: '#1a0d3a',
    p: `<path d="M12 4.8c4 0 7 3 7 7v5.2c0 1.4-1 2.6-2.4 2.6H7.4A2.4 2.4 0 0 1 5 17V11.8c0-4 3-7 7-7z" fill="var(--ic-a)"/>
        <path d="M10.9 9.6h2.2v10h-2.2z" fill="var(--ic-b)"/>
        <path d="M7.2 11.6h3.2v2.8H7.2zM13.6 11.6h3.2v2.8h-3.2z" fill="var(--ic-b)"/>
        <path d="M12 .8c1.3 1.5 1.9 2.6 1.9 3.6M7.4 2.2c.9 1 1.3 1.9 1.3 2.7M16.6 2.2c-.9 1-1.3 1.9-1.3 2.7" fill="none" stroke="var(--ic-a)" stroke-width="1.9" stroke-linecap="round"/>`,
  },
  // 深淵王アビスゼロ（深淵ダンジョン A100 の主）：閉じない「0」の中の縦の瞳。
  // 輪の内側に下地の円を敷くと、白一色にしたときにただの丸に潰れる。
  // 穴は本当に穴のまま（塗り分けの反転）にしてある。
  boss_abysszero: {
    a: '#7c3aed', b: '#160a33',
    p: `<path d="M12 2.4a8.2 8.2 0 0 1 0 16.4 8.2 8.2 0 0 1 0-16.4zm0 2.7a5.5 5.5 0 0 0 0 11 5.5 5.5 0 0 0 0-11z" fill="var(--ic-a)"/>
        <path d="M12 6.4c1.1 1.7 1.6 3 1.6 4.2s-.5 2.5-1.6 4.2c-1.1-1.7-1.6-3-1.6-4.2s.5-2.5 1.6-4.2z" fill="var(--ic-a)"/>
        <path d="M5.4 21.6 12 18.4l6.6 3.2" fill="none" stroke="var(--ic-a)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>`,
  },
});

// ---------------------------------------------------------------------------
// バッジ（screens.js の BADGE_INFO / BADGE_ORDER にある27種＋🏛シーズン刻印）
//
// バッジは持ち物・順位表・プロフィールで**アイコンとして**並ぶのに、
// 👑 が adminevent / crown2 / crown3 / crown5 の4つに、🕳️ が under と
// 実績の深淵100Fに使い回されていた。「二冠」と「三冠」が同じ絵で並ぶと、
// 何が違うのか一生分からない。
//
// 冠系（crown2/3/5/7）は rank_* と同じ考えかたで**帯の玉の数**で読ませる。
// 色だけで分けると白黒表示や色覚特性で潰れる。
// ---------------------------------------------------------------------------
const CROWN_BADGES = [['badge_crown2', 2], ['badge_crown3', 3], ['badge_crown5', 5], ['badge_crown7', 7]];
for (const [name, pips] of CROWN_BADGES) {
  // 玉は帯の中に等間隔。7個でも帯（3.4〜20.6）に収まる間隔にしてある。
  const dots = Array.from({ length: pips }, (_, i) => {
    const x = 12 + (i - (pips - 1) / 2) * 2.6;
    return `<circle cx="${x.toFixed(1)}" cy="18.1" r="1" fill="var(--ic-a)"/>`;
  }).join('');
  ICONS[name] = {
    a: '#ffd75e', b: '#8a6206',
    // mode_adminevent のギザギザ冠とは別物に見えるよう、こちらは丸いアーチ冠。
    p: `<path d="M3.4 15.6V9.4a2 2 0 0 1 3.4-1.4l1.9 1.9a4.7 4.7 0 0 1 6.6 0l1.9-1.9a2 2 0 0 1 3.4 1.4v6.2z" fill="var(--ic-a)"/>
        <rect x="3.4" y="16.4" width="17.2" height="3.4" rx="1.2" fill="var(--ic-b)"/>
        <circle cx="4.2" cy="6.6" r="1.5" fill="var(--ic-a)"/><circle cx="19.8" cy="6.6" r="1.5" fill="var(--ic-a)"/><circle cx="12" cy="5" r="1.7" fill="var(--ic-a)"/>
        ${dots}`,
  };
}

// バトルパスの到達バッジ3種（ティア10 / 20 / 30）。段は**メダルの下に並ぶ
// 玉の数**（1〜3）で読ませる。
//
// 最初はメダルの中に線を引いていたが、それだと色を落としたときに
// 地色と同化して3つとも「ただの丸いメダル」になった。rank_* が
// 「盾の外側にピップを置く」形をとっているのと同じ理由 ── 内側の描き込みは
// 潰れるが、外形に出っ張りを作れば色が無くなっても数えられる。
const BP_BADGES = [['badge_bronze', '#cd7f32', '#6b3d12', 1], ['badge_silver', '#c9d4e4', '#5a6577', 2], ['badge_gold', '#ffd75e', '#8a6206', 3]];
for (const [name, a, b, pips] of BP_BADGES) {
  const dots = Array.from({ length: pips }, (_, i) => {
    const x = 12 + (i - (pips - 1) / 2) * 3.4;
    return `<circle cx="${x.toFixed(1)}" cy="21.2" r="1.3" fill="var(--ic-a)"/>`;
  }).join('');
  ICONS[name] = {
    a, b,
    p: `<rect x="4.4" y="1.8" width="15.2" height="3.2" rx="1.4" fill="var(--ic-a)"/>
        <path d="M10.4 5h3.2v2.8h-3.2z" fill="var(--ic-a)"/>
        <circle cx="12" cy="13.4" r="5.8" fill="var(--ic-a)"/>
        <circle cx="12" cy="13.4" r="2.8" fill="var(--ic-b)"/>
        ${dots}`,
  };
}

Object.assign(ICONS, {
  // 鬼討伐 → 鬼の金棒。鬼の面にすると boss_maou（角のある顔）と被る。
  badge_oni: {
    a: '#ff5d5d', b: '#5a1414',
    p: `<path d="m14.4 2.2 7.4 7.4-8.2 8.2-7.4-7.4z" fill="var(--ic-a)"/>
        <path d="m6.2 12.4 5.4 5.4-4.1 4.1a3.8 3.8 0 0 1-5.4-5.4z" fill="var(--ic-b)"/>
        <circle cx="13" cy="6.8" r="1.2" fill="var(--ic-b)"/><circle cx="17.2" cy="11" r="1.2" fill="var(--ic-b)"/>
        <circle cx="17.2" cy="6.4" r="1.2" fill="var(--ic-b)"/><circle cx="12.6" cy="11.4" r="1.2" fill="var(--ic-b)"/>`,
  },
  // 神殺し → 三叉の矛。
  badge_kami: {
    a: '#ffd75e', b: '#6b4a00',
    p: `<path d="M4.6 2.6v4.6a7.4 7.4 0 0 0 14.8 0V2.6" fill="none" stroke="var(--ic-a)" stroke-width="2.2" stroke-linecap="round"/>
        <path d="M12 2.6v19" stroke="var(--ic-a)" stroke-width="2.4" stroke-linecap="round"/>
        <path d="M8.6 13.6h6.8" stroke="var(--ic-b)" stroke-width="2.2" stroke-linecap="round"/>
        <path d="m4.6 1.4-1.8 2.6M19.4 1.4l1.8 2.6" stroke="var(--ic-a)" stroke-width="2" stroke-linecap="round"/>`,
  },
  // 創造神討伐 → 割れた創造の珠。
  badge_souzou: {
    a: '#b06bff', b: '#2a1060',
    p: `<circle cx="12" cy="12" r="8.2" fill="var(--ic-a)"/>
        <path d="M12 3.8 9.6 10.4 12 12.6l-2.6 2 2 5.6" fill="none" stroke="var(--ic-b)" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/>
        <path d="M12 .8v1.8M12 21.4v1.8M.8 12h1.8M21.4 12h1.8" stroke="var(--ic-a)" stroke-width="2" stroke-linecap="round"/>`,
  },
  // 魔王討伐 → へし折れた角。
  badge_maou: {
    a: '#ff5d5d', b: '#5a1414',
    p: `<path d="M3.4 20.8C2.4 14.2 5 8.6 10.8 5l2.2 4.6c-3.4 2.8-4.8 6.6-4.4 11.2z" fill="var(--ic-a)"/>
        <path d="M13.4 8.2 11 3.6c2.4-1.2 5-1.8 7.8-1.8-1 2.6-2.6 4.8-5.4 6.4z" fill="var(--ic-b)"/>
        <path d="m15.6 12.8 5.6-2M16.8 17.2l4.8.6M15 20.6l3.6 2.2" stroke="var(--ic-a)" stroke-width="1.9" stroke-linecap="round"/>`,
  },
  // ボスラッシュ制覇 → 交差した2本の剣。
  badge_rush: {
    a: '#dfe6ff', b: '#5a6577',
    p: `<path d="M20.6 2.2 9.4 13.4l1.2 1.2L21.8 3.4z" fill="var(--ic-a)"/>
        <path d="M3.4 2.2 14.6 13.4l-1.2 1.2L2.2 3.4z" fill="var(--ic-a)"/>
        <path d="m8.4 14.4 1.2 1.2-4 4a1.7 1.7 0 0 1-2.4-2.4zM15.6 14.4l-1.2 1.2 4 4a1.7 1.7 0 0 0 2.4-2.4z" fill="var(--ic-b)"/>`,
  },
  // 百塔踏破 → 銃眼つきの塔＋旗。
  badge_dungeon: {
    a: '#c9a06a', b: '#5a3819',
    p: `<path d="M6.4 7.4h11.2v14H6.4z" fill="var(--ic-a)"/>
        <path d="M5.2 4.2h2.8v3.2H5.2zM10.6 4.2h2.8v3.2h-2.8zM16 4.2h2.8v3.2H16z" fill="var(--ic-a)"/>
        <path d="M10 13.6a2 2 0 0 1 4 0v7.8h-4z" fill="var(--ic-b)"/>
        <path d="M12.6 1.2 17.4 2.6l-4.8 1.6z" fill="var(--ic-b)"/>
        <path d="M12.2 1v3.4" stroke="var(--ic-b)" stroke-width="1.4" stroke-linecap="round"/>`,
  },
  // 地底踏破 → 下りていく階段＋下向きの矢印。
  badge_under: {
    a: '#b07a4a', b: '#3d2410',
    p: `<path d="M2.2 4.6h5.8V9h4.4v4.4h4.4V18h5v3.4H2.2z" fill="var(--ic-a)"/>
        <path d="M18.4 2.2v7.4M15.4 6.8l3 3.2 3-3.2" fill="none" stroke="var(--ic-b)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>`,
  },
  // 天界踏破 → 雲を突き抜けて昇る矢印。
  badge_heaven: {
    a: '#dfe6ff', b: '#5b8bff',
    p: `<path d="M6.6 19.4a4.4 4.4 0 0 1-.5-8.8 5.6 5.6 0 0 1 10.6-1.4 4.1 4.1 0 0 1 1 8.1z" fill="var(--ic-a)"/>
        <path d="M12 22V9.4M8.2 13 12 9.2l3.8 3.8" fill="none" stroke="var(--ic-b)" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/>`,
  },
  // 深淵踏破 → すり鉢状に落ちていく渦。
  badge_abyss: {
    a: '#7c3aed', b: '#160a33',
    p: `<ellipse cx="12" cy="5.4" rx="9.4" ry="3.4" fill="var(--ic-a)"/>
        <ellipse cx="12" cy="5.4" rx="5.4" ry="1.9" fill="var(--ic-b)"/>
        <path d="M2.8 6.6c1.5 5.5 4.5 10.7 9.2 15.4 4.7-4.7 7.7-9.9 9.2-15.4" fill="none" stroke="var(--ic-a)" stroke-width="2.1" stroke-linecap="round"/>
        <ellipse cx="12" cy="13.6" rx="4.4" ry="1.6" fill="none" stroke="var(--ic-a)" stroke-width="1.7"/>`,
  },
  // 断罪 → 縦向きの眼。ult_condemn（横向きの眼＋斜線）と向きで分ける。
  badge_zero: {
    a: '#e03546', b: '#3a0a10',
    p: `<path d="M12 2.4s6.4 4.2 6.4 9.6-6.4 9.6-6.4 9.6-6.4-4.2-6.4-9.6S12 2.4 12 2.4z" fill="var(--ic-a)"/>
        <ellipse cx="12" cy="12" rx="3.4" ry="2.4" fill="var(--ic-b)"/>
        <path d="M1.8 12h2.6M19.6 12h2.6" stroke="var(--ic-a)" stroke-width="2" stroke-linecap="round"/>`,
  },
  // 七冠奪還 → 同じ眼に7条の光。冠にすると crown7（全冠制覇）と意味も絵も
  // かぶるので、こちらは「断罪」の系統として描く。
  badge_zero7: {
    a: '#f0b429', b: '#5a3a02',
    p: `<path d="M12 5.4s5 3.4 5 7.8-5 7.8-5 7.8-5-3.4-5-7.8 5-7.8 5-7.8z" fill="var(--ic-a)"/>
        <ellipse cx="12" cy="13.2" rx="2.8" ry="2" fill="var(--ic-b)"/>
        <path d="M12 3.4V.8M6.2 5.4 4.4 3.2M17.8 5.4 19.6 3.2M3.6 9.8 1.2 9M20.4 9.8l2.4-.8M4.4 17.8l-2.2 1.4M19.6 17.8l2.2 1.4" stroke="var(--ic-a)" stroke-width="1.8" stroke-linecap="round"/>`,
  },
  // 大会優勝 → 勝ち上がり表。mode_tourney（トロフィー）とは別物。
  badge_tourney: {
    a: '#ffd75e', b: '#6b4a00',
    p: `<path d="M2.6 5.4h4.2V12h4M2.6 18.6h4.2V12M21.4 5.4h-4.2V12h-4M21.4 18.6h-4.2V12" fill="none" stroke="var(--ic-a)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
        <circle cx="12" cy="12" r="2.8" fill="var(--ic-b)"/>`,
  },
  // 百人の頂点 → 月桂冠に囲まれた「1」。
  badge_royale: {
    a: '#ff5d5d', b: '#ffd75e',
    p: `<path d="M8.4 3.4C4.6 5.2 2.6 8.6 2.6 12.6c0 4 2 7.2 5.8 8.6" fill="none" stroke="var(--ic-a)" stroke-width="2.2" stroke-linecap="round"/>
        <path d="M15.6 3.4c3.8 1.8 5.8 5.2 5.8 9.2 0 4-2 7.2-5.8 8.6" fill="none" stroke="var(--ic-a)" stroke-width="2.2" stroke-linecap="round"/>
        <path d="M10.2 8.4 12.4 6.6v10.8M9.8 17.4h5.2" fill="none" stroke="var(--ic-b)" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/>`,
  },
  // 管理者イベント制覇 → 星入りのペナント。
  badge_adminevent: {
    a: '#ffd75e', b: '#6b4a00',
    p: `<path d="M5.2 2.2v19.6" stroke="var(--ic-a)" stroke-width="2.4" stroke-linecap="round"/>
        <path d="M6.6 3.4h14.8l-3.6 4.6 3.6 4.6H6.6z" fill="var(--ic-a)"/>
        <path d="m12.4 5.4 1.1 2.2 2.4.3-1.7 1.7.4 2.4-2.2-1.2-2.2 1.2.4-2.4L8.9 7.9l2.4-.3z" fill="var(--ic-b)"/>`,
  },
  // 週間チャンピオン → リボンつきの星メダル。
  badge_weekly1: {
    a: '#ffd75e', b: '#8a6206',
    p: `<path d="M6.4 1.6 10.2 8.6 12.8 7 9.4 1.6zM17.6 1.6 13.8 8.6 11.2 7l3.4-5.4z" fill="var(--ic-b)"/>
        <circle cx="12" cy="15" r="6.8" fill="var(--ic-a)"/>
        <path d="m12 10.2 1.5 3 3.3.5-2.4 2.3.6 3.3-3-1.6-3 1.6.6-3.3-2.4-2.3 3.3-.5z" fill="var(--ic-b)"/>`,
  },
  // ギルドの誉れ → 3つの塔と星。guild（盾）や badge_dungeon（1本の塔）とは別。
  badge_guildquest: {
    a: '#ff9d3d', b: '#5c2f06',
    p: `<path d="M2.4 9.4h4.4v11.8H2.4zM9.8 6.6h4.4v14.6H9.8zM17.2 9.4h4.4v11.8h-4.4z" fill="var(--ic-a)"/>
        <path d="M10.6 16.6a1.4 1.4 0 0 1 2.8 0v4.6h-2.8z" fill="var(--ic-b)"/>
        <path d="m12 1.2 1.1 2.2 2.4.3-1.8 1.7.5 2.4L12 6.6 9.8 7.8l.5-2.4-1.8-1.7 2.4-.3z" fill="var(--ic-b)"/>
        <circle cx="4.6" cy="6.6" r="1.3" fill="var(--ic-b)"/><circle cx="19.4" cy="6.6" r="1.3" fill="var(--ic-b)"/>`,
  },
  // 日課の鬼 → 7日ぶんの帯と大きなチェック。mode_daily（カレンダー）とは別。
  badge_daily7: {
    a: '#5ee86e', b: '#124d22',
    p: `<rect x="1.6" y="6.2" width="20.8" height="5.6" rx="2.4" fill="var(--ic-b)"/>
        <circle cx="3.3" cy="9" r="1.3" fill="var(--ic-a)"/><circle cx="6.2" cy="9" r="1.3" fill="var(--ic-a)"/><circle cx="9.1" cy="9" r="1.3" fill="var(--ic-a)"/><circle cx="12" cy="9" r="1.3" fill="var(--ic-a)"/><circle cx="14.9" cy="9" r="1.3" fill="var(--ic-a)"/><circle cx="17.8" cy="9" r="1.3" fill="var(--ic-a)"/><circle cx="20.7" cy="9" r="1.3" fill="var(--ic-a)"/>
        <path d="m7 17.6 3.2 3.2 6.8-7" fill="none" stroke="var(--ic-a)" stroke-width="2.8" stroke-linecap="round" stroke-linejoin="round"/>`,
  },
  // 遺跡マスター → 石のアーチ門。mode_puzzle（ジグソー片）とは別。
  badge_puzzle: {
    a: '#c9d4e4', b: '#5a6577',
    p: `<path d="M3.4 21.4V9.4a8.6 8.6 0 0 1 17.2 0v12h-4.6v-12a4 4 0 0 0-8 0v12z" fill="var(--ic-a)"/>
        <circle cx="12" cy="7" r="2.4" fill="var(--ic-b)"/>
        <path d="M2.2 21.6h19.6" stroke="var(--ic-b)" stroke-width="2.2" stroke-linecap="round"/>`,
  },
  // マスター採掘士 → 鉱石を積んだトロッコ。mode_dig（ツルハシ）とは別。
  badge_dig: {
    a: '#b07a4a', b: '#3d2410',
    p: `<path d="M7.4 8.6a4.6 4.6 0 0 1 9.2 0z" fill="var(--ic-b)"/>
        <path d="M3.4 9.6h17.2l-2.2 7.6H5.6z" fill="var(--ic-a)"/>
        <path d="M2.2 9.6h19.6" stroke="var(--ic-b)" stroke-width="2" stroke-linecap="round"/>
        <circle cx="8.4" cy="19.8" r="2.4" fill="var(--ic-b)"/><circle cx="15.6" cy="19.8" r="2.4" fill="var(--ic-b)"/>`,
  },
  // 幽霊屋敷の生還者 → 墓石と人魂。mode_ghost（おばけ本体）とは別。
  badge_ghost: {
    a: '#c9d4e4', b: '#39415c',
    p: `<path d="M6.4 21.4V9.6a5.6 5.6 0 0 1 11.2 0v11.8z" fill="var(--ic-a)"/>
        <path d="M9.4 10.6h5.2M9.4 14.2h5.2" stroke="var(--ic-b)" stroke-width="1.9" stroke-linecap="round"/>
        <path d="M1.6 21.6h20.8" stroke="var(--ic-b)" stroke-width="2.4" stroke-linecap="round"/>
        <circle cx="19.8" cy="5.2" r="2.4" fill="var(--ic-b)"/>`,
  },
  // 🏛 シーズン刻印（s{N}champ）。シーズンごとに増えるので id は1つで使い回す。
  badge_season: {
    a: '#e0c98a', b: '#7a6320',
    p: `<rect x="5.2" y="9.4" width="13.6" height="2.8" rx="1" fill="var(--ic-a)"/>
        <rect x="4.2" y="18.6" width="15.6" height="3" rx="1.2" fill="var(--ic-a)"/>
        <path d="M7.8 12.2h2.6v6.4H7.8zM13.6 12.2h2.6v6.4h-2.6z" fill="var(--ic-a)"/>
        <path d="m12 1 1.4 2.9 3.2.5-2.3 2.2.5 3.2L12 8.3 8.7 9.8l.5-3.2L6.9 4.4l3.2-.5z" fill="var(--ic-b)"/>`,
  },
});

// ---------------------------------------------------------------------------
// 観戦・カスタムルームの席（v2.35）
//
// 観戦ビューと8人部屋を作ったときに、絵文字のまま残っていたところ。
// 👀（観戦）／⚔️（対戦席）／👑（ホスト）／＋（空き席）／🔥（ファイナル）。
// 👀 を mode_ghost（👻＝幽霊屋敷）で代用すると意味が二重になるので、
// 「見る」は専用の目のアイコンを作る。
// ---------------------------------------------------------------------------
Object.assign(ICONS, {
  // 観戦。まぶたと瞳。mode_ghost（お化け）とは似ないようにする。
  spectate: {
    a: '#57e0ff', b: '#0d3a44',
    p: `<path d="M2.4 12S6.2 5.8 12 5.8 21.6 12 21.6 12 17.8 18.2 12 18.2 2.4 12 2.4 12z" fill="none" stroke="var(--ic-a)" stroke-width="2"/>
        <circle cx="12" cy="12" r="3.4" fill="var(--ic-a)"/>
        <circle cx="12" cy="12" r="1.4" fill="var(--ic-b)"/>`,
  },
  // 対戦席。交差した2本の剣。
  seat_play: {
    a: '#ff8a5c', b: '#5c2408',
    p: `<path d="m4.6 4.6 10.8 10.8M19.4 4.6 8.6 15.4" stroke="var(--ic-a)" stroke-width="2.2" stroke-linecap="round"/>
        <path d="m14.2 16.4 3.4 3.4M9.8 16.4l-3.4 3.4" stroke="var(--ic-b)" stroke-width="2.6" stroke-linecap="round"/>`,
  },
  // 観戦席。椅子＋目。座って見ている席。
  seat_watch: {
    a: '#9fb0d4', b: '#38425c',
    p: `<path d="M5.6 4.6h12.8v8.2H5.6z" fill="var(--ic-b)"/>
        <path d="M4 13h16v3.2H4zM6 16.2h2.2v3.6H6zM15.8 16.2H18v3.6h-2.2z" fill="var(--ic-a)"/>
        <circle cx="12" cy="8.6" r="2.4" fill="var(--ic-a)"/>
        <circle cx="12" cy="8.6" r="1" fill="var(--ic-b)"/>`,
  },
  // 空き席。点線の枠＋プラス。
  seat_open: {
    a: '#6b7690', b: '#39415c',
    p: `<rect x="3.6" y="3.6" width="16.8" height="16.8" rx="3.4" fill="none" stroke="var(--ic-a)" stroke-width="1.8" stroke-dasharray="3.4 3"/>
        <path d="M12 8v8M8 12h8" stroke="var(--ic-a)" stroke-width="2.2" stroke-linecap="round"/>`,
  },
  // ルームのホスト。王座（throne）や段位の冠と混ざらないよう、
  // 「冠」ではなく「司会の指揮棒つきの人」で描き分ける。
  host_crown: {
    a: '#ffd75e', b: '#6b4a00',
    p: `<circle cx="10" cy="7.6" r="3.4" fill="var(--ic-a)"/>
        <path d="M3.6 19.6a6.4 6.4 0 0 1 12.8 0z" fill="var(--ic-a)"/>
        <path d="m16.6 4.6 1 2.2 2.4.3-1.8 1.6.5 2.3-2.1-1.2-2.1 1.2.5-2.3-1.8-1.6 2.4-.3z" fill="var(--ic-b)"/>`,
  },
  // 決着間際（ファイナル）。炎。
  fire: {
    a: '#ff8a5c', b: '#ffd75e',
    p: `<path d="M12 2.2c4 3.4 6.4 6.8 6.4 10.4A6.4 6.4 0 0 1 5.6 12.6c0-2 .9-3.8 2.4-5.4.3 1.4 1 2.4 2 2.8-.4-3 .6-5.6 2-7.8z" fill="var(--ic-a)"/>
        <path d="M12 21a3.4 3.4 0 0 1-3.4-3.4c0-1.8 1.4-3 3.4-5 2 2 3.4 3.2 3.4 5A3.4 3.4 0 0 1 12 21z" fill="var(--ic-b)"/>`,
  },
});

// ---------------------------------------------------------------------------
// 描画
// ---------------------------------------------------------------------------

export function hasIcon(name) {
  return Object.prototype.hasOwnProperty.call(ICONS, name);
}

export function iconNames() {
  return Object.keys(ICONS);
}

/**
 * アイコンを SVG 文字列で返す（innerHTML 用）。
 * 未知の名前でも必ず何かを返す ── 商品が「絵の無い空欄」になるより、
 * 見慣れない箱が出ているほうが不具合に気づける。
 */
export function icon(name, opts = {}) {
  const { size = 20, cls = '', label = '' } = opts;
  const def = ICONS[name] || ICONS.placeholder;
  const px = Number(size) || 20;
  const a11y = label
    ? ` role="img" aria-label="${String(label).replace(/[<>&"]/g, '')}"`
    : ' aria-hidden="true"';
  const klass = `bba-ic${cls ? ` ${cls}` : ''}`;
  return `<svg class="${klass}" viewBox="0 0 24 24" width="${px}" height="${px}"`
    + ` style="--ic-a:${def.a};--ic-b:${def.b}"${a11y}>${def.p}</svg>`;
}

/** DOM ノードが欲しいとき。 */
export function iconEl(name, opts = {}) {
  const wrap = document.createElement('span');
  wrap.className = 'bba-ic-wrap';
  wrap.innerHTML = icon(name, opts);
  return wrap.firstElementChild;
}

// ---------------------------------------------------------------------------
// id → アイコン名
//
// 以前ここには iconForEmoji()（絵文字→アイコン名の逆引き表）があったが、
// 廃止した。**逆引きは原理的に成立しない** ── そもそもの不具合が
// 「同じ絵文字が別々の意味で使われている」ことなので、絵文字を鍵にすると
// ✨ を引いた8品が全部同じアイコンに戻る。作った重複を作り直すことになる。
//
// 引くのは必ず商品の id。id は一意で、一意でなくなったらそれ自体が別の不具合。
// ---------------------------------------------------------------------------

/**
 * 商品（SHOP_ITEMS / BOOST_ITEMS の1件、または id 文字列）のアイコン名。
 * 個別のアイコンが無ければカテゴリ共通（cat_skin / cat_board / cat_fx /
 * cat_ult / cat_boost）へ、それも無ければ placeholder へ落ちる。
 *
 *   el.innerHTML = icon(itemIconName(item), { size: 34 });
 */
export function itemIconName(item) {
  const id = typeof item === 'string' ? item : (item && item.id) || '';
  if (hasIcon(id)) return id;
  const cat = (item && typeof item === 'object' && item.cat)
    // id からカテゴリを推せるものは推す（ガチャの結果など、cat が
    // 付かない形で渡ってくる呼び出しがある）。
    || (/^skin_/.test(id) ? 'skin' : /^board_/.test(id) ? 'board'
      : /^fx_/.test(id) ? 'fx' : /^ult_/.test(id) ? 'ult'
      : /^item_/.test(id) ? 'boost' : '');
  return cat && hasIcon(`cat_${cat}`) ? `cat_${cat}` : 'placeholder';
}

/** ボスのアイコン名（BOSSES / RAID_BOSSES の id、深淵王は 'abysszero'）。 */
export function bossIconName(bossId) {
  const name = `boss_${bossId || ''}`;
  return hasIcon(name) ? name : 'mode_boss';
}

/**
 * バッジのアイコン名。🏛 シーズン刻印（s12champ のような可変 id）は
 * 1つの badge_season にまとめる ── シーズンは毎回増えるので、
 * ここで打ち止めにしないと表が永遠に足りない。
 */
export function badgeIconName(badgeId) {
  const id = String(badgeId || '');
  if (/^s\d{1,4}champ$/.test(id)) return 'badge_season';
  const name = `badge_${id}`;
  return hasIcon(name) ? name : 'placeholder';
}

/**
 * 順位（1始まり）のメダルのアイコン名。4位以降は **null** を返す。
 *
 * null を返すのは「4位のメダル」という絵を作らないため ── 順位は無限に続く
 * ので、4位以降は数字で出すのが正しい。呼び出し側はこう書く:
 *
 *   const n = medalIconName(rank);
 *   const cell = n ? icon(n, { size: 20 }) : `${rank}`;
 *
 * 画面ごとに 🥇🥈🥉 の三項演算子を書いていた5か所（screens.js の lbMedal /
 * modes.js のロイヤル結果とゴースト一覧 / friends.js のフレンド順位 /
 * adminevent.js の今日のトップ）は、すべてここを引く形にそろえた。
 */
export function medalIconName(rank) {
  const n = Math.floor(Number(rank));
  return n >= 1 && n <= 3 ? `medal_${n}` : null;
}

/**
 * レートから段位アイコンの名前を返す。
 *
 * しきい値をここに書き写さない ── public/js/ranks.js が段位の唯一の正解で、
 * 帯を足したり境界を動かしたりするのはあちらだけ。以前はこの表が
 * dom.js・server/battle.js・server/residents.js と合わせて4か所に複製されていて、
 * 「画面ではゴールドなのにサーバーはプラチナ扱い」が起きる一歩手前だった。
 */
export function rankIconName(rating) {
  return bandOf(rating).icon;
}

/** 段位アイコンを直接 SVG 文字列で返す（rankOf(...).icon の置き換え用）。 */
export function rankIcon(rating, opts = {}) {
  return icon(rankIconName(rating), { size: 16, cls: 'rank-ic', ...opts });
}
