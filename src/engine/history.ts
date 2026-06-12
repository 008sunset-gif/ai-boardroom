// 議論結果の保存（localStorage）と、コピー用テキスト整形。
// APIキーは絶対に保存しない（履歴は議題・役員・発言・総括・日時のみ）。
// localStorageが使えない環境でも壊れないよう、すべて try-catch で保護する。

import { getRole } from '../agents/roles'
import { STANCE_LABELS, type Statement } from './discuss'

const STORAGE_KEY = 'ai-boardroom:history'
const MAX_ENTRIES = 20

export interface HistoryEntry {
  id: string
  issue: string
  roleIds: string[] // 出席役員（CEOを除く選択分）
  statements: Statement[]
  createdAt: number // epoch ms
}

function genId(): string {
  try {
    if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
      return crypto.randomUUID()
    }
  } catch {
    // fall through
  }
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`
}

/** 履歴を読み込む。壊れている/使えない場合は空配列。 */
export function loadHistory(): HistoryEntry[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? (parsed as HistoryEntry[]) : []
  } catch {
    return []
  }
}

/** 完了した議論を保存し、更新後の一覧を返す。最大20件、古いものから削除。 */
export function saveDiscussion(input: {
  issue: string
  roleIds: string[]
  statements: Statement[]
}): HistoryEntry[] {
  const entry: HistoryEntry = {
    id: genId(),
    issue: input.issue,
    roleIds: input.roleIds,
    statements: input.statements,
    createdAt: Date.now(),
  }
  try {
    const list = [entry, ...loadHistory()].slice(0, MAX_ENTRIES)
    localStorage.setItem(STORAGE_KEY, JSON.stringify(list))
    return list
  } catch {
    // 保存できなくても他機能は動かす。現状の一覧を返す。
    return loadHistory()
  }
}

/** 1件削除し、更新後の一覧を返す。 */
export function removeHistory(id: string): HistoryEntry[] {
  try {
    const list = loadHistory().filter((e) => e.id !== id)
    localStorage.setItem(STORAGE_KEY, JSON.stringify(list))
    return list
  } catch {
    return loadHistory()
  }
}

/** すべて削除する。 */
export function clearHistory(): void {
  try {
    localStorage.removeItem(STORAGE_KEY)
  } catch {
    // 何もできなくても無視
  }
}

/**
 * 議論全文を、コピー用の読みやすいプレーンテキストに整形する。
 */
export function formatDiscussionText(issue: string, statements: Statement[]): string {
  const lines: string[] = []
  lines.push(`議題：${issue}`)

  const openings = statements.filter((s) => s.phase === 'opening')
  if (openings.length > 0) {
    lines.push('', '─ 各役員の初期意見 ─')
    for (const s of openings) {
      const role = getRole(s.roleId)
      const stance = s.stance ? `（${STANCE_LABELS[s.stance]}）` : ''
      lines.push(`${role.name}${stance}：${s.content}`)
    }
  }

  const rebuttals = statements.filter((s) => s.phase === 'rebuttal')
  if (rebuttals.length > 0) {
    lines.push('', '─ 反論 ─')
    for (const s of rebuttals) {
      const role = getRole(s.roleId)
      lines.push(`${role.name}：${s.content}`)
    }
  }

  const counters = statements.filter((s) => s.phase === 'counter')
  if (counters.length > 0) {
    lines.push('', '─ 再反論 ─')
    for (const s of counters) {
      const role = getRole(s.roleId)
      const stance = s.stance ? `（${STANCE_LABELS[s.stance]}）` : ''
      lines.push(`${role.name}${stance}：${s.content}`)
    }
  }

  const summary = statements.find((s) => s.phase === 'summary' && s.summary)?.summary
  if (summary) {
    lines.push('', '─ 議長総括 ─')
    lines.push(`論点：${summary.points}`)
    lines.push(`方向性：${summary.direction}`)
    lines.push(`判断の分かれ目：${summary.conditions}`)
    lines.push(`最大リスク：${summary.risk}`)
    lines.push('足りない情報：')
    for (const m of summary.missingInfo) lines.push(`・${m}`)
  }

  return lines.join('\n')
}
