// テスト用の空きポートを取る。
//
// 各テストがポートを固定していたせいで、そのポートを別のプロセスが使って
// いると落ちていた。しかも落ち方が悪く、start() は
//   fetch(`http://localhost:3100/api/status`) が通ったら起動成功
// と判断していたので、**他人のサーバーが応答しただけ**でも「起動した」
// ことになり、そのまま無関係なサーバー相手にテストが進んでいた。
// 落ちるならまだしも、緑のまま嘘をつく可能性があった。
//
// OS に 0 番を渡して空きを割り当ててもらい、すぐ閉じて番号だけ使う。
// 閉じてから使うまでの隙間に他人が取る可能性は残るが、固定より桁違いに安全。
import net from 'net';

// テストが「何も出力せずに終了コード1で死ぬ」ことがあった。何が起きたのか
// 分からないので、原因の調べようがない（実際これで時間を溶かした）。
// サーバーを立てるテストはすべてこのファイルを import しているので、
// ここで拾えば全部に効く。
//
// 主な発生源は、try/catch の外にあるトップレベルの await と、
// 誰も待っていない Promise の拒否。どちらも既定では静かに死ぬ。
function shout(kind, err) {
  const at = new Date().toISOString().slice(11, 19);
  console.error('');
  console.error(`❌ テストが異常終了しました（${kind} / ${at}）`);
  console.error(String((err && err.stack) || err));
  console.error('  ※ 他の重い処理と同時に走らせると、起動待ちが間に合わずここに来ることがあります。');
  process.exitCode = 1;
}
process.on('unhandledRejection', err => shout('未処理のPromise拒否', err));
process.on('uncaughtException', err => shout('未捕捉の例外', err));

export function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

// 起動待ちの共通処理。
// ポイントは「応答が返ったら成功」ではなく「**自分が起動した子プロセスが
// 生きていること**も併せて確認する」こと。子が即死しているのに他人の
// サーバーが応答して成功扱いになる、という事故を防ぐ。
export async function waitForServer(proc, base, { tries = 80, everyMs = 250 } = {}) {
  for (let i = 0; i < tries; i++) {
    await new Promise(r => setTimeout(r, everyMs));
    if (proc.exitCode !== null || proc.signalCode !== null) {
      throw new Error(`サーバーが起動直後に終了しました (code=${proc.exitCode} signal=${proc.signalCode})`);
    }
    try {
      const r = await fetch(`${base}/api/status`);
      if (r.ok) return true;
    } catch { /* まだ立ち上がっていない */ }
  }
  throw new Error('サーバーが起動しませんでした');
}
