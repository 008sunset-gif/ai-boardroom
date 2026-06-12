import { useEffect, useMemo, useRef, useState } from 'react'
import { CHAIR, getRole, SELECTABLE_ROLES, type Role } from './agents/roles'
import {
  generateClarifyingQuestions,
  runDiscussion,
  STANCE_LABELS,
  suggestRoles,
  type ClarifyAnswer,
  type Phase,
  type Progress,
  type Statement,
} from './engine/discuss'

// 課題入力欄に挿入する例文。
const EXAMPLE_ISSUES = [
  '主力商品を20%値上げすべきか',
  '赤字の新規事業を撤退すべきか',
  '正社員か業務委託か',
]

// 表示するフェーズの順序（＝会議のアジェンダ進行順）。
const PHASE_ORDER: Phase[] = ['opening', 'rebuttal', 'counter', 'summary']

// 議論画面の議事タイトル。
const AGENDA_TITLES: Record<Phase, string> = {
  opening: '各役員の初期意見',
  rebuttal: '反論',
  counter: '再反論',
  summary: '議長総括',
}

// 履歴の日時表示（例: 6/12 14:30）。
function formatHistoryDate(ts: number): string {
  try {
    return new Date(ts).toLocaleString('ja-JP', {
      month: 'numeric',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    })
  } catch {
    return ''
  }
}

// ---- 小さなインラインアイコン ----
function MeetingIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M3 21h18" />
      <path d="M12 3l8 5H4l8-5z" />
      <path d="M5 10v8M9 10v8M15 10v8M19 10v8" />
    </svg>
  )
}

function SparkleIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M12 2l1.7 5.6L19.5 9l-5.8 1.4L12 16l-1.7-5.6L4.5 9l5.8-1.4L12 2z" />
    </svg>
  )
}

function CheckIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#fff"
      strokeWidth="3.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M20 6L9 17l-5-5" />
    </svg>
  )
}

function App() {
  const [view, setView] = useState<'input' | 'discussion'>('input')
  // APIキーはこのstate（ブラウザのメモリ上）のみで保持。localStorageには保存しない。
  const [apiKey, setApiKey] = useState('')
  const [issue, setIssue] = useState('')
  // 招集する役員（CEO=議長は常に固定参加なので含めない）。初期はCFO+CMO。
  const [selectedIds, setSelectedIds] = useState<string[]>(['cfo', 'cmo'])
  const [statements, setStatements] = useState<Statement[]>([])
  const [progress, setProgress] = useState<Progress | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // 役員紹介ポップアップの対象（nullなら閉じている）。
  const [profileRole, setProfileRole] = useState<Role | null>(null)
  // 自動選択の状態。
  const [autoLoading, setAutoLoading] = useState(false)
  const [autoError, setAutoError] = useState<string | null>(null)
  // 事前ヒアリング（確認質問とその回答）の状態。
  const [questions, setQuestions] = useState<string[]>([])
  const [answers, setAnswers] = useState<string[]>([])
  const [prepLoading, setPrepLoading] = useState(false)
  const [prepError, setPrepError] = useState<string | null>(null)
  // APIキー欄へフォーカス/スクロールするためのref。
  const apiKeyRef = useRef<HTMLInputElement>(null)

  function focusApiKey() {
    apiKeyRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' })
    apiKeyRef.current?.focus()
  }

  const canStart =
    apiKey.trim() !== '' && issue.trim() !== '' && selectedIds.length >= 2 && !loading
  const attendeeCount = selectedIds.length + 1 // ＋議長CEO

  // 議題が変わったら、古い議題向けの確認質問はリセットする。
  function changeIssue(value: string) {
    setIssue(value)
    setQuestions([])
    setAnswers([])
    setPrepError(null)
  }

  function toggleRole(id: string) {
    setSelectedIds((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id],
    )
  }

  function updateAnswer(index: number, value: string) {
    setAnswers((prev) => {
      const next = [...prev]
      next[index] = value
      return next
    })
  }

  // 「議論の準備をする」/「質問を作り直す」: 確認質問を生成する（API1回）。
  async function handlePrepare() {
    setPrepError(null)
    if (!issue.trim()) {
      setPrepError('先に議題を入力してください')
      return
    }
    if (!apiKey.trim()) {
      setPrepError('APIキーを入力してください')
      focusApiKey()
      return
    }
    setPrepLoading(true)
    try {
      const qs = await generateClarifyingQuestions(apiKey, issue)
      setQuestions(qs)
      setAnswers(qs.map(() => ''))
    } catch (e) {
      setPrepError(e instanceof Error ? e.message : String(e))
    } finally {
      setPrepLoading(false)
    }
  }

  async function handleAutoSelect() {
    setAutoError(null)
    if (!issue.trim()) {
      setAutoError('先に議題を入力してください')
      return
    }
    if (!apiKey.trim()) {
      setAutoError('APIキーを入力してください')
      focusApiKey()
      return
    }
    setAutoLoading(true)
    try {
      const ids = await suggestRoles({ apiKey, issue })
      setSelectedIds(ids)
    } catch (e) {
      setAutoError(e instanceof Error ? e.message : String(e))
    } finally {
      setAutoLoading(false)
    }
  }

  async function handleStart() {
    setView('discussion')
    setError(null)
    setStatements([])
    setProgress(null)
    setLoading(true)
    // 回答済みの確認質問を文脈として渡す（空欄はengine側で除外される）。
    const context: ClarifyAnswer[] = questions.map((q, i) => ({
      question: q,
      answer: answers[i] ?? '',
    }))
    try {
      await runDiscussion({
        apiKey,
        issue,
        roleIds: selectedIds,
        context,
        onStatement: (s) => setStatements((prev) => [...prev, s]),
        onProgress: (p) => setProgress(p),
      })
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
      setProgress(null)
    }
  }

  // フェーズごとに発言をまとめる（時系列のまま、議事見出しで区切るため）。
  const byPhase = useMemo(() => {
    return PHASE_ORDER.map((phase) => ({
      phase,
      items: statements.filter((s) => s.phase === phase),
    })).filter((g) => g.items.length > 0)
  }, [statements])

  // 各役員の最終的な立場を集計する（再反論フェーズの立場を優先、なければ初期意見の立場）。
  // 賛成・条件付き賛成・反対の内訳を、総括の手前で一目で分かるように見せる。
  const stanceDist = useMemo(() => {
    const counts: Record<Stance, number> = { agree: 0, conditional: 0, disagree: 0 }
    let total = 0
    for (const roleId of selectedIds) {
      const counter = statements.find((s) => s.roleId === roleId && s.phase === 'counter')
      const opening = statements.find((s) => s.roleId === roleId && s.phase === 'opening')
      const stance = counter?.stance ?? opening?.stance
      if (stance) {
        counts[stance] += 1
        total += 1
      }
    }
    return { counts, total }
  }, [statements, selectedIds])

  return (
    <div className="app">
      <div className={`container${view === 'discussion' ? ' container--narrow' : ''}`}>
        {view === 'input' ? (
          <>
            <header className="masthead">
              <div className="brand">
                <MeetingIcon />
                <h1>AI経営会議</h1>
              </div>
              <p className="lede">経営課題を投げかけると、役員AIが議論します。</p>
              <p className="lede">決めるのは、あなたです。</p>
            </header>

            <section className="panel">
              {/* 議題 */}
              <div className="field">
                <label htmlFor="issue">議題（経営課題）</label>
                <textarea
                  id="issue"
                  value={issue}
                  onChange={(e) => changeIssue(e.target.value)}
                  rows={3}
                  placeholder="議論したい経営課題を入力、または下の例から選択"
                />
                <div className="examples">
                  {EXAMPLE_ISSUES.map((ex) => (
                    <button
                      key={ex}
                      type="button"
                      className="example-chip"
                      onClick={() => changeIssue(ex)}
                      title="クリックで議題欄に挿入"
                    >
                      {ex}
                    </button>
                  ))}
                </div>
              </div>

              {/* 確認事項（事前ヒアリング） */}
              <div className="field clarify">
                <label>確認事項（任意）</label>
                {questions.length === 0 ? (
                  <>
                    <p className="hint">
                      議題に応じてAIが確認質問を作成します。答えるほど、御社に即した議論になります。
                    </p>
                    <button
                      type="button"
                      className="prep-btn"
                      onClick={handlePrepare}
                      disabled={issue.trim() === '' || prepLoading}
                    >
                      {prepLoading ? '質問を準備中…' : '議論の準備をする'}
                    </button>
                    {prepLoading && (
                      <p className="prep-loading">
                        <span className="pulse-dot" />
                        AIが議題を読み、確認質問を作成しています…
                      </p>
                    )}
                  </>
                ) : (
                  <>
                    <p className="hint">
                      これらの質問はAIが議題に応じて作成したものです。答えるほど、御社に即した議論になります。空欄でも構いません。
                    </p>
                    <ol className="clarify-list">
                      {questions.map((q, i) => (
                        <li className="clarify-item" key={i}>
                          <span className="clarify-q">{q}</span>
                          <textarea
                            className="clarify-a"
                            rows={1}
                            value={answers[i] ?? ''}
                            onChange={(e) => updateAnswer(i, e.target.value)}
                            placeholder="任意・分かる範囲で"
                            autoFocus={i === 0}
                          />
                        </li>
                      ))}
                    </ol>
                    <button
                      type="button"
                      className="link-btn"
                      onClick={handlePrepare}
                      disabled={prepLoading}
                    >
                      {prepLoading ? '作成中…' : '質問を作り直す'}
                    </button>
                  </>
                )}
                {prepError && (
                  <p className="hint hint--error">
                    {prepError}（質問なしで議論を始めることもできます）
                  </p>
                )}
              </div>

              {/* 議長（固定）— 6名グリッドとは物理的に分ける */}
              <div className="field">
                <label>議長</label>
                <div className="chair-card">
                  <span className="role-dot role-dot--filled" style={{ backgroundColor: CHAIR.accentColor }}>
                    <CheckIcon />
                  </span>
                  <div className="chair-meta">
                    <div className="chair-line">
                      <span className="role-card-name">{CHAIR.name}</span>
                      <span className="role-card-title">最高経営責任者</span>
                      <span className="chair-badge">議長</span>
                    </div>
                    <span className="chair-note">この会議の進行役として常に出席します</span>
                  </div>
                  <button
                    type="button"
                    className="info-btn"
                    onClick={() => setProfileRole(CHAIR)}
                    aria-label={`${CHAIR.name}の詳細`}
                    title="役員の詳細"
                  >
                    i
                  </button>
                </div>
              </div>

              {/* 出席する役員（選択式） */}
              <div className="field">
                <div className="field-label-row">
                  <label>出席する役員（2名以上を選択）</label>
                  <button
                    type="button"
                    className="auto-btn"
                    onClick={handleAutoSelect}
                    disabled={issue.trim() === '' || autoLoading}
                  >
                    <SparkleIcon />
                    {autoLoading ? '選定中…' : '議題から自動で選ぶ'}
                  </button>
                </div>

                <div className="role-grid">
                  {SELECTABLE_ROLES.map((role) => {
                    const checked = selectedIds.includes(role.id)
                    return (
                      <div
                        className={`role-card${checked ? ' is-on' : ''}`}
                        key={role.id}
                        style={
                          checked
                            ? {
                                borderColor: role.accentColor,
                                boxShadow: `inset 0 0 0 1px ${role.accentColor}`,
                              }
                            : undefined
                        }
                      >
                        <button
                          type="button"
                          className="role-toggle"
                          aria-pressed={checked}
                          onClick={() => toggleRole(role.id)}
                        >
                          <span
                            className={`role-dot${checked ? ' role-dot--filled' : ' role-dot--empty'}`}
                            style={checked ? { backgroundColor: role.accentColor } : undefined}
                          >
                            {checked && <CheckIcon />}
                          </span>
                          <span className="role-meta">
                            <span className="role-card-name">{role.name}</span>
                            <span className="role-card-title">{role.title}</span>
                          </span>
                        </button>
                        <button
                          type="button"
                          className="info-btn"
                          onClick={() => setProfileRole(role)}
                          aria-label={`${role.name}の詳細`}
                          title="役員の詳細"
                        >
                          i
                        </button>
                      </div>
                    )
                  })}
                </div>

                <p className="hint">
                  観点の異なる役員を選ぶと議論が深まります。迷ったら「議題から自動で選ぶ」へ。
                </p>
                {autoError && <p className="hint hint--error">{autoError}</p>}
              </div>

              {/* APIキー（控えめに、開始ボタンの近く） */}
              <div className="apikey-area">
                <label htmlFor="apikey">Gemini APIキー</label>
                <input
                  ref={apiKeyRef}
                  id="apikey"
                  type="password"
                  value={apiKey}
                  onChange={(e) => setApiKey(e.target.value)}
                  placeholder="sk-…"
                  autoComplete="off"
                />
                <p className="hint">
                  APIキーはブラウザ内のみで保持され、外部に送信されません。
                </p>
              </div>

              <button type="button" className="start-btn" onClick={handleStart} disabled={!canStart}>
                会議を開始する
              </button>
            </section>
          </>
        ) : (
          <>
            <button type="button" className="back-btn" onClick={() => setView('input')}>
              ← 議題に戻る
            </button>

            <header className="mini-header">
              <span className="mini-icon">
                <MeetingIcon />
              </span>
              <span className="mini-title">経営会議</span>
              <span className="mini-issue">{issue}</span>
              <span className="attendee-badge">{attendeeCount}名出席</span>
            </header>

            {error && (
              <div className="error" role="alert">
                <p className="error-msg">⚠ {error}</p>
                <p className="error-sub">
                  議論が途中で中断されました。「議題に戻る」からやり直してください。
                </p>
              </div>
            )}

            <div className="minutes">
              {byPhase.map((group) => (
                <section key={group.phase} className="phase-group">
                  <AgendaHeading phase={group.phase} />
                  {group.items.map((s) => (
                    <StatementCard key={s.id} statement={s} />
                  ))}
                </section>
              ))}
            </div>

            {loading && progress && (
              <WaitingRoom progress={progress} roleIds={selectedIds} />
            )}
          </>
        )}
      </div>

      {profileRole && (
        <RoleProfileModal role={profileRole} onClose={() => setProfileRole(null)} />
      )}
    </div>
  )
}

function AgendaHeading({ phase }: { phase: Phase }) {
  const no = String(PHASE_ORDER.indexOf(phase) + 1).padStart(2, '0')
  const isSummary = phase === 'summary'
  return (
    <div className="agenda">
      <span className={`agenda-no${isSummary ? ' agenda-no--chair' : ''}`}>議事 {no}</span>
      <span className="agenda-title">{AGENDA_TITLES[phase]}</span>
      <span className="agenda-rule" />
    </div>
  )
}

// 議論生成中の待機表示。出席役員のアバターを並べ、生成中の役員に思考中ドットを出す。
function WaitingRoom({ progress, roleIds }: { progress: Progress; roleIds: string[] }) {
  const attendees = [CHAIR, ...roleIds.map(getRole)]
  return (
    <div className="waiting">
      <AgendaHeading phase={progress.phase} />
      <div className="waiting-room">
        {attendees.map((role) => {
          const active = progress.activeRoleIds.includes(role.id)
          return (
            <div className={`waiting-att${active ? ' is-active' : ''}`} key={role.id}>
              <span className="avatar" style={{ ['--role' as string]: role.accentColor }}>
                {role.name}
              </span>
              {active ? (
                <span className="thinking" aria-label="準備中">
                  <i />
                  <i />
                  <i />
                </span>
              ) : (
                <span className="waiting-wait">待機</span>
              )}
            </div>
          )
        })}
      </div>
      <p className="waiting-text">
        {progress.activeRoleIds.map((id) => getRole(id).name).join('・')}
        {' が'}
        {AGENDA_TITLES[progress.phase]}
        {'を準備しています'}
      </p>
      {progress.retrying && (
        <p className="waiting-retry">混雑のため、自動的に再試行しています…</p>
      )}
    </div>
  )
}

// 各役員の最終的な立場の分布。賛成・条件付き賛成・反対を色帯と内訳で控えめに示す。
const STANCE_ORDER: Stance[] = ['agree', 'conditional', 'disagree']

function StanceDistribution({
  dist,
}: {
  dist: { counts: Record<Stance, number>; total: number }
}) {
  const { counts, total } = dist
  const label = STANCE_ORDER.filter((s) => counts[s] > 0)
    .map((s) => `${STANCE_LABELS[s]}${counts[s]}名`)
    .join('・')

  return (
    <div className="stance-dist">
      <span className="stance-dist-label">役員の最終的な立場</span>
      <div className="stance-bar" role="img" aria-label={label}>
        {STANCE_ORDER.map((s) =>
          counts[s] > 0 ? (
            <span
              key={s}
              className={`stance-bar-seg stance-fill--${s}`}
              style={{ flexGrow: counts[s] }}
            />
          ) : null,
        )}
      </div>
      <div className="stance-legend">
        {STANCE_ORDER.map((s) => (
          <span className="stance-legend-item" key={s} data-zero={counts[s] === 0}>
            <span className={`stance-dot stance-fill--${s}`} />
            {STANCE_LABELS[s]}
            <span className="stance-legend-count">{counts[s]}</span>
          </span>
        ))}
      </div>
      <span className="stance-dist-note">
        {total}名中、{label || '集計なし'}
      </span>
    </div>
  )
}

function StatementCard({ statement }: { statement: Statement }) {
  const role = getRole(statement.roleId)
  const isSummary = Boolean(statement.summary)

  return (
    <article
      className={`statement${isSummary ? ' statement--summary' : ''}`}
      style={{ ['--role' as string]: role.accentColor }}
    >
      <div className="statement-row">
        <span className="avatar" aria-hidden="true">
          {role.name}
        </span>
        <div className="statement-main">
          <div className="statement-head">
            <span className="role-name">{role.name}</span>
            <span className="role-title">{role.title}</span>
            {statement.stance && (
              <span className={`stance stance--${statement.stance}`}>
                {STANCE_LABELS[statement.stance]}
              </span>
            )}
            {isSummary && <span className="decision-badge">決定は人が行います</span>}
          </div>

          {statement.summary ? (
            <div className="summary">
              <SummaryItem label="主要な論点" text={statement.summary.points} />
              <SummaryItem label="結論の方向性" text={statement.summary.direction} />
              {statement.summary.conditions && (
                <SummaryItem label="判断の分かれ目" text={statement.summary.conditions} />
              )}
              <SummaryItem label="最大のリスク" text={statement.summary.risk} />
              <div className="summary-item">
                <span className="summary-label">判断に足りない情報</span>
                <ul className="summary-list">
                  {statement.summary.missingInfo.map((m, i) => (
                    <li key={i}>{m}</li>
                  ))}
                </ul>
              </div>
            </div>
          ) : (
            <p className="statement-body">{statement.content}</p>
          )}
        </div>
      </div>
    </article>
  )
}

function SummaryItem({ label, text }: { label: string; text: string }) {
  return (
    <div className="summary-item">
      <span className="summary-label">{label}</span>
      <p className="summary-text">{text}</p>
    </div>
  )
}

function RoleProfileModal({ role, onClose }: { role: Role; onClose: () => void }) {
  // Escキーで閉じる。
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-label={`${role.title}の紹介`}
        onClick={(e) => e.stopPropagation()}
      >
        <button type="button" className="modal-close" onClick={onClose} aria-label="閉じる">
          ×
        </button>

        <div className="modal-head">
          <span className="avatar avatar--lg" style={{ ['--role' as string]: role.accentColor }}>
            {role.name}
          </span>
          <div>
            <h2 className="modal-title">{role.title}</h2>
            <span className="modal-stance" style={{ color: role.accentColor }}>
              {role.profile.stance}
            </span>
          </div>
        </div>

        <dl className="profile">
          <ProfileRow label="専門領域" text={role.profile.specialty} />
          <ProfileRow label="重視する観点" text={role.profile.perspective} />
          <ProfileRow label="こんな課題に" text={role.profile.whenToCall} />
        </dl>
      </div>
    </div>
  )
}

function ProfileRow({ label, text }: { label: string; text: string }) {
  return (
    <div className="profile-row">
      <dt>{label}</dt>
      <dd>{text}</dd>
    </div>
  )
}

export default App
