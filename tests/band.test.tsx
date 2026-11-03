import { expect, mock, test } from 'claude-code/testing'
import type { On, SessionRateLimit } from 'claude-code'

const BAND = {
  plugin: 'sobiegroup-claude-limit-meter',
  component: 'AbovePrompt',
  requestId: 'above-prompt',
  props: {
    hasSurvey: false,
    isWorking: false,
    maxRows: 10,
    bodyColumns: 140,
    scroll: { offset: 0, bodyRows: 10 },
    view: {},
  },
} as const

const HOUR = 3_600_000

// Tient le rôle de l'app : `rate` donne ce que l'API d'Anthropic renvoie pour le compte.
function engine(on: On, rate: (now: number) => SessionRateLimit[] = () => []) {
  const clock = mock.clock(on)
  mock.store(on)
  on('command.register', () => ({ value: { command: 'limit-meter' } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.measure', (_, e) => ({ changed: e.changed }))
  on('session.usage', () => ({
    value: { startedAt: 0, context: { window: 200_000 }, rateLimits: rate(clock.now()) },
  }))
  return clock
}

function limits(now: number, five: number, week: number): SessionRateLimit[] {
  return [
    { kind: 'five_hour', percentUsed: five, resetsAt: new Date(now + 2 * HOUR + 13 * 60_000).toISOString() },
    { kind: 'seven_day', percentUsed: week, resetsAt: new Date(now + 4 * 24 * HOUR).toISOString() },
  ]
}

test("la bande affiche les pourcentages réels d'Anthropic, sur terminal et desktop", async ($, on) => {
  engine(on, now => limits(now, 23.5, 41))
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...BAND, surface })
    expect(await ui.find({ type: 'Text', text: /24 %/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /41 %/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /reset dans 2 h 13/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /reset dans 4 j 0 h/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /désactivé/ })).toBeDefined()
    await ui.unmount()
  }
})

test("sans relevé, la bande n'invente rien", async ($, on) => {
  engine(on)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })

  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: /en attente du premier message/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /%/ })).toBeUndefined()
  await ui.unmount()
})

test('un nouveau relevé après un tour met la bande à jour', async ($, on) => {
  const clock = engine(on)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.session.measure({
    context: { window: 200_000 },
    rateLimits: limits(clock.now(), 62, 34),
    changed: ['rateLimits'],
  })

  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: /62 %/ })).toBeDefined()
  expect(await ui.find({ type: 'Svg' })).toBeDefined()
  await ui.unmount()
})

test('une fenêtre dont le reset est passé repart de zéro', async ($, on) => {
  let start: number | null = null
  const clock = engine(on, now => limits((start ??= now), 80, 30))
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await clock.advance(3 * HOUR)

  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: /^0 %$/ })).toBeDefined()
  await ui.unmount()
})

test('le bouton de dépassement fait défiler la marge', async ($, on) => {
  engine(on)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...BAND, surface })
    await ui.press({ key: 'overflow' })
    expect(await ui.find({ type: 'Text', text: /\+5 % possible/ })).toBeDefined()
    await ui.press({ key: 'overflow' })
    expect(await ui.find({ type: 'Text', text: /\+10 % possible/ })).toBeDefined()
    for (let i = 0; i < 5; i++) await ui.press({ key: 'overflow' })
    expect(await ui.find({ type: 'Text', text: /désactivé/ })).toBeDefined()
    await ui.unmount()
  }
})

test('« Finir le prompt » envoie le texte configuré', async ($, on) => {
  engine(on)
  const sent: string[] = []
  on('prompt.submit', (_, e) => {
    sent.push(e.text)
    return { text: e.text }
  })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })

  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  await ui.press({ key: 'finish' })
  expect(sent.length).toBe(1)
  expect(sent[0]).toMatch(/Termine la tâche/)
  await ui.unmount()
})

test('le blocage refuse un prompt une fois la limite réelle atteinte', { options: { blockAtLimit: true } }, async ($, on) => {
  engine(on, now => limits(now, 100, 60))
  on('prompt.submit', (_, e) => ({ text: e.text }))
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })

  const refused = await $.prompt.submit({ text: 'encore' })
  expect(refused.drop).toMatch(/limite atteinte/)
})

test("un relevé périmé d'une session inactive n'écrase pas un relevé frais", async ($, on) => {
  const clock = engine(on)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  const now = clock.now()
  const measureWith = (rateLimits: SessionRateLimit[]) =>
    $.session.measure({ context: { window: 200_000 }, rateLimits, changed: ['rateLimits'] })

  // Relevé frais d'une session active : 54 %.
  await measureWith(limits(now, 54, 24))
  // Une autre session, inactive, renvoie son vieux relevé de la même fenêtre : 30 %.
  await measureWith(limits(now, 30, 20))

  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: /54 %/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /30 %/ })).toBeUndefined()
  await ui.unmount()

  // La fenêtre suivante (reset plus tardif) remplace l'ancienne, même plus basse.
  await measureWith([{ kind: 'five_hour', percentUsed: 3, resetsAt: new Date(now + 7 * HOUR).toISOString() }])
  const next = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect(await next.find({ type: 'Text', text: /^3 %$/ })).toBeDefined()
  await next.unmount()
})
