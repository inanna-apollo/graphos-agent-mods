// The surface module behind Shimmer: Claude Code's spinner glyph and a
// shimmer sweeping across the text, on the surface's own frame clock, so
// only this region redraws and not the pane. Runs on the drawing thread:
// no $, no timers but `surface.every`, which ends when the instance
// unmounts (the line leaves the pane's tree, or the pane closes).

import type { ClientModule } from 'claude-code'

import { COLOR, FRAME_MS, GLYPH_COLUMNS, glyphAt, sweepAt } from './frames.ts'

export type SpinnerProps = { text: string }
type State = { step: number }

const Spinner: ClientModule<SpinnerProps, State> = (props, surface) => {
  const { Box, Text } = surface.elements
  const step = surface.state?.step ?? 0
  if (surface.state === undefined) {
    // Once per instance: the state marks the clock as started.
    surface.setState({ step })
    let next = step
    surface.every(FRAME_MS, () => {
      next += 1
      surface.setState({ step: next })
    })
  }
  const { before, lit, after } = sweepAt(props.text, step)
  return (
    <Box flexDirection="row">
      <Box width={GLYPH_COLUMNS} flexShrink={0}>
        <Text color={COLOR.base}>{glyphAt(step)}</Text>
      </Box>
      <Box flexGrow={1} flexShrink={1}>
        <Text wrap="wrap">
          {before !== '' && <Text color={COLOR.base}>{before}</Text>}
          {lit !== '' && <Text color={COLOR.lit}>{lit}</Text>}
          {after !== '' && <Text color={COLOR.base}>{after}</Text>}
        </Text>
      </Box>
    </Box>
  )
}

export default Spinner
