// Gemini API をブラウザから直接呼び出す薄いラッパ。
// APIキーは呼び出し側（Reactのstate）から都度渡す。ここでは保持しない。
//
// 429（レート制限）に限り、指数バックオフで自動リトライして完走を狙う。
// それ以外のエラー（401/403/ネットワーク/その他）はリトライせず即整形して投げる。
import {
  GoogleGenerativeAI,
  type GenerativeModel,
  type GenerateContentResult,
  type ResponseSchema,
} from '@google/generative-ai'

// 議論エンジンが使うモデル。要件により固定。
export const MODEL_ID = 'gemini-2.5-flash-lite'

// リトライ待機に入ったことを呼び出し側へ通知するためのオプション。
export interface GenerateOptions {
  onRetry?: (info: { attempt: number; waitMs: number }) => void
}

const MAX_RETRIES = 4
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

/**
 * 1回のテキスト生成を行う（429は自動リトライ）。
 */
export async function generate(
  apiKey: string,
  systemPrompt: string,
  userPrompt: string,
  opts?: GenerateOptions,
): Promise<string> {
  if (!apiKey.trim()) {
    throw new Error('APIキーが入力されていません。')
  }

  const genAI = new GoogleGenerativeAI(apiKey)
  const model = genAI.getGenerativeModel({
    model: MODEL_ID,
    systemInstruction: systemPrompt,
  })

  const result = await callWithRetry(model, userPrompt, opts?.onRetry)
  const text = result.response.text()
  if (!text.trim()) {
    throw new Error('議論の生成中にエラーが発生しました。もう一度お試しください。')
  }
  return text.trim()
}

/**
 * 構造化（JSON）出力を生成する（429は自動リトライ）。
 */
export async function generateJson<T>(
  apiKey: string,
  systemPrompt: string,
  userPrompt: string,
  responseSchema: ResponseSchema,
  opts?: GenerateOptions,
): Promise<T> {
  if (!apiKey.trim()) {
    throw new Error('APIキーが入力されていません。')
  }

  const genAI = new GoogleGenerativeAI(apiKey)
  const model = genAI.getGenerativeModel({
    model: MODEL_ID,
    systemInstruction: systemPrompt,
    generationConfig: {
      responseMimeType: 'application/json',
      responseSchema,
    },
  })

  const result = await callWithRetry(model, userPrompt, opts?.onRetry)
  const text = result.response.text()

  try {
    return JSON.parse(text) as T
  } catch (err) {
    // パース失敗は内容の問題。生データはconsoleにのみ残す。
    console.error('[Gemini] JSON parse failed. raw text:', text, err)
    throw new Error('議論の生成中にエラーが発生しました。もう一度お試しください。')
  }
}

// ---- リトライ（429のみ・指数バックオフ） ----

async function callWithRetry(
  model: GenerativeModel,
  userPrompt: string,
  onRetry?: GenerateOptions['onRetry'],
): Promise<GenerateContentResult> {
  let retries = 0
  // 成功するか、429以外/上限到達で整形エラーを投げるまでループ。
  for (;;) {
    try {
      return await model.generateContent(userPrompt)
    } catch (err) {
      // 429以外は即整形して投げる（リトライしない）。
      if (!isRateLimit(err)) {
        throw classifyError(err)
      }
      // 上限まで使い切ったら、整形済みの「利用上限」メッセージを投げる。
      if (retries >= MAX_RETRIES) {
        throw classifyError(err)
      }
      retries += 1
      // サーバが retryDelay（例「7s」）を返していれば優先。なければ指数バックオフ。
      const waitMs = parseRetryDelayMs(err) ?? backoffMs(retries)
      console.log(
        `[Gemini] 429 rate limited. retry ${retries}/${MAX_RETRIES} after ${waitMs}ms`,
      )
      onRetry?.({ attempt: retries, waitMs })
      await sleep(waitMs)
    }
  }
}

// 指数バックオフ + ジッター。retries: 1→約2秒, 2→約4秒, 3→約8秒, 4→約16秒。
function backoffMs(retries: number): number {
  const base = Math.pow(2, retries) * 1000
  const jitter = Math.floor(Math.random() * 600)
  return base + jitter
}

// Geminiのエラー文に含まれる retryDelay（例: "retryDelay":"7s"）を ms に変換。
function parseRetryDelayMs(err: unknown): number | undefined {
  const raw = err instanceof Error ? err.message : String(err)
  const m = raw.match(/retryDelay"?\s*[:=]\s*"?(\d+(?:\.\d+)?)\s*s/i)
  if (m) return Math.ceil(parseFloat(m[1]) * 1000)
  return undefined
}

function isRateLimit(err: unknown): boolean {
  const status = getStatus(err)
  const raw = err instanceof Error ? err.message : String(err)
  return status === 429 || /\b429\b|RESOURCE_EXHAUSTED|rate limit|quota/i.test(raw)
}

// ---- エラー整形 ----
// APIの生レスポンス（URL・JSON・スタックトレース）は画面に出さず、
// console.error にのみ残す。ユーザーには簡潔な日本語メッセージを返す。

function classifyError(err: unknown): Error {
  // 生のエラーは開発者向けにコンソールへ。
  console.error('[Gemini] request failed:', err)

  const status = getStatus(err)
  const raw = err instanceof Error ? err.message : String(err)

  // 429: レート制限 / quota 超過
  if (isRateLimit(err)) {
    return new Error(
      '1分あたりの利用上限に達しました。少し時間をおいてから、もう一度お試しください。',
    )
  }

  // 401 / 403 / APIキー不正
  if (
    status === 401 ||
    status === 403 ||
    /\b401\b|\b403\b|API key not valid|API_KEY_INVALID|PERMISSION_DENIED/i.test(raw)
  ) {
    return new Error('APIキーが正しくないか、権限がありません。キーをご確認ください。')
  }

  // ネットワークエラー
  if (isNetworkError(err, raw)) {
    return new Error('通信に失敗しました。接続を確認して再度お試しください。')
  }

  // その他
  return new Error('議論の生成中にエラーが発生しました。もう一度お試しください。')
}

// SDKの GoogleGenerativeAIFetchError などが持つ HTTP ステータスを取り出す。
function getStatus(err: unknown): number | undefined {
  if (err && typeof err === 'object' && 'status' in err) {
    const s = (err as { status?: unknown }).status
    if (typeof s === 'number') return s
  }
  return undefined
}

function isNetworkError(err: unknown, raw: string): boolean {
  if (err instanceof TypeError) return true // fetch失敗は多くがTypeError
  return /failed to fetch|networkerror|fetch failed|ENOTFOUND|ECONNREFUSED|ETIMEDOUT|network/i.test(
    raw,
  )
}
