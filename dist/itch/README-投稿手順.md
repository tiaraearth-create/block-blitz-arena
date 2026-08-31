# 🚀 公開キット — itch.io / Reddit / X

このフォルダの `index.html` が itch.io にアップロードするファイルです。
そのままコピペで使える文面も下にまとめてあります。

---

## 0. 先に1回だけ：Render の環境変数を1つ足す

itch.io はゲームを iframe の中で動かします。いまのサーバーは
「自分のサイト以外には埋め込ませない」設定なので、itch.io だけ許可します。

Render → block-blitz-arena → Environment → Add Environment Variable

| Key | Value |
|---|---|
| `FRAME_ANCESTORS` | `https://itch.io https://*.itch.io https://html-classic.itch.zone` |

保存すると再デプロイされます。**これを忘れると itch.io で真っ黒な画面になります。**
（itch.io をやめたくなったら、この変数を消すだけで元の「埋め込み禁止」に戻ります）

---

## 1. itch.io（審査なし・即日・無料）

### アップロードするもの
`index.html` だけを入れた ZIP を作ってアップロードします。

```
右クリック → 圧縮 → index.html だけが入った zip
```

### ページ設定
- **Kind of project**: HTML
- アップロード後、そのファイルの **「This file will be played in the browser」にチェック**
- **Embed options**: Manually set size → **Width 480 / Height 860**、
  「Fullscreen button」と「Mobile friendly」にチェック
- **Genre**: Puzzle / **Tags**: `puzzle`, `multiplayer`, `mobile`, `html5`, `block`, `casual`, `free`

### ページ本文（英語・そのままコピペ）

> **Block Blitz Arena** is a free block-puzzle game you can play right in your
> browser — no download, no signup.
>
> Drop blocks, clear lines, chain combos. Then take it online: real-time 1v1
> duels, 100-player battle royale, co-op, guilds and a 100-floor dungeon.
>
> **Features**
> - ⚡ Instant play — works on phone and desktop, no account needed
> - ⚔️ Online duels, 2v2, co-op and 100-player battle royale
> - 🏰 100-floor dungeon, boss fights, daily & weekly challenges
> - 🎵 Original soundtrack, generated live in your browser
> - 🌐 Full English and Japanese support
>
> Built solo. Feedback very welcome!

### ページ本文（日本語）

> **Block Blitz Arena** は、ブラウザですぐ遊べる無料のブロックパズルです。
> ダウンロードも登録もいりません。
>
> ブロックを置いてラインを消す気持ちよさはそのままに、オンライン対戦へ。
> リアルタイム1v1、100人バトルロイヤル、協力プレイ、ギルド、100階ダンジョン。
>
> **できること**
> - ⚡ 登録なしで即プレイ（スマホ・PC どちらでも）
> - ⚔️ オンライン対戦・2v2・協力プレイ・100人バトルロイヤル
> - 🏰 100階ダンジョン、ボス戦、デイリー／ウィークリー
> - 🎵 ブラウザ内で生成しているオリジナルBGM
> - 🌐 日本語・英語対応
>
> 個人開発です。感想をもらえると嬉しいです！

---

## 2. Reddit r/WebGames（自作ゲームの直リンクOKな数少ない場所）

**投稿タイトル（英語のまま）**

```
Block Blitz Arena — free block puzzle with real-time online duels and 100-player battle royale (browser, no download, mobile OK)
```

**本文**

```
I've been building this solo for the past few weeks: a Block Blast-style
puzzle game, but with an online layer on top.

- Real-time 1v1 duels, 2v2, co-op, and a 100-player battle royale
- 100-floor dungeon, boss fights, daily and weekly challenges
- Runs in the browser on phone and desktop — no download, no signup
- Original soundtrack synthesised live in the page (no audio files)
- English and Japanese

Play: https://block-blitz-arena.onrender.com/?ref=reddit

It's completely free and there are no ads. Genuinely after feedback — the
first 60 seconds especially. What made you stop playing?
```

**投稿時のコツ**
- 投稿する前に、シークレットウィンドウで開いて「登録なしで即プレイできる」ことを確認
- 投稿後2〜3時間は張り付いて、コメントに全部返信する（ここが一番効きます）
- r/incremental_games はジャンル違いなので投稿しない

---

## 3. X（週2〜3回・15〜30秒のクリップ）

**固定ポスト用**

```
ブラウザで遊べる無料のブロックパズル「Block Blitz Arena」を個人開発しています。

⚡ 登録なしで即プレイ
⚔️ オンライン対戦・100人バトロワ
🏰 100階ダンジョン
🎵 BGMも全部その場で生成

▶ https://block-blitz-arena.onrender.com/?ref=x

#ゲーム制作 #インディーゲーム
```

**クリップ投稿の型**（週2〜3回、これの使い回しでOK）

```
【全消しの瞬間】
盤面が一気に消えるところ。冒頭1〜2秒に必ず消える瞬間を置く。
→「気持ちいいところだけ」15秒
```
```
【逆転】
オンライン対戦で負けていたのが最後に勝つところ。
→ スコアが入れ替わる瞬間で終わる
```
```
【あと1手】
詰みかけから生還する手。「どこに置く？」と問いかけて投稿すると反応が伸びる
```

- ハッシュタグは**1投稿2〜3個まで**（詰め込むと届かなくなります）
- 海外向けは別ポストで `#indiedev #indiegame`（日本語タグと混ぜない）

---

## 4. スクリーンショット（自分で4枚だけ撮ってください）

スマホの実機で撮るのが一番きれいです。撮るのはこの4枚：

1. **メニュー画面**（モードがずらっと並んでいるところ）
2. **プレイ中**（盤面にブロックが乗っていて、コンボが出ている瞬間）
3. **オンライン対戦中**（相手の盤面も映っているところ）
4. **結果画面**（スコアが大きく出ているところ）

itch.io は1枚目がサムネイルになるので、**2番（プレイ中）を1枚目**にすると
「何のゲームか」が一目で伝わります。

---

## 5. 順番

1. Render に `FRAME_ANCESTORS` を追加（上の 0）
2. itch.io にページを作る（審査なし・すぐ公開できます）
3. スクリーンショット4枚を撮って貼る
4. Reddit に投稿 → コメントに全部返信
5. X の固定ポストを作る → 週2〜3回クリップ

一度に全部やらなくて大丈夫です。**1と2だけでも今日の価値は出ます。**
