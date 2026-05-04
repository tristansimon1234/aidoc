import React from 'react'
import {
  AbsoluteFill,
  interpolate,
  spring,
  useCurrentFrame,
  useVideoConfig,
} from 'remotion'
import {
  LineChart, Line, BarChart, Bar, XAxis, ResponsiveContainer,
} from 'recharts'
import type { Branding, SceneTemplate } from '../../manifest.js'
import { Icons, MockFrame, Pill } from '../mock-helpers.js'

/**
 * Renders a structured SceneTemplate. Each `kind` maps to a fixed React
 * component below; the LLM fills the slots via JSON. No compile step,
 * no runtime eval — what the model can't write, can't break.
 */
export const TemplateScene: React.FC<{ template: SceneTemplate; branding: Branding }> = ({ template, branding }) => {
  switch (template.kind) {
    case 'hero-text':       return <HeroText {...template} branding={branding} />
    case 'kpi-reveal':      return <KpiReveal {...template} branding={branding} />
    case 'list-reveal':     return <ListReveal {...template} branding={branding} />
    case 'mock-frame':      return <MockFrameTemplate {...template} branding={branding} />
    case 'chat-bubble':     return <ChatBubble {...template} branding={branding} />
    case 'flow-diagram':    return <FlowDiagram {...template} branding={branding} />
    case 'chart':           return <ChartTemplate {...template} branding={branding} />
    case 'before-after':    return <BeforeAfter {...template} branding={branding} />
    case 'comparison-bars': return <ComparisonBars {...template} branding={branding} />
    case 'quote':           return <QuoteTemplate {...template} branding={branding} />
    case 'step-progression':return <StepProgression {...template} branding={branding} />
    case 'big-stat':        return <BigStat {...template} branding={branding} />
    case 'live-typing':     return <LiveTyping {...template} branding={branding} />
    case 'dual-screen':     return <DualScreen {...template} branding={branding} />
  }
}

// === Shared helpers ============================================

function useSpringEntry(delay: number): number {
  const frame = useCurrentFrame()
  const { fps } = useVideoConfig()
  return spring({ frame: frame - delay, fps, config: { damping: 18, stiffness: 110 } })
}

function entryStyle(t: number, dy = 12): React.CSSProperties {
  return {
    opacity: interpolate(t, [0, 1], [0, 1]),
    transform: `translateY(${interpolate(t, [0, 1], [dy, 0])}px)`,
  }
}

function IconFromName({ name, size = 24, color }: { name: string; size?: number; color: string }): React.ReactElement | null {
  const Cmp = (Icons as unknown as Record<string, React.FC<{ size?: number; color?: string }> | undefined>)[name]
  if (!Cmp) return null
  return <Cmp size={size} color={color} />
}

// === hero-text =================================================

const HeroText: React.FC<{
  headline: string
  subhead?: string
  layout?: 'center' | 'left' | 'burst'
  branding: Branding
}> = ({ headline, subhead, layout = 'center', branding }) => {
  const frame = useCurrentFrame()
  const { fps } = useVideoConfig()
  const align = layout === 'left' ? 'flex-start' : 'center'
  const textAlign = (layout === 'left' ? 'left' : 'center') as React.CSSProperties['textAlign']

  if (layout === 'burst') {
    const words = headline.split(/\s+/).filter(Boolean)
    return (
      <AbsoluteFill style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 80 }}>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.4em 0.6em', justifyContent: 'center', maxWidth: '80%' }}>
          {words.map((w, i) => {
            const t = spring({ frame: frame - i * 6, fps, config: { damping: 18, stiffness: 110 } })
            return (
              <span
                key={i}
                style={{
                  ...entryStyle(t, 18),
                  color: i % 3 === 1 ? branding.accentColor : branding.textColor,
                  fontFamily: branding.fontFamily,
                  fontSize: 96, fontWeight: 800, letterSpacing: '-0.025em', lineHeight: 1.05,
                }}
              >{w}</span>
            )
          })}
        </div>
      </AbsoluteFill>
    )
  }

  const headlineT = useSpringEntry(0)
  const subT = useSpringEntry(12)
  return (
    <AbsoluteFill style={{ display: 'flex', alignItems: 'center', justifyContent: align, padding: 96 }}>
      <div style={{ maxWidth: 1100, textAlign }}>
        <h1
          style={{
            ...entryStyle(headlineT),
            color: branding.textColor,
            fontFamily: branding.fontFamily,
            fontSize: 88, fontWeight: 700, letterSpacing: '-0.025em', lineHeight: 1.05, margin: 0,
          }}
        >{headline}</h1>
        {subhead && (
          <p
            style={{
              ...entryStyle(subT),
              color: branding.textColor,
              opacity: interpolate(subT, [0, 1], [0, 0.65]),
              fontFamily: branding.fontFamily,
              fontSize: 32, fontWeight: 400, lineHeight: 1.4, marginTop: 32,
            }}
          >{subhead}</p>
        )}
      </div>
    </AbsoluteFill>
  )
}

// === kpi-reveal ================================================

const KpiReveal: React.FC<{
  metric: string
  value: string
  sub?: string
  trend?: 'up' | 'down' | 'flat'
  branding: Branding
}> = ({ metric, value, sub, trend, branding }) => {
  const labelT = useSpringEntry(0)
  const valueT = useSpringEntry(8)
  const subT = useSpringEntry(20)
  const trendIcon = trend === 'up' ? 'TrendingUp' : trend === 'down' ? 'TrendingDown' : null
  const trendColor = trend === 'up' ? '#16a34a' : trend === 'down' ? '#dc2626' : branding.textColor
  return (
    <AbsoluteFill style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 96 }}>
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: 12 }}>
        <p
          style={{
            ...entryStyle(labelT),
            color: branding.textColor, opacity: 0.55,
            fontFamily: branding.fontFamily,
            fontSize: 22, letterSpacing: '0.05em', textTransform: 'uppercase', margin: 0, fontWeight: 500,
          }}
        >{metric}</p>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 16 }}>
          <span
            style={{
              ...entryStyle(valueT, 24),
              color: branding.accentColor,
              fontFamily: branding.fontFamily,
              fontSize: 220, fontWeight: 800, letterSpacing: '-0.04em', lineHeight: 0.95,
            }}
          >{value}</span>
          {trendIcon && (
            <span style={{ ...entryStyle(valueT, 8), color: trendColor }}>
              <IconFromName name={trendIcon} size={48} color={trendColor} />
            </span>
          )}
        </div>
        {sub && (
          <p
            style={{
              ...entryStyle(subT),
              color: branding.textColor, opacity: 0.6,
              fontFamily: branding.fontFamily,
              fontSize: 28, fontWeight: 400, margin: 0, marginTop: 12,
            }}
          >{sub}</p>
        )}
      </div>
    </AbsoluteFill>
  )
}

// === list-reveal ===============================================

const ListReveal: React.FC<{
  title: string
  items: { text: string; icon?: string }[]
  branding: Branding
}> = ({ title, items, branding }) => {
  const titleT = useSpringEntry(0)
  return (
    <AbsoluteFill style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 96 }}>
      <div style={{ maxWidth: 900, width: '100%' }}>
        <h2
          style={{
            ...entryStyle(titleT),
            color: branding.textColor,
            fontFamily: branding.fontFamily,
            fontSize: 56, fontWeight: 700, letterSpacing: '-0.02em', margin: 0, marginBottom: 40,
          }}
        >{title}</h2>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          {items.map((item, i) => {
            const t = useSpringEntry(8 + i * 6)
            return (
              <div
                key={i}
                style={{
                  ...entryStyle(t, 16),
                  display: 'flex', alignItems: 'center', gap: 20,
                  padding: '20px 28px',
                  borderRadius: 16,
                  background: `${branding.accentColor}0A`,
                  border: `1px solid ${branding.accentColor}1F`,
                }}
              >
                {item.icon && (
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', width: 48, height: 48, borderRadius: 12, background: `${branding.accentColor}1A` }}>
                    <IconFromName name={item.icon} size={24} color={branding.accentColor} />
                  </div>
                )}
                <span style={{ color: branding.textColor, fontFamily: branding.fontFamily, fontSize: 28, fontWeight: 500 }}>
                  {item.text}
                </span>
              </div>
            )
          })}
        </div>
      </div>
    </AbsoluteFill>
  )
}

// === mock-frame ================================================

const MockFrameTemplate: React.FC<{
  url?: string
  appName?: string
  cards: { title: string; subtitle?: string; pillText?: string; pillTone?: 'accent' | 'success' | 'warning' | 'danger' | 'muted' }[]
  branding: Branding
}> = ({ url, appName, cards, branding }) => {
  const frameT = useSpringEntry(0)
  const displayUrl = url ?? `${(appName ?? branding.productName).toLowerCase().replace(/\s+/g, '')}.app`
  return (
    <AbsoluteFill style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 80 }}>
      <div style={{ width: '85%', maxWidth: 1280, ...entryStyle(frameT, 24) }}>
        <MockFrame url={displayUrl} tone="light">
          <div style={{ padding: 32, fontFamily: branding.fontFamily }}>
            <div style={{ fontSize: 22, fontWeight: 600, color: branding.textColor, marginBottom: 24 }}>
              {appName ?? branding.productName}
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: 16 }}>
              {cards.map((card, i) => {
                const t = useSpringEntry(8 + i * 5)
                return (
                  <div
                    key={i}
                    style={{
                      ...entryStyle(t, 12),
                      padding: 20,
                      borderRadius: 12,
                      background: '#fff',
                      border: '1px solid rgba(0,0,0,0.06)',
                      boxShadow: '0 1px 3px rgba(0,0,0,0.05)',
                      display: 'flex', flexDirection: 'column', gap: 6,
                    }}
                  >
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
                      <span style={{ fontSize: 18, fontWeight: 600, color: branding.textColor }}>{card.title}</span>
                      {card.pillText && (
                        <Pill tone={card.pillTone ?? 'accent'} accentColor={branding.accentColor}>
                          {card.pillText}
                        </Pill>
                      )}
                    </div>
                    {card.subtitle && (
                      <span style={{ fontSize: 15, color: branding.textColor, opacity: 0.6 }}>{card.subtitle}</span>
                    )}
                  </div>
                )
              })}
            </div>
          </div>
        </MockFrame>
      </div>
    </AbsoluteFill>
  )
}

// === chat-bubble ===============================================

const ChatBubble: React.FC<{
  appName?: string
  question: string
  answer: string
  branding: Branding
}> = ({ appName, question, answer, branding }) => {
  const frame = useCurrentFrame()
  const frameT = useSpringEntry(0)
  const qT = useSpringEntry(10)
  const aT = useSpringEntry(28)
  // Typewriter effect on the answer
  const charCount = Math.floor(interpolate(frame, [80, 200], [0, answer.length], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' }))
  const visibleAnswer = answer.slice(0, charCount)
  return (
    <AbsoluteFill style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 80 }}>
      <div style={{ width: '70%', maxWidth: 880, ...entryStyle(frameT, 24) }}>
        <MockFrame url={`${(appName ?? branding.productName).toLowerCase().replace(/\s+/g, '')}.app/chat`} tone="light">
          <div style={{ padding: 28, display: 'flex', flexDirection: 'column', gap: 16, fontFamily: branding.fontFamily, minHeight: 360 }}>
            <div style={{ ...entryStyle(qT), display: 'flex', justifyContent: 'flex-end' }}>
              <div style={{ background: '#F1F1F1', color: branding.textColor, padding: '14px 18px', borderRadius: 18, maxWidth: '70%', fontSize: 20, fontWeight: 500 }}>
                {question}
              </div>
            </div>
            <div style={{ ...entryStyle(aT), display: 'flex', justifyContent: 'flex-start' }}>
              <div style={{ background: branding.accentColor, color: '#fff', padding: '14px 18px', borderRadius: 18, maxWidth: '80%', fontSize: 20, fontWeight: 500 }}>
                {visibleAnswer}
                {charCount < answer.length && <span style={{ display: 'inline-block', width: 2, height: 18, background: '#fff', verticalAlign: 'middle', marginLeft: 4, opacity: Math.round(frame / 8) % 2 }} />}
              </div>
            </div>
          </div>
        </MockFrame>
      </div>
    </AbsoluteFill>
  )
}

// === flow-diagram ==============================================

const FlowDiagram: React.FC<{
  nodes: { icon: string; label: string; accent?: boolean }[]
  branding: Branding
}> = ({ nodes, branding }) => {
  return (
    <AbsoluteFill style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 96 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 32 }}>
        {nodes.map((node, i) => {
          const nodeT = useSpringEntry(i * 18)
          const arrowT = useSpringEntry(i * 18 + 10)
          const accent = !!node.accent
          return (
            <React.Fragment key={i}>
              <div
                style={{
                  ...entryStyle(nodeT, 20),
                  width: 200, height: 200,
                  display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
                  gap: 16,
                  borderRadius: 28,
                  padding: 24,
                  background: accent ? `linear-gradient(135deg, ${branding.accentColor}, ${branding.accentColor}DD)` : '#fff',
                  border: `1px solid ${accent ? 'transparent' : 'rgba(0,0,0,0.08)'}`,
                  boxShadow: accent ? `0 24px 48px -12px ${branding.accentColor}55` : '0 8px 24px -8px rgba(0,0,0,0.10)',
                }}
              >
                <IconFromName name={node.icon} size={56} color={accent ? '#fff' : branding.accentColor} />
                <span style={{ color: accent ? '#fff' : branding.textColor, fontFamily: branding.fontFamily, fontSize: 20, fontWeight: 600, textAlign: 'center', lineHeight: 1.2 }}>
                  {node.label}
                </span>
              </div>
              {i < nodes.length - 1 && (
                <div style={{ ...entryStyle(arrowT, 0), opacity: interpolate(arrowT, [0, 1], [0, 0.7]) }}>
                  <IconFromName name="ArrowRight" size={36} color={branding.accentColor} />
                </div>
              )}
            </React.Fragment>
          )
        })}
      </div>
    </AbsoluteFill>
  )
}

// === chart =====================================================

const ChartTemplate: React.FC<{
  type: 'bar' | 'line'
  title?: string
  points: { label: string; value: number }[]
  branding: Branding
}> = ({ type, title, points, branding }) => {
  const titleT = useSpringEntry(0)
  const chartT = useSpringEntry(8)
  const reveal = interpolate(chartT, [0, 1], [0, 1])
  // Progressive reveal: trim the data to the proportion that should be visible.
  const visibleCount = Math.max(1, Math.ceil(points.length * reveal))
  const visiblePoints = points.slice(0, visibleCount)
  return (
    <AbsoluteFill style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 96 }}>
      <div style={{ width: '70%', maxWidth: 1100 }}>
        {title && (
          <h2
            style={{
              ...entryStyle(titleT),
              color: branding.textColor,
              fontFamily: branding.fontFamily,
              fontSize: 48, fontWeight: 700, letterSpacing: '-0.02em', margin: 0, marginBottom: 32,
            }}
          >{title}</h2>
        )}
        <div style={{ ...entryStyle(chartT, 16), height: 360 }}>
          <ResponsiveContainer width="100%" height="100%">
            {type === 'bar' ? (
              <BarChart data={visiblePoints}>
                <XAxis dataKey="label" tick={{ fill: branding.textColor, fontSize: 14, fontFamily: branding.fontFamily }} axisLine={false} tickLine={false} />
                <Bar dataKey="value" fill={branding.accentColor} radius={[8, 8, 0, 0]} isAnimationActive={false} />
              </BarChart>
            ) : (
              <LineChart data={visiblePoints}>
                <XAxis dataKey="label" tick={{ fill: branding.textColor, fontSize: 14, fontFamily: branding.fontFamily }} axisLine={false} tickLine={false} />
                <Line type="monotone" dataKey="value" stroke={branding.accentColor} strokeWidth={3} dot={{ r: 5, fill: branding.accentColor }} isAnimationActive={false} />
              </LineChart>
            )}
          </ResponsiveContainer>
        </div>
      </div>
    </AbsoluteFill>
  )
}

// === before-after ===============================================

const BeforeAfter: React.FC<{
  beforeLabel: string
  afterLabel: string
  beforeText?: string
  afterText?: string
  beforeIcon?: string
  afterIcon?: string
  branding: Branding
}> = ({ beforeLabel, afterLabel, beforeText, afterText, beforeIcon, afterIcon, branding }) => {
  const frame = useCurrentFrame()
  const { fps } = useVideoConfig()
  // Wipe slider goes from "all-before" to "all-after" between frames 30 and 90.
  const wipeT = spring({ frame: frame - 30, fps, config: { damping: 22, stiffness: 90 } })
  const wipePct = interpolate(wipeT, [0, 1], [50, 50]) // both panels stay visible
  const beforeOpacity = interpolate(wipeT, [0, 1], [1, 0.55])
  const afterScale = interpolate(wipeT, [0, 1], [0.96, 1])
  const labelTop = useSpringEntry(0)
  return (
    <AbsoluteFill style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 80 }}>
      <div style={{ width: '85%', maxWidth: 1280, height: 540, borderRadius: 20, overflow: 'hidden', display: 'flex', position: 'relative', boxShadow: '0 24px 48px -16px rgba(0,0,0,0.18)', border: '1px solid rgba(0,0,0,0.06)' }}>
        {/* Before half */}
        <div style={{ flex: 1, background: '#F6F6F6', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 18, padding: 32, opacity: beforeOpacity }}>
          {beforeIcon && <IconFromName name={beforeIcon} size={64} color="#9CA3AF" />}
          <span style={{ fontFamily: branding.fontFamily, fontSize: 28, fontWeight: 600, color: '#6B7280', textTransform: 'uppercase', letterSpacing: '0.05em' }}>{beforeLabel}</span>
          {beforeText && <span style={{ fontFamily: branding.fontFamily, fontSize: 22, color: '#6B7280', textAlign: 'center', lineHeight: 1.4, maxWidth: '90%' }}>{beforeText}</span>}
        </div>
        {/* Divider */}
        <div style={{ width: 4, background: branding.accentColor, position: 'absolute', left: `${wipePct}%`, top: 0, bottom: 0, transform: 'translateX(-50%)', boxShadow: `0 0 24px ${branding.accentColor}` }} />
        {/* After half */}
        <div style={{ flex: 1, background: `linear-gradient(135deg, ${branding.accentColor}, ${branding.accentColor}DD)`, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 18, padding: 32, transform: `scale(${afterScale})` }}>
          {afterIcon && <IconFromName name={afterIcon} size={64} color="#fff" />}
          <span style={{ fontFamily: branding.fontFamily, fontSize: 32, fontWeight: 700, color: '#fff', textTransform: 'uppercase', letterSpacing: '0.05em', ...entryStyle(labelTop, 12) }}>{afterLabel}</span>
          {afterText && <span style={{ fontFamily: branding.fontFamily, fontSize: 22, color: '#fff', opacity: 0.9, textAlign: 'center', lineHeight: 1.4, maxWidth: '90%' }}>{afterText}</span>}
        </div>
      </div>
    </AbsoluteFill>
  )
}

// === comparison-bars ============================================

const ComparisonBars: React.FC<{
  leftLabel: string
  rightLabel: string
  rows: { feature: string; left: boolean; right: boolean }[]
  branding: Branding
}> = ({ leftLabel, rightLabel, rows, branding }) => {
  const headerT = useSpringEntry(0)
  return (
    <AbsoluteFill style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 80 }}>
      <div style={{ width: '70%', maxWidth: 1100, fontFamily: branding.fontFamily }}>
        <div style={{ ...entryStyle(headerT), display: 'grid', gridTemplateColumns: '2fr 1fr 1fr', gap: 0, marginBottom: 16, paddingBottom: 16, borderBottom: '1px solid rgba(0,0,0,0.08)' }}>
          <span style={{ fontSize: 22, fontWeight: 500, color: branding.textColor, opacity: 0.5 }}>Feature</span>
          <span style={{ fontSize: 26, fontWeight: 700, color: branding.textColor, textAlign: 'center' }}>{leftLabel}</span>
          <span style={{ fontSize: 26, fontWeight: 700, color: branding.accentColor, textAlign: 'center' }}>{rightLabel}</span>
        </div>
        {rows.map((row, i) => {
          const t = useSpringEntry(8 + i * 6)
          return (
            <div
              key={i}
              style={{
                ...entryStyle(t, 12),
                display: 'grid', gridTemplateColumns: '2fr 1fr 1fr', alignItems: 'center',
                padding: '20px 0',
                borderBottom: i < rows.length - 1 ? '1px solid rgba(0,0,0,0.04)' : 'none',
              }}
            >
              <span style={{ fontSize: 22, color: branding.textColor, fontWeight: 500 }}>{row.feature}</span>
              <span style={{ display: 'flex', justifyContent: 'center' }}>
                {row.left
                  ? <IconFromName name="Check" size={28} color="#16a34a" />
                  : <IconFromName name="X" size={28} color="#9CA3AF" />}
              </span>
              <span style={{ display: 'flex', justifyContent: 'center' }}>
                {row.right
                  ? <IconFromName name="Check" size={28} color={branding.accentColor} />
                  : <IconFromName name="X" size={28} color="#9CA3AF" />}
              </span>
            </div>
          )
        })}
      </div>
    </AbsoluteFill>
  )
}

// === quote ======================================================

const QuoteTemplate: React.FC<{
  text: string
  author: string
  role?: string
  company?: string
  avatarUrl?: string
  branding: Branding
}> = ({ text, author, role, company, avatarUrl, branding }) => {
  const quoteT = useSpringEntry(0)
  const authorT = useSpringEntry(20)
  const subtitle = [role, company].filter(Boolean).join(' · ')
  const initials = author.split(/\s+/).slice(0, 2).map(p => p[0]).join('').toUpperCase()
  return (
    <AbsoluteFill style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 96 }}>
      <div style={{ maxWidth: 1100, fontFamily: branding.fontFamily }}>
        <div style={{ ...entryStyle(quoteT), fontSize: 80, color: branding.accentColor, lineHeight: 0.5, marginBottom: 24 }}>“</div>
        <p style={{ ...entryStyle(quoteT, 16), fontSize: 44, fontWeight: 500, color: branding.textColor, lineHeight: 1.35, letterSpacing: '-0.01em', margin: 0 }}>
          {text}
        </p>
        <div style={{ ...entryStyle(authorT, 16), display: 'flex', alignItems: 'center', gap: 16, marginTop: 40 }}>
          <div style={{ width: 64, height: 64, borderRadius: '50%', overflow: 'hidden', background: `${branding.accentColor}1F`, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            {avatarUrl
              ? <img src={avatarUrl} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
              : <span style={{ fontSize: 24, fontWeight: 700, color: branding.accentColor }}>{initials}</span>}
          </div>
          <div>
            <div style={{ fontSize: 22, fontWeight: 600, color: branding.textColor }}>{author}</div>
            {subtitle && <div style={{ fontSize: 18, color: branding.textColor, opacity: 0.6 }}>{subtitle}</div>}
          </div>
        </div>
      </div>
    </AbsoluteFill>
  )
}

// === step-progression ===========================================

const StepProgression: React.FC<{
  steps: { title: string; description?: string }[]
  branding: Branding
}> = ({ steps, branding }) => {
  const frame = useCurrentFrame()
  const { fps } = useVideoConfig()
  return (
    <AbsoluteFill style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 96 }}>
      <div style={{ maxWidth: 900, width: '100%', position: 'relative', fontFamily: branding.fontFamily }}>
        {/* Vertical progress bar background */}
        <div style={{ position: 'absolute', left: 32, top: 32, bottom: 32, width: 4, background: 'rgba(0,0,0,0.06)', borderRadius: 2 }} />
        {/* Filled portion */}
        <div
          style={{
            position: 'absolute', left: 32, top: 32, width: 4,
            background: branding.accentColor,
            borderRadius: 2,
            height: `calc(${interpolate(frame, [10, 10 + steps.length * 12], [0, 100], { extrapolateRight: 'clamp' })}% - 64px)`,
          }}
        />
        {steps.map((step, i) => {
          const t = useSpringEntry(8 + i * 12)
          return (
            <div
              key={i}
              style={{
                ...entryStyle(t, 16),
                display: 'flex', alignItems: 'flex-start', gap: 24,
                marginBottom: i < steps.length - 1 ? 32 : 0,
                position: 'relative',
              }}
            >
              <div
                style={{
                  width: 68, height: 68, borderRadius: '50%',
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  background: `linear-gradient(135deg, ${branding.accentColor}, ${branding.accentColor}DD)`,
                  color: '#fff', fontSize: 28, fontWeight: 700,
                  boxShadow: `0 12px 24px -8px ${branding.accentColor}55`,
                  flexShrink: 0, zIndex: 1,
                }}
              >{i + 1}</div>
              <div style={{ paddingTop: 8 }}>
                <div style={{ fontSize: 30, fontWeight: 600, color: branding.textColor, marginBottom: step.description ? 8 : 0 }}>{step.title}</div>
                {step.description && <div style={{ fontSize: 20, color: branding.textColor, opacity: 0.6, lineHeight: 1.4 }}>{step.description}</div>}
              </div>
            </div>
          )
        })}
      </div>
    </AbsoluteFill>
  )
}

// === big-stat ===================================================

const BigStat: React.FC<{
  value: string
  label?: string
  sub?: string
  branding: Branding
}> = ({ value, label, sub, branding }) => {
  const labelT = useSpringEntry(0)
  const valueT = useSpringEntry(8)
  const subT = useSpringEntry(28)
  return (
    <AbsoluteFill style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 80 }}>
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', textAlign: 'center', gap: 16, fontFamily: branding.fontFamily }}>
        {label && (
          <span style={{ ...entryStyle(labelT), fontSize: 28, color: branding.textColor, opacity: 0.55, letterSpacing: '0.06em', textTransform: 'uppercase', fontWeight: 500 }}>
            {label}
          </span>
        )}
        <span
          style={{
            ...entryStyle(valueT, 40),
            fontSize: 360,
            fontWeight: 800,
            background: `linear-gradient(135deg, ${branding.accentColor}, ${branding.accentColor}AA)`,
            WebkitBackgroundClip: 'text',
            WebkitTextFillColor: 'transparent',
            backgroundClip: 'text',
            letterSpacing: '-0.04em',
            lineHeight: 0.9,
          }}
        >{value}</span>
        {sub && (
          <span style={{ ...entryStyle(subT), fontSize: 28, color: branding.textColor, opacity: 0.7, fontWeight: 400, marginTop: 8 }}>
            {sub}
          </span>
        )}
      </div>
    </AbsoluteFill>
  )
}

// === live-typing ================================================

const LiveTyping: React.FC<{
  language?: 'shell' | 'js' | 'json' | 'http'
  lines: string[]
  branding: Branding
}> = ({ language = 'shell', lines, branding }) => {
  const frame = useCurrentFrame()
  const { fps } = useVideoConfig()
  const frameT = useSpringEntry(0)
  const PROMPT: Record<string, string> = { shell: '$', js: '>', json: '', http: '' }
  const prefix = PROMPT[language] ?? ''
  const charsPerSecond = 35
  const totalChars = lines.reduce((acc, l) => acc + l.length, 0)
  const startFrame = 20
  const visible = Math.min(totalChars, Math.max(0, Math.floor((frame - startFrame) / fps * charsPerSecond)))
  // Distribute "visible" chars across the lines
  let remaining = visible
  const visibleLines = lines.map(line => {
    if (remaining <= 0) return ''
    const take = Math.min(line.length, remaining)
    remaining -= take
    return line.slice(0, take)
  })
  const cursorBlink = Math.round(frame / 12) % 2
  return (
    <AbsoluteFill style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 80 }}>
      <div
        style={{
          ...entryStyle(frameT, 24),
          width: '70%', maxWidth: 1100, minHeight: 320,
          background: '#0F0F12',
          borderRadius: 14,
          border: '1px solid rgba(255,255,255,0.06)',
          boxShadow: '0 30px 60px -16px rgba(0,0,0,0.4)',
          fontFamily: 'ui-monospace, SFMono-Regular, Consolas, Menlo, monospace',
          fontSize: 22,
          lineHeight: 1.6,
          color: '#E6E6E6',
          overflow: 'hidden',
        }}
      >
        <div style={{ display: 'flex', gap: 6, padding: '14px 18px', borderBottom: '1px solid rgba(255,255,255,0.05)' }}>
          <div style={{ width: 12, height: 12, borderRadius: '50%', background: '#FF5F56' }} />
          <div style={{ width: 12, height: 12, borderRadius: '50%', background: '#FFBD2E' }} />
          <div style={{ width: 12, height: 12, borderRadius: '50%', background: '#27C93F' }} />
        </div>
        <div style={{ padding: '24px 28px' }}>
          {visibleLines.map((line, i) => {
            const isLast = i === visibleLines.length - 1 || (i + 1 < visibleLines.length && visibleLines[i + 1] === '')
            const showCursor = isLast && line.length > 0 && line.length < lines[i]!.length
            return (
              <div key={i} style={{ display: 'flex', whiteSpace: 'pre' }}>
                {prefix && <span style={{ color: branding.accentColor, marginRight: 8, opacity: line ? 1 : 0.5 }}>{prefix}</span>}
                <span>{line}</span>
                {showCursor && <span style={{ display: 'inline-block', width: 10, height: 22, background: branding.accentColor, marginLeft: 2, opacity: cursorBlink, verticalAlign: 'middle' }} />}
              </div>
            )
          })}
        </div>
      </div>
    </AbsoluteFill>
  )
}

// === dual-screen ================================================

const DualScreen: React.FC<{
  leftUrl?: string
  rightUrl?: string
  leftCards: { title: string; subtitle?: string; pillText?: string; pillTone?: 'accent' | 'success' | 'warning' | 'danger' | 'muted' }[]
  rightCards: { title: string; subtitle?: string; pillText?: string; pillTone?: 'accent' | 'success' | 'warning' | 'danger' | 'muted' }[]
  branding: Branding
}> = ({ leftUrl, rightUrl, leftCards, rightCards, branding }) => {
  const leftT = useSpringEntry(0)
  const rightT = useSpringEntry(8)
  const renderCards = (cards: typeof leftCards, baseDelay: number) => (
    <div style={{ padding: 22, display: 'flex', flexDirection: 'column', gap: 12, fontFamily: branding.fontFamily }}>
      {cards.map((card, i) => {
        const t = useSpringEntry(baseDelay + 8 + i * 5)
        return (
          <div
            key={i}
            style={{
              ...entryStyle(t, 12),
              padding: 14, borderRadius: 10,
              background: '#fff', border: '1px solid rgba(0,0,0,0.06)',
              display: 'flex', flexDirection: 'column', gap: 4,
            }}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
              <span style={{ fontSize: 16, fontWeight: 600, color: branding.textColor }}>{card.title}</span>
              {card.pillText && (
                <Pill tone={card.pillTone ?? 'accent'} accentColor={branding.accentColor}>
                  {card.pillText}
                </Pill>
              )}
            </div>
            {card.subtitle && <span style={{ fontSize: 13, color: branding.textColor, opacity: 0.6 }}>{card.subtitle}</span>}
          </div>
        )
      })}
    </div>
  )
  return (
    <AbsoluteFill style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 60, gap: 24 }}>
      <div style={{ flex: 1, maxWidth: 700, ...entryStyle(leftT, 24), transform: `${entryStyle(leftT, 24).transform} translateX(-12px) rotateY(2deg)` }}>
        <MockFrame url={leftUrl ?? `${branding.productName.toLowerCase().replace(/\s+/g, '')}.app`} tone="light">
          {renderCards(leftCards, 0)}
        </MockFrame>
      </div>
      <div style={{ flex: 1, maxWidth: 700, ...entryStyle(rightT, 24), transform: `${entryStyle(rightT, 24).transform} translateX(12px) rotateY(-2deg)` }}>
        <MockFrame url={rightUrl ?? `${branding.productName.toLowerCase().replace(/\s+/g, '')}.app/v2`} tone="light">
          {renderCards(rightCards, 8)}
        </MockFrame>
      </div>
    </AbsoluteFill>
  )
}
