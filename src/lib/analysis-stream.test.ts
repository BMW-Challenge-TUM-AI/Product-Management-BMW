import {describe,it,expect,vi} from 'vitest';
import {readAnalysisResponse} from './analysis-stream';

function stream(chunks:string[]){return new Response(new ReadableStream({start(controller){for(const chunk of chunks)controller.enqueue(new TextEncoder().encode(chunk));controller.close();}}),{headers:{'Content-Type':'application/x-ndjson'}});}
describe('analysis progress transport',()=>{
 it('reports backend progress across chunk boundaries and returns only the final result',async()=>{
  const onProgress=vi.fn();
  const response=stream(['{"type":"progress","stage":"extract', 'ing","progress":20,"message":"Reading comments"}\n{"type":"progress","stage":"generating","progress":80,"message":"Preparing drafts"}\n','{"type":"result","result":{"validated":true}}']);
  expect(await readAnalysisResponse(response,onProgress)).toEqual({validated:true});
  expect(onProgress.mock.calls.map(([event])=>event.stage)).toEqual(['extracting','generating']);
 });
 it('preserves backend errors after a stream has started',async()=>{
  await expect(readAnalysisResponse(stream(['{"type":"error","error":"Model request timed out"}\n']),vi.fn())).rejects.toThrow('Model request timed out');
 });
 it('rejects a connection that closes after progress without a result',async()=>{
  await expect(readAnalysisResponse(stream(['{"type":"progress","stage":"extracting","progress":5,"message":"Starting"}\n']),vi.fn())).rejects.toThrow('before results were ready');
 });
 it('supports a JSON response and preserves its error message',async()=>{
  expect(await readAnalysisResponse(Response.json({validated:true}),vi.fn())).toEqual({validated:true});
  await expect(readAnalysisResponse(Response.json({error:'An analysis is already running.'},{status:409}),vi.fn())).rejects.toThrow('already running');
 });
 it('rejects malformed or duplicate terminal responses',async()=>{
  await expect(readAnalysisResponse(stream(['{"type":"result",']),vi.fn())).rejects.toThrow('interrupted');
  await expect(readAnalysisResponse(stream(['{"type":"result","result":{}}\n{"type":"result","result":{}}\n']),vi.fn())).rejects.toThrow('duplicate');
 });
});
