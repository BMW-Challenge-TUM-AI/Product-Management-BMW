import {z} from 'zod';
import type {LiveAnalysisProgress} from './storage';

const eventSchema=z.discriminatedUnion('type',[
 z.object({type:z.literal('progress'),stage:z.enum(['extracting','clustering','generating','committing']),progress:z.number().min(0).max(100),message:z.string()}),
 z.object({type:z.literal('result'),result:z.unknown()}),
 z.object({type:z.literal('error'),error:z.string()}),
]);

/** Read actual backend progress without publishing an incomplete result. */
export async function readAnalysisResponse(response:Response,onProgress:(progress:LiveAnalysisProgress)=>void):Promise<unknown>{
 if(!response.ok||!response.headers.get('content-type')?.includes('application/x-ndjson')){
  let data:unknown;
  try{data=await response.json();}catch{throw new Error('The analysis server returned an unreadable response. Check that the local server is still running.');}
  if(!response.ok)throw new Error(typeof data==='object'&&data&&'error' in data?String(data.error):'AI analysis failed.');
  return data;
 }
 if(!response.body)throw new Error('The analysis server did not return a progress stream.');
 const reader=response.body.getReader(),decoder=new TextDecoder();
 let pending='',result:unknown,receivedResult=false;
 const consume=(line:string)=>{
  if(!line.trim())return;
  let raw:unknown;
  try{raw=JSON.parse(line);}catch{throw new Error('The analysis response was interrupted or incomplete. No results were saved.');}
  const parsed=eventSchema.safeParse(raw);
  if(!parsed.success)throw new Error('The analysis server returned an invalid progress message.');
  const event=parsed.data;
  if(event.type==='error')throw new Error(event.error);
  if(event.type==='progress')onProgress({jobId:'local',stage:event.stage,progress:event.progress,message:event.message});
  if(event.type==='result'){
   if(receivedResult)throw new Error('The analysis server returned duplicate results.');
   result=event.result;receivedResult=true;
  }
 };
 try{
  while(true){
   const {done,value}=await reader.read();
   pending+=decoder.decode(value,{stream:!done});
   if(pending.length>10_000_000)throw new Error('The analysis response exceeds the supported size.');
   let newline:number;
   while((newline=pending.indexOf('\n'))!==-1){consume(pending.slice(0,newline));pending=pending.slice(newline+1);}
   if(done){consume(pending);break;}
  }
 }finally{reader.releaseLock();}
 if(!receivedResult)throw new Error('The analysis connection ended before results were ready. No results were saved; retry the batch.');
 return result;
}
