//@flow

import type {Graphite, Graph, ID} from './stdlib'
import {getGraph, readRef} from './stdlib'

/** Names of priority groups */
type PriorityTag = 'child' | 'pure' | 'barrier' | 'sampler' | 'effect'

/**
 * Position in the current branch,
 * including call stack, priority type
 * and index of next step in the executed Graph
 */
type Layer = {|
  /** index of first step */
  +idx: number,
  +stack: Stack,
  +type: PriorityTag,
  +id: number,
|}

/** Call stack */
type Stack = {
  value: any,
  a: any,
  b: any,
  parent: Stack | null,
  node: Graph,
}

/** Queue as linked list */
type QueueItem = {
  right: QueueItem | null,
  value: Layer,
}
type QueueBucket = {
  first: QueueItem | null,
  last: QueueItem | null,
  size: number,
}

/** Queue as skew heap */
type Heap = {
  /** heap node value */
  v: Layer,
  /** left heap node */
  l: Heap | null,
  /** right heap node */
  r: Heap | null,
}

/** Dedicated local metadata */
type Local = {
  skip: boolean,
  fail: boolean,
  ref: ID,
  scope: {[key: string]: any, ...},
}

let heap: Heap | null = null

const merge = (a: Heap | null, b: Heap | null): Heap | null => {
  if (!a) return b
  if (!b) return a

  let ret
  const isSameType = a.v.type === b.v.type
  if (
    /**
     * if both nodes has the same PriorityType
     * and first node is created after second one
     */
    (isSameType && a.v.id > b.v.id) ||
    /** if first node is "sampler" and second node is "barrier" */
    (!isSameType && a.v.type === 'sampler')
  ) {
    ret = a
    a = b
    b = ret
  }
  ret = merge(a.r, b)
  a.r = a.l
  a.l = ret

  return a
}

/** queue buckets for each PriorityType */
const queue: QueueBucket[] = []
let ix = 0
while (ix < 5) {
  /**
   * although "sampler" and "barrier" are using heap instead of linked list,
   * their buckets are still useful: they maintains size of heap queue
   */
  queue.push({first: null, last: null, size: 0})
  ix += 1
}

const deleteMin = () => {
  for (let i = 0; i < 5; i++) {
    const list = queue[i]
    if (list.size > 0) {
      /**
       * second bucket is for "barrier" PriorityType (used in combine)
       * and third bucket is for "sampler" PriorityType (used in sample and guard)
       */
      if (i === 2 || i === 3) {
        list.size -= 1
        const value = heap.v
        heap = merge(heap.l, heap.r)
        return value
      }
      if (list.size === 1) {
        list.last = null
      }
      const item = list.first
      list.first = item.right
      list.size -= 1
      return item.value
    }
  }
}
const pushFirstHeapItem = (
  type: PriorityTag,
  node: Graph,
  parent: Stack | null,
  value: any,
) =>
  pushHeap(
    0,
    ({
      a: null,
      b: null,
      node,
      parent,
      value,
    }: Stack),
    type,
  )
const pushHeap = (idx: number, stack: Stack, type: PriorityTag, id = 0) => {
  const priority = getPriority(type)
  const bucket: QueueBucket = queue[priority]
  const value: Layer = {
    idx,
    stack,
    type,
    id,
  }
  /**
   * second bucket is for "barrier" PriorityType (used in combine)
   * and third bucket is for "sampler" PriorityType (used in sample and guard)
   */
  if (priority === 2 || priority === 3) {
    heap = merge(heap, {v: value, l: 0, r: 0})
  } else {
    const item: QueueItem = {
      right: null,
      value,
    }
    if (bucket.size === 0) {
      bucket.first = item
    } else {
      bucket.last.right = item
    }
    bucket.last = item
  }
  bucket.size += 1
}

const getPriority = (t: PriorityTag) => {
  switch (t) {
    case 'child':
      return 0
    case 'pure':
      return 1
    case 'barrier':
      return 2
    case 'sampler':
      return 3
    case 'effect':
      return 4
    default:
      return -1
  }
}

const barriers = new Set()

let alreadyStarted = false

/** main execution method */
const exec = () => {
  const lastStartedState = alreadyStarted
  alreadyStarted = true
  const meta = {
    stop: false,
  }
  let graph
  let value
  mem: while ((value = deleteMin())) {
    const {idx, stack, type} = value
    graph = stack.node
    const local: Local = {
      skip: false,
      fail: false,
      ref: '',
      scope: graph.scope,
    }
    for (let stepn = idx; stepn < graph.seq.length && !meta.stop; stepn++) {
      const step = graph.seq[stepn]
      const data = step.data
      switch (step.type) {
        case 'barrier': {
          const id = data.barrierID
          const priority = data.priority
          if (stepn !== idx || type !== priority) {
            if (!barriers.has(id)) {
              barriers.add(id)
              pushHeap(stepn, stack, priority, id)
            }
            continue mem
          }
          barriers.delete(id)
          break
        }
        case 'mov': {
          let value
          //prettier-ignore
          switch (data.from) {
            case 'stack': value = stack.value; break
            case 'a': value = stack.a; break
            case 'b': value = stack.b; break
            case 'value': value = data.store; break
            case 'store':
              value = readRef(graph.reg[data.store.id])
              break
          }
          //prettier-ignore
          switch (data.to) {
            case 'stack': stack.value = value; break
            case 'a': stack.a = value; break
            case 'b': stack.b = value; break
            case 'store':
              graph.reg[data.target.id].current = value
              break
          }
          break
        }
        case 'check':
          switch (data.type) {
            case 'defined':
              local.skip = stack.value === undefined
              break
            case 'changed':
              local.skip = stack.value === readRef(graph.reg[data.store.id])
              break
          }
          break
        case 'filter':
          /**
           * handled edge case: if step.fn will throw,
           * tryRun will return null
           * thereby forcing that branch to stop
           */
          local.skip = !tryRun(local, data, stack)
          break
        case 'run':
          /** exec 'compute' step when stepn === idx */
          if (stepn !== idx || type !== 'effect') {
            pushHeap(stepn, stack, 'effect')
            continue mem
          }
        case 'compute':
          stack.value = tryRun(local, data, stack)
          break
      }
      meta.stop = local.fail || local.skip
    }
    if (!meta.stop) {
      for (let stepn = 0; stepn < graph.next.length; stepn++) {
        pushFirstHeapItem('child', graph.next[stepn], stack, stack.value)
      }
    }
    meta.stop = false
  }
  alreadyStarted = lastStartedState
}
export const launch = (unit: Graphite, payload: any, upsert?: boolean) => {
  if (unit.target) {
    payload = unit.params
    upsert = unit.defer
    unit = unit.target
  }
  if (Array.isArray(unit)) {
    for (let i = 0; i < unit.length; i++) {
      pushFirstHeapItem('pure', getGraph(unit[i]), null, payload[i])
    }
  } else {
    pushFirstHeapItem('pure', getGraph(unit), null, payload)
  }
  if (upsert && alreadyStarted) return
  exec()
}

/** try catch for external functions */
const tryRun = (local: Local, {fn}, stack: Stack) => {
  try {
    return fn(stack.value, local.scope, stack)
  } catch (err) {
    console.error(err)
    local.fail = true
  }
}
