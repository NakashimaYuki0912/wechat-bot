#!/usr/bin/env node
/** Chat web-tool offline test: patch allowlist, prompt gate, fake search calls. */
import fs from "node:fs";
import path from "node:path";
import { buildChatPrompt } from "../bridge/request-routing.js";
import { runSdk } from "./sdk-runner.mjs";
const root=process.cwd(); const dir=path.join(root,"work","web-search-test"); fs.mkdirSync(dir,{recursive:true});
const patch=fs.readFileSync(path.join(root,"deploy/harness/chat-web.patch.yml"),"utf8");
const prompt=buildChatPrompt({botName:"ExampleBot",groupName:"G",groupId:"g",senderId:"s1",senderDisplay:"甲",senderContactName:"甲",senderGroupAlias:null,text:"查一下最新消息",quote:null,persona:{name:"ExampleBot"},webSearchEnabled:true,messageId:1});
process.env.DSH_FAKE_SDK="1";
const result=await runSdk({prompt:"WEB_SEARCH_TEST 查一下最新消息",sessionId:"web-test",maxTokens:8192,timeoutMs:1000,reasoningEffort:"high",patchPath:path.join(root,"deploy/harness/chat-web.patch.yml"),maxSteps:4});
delete process.env.DSH_FAKE_SDK;
const checks={
  patch_enables_tool_web:!patch.includes("- id: tool-web\n  disabled: true"),
  patch_disables_shell:patch.includes("- id: tool-bash\n  disabled: true")&&patch.includes("- id: tool-fs\n  disabled: true"),
  prompt_has_search_rules:prompt.includes("每条请求最多 1 次 web_search")&&prompt.includes("最多读取 2 个网页")&&prompt.includes("必须附实际返回的 URL"),
  fake_tool_calls:result.tool_calls?.length===3,
  fake_steps:result.steps===4,
  fake_answer_has_sources:result.text.includes("https://example.com/a")&&result.text.includes("https://example.com/b"),
};
const out={passed:Object.values(checks).every(Boolean),checks,result:{status:result.status,steps:result.steps,tool_calls:result.tool_calls?.map(x=>({name:x.name,args:x.arguments})),text:result.text}};
fs.writeFileSync(path.join(dir,"results.json"),JSON.stringify(out,null,2)); console.log(JSON.stringify(out,null,2)); process.exit(out.passed?0:1);
