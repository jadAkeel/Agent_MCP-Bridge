# سجل المشاكل ونواقص التسليم — 2026-10-23

> **متابعة 2026-10-24:** الإصلاحات الثلاث صارت ضمن مرشّح PR، مع نقل اختبار مراقبة العمليات إلى المسار المتسلسل. اختبار الـrunner الجديد نجح 27/27، لكن هذا لا يحوّل نتيجة الفحص الشامل السابقة إلى نجاح ولا يثبت نجاح CI جديدة. راجع [أدلة المتابعة](BR-001-003-PR-VERIFICATION-2026-10-24.md). النص التاريخي والنتائج الأصلية أدناه محفوظة.

هذا الملف يجمع نتائج المراجعة المثبتة، وشروط ظهورها وأثرها، وما بقي غير متحقق منه. لا يعتبر كل تنبيه ثغرة، ولا يعتبر غياب تجربة قبول دليلًا على فشل المنتج. لم تُطبّق إصلاحات كود في هذه الجولة؛ التفويض الحالي للتغليف والتوثيق فقط.

> **تحديث لاحق بتفويض إصلاح محدود — 2026-10-23:** النص التاريخي أدناه محفوظ كما هو. حالات BR-001 وBR-002 وآلية BR-003 حُدّثت في الملحق الأخير وفي [تقرير الإصلاح والتحقق](BR-001-003-VERIFICATION-2026-10-23.md)؛ عبارات «غير منفذ» وحدود التفويض السابقة تصف جولة التشخيص الأصلية.

## النسخة المراجعة

- المستودع: `jadAkeel/Agent_MCP-Bridge`.
- `main`: `e1d1db86f2fb1c609ef91f0258bbe722b58eafb7`.
- HEAD المحلي عند التحقق: `38c01445512890fe54b182f16c182cabc33d90d2`، بنفس ملفات main.
- Git tree المشترك: `42f63a7cc4c1a2d8a4b35801aaaf51b5e17ac455`.
- بيئة التشخيص: Windows، Node `24.11.1`، OpenCode `1.18.32`.
- التاريخ بتوقيت `Asia/Beirut`؛ أوقات receipts الأصلية بـUTC.

## ملخص الأولويات

| ID | النقطة | الحالة | الأولوية العملية |
|---|---|---|---|
| BR-001 | requeue قد يرجع نفس المهمة الفاشلة مع لاحقة مفتاح معينة | عيب مثبت بfixture مع control | P2؛ يعطّل سلسلة retry محددة، لا كل queue |
| BR-002 | تغيير ADS موجود بنفس الحجم أو حذفه لا يُكتشف | فجوة مقارنة مثبتة على NTFS | P2؛ حد سلامة مخرجات Windows، تعرّض محدود |
| BR-003 | فشل مشاركة attestation في CI؛ قفل SQLite متأخر قد يكرر القراءة | إخفاق CI مثبت وآلية مستقلة مثبتة؛ الربط النهائي غير مثبت | P2؛ يحول دون ادعاء اجتياز CI كاملًا |
| SETUP-001 | النموذج الافتراضي غائب عن الكتالوج المشاهد | mismatch إعداد/كتالوج، دون محاولة inference عليه | مهم قبل أول تجربة للمستخدم |
| RELEASE-001 | حزم محلية موجودة، لكن التنزيل العام والربط النهائي غير مثبتين | نواقص تسليم، وليست bug تشغيل مثبتة | مهم قبل تسليم Marketplace عام |
| ACCEPTANCE-001 | رحلة مستخدم حقيقية كاملة ومستخدم مستقل غير متحقق منهما | نقص دليل قبول | مهم قبل تعميم ادعاءات الجاهزية |
| SECURITY-001 | npm audit يذكر 3 حزم؛ قابلية الوصول لا تتبع التصنيف وحده | متابعة dependencies؛ لا exploit مثبت من هذه التنبيهات في مسار stdio المراجع | متابعة متناسبة، دون توصيفه blocker تلقائيًا |

P2 هنا يعني عيبًا محددًا يستحق المتابعة، ولا يعني انهيارًا عامًا أو ضرورة إعادة بناء المشروع. أولوية التسليم ليست ادعاء أن فجوة القبول عيب كود.

## BR-001 — مفتاح requeue قد يصطدم بمفتاح المهمة الأصلية

**شرط الظهور:** مهمة أصلية بمفتاح مسموح مثل `suffix-root:requeue:1`، تفشل، ثم يعاد طلبها بلا تغيير في الطلب.

**المتوقع:** مهمة خلف جديدة بمعرّف مختلف وتنفيذ جديد، مع ربط lineage بالأصل.

**المثبت:** تطبيع المفتاح يزيل لاحقة `:requeue:<n>` حتى من مفتاح المستخدم الأصلي. أول إعادة محاولة قد تولد نفس المفتاح؛ deduplication يعيد الأصل، ثم تسجل `requeuedAs` بنفس ID وتعلن `retryDecisionOutcome: requeued`.

| Control / حالة | ID خلف جديد | عدد استدعاءات executor، شاملًا الأصل |
|---|---|---|
| `ordinary-root` | نعم | 2 |
| `suffix-root:requeue:1` | لا؛ رجع الأصل مع `deduplicated: true` | 1 |

المحاولة اللاحقة للحالة المتأثرة رجعت `requeue_already_requeued`.

**حد التحقق:** Git وSQLite وschema حقيقيون في مجلد مؤقت؛ executor اصطناعي يعيد `agent_timeout`. لم يُستدعَ provider. مسار automatic same-model retry مشترك بحسب المصدر، لكنه لم يُشغّل منفصلًا في هذا التشخيص.

**الأثر:** سلسلة retry المحددة تتوقف دون تنفيذ جديد؛ لا دليل هنا على فقدان ملفات أو تعطل كل مفاتيح idempotency.

**تجاوز مؤقت:** إعادة enqueue بمفتاح جديد لا ينتهي باللاحقة المذكورة، مع مراجعة العمل السابق قبل إعادة تشغيله.

**تصحيح مقترح، غير منفذ:** ربط تطبيع المفتاح بـlineage مثبتة، ومنع self-successor، وإضافة regression للشرط المحدد.

**المصدر:** [تطبيع المفتاح](https://github.com/jadAkeel/Agent_MCP-Bridge/blob/e1d1db86f2fb1c609ef91f0258bbe722b58eafb7/lib/queue.js#L108)، [requeue](https://github.com/jadAkeel/Agent_MCP-Bridge/blob/e1d1db86f2fb1c609ef91f0258bbe722b58eafb7/lib/queue/retry.js#L493)، [إعادة الصف عند deduplication](https://github.com/jadAkeel/Agent_MCP-Bridge/blob/e1d1db86f2fb1c609ef91f0258bbe722b58eafb7/server.js#L3553).

**الدليل المحلي:** [requeue-result.json](C:/Users/10User/bridge-review-20261023/requeue-result.json). إعادة التشخيص: `node C:/Users/10User/bridge-review-20261023/verify-requeue.mjs`.

## BR-002 — المقارنة تفوّت تعديل ADS قديم بنفس الحجم أو حذفه

**شرط الظهور:** Windows/NTFS، stream موجود قبل التقاط baseline داخل نطاق الكتابة، ثم يُعدّل محتواه بنفس الحجم أو يُحذف. writer مباشر مع worktree mode off يوضح التعرّض؛ ليس هذا إعداد الكاتب المعزول الافتراضي.

**المتوقع:** رفض التغييرات غير الممثلة في Git patch، مع قبول stream قديم لم يتغير.

**المثبت:** الالتقاط يخزن سطر الاسم والحجم من `dir /r`، لا digest للمحتوى؛ المقارنة تمر على streams الموجودة بعد التنفيذ فقط.

- تغيير `AAAA` إلى `BBBB` أعاد `null` أي لا مخالفة.
- حذف stream موجود أعاد `null` أيضًا.
- إضافة stream جديد، كـcontrol، أعادت `alternate_data_stream_written`.

**حد التحقق:** استُخدم filesystem snapshot/comparison الحقيقيان على NTFS. لم تُنفّذ مهمة provider أو payload عدائي كامل. هذه فجوة تحقق من مخرجات filesystem، وليست إثبات sandbox escape أو arbitrary code execution.

**الأثر:** قد تقبل المقارنة تغييرًا غير ظاهر في patch ضمن الشروط المذكورة. لا دليل على أنه يعطّل setup أو رحلة الكتابة المعتادة على كل المنصات.

**تصحيح مقترح، غير منفذ:** مقارنة محتوى streams القديمة، والإضافات والحذف، مع إبقاء unchanged-stream control ناجحًا.

**المصدر:** [التقاط ADS](https://github.com/jadAkeel/Agent_MCP-Bridge/blob/e1d1db86f2fb1c609ef91f0258bbe722b58eafb7/lib/writable-scope.js#L78)، [المقارنة](https://github.com/jadAkeel/Agent_MCP-Bridge/blob/e1d1db86f2fb1c609ef91f0258bbe722b58eafb7/lib/writable-scope.js#L220).

**الدليل المحلي:** [ads-result.json](C:/Users/10User/bridge-review-20261023/ads-result.json). إعادة التشخيص على Windows/NTFS: `node C:/Users/10User/bridge-review-20261023/verify-ads.mjs`.

## BR-003 — مشاركة attestation وCI غير محسومين

**المثبت في GitHub:** آخر [CI على main](https://github.com/jadAkeel/Agent_MCP-Bridge/actions/runs/39463831959) وقت التوثيق نجح في 7/9 خلايا. Windows `22.x` و`24.x` فشلا في نفس assertion: follower أعاد `fresh` بدل `shared`. الملف نجح 28/29، والـrunner نجح 181/182 أمرًا في كل خلية فاشلة.

**المثبت محليًا:** نفس المصدر نجح 29/29، دون skips. لا يلغي ذلك إخفاق CI.

**آلية مستقلة أُعيد إنتاجها:** deadline لإعادة محاولة SQLite يبدأ قبل انتظار owner. عند حدوث قفل عابر بعد أكثر من 5 ثوانٍ، قد يعود follower إلى fresh read بدل أخذ فرصة جديدة للمشاركة. حقن قفل واحد بعد 5.2 ثانية أعطى owner وfollower بعمليتي fresh.

**ما لم يثبت:** سجل CI لا يحفظ exception الداخلي للـcache؛ لا نجزم أن القفل المحقون هو السبب الدقيق لذلك التشغيل. لم يثبت تجاوز سياسة أو تشغيل نموذج غير مأذون. cache failure يعود إلى attestation جديدة، وليس موافقة تلقائية.

**الأثر:** فشل ضمان مشاركة القراءة تحت شرط محدد، مع تكرار العمل وأثر محتمل على latency/load. لا يصح وصف النسخة بأنها اجتازت 9/9، ولا حذف assertion لتمرير CI.

**المتابعة:** تحديد الخطأ الأصلي عند ظهوره، ومراجعة budget قفل SQLite المتأخر على أساس الدليل، ثم التحقق الموجه إذا أُجيز إصلاح لاحقًا.

**المصدر:** [deadline](https://github.com/jadAkeel/Agent_MCP-Bridge/blob/e1d1db86f2fb1c609ef91f0258bbe722b58eafb7/lib/attestation-cache.js#L181)، [فرع retry](https://github.com/jadAkeel/Agent_MCP-Bridge/blob/e1d1db86f2fb1c609ef91f0258bbe722b58eafb7/lib/attestation-cache.js#L219)، [fresh fallback](https://github.com/jadAkeel/Agent_MCP-Bridge/blob/e1d1db86f2fb1c609ef91f0258bbe722b58eafb7/lib/attestation-cache.js#L244).

**الأدلة المحلية:** [late-contention-result.json](C:/Users/10User/bridge-review-20261023/late-contention-result.json)، [Windows24 log](C:/Users/10User/bridge-review-20261023/ci-windows24.log)، [Windows22 log](C:/Users/10User/bridge-review-20261023/ci-windows22.log). إعادة التشخيص: `node C:/Users/10User/bridge-review-20261023/verify-late-contention.mjs`.

## SETUP-001 — اختيار النموذج لأول استخدام غير مثبت

الإعداد وملفات الأدوار تضبط `opencode/muse-spark-1.3-contributor-free`. كتالوج `opencode models opencode` المشاهد في هذه الجلسة لم يتضمن الاسم. هذا mismatch على الجهاز/الحساب المشاهد، وليس حكمًا على كل حساب أو إثباتًا بمحاولة inference فاشلة.

الـhealth يصرّح أنه لا يختبر provider readiness. لذلك نجاح installer/health لا يثبت أن أول job على default ستعمل.

**المطلوب للتسليم:** route متاحة ومختارة صراحةً من المستخدم، مع تحقق استعمالها حسب allowlist. لا يُستبدل النموذج أو الحساب بصمت.

**الأدلة:** [الإعداد المراجع](https://github.com/jadAkeel/Agent_MCP-Bridge/blob/e1d1db86f2fb1c609ef91f0258bbe722b58eafb7/opencode/opencode.jsonc#L5)، [الكتالوج المحلي](C:/Users/10User/bridge-review-20261023/opencode-model-catalog.txt).

## RELEASE-001 — بناء الحزمة محليًا لا يثبت التسليم العام

**ما أصبح موجودًا محليًا:**

- Skill ZIP بمجموع 200 ملف: `C:/Users/10User/bridge-marketplace-20261023/skill-rc2-baseline/agent-mcp-bridge-0.1.0-rc.2.zip`.
- SHA-256 للـSkill ZIP: `ca03d7ce337c2d97129961756aa735ffd95ebd179066390b86c84cd5bfa54d5d`.
- runtime baseline بُني في `C:/Users/10User/bridge-marketplace-20261023/runtime-baseline-e1d1db8`، بمجموع 3,947 ملفًا في build manifest.
- SHA-256 لـruntime release manifest: `0fb5eb4efb1de582b8690ae5dd437c5e80e7b7be2460c2e320b7953904f8faab`.

هذه أدلة بناء مرشح baseline، لا قبول إصدار نهائي. Skill ZIP لا يحتوي runtime أو CLIs أو subscriptions، وhash الـSkill ليس hash الـruntime.

**غير مثبت بعد:** runtime archive منشورة ومحددة للمشتري، download URL/version/hash مربوطة بالـlisting، وتجربة وصول فعلية للـreferences عبر Agensi. لا توجد GitHub releases في رد API المحفوظ؛ ذلك لا ينفي إمكانية استعمال clone من المصدر أو ملفات محلية لدى المالك.

**المطلوب:** تسليم runtime قابلة للتحقق، ربط listing بالحزمة الفعلية، والإفصاح عن حدود beta. السعر والحساب وموافقة المنصة لا تُفترض جاهزة.

**الدليل:** [Skill BUILD-REPORT](C:/Users/10User/bridge-marketplace-20261023/skill-rc2-baseline/BUILD-REPORT.json)، [runtime manifest](C:/Users/10User/bridge-marketplace-20261023/runtime-baseline-e1d1db8/release-manifest.json)، [GitHub releases snapshot](C:/Users/10User/bridge-review-20261023/github-releases.json).

## ACCEPTANCE-001 — رحلة المستخدم الكاملة لم تُثبت

لم تُسجّل على المرشح رحلة جديدة كاملة: download/hash → install → client → provider file read → writer محدود → validation → reviewer → preview → exact receipt apply → التحقق من النتيجة والملفات غير المعنية. كما لم تُسجّل تجربة مستخدم مستقل أو workload طويل.

تشغيل مساعد OpenCode نجح فعليًا بـGPT-6.1 Sol/high للمراجعة، ومساعد Luna/xhigh فحص التوثيق؛ هذا ليس بديلًا عن قبول المنتج من client عبر Bridge.

**الأثر:** حد للدليل المتاح ولادعاءات التسليم العام، وليس إثباتًا أن كل مرحلة تفشل. المتابعة المطلوبة تجربة قبول محددة بعد تثبيت الحزمة والـroute، دون توسيع ميزات المنتج.

## SECURITY-001 — متابعة تنبيهات dependencies بحسب قابلية الوصول

`npm audit --omit=dev --json` أبلغ عن 3 حزم: واحدة high واثنتان moderate، وصفر critical. عدد الحزم لا يساوي عدد exploits في المنتج.

- SDK `1.31.0`: التنبيهات المراجعة تخص experimental taskStore أو HTTP/auth paths؛ entrypoint المراجع stdio، ولم نجد استعمال تلك المسارات في Bridge المراجع. شروط [taskStore](https://github.com/advisories/GHSA-22jm-h49p-29qw) و[HTTP exhaustion](https://github.com/advisories/GHSA-46jr-4wx8-v453) و[redirects](https://github.com/advisories/GHSA-6prh-2h8m-c8cw) و[bearer audience](https://github.com/advisories/GHSA-rvq5-wwqv-78pq) موثقة عند المصدر.
- Hono `4.13.7`: [التنبيه](https://github.com/advisories/GHSA-5r4p-p66f-jhc7) يخص `serveStatic`؛ لم نجد استدعاءه في مصدر Bridge التشغيلي المراجع.
- ip-address `10.7.2`: dependency عبر `SDK → express-rate-limit`؛ لم نجد تمرير input الخاص بالمنتج إلى `Address6`. [التنبيه](https://github.com/advisories/GHSA-rxp7-6hxx-x8q5) مشروط بالوصول لهذه الدالة بinput غير موثوق.

عدم الوصول هنا استنتاج من entrypoint والبحث بالمصدر، وليس penetration test أو ضمانًا أمنيًا. عرض المنتج عبر HTTP مستقبلًا يغيّر التقييم. لم تُحدَّث dependencies أو تُغلق alerts في هذه الجولة.

سباقات قراءة state key ضد خصم بنفس صلاحيات المستخدم، المذكورة في [التقرير التاريخي](https://github.com/jadAkeel/Agent_MCP-Bridge/blob/e1d1db86f2fb1c609ef91f0258bbe722b58eafb7/docs/BETA-SECURITY-TRIAGE-2026-10-20.md)، باقية غير محلولة في ذلك التقرير؛ لم يُثبت استغلالها أو يعاد اختبارها عدائيًا هنا. لا تُقدّم هذه المراجعة شهادة أمان أو وعد OS sandbox.

**الدليل:** [npm-audit-production.json](C:/Users/10User/bridge-review-20261023/npm-audit-production.json).

## سجل التحقق وحدوده

| الفحص في الجولة السابقة على نفس المصدر | النتيجة |
|---|---|
| `node bin/verify-isolated.js --node tests/review-shared-attestation.js` | 29/29، صفر skips، exit 0، stableInputs:true |
| `node bin/verify-isolated.js --node tests/review-setup-cli.js` | 39 checks، صفر skips، exit 0، stableInputs:true |
| `node bin/verify-isolated.js --node tests/review-integration-reuse.js` | 19/19، صفر skips، exit 0، stableInputs:true |
| `node bin/package-agensi.js --check` | سلامة 200 ملف وmetadata/hashes/licenses/links |
| `node bin/skill-package.js --check` | 26 skills، 189 rendered files؛ integrity نجحت |

المجموع 87 فحصًا في suites الثلاث، وليس 87 تجربة provider. لم تُعد هذه suites لمجرد كتابة هذا الملف. لم يُشغّل full suite أو deep testing في جولة التوثيق، ولا تعني النجاحات المحلية إغلاق إخفاق CI.

تفاصيل الدليل في [verification-summary.json](C:/Users/10User/bridge-review-20261023/verification-summary.json)، والتقرير الأشمل في [REPORT.md](C:/Users/10User/bridge-review-20261023/REPORT.md)، وخريطة المتابعة في [REVIEW-MATRIX.csv](C:/Users/10User/bridge-review-20261023/REVIEW-MATRIX.csv): 18 وحدة و86 حالة مراجعة، وليست ادعاء تنفيذ كل الاحتمالات.

الروابط `C:/Users/10User/...` تخص أدلة محلية على جهاز المالك؛ لا تصلح وحدها كأدلة قابلة للتنزيل لمستخدم GitHub جديد. روابط المصدر أعلاه مثبتة على commit المراجعة حتى لا تتبدل دلالتها مع main.

## ترتيب المتابعة

1. إكمال مسار الحزمة والـruntime والـlisting وتثبيت route لأول استعمال، ضمن صلاحية التغليف والتوثيق.
2. إثبات رحلة قبول محددة قبل وصف المنتج بأنه مكتمل التجربة العامة.
3. إبقاء BR-001 وBR-002 وBR-003 مفتوحة. أي تصحيح كود يحتاج تفويضًا لاحقًا؛ لا حذف tests أو تخفيفها لتمرير CI.
4. تحديث كل نقطة فقط عند وجود دليل مرتبط بالنسخة التي غُيّرت. لا يبرر هذا السجل refactor أو إضافة feature أو وصف كل الحالات بأنها critical.

## Authorized fix follow-up — 2026-10-23

The preceding report is historical evidence, retained without removing the original findings. The user subsequently authorized code/test fixes only for BR-001, BR-002 and BR-003. The current local dispositions supersede their original open-code-fix status:

| ID | Current disposition | New evidence |
|---|---|---|
| BR-001 | Fixed locally: retry suffix normalization requires persisted lineage; deduplication must match the retry attempt; self-successor receipts are refused. | Reproduced before editing production code; final queue suite 37/37, including concurrent/repeated/sequential retries and automatic maxAttempts. |
| BR-002 | Fixed locally on actual Windows/NTFS: stream-content digests and before/after key-union comparison detect equal-size edits and deletion. | Both regressions failed before the fix; final native suite 19/19, including unchanged and creation controls. |
| BR-003 | Diagnosed late-contention mechanism fixed locally: contention budget starts at the lock and owner waiting remains bounded. Historical CI cause remains unproven. | Deterministic late-lock regression failed before the fix; shared-attestation suite 35/35, including owner success/refusal/exception, drift and exhausted waits. |

Full isolated runner: **181/182 commands passed, exit 1**, with 4 optional skips and 2 optional partial cases (zero required skips). The sole failure was the unchanged Windows process-supervisor descendant snapshot (`snapshotOk:false`); its standalone rerun passed on the same source. The original full-run failure is not erased by that rerun. Packaging, smoke, command-boundary, Pi, platform-contract and property checks passed. No new CI run was triggered; the latest observed GitHub result remains failed run `39463831959`.

See [BR-001-003-VERIFICATION-2026-10-23.md](BR-001-003-VERIFICATION-2026-10-23.md) for root causes, exact commands, before/after results, local receipt paths, final source digest and remaining limits. Original diagnostic files and old packages were preserved. These local fixes do not migrate historical self-receipts or establish provider/client acceptance, cross-platform native acceptance, a green CI run or publication readiness.
