import {EventEmitter} from 'node:events';
import {PassThrough,Readable} from 'node:stream';
import type {IncomingMessage,ServerResponse} from 'node:http';
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {spawn} from 'node:child_process';
import {mkdtempSync,readFileSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {localAI} from './local-ai';
vi.mock('node:child_process',()=>({spawn:vi.fn()}));
type Middleware=(req:IncomingMessage,res:ServerResponse,next:()=>void)=>void;
class Reply extends EventEmitter {
 statusCode=200;writableEnded=false;destroyed=false;body='';flushed=false;headers:Record<string,string>={};
 setHeader(name:string,value:string){this.headers[name]=value;}
 flushHeaders(){this.flushed=true;}
 write(value:string){this.body+=value;return true;}
 end(value=''){this.body+=value;this.writableEnded=true;}
}
const temporaryDirectories:string[]=[];
function setup(directory=mkdtempSync(join(tmpdir(),'analysis-transport-'))){
 temporaryDirectories.push(directory);
 const child=Object.assign(new EventEmitter(),{pid:process.pid,stdout:new PassThrough(),stderr:new PassThrough(),stdin:new PassThrough(),kill:vi.fn()});
 vi.mocked(spawn).mockReturnValue(child as unknown as ReturnType<typeof spawn>);
 let middleware:Middleware=()=>{};
 const plugin=localAI({OPENAI_API_KEY:'test-only',ANALYSIS_JOB_DIR:directory});
 const configure=plugin.configureServer as (server:{middlewares:{use:(fn:Middleware)=>void}})=>unknown;
 configure({middlewares:{use:fn=>{middleware=fn;}}});
 async function send(url:string,method:string,body?:unknown,headers:Record<string,string>={}){
  const req=Readable.from(body===undefined?[]:[JSON.stringify(body)]) as IncomingMessage;
  req.url=url;req.method=method;req.headers={host:'127.0.0.1:5173',...headers};
  const reply=new Reply();middleware(req,reply as unknown as ServerResponse,()=>{});
  await new Promise(resolve=>setImmediate(resolve));
  return reply;
 }
 const request=(streaming=true)=>send('/api/analyze','POST',{records:[{}]},streaming?{accept:'application/x-ndjson'}:{});
 const startJob=(jobId:string)=>send('/api/analyze','POST',{jobId,records:[{}]},{prefer:'respond-async',accept:'application/json'});
 const getJob=(jobId:string)=>send(`/api/analysis/${jobId}`,'GET');
 return {child,request,startJob,getJob,send,directory};
}
beforeEach(()=>vi.mocked(spawn).mockReset());
afterEach(()=>{vi.useRealTimers();for(const directory of temporaryDirectories.splice(0))rmSync(directory,{recursive:true,force:true});});
describe('local analysis stream transport',()=>{
 it('streams split UTF-8 progress and returns one result after child success',async()=>{
  const {child,request}=setup();const reply=await request();
  expect(reply.flushed).toBe(true);expect(reply.headers['Content-Type']).toContain('application/x-ndjson');
  expect(vi.mocked(spawn).mock.calls[0][1]).toContain('--stream');
  const line=Buffer.from(JSON.stringify({type:'progress',stage:'extracting',progress:55,message:'Überprüft'})+'\n');
  const split=line.indexOf(Buffer.from('Ü'))+1;
  child.stdout.write(line.subarray(0,split));child.stdout.write(line.subarray(split));
  child.stdout.write(JSON.stringify({type:'result',result:{findings:[]}})+'\n');
  expect(reply.writableEnded).toBe(false);child.emit('close',0);
  const events=reply.body.trim().split('\n').map(line=>JSON.parse(line));
  expect(events.map(event=>event.type)).toEqual(['progress','result']);expect(events[0].message).toBe('Überprüft');
  expect(reply.writableEnded).toBe(true);
 });
 it('ends provider failure visibly and releases the active run',async()=>{
  const {child,request}=setup();const reply=await request();
  child.stdout.write(JSON.stringify({type:'error',error:'The model service timed out.'})+'\n');child.emit('close',1);
  expect(JSON.parse(reply.body).error).toContain('timed out');
  const next=await request();expect(next.statusCode).toBe(200);next.emit('close');
 });
 it('kills a disconnected run and releases its lock',async()=>{
  const {child,request}=setup();const reply=await request();
  const duplicate=await request();expect(duplicate.statusCode).toBe(409);
  reply.destroyed=true;reply.emit('close');expect(child.kill).toHaveBeenCalledOnce();
  const next=await request();expect(next.statusCode).toBe(200);next.emit('close');
 });
 it('keeps the non-streaming JSON response contract',async()=>{
  const {child,request}=setup();const reply=await request(false);
  child.stdout.write(JSON.stringify({findings:[]}));child.emit('close',0);
  expect(JSON.parse(reply.body)).toEqual({findings:[]});expect(reply.headers['Content-Type']).toBe('application/json');
 });
 it('returns an explicit error for an incomplete child response',async()=>{
  const {child,request}=setup();const reply=await request();child.emit('close',0);
  expect(JSON.parse(reply.body)).toEqual({type:'error',error:'Analysis stopped before returning a complete result.'});
 });
});

describe('recoverable local analysis jobs',()=>{
 it('acknowledges immediately, survives disconnect, and persists progress and the complete result',async()=>{
  const {child,startJob,getJob,directory}=setup();const jobId=randomUUID();
  const reply=await startJob(jobId);
  expect(reply.statusCode).toBe(202);expect(reply.writableEnded).toBe(true);
  expect(JSON.parse(reply.body)).toEqual({jobId});expect(reply.headers['Preference-Applied']).toBe('respond-async');
  expect(vi.mocked(spawn).mock.calls[0][1]).toContain('--stream');
  reply.destroyed=true;reply.emit('close');expect(child.kill).not.toHaveBeenCalled();
  child.stdout.write(JSON.stringify({type:'progress',stage:'clustering',progress:65,message:'Grouping source evidence.'})+'\n');
  const progress=JSON.parse((await getJob(jobId)).body);
  expect(progress).toMatchObject({jobId,stage:'clustering',progress:65,message:'Grouping source evidence.'});
  expect(progress).not.toHaveProperty('workerPid');expect(progress).not.toHaveProperty('ownerPid');
  child.stdout.write(JSON.stringify({type:'result',result:{findings:[],requirements:[]}})+'\n');child.emit('close',0);
  const complete=JSON.parse((await getJob(jobId)).body);
  expect(complete).toMatchObject({jobId,stage:'complete',progress:100,result:{findings:[],requirements:[]}});
  expect(complete.finishedAt).toBeTruthy();
  expect(JSON.parse(readFileSync(join(directory,`${jobId}.json`),'utf8')).stage).toBe('complete');
 });

 it('resumes through another plugin instance and never starts a duplicate job',async()=>{
  const initial=setup();const jobId=randomUUID();await initial.startJob(jobId);
  const reload=setup(initial.directory);
  expect((await reload.getJob(jobId)).statusCode).toBe(200);
  expect((await reload.startJob(jobId)).statusCode).toBe(202);
  const duplicate=await reload.startJob(randomUUID());
  expect(duplicate.statusCode).toBe(409);expect(JSON.parse(duplicate.body).jobId).toBe(jobId);
  expect((await reload.request()).statusCode).toBe(409);
  expect(vi.mocked(spawn)).toHaveBeenCalledOnce();
  initial.child.stdout.write(JSON.stringify({type:'result',result:{findings:[]}})+'\n');initial.child.emit('close',0);
  expect(JSON.parse((await reload.getJob(jobId)).body).stage).toBe('complete');
  expect((await reload.startJob(jobId)).statusCode).toBe(202);expect(vi.mocked(spawn)).toHaveBeenCalledOnce();
 });

 it('reads completed and failed jobs from disk without rerunning either request',async()=>{
  const {directory,getJob,startJob}=setup();
  for(const stage of ['complete','failed']){
   const jobId=randomUUID();
   writeFileSync(join(directory,`${jobId}.json`),JSON.stringify({jobId,stage,progress:stage==='complete'?100:45,message:stage,startedAt:new Date().toISOString(),finishedAt:new Date().toISOString(),ownerPid:0,...(stage==='complete'?{result:{findings:[]}}:{error:'Provider timed out.'})}));
   expect(JSON.parse((await getJob(jobId)).body).stage).toBe(stage);
   expect((await startJob(jobId)).statusCode).toBe(202);
  }
  expect(vi.mocked(spawn)).not.toHaveBeenCalled();
 });

 it('rejects malformed identifiers and enforces same-origin access on status and submission',async()=>{
  const {startJob,getJob,send}=setup();
  expect((await startJob('../outside')).statusCode).toBe(400);
  expect((await getJob('../outside')).statusCode).toBe(400);
  expect((await getJob(randomUUID())).statusCode).toBe(404);
  expect((await send(`/api/analysis/${randomUUID()}`,'GET',undefined,{origin:'https://other.example'})).statusCode).toBe(403);
  expect((await send('/api/analyze','POST',{jobId:randomUUID(),records:[{}]},{prefer:'respond-async',origin:'https://other.example'})).statusCode).toBe(403);
  expect(vi.mocked(spawn)).not.toHaveBeenCalled();
 });

 it('marks an orphaned worker failed and preserves its ID to prevent a silent paid retry',async()=>{
  const {directory,getJob,startJob}=setup();const jobId=randomUUID();
  writeFileSync(join(directory,`${jobId}.json`),JSON.stringify({jobId,stage:'extracting',progress:12,message:'Working',startedAt:new Date().toISOString(),ownerPid:process.pid,workerPid:99999999}));
  const recovered=JSON.parse((await getJob(jobId)).body);
  expect(recovered.stage).toBe('failed');expect(recovered.error).toContain('worker stopped');
  expect((await startJob(jobId)).statusCode).toBe(202);expect(vi.mocked(spawn)).not.toHaveBeenCalled();
 });

 it('expires a stale job even if its recorded process IDs still exist',async()=>{
  const {directory,getJob}=setup();const jobId=randomUUID();
  writeFileSync(join(directory,`${jobId}.json`),JSON.stringify({jobId,stage:'generating',progress:80,message:'Working',startedAt:new Date(Date.now()-601_000).toISOString(),ownerPid:process.pid,workerPid:process.pid}));
  const recovered=JSON.parse((await getJob(jobId)).body);
  expect(recovered.stage).toBe('failed');expect(recovered.error).toContain('10-minute');
 });

 it('claims concurrently submitted copies of the same ID only once',async()=>{
  const {startJob,child}=setup();const jobId=randomUUID();
  const replies=await Promise.all([startJob(jobId),startJob(jobId)]);
  expect(replies.map(reply=>reply.statusCode)).toEqual([202,202]);expect(vi.mocked(spawn)).toHaveBeenCalledOnce();
  child.stdout.write(JSON.stringify({type:'result',result:{findings:[]}})+'\n');child.emit('close',0);
 });

 it('saves provider failures without leaking the configured credential and releases the lock',async()=>{
  const {child,startJob,getJob,directory}=setup();const jobId=randomUUID();await startJob(jobId);
  child.stdout.write(JSON.stringify({type:'error',error:'Authentication failed for test-only.'})+'\n');child.emit('close',1);
  expect(JSON.parse((await getJob(jobId)).body)).toMatchObject({stage:'failed',error:'Authentication failed for [redacted].'});
  expect(readFileSync(join(directory,`${jobId}.json`),'utf8')).not.toContain('test-only');
  const next=await startJob(randomUUID());expect(next.statusCode).toBe(202);
  child.emit('error',new Error('Mock worker stop'));
 });
});
