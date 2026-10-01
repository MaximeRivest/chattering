# Universal agent traces: the landscape after the public discussion

Research date: **2026-09-30**. This is a research report, not a ratified format or implementation plan.

## Bottom line

The replies point to overlapping solutions to different problems, not simply competing file formats. There is a strong case for interoperable conversation records. There is not yet a demonstrated case for replacing existing tracing and trajectory standards with a new base format.

The most promising contribution is a **conversation-portability profile**: shared rules for identity, branches, context changes, provenance and continuation, with tested mappings to existing formats. lm15 can supply its request/response and provider-adaptation layer; it need not own every surrounding concept.

This is a recommendation, not a claim that the missing pieces cannot be represented in today's formats. OpenTelemetry, ATIF, and RDF all have extension mechanisms. Putting arbitrary data in an extension is possible; making independent readers agree on its meaning requires a contract and tests.

## Scope and evidence

I followed the supplied replies to current documentation and source repositories, including LangChain's September 24 launch, its coding-agent metadata contract and smithtune code, OpenTelemetry's current GenAI conventions and file exporter, CASS's connector documentation and canonical packet, Harbor's ATIF specification, W3C provenance standards, and continuation protocols.

These are documented capabilities and source inspection, **not local end-to-end compatibility tests**. I did not install these projects or send private conversation data to a service. Search did not identify a public repository or ontology for @lux's particular transcript store; the description of that implementation comes only from the supplied reply.

Repository heads observed during research:

| Repository | Commit |
|---|---|
| OpenTelemetry semantic-conventions-genai | `bcc7f9c2856fa7f4feb753f54d4ebba9455cc3dc` |
| Harbor | `9b168361ebe973113640b9183b03cbd7884d720e` |
| LangChain smithtune | `fdc675820cfe97b4637ed05c8c7315e87746e212` |
| CASS | `070e4254bd8b97718e3792c4b13749eabdc06f5e` |
| moshi-labs/handoff | `8e6ca3fd4059a8f81df9e93a0995cd720b5d6318` |

Pages and files were read from live main branches; these heads identify the research snapshot, rather than proving every download was an atomic checkout.

## 1. The map

| Family | Main question | Examples | Relevance |
|---|---|---|---|
| Execution observability | What ran, what did it call, how long did it take? | OpenTelemetry GenAI, OpenInference, Phoenix, Langfuse, LangSmith traces | Gantt timing, costs, backend and database correlation |
| Readable trajectories and training data | What did the agent say, do and observe? | LangSmith Trajectories, Harbor ATIF | Review, evaluation, training, interchange |
| Existing conversation archives | Where is all my history, across agents and machines? | CASS, cass-memory, handoff | Discovery, importers, search, migration and memory |
| Provenance and meaning | Which things produced, revised or depended on which other things? | RDF/OWL, W3C PROV, JSON-LD | Merges, authorship, derivation, knowledge graphs |
| Continuation and execution state | What is required to proceed from this point? | LangGraph checkpoints, OpenHands persistence, ACP session loading | Conversation handoff versus restoring a running program |
| Code attribution | Which agent/person produced these lines? | Agent Trace | Connecting conversation activity to file changes |

One product may cover several rows. These are lenses, not mutually exclusive categories.

## 2. Pamela Fox and Clay Smith: OpenTelemetry belongs in the architecture

### Verified

OpenTelemetry represents executions as spans, with parent relationships and links. GenAI conventions include model and agent operations, tools, conversation IDs, request metadata, usage and optional content capture. The current model-span document includes `gen_ai.input.messages`, `gen_ai.output.messages`, `gen_ai.system_instructions`, `gen_ai.tool.definitions`, a context-compaction indicator and previous-response references. Message content has JSON schemas, including reasoning and tool-related parts.

The Collector file exporter **already writes a single local file by default**. With JSON and no compression, each line is a JSON object. There is a corresponding OTLP JSON file receiver. The file exporter is marked alpha for traces and warns about field stability; the GenAI conventions inspected are marked Development. Mature OpenTelemetry infrastructure and evolving GenAI conventions should not be conflated.

Sources:
- [Trace concepts, spans and links](https://opentelemetry.io/docs/concepts/signals/traces/)
- [Current GenAI model-span conventions](https://github.com/open-telemetry/semantic-conventions-genai/blob/main/docs/gen-ai/gen-ai-spans.md)
- [Agent conventions](https://github.com/open-telemetry/semantic-conventions-genai/blob/main/docs/gen-ai/gen-ai-agent-spans.md)
- [Input-message schema](https://github.com/open-telemetry/semantic-conventions-genai/blob/main/model/gen-ai/gen-ai-input-messages.json)
- [File exporter](https://github.com/open-telemetry/opentelemetry-collector-contrib/tree/main/exporter/fileexporter)
- [OTLP](https://opentelemetry.io/docs/specs/otlp/)

### Interpretation

Pamela's question is a valuable correction: single-file packaging is **not** a reason to reject OpenTelemetry. Local-first storage does not require inventing a tracing transport.

Clay's proposed bridge is also concrete: a model asks for a tool; that tool calls a backend; the backend queries a database. With instrumentation and propagated context, those operations can be correlated. A transcript-only format would otherwise lose that connection or recreate it separately.

However, recording that operations ran inside a turn does not automatically specify which sibling answers belong in the next prompt. That is an application semantic to standardize, not a structural impossibility in OpenTelemetry.

Content capture is optional and can be filtered, truncated, or sampled. An ordinary monitoring pipeline must not silently be assumed to be a complete archival record. A portability profile would have to say which evidence is present, absent, transformed or dropped.

Useful ecosystem references:
- [OpenInference specification](https://github.com/Arize-ai/openinference/blob/main/spec/README.md)
- [Phoenix](https://github.com/Arize-ai/phoenix)
- [Langfuse data model](https://langfuse.com/docs/observability/data-model)

## 3. Viv's pointer: what LangChain actually launched

### Verified

[Trajectories now in LangSmith](https://www.langchain.com/blog/langsmith-trajectories-tracing), published **September 24, 2026**, describes a chronological conversational view of an agent session.

Its model is:

- **Run:** one operation.
- **Trace:** the nested runs for an operation or turn.
- **Thread:** linked traces across a session.
- **Trajectory:** a readable projection that deduplicates the session's messages and orders them by first appearance, removing execution nesting.

The underlying trace remains the detailed source. Trajectories support expert review, online evaluation, annotation queues, datasets and fine-tuning workflows.

The separate [coding-agent metadata contract](https://docs.langchain.com/langsmith/coding-agent-metadata-contract) lists integrations for Claude Code, Codex, Deep Agents, Cursor, Pi, OpenCode and Copilot. It defines stable thread identity, runtime/version, repository context where known, and distinctions for subagents, tools and interruption.

Its [trajectory integrations guide](https://docs.langchain.com/langsmith/trajectory-view-integrations) documents extractors for multiple native message shapes. This is not limited to programs written in LangChain.

The open-source [smithtune tool](https://github.com/langchain-ai/smithtune) supplies especially useful evidence:

- [`bindings.py`](https://github.com/langchain-ai/smithtune/blob/main/src/smithtune/bindings.py) binds each assistant message to its producing run/trace and its available tools. Unknown tool availability is distinguished from an empty list of tools.
- [`dataset.py`](https://github.com/langchain-ai/smithtune/blob/main/src/smithtune/dataset.py) validates tool call/result pairs and converts training messages. Its training conversion deliberately does not copy signatures or encrypted reasoning state into training targets. This is appropriate for training; it is not evidence that the original trace discards that state.

### Interpretation

This is substantial overlap with our proposal, and an excellent potential collaborator.

It is important not to equate the new product view, its API response, a training export, and a complete portable archive. They have different promises. I found documentation, metadata contracts and consumer code; I did **not** establish a separate, independently versioned interchange specification for the whole trajectory comparable to ATIF's RFC.

Questions for Viv:

1. Is there a public, versioned trajectory schema and standalone validator?
2. Is chronology merely a view, or the underlying interchange model?
3. How are branches, alternate answers and merges represented?
4. Are per-turn tool definitions, provider replay state and context mutations available in the portable form?
5. Would they welcome a tested lm15 mapping rather than a replacement message vocabulary?

## 4. Harbor ATIF: the existing interchange candidate

[ATIF's specification](https://github.com/harbor-framework/harbor/blob/main/rfcs/0001-trajectory-format.md) defines a trajectory with agent metadata and ordered steps containing messages, actions, observations and metrics.

The inspected version also covers tool definitions, multimodal content, embedded or external subagents, continuation files, copied-context flags, and context-management conventions. A replacement-context boundary is more specific than a vague note that compaction happened: it says what subsequent context comprises.

This is already much closer to the interchange problem than my earlier description of 'linear benchmark steps' suggested.

Its sequential steps and hierarchical subagents should be evaluated against Chattering's alternative-answer and merge graph. The existence of an `extra` field means additional concepts can be carried, but interoperable readers still need shared interpretation.

**Recommendation:** run the difficult Chattering examples through ATIF before deciding to define a replacement.

## 5. Chase Davis's @doodlestein pointer: CASS and cass-memory

[Jeff Emanuel's GitHub profile](https://github.com/Dicklesworthstone) links the identity to @doodlestein.

### CASS

[Coding Agent Session Search (cass)](https://github.com/Dicklesworthstone/coding_agent_session_search) documents **32 local agent connectors**, a searchable cross-agent timeline, remote-machine sources, semantic search, exports and native resumption commands.

The source contains a [versioned canonical ConversationPacket](https://github.com/Dicklesworthstone/coding_agent_session_search/blob/main/src/model/conversation_packet.rs), separating canonical content and provenance from search/analytics projections.

That architecture is directly relevant to Chattering. It is evidence that discovery and normalizing many agent histories are already substantial existing work.

The documented normalized model is conversation → message → snippet. Some connectors explicitly select the active branch or flatten tool content. Documented resume examples invoke the original agent, such as `omp --resume` or `grok --resume`. This does **not** by itself demonstrate provider-exact migration into lm15 or preservation of every branch and merge.

The repository's [license](https://github.com/Dicklesworthstone/coding_agent_session_search/blob/main/LICENSE) includes an OpenAI/Anthropic rider; do not describe it as unqualified MIT or assume code can be copied into a shared standard without reviewing licensing.

### cass-memory

[cass-memory](https://github.com/Dicklesworthstone/cass_memory_system) builds cross-agent memory from histories, including lessons, feedback, confidence tracking and anti-patterns.

This directly overlaps the reply about analyzing failures, lessons and unfinished work. It is a downstream consumer of history, not a reason for those inferred lessons to become immutable historical facts.

### Migration precedent

[moshi-labs/handoff](https://github.com/moshi-labs/handoff) documents native parsers → NeutralSession → native writers for Claude Code, Codex, OpenCode and Antigravity. Its documented fallback behavior includes narrative tool representations, a bridge digest and zeroed token counters. It is useful precedent, but these are explicit losses, not proof of exact round-trip compatibility.

## 6. Lux's question: format versus ontology

Lux's reply asks what the relationships *mean*, rather than which file stores them. That distinction is important.

- JSON/JSONL is a way to write data down.
- RDF describes a graph of statements and relationships.
- OWL can define vocabulary and logical relationships.
- [W3C PROV](https://www.w3.org/TR/prov-overview/) already models entities, activities, agents and derivation.
- [JSON-LD](https://www.w3.org/TR/json-ld11/) can express linked data using JSON.

A merge is a natural example: two answers are used by an activity that generates a new answer. People, tools and models participate; provenance links explain where each result came from.

We do not need to require every CLI to become an OWL/RDF system to benefit from precise relationship definitions. A JSON representation with a documented PROV/RDF mapping is an option.

**Unverified lead:** I did not find Lux's specific public schema or repository. Ask for a sample export showing a branch, merge and compaction boundary. Do not infer the fidelity or capabilities of that store from one reply.

Trade-off: a rich graph model is expressive, but a small CLI needs straightforward local files, simple queries and validators. Define the meanings first; avoid requiring reasoning infrastructure merely to display a conversation.

## 7. Background analysis: facts and conclusions are different layers

The reply about failed tools, learnings, gaps and technical debt describes valuable downstream applications. LangSmith's [Engine v2 announcement](https://www.langchain.com/blog/langsmith-engine-agents-fine-tuning-trajectories) also describes automated issue detection and evaluation; cass-memory describes history-derived lessons.

Recommended separation:

- **Recorded fact:** a command returned exit status 1.
- **Interpretation:** that tool invocation was a mistake. Exit status 1 alone is not proof; the user may have requested a failing test.
- **Derived claim:** a task remains unresolved.
- **Rating/correction:** a person agrees or disagrees.

Store analysis as attributed, versioned annotations with evidence references. A later analysis may supersede an earlier one without changing what actually happened. This is a useful role for FunctAI calls and ratings linked to the history.

## 8. Continuation is not one operation

These promises should be named separately:

1. **Display:** show the history.
2. **Context handoff:** send a faithful or explicitly adapted history to a new model.
3. **Native resume:** reopen the original tool's saved session.
4. **Runtime recovery:** restore tool processes, permissions, filesystem/worktree state and other program state.

[LangGraph persistence](https://docs.langchain.com/oss/python/langgraph/persistence) and [time travel](https://docs.langchain.com/oss/python/langgraph/use-time-travel) concern execution-state checkpoints. Replaying can execute model and tool calls again.

[OpenHands](https://github.com/OpenHands/docs/blob/main/sdk/arch/sdk.mdx) combines conversation state, events, tools and persistence.

[ACP session loading](https://agentclientprotocol.com/protocol/session-setup) concerns interaction with an agent that supports loading and history replay. It is not automatically a cross-provider archive format.

[Agent Trace](https://agent-trace.dev/) primarily concerns code attribution, not an entire resumable conversation. It can link file changes back to the other layers.

A format must not silently turn imported historical tool calls into new commands. Nor does possessing a provider's continuation state guarantee a different account or model accepts it. Import and continuation need capability checks and explicit loss reports.

## 9. Changes to our earlier design thinking

The visual guide should currently be treated as a conceptual sketch, not a settled schema.

1. **Do not reject OTel for packaging.** Local file capture already exists.
2. **Do not overload one parent relation.** Execution parent ('this tool ran inside this turn'), conversation predecessor ('this answer follows that question'), and derivation ('this answer merges those two') have different meanings.
3. **A path does not prove the exact request.** System instructions, tool availability, context edits, provider adaptation and server-held state also matter. Captured exchanges and reconstructed histories need different evidence labels.
4. **Do not call a pointer lossless archival storage.** A hash detects change; it does not recover deleted source content. Durable archives must retain the bytes and referenced assets they promise to preserve.
5. **Do not hide suspected duplicates automatically.** Import similarity is evidence for a possible relationship, not proof. Native IDs, provenance, content fingerprints and user review need a stated policy.
6. **Do not promise effortless native round-trips.** Foreign agents may not understand custom metadata or exact provider state. Retaining opaque bytes is different from the target agent understanding them.
7. **Treat monitoring, training, and continuation as profiles.** Training may correctly omit opaque state; continuation may need it. Monitoring may intentionally omit sensitive text. Each consumer should know what it is receiving.
8. **Choose conformance examples before choosing field names.** Independently validated agreement is the defensible contribution.

## 10. A practical next step

Create one small, permission-safe test corpus, with real and synthetic difficult cases:

- Pi, Claude Code, Codex and OpenCode imports.
- A matched tool call/result pair and an interrupted unmatched call.
- Two parallel answers, a retry, a merge, and a simpler rewrite.
- A changed tool list and a compaction boundary.
- Same-provider and cross-provider continuation, with explicit provider-state outcomes.
- A subagent, a source-import duplicate, an image attachment, missing source data.
- Inferred versus recorded timings.

For each candidate (OTel profile, ATIF, LangSmith trajectory export, our proposed record), record **preserved / transformed / omitted / unknown**, not just 'supports agents'. Compare both directions, and distinguish storing metadata from actually resuming execution.

The smallest missing contract should emerge from that exercise.

Priority conversations:

1. **Viv / LangChain:** obtain the concrete portable schema and confirm what a trajectory export promises.
2. **Pamela / OTel community:** test a durable local-file profile, content capture, span links and conversation/context relationships.
3. **Jeff / CASS:** discuss connector sharing, provenance and what is intentionally flattened; clarify licensing before code reuse.
4. **Lux:** obtain the ontology and sample branch/merge/compaction records.
5. **Harbor maintainers:** discuss extending ATIF only where a reproducible example demonstrates a gap.

Tarun's offer to collaborate is valuable, but the supplied reply alone does not identify a particular technical implementation. Ask which piece he wants to work on rather than guessing.

**A concise framing for the public discussion:**

> I want conversation portability, not another telemetry backend: one local history across coding agents, with explicit branches, context changes and provenance, that can be inspected and continued through another harness. I want to reuse OTel and existing trajectory formats wherever they already carry the necessary meaning, and prove the remaining mappings with tests.
