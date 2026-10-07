// The snapshot feature's two options, `snapshots` and `snapshotWidths`. Not in the manifest (a person never sees them), so unset is the normal case: off, at the default widths. Pure.

export const DEFAULT_WIDTHS = [50, 64, 84]

export type SnapshotOptions = { isOn: boolean; widths: number[] }

/** `snapshots` and `snapshotWidths` from the plugin's options, when a settings file sets them; the defaults otherwise. */
export function snapshotOptionsOf(options: unknown): SnapshotOptions {
  const o = typeof options === 'object' && options !== null ? (options as Record<string, unknown>) : {}
  const isOn = o.snapshots === true || o.snapshots === 'true'
  const parsed = (typeof o.snapshotWidths === 'string' ? o.snapshotWidths : '')
    .split(',')
    .map(part => Number.parseInt(part.trim(), 10))
    .filter(n => Number.isFinite(n) && n >= 20 && n <= 300)
  return { isOn, widths: parsed.length > 0 ? [...new Set(parsed)] : DEFAULT_WIDTHS }
}
