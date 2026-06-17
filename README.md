# simple-pomdp-system

Lightweight proactive dialogue system based on `docs/simple_pomdp.md`.

It persists:

- `TurnRecord`
- `UserBelief`
- `InteractionLog`

At runtime it:

1. reads belief and recent turns
2. generates `DialogueCandidate`s
3. selects one candidate or `do_nothing`
4. enqueues a background instruction for the main agent
5. later observes user reaction and updates belief

Run the background loop with:

```bash
npm run start:background --prefix packages/simple-pomdp-system
```
