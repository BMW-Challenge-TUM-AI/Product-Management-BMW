import type {Plugin} from 'vite';
import {spawn,spawnSync} from 'node:child_process';
import {existsSync,mkdirSync,readFileSync,readdirSync,renameSync,writeFileSync} from 'node:fs';
import type {IncomingMessage, ServerResponse} from 'node:http';
import {resolve,join} from 'node:path';
import {randomUUID} from 'node:crypto';

type StreamEvent = {type:'progress';stage:string;progress:number;message:string;completed?:number;total?:number}
 | {type:'result';result:unknown} | {type:'error';error:string};
type Stage='extracting'|'clustering'|'generating'|'committing'|'complete'|'failed';
type AnalysisJob={jobId:string;stage:Stage;progress:number;message:string;startedAt:string;finishedAt?:string;result?:unknown;error?:string;workerPid?:number;ownerPid:number};
type ActiveRun={jobId?:string;token:string};
type Runtime={active?:ActiveRun};
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const stages=new Set<Stage>(['extracting','clustering','generating','committing','complete','failed']);
const analysisTimeout=600_000;
const runtimesKey=Symbol.for('bmw-insightpilot.local-analysis-runtimes');
const shared=globalThis as typeof globalThis&{[runtimesKey]?:Map<string,Runtime>};
const runtimes=shared[runtimesKey]??=new Map<string,Runtime>();
const isFinished=(job:AnalysisJob)=>job.stage==='complete'||job.stage==='failed';
const processExists=(pid:number|undefined)=>{if(!pid)return false;try{process.kill(pid,0);return true;}catch{return false;}};
const publicJob=({workerPid:_workerPid,ownerPid:_ownerPid,...job}:AnalysisJob)=>job;

function resolvePython(env:Record<string,string>):string {
 const candidates=[
  env.PYTHON_BIN,
  resolve('.venv','Scripts','python.exe'),
  resolve('.venv','bin','python'),
  env.USERPROFILE?join(env.USERPROFILE,'.cache','codex-runtimes','codex-primary-runtime','dependencies','python','python.exe'):'',
  process.platform==='win32'?'python':'python3',
  'python3',
 ].filter(Boolean) as string[];
 for(const candidate of candidates){
  if(candidate.includes('/')||candidate.includes('\\')){
   if(!existsSync(candidate))continue;
  }
  const check=spawnSync(candidate,['-c','import sys; print(sys.executable)'],{encoding:'utf8',timeout:3000});
  if(check.status===0)return candidate;
 }
 return process.platform==='win32'?'python':'python3';
}

/** Local-only Python services. No API key is ever sent to browser JavaScript. */
export function localAI(env:Record<string,string>):Plugin {
 const jobsDirectory=resolve(env.ANALYSIS_JOB_DIR||'data/analysis-jobs');
 const python=resolvePython(env);
 const runtime=runtimes.get(jobsDirectory)??{};
 runtimes.set(jobsDirectory,runtime);
 const redact=(text:string)=>env.OPENAI_API_KEY?text.split(env.OPENAI_API_KEY).join('[redacted]'):text;
 const saveJob=(job:AnalysisJob)=>{
  mkdirSync(jobsDirectory,{recursive:true,mode:0o700});
  const destination=join(jobsDirectory,`${job.jobId}.json`);
  const temporary=`${destination}.${randomUUID()}.tmp`;
  writeFileSync(temporary,redact(JSON.stringify(job)),{mode:0o600});
  renameSync(temporary,destination);
 };
 const readJob=(jobId:string):AnalysisJob|undefined=>{
  const path=join(jobsDirectory,`${jobId}.json`);
  if(!existsSync(path))return;
  const job=JSON.parse(readFileSync(path,'utf8')) as AnalysisJob;
  if(job.jobId!==jobId||!stages.has(job.stage)||!Number.isFinite(Date.parse(job.startedAt)))throw new Error('Invalid stored analysis job.');
  if(!isFinished(job)){
   const timedOut=Date.now()-Date.parse(job.startedAt)>analysisTimeout;
   const inThisProcess=runtime.active?.jobId===jobId;
   const orphaned=!inThisProcess&&(!processExists(job.ownerPid)||!processExists(job.workerPid));
   if(timedOut||orphaned){
    job.stage='failed';job.finishedAt=new Date().toISOString();
    job.error=timedOut?'Analysis exceeded the 10-minute limit. Retry this batch.':'The analysis worker stopped before saving a result. Retry this batch.';
    job.message=job.error;saveJob(job);
    if(runtime.active?.jobId===jobId)runtime.active=undefined;
   }
  }
  return job;
 };
 const activeRun=():ActiveRun|undefined=>{
  if(runtime.active){
   if(!runtime.active.jobId)return runtime.active;
   const current=readJob(runtime.active.jobId);
   if(current&&!isFinished(current))return runtime.active;
   runtime.active=undefined;
  }
  if(!existsSync(jobsDirectory))return;
  for(const filename of readdirSync(jobsDirectory)){
   const jobId=filename.replace(/\.json$/,'');
   if(!filename.endsWith('.json')||!uuid.test(jobId))continue;
   const job=readJob(jobId);
   if(job&&!isFinished(job))return {jobId,token:jobId};
  }
 };
 const handler=async(req:IncomingMessage,res:ServerResponse,next:()=>void)=>{
  if(!req.url?.startsWith('/api/'))return next();
  res.setHeader('Content-Type','application/json');res.setHeader('Cache-Control','no-store');
  const reply=(status:number,data:unknown)=>{if(res.writableEnded||res.destroyed)return;res.statusCode=status;res.end(JSON.stringify(data));};
  const host=req.headers.host??'';const origin=req.headers.origin;
  if(!/^(localhost|127\.0\.0\.1)(:\d+)?$/.test(host)||origin&&origin!==`http://${host}`)return reply(403,{error:'Local same-origin access only.'});
  if(req.url==='/api/capabilities'&&req.method==='GET')return reply(200,{ai:!!env.OPENAI_API_KEY,chat:!!env.OPENAI_API_KEY,collector:true,model:env.OPENAI_MODEL||'gpt-5-mini',limit:50});
  if(req.url.startsWith('/api/analysis/')&&req.method==='GET'){
   const jobId=req.url.slice('/api/analysis/'.length);
   if(!uuid.test(jobId))return reply(400,{error:'A valid analysis job ID is required.'});
   try{const job=readJob(jobId);return job?reply(200,publicJob(job)):reply(404,{error:'Analysis job was not found.'});}
   catch{return reply(500,{error:'The saved analysis status could not be read.'});}
  }
  const routes:Record<string,{script:string;timeout:number;needsKey:boolean}>={
   '/api/analyze':{script:'scripts/analyze_bridge.py',timeout:analysisTimeout,needsKey:true},
   '/api/chat':{script:'scripts/chat_bridge.py',timeout:60_000,needsKey:true},
   '/api/report':{script:'scripts/report_bridge.py',timeout:45_000,needsKey:false},
   '/api/collect':{script:'scripts/collect_bridge.py',timeout:45_000,needsKey:false},
   '/api/bmw':{script:'scripts/bmw_bridge.py',timeout:60_000,needsKey:false},
  };
  const route=routes[req.url??''];
  if(!route||req.method!=='POST')return reply(404,{error:'Unknown endpoint.'});
  const analysis=req.url==='/api/analyze';
  const preference=Array.isArray(req.headers.prefer)?req.headers.prefer.join(','):req.headers.prefer;
  const asynchronous=analysis&&preference?.split(',').some(value=>value.trim()==='respond-async')===true;
  let body='';let data:Record<string,unknown>;
  try{
   for await(const chunk of req){body+=chunk;if(Buffer.byteLength(body)>1_000_000)return reply(413,{error:'Request is too large.'});}
   data=JSON.parse(body);
   if(!data||typeof data!=='object'||Array.isArray(data))return reply(400,{error:'Invalid JSON request.'});
   if(analysis&&(!Array.isArray(data.records)||data.records.length<1||data.records.length>50))return reply(400,{error:'Select 1–50 feedback records.'});
  }catch{return reply(400,{error:'Invalid JSON request.'});}
  let job:AnalysisJob|undefined;
  let worker:ReturnType<typeof spawn>|undefined;
  const token=randomUUID();
  try{
   if(asynchronous){
    if(typeof data.jobId!=='string'||!uuid.test(data.jobId))return reply(400,{error:'A valid analysis job ID is required.'});
    if(readJob(data.jobId)){res.setHeader('Preference-Applied','respond-async');return reply(202,{jobId:data.jobId});}
   }
   if(route.needsKey&&!env.OPENAI_API_KEY)return reply(503,{error:'Set OPENAI_API_KEY in .env and restart the app.'});
   // No await between checking and claiming: parallel body reads cannot start two workers.
   const active=analysis?activeRun():undefined;
   if(active)return reply(409,{error:'An analysis is already running.',...(active.jobId?{jobId:active.jobId}:{})});
   if(asynchronous){
    job={jobId:data.jobId as string,stage:'extracting',progress:0,message:'Starting analysis of the selected source comments.',startedAt:new Date().toISOString(),ownerPid:process.pid};
    saveJob(job);
   }
   if(analysis)runtime.active={token,jobId:job?.jobId};
   const streaming=analysis&&req.headers.accept?.includes('application/x-ndjson')===true;
   const workerStreaming=streaming||asynchronous;
   const child=spawn(python,[route.script,...(workerStreaming?['--stream']:[])],{env:{...process.env,...env,PYTHONIOENCODING:'utf-8',PYTHONUTF8:'1'},stdio:['pipe','pipe','pipe']});
   worker=child;
   if(job){job.workerPid=child.pid;saveJob(job);}
   let output='',finished=false,outputSize=0,terminal:StreamEvent|undefined;
   if(streaming&&!asynchronous){res.setHeader('Content-Type','application/x-ndjson; charset=utf-8');res.setHeader('X-Accel-Buffering','no');res.flushHeaders();}
   const send=(event:StreamEvent)=>{if(!res.writableEnded&&!res.destroyed)res.write(JSON.stringify(event)+'\n');};
   const finish=(status:number,result:unknown)=>{
    if(finished)return;finished=true;clearTimeout(timer);if(runtime.active?.token===token)runtime.active=undefined;
    if(job){
     job.finishedAt=new Date().toISOString();
     if(status===200){job.stage='complete';job.progress=100;job.message='Analysis complete. Results are ready to save in the workspace.';job.result=result;}
     else{job.stage='failed';job.error=redact(typeof result==='object'&&result!==null&&'error' in result?String(result.error):'Analysis failed.');job.message=job.error;}
     try{saveJob(job);}catch{/* Polling reports unreadable storage; do not crash the local server. */}return;
    }
    if(streaming){send(status===200?{type:'result',result}:{type:'error',error:typeof result==='object'&&result!==null&&'error' in result?String(result.error):'Analysis failed.'});res.end();}
    else reply(status,result);
   };
   const timer=setTimeout(()=>{child.kill();finish(504,{error:analysis?'Analysis exceeded the 10-minute limit. No results were saved. Retry this batch after checking the model service.':'Operation timed out. Try a smaller input or another source.'});},route.timeout);
   timer.unref();
   const consumeLine=(line:string)=>{
    if(!line.trim())return;
    const event=JSON.parse(line) as StreamEvent;
    if(terminal)throw new Error('Unexpected output after analysis completion.');
    if(event.type==='progress'&&stages.has(event.stage as Stage)&&event.stage!=='complete'&&event.stage!=='failed'&&Number.isFinite(event.progress)&&typeof event.message==='string'){
     if(job){job.stage=event.stage as Stage;job.progress=Math.min(99,Math.max(0,event.progress));job.message=redact(event.message);saveJob(job);}
     else send(event);
    }
    else if(event.type==='result'||event.type==='error')terminal=event;
    else throw new Error('Invalid analysis event.');
   };
   child.stdout.setEncoding('utf8');
   child.stdout.on('data',(chunk:string)=>{
    if(finished)return;
    outputSize+=Buffer.byteLength(chunk);
    if(outputSize>10_000_000){child.kill();finish(502,{error:'Output exceeds the limit.'});return;}
    output+=chunk;
    if(workerStreaming){try{let newline:number;while((newline=output.indexOf('\n'))>=0){consumeLine(output.slice(0,newline));output=output.slice(newline+1);}}catch{child.kill();finish(502,{error:'The analysis server returned an invalid progress response.'});}}
   });
   child.stderr.resume();
   child.on('error',()=>finish(503,{error:'Python could not start. Create .venv and install requirements.txt.'}));
   child.on('close',code=>{
    if(finished)return;
    try{
     if(workerStreaming){consumeLine(output);if(terminal?.type==='result'&&code===0)finish(200,terminal.result);else if(terminal?.type==='error')finish(422,{error:terminal.error});else finish(502,{error:'Analysis stopped before returning a complete result.'});}
     else{const parsed=JSON.parse(output);finish(code===0?200:422,parsed);}
    }catch{finish(502,{error:'Python operation failed. Install requirements.txt and check the server setup.'});}
   });
   if(!asynchronous)res.on('close',()=>{if(!finished){child.kill();finished=true;clearTimeout(timer);if(runtime.active?.token===token)runtime.active=undefined;}});
   child.stdin.on('error',()=>{});child.stdin.end(JSON.stringify(data));
   if(asynchronous){res.setHeader('Preference-Applied','respond-async');reply(202,{jobId:job!.jobId});}
  }catch{
   worker?.kill();
   if(runtime.active?.token===token)runtime.active=undefined;
   if(job){job.stage='failed';job.error='The local analysis worker could not start or save its status.';job.message=job.error;job.finishedAt=new Date().toISOString();try{saveJob(job);}catch{/* The response still reports a storage failure. */}}
   reply(503,{error:'The local operation could not start or save its status.'});
  }
 };
 return {name:'local-python-services',configureServer(server){server.middlewares.use((req,res,next)=>{void handler(req,res,next);});},configurePreviewServer(server){server.middlewares.use((req,res,next)=>{void handler(req,res,next);});}};
}
