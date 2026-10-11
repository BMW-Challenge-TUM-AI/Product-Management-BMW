import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {createPendingAnalysis,getPendingAnalysis,clearPendingAnalysis,startAnalysisJob,waitForAnalysisJob} from './analysis-jobs';
import {integratePythonResult} from './python-analysis';
import {createEmptyWorkspace} from '../data/empty-workspace';

const storageKey='insightpilot.pending-analysis.v1';
const values=new Map<string,string>();
const request=vi.fn<typeof fetch>();
const progress=vi.fn();
const completed=(jobId:string,result:unknown={findings:[],clusters:[],proposed_requirements:[],validation_errors:[]})=>Response.json({jobId,stage:'complete',progress:100,message:'Ready',result});

beforeEach(()=>{
 vi.useFakeTimers();vi.setSystemTime(new Date('2026-10-11T00:00:00Z'));
 values.clear();request.mockReset();progress.mockReset();
 vi.stubGlobal('localStorage',{getItem:(key:string)=>values.get(key)??null,setItem:(key:string,value:string)=>values.set(key,value),removeItem:(key:string)=>values.delete(key)});
 vi.stubGlobal('fetch',request);
});
afterEach(()=>{vi.useRealTimers();vi.unstubAllGlobals();});

describe('recoverable analysis client',()=>{
 it('persists only job metadata and requests the asynchronous response contract',async()=>{
  const pending=createPendingAnalysis('project',['dataset'],0);
  request.mockResolvedValue(Response.json({jobId:pending.jobId},{status:202}));
  await startAnalysisJob(pending,[{source_id:'original-source-reference'}]);
  expect(getPendingAnalysis()).toEqual(pending);
  const [url,options]=request.mock.calls[0];
  expect(url).toBe('/api/analyze');
  expect(options?.headers).toMatchObject({Prefer:'respond-async',Accept:'application/json'});
  expect(JSON.parse(String(options?.body))).toEqual({jobId:pending.jobId,records:[{source_id:'original-source-reference'}]});
  expect(values.get(storageKey)).not.toContain('original-source-reference');
 });

 it('polls a restored job without submitting source records again and leaves clearing until saving',async()=>{
  const pending=createPendingAnalysis('project',['dataset'],1);
  request.mockResolvedValueOnce(Response.json({jobId:pending.jobId,stage:'generating',progress:85,message:'Preparing drafts'})).mockResolvedValueOnce(completed(pending.jobId));
  const waiting=waitForAnalysisJob(getPendingAnalysis()!,progress);
  await vi.advanceTimersByTimeAsync(1000);
  expect(await waiting).toMatchObject({proposed_requirements:[]});
  expect(progress).toHaveBeenCalledWith({jobId:pending.jobId,stage:'generating',progress:85,message:'Preparing drafts'});
  expect(request.mock.calls.every(([url,options])=>url===`/api/analysis/${pending.jobId}`&&!options?.method)).toBe(true);
  expect(getPendingAnalysis()?.jobId).toBe(pending.jobId);
  clearPendingAnalysis(pending.jobId);expect(getPendingAnalysis()).toBeNull();
 });

 it('recovers a completed disk result after the browser has been closed longer than the running limit',async()=>{
  const pending=createPendingAnalysis('project',['dataset'],0);
  vi.advanceTimersByTime(24*60*60*1000);
  request.mockResolvedValue(completed(pending.jobId));
  expect(await waitForAnalysisJob(pending,progress)).toMatchObject({findings:[]});
  expect(request).toHaveBeenCalledOnce();expect(getPendingAnalysis()?.jobId).toBe(pending.jobId);
 });

 it('retains a submission with a lost acknowledgment so recovery checks the same job instead of reposting',async()=>{
  const pending=createPendingAnalysis('project',['dataset'],0);
  request.mockRejectedValueOnce(new TypeError('Connection interrupted'));
  await expect(startAnalysisJob(pending,[{source_id:'original-source-reference'}])).rejects.toThrow('Connection interrupted');
  expect(getPendingAnalysis()).toEqual(pending);
  request.mockResolvedValueOnce(completed(pending.jobId));
  await waitForAnalysisJob(getPendingAnalysis()!,progress);
  expect(request.mock.calls.map(([url])=>url)).toEqual(['/api/analyze',`/api/analysis/${pending.jobId}`]);
 });

 it('clears provider failure and invalid completion states instead of resuming them forever',async()=>{
  for(const response of [
   (jobId:string)=>Response.json({jobId,stage:'failed',progress:40,message:'Provider stopped',error:'Provider timed out'}),
   (jobId:string)=>Response.json({jobId,stage:'complete',progress:100,message:'Ready'}),
   (jobId:string)=>Response.json({jobId,stage:'generating',progress:101,message:'Invalid progress'}),
   ()=>completed(crypto.randomUUID()),
   ()=>new Response('not JSON'),
  ]){
   const pending=createPendingAnalysis('project',['dataset'],0);
   request.mockResolvedValueOnce(response(pending.jobId));
   await expect(waitForAnalysisJob(pending,progress)).rejects.toThrow();
   expect(getPendingAnalysis()).toBeNull();
  }
  expect(request).toHaveBeenCalledTimes(5);
 });

 it('clears rejected and mismatched submission responses',async()=>{
  for(const response of [Response.json({error:'An analysis is already running.'},{status:409}),Response.json({jobId:crypto.randomUUID()},{status:202}),new Response('<html>unavailable</html>',{status:503})]){
   const pending=createPendingAnalysis('project',['dataset'],0);request.mockResolvedValueOnce(response);
   await expect(startAnalysisJob(pending,[])).rejects.toThrow();expect(getPendingAnalysis()).toBeNull();
  }
 });

 it('bounds missing-job retries and clears metadata after a definitively absent job',async()=>{
  const pending=createPendingAnalysis('project',['dataset'],0);
  request.mockImplementation(async()=>Response.json({error:'Analysis job was not found.'},{status:404}));
  const rejection=expect(waitForAnalysisJob(pending,progress)).rejects.toThrow('not found');
  await vi.runAllTimersAsync();await rejection;
  expect(request).toHaveBeenCalledTimes(11);expect(getPendingAnalysis()).toBeNull();
 });

 it('bounds connection retries while preserving the recoverable server job',async()=>{
  const pending=createPendingAnalysis('project',['dataset'],0);request.mockRejectedValue(new TypeError('Offline'));
  const rejection=expect(waitForAnalysisJob(pending,progress)).rejects.toThrow('Reload the app to reconnect');
  await vi.runAllTimersAsync();await rejection;
  expect(request).toHaveBeenCalledTimes(15);expect(getPendingAnalysis()).toEqual(pending);
 });

 it('expires an old still-running job after inspecting its current status',async()=>{
  const pending=createPendingAnalysis('project',['dataset'],0);vi.advanceTimersByTime(901_000);
  request.mockResolvedValue(Response.json({jobId:pending.jobId,stage:'extracting',progress:10,message:'Working'}));
  await expect(waitForAnalysisJob(pending,progress)).rejects.toThrow('time limit');
  expect(request).toHaveBeenCalledOnce();expect(getPendingAnalysis()).toBeNull();
 });

 it('removes corrupt metadata and never clears a newer pending job through an older callback',()=>{
  values.set(storageKey,'{"jobId":"broken"}');expect(getPendingAnalysis()).toBeNull();expect(values.has(storageKey)).toBe(false);
  const older=createPendingAnalysis('project',['dataset'],0);const newer=createPendingAnalysis('project',['dataset'],1);
  clearPendingAnalysis(older.jobId);expect(getPendingAnalysis()).toEqual(newer);
 });

 it('returns the saved workspace unchanged when reapplying an already committed job ID',()=>{
  const pending=createPendingAnalysis('project',['dataset'],0);const state=createEmptyWorkspace();
  state.runs.push({id:`RUN-${pending.jobId}`,projectId:'project',datasets:['dataset'],at:new Date().toISOString(),mode:'AI',findingIds:[],requirementIds:[]});
  expect(integratePythonResult(state,'project',['dataset'],null,0,pending.jobId)).toBe(state);
  expect(state.runs).toHaveLength(1);expect(state.audit).toHaveLength(0);
 });
});
