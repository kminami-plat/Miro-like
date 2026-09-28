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

`tests/run_e2e.sh` は 4 フェーズを実行します。まず単体テスト `tests/plat_tasks_test.py`（タスクストア）と
`tests/archive_test.py`（営業日カレンダーと記録。unittest）。主スイートの `tests/e2e.py` は、3 つのブラウザコンテキスト
（管理者・メンバー・リンク経由のゲスト）を 1 本の長い共同作業シナリオで動かす Playwright スクリプトです。
第 2 フェーズの `tests/registration_code.py` は `REGISTRATION_CODE` を設定した別プロセスに対して招待コード
ゲートを検証します（環境変数はプロセス起動時に固定されるため、主スイートでは切り替えられない）。
最後の `tests/tasks_grid.py` は `tests/fake_kv.py`（plat-kv Worker の代役）と
`tests/fixtures/plat/` の名簿を使って、既定モード（`LEGACY_BOARDS` なし）の今日のボードとアーカイブを検証します — **本物の Worker には決して向けないこと**。
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

サーバーは `server/` の数モジュール、フロントエンドは `static/` の数ファイル。クライアント側にフレームワークはなく、すべて手書きです。

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

### 今日のボードとアーカイブ（既定の画面）

既定ではアプリは **1 枚の固定グリッドのボード** です: サインイン → `/`（今日のボード）→ `/archive`
（営業日カレンダー）→ `/archive/YYYY-MM-DD`（その日の凍結された閲覧専用ボード）。従来のダッシュボード・
ボード作成・キャンバス（`board.js`、`/b/`、`/s/`）はコードを残したまま **`LEGACY_BOARDS=1` のときだけ**
有効です（オフ時は `create_board` / `import_board` / `duplicate_board` が 403、`/b/` `/s/` は `/` へ）。
e2e の第 1・2 フェーズはキャンバスを検証するので `LEGACY_BOARDS=1` で動かしています。

`server/archive.py` が日本の営業日（土日・国民の祝日・振替休日・国民の休日・`ARCHIVE_EXTRA_HOLIDAYS`）を
計算し、締め時刻（`ARCHIVE_CUTOFF`、既定 24:00 JST）を過ぎた直近の営業日を `board_archives` に 1 行だけ
記録します（`ARCHIVE_DAYS`、既定 31 日で削除）。記録のきっかけは 3 つで、どれも冪等な `ensure_captured()`
を呼ぶだけです: サーバー内の 1 分ごとのループ（`ARCHIVE_AUTO=0` で停止）、**このアプリからの書き込みの直前**
（締め後の自分の編集が前日の記録に混ざらない）、外部 cron 用の `POST /api/archive/run`
（`X-Archive-Secret: $ARCHIVE_CRON_SECRET`、または管理者）。記録は `board_snapshot()` の JSON（タスク・日程・
行・参照リスト）で、画面は同じ `TaskGrid` を `PlatTaskStore.frozen()` で描き、期限切れはその日付で判定します。
遅れて記録された場合は `late` が立ち、画面に明示されます。

行（社員）は people.json に加えて、管理者が「行を編集」で設定する `settings.plat_roster`
（ID・表示名・役職・非表示、並び順）で決まります（`board_meta()`）。非表示の行も付箋があるうちは表示します。

### タスクグリッド（plat-todo 連携）

ボードは社内タスクハブ（pm.plat-yonezawa.com/plat-todo/）と同じ Cloudflare Worker + KV（plat-kv）を
読み書きする第 2 クライアントです。Worker を呼ぶのはサーバー（`server/plat_tasks.py`）なので CORS は
関係せず、書き込みトークン `PLAT_KV_TOKEN` はブラウザに出ません。**PUT は値全体の置き換え**で既存ページも
同時に書くため、書き込みは必ず `TaskStore.apply()` 経由の read-merge-write（最新を GET → ID 一致で
変更フィールドだけ適用 → PUT）にします。`suggestions`・未知のキー・未知のタスクフィールドは必ず
そのまま残すこと。キーは `PLAT_TASKS_KEY`（既定はサンドボックス `plat-todo-tasks-sandbox`）。
ブラウザ側のキュー/デバウンス/再試行は `static/plat_store.js`、画面は `static/tasks.js`
（`window.TaskGrid`、`app.js` が `S.editor` としてマウント）。付箋 1 枚 = タスク 1 件で、付箋の文字は
`title`（1 行）です。空の付箋は保存しません。業務ルール（open/overdue/heavy、done_at）は
Python と JS の両方にあるので、変えるときは両方を合わせます。people.json などは Cloudflare Access の
内側にあり、サービストークンかローカルコピー（`data/plat/`）がなければタスクの担当者 ID から行を作ります。
詳細は `docs/plat-tasks/`。

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
