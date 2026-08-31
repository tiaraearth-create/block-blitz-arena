# 本番(Render)は render.yaml の `runtime: node` で動いており、この Dockerfile は
# 使われていない。他所へ持っていくとき用に置いてある。
#
# ⚠ データの保存先について
# server/db.js は DATA_DIR 環境変数が無いと <server/の場所>/data を使う。
# つまりこのイメージでは /app/server/data になる。コンテナの中なので、
# ボリュームを当てないと**コンテナを作り直すたびにプレイヤーデータが消える**。
# 実際、以前これと同じ理屈（永続ディスクの無いホスト）でデータを失っている。
# 必ず DATA_DIR を明示し、そこにボリュームを当てること。
#
#   docker run -v bba-data:/data -e DATA_DIR=/data -e SESSION_SECRET=... \
#              -e ADMIN_PASSWORD=... -p 3000:3000 block-blitz-arena
#
# SESSION_SECRET を渡さないと、再起動のたびに全員ログアウトする。
FROM node:22-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY . .
ENV NODE_ENV=production
# 既定でもコンテナ内の固定パスを指すようにしておく。ここへボリュームを当てれば
# データが残る。当て忘れてもパスは一定なので、事故に気づきやすい。
ENV DATA_DIR=/data
# 保存先を先に作って node ユーザーの持ち物にしておく。VOLUME より前に作るのが
# 肝心で、ここで作ったディレクトリの所有者が匿名ボリュームの初期状態になる。
# あとから当てる名前付きボリュームも、空なら中身と所有者がここから写される。
RUN mkdir -p /data && chown -R node:node /data
VOLUME ["/data"]
# root のまま動かす理由が無い。node:*-alpine には uid 1000 の node ユーザーが
# 最初から入っているので、追加のパッケージは要らない。
# ※ /app は root 所有のまま（アプリは読むだけ）。書くのは /data だけ。
USER node
EXPOSE 3000
CMD ["node", "server/index.js"]
