# simple-pomdp-system

Proactive initiative planner for chat-agent.

It persists only:

- `TopicState`
- `InteractionLog`

Canonical `TurnRecord` history is read from memory-system and is not copied here.

At runtime it:

1. reads recent turns, shared UserMemory, TopicState, and InteractionLog through
   injected context sources
2. returns exactly one `DialogueDecision`: `explore`, `refine`, or `exploit`
3. returns conversation-trigger output to the caller, or enqueues one scheduled
   background instruction
4. links the later human reaction with `sourceInteractionId`
5. treats no response as an observation without changing TopicState

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
