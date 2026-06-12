# AI経営会議 / AI Boardroom

複数のAIペルソナが経営課題を議論するWebアプリ（React + TypeScript + Vite、LLMはブラウザからGoogle Gemini APIを直接呼び出し）。

## 開発・起動方法

```bash
npm install
npm run dev
```

ブラウザで Vite が表示するローカルURL（既定 http://localhost:5173）を開く。

## ビルド

```bash
npm run build    # 本番ビルド (dist/)
npm run preview  # ビルド結果のプレビュー
```

## メモ

- Gemini API キーは画面で入力し、ブラウザのメモリ上だけで保持します（サーバ送信なし・localStorage 保存なし）。
