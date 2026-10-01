// Proposed Chattering application contract. Design only, not a wire protocol.
// Native/ACP codecs live behind it. Authority fields are resolved server-side.
export type Revision = string;
export type Capability =
  | { state: 'supported'; evidence: Revision }
  | { state: 'unsupported' | 'blocked' | 'unknown' | 'requires-restart'; reason: string; evidence: Revision };
export interface ConnectionRef {
  installationId: string; adapterId: string; hostId: string;
  accountScopeId: string; workspaceId: string; protocolRevision: Revision;
}
export interface Destination {
  conversationId: string; generation: Revision; connection: ConnectionRef;
  native: { sessionId: string; sourceKey: string; branchAnchor: string | null; incarnation: string } | null;
}
export interface ConfigControl {
  id: string; label: string; description?: string; category: string;
  scope: 'message' | 'session' | 'workspace' | 'account';
  takesEffect: 'now' | 'next-turn' | 'restart'; capability: Capability;
  schema: { type: 'select'; values: { id: string; label: string }[] }
    | { type: 'boolean' } | { type: 'number'; min: number; max: number; step?: number }
    | { type: 'unsupported'; nativeType: string };
  current: unknown; revision: Revision;
}
export interface Descriptor {
  destination: Destination; revision: Revision; policyRevision: Revision;
  display: { name: string; markId?: string; transportLabel: string; connectionLabel: string };
  capabilities: Record<string, Capability>; controls: ConfigControl[];
  modelRoles: { id: string; label: string; currentModel: string | null; catalogRevision: Revision }[];
  discovery: { observedAt: string; expiresAt?: string; startupEffects: string[] };
}
export type ContextPart = {
  id: string; kind: 'file' | 'image' | 'text' | 'history' | 'host-brief';
  contentRef: string; digest: string; origin: string;
  trust: 'user-input' | 'historical-data' | 'trusted-host';
  requestedLifetime: 'message' | 'session';
  actualRetention: 'message' | 'native-history' | 'unknown';
};
export interface SendEnvelope {
  composerId: string; draftId: string; draftRevision: Revision;
  destination: Destination; descriptorRevision: Revision; policyRevision: Revision;
  idempotencyKey: string; intent: 'send' | 'queue' | 'steer';
  expectedTurnId?: string; text: string; parts: ContextPart[];
  requestedControls: Record<string, unknown>; coauthorRefs: string[];
}
export type SubmissionReceipt = {
  id: string; digest: string; runId: string | null; nativeTurnId: string | null;
  state: 'prepared' | 'accepted' | 'queued' | 'running' | 'delivery-unknown' | 'completed' | 'cancelled' | 'failed' | 'incomplete';
  effectiveControls: Record<string, unknown>; warnings: string[];
};
export interface NativeEvidence { installationId: string; nativeEventId: string; protectedRecordRef: string; schemaVersion: string; }
export type DisplayEvent = {
  sequence: number; runId: string; destination: Destination;
  kind: 'text' | 'tool' | 'plan' | 'question' | 'permission' | 'usage' | 'configuration' | 'state' | 'unknown';
  operation: 'append' | 'upsert'; payload: unknown; evidence: NativeEvidence;
};
export interface Approval {
  id: string; runId: string; sessionIncarnation: string; nativeRequestId: string;
  expiresAt?: string; subject: string;
  choices: { id: string; label: string; effect: 'allow' | 'deny' | 'other'; scope: 'once' | 'session' | 'workspace' | 'account' | 'unknown' }[];
}
export interface HandoffPlan {
  token: string; source: Destination; target: ConnectionRef; expiresAt: string;
  manifest: { originRef: string; digest: string; handling: 'preserved' | 'quoted' | 'summarized' | 'omitted' | 'unavailable'; reason?: string }[];
  blockers: string[]; confirmations: string[]; estimatedTokens?: { value: number; method: string };
}
export interface ComposerController {
  readonly id: string;
  getDraft(): { text: string; revision: Revision; parts: ContextPart[] };
  bind(destination: Destination): Promise<void>;
  subscribe(listener: (state: unknown) => void): () => void;
  describe(): Promise<Descriptor>;
  complete(input: { text: string; cursor: number; selectionEnd: number; draftRevision: Revision }): Promise<unknown>;
  applyCompletion(token: string, choiceId: string): Promise<void>;
  requestConfiguration(id: string, value: unknown, expectedRevision: Revision): Promise<Descriptor>;
  submit(intent: SendEnvelope['intent']): Promise<SubmissionReceipt>;
  dispose(): void;
}
// Coordinator validates actor/policy/session revisions independently of client data.
// Optional adapter interfaces should be split by ability, not one mandatory giant class.
export interface InteractiveAdapter {
  describe(destination: Destination, signal: AbortSignal): Promise<Descriptor>;
  applyConfiguration(destination: Destination, control: string, value: unknown, revision: Revision): Promise<Descriptor>;
  submit(envelope: SendEnvelope, signal: AbortSignal): Promise<SubmissionReceipt>;
  stop(runId: string): Promise<{ confirmed: boolean; reason?: string }>;
  respond(approval: Approval, nativeChoiceId: string): Promise<void>;
}
export interface HistoryAdapter {
  read(sourceKey: string): AsyncIterable<{ nativeId: string; kind: string; content: unknown; evidence: NativeEvidence }>;
  prepareImport?(plan: HandoffPlan): Promise<{ provisionalSessionId: string; verified: boolean }>;
}
