# simple-pomdp-system

Lightweight proactive dialogue system based on `docs/simple_pomdp.md`.

It persists:

- `TurnRecord`
- `UserBelief`
- `InteractionLog`

At runtime it:

1. reads belief and recent turns
2. loads broad initial domain candidates for breadth exploration
3. generates `DialogueCandidate`s
4. mixes broad random exploration with refine/exploit candidates
5. selects one candidate or `do_nothing`
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
