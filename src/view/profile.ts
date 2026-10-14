// Which of the pane's blocks a kind of Agent Services call draws (src/view/kinds.ts
// picks one per call). Its own module so the planner can take it without the
// kinds' imports. Pure: no $.

/** Which of the pane's blocks a kind of call draws, and how its form reads. */
export type Profile = {
  /** A lookup: no Haiku headline, RESULT, CHANGES, trust line or deep links. */
  isLookup: boolean
  /** The flags line (writes, denials, oversized fields). */
  flags: boolean
  /** The notes that say policy is unknown or unchecked: only where the call is about policy. */
  policyNotes: boolean
  /** `no limit` and `large: limit N`: only for an operation that would run. */
  limitNotes: boolean
  /** Arguments as the schema declares them (every one, with its type), not as a call set them. */
  isDeclared: boolean
  /** The label of the row over the field tree. */
  returnsLabel: string
  /** Scalar, enum, input and union introspection have member notes instead of a selectable-field tree. */
  hasFieldTree?: boolean
  /** The root's verb, in place of the one its name and shape give. */
  verb?: string
  /** Field cards say the field's policy. */
  policyFacts: boolean
}

export const EXECUTE_PROFILE: Profile = { isLookup: false, flags: true, policyNotes: true, limitNotes: true, isDeclared: false, returnsLabel: 'return type', policyFacts: true }
