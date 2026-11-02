import {createRequire} from 'node:module';
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {resolve,dirname} from 'node:path';
const repo=process.env.EVIDENCE_REPO || execFileSync('git',['rev-parse','--show-toplevel'],{encoding:'utf8'}).trim();
const require=createRequire(repo+'/package.json');
const {build}=await import(require.resolve('tsdown'));
const mode=process.argv[2]||'before';
const base=process.env.EVIDENCE_DIR || '/tmp/plan-confirmation-evidence';
const source=process.env.SOURCE_DIR || (mode==='before'?base+'/before-source':repo);
const out=base+'/'+mode;
mkdirSync(out,{recursive:true});
const locale=readFileSync(source+'/src/client/locales.ts','utf8');
const en={};
for(const match of locale.matchAll(/^\s*(?:'([^']+)'|(\w+)):\s*(\[(?:[^\n]+)\]),?\s*$/gm)){
 try {const pair=Function('return '+match[3])(); if(typeof pair[1]==='string')en[match[1]||match[2]]=pair[1]}catch{}
}
writeFileSync(out+'/english.json',JSON.stringify(en));
const entry=`import React from 'react';
import {createRoot} from 'react-dom/client';
import {ProjectConversation} from '${source}/src/client/project-conversation.tsx';
import {PanelProvider} from '${source}/src/client/provider.tsx';
import en from './english.json';
const project={id:'project-visual',name:'Release readiness',goal:'Prepare a safe, reviewed release plan for the next milestone.'};
const messages=[{id:'message-user',projectId:project.id,role:'user',status:'answered',text:'Please propose a plan for the next release. Break it into reviewable tasks and wait for my confirmation before dispatching any work.',createdAt:'2026-11-02T09:00:00.000Z'},{id:'message-assistant',projectId:project.id,role:'assistant',status:'saved',text:'I will outline the release work, identify dependencies, and ask you to confirm the plan before starting execution.',createdAt:'2026-11-02T09:00:04.000Z'}];
const tasks=[{id:'task-release-plan',projectId:project.id,title:'Review release readiness',projectStage:'awaiting-confirmation',planRevisions:[{projectId:project.id,ticketId:'task-release-plan',revision:1,createdAt:'2026-11-02T09:00:05.000Z',goal:'Review release readiness, verify regressions, and prepare release notes.',scope:'Review the next milestone; wait for explicit confirmation before execution.',outputs:['Release checklist','Regression findings','Draft release notes'],resources:['Synthetic repository snapshot'],environment:'Isolated local workspace',cost:'One review pass',completion:'Checklist reviewed and release notes ready for approval.'}],authorizations:[],assignments:[]}];
if (${JSON.stringify(mode === 'after-confirmed')}) {
 const authorization={id:'authorization-release',projectId:project.id,ticketId:'task-release-plan',planRevision:1,actor:{source:'web',id:'synthetic-user'},message:{id:'message-confirmation',text:'Implement this plan'},intent:'execute',intentId:'synthetic-confirmation',targetId:'target-release',createdAt:'2026-11-02T09:00:10.000Z'};
 tasks[0].authorizations.push(authorization);
 tasks[0].projectStage='confirmed';
 tasks[0].assignments.push({id:'assignment-release',state:'pending',waitingReason:'executor-unavailable',contract:{authorizationId:authorization.id,targetId:authorization.targetId,planRevision:1,plan:tasks[0].planRevisions[0],inputs:[]}});
}
window.__evidenceCalls=[];
window.fetch=async (url,options)=>{window.__evidenceCalls.push({url,method:options?.method}); const path=String(url); let data;
if(path.endsWith('/state'))data={load:{running:0}};
else if(path.endsWith('/conversation'))data={project,messages,tasks,coordinator:{status:'idle'}};
else if(path.endsWith('/plans'))data=window.__planSeed||[];
else throw new Error('Unseeded API '+path);
return new Response(JSON.stringify(data),{status:200,headers:{'Content-Type':'application/json'}})};
const t=(key,values)=>{let text=en[key]||key;for(const [k,v]of Object.entries(values||{}))text=text.replaceAll('{'+k+'}',String(v));return text};
createRoot(document.getElementById('root')).render(<PanelProvider t={t}><main className="dt-page"><div className="dt-column"><ProjectConversation id={project.id}/></div></main></PanelProvider>);
`;
writeFileSync(out+'/entry.tsx',entry);
const raw={name:'raw',resolveId:(s,i)=>s.endsWith('?raw')&&i?resolve(dirname(i),s):undefined,load:id=>id.endsWith('?raw')?{code:'export default '+JSON.stringify(readFileSync(id.slice(0,-4),'utf8')),moduleType:'js'}:undefined};
await build({config:false,entry:[out+'/entry.tsx'],outDir:out,format:'iife',platform:'browser',dts:false,clean:false,plugins:[raw],deps:{alwaysBundle:[/.*/]},alias:{react:dirname(require.resolve('react/package.json')),'react-dom':dirname(require.resolve('react-dom/package.json'))},define:{'process.env.NODE_ENV':'"production"'},outputOptions:{entryFileNames:'app.js'}});
const tokens=`:root{color-scheme:light;--dsw-alias-label-primary:#1c2024;--dsw-alias-label-secondary:#60646c;--dsw-alias-label-tertiary:#80838d;--dsw-alias-label-caption:#80838d;--dsw-alias-bg-layer-1:#fff;--dsw-alias-bg-layer-2:#fff;--dsw-alias-border-l2:#e8e8ec;--dsw-alias-border-l3:#d9d9e0;--dsw-alias-border-l4:#b9bbc6;--dsw-alias-interactive-bg-hover:#f0f0f3;--dsw-alias-brand-primary:#3e63dd;--dsw-alias-on-brand-primary:#fff;--dsw-alias-button-primary-fill:#3e63dd;--dsw-alias-button-primary-hover:#3358d4;--dsw-alias-label-primary-foreground:#fff;--dsw-alias-interactive-bg-active:#e8e8ec;--dsw-alias-bg-module-platform:#f0f0f3;--dsw-alias-state-business-primary:#3e63dd;--dsw-alias-link:#3e63dd;--dsw-alias-state-error-primary:#ce2c31;--dsw-alias-state-warn-primary:#b65b00;--dsw-alias-state-success-primary:#218358}html,body,#root{margin:0;width:100%;height:100%;background:#fff}body{font:14px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}*{box-sizing:border-box}`;
writeFileSync(out+'/index.html','<!DOCTYPE html><html lang="en"><meta charset="utf-8"><title>Project conversation visual evidence</title><style>'+tokens+'</style><div id="root"></div><script src="app.js"></script></html>');
const hashes={};
for(const file of ['src/client/project-conversation.tsx','src/client/provider.tsx','src/client/api.ts','src/client/client.css','src/client/locales.ts']) hashes[file]=createHash('sha256').update(readFileSync(source+'/'+file)).digest('hex');
const head=execFileSync('git',['rev-parse','HEAD'],{cwd:repo,encoding:'utf8'}).trim();
const componentGitBlob=execFileSync('git',['hash-object',source+'/src/client/project-conversation.tsx'],{cwd:repo,encoding:'utf8'}).trim();
const revision=mode==='before'?'998b62cdc242232bad49ff8dea5dc930c07d167c':head+'+working-tree:'+componentGitBlob;
writeFileSync(out+'/source-metadata.json',JSON.stringify({source,revision,componentGitBlob,hashes},null,2));
console.log('Built actual component from',source,'at',out);
