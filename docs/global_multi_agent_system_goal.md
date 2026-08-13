# Global Multi-Agent System: Codex ↔ OpenCode

> **Legacy document:** this file is retained for history and is superseded by
> [`global_multi_agent_system_goal_v2.md`](./global_multi_agent_system_goal_v2.md).
> The current MCP route is `orchestrator -> mcp-orchestrator`; the dedicated
> MCP agent denies edits and nested subagents. Do not use the older direct
> orchestrator routing examples below as implementation guidance.

## الهدف النهائي

الهدف هو بناء **Global Multi-Agent Orchestration System** يربط بين:

```text
Codex App
  ↓
Custom MCP Bridge
  ↓
OpenCode CLI
  ↓
OpenCode Agents / Subagents
```

هذا النظام يجب أن يكون **global** ويعمل مع أي repository تفتحه لاحقًا، وليس مرتبطًا بمشروع معيّن.

الفكرة الأساسية:

- Codex App يكون هو الأوركستريتور الأساسي.
- OpenCode CLI يكون backend لتنفيذ sub-agent tasks.
- Codex يقدر يستدعي OpenCode agents عبر MCP bridge.
- OpenCode يقدر يشتغل كـ backup orchestrator إذا Codex ما قدر يكمل بسبب context أو token limits.
- كل شيء يكون بسيط، واضح، قابل للاختبار، وقابل للصيانة.

---

## الصورة العامة للنظام

### الوضع الطبيعي

```text
User
  ↓
Codex App
  ↓
Codex Primary Orchestrator
  ↓
MCP Bridge
  ↓
OpenCode CLI
  ↓
Direct OpenCode Agent
  ↓
Result back to Codex
  ↓
Codex Review / Validation / Final Report
```

### وضع fallback

```text
User
  ↓
OpenCode CLI directly
  ↓
OpenCode Global Orchestrator
  ↓
OpenCode Subagents
  ↓
Continue work from Codex handoff or current repo state
```

---

## الأدوار الأساسية

## 1. Codex App

Codex هو القائد الأساسي عندما يكون متاحًا.

مسؤوليات Codex:

- فهم طلب المستخدم.
- وضع خطة بسيطة.
- تقسيم العمل إلى tasks صغيرة.
- اختيار agent مناسب لكل task.
- إرسال task packets مختصرة إلى OpenCode.
- استلام نتائج OpenCode.
- عمل review نهائي.
- تشغيل tests أو validation.
- إنتاج final report واضح.

Codex لا يجب أن يرسل كل history إلى OpenCode. يجب أن يرسل فقط context مختصر ومفيد.

---

## 2. MCP Bridge

الـ MCP bridge هو طبقة الربط بين Codex وOpenCode.

المسار المتوقع:

```text
<repo>\server.js
```

مسؤولياته:

- كشف agents المتاحة في OpenCode.
- تشغيل OpenCode agent محدد مباشرة.
- تشغيل parallel agents إذا كان ذلك آمنًا.
- إرجاع معلومات واضحة عن التنفيذ.
- منع silent fallback.
- رفض parallel write إذا كان فيه تضارب.

الأدوات الأساسية:

```text
list_opencode_agents
run_opencode_agent
run_opencode_parallel
```

---

## 3. OpenCode CLI

OpenCode هو engine التنفيذ.

يتم استدعاؤه من Codex عبر MCP bridge.

المطلوب أن يكون routing مباشرًا:

```text
planner      -> opencode run --agent planner
reviewer     -> opencode run --agent reviewer
tester       -> opencode run --agent tester
builder      -> opencode run --agent builder
debugger     -> opencode run --agent debugger
architect    -> opencode run --agent architect
orchestrator -> opencode run --agent orchestrator
build        -> opencode run --agent build
```

المرفوض:

```text
كل agents تمر عبر:
opencode run --agent build
```

إلا إذا كان fallback واضحًا ومطلوبًا صراحة.

---

## 4. OpenCode Agents

الأدوار المتوقعة:

| Agent | الدور | هل يعدّل ملفات؟ |
|---|---|---|
| planner | يخطط ويقسم العمل | لا |
| architect | يراجع architecture والمخاطر | لا |
| builder | ينفذ التعديلات | نعم، ضمن scope |
| reviewer | يراجع الكود | لا |
| tester | يختبر أو يقترح tests | غالبًا لا |
| debugger | يحلل bugs ويصلح إذا مسموح | حسب الصلاحية |
| orchestrator | backup leader | حسب الوضع |

---

## 5. OpenCode Backup Orchestrator

يجب إنشاء global OpenCode orchestrator agent في:

```text
%USERPROFILE%\.config\opencode\agents\orchestrator.md
```

دوره ليس منافسة Codex.

دوره:

1. تنفيذ task مفوض من Codex.
2. استلام القيادة إذا Codex توقف أو خلص context.
3. العمل standalone عندما تفتح OpenCode مباشرة.

### Modes

#### Mode 1: Delegated Executor

عندما Codex يرسل task محدد.

المطلوب:

- الالتزام بالـ scope.
- تنفيذ المطلوب فقط.
- عدم توسيع المهمة.
- إرجاع نتيجة مختصرة.

#### Mode 2: Backup Orchestrator

عندما Codex لا يستطيع الإكمال.

المطلوب:

- قراءة handoff.
- فهم ما تم وما بقي.
- فحص حالة الـ repo.
- إكمال الخطة.
- تفويض subagents.
- مراجعة النتائج.
- تشغيل validation.
- إخراج تقرير نهائي.

#### Mode 3: Standalone Orchestrator

عندما يتم تشغيل OpenCode مباشرة.

المطلوب:

- فحص الـ repo الحالي.
- قراءة أي تعليمات محلية إذا كانت موجودة.
- استخدام تخطيط بسيط.
- عدم إنشاء configs تلقائيًا.
- عدم إنشاء Spec Kit تلقائيًا.

---

## القرار المهم: Global وليس Project-Local

الهدف الحالي هو global setup.

المطلوب تعديله أو إنشاؤه:

```text
<repo>\server.js
<repo>\README.md
%USERPROFILE%\.config\opencode\agents\orchestrator.md
%USERPROFILE%\.codex\agents\principal-engineer-orchestrator.toml
```

غير مطلوب الآن:

```text
repo/.opencode/
repo/.opencode/opencode.jsonc
repo/.opencode/instructions
repo/.specify/
repo/specs/
migration من AGENTS.md
```

أي project-local setup ممكن لاحقًا، لكنه ليس جزءًا من الهدف الحالي.

---

## Direct Agent Routing

المشكلة التي يجب حلها:

```text
run_opencode_agent يمرر كل شيء عبر build
```

السلوك المطلوب:

```text
requested agent = reviewer
actual command = opencode run --agent reviewer
```

كل نتيجة يجب أن توضّح:

```text
requested agent
actual agent used
fallback used or not
command shape
working directory
exit code
duration
stderr summary if failed
```

لا يجب تسجيل:

```text
API keys
tokens
full environment variables
huge prompts
```

---

## Missing Agent Behavior

إذا agent غير موجود:

السلوك الصحيح:

```text
Return clear error.
Do not fallback silently.
```

fallback إلى `build` مسموح فقط إذا caller طلبه صراحة.

مثال جيد:

```text
requested: unknown-agent
actual: none
fallback: false
error: agent not found
```

أو إذا fallback مسموح:

```text
requested: unknown-agent
actual: build
fallback: true
fallback_reason: requested agent not found and fallback was explicitly allowed
```

---

## Compact Task Packet

لتوفير tokens، Codex يجب أن يرسل task packet مختصر إلى OpenCode.

القالب:

```text
Role:
<agent>

Task:
<bounded task>

Scope:
<files/directories/modules, or "current repo">

Lock granted:
<paths, if write task>

Allowed edits:
<paths or "none">

Forbidden edits:
<paths or "none specified">

Shared files:
<shared files frozen unless explicitly assigned>

Permissions:
<read-only / write allowed / bash ask / bash allowed>

Return format:
1. Summary
2. Files inspected
3. Files changed
4. Changes made or proposed
5. Risks
6. Validation performed
7. Validation still recommended
```

إذا كان agent يحتاج ملف خارج الـ lock:

```text
NEEDS_INTEGRATION:
- file/path needed
- reason
- recommended change
```

---

## Parallel Execution

Parallel execution مفيد، لكن خطر إذا كان فيه write.

### Read-only parallel

مسموح غالبًا:

```text
planner
reviewer
architect
explore
tester when read-only
debugger when no edits allowed
```

### Write parallel

مسموح فقط مع locks واضحة.

مثال آمن:

```text
builder-auth:
  lock: services/auth/**

builder-billing:
  lock: services/billing/**
```

مثال ممنوع:

```text
agent A edits shared/types.ts
agent B edits shared/types.ts
```

أو:

```text
agent A edits package.json
agent B edits package.json
```

---

## Lock System

القرار: استخدام lock protocol بسيط.

### القواعد

- orchestrator هو الوحيد الذي يمنح locks.
- subagents لا يمنحون أنفسهم locks.
- agent يكتب فقط داخل lock الممنوح له.
- إذا احتاج ملف خارج lock، يوقف ويرجع `NEEDS_INTEGRATION`.
- shared files دائمًا serial.

### أنواع locks

| Lock Type | الاستخدام | Parallel |
|---|---|---|
| Read lock | تخطيط، review، exploration | نعم |
| Write lock | تنفيذ isolated | نعم إذا لا يوجد overlap |
| Serial integration lock | shared/global files | لا |

### ملفات serial-only

```text
package files
lockfiles
shared types
schemas
DTOs
API contracts
OpenAPI specs
database migrations
generated files
global config
test infrastructure
```

---

## Handoff Protocol

عندما Codex لا يستطيع الإكمال، يجب أن يخرج handoff:

```text
HANDOFF_TO_OPENCODE
```

القالب:

```text
1. Original goal
2. Current working directory
3. Current repo state
4. Codex plan
5. Completed work
6. Remaining work
7. Files changed
8. Commands run
9. Validation result
10. Risks
11. Next recommended task
```

OpenCode orchestrator يجب أن يستطيع الإكمال من هذا handoff.

---

## Spec Kit Decision

في المرحلة الحالية:

```text
Do not use Spec Kit.
Do not initialize Spec Kit.
Do not create .specify/.
Do not create specs/.
```

السبب:

الهدف الآن هو اختبار البنية:

```text
Codex → MCP bridge → OpenCode agents → reviewer → validation
```

Spec Kit يمكن استخدامه لاحقًا إذا كان موجودًا في repo، لكن لا يتم إنشاؤه تلقائيًا.

---

## Integration Test

أفضل test fixture بسيط:

```text
Tic Tac Toe game
```

لكن الهدف ليس اللعبة.

الهدف اختبار:

```text
Codex plan
  ↓
OpenCode planner
  ↓
OpenCode builder
  ↓
OpenCode reviewer
  ↓
OpenCode tester / validation
  ↓
Codex final report
```

بدون:

```text
Spec Kit
repo-local .opencode/
AGENTS.md migration
```

---

## Definition of Done

النظام يعتبر جاهزًا عندما:

```text
list_opencode_agents works
run_opencode_agent routes planner directly
run_opencode_agent routes reviewer directly
run_opencode_agent routes builder directly
run_opencode_agent routes orchestrator directly
unknown agent returns clear error
fallback to build is explicit, not silent
run_opencode_parallel rejects unsafe overlapping writes
global orchestrator.md exists
handoff protocol is documented
small integration test passes
reviewer validates result
tester or local validation passes
```

---

## Final Target

الوضع النهائي المطلوب:

```text
READY: Codex ↔ MCP bridge ↔ OpenCode agents works for planned, delegated, reviewed, validated workflows.
```

بجملة واحدة:

أنت تريد **Global Multi-Agent Orchestration Layer** حيث Codex هو الأوركستريتور الأساسي، OpenCode هو direct sub-agent backend عبر MCP، وOpenCode orchestrator يستطيع الإكمال كـ backup إذا Codex توقف، مع direct routing، compact prompts، locks للـ parallel writes، review، validation، وhandoff واضح.
