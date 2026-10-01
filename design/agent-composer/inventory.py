"""Reproduce the production-source inventory for the composer design review.
Text search is a discovery aid, not a call graph or proof of complete coverage.
Hashes refer to the working files, including pre-existing uncommitted changes.
"""
from pathlib import Path
import re,json,hashlib,subprocess,datetime
HERE=Path(__file__).resolve().parent
ROOT=HERE.parent.parent
anchors={
 'app.html':['agentComposerHtml','wireAgentComposer','openModelPicker','showThinkingPicker','currentSpeechTarget','agentSpeechEvent','buildUiRequest','runCompaction','/api/node/send'],
 'conversation-draft.js':['newDraft','draftAsCurrent','draftSetModels','showDraft'],
 'conversation-reader.js':['openConversationMerge','regenerateQuestion','renderLiveInGroups'],
 'ask-bubble.js':['askBubbleLoadTarget','askSubmit','askBubblePaintControls','askBubbleCodexPick'],
 'codex-ui.js':['menusFor','choices','pickModel','pickEffort','pickAccess'],
 'harness-composer-ui.js':['createClient','let uninstall','function install'],
 'harness/pi-composer.js':['createPiComposer','snapshot','generation'],
 'harness/codex-composer.js':['complete','apply','commands'],
 'harness/codex-runs.js':['async function send','followUps.get(sessionPath).push','target.onInjected','async function start'],
 'harness/codex.js':['async function openThread','function release','function codexHeadlessRun','function forkThread'],
 'harness/claude-code.js':['function claudeArgs','class ClaudeSession','function claudeHeadlessRun','claudeMenus'],
 'harness/codex-diffs.js':['function outcomeOf','function codexPatchCalls','function codexEditOps'],
 'harness/codex-transcript.js':['environmentCwd','parseCodexRollout','forked_from'],
 'server.js':['function principalFor','async function principalInProject','const codexRefused','function conversationKind','function sessionPathsFor','async function composeInPi','function scanAgentProcs','function runEventForwarder','async function startAgentRun','expectedVersion &&','expectedLeaf &&','function codexRuns','async function openConversationInTerminal','async function sendToConversation','async function sendFileFeedback','async function conversationDiffs','async function ledgerIngestConversation','async function filesAskTargetResponse','async function filesAskResponse','async function filesAskCodex','const draftStarts','async function startCodexConversation','async function startConversationFromDraft','async function startProjectConversation','async function voiceDelegateStart','async function voiceListen',"u.pathname === '/api/reviews/send'","u.pathname === '/api/run/ui-response'",'composeCoauthorsOf','restoreInterruptedRuns'],
 'people.js':['composeShareAttach','composeShareCheck'],
 'collab-client.js':['collabJoin','collabBindTextarea'],
 'pair.js':['withConversation','mountDocument','showsConversation'],
 'ai-commands.js':['const COMMANDS','validateRequest','buildPrompt'],
 'policy.js':["'/api/node/send'","'/api/file-feedback'","'GET /api/codex/menus'"],
 'platform.js':['findOnPath','isExecutable','isInside'],
 'step-changes.js':['const recorded =','recordedBy','rebuild'],
 'conversation-reviews.js':['buildConversationReview','sourceGroup'],
 'change-review-ui.js':['crPreview','/api/reviews/send'],
 'design/90-computers-linked.md':['Separate conversations','Who may use a link'],
 'design/tokens.css':['--r-composer','--theme-mode'],
}
reviewed=[]
for name,names in anchors.items():
 p=ROOT/name; raw=p.read_bytes(); text=raw.decode(); lines=text.splitlines(); hits=[]
 for anchor in names:
  matching=[i+1 for i,l in enumerate(lines) if anchor in l]
  if not matching: raise SystemExit(f'Missing evidence anchor: {name} / {anchor}')
  hits.append(dict(anchor=anchor,lines=matching))
 reviewed.append(dict(path=name,sha256=hashlib.sha256(raw).hexdigest(),lineCount=len(lines),anchors=hits,review='selected controlling paths, not every line'))
pattern=re.compile(r'\b(startAgentRun|startProjectConversation|startConversationFromDraft|piHeadlessRun|piBeginWarm|piQueuePrompt|codexHeadlessRun|claudeHeadlessRun|spawnAlacritty|sendToConversation|openModelPicker|showThinkingPicker)\s*\(')
files=list(ROOT.glob('*.js'))+list(ROOT.glob('*.ts'))+[ROOT/'app.html']
for folder in ['harness','extensions']:
 files+=list((ROOT/folder).rglob('*.js'))+list((ROOT/folder).rglob('*.ts'))
scan=[]
for p in sorted(set(files)):
 for i,line in enumerate(p.read_text().splitlines(),1):
  names=pattern.findall(line)
  if names: scan.append(dict(path=str(p.relative_to(ROOT)),line=i,symbols=names,text=line.strip()[:280]))
result=dict(capturedAt=datetime.datetime.now(datetime.timezone.utc).isoformat(),head=subprocess.check_output(['git','rev-parse','HEAD'],cwd=ROOT,text=True).strip(),scope='root JS/TS, app.html, harness and extensions; excludes vendor/runtime/test/design/dist; text matches include definitions',scannedFiles=len(set(files)),reviewed=reviewed,callSiteCandidates=scan,limits=['Indirect calls and runtime extension actions require integration coverage, not grep.','Concurrent edits can invalidate line numbers; resolve named anchors and compare hashes.'])
(HERE/'inventory.json').write_text(json.dumps(result,indent=2)+'\n')
print(f'{len(reviewed)} evidence files; {len(set(files))} scanned production files; {len(scan)} call/picker text-match candidates')
