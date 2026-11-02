import {spawn} from 'node:child_process';
import {writeFileSync} from 'node:fs';
const mode=process.argv[2]||'before';
const base=process.env.EVIDENCE_DIR || '/tmp/plan-confirmation-evidence';
const edge=process.env.EDGE_BIN || '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge';
const child=spawn(edge,['--headless','--disable-gpu','--no-first-run','--no-default-browser-check',`--user-data-dir=${base}/cdp-${mode}`,'--remote-debugging-port=0','--window-size=1280,900','--force-device-scale-factor=1','about:blank'],{stdio:['ignore','ignore','pipe']});
let stderr=''; let websocket;
const address=await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('Edge did not expose isolated debugger')),15000);child.stderr.on('data',chunk=>{stderr+=chunk;const match=stderr.match(/DevTools listening on (ws:\/\/[^\s]+)/);if(match){clearTimeout(timer);resolve(match[1]);}});child.once('error',reject)});
try{
 websocket=new WebSocket(address);await new Promise((resolve,reject)=>{websocket.onopen=resolve;websocket.onerror=reject});
 let next=0;const pending=new Map();const events=[];
 websocket.onmessage=e=>{const data=JSON.parse(e.data);if(data.id){const p=pending.get(data.id);pending.delete(data.id);data.error?p.reject(data.error):p.resolve(data.result)}else events.push(data)};
 const send=(method,params={},sessionId)=>new Promise((resolve,reject)=>{const id=++next;pending.set(id,{resolve,reject});websocket.send(JSON.stringify({id,method,params,...sessionId?{sessionId}:{}}))});
 const {targetId}=await send('Target.createTarget',{url:'about:blank'});
 const {sessionId}=await send('Target.attachToTarget',{targetId,flatten:true});
 await send('Page.enable',{},sessionId);await send('Runtime.enable',{},sessionId);
 await send('Emulation.setDeviceMetricsOverride',{width:1280,height:900,deviceScaleFactor:1,mobile:false},sessionId);
 await send('Emulation.setEmulatedMedia',{features:[{name:'prefers-color-scheme',value:'light'}]},sessionId);
 await send('Emulation.setTimezoneOverride',{timezoneId:'Asia/Shanghai'},sessionId);
 await send('Page.navigate',{url:`file://${base}/${mode}/index.html`},sessionId);
 let evidence;
 for(let i=0;i<100;i++){
  const result=await send('Runtime.evaluate',{expression:`JSON.stringify({ready:!!document.querySelector('.dt-conversation-message'),title:document.title,text:document.body.innerText,calls:window.__evidenceCalls||[],viewport:{width:innerWidth,height:innerHeight}})`,returnByValue:true},sessionId);
  evidence=JSON.parse(result.result.value);if(evidence.ready)break;
  await new Promise(resolve=>setTimeout(resolve,50));
 }
 if(!evidence.ready)throw new Error('Component did not render saved conversation');
 await new Promise(resolve=>setTimeout(resolve,250));
 const screenshot=await send('Page.captureScreenshot',{format:'png',captureBeyondViewport:false},sessionId);
 writeFileSync(`${base}/${mode}.png`,Buffer.from(screenshot.data,'base64'));
 evidence.exceptions=events.filter(e=>e.method==='Runtime.exceptionThrown');
 writeFileSync(`${base}/${mode}-browser-evidence.json`,JSON.stringify(evidence,null,2));
 console.log(JSON.stringify({mode,viewport:evidence.viewport,apiCalls:evidence.calls,exceptions:evidence.exceptions,screenshot:`${base}/${mode}.png`}));
 if(evidence.exceptions.length)process.exitCode=1;
 await send('Browser.close');
}finally{websocket?.close();child.kill();}
