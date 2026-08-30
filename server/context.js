// 共有依存の受け渡し口。
//
// server/index.js が肥大化したのでルート定義を routes/ に分割したが、db や
// publicUser のような「index.js のモジュールスコープにしか無いもの」を
// routes/ から参照できないと切り出せない。かといって routes/ から index.js を
// import すると循環参照になり、ES モジュールのリンク順で undefined を掴む。
//
// そこで向きを一方向に固定する:
//
//   index.js  --(setContext で値を注入)-->  context.js  --(読むだけ)-->  routes/*
//
// routes/ は context.js しか見ないので index.js を import しない = 循環しない。
// 注入は起動時に1回だけ（server.listen の直前）。routes/ 側は
// `installXxxRoutes(router)` の中で ctx を分割代入して束縛を作る ——
// つまり注入が終わったあとにしか読まないので、TDZ も undefined も踏まない。
//
// ⚠ ここに「振る舞い」を書かないこと。あくまで値の受け渡しだけの入れ物で、
//    判断が入った瞬間に index.js と routes/ のどちらを読めばいいのか
//    分からなくなる。
export const ctx = {};

export function setContext(values) {
  Object.assign(ctx, values);
  return ctx;
}
