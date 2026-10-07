// A live status line, `<Shimmer kit={kit} text="checking policy…" />`.
//
// Where the kit carries `Client` (terminal and desktop, and only until a
// fault: the hooks module leaves it out after one), the line is the surface
// module ./spinner.tsx: Claude Code's spinner and a shimmer, animated on the
// surface's frame clock. Elsewhere it is the still `✻ text`, dimmed. The
// text is the same either way; every string handed in is already escaped.

import type { Kit } from '../kit.ts'
import { Note } from '../ui/index.tsx'
import { STILL } from './frames.ts'

/**
 * `id` keys the Client instance (its timer and frame): two live lines in one
 * pane need two. The instance lives while a line with that key stays drawn.
 */
export function Shimmer({ kit, text, id = 'shimmer' }: { kit: Kit; text: string; id?: string }) {
  const { Client } = kit
  if (Client === undefined) {
    return (
      <Note kit={kit} glyph={STILL} isDim>
        {text}
      </Note>
    )
  }
  return <Client key={id} module="./spinner.tsx" props={{ text }} />
}
