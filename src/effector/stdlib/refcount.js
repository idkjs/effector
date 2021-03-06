//@flow

const stringRefcount = (): (() => string) => {
  let id = 0
  return () => (++id).toString(36)
}

export const nextUnitID = stringRefcount()
export const nextStepID = stringRefcount()
