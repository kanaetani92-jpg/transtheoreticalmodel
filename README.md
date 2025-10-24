# 対話型ストレスマネジメント（TTM）アプリ

就労者向けのTTM（多理論統合モデル）に基づくAIカウンセリング。  
認証/保存: Firebase、モデル: Gemini API、配布: Vercel。

## 機能
- Email/Password ログイン/ログアウト
- セッション作成・切替（1件以上ある場合は履歴ボタン表示）
- 5000字までの入力、残り字数カウント
- Enterで改行、Shift+Enterで送信
- Geminiの回答からMarkdownの**を除去
- すべてのやりとりをFirestoreへ保存

## 環境変数
`.env.local`（ローカル）やVercelのProject Settingsに設定
