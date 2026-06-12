// 議論エンジン（一般化版）。
// ユーザーが選んだ任意の人数（2〜6名）の役員＋議長CEOで議論を回す。
//   フェーズ1: 選ばれた全役職が初期意見を「並列」で生成（Promise.all）
//   フェーズ2: 各役職が「他の全員」の初期意見を読み、反論を1回ずつ「並列」で生成
//   フェーズ3: CEOが全体を読み、論点・結論方向・最大リスク・足りない情報を構造化して総括
//
// 発言は生成され次第 onStatement で通知し、UIが時系列で逐次表示できるようにする。
// どの役職が生成中かは onProgress で通知する。
//
// suggestRoles: 議題から、議論に必要な役員をGeminiに選ばせる（自動選択ボタン用）。

import { SchemaType, type ResponseSchema } from '@google/generative-ai'
import { CHAIR, getRole, SELECTABLE_ROLES, type Role } from '../agents/roles'
import { generate, generateJson } from './gemini'

// レート制限(429)対策: 各フェーズ内のリクエストを全員同時に投げず、
// 少数(MAX_CONCURRENT)ずつのバッチに分け、バッチ間に短いディレイを入れる。
// 凝った並列制御は使わず、自前の小さなヘルパーで実現する。
const MAX_CONCURRENT = 2
const BATCH_DELAY_MS = 400
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

async function mapInBatches<T, R>(
  items: T[],
  batchSize: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = []
  for (let i = 0; i < items.length; i += batchSize) {
    const batch = items.slice(i, i + batchSize)
    // バッチ内のいずれかが失敗すれば、ここで例外が伝播し以降のバッチは実行されない。
    const part = await Promise.all(batch.map((item, j) => fn(item, i + j)))
    results.push(...part)
    if (i + batchSize < items.length) await sleep(BATCH_DELAY_MS)
  }
  return results
}

export type Phase = 'opening' | 'rebuttal' | 'counter' | 'summary'

export const PHASE_LABELS: Record<Phase, string> = {
  opening: '初期意見',
  rebuttal: '反論',
  counter: '再反論',
  summary: '総括',
}

// 初期意見での立場。UIでバッジ表示する。
export type Stance = 'agree' | 'disagree' | 'conditional'

export const STANCE_LABELS: Record<Stance, string> = {
  agree: '賛成',
  disagree: '反対',
  conditional: '条件付き賛成',
}

// 初期意見の冒頭から立場を推定する。プロンプトで冒頭に立場を明示させているため、
// 先頭付近のキーワードで判定する（「条件付き」を先に見る点に注意）。
function detectStance(text: string): Stance | undefined {
  const head = text.slice(0, 60)
  if (head.includes('条件付き')) return 'conditional'
  if (head.includes('反対')) return 'disagree'
  if (head.includes('賛成')) return 'agree'
  return undefined
}

// CEOの総括を項目ごとに分けた構造化データ。UI側でラベル付きカードとして表示する。
export interface CeoSummary {
  points: string // 主要な論点（対立点）
  direction: string // 結論の方向性（決定ではない）
  conditions: string // 判断の分かれ目（どんな条件なら進め、どんな条件なら見送るか）
  risk: string // 最大のリスク
  missingInfo: string[] // 判断に足りない情報（最大3点）
}

export interface Statement {
  id: string
  roleId: string
  phase: Phase
  content: string // 通常発言の本文。summaryのときは空。
  summary?: CeoSummary // phase === 'summary' のときのみ入る。
  stance?: Stance // phase === 'opening' のときのみ入る。
}

export interface Progress {
  phase: Phase
  activeRoleIds: string[] // 今まさに生成中の役職
  retrying?: boolean // 429で自動リトライ待機中か
}

// 事前ヒアリング（確認質問）への回答。answerが空のものは文脈に含めない。
export interface ClarifyAnswer {
  question: string
  answer: string
}

export interface DiscussParams {
  apiKey: string
  issue: string
  roleIds: string[] // 選択された役職ID（CEOを除く、2名以上）
  context?: ClarifyAnswer[] // 事前ヒアリングの回答（任意）
  onStatement?: (statement: Statement) => void
  onProgress?: (progress: Progress) => void
}

let counter = 0
function makeStatement(
  role: Role,
  phase: Phase,
  content: string,
  extra?: { summary?: CeoSummary; stance?: Stance },
): Statement {
  counter += 1
  return { id: `s${counter}`, roleId: role.id, phase, content, ...extra }
}

// ---- 各フェーズの指示プロンプト ----

// 事前ヒアリングの回答を「会社の前提情報」ブロックに整形する。
// 回答済み（answerが非空）のものだけを含める。何も無ければ空文字。
function formatContext(context?: ClarifyAnswer[]): string {
  const answered = (context ?? []).filter((c) => c.answer.trim() !== '')
  if (answered.length === 0) return ''
  const lines = answered.map((c) => `・${c.question} → ${c.answer.trim()}`).join('\n')
  return [
    '【今回の会社の前提情報】',
    lines,
    '上記はこの会社の実際の状況です。発言の中で、この前提情報の具体的な数値や事実に必ず言及し、それを根拠に論じてください。前提情報を無視した一般論は避けること。',
    '',
    '',
  ].join('\n')
}

function openingPrompt(issue: string): string {
  return [
    '次の経営課題について、あなたの立場（賛成 / 反対 / 条件付き賛成 のいずれか）を最初に明示し、',
    'その理由を、あなたの専門観点から2〜3点述べてください。',
    '200字程度で、要点を絞って簡潔に。冗長な前置きや一般論の繰り返しは避けること。',
    '立場とその核心的な理由が端的に伝わることを最優先にしてください。',
    '',
    '【経営課題】',
    issue,
  ].join('\n')
}

function rebuttalPrompt(
  self: Role,
  selfOpening: string,
  others: { role: Role; opening: string }[],
): string {
  const othersBlock = others
    .map((o) => `■ ${o.role.title}の意見:\n${o.opening}`)
    .join('\n\n')

  return [
    `あなた（${self.title}）は先ほど、次の初期意見を述べました。`,
    '---',
    selfOpening,
    '---',
    '',
    'これに対し、他の役員は次のように主張しています。',
    '---',
    othersBlock,
    '---',
    '',
    '他の役員の主張に「反論」してください。次を必ず守ること:',
    '・全員に総花的に触れる必要はない。最も意見が食い違う相手の主張に、具体的に切り込む。',
    '・誰のどの主張に反論しているのかが分かるように、相手の役職名に触れながら述べる。',
    '・安易に同意せず、少なくとも1つは具体的な反論点（前提の甘さ・見落とし・リスクや機会損失）を挙げる。',
    '200字程度で、要点を絞って簡潔に。冗長な前置きや一般論の繰り返しは避けること。',
  ].join('\n')
}

// フェーズ3（再反論）。各役員が、自分への反論や他者の反論を読んだうえで、
// 立場を維持するか修正するかを明示して、もう一度述べる。議論を噛み合わせるための一巡。
function counterPrompt(
  self: Role,
  selfOpening: string,
  othersRebuttals: { role: Role; rebuttal: string }[],
): string {
  const othersBlock = othersRebuttals
    .map((o) => `■ ${o.role.title}の反論:\n${o.rebuttal}`)
    .join('\n\n')

  return [
    `あなた（${self.title}）は最初に、次の初期意見を述べました。`,
    '---',
    selfOpening,
    '---',
    '',
    'これに対し、他の役員は次のように反論しています。',
    '---',
    othersBlock,
    '---',
    '',
    'これらの反論を踏まえ、改めてあなたの考えを述べてください。次を必ず守ること:',
    '・冒頭で、最終的なあなたの立場（賛成 / 反対 / 条件付き賛成 のいずれか）を明示する。最初の立場を維持するのか、修正するのかが分かるようにする。',
    '・相手の反論のどこに同意し、どこには引き続き反対するのかを、具体的に述べる。',
    '・反論によって考えが変わったなら、その理由を率直に述べる。変わらないなら、その根拠を補強する。',
    '200字程度で、要点を絞って簡潔に。冗長な前置きや一般論の繰り返しは避けること。',
  ].join('\n')
}

function summaryPrompt(issue: string, transcript: string): string {
  return [
    '以下は、ある経営課題に対する役員たちの議論の記録です。',
    '',
    '【経営課題】',
    issue,
    '',
    '【議論の記録】',
    transcript,
    '',
    'あなたは議長です。最終決定は人間が行うため、あなたは決定を下しません。',
    '議論を踏まえ、次の5項目を「要点のみ」簡潔にまとめてください。冗長な説明は避けること。',
    '・points: 主要な論点（役員間の対立点はどこか）。2〜3文程度。',
    '・direction: 結論の方向性（決定ではなく検討の方向性として）。2〜3文程度。',
    '・conditions: 判断の分かれ目。どういう条件が満たされるなら進めるべきで、どういう条件なら見送る・慎重になるべきか、判断の境目を簡潔に示す。1〜2文程度。',
    '・risk: 最大のリスク。1〜2文程度。',
    '・missingInfo: 判断に足りない情報。最大3点まで、各項目は短く。',
  ].join('\n')
}

const SUMMARY_SCHEMA: ResponseSchema = {
  type: SchemaType.OBJECT,
  properties: {
    points: { type: SchemaType.STRING, description: '主要な論点・対立点' },
    direction: { type: SchemaType.STRING, description: '結論の方向性（決定ではない）' },
    conditions: {
      type: SchemaType.STRING,
      description: '判断の分かれ目（どんな条件なら進め、どんな条件なら見送るか）',
    },
    risk: { type: SchemaType.STRING, description: '最大のリスク' },
    missingInfo: {
      type: SchemaType.ARRAY,
      description: '判断に足りない情報（最大3点）',
      items: { type: SchemaType.STRING },
    },
  },
  required: ['points', 'direction', 'conditions', 'risk', 'missingInfo'],
}

function formatTranscript(statements: Statement[]): string {
  return statements
    .map((s) => {
      const role = getRole(s.roleId)
      return `[${role.title}・${PHASE_LABELS[s.phase]}]\n${s.content}`
    })
    .join('\n\n')
}

/**
 * 議論を実行し、全発言を発言順の配列で返す。
 * 途中の発言は onStatement、生成中の役職は onProgress で逐次通知する。
 */
export async function runDiscussion({
  apiKey,
  issue,
  roleIds,
  context,
  onStatement,
  onProgress,
}: DiscussParams): Promise<Statement[]> {
  if (!issue.trim()) {
    throw new Error('経営課題が入力されていません。')
  }
  if (roleIds.length < 2) {
    throw new Error('議論には議長以外に2名以上の役員を選んでください。')
  }

  // 選択された役職（CEOは除外しておく。総括役として最後に別途参加する）。
  const members = roleIds.filter((id) => id !== CHAIR.id).map(getRole)

  // 事前ヒアリングの回答を前提情報ブロックに整形（空ならフォールバックで一般論）。
  const ctx = formatContext(context)

  const statements: Statement[] = []
  const emit = (s: Statement) => {
    statements.push(s)
    onStatement?.(s)
  }

  const memberIds = members.map((m) => m.id)
  const emitProgress = (phase: Phase, activeRoleIds: string[], retrying = false) =>
    onProgress?.({ phase, activeRoleIds, retrying })

  // --- フェーズ1: 全員が初期意見を生成（少数ずつ・429回避。429時は自動リトライ） ---
  emitProgress('opening', memberIds)
  const openingTexts = await mapInBatches(members, MAX_CONCURRENT, (m) =>
    generate(apiKey, m.systemPrompt, ctx + openingPrompt(issue), {
      onRetry: () => emitProgress('opening', memberIds, true),
    }),
  )
  const openings = members.map((m, i) =>
    makeStatement(m, 'opening', openingTexts[i], { stance: detectStance(openingTexts[i]) }),
  )
  openings.forEach(emit)

  // --- フェーズ2: 各自が他の全員の初期意見を読んで反論を生成（少数ずつ・429回避。429時は自動リトライ） ---
  emitProgress('rebuttal', memberIds)
  const rebuttalTexts = await mapInBatches(members, MAX_CONCURRENT, (m, i) => {
    const others = members
      .map((other, j) => ({ role: other, opening: openings[j].content }))
      .filter((_, j) => j !== i)
    return generate(apiKey, m.systemPrompt, ctx + rebuttalPrompt(m, openings[i].content, others), {
      onRetry: () => emitProgress('rebuttal', memberIds, true),
    })
  })
  members.forEach((m, i) => emit(makeStatement(m, 'rebuttal', rebuttalTexts[i])))

  // --- フェーズ3: 各自が「自分への反論・他者の反論」を読み、立場を維持/修正して再反論（少数ずつ・429回避） ---
  emitProgress('counter', memberIds)
  const counterTexts = await mapInBatches(members, MAX_CONCURRENT, (m, i) => {
    const othersRebuttals = members
      .map((other, j) => ({ role: other, rebuttal: rebuttalTexts[j] }))
      .filter((_, j) => j !== i)
    return generate(apiKey, m.systemPrompt, ctx + counterPrompt(m, openings[i].content, othersRebuttals), {
      onRetry: () => emitProgress('counter', memberIds, true),
    })
  })
  // 再反論でも、冒頭に最終的な立場を明示させているので立場を推定して持たせる（立場分布の集計に使う）。
  members.forEach((m, i) =>
    emit(makeStatement(m, 'counter', counterTexts[i], { stance: detectStance(counterTexts[i]) })),
  )

  // --- フェーズ4: CEOが全体を構造化して総括（429時は自動リトライ） ---
  emitProgress('summary', [CHAIR.id])
  const summary = await generateJson<CeoSummary>(
    apiKey,
    CHAIR.systemPrompt,
    ctx + summaryPrompt(issue, formatTranscript(statements)),
    SUMMARY_SCHEMA,
    { onRetry: () => emitProgress('summary', [CHAIR.id], true) },
  )
  // 念のため、足りない情報は最大3点に丸める。
  summary.missingInfo = (summary.missingInfo ?? []).slice(0, 3)
  emit(makeStatement(CHAIR, 'summary', '', { summary }))

  return statements
}

// ---- 事前ヒアリング（確認質問の動的生成） ----

const QUESTIONS_SCHEMA: ResponseSchema = {
  type: SchemaType.ARRAY,
  description: '経営者に確認すべき質問文の配列（3〜4個）',
  items: { type: SchemaType.STRING },
}

/**
 * 議題を判断するために経営者へ確認すべき重要な情報を、3〜4個の質問文で返す。
 * 議題に応じて動的に変わる、判断を左右する具体的な事実を聞く質問。
 */
export async function generateClarifyingQuestions(
  apiKey: string,
  issue: string,
): Promise<string[]> {
  if (!issue.trim()) {
    throw new Error('議題が入力されていません。')
  }

  const system =
    'あなたは経営会議の事務局です。意思決定の前に、判断に必要な事実を経営者に確認します。'
  const prompt = [
    'これから経営者に、判断に必要な情報を確認する質問を作成します。',
    'まず、次の経営課題がどのタイプかを内心で見極めてください（投資判断 / 事業撤退・継続 / 価格設定 / 採用・人員 / 新規参入 / その他）。',
    'そのうえで、そのタイプの判断を左右する確認質問を3〜4個作ってください。',
    '',
    '重要な前提: これらの質問への回答は、この後に行われる役員たちの議論の「前提情報」として使われます。',
    'だから、回答があれば議論が一般論ではなく具体的になる、判断を直接左右する質問を選んでください。',
    '',
    '質問の作り方:',
    '・できるだけ定量的に答えられる質問（金額・率・期間・人数など、数字で答えられるもの）を優先する。',
    '・定性的で曖昧な質問（強み・ニーズ・市場の様子など、数字で答えられないもの）は避ける。',
    '・経営者が「分かる範囲で」答えるものなので、答えやすい平易な日本語にする。',
    '・各質問は簡潔な一文。マークダウン記号や番号は付けない。',
    '・3〜4個に絞る。',
    '',
    '良い質問の例（具体的・定量的）:',
    '・その事業の月間赤字額はいくらですか',
    '・競合と比べた価格差は何％ですか',
    '・値上げ対象商品の粗利率は何％ですか',
    '・採用を検討している人数と想定年収はいくらですか',
    '',
    '悪い質問の例（曖昧・数字で答えられない。こうした質問は出さない）:',
    '・御社の戦略は何ですか',
    '・顧客はどう思っていますか',
    '・市場はどうですか',
    '',
    '【経営課題】',
    issue,
  ].join('\n')

  const questions = await generateJson<string[]>(apiKey, system, prompt, QUESTIONS_SCHEMA)
  // 文字列・非空のみに整え、最大4個に絞る。
  return (Array.isArray(questions) ? questions : [])
    .map((q) => (typeof q === 'string' ? q.trim() : ''))
    .filter((q) => q !== '')
    .slice(0, 4)
}

// ---- 自動選択（議題から必要な役員を選ぶ） ----

const ROLE_SUGGEST_SCHEMA: ResponseSchema = {
  type: SchemaType.ARRAY,
  description: '議論に招集すべき役職IDの配列（CEOは含めない）',
  items: { type: SchemaType.STRING },
}

/**
 * 議題から、議論に特に必要な役員を3〜4名選び、役職IDの配列で返す。
 * CEO（議長）は自動参加のため含めない。返り値は実在IDのみに検証済み。
 */
export async function suggestRoles({
  apiKey,
  issue,
}: {
  apiKey: string
  issue: string
}): Promise<string[]> {
  if (!issue.trim()) {
    throw new Error('議題が入力されていません。')
  }

  const catalog = SELECTABLE_ROLES.map(
    (r) => `${r.id} = ${r.title}（専門: ${r.profile.specialty} / スタンス: ${r.profile.stance}）`,
  ).join('\n')

  const system = 'あなたは経営会議の事務局です。経営課題に対し、議論に特に必要な役員を選定します。'
  const prompt = [
    '次の経営課題の検討に特に必要な役員を3〜4名選び、その役職IDだけをJSON配列で返してください。',
    '・必ず下のリストにあるIDのみを使う。',
    '・議長(CEO)は自動で参加するので含めない。',
    '・対立や多角的な検討が生まれるよう、観点の異なる役員を選ぶ。',
    '',
    '【選べる役員】',
    catalog,
    '',
    '【経営課題】',
    issue,
  ].join('\n')

  const ids = await generateJson<string[]>(apiKey, system, prompt, ROLE_SUGGEST_SCHEMA)

  // 実在するIDのみ・重複排除・最大4名に整える。
  const valid = [...new Set(Array.isArray(ids) ? ids : [])].filter((id) =>
    SELECTABLE_ROLES.some((r) => r.id === id),
  )
  // 万一2名未満しか返らなければ、無難な既定（CFO+CMO）にフォールバック。
  if (valid.length < 2) return ['cfo', 'cmo']
  return valid.slice(0, 4)
}
