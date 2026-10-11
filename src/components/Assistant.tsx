import {useEffect,useMemo,useRef,useState,type ReactNode} from 'react';
import {ArrowUp,BookOpen,ExternalLink,Loader2,MessageCircle,RotateCcw,ShieldCheck,Sparkles,Square,Trash2,X} from 'lucide-react';
import {z} from 'zod';
import {useApp} from '../context';
import {buildAssistantContext,lookupAssistantSource,offlineAssistantAnswer,type AssistantAnswer} from '../lib/assistant-context';
import {getSourceInsights,sourceLocation} from '../lib/source-insights';
import './assistant.css';

type Message={id:string;role:'user'|'assistant';text:string;answer?:AssistantAnswer;mode?:'AI'|'Project guide';error?:string;retryQuestion?:string;revision?:number};
const suggestions=['Summarize the current project and what needs attention.','What did the latest analysis cover?','Which requirements need more evidence?','What changed in the recent PM decisions?'];
const referenceSchema=z.object({type:z.enum(['requirement','finding','audit','run']),id:z.string(),label:z.string().nullish()});
const answerSchema=z.object({answer:z.string().min(1).max(12000),citations:z.array(z.object({source_id:z.string(),quote:z.string().min(1)})).max(12),uncertainty:z.string(),references:z.array(referenceSchema).max(20).optional()});
const historyKey=(projectId:string)=>`insightpilot.chat.v2.${projectId}`;
function readMessages(projectId:string):Message[]{
 try{const saved=JSON.parse(sessionStorage.getItem(historyKey(projectId))??'[]');if(!Array.isArray(saved))return [];return saved.filter((m:Message)=>m&&typeof m.id==='string'&&['user','assistant'].includes(m.role)&&typeof m.text==='string'&&m.text.length<=12000).slice(-40).map((m:Message)=>({...m,answer:m.answer&&answerSchema.safeParse(m.answer).success?m.answer:undefined}));}catch{return [];}
}
function inlineText(text:string):ReactNode[]{return text.split(/(\*\*[^*]+\*\*|`[^`]+`)/g).map((part,i)=>part.startsWith('**')&&part.endsWith('**')?<strong key={i}>{part.slice(2,-2)}</strong>:part.startsWith('`')&&part.endsWith('`')?<code key={i}>{part.slice(1,-1)}</code>:part);}
function AnswerText({text}:{text:string}){return <div className="assistant-answer-text">{text.split(/\n\s*\n/).map((block,i)=>{
 const lines=block.split('\n');
 if(lines.every(line=>/^\s*[-*]\s+/.test(line)))return <ul key={i}>{lines.map((line,j)=><li key={j}>{inlineText(line.replace(/^\s*[-*]\s+/,''))}</li>)}</ul>;
 if(lines.every(line=>/^\s*\d+[.)]\s+/.test(line)))return <ol key={i}>{lines.map((line,j)=><li key={j}>{inlineText(line.replace(/^\s*\d+[.)]\s+/,''))}</li>)}</ol>;
 return <p key={i}>{inlineText(block.replace(/^#{1,4}\s+/,''))}</p>;
 })}</div>;}

export default function Assistant(){
 const {state,project,page,analysis,aiAvailable,cloud,openSource,openRequirement,openFinding,openAudit,navigate}=useApp();
 const liveAssistant=aiAvailable&&!cloud;
 const [open,setOpen]=useState(false),[question,setQuestion]=useState('');
 const [conversation,setConversation]=useState<{projectId:string;messages:Message[]}>(()=>({projectId:project.id,messages:readMessages(project.id)}));
 const [pending,setPending]=useState<{projectId:string;startedAt:number}|null>(null),[elapsed,setElapsed]=useState(0);
 const request=useRef<{controller:AbortController;token:string}|null>(null);
 const currentProject=useRef(project.id);currentProject.current=project.id;
 const scrollArea=useRef<HTMLDivElement>(null);
 const messages=conversation.projectId===project.id?conversation.messages:[];
 const busy=pending?.projectId===project.id;
 useEffect(()=>{request.current?.controller.abort();request.current=null;setPending(null);setQuestion('');setConversation({projectId:project.id,messages:readMessages(project.id)});},[project.id]);
 useEffect(()=>()=>{request.current?.controller.abort();request.current=null;},[]);
 useEffect(()=>{if(conversation.projectId!==project.id)return;try{sessionStorage.setItem(historyKey(project.id),JSON.stringify(conversation.messages.slice(-40)));}catch{/* The conversation can continue in memory. */}},[conversation,project.id]);
 useEffect(()=>{const area=scrollArea.current;if(area)area.scrollTo({top:area.scrollHeight,behavior:'smooth'});},[messages,pending,open]);
 useEffect(()=>{if(!pending)return;const update=()=>setElapsed(Math.floor((Date.now()-pending.startedAt)/1000));update();const timer=setInterval(update,1000);return()=>clearInterval(timer);},[pending]);
 const append=(scope:string,message:Message)=>setConversation(old=>old.projectId===scope?{...old,messages:[...old.messages,message].slice(-40)}:old);
 const stop=()=>{request.current?.controller.abort();request.current=null;setPending(null);};
 const send=async(raw:string,retry=false,localOnly=false)=>{
  const q=raw.trim();if(!q||request.current)return;
  const scope=project.id,revision=state.revision;
  const controller=new AbortController(),token=crypto.randomUUID();request.current={controller,token};
  const repeatsLatest=retry&&messages.at(-1)?.error&&messages.at(-1)?.retryQuestion===q;
  setQuestion('');if(!repeatsLatest)append(scope,{id:crypto.randomUUID(),role:'user',text:q});
  setPending({projectId:scope,startedAt:Date.now()});
  const history=messages.filter(m=>!m.error).map(m=>({role:m.role,content:m.text}));
  // Retrying the last failed question must not include that same turn twice.
  if(repeatsLatest&&history.at(-1)?.role==='user'&&history.at(-1)?.content===q)history.pop();
  const active=()=>currentProject.current===scope&&request.current?.token===token;
  const timer=setTimeout(()=>controller.abort(new Error('The assistant timed out. Try a more focused question.')),65000);
  try{
   const context=buildAssistantContext(state,project,q,{history,currentPage:page,analysis});
   let answer:AssistantAnswer,mode:'AI'|'Project guide'='Project guide';
   if(liveAssistant&&!localOnly){
    const response=await fetch('/api/chat',{method:'POST',headers:{'Content-Type':'application/json','Accept':'application/json'},body:JSON.stringify(context),signal:controller.signal});
    let data:unknown;try{data=await response.json();}catch{throw new Error('The assistant returned an unreadable response. Please retry.');}
    if(!response.ok)throw new Error(data&&typeof data==='object'&&'error'in data?String(data.error):'The assistant request could not be completed.');
    const parsed=answerSchema.parse(data);
    answer={...parsed,references:parsed.references?.map(ref=>({...ref,label:ref.label??undefined}))};mode='AI';
   }else answer=offlineAssistantAnswer(context);
   const allowed=new Map(context.sources.map(s=>[s.id,s.text]));
   if(answer.citations.some(c=>!allowed.get(c.source_id)?.includes(c.quote)))throw new Error('A citation did not match its source. No unverified answer was shown. Retry the question.');
   const referenceIds={requirement:new Set(context.requirements.map(r=>r.id)),finding:new Set(context.findings.map(f=>f.id)),audit:new Set(context.audit.map(a=>a.id)),run:new Set(context.runs.map(r=>r.id))};
   if(answer.references?.some(ref=>!referenceIds[ref.type].has(ref.id)))throw new Error('An answer linked to a record outside the selected context. Please retry.');
   if(active())append(scope,{id:crypto.randomUUID(),role:'assistant',text:answer.answer,answer,mode,revision});
  }catch(error){
   if(active()){
    const errorText=controller.signal.aborted?'The response timed out. Your project and conversation are saved; retry this question.':error instanceof z.ZodError?'The assistant returned an invalid answer format. Please retry.':error instanceof Error?error.message:'The assistant could not complete this response.';
    append(scope,{id:crypto.randomUUID(),role:'assistant',text:'The live answer could not be completed.',error:errorText,retryQuestion:q,revision});
   }
  }finally{clearTimeout(timer);if(active()){request.current=null;setPending(null);}}
 };
 const openReference=(ref:NonNullable<AssistantAnswer['references']>[number])=>{
  if(ref.type==='requirement'){const item=state.requirements.find(r=>r.projectId===project.id&&r.id===ref.id);if(item){setOpen(false);openRequirement(item);}}
  if(ref.type==='finding'){const item=state.findings.find(f=>f.projectId===project.id&&f.id===ref.id);if(item){setOpen(false);openFinding(item);}}
  if(ref.type==='audit'){const item=state.audit.find(a=>a.projectId===project.id&&a.id===ref.id);if(item){setOpen(false);openAudit(item);}}
  if(ref.type==='run'){const event=state.audit.find(a=>a.projectId===project.id&&a.entityId===ref.id);setOpen(false);if(event)openAudit(event);else navigate('Audit Trail');}
 };
 const feedbackCount=useMemo(()=>getSourceInsights(state,project.id).feedbackCount,[state.datasets,project.id]);
 const requirementCount=state.requirements.filter(r=>r.projectId===project.id&&!r.synthetic).length;
 return <div className="assistant-root">
  {open&&<section className="assistant-panel" aria-label="InsightPilot assistant">
   <header className="assistant-header"><div className="assistant-avatar"><Sparkles size={18}/></div><div><strong>InsightPilot Assistant</strong><span>{liveAssistant?'Live AI':'Local project guide'} · {project.derivative} / {project.market}</span></div><button aria-label="Start a new conversation" title="Start a new conversation" disabled={busy||!messages.length} onClick={()=>{setConversation({projectId:project.id,messages:[]});setQuestion('');}}><Trash2 size={16}/></button><button aria-label="Close assistant panel" onClick={()=>setOpen(false)}><X size={18}/></button></header>
   <div className="assistant-context-strip"><span>{feedbackCount.toLocaleString()} comments · {requirementCount} requirements</span><span>{page}</span><button disabled={busy} onClick={()=>void send('Summarize the current project and what needs attention.',false,true)} title="Computed from project records without an AI request">Local summary</button></div>
   <div ref={scrollArea} className="assistant-messages" role="log" aria-live="polite">
    {!messages.length&&<div className="assistant-welcome"><div className="assistant-welcome-icon"><BookOpen size={24}/></div><h3>Understand this project</h3><p>Ask about customer themes, analysis coverage, evidence gaps, priorities, or recent decisions. Follow up naturally; I keep this conversation’s context.</p><div className="assistant-suggestions">{suggestions.map(s=><button key={s} onClick={()=>void send(s)}>{s}</button>)}</div></div>}
    {messages.map(m=><div key={m.id} className={`assistant-message ${m.role}`}><div className={`assistant-bubble ${m.error?'assistant-error':''}`}>
     {m.role==='assistant'&&<small>{m.error?'Request interrupted':m.mode}</small>}
     <AnswerText text={m.error??m.text}/>
     {m.error&&m.retryQuestion&&<button className="assistant-retry" disabled={busy} onClick={()=>void send(m.retryQuestion!,true)}><RotateCcw size={13}/>Retry question</button>}
     {m.answer?.uncertainty&&<p className="assistant-uncertainty"><ShieldCheck size={13}/>{m.answer.uncertainty}</p>}
     {!!m.answer?.references?.length&&<div className="assistant-reference-links">{m.answer.references.map(ref=><button key={`${ref.type}-${ref.id}`} onClick={()=>openReference(ref)}><ExternalLink size={12}/>{ref.label||ref.id}</button>)}</div>}
     {!!m.answer?.citations.length&&<div className="assistant-citations"><span>Check the original evidence</span>{m.answer.citations.map((c,j)=>{
      const source=lookupAssistantSource(state,project.id,c.source_id);
      const originalId=source?.fields._originalId;
      const location=source?sourceLocation(source):null;
      return <button key={`${c.source_id}-${j}`} onClick={()=>{if(source){setOpen(false);openSource(source);}}} disabled={!source}><strong>{String(originalId??c.source_id)}</strong><span>“{c.quote.slice(0,220)}{c.quote.length>220?'…':''}”</span><small>{location?.file??'Source record'}{location?` · ${location.sheet?`${location.sheet} · `:''}Row ${location.row}`:''}</small></button>;
     })}</div>}
     {m.role==='assistant'&&!m.error&&m.revision!==undefined&&m.revision!==state.revision&&<div className="assistant-stale">The project has changed since this answer. Ask again for current status.</div>}
    </div></div>)}
    {busy&&<div className="assistant-message assistant"><div className="assistant-bubble assistant-thinking"><Loader2 className="spin" size={15}/><span>{elapsed<8?'Reading the current project and relevant evidence…':'Preparing a source-linked answer…'}<small>{elapsed}s · You can keep working</small></span></div></div>}
   </div>
   <form className="assistant-composer" onSubmit={e=>{e.preventDefault();void send(question);}}><label className="sr-only" htmlFor="assistant-question">Ask the assistant</label><textarea id="assistant-question" value={question} onChange={e=>setQuestion(e.target.value)} maxLength={600} rows={2} placeholder="Ask about this project or follow up…" onKeyDown={e=>{if(e.key==='Enter'&&!e.shiftKey&&!e.nativeEvent.isComposing){e.preventDefault();if(!busy)void send(question);}}}/>{busy?<button type="button" aria-label="Stop response" title="Stop response" onClick={stop}><Square size={15}/></button>:<button type="submit" aria-label="Send question" disabled={!question.trim()}><ArrowUp size={18}/></button>}</form>
   <div className="assistant-footnote">{liveAssistant?'Sends this question, recent chat, and selected project context to OpenAI.':'Uses local project records. Live AI needs the local server and API key.'} Decisions stay with you.</div>
  </section>}
  <button className="assistant-launcher" onClick={()=>setOpen(value=>!value)} aria-label={open?'Close assistant':'Open assistant'} aria-expanded={open}><MessageCircle size={21}/><span>Ask InsightPilot</span></button>
 </div>;
}
