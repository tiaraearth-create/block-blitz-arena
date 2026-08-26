#!/usr/bin/env node
// 本番サーバーから最新バックアップを取得して server/seed-backup.json に保存する。
// これをコミットしてから push すると、デプロイ後のサーバーが起動時に自動で
// マージ復元するので、更新してもプレイヤーデータ・シーズン・実績が消えない。
//
// 使い方:
//   node scripts/pull-backup.mjs                     … パスワードを聞かれる
//   ADMIN_PASSWORD=xxxx node scripts/pull-backup.mjs … 環境変数で渡す
//   node scripts/pull-backup.mjs --url http://localhost:3000  … 対象を変える
//
// npm run backup:pull でも同じ。

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import readline from 'readline';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_FILE = path.join(__dirname, '..', 'server', 'seed-backup.json');
const DEFAULT_URL = 'https://block-blitz-arena.onrender.com';
const ADMIN_NAME = 'るみまき';

const args = process.argv.slice(2);
const urlIdx = args.indexOf('--url');
const BASE = (urlIdx >= 0 && args[urlIdx + 1] ? args[urlIdx + 1] : DEFAULT_URL).replace(/\/$/, '');

// パスワードを伏せ字で読む。
//
// 前の実装は readline に入力を任せたまま、echo された文字の上から * を
// 重ね書きしていた。表示は伏せられても入力の実体には一切触れておらず、
// バックスペースを押すと表示と中身がずれ、端末によっては制御文字が値に
// 紛れ込みうる。「打ったつもりのものと違うものが送られる」ので、原因が
// 分からないままログインに失敗する。
//
// ここでは raw モードにして1文字ずつ自分で受け取る。値に何が入るかを
// こちらが完全に決められるので、表示と中身がずれようがない。
function askHidden(question) {
  const { stdin, stdout } = process;
  if (!stdin.isTTY) {
    // パイプ経由（echo pw | node scripts/pull-backup.mjs）。1行目をそのまま使う。
    return new Promise(resolve => {
      const rl = readline.createInterface({ input: stdin });
      rl.once('line', line => { rl.close(); resolve(line); });
    });
  }
  return new Promise(resolve => {
    stdout.write(question);
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');
    let buf = '';
    const done = value => {
      stdin.setRawMode(false);
      stdin.pause();
      stdin.off('data', onData);
      stdout.write('\n');
      resolve(value);
    };
    const onData = chunk => {
      // 貼り付けは複数文字がまとめて届く。コードポイント単位で回す。
      for (const ch of chunk) {
        if (ch === '\r' || ch === '\n') return done(buf);
        // Ctrl+C
        if (ch === '\u0003') { stdout.write('\n中止しました\n'); process.exit(1); }
        // Backspace
        if (ch === '\u007f' || ch === '\b') {
          if (buf.length) { buf = buf.slice(0, -1); stdout.write('\b \b'); }
          continue;
        }
        if (ch < ' ') continue;   // その他の制御文字は値に入れない
        buf += ch;
        stdout.write('*');
      }
    };
    stdin.on('data', onData);
  });
}

// fetch が投げる Error は message が一律 'fetch failed' で、本当の理由は
// err.cause の側に入っている。それを捨てていたので、原因が分からないまま
// 「エラー: fetch failed」とだけ出ていた。原因を訳して見せる。
function explain(err) {
  const c = err && err.cause ? err.cause : err;
  const code = c && c.code;
  const known = {
    ENOTFOUND: 'サーバー名を解決できません（インターネットに繋がっていないか、URLが違います）',
    ECONNREFUSED: 'サーバーに接続を拒否されました（起動中か、停止しています）',
    ECONNRESET: '接続が途中で切れました（再デプロイ中の可能性があります）',
    ETIMEDOUT: '応答がありません（再デプロイ中か、回線が不安定です）',
    EAI_AGAIN: '名前解決に一時的に失敗しました（回線が不安定です）',
    UND_ERR_CONNECT_TIMEOUT: '接続がタイムアウトしました（再デプロイ中の可能性があります）',
    UND_ERR_HEADERS_TIMEOUT: '応答が返ってきませんでした（再デプロイ中の可能性があります）',
    UND_ERR_SOCKET: 'サーバー側から接続を閉じられました（再デプロイ中の可能性が高いです）',
    // ウイルス対策ソフト（Norton など）や社内プロキシ、VPN は HTTPS を
    // 一度ほどいて自前の証明書に付け替える。その発行元は Windows の
    // 証明書ストアには入っているのでブラウザは通るが、Node は自前のCA一覧を
    // 見るため検証に失敗する。パスワードの問題と紛らわしいので明示する。
    UNABLE_TO_VERIFY_LEAF_SIGNATURE: '証明書を検証できません（ウイルス対策ソフトやVPNがHTTPSを傍受しています）',
    SELF_SIGNED_CERT_IN_CHAIN: '自己署名の証明書が挟まっています（ウイルス対策ソフトやVPNの傍受）',
    DEPTH_ZERO_SELF_SIGNED_CERT: '自己署名の証明書です（ウイルス対策ソフトやVPNの傍受）',
    CERT_HAS_EXPIRED: '証明書の期限が切れています（傍受ソフトの証明書が古い可能性）',
  };
  const why = known[code] || (c && c.message) || String(err);
  return code ? `${why}（${code}）` : why;
}

// 再デプロイ直後や無料プランのスピンアップ中は、数十秒つながらないことがある。
// 一度で諦めず、間隔をあけて数回試す。
async function req(url, opts = {}, { label = '通信', tries = 4 } = {}) {
  let last;
  for (let i = 1; i <= tries; i++) {
    try {
      return await fetch(url, { ...opts, signal: AbortSignal.timeout(90000) });
    } catch (err) {
      last = err;
      if (i < tries) {
        const wait = i * 5;
        console.log(`[backup:pull] ${label}に失敗（${explain(err)}）— ${wait}秒後に再試行 ${i}/${tries - 1}`);
        await new Promise(r => setTimeout(r, wait * 1000));
      }
    }
  }
  console.error(`[backup:pull] ${label}に失敗しました: ${explain(last)}`);
  const code = last && (last.cause ? last.cause.code : last.code);
  if (String(code).includes('CERT') || String(code).includes('SELF_SIGNED')) {
    // ここに来たら回線ではなく証明書の問題。パスワードは一切関係ない。
    console.error('');
    console.error('[backup:pull] これは通信の暗号化の問題で、パスワードは関係ありません。');
    console.error('[backup:pull] ウイルス対策ソフトやVPNがHTTPSを傍受しているときに起きます。');
    console.error('[backup:pull] 次のどれかで通ります:');
    console.error('  1. ターミナルを新しく開き直してから、もう一度実行する（多くはこれで直ります）');
    console.error('  2. Norton VPN を使っている場合は、一度切ってから実行する');
    console.error('  3. それでも駄目なら次を実行する:');
    console.error('     node --use-system-ca scripts/pull-backup.mjs');
  } else {
    console.error('[backup:pull] サーバーが再デプロイ中かもしれません。数分おいてもう一度お試しください。');
    console.error(`[backup:pull] ブラウザで ${BASE} が開けるかどうかも確認の目安になります。`);
  }
  process.exit(1);
}

async function main() {
  console.log(`[backup:pull] 対象サーバー: ${BASE}`);

  // 先に「繋がるか」だけ確かめる。認証の要らない /api/status を叩くので、
  // ここで落ちれば原因は通信側だと確定できる。
  // パスワードを聞いたあとに通信で落ちると、「パスワードが違うのでは」と
  // 疑ってしまう。実際それで、変える必要のないパスワードを変えさせてしまった。
  console.log('[backup:pull] サーバーに繋がるか確認中…');
  const probe = await req(`${BASE}/api/status`, {}, { label: 'サーバーへの接続' });
  if (!probe.ok) {
    console.error(`[backup:pull] サーバーが応答しません: HTTP ${probe.status}`);
    process.exit(1);
  }
  console.log('[backup:pull] 接続OK。ここから先で失敗したら、原因は通信ではありません。');
  const fromEnv = !!process.env.ADMIN_PASSWORD;
  const password = process.env.ADMIN_PASSWORD
    || await askHidden(`${ADMIN_NAME} の管理者パスワード: `);
  // 受け取った文字数を出す。値そのものは出さない。
  // 「打ったはずの文字数と違う」= 入力が化けている、とその場で分かるようにする。
  // 原因の分からないログイン失敗を、いちばん早く切り分けられるのがこれ。
  // 環境変数が残っていると、入力を求めずそちらを黙って使ってしまう。
  // 「打ったパスワードは合っているのに弾かれる」の原因になるので明示する。
  if (fromEnv) {
    console.log(`[backup:pull] 環境変数 ADMIN_PASSWORD を使用します（${password.length} 文字）`);
    console.log('[backup:pull] 入力を求められたい場合は、その環境変数を消してください。');
  } else {
    console.log(`[backup:pull] パスワードを ${password.length} 文字ぶん受け取りました`);
  }
  if (password !== password.trim()) {
    console.warn('[backup:pull] 前後に空白が入っています。貼り付けミスの可能性があります。');
  }
  if (!password) { console.error('パスワードが空です。中止しました。'); process.exit(1); }

  console.log('[backup:pull] ログイン中…（再デプロイ直後は少し時間がかかることがあります）');
  const loginRes = await req(`${BASE}/api/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: ADMIN_NAME, password }),
  }, { label: 'ログイン' });
  const login = await loginRes.json().catch(() => ({}));
  if (!loginRes.ok || !login.token) {
    console.error(`ログインに失敗しました: ${login.error || loginRes.status}`);
    if (loginRes.status === 401) {
      console.error('[backup:pull] パスワードが違います。Render の Environment の ADMIN_PASSWORD と同じものを入力してください。');
      console.error('[backup:pull] 変更直後の場合は、再デプロイが終わるまで古いパスワードのままです。');
    }
    process.exit(1);
  }

  console.log('[backup:pull] バックアップを取得中…');
  const bakRes = await req(`${BASE}/api/admin/backup`, {
    headers: { Authorization: `Bearer ${login.token}` },
  }, { label: 'バックアップの取得' });
  if (!bakRes.ok) {
    console.error(`バックアップの取得に失敗しました: HTTP ${bakRes.status}`);
    process.exit(1);
  }
  const data = await bakRes.json();
  const users = data.users ? Object.keys(data.users).length : 0;
  if (!users) { console.error('ユーザー0件のバックアップは保存しません。'); process.exit(1); }

  // The repo is public — the seed is encrypted with the admin password
  // (scrypt → AES-256-GCM). The server decrypts it at boot with the
  // ADMIN_PASSWORD environment variable, which must therefore be set on the
  // hosting dashboard and match this password.
  const salt = crypto.randomBytes(16);
  const iv = crypto.randomBytes(12);
  const key = crypto.scryptSync(password, salt, 32, { N: 1 << 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([cipher.update(JSON.stringify(data), 'utf8'), cipher.final()]);
  fs.writeFileSync(OUT_FILE, JSON.stringify({
    v: 1, enc: 'aes-256-gcm', kdf: 'scrypt-n15',
    salt: salt.toString('base64'), iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'), data: enc.toString('base64'),
    users, backupAt: data.meta && data.meta.backupAt || Date.now(),
  }));
  const kb = Math.round(fs.statSync(OUT_FILE).size / 1024);
  console.log(`[backup:pull] 暗号化して保存しました → ${path.relative(process.cwd(), OUT_FILE)}（${users}人 / ${kb}KB）`);
  console.log('[backup:pull] このファイルをコミットして push すれば、デプロイ後に自動で復元されます。');
  console.log('[backup:pull] ※ Render の Environment に ADMIN_PASSWORD（今入力したものと同じ）が必要です。');
}

main().catch(err => { console.error('[backup:pull] エラー:', err.message); process.exit(1); });
