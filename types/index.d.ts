/** Un relevé réel d'Anthropic pour une fenêtre : pourcentage utilisé et heure du reset (ms). */
export type LimitReading = { percentUsed: number; resetsAt: number | null }

/** Les derniers relevés connus, partagés entre les sessions via le store. */
export type Readings = {
  fiveHour: LimitReading | null
  week: LimitReading | null
  /** Quand ces relevés ont été lus (ms). */
  at: number
}

/** Ce que la bande dessine. */
export type Live = {
  readings: Readings | null
  overflowEnabled: boolean
  overflowPct: number
  now: number
}

declare module 'claude-code' {
  interface PluginState {
    'sobiegroup-claude-limit-meter': {
      /** Ancienne version (estimations locales), plus utilisée. */
      snapshot: unknown
      live: Live | null
    }
  }
}
