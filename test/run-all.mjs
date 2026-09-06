// リポジトリのルートから:  npm test   （＝ node test/run-all.mjs）
//
// test/*.test.mjs をまとめて走らせる。
//
// もともと package.json の test は全部を `&&` でつないだ一本の長い行だった。
// 直列なので遅いうえ、途中で1本落ちるとそこで止まり、**残りが通るのかどうかが
// 分からない**。1つ直して回し直すと次が落ちる、を繰り返すことになる。
// ここでは全部を最後まで走らせて、落ちたものをまとめて出す。
//
// ■ 並列にしてよいのか（重要）
// サーバーを立てるテストが17本ある。並列にするなら、次の2つが衝突しないことが
// 前提になる。両方とも確認済み:
//   ・ポート … 全17本が test/_port.mjs の freePort() を使い、OS に 0 番を
//     渡して空きを割り当ててもらっている。固定ポートは残っていない。
//   ・保存先 … 全17本が DATA_DIR に os.tmpdir() 配下の**自分専用**の名前を
//     渡している（bba-battle-test / bba-social-test …）。重複は無い。
//     dbsafety は mkdtempSync で毎回別の場所を作り、wsip は割り当てられた
//     ポート由来の名前を使う（起動前と終了後に自分で消す）。
// なので同時に走らせてもデータを踏み合わない。
//
// ただし freePort() は「空きを見つけて閉じてから使う」ので、閉じてから
// サーバーが listen するまでの一瞬に他人が取る可能性はゼロではない。並列度を
// 上げるほどその窓は踏まれやすくなる。また royale / shutdown のように実時間で
// 待つテストがあり、機械が重いと起動待ち（15〜20秒）が間に合わなくなる。
//
// 既定は同時2本。以前の既定（4本）だと social / battle / royale あたりが
// 「fetch failed」だけ残して落ちることがあり、単独で回すと全部通る——という
// 偽の失敗が出ていた。テストが嘘をつくと、本物の失敗まで疑われなくなる。
// CI（.github/workflows/ci.yml）も TEST_JOBS=2 なので、これで手元と揃う。
// 速さが要るときだけ上げる:
//
//   node test/run-all.mjs --jobs 1     … 直列（いちばん安全・いちばん遅い）
//   node test/run-all.mjs --jobs 4     … 速いマシン向け（偽の失敗が出たら下げる）
//   TEST_JOBS=1 npm test               … 環境変数でも同じ
//
// 出力は「走らせた順」ではなく「1本ぶんをまとめて」出す。並列の出力を
// 混ぜると誰の ❌ なのか分からなくなるため、終わったものから塊で流す。

import { spawn } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');

// 速い順。直列で回すときに、安いテストから落ちてくれたほうが早く気づける。
// 上の17本はサーバーを立てない純ロジック（合計でも数秒）。
const TESTS = [
  // いちばん最初に置く。public/js は素のままブラウザへ配られる（ビルド工程が
  // 無い）ので、閉じ括弧1つの欠けで全プレイヤーが起動できなくなる。それを
  // 数百msで止められるのはこれだけなので、他のどれより先に落ちてほしい。
  'syntax.test.mjs',
  'engine.test.mjs',
  'modes-structure.test.mjs',
  'mode-registry.test.mjs',
  // 商品を足したのにアイコン表を更新し忘れる（＝棚に同じ絵が並ぶ）を止める。
  // サーバーも DOM も要らないので、安いほうに置いてある。
  'icons.test.mjs',
  // 遊び方（public/js/rules.js）の数字が、サーバー／engine の式とズレていないか。
  // 一覧に入れ忘れていたので走っていなかった（第1波の統合で発覚）。
  // サーバーも DOM も要らないので、icons と同じ安い組に置く。
  'rules.test.mjs',
  // 段位（帯・24段）の唯一の正解が public/js/ranks.js であること。
  // server に手書きの表が復活していないかをソース検査で見張るので、
  // rules と同じくサーバー不要の安い組に置く。
  'ranks.test.mjs',
  'workshop.test.mjs',
  // 📴 圏外でもアカウントが残って見えること／その控えで管理者になれないこと。
  // サーバーを立てず、localStorage と最小の DOM を用意して dom.js を実際に
  // 動かすだけなので、安い組に置く（offline.test.mjs は本物のサーバーと
  // 本物の sw.js を回すので重い組。見ているものも別: あちらは「起動一式が
  // 控えにあるか」、こちらは「自分の情報の控えと、その権限の扱い」）。
  'offlineauth.test.mjs',
  // 🗄 端末に置く bba_* の一覧と仕分け。手書きの消去リストが腐って
  // 「リセットしたのに前の人の記録が残る」になったので、ソースから機械抽出して
  // 突き合わせる。サーバー不要の安い組。
  'localkeys.test.mjs',
  // 🚪 ログアウト・退会で端末に前の人のデータを残さない。offlineauth と同じ
  // 器（localStorage と最小の DOM）で dom.js を実際に動かすので隣に置く。
  'signout.test.mjs',
  'viewresize.test.mjs',
  'i18n.test.mjs',
  'clientwiring.test.mjs',
  'persist-registry.test.mjs',
  'api-contract.test.mjs',
  'ytexport.test.mjs',
  'clip.test.mjs',
  'resultclamp.test.mjs',
  'zero.test.mjs',
  'zero-session.test.mjs',
  'crowd.test.mjs',
  'ranking-ai.test.mjs',
  // 🌍 世界の辻褄（表示オンライン人数 ↔ ランキングの行数 ↔ にぎわいの札 ↔
  // 発言の速さ）。ranking-ai が「1人ぶんの数字が生きているか」を見るのに対し、
  // こちらは「人数と他の数字が食い違っていないか」を見る。サーバー不要の安い組。
  'worldconsistency.test.mjs',
  // 🐛 バグ探し 第2波（断罪・オンライン・深淵・サバイバル・翻訳・ギルド）。
  // 純ロジックとソース検査だけなので安い組。とくに「盤面が置いた以外の理由で
  // 死んだことに気づけるか」は、モードもお邪魔の経路も増え続けるので見張る。
  'bugfix-wave2.test.mjs',
  // 👁️断罪の走行の終わりぎわ（結果画面・伝言モーダルの間も撃たれない）と、
  // 枠の長さが20分より短いときの取引。偽の時計で本物の tick を回す。
  'zerofinish.test.mjs',
  // 🐛 バグ探し 第5波（進行不能・盤面が壊れる）。閉じ口の無いモーダル・
  // 止まらない時計・消えない行 ── 自力で抜け出せなくなる種類の壊れ方。
  'bugfix-wave5.test.mjs',
  // 🐛 バグ探し 第6波（報酬の数・嘘の表示・操作と端末差）。遊べてはいるので
  // 気づきにくいが、毎回すこしずつ損をする種類の壊れ方をまとめて見張る。
  'bugfix-wave6.test.mjs',
  // 🧹 「繋いだつもりで繋がっていなかった」配線。片側だけの実装・欄名の
  // 読み違え・呼ぶ場所の無い仕掛け・画面の無いAPI。どれもエラーが出ないので、
  // 動いているつもりのまま何ヶ月も残る種類の壊れ方。
  'deadwiring.test.mjs',
  // 💤 作り終えているのに触れなかった機能（カオス・宝物庫・幽霊屋敷・板の無い
  // 9モード）。とくに板は4か所そろえないと『その板だけ実プレイヤーしか並ばない』
  // ＝正体判定器になるので、機械で見張る。
  'awaken.test.mjs',
  // 🤝 実プレイヤーどうしを繋ぐ経路（名前だけでフレンド申請・ギルドチャット・
  // ルームで攻撃戦）。サーバーを立てて WS を往復させる統合テスト。
  'connect.test.mjs',
  // 🆕 新要素2つ（しおり・ゼロの眼）。engine の保存と復元は実物で確かめる。
  'newfeatures.test.mjs',
  // 🏆 「上位100位」がその世界の規模に見合った顔ぶれか。worldconsistency が
  // 「行数」を見るのに対し、こちらは **行の中身** を見る（人数だけ増えて
  // 100位が Lv.1・8,309点、という非対称を作らない）。サーバー不要の安い組。
  'boardquality.test.mjs',
  // 🗒 住人の戦績が「実際に起きたこと」を映すか（人間が勝つと本当に敗が増える）。
  // ranking-ai と表裏なので隣に置く ── あちらは「計算で作る基準値」が生きて
  // いることを、こちらは「その上に乗る実記録」を見る。サーバー不要の安い組。
  'residentrecord.test.mjs',
  'dbsafety.test.mjs',
  // ここから下はサーバーを起動する。
  // 接続上限まわり。サーバーを2つ立てる（プロキシ有り構成／無し構成）ぶん
  // 少し重いので、サーバー組の先頭に置いて早めに結果を出す。
  'wsip.test.mjs',
  'restore-auth.test.mjs',
  'session.test.mjs',
  'rank-rewards.test.mjs',
  'new-modes.test.mjs',
  'persist.test.mjs',
  'gacha.test.mjs',
  'inventory.test.mjs',
  'useredit.test.mjs',
  // 🔓 隠し要素（神／創造神／幽霊屋敷）の解放。誤爆しない合図（純ロジック）＋
  // アカウント保存・端末またぎ・復元の合流をサーバーで通す。復元まで見るので
  // persist / useredit と同じ組に置く。
  'unlocks.test.mjs',
  'security.test.mjs',
  // 🚪 退会・管理者削除の後始末（UGC・報告者名・チャット履歴・接続・墓標）。
  // 「コメントには2本から呼ぶと書いてあるのに1本しか呼んでいない」を機械で
  // 見張る。security と同じ組（サーバーを立て、復元まで通す）。
  'accountpurge.test.mjs',
  // 🤝 ゲスト相手／合言葉ルームの対戦は「練習試合」（勝ち星・連勝・勝利報酬が
  // 付かない）。ゲストは登録が要らない＝ただで作れるので、ここが緩いと
  // 勝ち星と実績を無限に量産できる。巻き添え（ふつうのレート戦が動かなくなる）
  // も同じテストで見張る。
  'guestmatch.test.mjs',
  // 🪪 名乗れる名前の門（登録・改名・ゲスト名で同じ厳しさ）。ゼロ幅スペースや
  // 全角で「運営」「管理者ゼロ」になりすませないこと、その代わりに既存
  // ユーザーのログインを締め出していないこと。
  'nameclaim.test.mjs',
  // 🚫 取り締まりと身元 ── 凍結された回線／ゲスト名の照会上限／殿堂とお知らせに
  // 焼き付いた名前／通報と操作ログのID照合／同じ相手との連戦。どれも
  // 「効きすぎない」ことを同じテストで見張っている（巻き添えが本体より怖い）。
  'moderation.test.mjs',
  // 🐛 バグ探し（2026-09-04）第1波の修正。招待制ギルドの合言葉照合・称号
  // 《大富豪》の到達判定・フレンド申請の断り順（相手の事情を漏らさない）と、
  // コメントが約束していたのに破れていた配線一式。
  'bugfix-wave1.test.mjs',
  // 🔌 切断の猶予（戻れる／戻らなければ従来どおり負ける／別人は席を取れない）。
  // 「敗北とEloの回避」を塞いだ門を再接続の名目で開け直していないかを見るので、
  // security / secrecy と同じ組に置く。実時間で20秒ほどかかる。
  'reconnect.test.mjs',
  // 🕒 在席区間ログ（誰がいつオンラインだったか）。上限が効いていることと、
  // 復元の合流で消えないこと。reconnect と同じ WS の生死まわりなので隣に置く。
  'onlinelog.test.mjs',
  // 📊 管理者のプレイヤー統計（誰がいつオンラインだったか）。見せてよい相手を
  // 間違えると個人の行動履歴の流出になるので、security / secrecy と同じ組に置く
  // ── どれも「返してはいけないものを返していないか」を見るテスト。
  'adminstats.test.mjs',
  // 👀 いま誰がオンラインか（/api/admin/online）。名前つきの現在地そのものなので、
  // 見せてよい相手を間違えたら即流出。adminstats の隣に置く ── あちらが
  // 「いつオンラインだったか（履歴）」を、こちらが「いま誰が居るか」を見る。
  // 実WSで数人つないで対戦が始まるまで待つので、実時間で20秒ほどかかる。
  'adminonline.test.mjs',
  // 「ソロを押してすぐ終了」の連投で稼げないこと＋1日の上限。
  // security と同じく「配ってはいけないものを配っていないか」を見るので隣に置く。
  'farming.test.mjs',
  // 🌪️ カオスの「コイン1.5倍」がイベント中だけに掛かること。入口を常時開けたときに
  // 倍率だけが取り残され、「いつでも遊べる1.5倍のモード」になっていた。
  // farming と同じく「配ってはいけないものを配っていないか」なので隣に置く。
  'chaosbonus.test.mjs',
  // 🪙 「遊ばずに通貨が湧く」経路。farming が 🪙/XP の連投を見張るのに対し、
  // こちらは **その門をすり抜けていた蛇口** ── 👁王座の欠片（唯一そのまま通貨を
  // 鋳造する行なのに realPlay も日次上限も無かった）と、実プレイの物理から
  // 2桁ずれた申告テレメトリ（実績→💎 の原資）。住人の板の値が人間の絶対上限を
  // 超えていないか（＝1位を人間が取れるか）も同じ組で見る。
  'econguard.test.mjs',
  // 🙋 ユーザー報告ぶん（2026-09-06）── 配置プレビューの3段・チュートリアルの
  // 一度きり・しおりのUI崩れ・隠し要素の解放。どれも「実装はあるのに届かない」形。
  'userfix.test.mjs',
  // 🧾 結果送信の冪等キー（同じ runId を2回送っても1回ぶんしか入らない）と、
  // その上に乗る「オフライン中の記録を後から送る」控え。farming と同じく
  // 「配ってはいけないものを配っていないか」を見るので隣に置く。
  'idempotent.test.mjs',
  // 🎭 住人（AIプレイヤー）の正体が非管理者に漏れていないか。security の隣に
  // 置く ── 見ているものは違うが、どちらも「返してはいけないものを返していないか」。
  'secrecy.test.mjs',
  // 🎭 同じ「秘匿」でも見るものが違う。あちらは**禁止キーが出たか**、
  // こちらは**欄の有無で仕分けできるか**。禁止キー0件のまま、順位表・
  // ライブフィード・フレンド検索の3か所で住人が総当たり不要で判別できていた。
  'secrecy-shape.test.mjs',
  // 🎭 対戦カードの称号・ギルド・戦績で正体が割れないか。secrecy が「禁止キーが
  // 混ざっていないか」を見るのに対し、こちらは「**欄の揃い方と値の分布**で
  // 選り分けられないか」を統計で見る（使い捨ての対戦相手が住人と同じ分布か）。
  // サーバーを2つ順に立てるので、secrecy と同じ重い組に置く。
  'personaparity.test.mjs',
  'adminevent.test.mjs',
  'throne.test.mjs',
  'social.test.mjs',
  'daily.test.mjs',
  'battle.test.mjs',
  'royale.test.mjs',
  // 👀 観戦の取り決め（watch / watchable）。ロイヤル側をWSで1試合ぶん通すので
  // royale の隣に置く（実時間で30秒ほどかかる）。
  'spectate.test.mjs',
  // 🚪 カスタムルームの定員8人と観戦席。実マッチを1本回すので重い組。
  'room.test.mjs',
  // 🚪 合言葉ルームの「友達と遊ぶ導線」。room.test.mjs は常に観戦者を用意して
  // いるので**2人だけ**を一度も踏んでおらず、観戦者ゼロで部屋が消える障害が
  // 長く残った。ここは2人から始めて、連戦・ホスト・攻撃戦・在室表示まで見る。
  'roomfix.test.mjs',
  // 🚪 16人ルーム・席ごとのチーム指定・対戦する人数の選択（2026-09-06 要望）。
  // ★ 席を選べるようにすると『1人＋ボット15人で必勝ボタン』になるので、
  //   「部屋の試合は人数にもモードにもよらず練習試合」を同じテストで見張る。
  'room16.test.mjs',
  // 🧱 進行できなくなる／記録が消える系。ロイヤルの切断でWSを1本立てるので
  //   サーバー組。しおり・呪縛・録画の引き直し・大会の離脱口・更新時の締めは
  //   同じファイルの前半でサーバー無しに見ている。
  'progress.test.mjs',
  // 🪞 見せた数字と実際に起きたことのズレ（カオスの「1.5倍」・練習試合の Elo・
  //   録画再生の種・フィーバー・奥義ゲージ・パス満了・欠片の上限・デイリーの
  //   ジェム欄・協力の新記録・ロイヤルの最後の1手）。ソース検査と純ロジックだけ
  //   なので安い組に置きたいが、progress と同じ話題なので隣に並べる。
  'displaytruth.test.mjs',
  // 🧾 判定と記録のズレ（大会の勝ち／不戦勝の報酬／遺跡の★／設計図の日跨ぎ／
  //   図鑑の在庫判定／しおりのテレメトリ／デイリーの冪等キー／ライバル表の同点順位…）。
  //   実物の Engine と catalog を読み込んで通すので、サーバーは要らない。
  'recordtruth.test.mjs',
  // 🛒 棚・持ち物・順位表の数え方と言い方（監査の残り）。
  //   ★ 順位報酬の「/ N人中」は**実プレイヤーの人数**そのものだったので、
  //     秘匿の検査としても効く（100行あるランキングの残りが割れる）。
  'shelftruth.test.mjs',
  // 🔍 未監査だった5領域（管理者ツール・👁️断罪・にぎわい/翻訳/投票・
  //   フレンド/パーティ・オフライン/PWA）のバグ。実物の translate / polls /
  //   friends を読み込んで通すので、サーバーは要らない。
  'restareas.test.mjs',
  // 😖 痛い場所（理不尽・面倒・分かりにくい）。実プレイヤーが13人しかいない
  //   世界で「到達不能な目標」「自分の落ち度でないのに損をする形」を見張る。
  //   ★ B-5 は要注意 ── ロイヤルの猶予は、ロビーの解体条件にも通さないと
  //     『猶予前にロビーごと消えて報酬がゼロ』になる（改善のつもりが改悪になる）。
  'painpoints.test.mjs',
  // 🧹 第3回横断監査の「中」「小」ぶん（52件）の回帰。落ちはしないが
  //   「画面が嘘をつく／設定が効かない／指が届かない」形の不具合で、
  //   直したことがコードの見た目から分かりにくいものばかり。静的検査だけ
  //   なのでサーバーは要らない（安い組に置いてある）。
  'polish.test.mjs',
  // 🎵 BGM のトラック表。「鳴らないことが確実に分かる形」（存在しない音名・
  //   欠けたドラム・噴み合わない指定）と、**使い回し**を見張る。
  //   E-1 がこのテストの本題 1つの曲を2つ以上のモードが借りた瞬間に赤くなる。
  'tracks.test.mjs',
  // 🕵 記録の監査。「遊んだ形跡に対して記録が高すぎる」を拾う。
  //   ★ このテストの本命は 4-1/4-2（**正直な人を引っかけない**）。
  //   検査を強くするときは、先にここが赤くならないか見ること。
  //   db.json を書き換えてアカウントの年齢を作るので重い組に置く。
  'audit.test.mjs',
  // 🩹 第6波の統合で潰した不具合の回帰。対戦の裁定（終了間際の切断・二重切断・
  // 自分から降りる）とカスタムルームの観戦席を実WSで通すので、reconnect / room と
  // 同じ重い組に置く。翻訳・実績・復元の検査はサーバー無しで同じファイルの後半にある。
  'wave6.test.mjs',
  // 📴 オフラインで遊べるか。本物の sw.js を本物のサーバー相手に走らせて、
  // 控えの中身を数えてから通信を落とす（＝ソース検査では出てこない
  // 「SW は load で登録されるので初回訪問は1本も通らない」を捕まえる）。
  // サーバーを立てるので重い組に置く。
  'offline.test.mjs',
  // 👑 ちゃちゃまる。住人の計算（サーバー不要）に加えて、v2.35 から
  // 「本当に対戦相手として出て、倒すと印が付く」をWSで通しで見るので、
  // 純ロジックの安い組ではなくサーバー組に置いてある。
  'champion.test.mjs',
  // 🚨 本番に出ていた重大4件（v2.63.2）の回帰。うち2件は直前の波で
  // 自分が開けた穴（ブループリントの申告日、初回の持ち時間の持ち越し）なので、
  // ここを赤くしたまま何かを直さないこと。サーバーを立て直す（db.json を
  // 書き換えてアカウントを「40分前に作られた」ことにする）ので重い組に置く。
  'criticals.test.mjs',
  'shutdown.test.mjs',
];

// 1本あたりの上限。無限に待つと CI が止まったまま気づけない。
const TIMEOUT_MS = Number(process.env.TEST_TIMEOUT_MS || 300000);

const args = process.argv.slice(2);
const jobsArg = args.indexOf('--jobs');
let JOBS = Number(
  (jobsArg >= 0 && args[jobsArg + 1]) || process.env.TEST_JOBS || 2
);
if (!Number.isFinite(JOBS) || JOBS < 1) JOBS = 1;
JOBS = Math.min(JOBS, TESTS.length);

// 走らせる前に、並べたファイルが実在するか見る。名前を打ち間違えたまま
// 「26本中25本成功」と出るのがいちばん困る（見えないところが増えていく）。
const missing = TESTS.filter(f => !fs.existsSync(path.join(__dirname, f)));
if (missing.length) {
  console.error(`❌ 一覧にあるのに見つからないテストがあります: ${missing.join(', ')}`);
  console.error('   test/run-all.mjs の TESTS を直してください。');
  process.exit(1);
}
// 逆に、置いてあるのに一覧に無いものも知らせる（黙って走らないほうが怖い）。
const listed = new Set(TESTS);
const onDisk = fs.readdirSync(__dirname).filter(f => f.endsWith('.test.mjs'));
const unlisted = onDisk.filter(f => !listed.has(f));

const nowMs = () => Number(process.hrtime.bigint() / 1000000n);
const secs = ms => `${(ms / 1000).toFixed(1)}s`;

// Windows では kill() が子（テストが起動したサーバー）まで届かない。
// 時間切れで諦めるときくらいは、道連れにしておく。
function hardKill(proc) {
  if (process.platform === 'win32' && proc.pid) {
    try {
      spawn('taskkill', ['/pid', String(proc.pid), '/t', '/f'], { stdio: 'ignore' });
      return;
    } catch { /* taskkill が無ければ下の kill にまかせる */ }
  }
  try { proc.kill('SIGKILL'); } catch { /* もう死んでいる */ }
}

function runOne(file) {
  return new Promise(resolve => {
    const t0 = nowMs();
    const proc = spawn(process.execPath, [path.join('test', file)], {
      cwd: ROOT,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '', err = '';
    let timedOut = false;
    // 明示的に utf8 で受ける。Buffer のまま足していくと、日本語が
    // チャンクの切れ目でちょうど分断されたときに文字化けする
    // （✅ の行が読めなくなって、何が落ちたのか分からなくなる）。
    proc.stdout.setEncoding('utf8');
    proc.stderr.setEncoding('utf8');
    proc.stdout.on('data', d => { out += d; });
    proc.stderr.on('data', d => { err += d; });
    const timer = setTimeout(() => { timedOut = true; hardKill(proc); }, TIMEOUT_MS);
    const finish = (code, signal) => {
      clearTimeout(timer);
      resolve({
        file, out, err, timedOut,
        ms: nowMs() - t0,
        ok: !timedOut && code === 0,
        why: timedOut ? `時間切れ（${secs(TIMEOUT_MS)}）`
          : code === 0 ? '' : `終了コード ${code}${signal ? ` / ${signal}` : ''}`,
      });
    };
    proc.on('error', e => finish(-1, String(e && e.message)));
    proc.on('close', finish);
  });
}

function report(r, index, total) {
  const head = r.ok ? '✅' : '❌';
  console.log('');
  console.log(`${head} ${r.file}  (${secs(r.ms)})  [${index}/${total}]`);
  const body = (r.out + (r.err ? (r.out ? '\n' : '') + r.err : '')).replace(/\s+$/, '');
  if (body) console.log(body.split('\n').map(l => `   ${l}`).join('\n'));
  if (!r.ok) console.log(`   ── ${r.why}`);
}

async function main() {
  console.log(`[test] ${TESTS.length}本を同時${JOBS}本で実行します（node ${process.version} / ${os.platform()}）`);
  if (JOBS === 1) console.log('[test] 直列モードです。');
  if (unlisted.length) {
    console.log(`[test] ⚠ 一覧に入っていないテストがあります（走りません）: ${unlisted.join(', ')}`);
  }

  const t0 = nowMs();
  const done = [];
  let next = 0;

  const worker = async () => {
    for (;;) {
      const i = next++;
      if (i >= TESTS.length) return;
      const r = await runOne(TESTS[i]);
      done.push(r);
      report(r, done.length, TESTS.length);
    }
  };
  await Promise.all(Array.from({ length: JOBS }, worker));

  const failed = done.filter(r => !r.ok);
  const total = nowMs() - t0;

  console.log('');
  console.log('─'.repeat(60));
  if (!failed.length) {
    console.log(`✅ 全 ${TESTS.length} 本が成功しました（${secs(total)}）`);
    return;
  }
  console.log(`❌ ${failed.length} / ${TESTS.length} 本が失敗しました（${secs(total)}）`);
  console.log('');
  for (const r of failed) {
    console.log(`  ❌ ${r.file} — ${r.why}`);
    // 失敗した行だけ抜き出して添える。上のログを遡らなくても原因に当たれる。
    const bad = (r.out + '\n' + r.err).split('\n').filter(l => l.includes('❌')).slice(0, 8);
    for (const l of bad) console.log(`       ${l.trim()}`);
    // ❌ が1行も無いまま落ちた＝「何が壊れたのか分からない失敗」。
    // 無言で終わったときは、せめて最後に出ていたものを見せる。
    if (!bad.length) {
      const tail = (r.err || r.out).split('\n').map(l => l.trimEnd()).filter(Boolean).slice(-8);
      if (tail.length) for (const l of tail) console.log(`       ${l}`);
      else console.log('       （出力はありませんでした）');
    }
  }
  console.log('');
  console.log('  1本だけ回すには:  node test/<ファイル名>');
  if (JOBS > 1) {
    console.log('  同時実行が原因かもしれないときは:  node test/run-all.mjs --jobs 1');
  }
  process.exitCode = 1;
}

main().catch(err => {
  console.error('[test] ランナー自体が落ちました:', (err && err.stack) || err);
  process.exit(1);
});
