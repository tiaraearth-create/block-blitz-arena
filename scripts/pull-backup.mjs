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

function ask(question, { hidden = false } = {}) {
  return new Promise(resolve => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    if (hidden && process.stdin.isTTY) {
      // Echo * instead of the typed characters.
      const onData = ch => {
        const s = String(ch);
        if (s === '\n' || s === '\r' || s === '') return;
        readline.moveCursor(process.stdout, -s.length, 0);
        process.stdout.write('*'.repeat(s.length));
      };
      process.stdin.on('data', onData);
      rl.question(question, answer => {
        process.stdin.off('data', onData);
        rl.close();
        process.stdout.write('\n');
        resolve(answer.trim());
      });
    } else {
      rl.question(question, answer => { rl.close(); resolve(answer.trim()); });
    }
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
  console.error(`[backup:pull] ${label}できませんでした: ${explain(last)}`);
  console.error('[backup:pull] サーバーが再デプロイ中かもしれません。数分おいてもう一度お試しください。');
  console.error(`[backup:pull] ブラウザで ${BASE} が開けるかどうかも確認の目安になります。`);
  process.exit(1);
}

async function main() {
  console.log(`[backup:pull] 対象サーバー: ${BASE}`);
  const password = process.env.ADMIN_PASSWORD || await ask(`${ADMIN_NAME} の管理者パスワード: `, { hidden: true });
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
