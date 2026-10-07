// The annotated IR: one record per Agent Services call, the only thing the pane and the
// summary are built from. Declared in the $.state contract (types/index.d.ts),
// which must stand alone; this module re-exports it for src/.

export type {
  OpType,
  Policy,
  FieldSchema,
  ArgIR,
  Renderer,
  OmittedArg,
  Paging,
  FieldIR,
  Validation,
  CallState,
  Summary,
  CallIR,
  CallOutcome,
  CallWeight,
  WeightField,
  CheckOutcome,
  Checks,
  RootFit,
  TrustFit,
  CallAgent,
} from '../types'
