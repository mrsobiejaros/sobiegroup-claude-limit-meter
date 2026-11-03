import { atom, read, update } from 'claude-code'
import type { EngineInterface, PluginOptions, Register, SessionRateLimit } from 'claude-code'

import type { LimitReading, Live, Readings } from '../types'

// Les pourcentages viennent directement d'Anthropic : chaque réponse de l'API
// renvoie l'utilisation réelle du compte pour la fenêtre de 5 h et celle de
// 7 jours, selon l'abonnement de la personne. Rien n'est estimé ici.

const OVERFLOW_STEPS = [5, 10, 15, 20, 25, 50]
const BAR_WIDTH = 160
const BAR_COLORS = { success: '#3fb27f', warning: '#e0a83a', error: '#e5534b' } as const

type Overflow = { enabled: boolean; pct: number }

const live = atom({ plugin: 'sobiegroup-claude-limit-meter', key: 'live' } as const, null)

// ---------- Relevés d'Anthropic ----------

function toReading(limit: SessionRateLimit | undefined): LimitReading | null {
  if (!limit) return null
  const resetsAt = limit.resetsAt ? Date.parse(limit.resetsAt) : NaN
  return { percentUsed: limit.percentUsed, resetsAt: Number.isFinite(resetsAt) ? resetsAt : null }
}

function fromRateLimits(rateLimits: readonly SessionRateLimit[], at: number): Readings | null {
  const fiveHour = toReading(rateLimits.find(l => l.kind === 'five_hour'))
  const week = toReading(rateLimits.find(l => l.kind === 'seven_day'))
  return fiveHour || week ? { fiveHour, week, at } : null
}

// Une fenêtre dont l'heure de reset est passée repart de zéro.
function currentPct(reading: LimitReading | null, now: number): number | null {
  if (!reading) return null
  if (reading.resetsAt !== null && now >= reading.resetsAt) return 0
  return reading.percentUsed
}

function ceiling(l: Live): number {
  return 100 + (l.overflowEnabled ? l.overflowPct : 0)
}

function worstPct(l: Live): number {
  const r = l.readings
  return Math.max(currentPct(r?.fiveHour ?? null, l.now) ?? 0, currentPct(r?.week ?? null, l.now) ?? 0)
}

function isOverLimit(l: Live): boolean {
  return worstPct(l) >= ceiling(l)
}

// ---------- Mise en forme ----------

function formatDuration(ms: number): string {
  const min = Math.max(1, Math.ceil(ms / 60000))
  const d = Math.floor(min / 1440)
  const h = Math.floor((min % 1440) / 60)
  const m = min % 60
  if (d > 0) return `${d} j ${h} h`
  if (h > 0) return `${h} h ${String(m).padStart(2, '0')}`
  return `${m} min`
}

function formatPct(p: number): string {
  return p < 10 && p % 1 !== 0 ? `${p.toFixed(1)} %` : `${Math.round(p)} %`
}

function levelColor(p: number, limit: number): 'success' | 'warning' | 'error' {
  if (p >= Math.min(100, limit)) return 'error'
  if (p >= 70) return 'warning'
  return 'success'
}

function gaugeBar(p: number, limit: number, cells: number): string {
  const filled = Math.round(Math.min(1, p / limit) * cells)
  return '█'.repeat(filled) + '░'.repeat(cells - filled)
}

// Barre arrondie ; un repère marque 100 % quand la marge de dépassement est active.
function barSvg(p: number, limit: number): string {
  const h = 10
  const y = 2
  const bar = 6
  const fill = p > 0 ? Math.max(bar, Math.min(1, p / limit) * BAR_WIDTH) : 0
  const color = BAR_COLORS[levelColor(p, limit)]
  const mark = limit > 100
    ? `<rect x="${((100 / limit) * BAR_WIDTH - 1).toFixed(1)}" y="0" width="2" height="${h}" rx="1" fill="#8b8a85"/>`
    : ''
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${BAR_WIDTH}" height="${h}" viewBox="0 0 ${BAR_WIDTH} ${h}">` +
    `<rect x="0" y="${y}" width="${BAR_WIDTH}" height="${bar}" rx="3" fill="#8b8a85" fill-opacity="0.25"/>` +
    (fill > 0 ? `<rect x="0" y="${y}" width="${fill.toFixed(1)}" height="${bar}" rx="3" fill="${color}"/>` : '') +
    mark +
    '</svg>'
}

function gaugeData(label: string, reading: LimitReading | null, now: number) {
  const p = currentPct(reading, now)
  if (p === null) return { label, pct: null, detail: 'en attente du premier message' }
  const resetsAt = reading?.resetsAt ?? null
  const isExpired = resetsAt !== null && now >= resetsAt
  return {
    label,
    pct: p,
    detail: resetsAt === null ? 'reset inconnu' : isExpired ? 'remise à zéro effectuée' : `reset dans ${formatDuration(resetsAt - now)}`,
  }
}

// Un seul bouton : désactivé → +5 → +10 → +15 → +20 → +25 → +50 → désactivé.
function nextOverflow(o: Overflow): Overflow {
  const cycle = [0, ...OVERFLOW_STEPS]
  const current = o.enabled ? o.pct : 0
  const next = cycle[(cycle.indexOf(current) + 1) % cycle.length] ?? 0
  return next > 0 ? { enabled: true, pct: next } : { enabled: false, pct: o.pct }
}

function overflowLabel(l: Live): { badge: string; color?: 'warning' | 'error' } {
  if (!l.overflowEnabled) return { badge: 'désactivé' }
  const worst = worstPct(l)
  if (worst < 100) return { badge: `+${l.overflowPct} % possible`, color: 'warning' }
  const left = Math.max(0, Math.round(100 + l.overflowPct - worst))
  return { badge: `+${left} % restant`, color: left > 0 ? 'warning' : 'error' }
}

// ---------- Stockage (partagé entre toutes les sessions) ----------

async function loadOverflow($: EngineInterface): Promise<Overflow> {
  const o = (await $.store.get('overflow')) as Overflow | undefined
  return { enabled: o?.enabled ?? false, pct: o?.pct ?? 10 }
}

async function loadReadings($: EngineInterface): Promise<Readings | null> {
  return ((await $.store.get('readings')) as Readings | undefined) ?? null
}

// Deux relevés de la même fenêtre ont la même heure de reset, à quelques minutes près.
const SAME_WINDOW_MS = 5 * 60_000

// Une session inactive renvoie son dernier relevé, parfois ancien : on ne le laisse
// jamais écraser un relevé plus frais. La fenêtre la plus récente (reset le plus
// tardif) l'emporte ; dans une même fenêtre l'utilisation ne fait que monter, donc
// la valeur la plus haute est la plus récente.
function mergeReading(a: LimitReading | null, b: LimitReading | null): LimitReading | null {
  if (!a || !b) return a ?? b
  if (a.resetsAt === null || b.resetsAt === null) return b
  if (Math.abs(a.resetsAt - b.resetsAt) <= SAME_WINDOW_MS) {
    return a.percentUsed >= b.percentUsed ? a : b
  }
  return a.resetsAt > b.resetsAt ? a : b
}

async function saveReadings($: EngineInterface, fresh: Readings | null): Promise<void> {
  if (!fresh) return
  const stored = await loadReadings($)
  const merged: Readings = {
    fiveHour: mergeReading(stored?.fiveHour ?? null, fresh.fiveHour),
    week: mergeReading(stored?.week ?? null, fresh.week),
    at: Math.max(stored?.at ?? 0, fresh.at),
  }
  await $.store.set('readings', merged)
}

async function refresh($: EngineInterface): Promise<Live> {
  const [readings, overflow, now] = await Promise.all([loadReadings($), loadOverflow($), $.clock.now()])
  const next: Live = { readings, overflowEnabled: overflow.enabled, overflowPct: overflow.pct, now }
  await update($, live, () => next)
  return next
}

async function measure($: EngineInterface): Promise<Live> {
  const [usage, now] = await Promise.all([$.session.usage(), $.clock.now()])
  await saveReadings($, fromRateLimits(usage.rateLimits, now))
  return refresh($)
}

async function setOverflow($: EngineInterface, change: (o: Overflow) => Overflow) {
  await $.store.set('overflow', change(await loadOverflow($)))
  await refresh($)
}

async function finishPrompt($: EngineInterface, options: PluginOptions) {
  const current = await refresh($)
  if (options.blockAtLimit && isOverLimit(current)) {
    $.ui.toast('Limit Meter : limite atteinte, « Finir le prompt » est bloqué.')
    return
  }
  await $.prompt.submit({ text: String(options.finishText) })
}

export const register: Register = (on, options) => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'limit-meter',
      description: 'Limit Meter : affiche vos limites réelles 5 h et semaine',
    })
    // Efface les estimations des versions 1.x, qui ne servent plus.
    await $.store.delete('windows')
    await $.store.delete('calibration')
    await measure($)
    // Rafraîchit le compte à rebours et reprend les relevés des autres sessions.
    $.clock.every(60_000, () => void measure($))
    return next(e)
  })

  // Anthropic renvoie l'utilisation réelle après chaque tour.
  on('session.measure', async ($, e, next) => {
    const result = await next(e)
    if (e.changed.includes('rateLimits')) {
      await saveReadings($, fromRateLimits(e.rateLimits, await $.clock.now()))
      await refresh($)
    }
    return result
  })

  // Blocage optionnel quand la limite (+ marge active) est atteinte.
  on('prompt.submit', async ($, e, next) => {
    if (!options.blockAtLimit || e.command) return next(e)
    const l = await refresh($)
    if (!isOverLimit(l)) return next(e)
    return {
      drop: l.overflowEnabled
        ? 'Limit Meter : marge de dépassement épuisée. Attendez le reset ou augmentez la marge.'
        : 'Limit Meter : limite atteinte. Activez « Dépassement de la limite » pour continuer.',
    }
  }).catch(($, e, next) => next(e))

  on('command.run', { command: 'limit-meter' }, async $ => {
    const l = await measure($)
    if (!l.readings) {
      return { text: "Aucun relevé d'Anthropic pour l'instant : envoyez un message (il faut être connecté avec un abonnement Claude, pas une clé API)." }
    }
    const line = (name: string, r: LimitReading | null) => {
      const g = gaugeData(name, r, l.now)
      return g.pct === null ? `${name} : pas de relevé` : `${name} : ${formatPct(g.pct)} · ${g.detail}`
    }
    return {
      text: [
        line('Limite 5 h', l.readings.fiveHour),
        line('Limite semaine', l.readings.week),
        `Dépassement : ${l.overflowEnabled ? `activé, +${l.overflowPct} %` : 'désactivé'}`,
        `Relevé d'Anthropic d'il y a ${formatDuration(l.now - l.readings.at)}.`,
      ].join('\n'),
    }
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)
    const l = await read($, live)
    if (!l) return next(e)

    const limit = ceiling(l)
    const gauges = [
      gaugeData('Limite 5 h', l.readings?.fiveHour ?? null, l.now),
      gaugeData('Limite semaine', l.readings?.week ?? null, l.now),
    ]
    const overflow = overflowLabel(l)
    const cycleOverflow = () => setOverflow($, nextOverflow)
    const finish = () => finishPrompt($, options)

    if (e.surface === 'desktop') {
      const { Box, Button, Svg, Text } = $.ui.resolve(e)
      return (
        <Box flexDirection="row" flexWrap="wrap" alignItems="center" columnGap={3} rowGap={1}>
          {gauges.map(g => (
            <Box key={g.label} flexDirection="column" rowGap={0}>
              <Box flexDirection="row" justifyContent="space-between" columnGap={2}>
                <Text weight="semibold">{g.label}</Text>
                {g.pct === null
                  ? <Text dimColor>—</Text>
                  : <Text weight="semibold" color={levelColor(g.pct, limit)}>{formatPct(g.pct)}</Text>}
              </Box>
              <Svg source={barSvg(g.pct ?? 0, limit)} alt={`${g.label} : ${g.pct === null ? 'pas de relevé' : formatPct(g.pct)}`} width={BAR_WIDTH} height={10} />
              <Text dimColor>{g.detail}</Text>
            </Box>
          ))}
          <Box flexDirection="row" alignItems="center" columnGap={1} marginLeft={2}>
            <Button key="overflow" onPress={cycleOverflow}>
              Dépassement de la limite{' '}
              <Text color={overflow.color} dimColor={overflow.color === undefined}>{overflow.badge}</Text>
            </Button>
            <Button key="finish" variant="primary" label="Finir le prompt" onPress={finish} />
          </Box>
        </Box>
      )
    }

    // Terminal : jauges en texte.
    const { Box, Button, Text } = $.ui.resolve(e)
    const cells = e.props.bodyColumns < 100 ? 8 : 12
    return (
      <Box flexDirection="row" flexWrap="wrap" columnGap={3} alignItems="center">
        {gauges.map(g => (
          <Text>
            <Text weight="bold">{g.label} </Text>
            {g.pct === null
              ? <Text dimColor>—</Text>
              : <Text color={levelColor(g.pct, limit)}>{gaugeBar(g.pct, limit, cells)} {formatPct(g.pct)}</Text>}
            <Text dimColor> · {g.detail}</Text>
          </Text>
        ))}
        <Box flexDirection="row" columnGap={1}>
          <Button key="overflow" onPress={cycleOverflow}>
            Dépassement de la limite{' '}
            <Text color={overflow.color} dimColor={overflow.color === undefined}>{overflow.badge}</Text>
          </Button>
          <Button key="finish" variant="primary" label="Finir le prompt" onPress={finish} />
        </Box>
      </Box>
    )
  })
}
