# simple-pomdp-system

Lightweight proactive dialogue system based on `docs/simple_pomdp.md`.

It persists:

- `TurnRecord`
- `UserBelief`
- `InteractionLog`

At runtime it:

1. reads belief and recent turns
2. loads broad initial domain candidates for breadth exploration
3. builds a compact situation summary with the current time and recent interactions
4. returns one `DialogueDecision`: explore, refine, exploit, or `do_nothing`
5. treats no response as ambiguous context rather than negative interest
6. enqueues a background instruction for the main agent
7. later observes user reaction and updates belief

The default broad domain candidates live in `domains/initial_domains.txt`.

Run the background loop with:

```bash
npm run start:background --prefix packages/simple-pomdp-system
```

`knowledge-access` uses separate Ollama settings for embeddings. Set:

- `OLLAMA_EMBEDDING_BASE_URL`
- `OLLAMA_EMBEDDING_MODEL`
- `OLLAMA_EMBEDDING_DIMENSION`

You can gate proactive interactions by hour with:

- `SIMPLE_POMDP_INTERACTION_START_HOUR`
- `SIMPLE_POMDP_INTERACTION_END_HOUR`

The system dispatches only when `startHour <= currentHour < endHour`. For example,
`10` and `24` allows interactions from 10:00 through 23:59.
