# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

利用者は日本語話者です。UI 文字列・サーバーのエラーメッセージ・ドキュメントはすべて日本語で書きます。
コード内のコメントと識別子は英語のままです。ユーザーへの返答は、ユーザーが使っている言語に合わせてください。

## コマンド

```bash
./run.sh                      # :8000 で起動（初回は venv を作成）
./run.sh 9000                 # ポート指定
./tests/run_e2e.sh            # 一時 DB に対して Playwright スイートを一式実行
```

`.venv` は `~/.venvs/whiteboard` へのシンボリックリンクです。プロジェクトは iCloud 同期されたデスクトップ上に
あるため、仮想環境は必ずフォルダの外に置きます（同期対象の venv は Python の import を固まらせる）。
作り直す場合: `VENV_DIR=~/.venvs/whiteboard ./run.sh`。

ビルド工程・バンドラ・Node はありません。`static/` はそのまま配信されるので、JS/CSS の変更はブラウザの
リロードで反映されます。Python の変更はサーバーの再起動が必要です（uvicorn は `--reload` なしで動いています）。

### テスト

`tests/run_e2e.sh` は 2 フェーズを実行します。主スイートの `tests/e2e.py` は、3 つのブラウザコンテキスト
（管理者・メンバー・リンク経由のゲスト）を 1 本の長い共同作業シナリオで動かす Playwright スクリプトです。
第 2 フェーズの `tests/registration_code.py` は `REGISTRATION_CODE` を設定した別プロセスに対して招待コード
ゲートを検証します（環境変数はプロセス起動時に固定されるため、主スイートでは切り替えられない）。
コードを変える場合はスクリプトと `run_e2e.sh` の両方を合わせてください。pytest ではないので個別のテストケースを
選んで実行することはできません。粒度を変えたいときは `main()` の後半セクションをコメントアウトします。
Google Chrome のインストールと venv 内の `playwright`（`uv pip install --python .venv/bin/python playwright`）
が必要です。ランナーは `BOARD_DB` を一時ファイルに向けた uvicorn を :8765 で自前起動するため、
`data/boards.db` には触れません。スクリーンショットは `tests/screenshots/` に出ます。ブラウザコンソールの
未処理エラーが 1 件でもあれば失敗します。

スイートは空のデータベースから始まるので、登録フロー・認証カードのマークアップ・管理画面を変えると、
たいてい `e2e.py` にも対応する修正が必要になります。テストが日本語のボタン文言で要素を探している箇所が
あります（例: `has-text('共有')`）。

### 設定の読み込み

`server/__init__.py` が `server/envfile.py` を呼び、プロジェクト直下の `.env` を `os.environ` に
読み込みます（依存パッケージなし）。**実際の環境変数が常に優先**され、`WB_SKIP_ENV_FILE=1` で無効化
できます。パッケージの `__init__` で行っているのは、`server/db.py` が import 時に `DATABASE_URL` を
読んでバックエンドを決めるためで、どのエントリポイント（uvicorn、スクリプト、テスト）でも順序が保証されます。
`ALLOWED_ORIGINS` も import 時に読まれるので同じ理由が当てはまります。新しい設定を足すときは、
モジュールレベルの定数にするなら `server` パッケージの import 後に評価されることを確認してください。

`tests/run_e2e.sh` は常に `WB_SKIP_ENV_FILE=1` を設定します。テストがユーザーやボードを作って消すため、
本番 PostgreSQL に迷い込ませないための安全策です。明示的に `DATABASE_URL=… ./tests/run_e2e.sh` と
渡したときだけ Postgres を使います。

## アーキテクチャ

サーバーは 3 モジュール、フロントエンドは 2 ファイル。クライアント側にフレームワークはなく、すべて手書きです。

**`server/db.py`** — スキーマと、2 つのバックエンドを 1 つのインターフェースに束ねる薄いアダプタ。
既定は SQLite（`BOARD_DB`、WAL モード）、`DATABASE_URL` が設定されていれば PostgreSQL。SQL はすべて
`?` プレースホルダで一度だけ書き、Postgres 向けには `%s` に書き換えられます。**新しいクエリは両方で動く
移植可能な SQL にしてください** — SQLite 専用や Postgres 専用の構文は禁止です。`conn()` は正常終了時に
コミットするコンテキストマネージャ。アイテムの `props` は JSON 文字列のカラムで、`db.item_row()` が
デコードします。Postgres プールは接続を渡す前に検査し、アイドル 5 分で破棄します（Neon のスケール・ツー・ゼロ対策）。

**`server/auth.py`** — scrypt によるパスワードハッシュ、`wb_session` Cookie に入る不透明なセッショントークン
（30 日）、そして *ゲスト*: アカウントを持たないリンク訪問者で、再起動で消えないよう `guests` テーブルに
`wb_guest` Cookie（7 日）で保存されます。ゲスト行は `boards`（ボード ID → 権限）と `via`（ボード ID →
権限を与えた共有リンクのトークン）を持ち、これがリンク無効化時に「そのリンクから入ったゲストだけ」を
正確に見つけて剥奪できる仕組みです。

**`server/main.py`** — それ以外すべて: REST API、WebSocket ハブ、末尾の SPA キャッチオール
（`/{full_path}` は `api/` と `ws/` 以外に対して `index.html` を返す）。

### 権限モデルが中核の抽象

`board_permission()` は 1 人のアクター（サインイン済みユーザー、ゲスト、またはその両方）と 1 つのボードを
`owner | edit | view | None` に解決します。全体管理者ロール、ボードの所有、有効な `board_members` 行、
`visibility == 'team'` のときのボード全体の既定権限、ゲストのボード別付与のうち **最も高い** ものを取ります。
`PERM_RANK` が順序を定めます。HTTP ルートはすべて `require_board(request, board_id, minimum)` を通り、
WebSocket エンドポイントは接続時に `board_permission()` を直接呼びます。アクセス制御に関わることは個々の
ルートではなく、これらの関数に入れてください。

権限はライブです: メンバー・公開範囲・ロール・共有リンクを変えるハンドラは `HUB.refresh_permissions(board_id)`
を呼び、接続中の全クライアントを再解決して、権限が変わった相手には `perm`、失った相手には `kicked` を送ります。
そのため共有系のハンドラは await できるよう `async` になっています。

### リアルタイム同期

開いているボードごとに WebSocket 1 本、`/ws/boards/{id}`。`HUB.rooms` は ボード ID → 接続 ID → `Client`
のマップです（プロセス内のみ — **サーバープロセスが 1 つ** である前提の設計で、水平スケールには外部の
pub/sub が必要）。ハンドシェイクでは `Origin` ヘッダーを `Host`（または `ALLOWED_ORIGINS`）と照合し、
他サイトからの接続を拒否します。

アイテムのプロトコルは小さな op バッチ: `{a: 'create'|'update'|'delete', item|ids}`。クライアントは
`commit()` で楽観的に処理し — ローカルの `state.items` に適用し、送信し、逆操作を Undo スタックに積む —
サーバーの `apply_ops()` が永続化して正規化した行を再ブロードキャストします。サーバーは送信者を含む
*全員* に配信し、クライアントは `m.conn !== state.myConn` でエコーを無視します。再接続時は `init`
メッセージがローカルのアイテムをサーバーの真実で置き換えるので、オフライン中に落ちたものはここで回復します。
`apply_ops()` は型を `ITEM_TYPES` で検証し、`clean_props()` で props のサイズを上限（200 KB）に抑えます。

Undo/Redo はクライアント単位でブラウザ内にしかありません（`state.undo` / `state.redo`）。共同編集向けでは
なく、Undo は逆操作を通常の編集として再送するので他の全員にも見えます。

カーソルと選択のメッセージは在席情報のみで、永続化されません。

### バージョン履歴

`apply_ops()` は成功したバッチごとに `maybe_auto_snapshot()` を呼び、`AUTO_SNAPSHOT_MINUTES`（既定 10）
ごとに最大 1 回、ボード全体の JSON スナップショットを書き、自動分を `MAX_AUTO_SNAPSHOTS`（既定 40）まで
に刈り込みます（手動分は残す）。復元は全アイテムを置き換え、`{t: 'items', reason: 'restore'}` を
ブロードキャストします。クライアントはこれを完全置換として扱い、Undo スタックも消します。

### フロントエンド

`static/board.js` は `window.BoardEditor(container, opts)` を公開します — キャンバスエディタ全体
（SVG 描画、ツール、選択、Undo、WebSocket）が 1 つの IIFE で、`opts` のコールバック（`onKicked`、
`onDeleted`、`onBoardUpdate`、`onMembers`）で上位と通信します。`static/app.js` はシェル: History API の
ルーティング、認証カード、ダッシュボード、共有ダイアログ、管理画面を持ち、アプリ状態を `S` に保持し、
ナビゲーション時にエディタをマウント/破棄します。後に読み込まれ、`BoardEditor` を呼ぶ唯一のファイルです。

HTML はすべてテンプレートリテラルで組み立てているので、**埋め込む値はすべて `esc()` を通します**。

CSP は `script-src 'self'` です。インラインの `<script>` や `onclick=""` 属性、`eval` は動きません。
`style=""` 属性は許可されています。

## 注意すべき挙動

初回起動時の「管理者を作成」画面は意図的に削除しました — サインインカードは常にログインモードで開き、
登録ボタンがあります。バックエンドは空のデータベースでの最初のアカウントに `admin` を無言で付与します
（`main.py` の `register()`）。初期設定画面を復活させないでください。

自己登録は既定で開放されています。`REGISTRATION_CODE` 環境変数が設定されている場合のみ、`register()` は
一致する `code` フィールドを要求します（UTF-8 バイト列にして `hmac.compare_digest` で比較。日本語の
コードでも動くようにするため)。`app_settings()` はコードの有無だけを `registration_code_required` として
公開し、コード自体はどの API からも返しません。管理画面は状態を読み取り専用で表示するだけで、
`SettingsIn` にコードのフィールドはありません（設定できるのは環境変数だけ）。

パスワードの最小長はサーバー側の `PASSWORD_MIN`（8）が正で、クライアントの `minlength` はヒントに過ぎません。

セキュリティヘッダーは素の ASGI ミドルウェア（`SecurityHeaders`）です。**`BaseHTTPMiddleware` に
書き換えないでください** — レスポンス本文をストリームで包むため、SPA の `index.html` を返す `FileResponse`
が `Response content longer than Content-Length` で落ちます（実際に踏みました）。`http.response.start`
のヘッダーだけを触ること。

レート制限（`throttle()`）はプロセス内メモリなので再起動でリセットされ、単一プロセス前提です。
`/api/health` は既定で DB に触れません（ホストのヘルスチェックが Neon を起こし続けないため）。
`?deep=1` で DB まで確認します。
