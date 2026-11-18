import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { v2AgentMetadata, v2BridgeCommand, v2BridgeOutput, v2ModelEvents } from "../lib/opencode-v2.js";
import * as v2 from "../lib/opencode-v2.js";
import { DatabaseSync } from "node:sqlite";
import { createOpenCodeCommandRuntime } from "../lib/opencode-command.js";
import { createPluginPolicyRuntime } from "../lib/plugin-policy.js";
import { preflight, parseArguments } from "../bin/setup.js";

test("V2 inventory binds the requested checkout using the native location query schema", () => {
  assert.equal(typeof v2.v2InventoryOperationUrl, "function");
  const spec = { paths: { "/api/agent": { get: { operationId: "agent.list", parameters: [{ name: "location", in: "query", style: "deepObject" }] } } } };
  const url = new URL(v2.v2InventoryOperationUrl(spec, "agent.list", "C:/fixture/repo"), "http://127.0.0.1");
  assert.equal(url.searchParams.get("location[directory]"), "C:/fixture/repo");
  assert.equal(url.searchParams.has("directory"), false);
});

test("V2 commands use private servers and select the exact effective agent id", () => {
  const command = v2BridgeCommand(["debug", "agent", "reviewer"]);
  assert.deepEqual(command.args, ["debug", "agents", "--standalone"]);
  const metadata = JSON.parse(v2BridgeOutput(command, JSON.stringify([{id:"reviewer",name:"display",mode:"all",permissions:[{action:"*",resource:"*",effect:"deny"}],model:{providerID:"openai",id:"gpt-6.1-sol",variant:"high"},request:{body:{temperature:0}},system:"source"}])));
  assert.equal(metadata.name, "reviewer");
  assert.equal(metadata.model.modelID, "gpt-6.1-sol");
  assert.equal(metadata.temperature, 0);
  assert.throws(() => v2BridgeOutput(command, "[]"), /missing or duplicated/);
  assert.throws(() => v2AgentMetadata({id:"reviewer"}), /permissions/);
});

test("V2 wildcard defaults and later overrides preserve permission authority", () => {
  const agent = {id:"reviewer",permissions:[{action:"*",resource:"*",effect:"allow"},{action:"*",resource:"*",effect:"deny"},{action:"shell",resource:"git diff",effect:"allow"}]};
  const metadata = v2AgentMetadata(agent);
  assert.equal(metadata.tools.edit, false);
  assert.deepEqual(metadata.permission.filter(rule => rule.permission === "bash").map(({pattern,action}) => [pattern,action]), [["*","allow"],["*","deny"],["git diff","allow"]]);
  assert.equal(v2AgentMetadata({...agent,permissions:[...agent.permissions,{action:"edit",resource:"plan/*",effect:"allow"}]}).tools.edit, true);
  const denied = {action:"*",resource:"*",effect:"deny"};
  assert.throws(() => v2AgentMetadata({id:"x",permissions:[denied,{action:"ed*",resource:"*",effect:"allow"}]}), /action pattern/);
  assert.throws(() => v2AgentMetadata({id:"x",permissions:[denied,{action:"edit",resource:"*",effect:"unknown"}]}), /Invalid/);
  assert.throws(() => v2AgentMetadata({id:"x",permissions:[{action:"*",resource:"*",effect:"allow"}]}), /unknown tools/);
  assert.throws(() => v2AgentMetadata({id:"x",permissions:[denied,{action:"worktree_create",resource:"*",effect:"allow"}]}), /Unattested/);
  assert.throws(() => v2AgentMetadata({id:"x",permissions:[denied,{action:"*",resource:"**",effect:"allow"},
    ...["edit","shell","subagent","webfetch","websearch","external_directory","skill"].map(action=>({action,resource:"*",effect:"deny"}))]}), /wildcard grants/);
});

test("V2 run flags pin model variant and never use removed flags or shared servers", () => {
  const { openCodeRunArgs } = createOpenCodeCommandRuntime({CONFIG:{openCodeCliMajor:"2",allowExternalPlugins:false}, OPENCODE_EXE:"opencode"});
  const args = openCodeRunArgs("reviewer","--prompt-looking task",{provider:"openai",model:"gpt-6.1-sol",variant:"high"});
  assert.ok(args.includes("--standalone"));
  assert.ok(args.includes("--model=openai/gpt-6.1-sol#high"));
  assert.ok(!args.includes("--pure"));
  assert.ok(!args.some(arg => arg.startsWith("--variant")));
  assert.equal(args.at(-1), "Task:\n--prompt-looking task");
});

test("V2 skill inventory retains authoritative origins", () => {
  assert.deepEqual(JSON.parse(v2BridgeOutput(v2BridgeCommand(["debug","skill"]), JSON.stringify({data:[{id:"builder-safety",path:"/managed/skills/builder-safety/SKILL.md"}]}))), [{name:"builder-safety",location:"/managed/skills/builder-safety/SKILL.md"}]);
  assert.throws(() => v2BridgeOutput(v2BridgeCommand(["debug","skill"]), "[]"), /inventory/);
});

test("V2 pure policy refuses external plugins and active MCP in either config format", async () => {
  const root = await mkdtemp(path.join(tmpdir(),"bridge-v2-policy-"));
  const config = path.join(root,"config");
  await mkdir(config);
  const {verifyExternalPluginPolicyUnshared: verify} = createPluginPolicyRuntime({CONFIG:{openCodeCliMajor:"2",allowExternalPlugins:false},DEFAULT_OPENCODE_CONFIG_DIR:config,buildOpenCodeEnv:()=>({HOME:root}),runCommand:async()=>({exitCode:0,stdout:"opencode v2.2.2"})});
  try {
    for (const bad of [{plugin:["bad@1.0.0"]},{plugins:[{package:"bad"}]},{mcp:{bad:{type:"local",command:["bad"]}}}]) {
      await writeFile(path.join(config,"opencode.json"),JSON.stringify(bad));
      assert.equal((await verify()).ok, false);
    }
    await writeFile(path.join(config,"opencode.json"),JSON.stringify({plugins:[],mcp:{off:{disabled:true}}}));
    assert.equal((await verify()).ok, true);
    const oldPolicy=createPluginPolicyRuntime({CONFIG:{openCodeCliMajor:"1",allowExternalPlugins:false},DEFAULT_OPENCODE_CONFIG_DIR:config,buildOpenCodeEnv:()=>({HOME:root})});
    assert.equal((await oldPolicy.verifyExternalPluginPolicyUnshared()).ok,false,"native V2 disabled flags must not disable V1's enabled MCP servers");
    await mkdir(path.join(config,"plugin"));
    await writeFile(path.join(config,"plugin/untrusted.js"),"throw new Error('must never execute')");
    assert.equal((await verify()).ok,false);
  } finally { await rm(root,{recursive:true,force:true}); }
});

test("installer qualifies exact V2 pure, gates V2 Gemini package roots and refuses old pins", async () => {
  const options = parseArguments(["--client","codex","--skills"]);
  const commands = {git:{command:"git",args:[]},opencode:{command:"opencode",args:[]},codex:{command:"codex",args:[]},claude:null};
  const probe = (version,profile="pure") => preflight({...options,profile},{env:process.env,commands,log:()=>{},run:command=>({status:command?0:1,stdout:version})});
  assert.equal(probe("opencode v2.2.2").ok,true);
  assert.equal(probe("2.2.2").commands.openCodeMajor,"2");
  assert.equal(probe("2.2.1").ok,false);
  assert.equal(probe("2.2.2","gemini").ok,false);
  const prefix = await mkdtemp(path.join(tmpdir(), "bridge-v2-installer-plugin-"));
  try {
    const packageRoot = path.join(prefix, "node_modules", "@cortexkit", "opencode-antigravity-auth");
    await mkdir(packageRoot, { recursive: true });
    await writeFile(path.join(prefix, "package-lock.json"), "{}");
    await writeFile(path.join(packageRoot, "package.json"), JSON.stringify({ name:"@cortexkit/opencode-antigravity-auth",version:"3.0.19" }));
    const geminiOptions = parseArguments(["--client","codex","--profile","gemini","--v2-plugin-package-root",prefix]);
    const geminiProbe = preflight(geminiOptions,{env:process.env,commands,log:()=>{},run:command=>({status:command?0:1,stdout:"opencode v2.2.2"})});
    assert.equal(geminiProbe.ok,true);
    assert.equal(geminiProbe.needsAuth,true);
    const oldPackage = parseArguments(["--profile","gemini","--v2-plugin-package-root",prefix]);
    await writeFile(path.join(packageRoot, "package.json"), JSON.stringify({ name:"@cortexkit/opencode-antigravity-auth",version:"3.0.18" }));
    assert.equal(preflight(oldPackage,{env:process.env,commands,log:()=>{},run:command=>({status:command?0:1,stdout:"opencode v2.2.2"})}).ok,false);
  } finally { await rm(prefix,{recursive:true,force:true}); }
  assert.throws(()=>parseArguments(["--opencode-executable","relative"]), /absolute native/);
});

test("V2 observed model comes from this fresh native session, never the requested label or another session", async () => {
  const root = await mkdtemp(path.join(tmpdir(),"bridge-v2-model-"));
  await mkdir(path.join(root,"opencode"));
  const file = path.join(root,"opencode/opencode.db");
  const db = new DatabaseSync(file);
  try {
    db.exec("CREATE TABLE session_message (session_id TEXT, type TEXT, time_created INTEGER, seq INTEGER, data TEXT)");
    const insert = db.prepare("INSERT INTO session_message VALUES (?, 'assistant', ?, ?, ?)");
    insert.run("ses_fresh",10,1,JSON.stringify({model:{providerID:"actual",id:"older"}}));
    insert.run("ses_other",100,1,JSON.stringify({model:{providerID:"other",id:"wrong"}}));
    insert.run("ses_fresh",100,2,JSON.stringify({model:{providerID:"observed",id:"real"}}));
    const events=v2ModelEvents(JSON.stringify({type:"text",sessionID:"ses_fresh"}),{XDG_DATA_HOME:root},50);
    assert.equal(JSON.parse(events).properties.info.modelID,"real");
    assert.equal(JSON.parse(events).properties.info.providerID,"observed");
    assert.equal(v2ModelEvents("{}",{XDG_DATA_HOME:root},50),"");
    assert.equal(v2ModelEvents(JSON.stringify({type:"text",sessionID:"ses_fresh"}),{XDG_DATA_HOME:root,OPENCODE_DB:":memory:"},50),"");
  } finally { db.close(); await rm(root,{recursive:true,force:true}); }
});

test("V2 runtime refuses an upgraded binary before attestation or inference", async () => {
  const runtime=createPluginPolicyRuntime({CONFIG:{openCodeCliMajor:"2",allowExternalPlugins:false},buildOpenCodeEnv:()=>({}),runCommand:async()=>({exitCode:0,stdout:"opencode v2.2.1"})});
  const result=await runtime.verifyExternalPluginPolicyUnshared();
  assert.equal(result.ok,false);
  assert.equal(result.errorType,"opencode_version_unsupported");
});
