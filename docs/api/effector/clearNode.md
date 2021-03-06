---
id: clearNode
title: clearNode
hide_title: true
---

Method for destroy stores, events, effects, subscriptions and domains

# `clearNode(unit, config?: {deep?: boolean}): void`

#### Arguments

1. `unit` ([_Store_](Store.md)/[_Event_](Event.md)/[_Effect_](Effect.md)/[_Domain_](Domain.md)): unit to be erased
2. `config: ({deep?: boolean})` (optional): config object
   - `deep: boolean` (optional): erase node _and_ all of its computed values

#### Returns

`void`

#### Example 1

```js
import {createStore, createEvent, clearNode} from 'effector'

const inc = createEvent()
const store = createStore(0).on(inc, x => x + 1)
inc.watch(() => console.log('inc called'))
store.watch(x => console.log('store state: ', x))
// => store state: 0
inc()
// => inc called
// => store state: 1
clearNode(store)
inc()
// => inc called
```

[Try it](https://share.effector.dev/WjuSl6aN)

#### Example 2 (with deep)

```js
import {createStore, createStoreObject, createEvent, clearNode} from 'effector'

const inc = createEvent()
const trigger = inc.prepend(() => {})
const store = createStore(0).on(inc, x => x + 1)
trigger.watch(() => console.log('trigger called'))
inc.watch(() => console.log('inc called'))
store.watch(x => console.log('store state: ', x))
// => store state: 0
trigger()
// => trigger called
// => inc called
// => store state: 1
clearNode(trigger, {deep: true})
trigger()
// no reaction
inc()
// no reaction!
// all units, which depends on trigger, are erased
// including inc and store, because it depends on inc
```

[Try it](https://share.effector.dev/EkETZtKI)
