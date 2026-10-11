import {z} from 'npm:zod@4';
import {applyCommand} from '../_shared/workspace.ts';
import {createEmptyWorkspace} from '../_shared/empty-workspace.ts';
import {categories} from '../_shared/types.ts';
import {authenticate,commit,cors,json} from '../_shared/server.ts';
const text=z.string().min(1).max(20000),id=z.string().min(1).max(250),reason=text.trim().min(1);
const score=z.number().min(1).max(5).nullable();const scores=z.object({impact:score,frequency:score,strategy:score,evidence:score,feasibility:score}).strict();
const model=z.object({version:z.number().int().positive(),weights:z.object({impact:z.number(),frequency:z.number(),strategy:z.number(),evidence:z.number(),feasibility:z.number()}).strict(),thresholds:z.object({p1:z.number(),p2:z.number()}).strict(),updatedAt:text}).strict();
const record=z.object({id,datasetId:id,content:z.string().max(50000),fields:z.record(z.string(),z.unknown()),row:z.number().int().positive(),sheet:z.string().optional(),category:z.string().optional()}).strict();
const dataset=z.object({id,projectId:id,name:text,type:z.enum(['Customer verbatims','Equipment list','Sales volumes','Customer study','External research']),synthetic:z.boolean(),status:z.enum(['Ready','Needs mapping','Validation errors']),createdAt:text,records:z.array(record).min(1).max(5000),errors:z.array(z.string()),columns:z.array(z.string()).max(200)}).strict();
const commandSchema=z.discriminatedUnion('type',[
 z.object({type:z.literal('edit'),id,title:z.string().min(5).max(300),statement:z.string().min(20).max(20000),category:z.enum(categories),assumptions:z.string().max(20000),uncertainty:z.string().max(20000),reason}).strict(),
 z.object({type:z.literal('decision'),id,status:z.enum(['Approved','Rejected','Deferred','More evidence requested','Challenged','Awaiting review']),reason}).strict(),
 z.object({type:z.literal('finding'),id,status:z.enum(['New','Validated','Challenged','Excluded']),reason}).strict(),
 z.object({type:z.literal('score'),id,scores,priorityOverride:z.enum(['P1','P2','P3']).optional(),reason}).strict(),
 z.object({type:z.literal('model'),model,reason}).strict(),z.object({type:z.literal('import'),dataset}).strict(),
 z.object({type:z.literal('project'),project:z.object({id,name:text,derivative:text,market:text,horizon:text}).strict()}).strict(),
 z.object({type:z.literal('resolve'),id,reason}).strict(),z.object({type:z.literal('merge'),id,targetId:id,reason}).strict()
]);
Deno.serve(async req=>{if(req.method==='OPTIONS')return new Response('ok',{headers:cors});try{
 const ctx=await authenticate(req);const body=await req.json();
 if(body.operation==='capabilities')return json({ai:!!Deno.env.get('OPENAI_API_KEY')&&!!Deno.env.get('OPENAI_MODEL'),research:false});
 if(body.operation==='load'){if(!ctx.workspace){if(ctx.member.role!=='pm')throw new Error('A PM must initialize this workspace.');const workspace=createEmptyWorkspace();workspace.revision=ctx.revision+1;await commit(ctx,workspace,ctx.revision);return json({workspace});}return json({workspace:ctx.workspace});}
 if(body.operation!=='command'||ctx.member.role!=='pm')return json({error:'PM permission required.'},403);
 if(!ctx.workspace||body.revision!==ctx.revision)return json({error:'The workspace changed. Reload before saving.'},409);
 const command=commandSchema.parse(body.command);
 if(command.type==='import'){
  if(ctx.workspace.datasets.some(d=>d.id===command.dataset.id))throw new Error('Duplicate dataset ID.');
  if(!ctx.workspace.projects.some(p=>p.id===command.dataset.projectId))throw new Error('Invalid project.');
  const knownIds=new Set(ctx.workspace.datasets.flatMap(d=>d.records.map(r=>r.id)));const importedIds=new Set<string>();
  for(const r of command.dataset.records){if(r.datasetId!==command.dataset.id||knownIds.has(r.id)||importedIds.has(r.id))throw new Error('Invalid or duplicate source identity.');importedIds.add(r.id);}
  command.dataset.synthetic=false;command.dataset.createdAt=new Date().toISOString();
  if(command.dataset.errors.length)command.dataset.status='Validation errors';
 }
 if(command.type==='project'&&ctx.workspace.projects.some(p=>p.id===command.project.id))throw new Error('Duplicate project ID.');
 const next=applyCommand(ctx.workspace,command,ctx.user.id);await commit(ctx,next,ctx.revision);return json({workspace:next});
 }catch(e){return json({error:e instanceof Error?e.message:'Request failed.'},400);}});
