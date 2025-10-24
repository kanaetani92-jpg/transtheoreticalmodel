import type { NextApiRequest, NextApiResponse } from "next";
import { GoogleGenerativeAI } from "@google/generative-ai";

type Msg = { role: "user" | "assistant"; text: string };

const SYSTEM_PROMPT = `
あなたは職場で働く就労者のためのAIカウンセラー。多理論統合モデル（TTM）に基づき、利用者のストレスマネジメント行動の「変容ステージ」を推定し、ステージ適合の介入を一回の発話で小さく具体的に提案する。
制約と原則:
- 日本語で、敬意ある短文。専門用語は最小限。記号や装飾は使わず、Markdownの**は絶対に使わない。
- 一度に質問は最大1つ。提案は最大3個まで。最初に要約を一行、続けて提案、最後に短い問いかけ。
- 医療的診断や緊急介入はしない。自傷他害や重大リスクを検知したら早めに専門窓口受診や上長/産業保健への相談を案内。
- 仕事文脈へ必ず接続（例: 業務量、人間関係、勤務時間、通勤、睡眠）。
- 500〜800字以内を目安。必要に応じて継続セッションで深める。

TTMの運用規則（簡略）:
1) ステージ推定:
  - 前熟考期: 6か月以内に変える意図なし。行動は未実施。
  - 熟考期: 6か月以内に変えたい気持ちあり。まだ実施していないことが多い。
  - 準備期: 30日以内に始める意図。小さな実践や計画がある。
  - 実行期: 実行開始から6か月未満。
  - 維持期: 6か月以上継続。
2) ステージ適合介入（主目標→具体ステップ例）:
  - 前熟考期: 気づきと価値探索。例: 日常のストレス場面の可視化、メリット/デメリットの棚卸し、身近な成功事例の想起。
  - 熟考期: 両価性の整理と一歩目。例: 言い訳への反論カード、1週間のストレス日記、コントロールできる/できないの区別。
  - 準備期: 小さな開始と障害対策。例: 具体的な行動目標、開始日の予約、実施障害リストと対策、周囲の協力者。
  - 実行期: 環境調整と強化。例: ごほうびリスト、手助けしてくれる人/場所の明確化、後戻りトリガの回避プラン。
  - 維持期: 予期と再発予防。例: 今後起こりそうな出来事の想定、スリップ後のリカバリ手順、代替行動のバリエーション。
3) 共通技法:
  - 意思決定バランス、自信（自己効力感）の強化、体験的/行動的プロセスの活用、習慣化と環境設計、社会的支援。
4) 出力形式（厳守）:
  1行要約
  ・提案1
  ・提案2
  ・提案3（必要なら）
  質問（1つ）

禁止: 太字、過度な専門用語、長い段落、過度な共感の連発。
`;

function sanitize(text: string): string {
  // Geminiの出力からMarkdown太字を除去
  return (text || "").replace(/\*\*/g, "");
}

function clampInput(messages: Msg[]): Msg[] {
  // 念のためサーバでも長さを制限
  return messages.map(m => ({
    ...m,
    text: (m.text || "").slice(0, 5000)
  }));
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return res.status(500).json({ error: "GEMINI_API_KEY is not set" });

  try {
    const { messages } = req.body as { messages: Msg[] };
    const msgs = clampInput(messages || []);
    const genAI = new GoogleGenerativeAI(apiKey);
    const model = genAI.getGenerativeModel({
      model: "gemini-1.5-pro",
      systemInstruction: SYSTEM_PROMPT
    });

    // Gemini Node SDKのcontents形式へ変換
    const contents = msgs.map(m => ({
      role: m.role === "assistant" ? "model" : "user",
      parts: [{ text: m.text }]
    }));

    const result = await model.generateContent({ contents });
    const response = result?.response;

    const raw = safelyExtractText(response);
    const reply = sanitize(raw).trim();

    if (!reply) {
      throw new Error("empty_reply");
    }

    return res.status(200).json({ reply });
  } catch (e: any) {
    console.error(e);
    return res.status(500).json({ error: "generation_failed", detail: String(e?.message || e) });
  }
}

function safelyExtractText(response: any): string {
  if (!response) return "";
  try {
    if (typeof response.text === "function") {
      return response.text();
    }
  } catch (err) {
    console.error("failed_to_read_text", err);
  }
  return extractTextFromCandidates(response?.candidates);
}

function extractTextFromCandidates(candidates: any[] | undefined): string {
  if (!candidates || candidates.length === 0) return "";
  try {
    return candidates
      .flatMap((candidate) => candidate?.content?.parts ?? [])
      .map((part: any) => (typeof part?.text === "string" ? part.text : ""))
      .filter(Boolean)
      .join("\n");
  } catch (err) {
    console.error("failed_to_extract_text", err);
    return "";
  }
}
