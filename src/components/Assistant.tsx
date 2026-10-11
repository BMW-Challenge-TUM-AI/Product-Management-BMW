import {useEffect,useMemo,useRef,useState,type ReactNode} from 'react';
import {ArrowUp,BookOpen,ChevronDown,ExternalLink,Loader2,MessageCircle,Mic,RotateCcw,Sparkles,Square,Trash2,VolumeX,X} from 'lucide-react';
import {z} from 'zod';
import {useApp} from '../context';
import {buildAssistantContext,lookupAssistantSource,offlineAssistantAnswer,type AssistantAnswer} from '../lib/assistant-context';
import {getSourceInsights,sourceLocation} from '../lib/source-insights';
import './assistant.css';

type Message={id:string;role:'user'|'assistant';text:string;answer?:AssistantAnswer;mode?:'AI'|'Project guide';error?:string;retryQuestion?:string;revision?:number;voice?:boolean};
type BrowserSpeechRecognition={
 lang:string;continuous:boolean;interimResults:boolean;maxAlternatives:number;
 onresult:((event:{results:SpeechRecognitionResultList})=>void)|null;
 onerror:((event:{error:string})=>void)|null;
 onend:(()=>void)|null;
 start:()=>void;stop:()=>void;abort:()=>void;
};
type SpeechRecognitionWindow=Window&{
 SpeechRecognition?:new()=>BrowserSpeechRecognition;
 webkitSpeechRecognition?:new()=>BrowserSpeechRecognition;
};
type VoiceRecording={recorder:MediaRecorder;stream:MediaStream;chunks:Blob[];timer:ReturnType<typeof setTimeout>|null;monitor:ReturnType<typeof setInterval>|null;audioContext:AudioContext|null};
const suggestions=['Summarize the current project and what needs attention.','What did the latest analysis cover?','Which requirements need more evidence?','What changed in the recent PM decisions?'];
const referenceSchema=z.object({type:z.enum(['requirement','finding','audit','run']),id:z.string(),label:z.string().nullish()});
const answerSchema=z.object({answer:z.string().min(1).max(12000),citations:z.array(z.object({source_id:z.string(),quote:z.string().min(1)})).max(12),uncertainty:z.string(),references:z.array(referenceSchema).max(20).optional()});
const historyKey=(projectId:string)=>`insightpilot.chat.v2.${projectId}`;
function speechChunks(text:string):string[]{
 const chunks:string[]=[];let remaining=text.trim();
 while(remaining){
  if(remaining.length<=3900){chunks.push(remaining);break;}
  let end=remaining.lastIndexOf('. ',3900);
  if(end>=2000)end++;else end=remaining.lastIndexOf(' ',3900);
  if(end<1)end=3900;
  chunks.push(remaining.slice(0,end).trim());remaining=remaining.slice(end).trim();
 }
 return chunks;
}
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
 const [listening,setListening]=useState(false),[transcribing,setTranscribing]=useState(false),[speaking,setSpeaking]=useState(false),[voiceError,setVoiceError]=useState(''),[voiceStatus,setVoiceStatus]=useState('');
 const [conversation,setConversation]=useState<{projectId:string;messages:Message[]}>(()=>({projectId:project.id,messages:readMessages(project.id)}));
 const [pending,setPending]=useState<{projectId:string;startedAt:number}|null>(null),[elapsed,setElapsed]=useState(0);
 const request=useRef<{controller:AbortController;token:string}|null>(null);
 const recognitionRef=useRef<BrowserSpeechRecognition|null>(null),utteranceRef=useRef<SpeechSynthesisUtterance|null>(null);
 const speechRequest=useRef<AbortController|null>(null),audioRef=useRef<HTMLAudioElement|null>(null),audioUrl=useRef<string|null>(null);
 const recordingRef=useRef<VoiceRecording|null>(null),voiceAttempt=useRef(0),transcriptionRequest=useRef<AbortController|null>(null);
 const sendRef=useRef<(raw:string,retry?:boolean,localOnly?:boolean,voice?:boolean)=>Promise<void>>(async()=>{});
 const currentProject=useRef(project.id);currentProject.current=project.id;
 const panelOpen=useRef(open);panelOpen.current=open;
 const scrollArea=useRef<HTMLDivElement>(null);
 const messages=conversation.projectId===project.id?conversation.messages:[];
 const busy=pending?.projectId===project.id;
 const cancelListening=(updateState=true)=>{
  voiceAttempt.current++;
  const recognition=recognitionRef.current;recognitionRef.current=null;
  if(recognition){recognition.onresult=null;recognition.onerror=null;recognition.onend=null;try{recognition.abort();}catch{/* Recognition may already have ended. */}}
  const recording=recordingRef.current;recordingRef.current=null;
  if(recording){
   if(recording.timer)clearTimeout(recording.timer);
   if(recording.monitor)clearInterval(recording.monitor);
   if(recording.audioContext)void recording.audioContext.close();
   recording.recorder.ondataavailable=null;recording.recorder.onstop=null;recording.recorder.onerror=null;
   if(recording.recorder.state!=='inactive')recording.recorder.stop();
   recording.stream.getTracks().forEach(track=>track.stop());
  }
  transcriptionRequest.current?.abort();transcriptionRequest.current=null;
  if(updateState){setListening(false);setTranscribing(false);setVoiceStatus('');}
 };
 const stopSpeaking=(updateState=true)=>{
  speechRequest.current?.abort();speechRequest.current=null;
  const audio=audioRef.current;audioRef.current=null;
  if(audio){audio.pause();audio.removeAttribute('src');audio.load();}
  if(audioUrl.current){URL.revokeObjectURL(audioUrl.current);audioUrl.current=null;}
  const utterance=utteranceRef.current;utteranceRef.current=null;
  if(utterance){utterance.onend=null;utterance.onerror=null;}
  if('speechSynthesis'in window)window.speechSynthesis.cancel();
  if(updateState)setSpeaking(false);
 };
 const closePanel=()=>{panelOpen.current=false;cancelListening();stopSpeaking();setOpen(false);};
 const speakWithOpenAI=async(spoken:string)=>{
  stopSpeaking();
  const controller=new AbortController();speechRequest.current=controller;setSpeaking(true);
  try{
   for(const chunk of speechChunks(spoken)){
    if(controller.signal.aborted)return;
    const response=await fetch('/api/speech',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({text:chunk}),signal:controller.signal});
    if(!response.ok){
     let message='The smoother voice is unavailable. The answer is still shown above.';
     try{const data:unknown=await response.json();if(data&&typeof data==='object'&&'error'in data)message=String(data.error);}catch{/* Keep the plain playback error. */}
     throw new Error(message);
    }
    const blob=await response.blob();
    if(controller.signal.aborted)return;
    if(!blob.size)throw new Error('The speech service returned no audio. The answer is still shown above.');
    const url=URL.createObjectURL(blob),audio=new Audio(url);
    audioRef.current=audio;audioUrl.current=url;
    try{
     await new Promise<void>((resolve,reject)=>{
      const finish=()=>{controller.signal.removeEventListener('abort',finish);resolve();};
      controller.signal.addEventListener('abort',finish,{once:true});
      audio.onended=finish;
      audio.onerror=()=>{controller.signal.removeEventListener('abort',finish);reject(new Error('Audio playback failed. The answer is still shown above.'));};
      void audio.play().catch(reject);
     });
    }finally{
     if(audioRef.current===audio){audioRef.current=null;audio.pause();audio.removeAttribute('src');URL.revokeObjectURL(url);audioUrl.current=null;}
    }
   }
  }catch(error){
   if(!controller.signal.aborted&&speechRequest.current===controller)setVoiceError(error instanceof Error?error.message:'Audio playback failed. The answer is still shown above.');
  }finally{if(speechRequest.current===controller){speechRequest.current=null;setSpeaking(false);}}
 };
 const speakAnswer=(answer:string)=>{
  const spoken=answer.replace(/\[([^\]]+)\]\([^)]+\)/g,'$1').replace(/[`*_#]/g,'').replace(/^\s*[-]+\s+/gm,'').replace(/\s+/g,' ').trim();
  if(!spoken)return;
  if(liveAssistant){void speakWithOpenAI(spoken);return;}
  if(!('speechSynthesis'in window)||typeof SpeechSynthesisUtterance==='undefined'){
   setVoiceError('Spoken answers are unavailable in this browser. The answer is still shown above.');return;
  }
  try{
   stopSpeaking();
   const utterance=new SpeechSynthesisUtterance(spoken);
   utterance.lang=document.documentElement.lang||navigator.language||'en-US';
   utterance.onend=()=>{if(utteranceRef.current===utterance){utteranceRef.current=null;setSpeaking(false);}};
   utterance.onerror=()=>{if(utteranceRef.current===utterance){utteranceRef.current=null;setSpeaking(false);setVoiceError('Audio playback failed. The answer is still shown above.');}};
   utteranceRef.current=utterance;setSpeaking(true);
   window.speechSynthesis.speak(utterance);
  }catch{utteranceRef.current=null;setSpeaking(false);setVoiceError('Audio playback failed. The answer is still shown above.');}
 };
 useEffect(()=>{request.current?.controller.abort();request.current=null;cancelListening();stopSpeaking();setVoiceError('');setPending(null);setQuestion('');setConversation({projectId:project.id,messages:readMessages(project.id)});},[project.id]);
 useEffect(()=>()=>{request.current?.controller.abort();request.current=null;cancelListening(false);stopSpeaking(false);},[]);
 useEffect(()=>{if(conversation.projectId!==project.id)return;try{sessionStorage.setItem(historyKey(project.id),JSON.stringify(conversation.messages.slice(-40)));}catch{/* The conversation can continue in memory. */}},[conversation,project.id]);
 useEffect(()=>{const area=scrollArea.current;if(area)area.scrollTo({top:area.scrollHeight,behavior:'smooth'});},[messages,pending,open]);
 useEffect(()=>{if(!pending)return;const update=()=>setElapsed(Math.floor((Date.now()-pending.startedAt)/1000));update();const timer=setInterval(update,1000);return()=>clearInterval(timer);},[pending]);
 const append=(scope:string,message:Message)=>setConversation(old=>old.projectId===scope?{...old,messages:[...old.messages,message].slice(-40)}:old);
 const stop=()=>{request.current?.controller.abort();request.current=null;setPending(null);};
 const send=async(raw:string,retry=false,localOnly=false,voice=false)=>{
  const q=raw.trim();if(!q||request.current)return;
  if(!voice)cancelListening();
  stopSpeaking();setVoiceError('');
  const scope=project.id,revision=state.revision;
  const controller=new AbortController(),token=crypto.randomUUID();request.current={controller,token};
  const repeatsLatest=retry&&messages.at(-1)?.error&&messages.at(-1)?.retryQuestion===q;
  if(retry)setConversation(old=>old.projectId===scope?{...old,messages:old.messages.filter(message=>!message.error||message.retryQuestion!==q)}:old);
  setQuestion('');if(!repeatsLatest)append(scope,{id:crypto.randomUUID(),role:'user',text:q,voice});
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
    if(!response.ok){
     if(data&&typeof data==='object'&&'code'in data&&data.code==='unsupported_citation'){
      answer=offlineAssistantAnswer(context);
      answer={...answer,uncertainty:[answer.uncertainty,'The live answer contained an unverified quotation, so this answer uses local project records.'].filter(Boolean).join(' ')};
     }else throw new Error(data&&typeof data==='object'&&'error'in data?String(data.error):'The assistant request could not be completed.');
    }else{
     const parsed=answerSchema.parse(data);
     answer={...parsed,references:parsed.references?.map(ref=>({...ref,label:ref.label??undefined}))};mode='AI';
    }
   }else answer=offlineAssistantAnswer(context);
   const allowed=new Map(context.sources.map(s=>[s.id,s.text]));
   if(answer.citations.some(c=>!allowed.get(c.source_id)?.includes(c.quote)))throw new Error('A citation did not match its source. No unverified answer was shown. Retry the question.');
   const referenceIds={requirement:new Set(context.requirements.map(r=>r.id)),finding:new Set(context.findings.map(f=>f.id)),audit:new Set(context.audit.map(a=>a.id)),run:new Set(context.runs.map(r=>r.id))};
   if(answer.references?.some(ref=>!referenceIds[ref.type].has(ref.id)))throw new Error('An answer linked to a record outside the selected context. Please retry.');
   if(active()){
    append(scope,{id:crypto.randomUUID(),role:'assistant',text:answer.answer,answer,mode,revision,voice});
    if(voice&&panelOpen.current)speakAnswer(answer.answer);
   }
  }catch(error){
   if(active()){
    const errorText=controller.signal.aborted?'The response timed out. Your project and conversation are saved; retry this question.':error instanceof z.ZodError?'The assistant returned an invalid answer format. Please retry.':error instanceof Error?error.message:'The assistant could not complete this response.';
    append(scope,{id:crypto.randomUUID(),role:'assistant',text:'The live answer could not be completed.',error:errorText,retryQuestion:q,revision,voice});
   }
  }finally{clearTimeout(timer);if(active()){request.current=null;setPending(null);}}
 };
 sendRef.current=send;
 const transcribeRecording=async(blob:Blob)=>{
  if(blob.size<100){setVoiceError('No voice recording was captured. Try again.');setTranscribing(false);return;}
  const controller=new AbortController();transcriptionRequest.current=controller;
  try{
   const response=await fetch('/api/transcribe',{method:'POST',headers:{'Content-Type':blob.type.split(';')[0],'X-Voice-Language':(navigator.language||'en').split('-')[0]},body:blob,signal:controller.signal});
   const result:unknown=await response.json();
   if(controller.signal.aborted||transcriptionRequest.current!==controller)return;
   if(!result||typeof result!=='object')throw new Error('The transcription service returned an invalid response.');
   if(!response.ok)throw new Error('error'in result?String(result.error):'Voice transcription failed. Try again.');
   const text='text'in result&&typeof result.text==='string'?result.text.trim():'';
   if(!text)throw new Error('No speech was detected. Try again.');
   if(text.length>600){setQuestion(text.slice(0,600));throw new Error('The voice question is too long. Shorten it and send it as text.');}
   setQuestion(text);
   void sendRef.current(text,false,false,true);
  }catch(error){
   if(!controller.signal.aborted&&transcriptionRequest.current===controller)setVoiceError(error instanceof Error?error.message:'Voice transcription failed. Try again.');
  }finally{if(transcriptionRequest.current===controller){transcriptionRequest.current=null;setTranscribing(false);setVoiceStatus('');}}
 };
 const monitorSilence=(recording:VoiceRecording)=>{
  try{
   const context=new AudioContext();
   recording.audioContext=context;
   const source=context.createMediaStreamSource(recording.stream),analyser=context.createAnalyser();
   analyser.fftSize=1024;source.connect(analyser);
   void context.resume().catch(()=>{});
   const samples=new Uint8Array(analyser.fftSize);
   const started=performance.now();let activeFrames=0,lastSpeech=0,heardSpeech=false;
   recording.monitor=setInterval(()=>{
    if(recordingRef.current!==recording||recording.recorder.state!=='recording')return;
    analyser.getByteTimeDomainData(samples);
    const rms=Math.sqrt(samples.reduce((sum,sample)=>sum+((sample-128)/128)**2,0)/samples.length);
    const now=performance.now();
    if(rms>0.018){activeFrames++;if(activeFrames>=3){heardSpeech=true;lastSpeech=now;}}
    else activeFrames=0;
    if(heardSpeech&&now-lastSpeech>2500&&now-started>1200)recording.recorder.stop();
   },120);
  }catch{if(recording.audioContext)void recording.audioContext.close();recording.audioContext=null;}
 };
 const startRecording=async()=>{
  const attempt=++voiceAttempt.current;
  setListening(true);setVoiceStatus('Allow microphone access to record your question.');setVoiceError('');stopSpeaking();
  try{
   const stream=await navigator.mediaDevices.getUserMedia({audio:{channelCount:1,echoCancellation:true,noiseSuppression:true,autoGainControl:true}});
   if(voiceAttempt.current!==attempt||!panelOpen.current){stream.getTracks().forEach(track=>track.stop());return;}
   const mimeType=['audio/webm;codecs=opus','audio/webm','audio/mp4','audio/ogg'].find(type=>MediaRecorder.isTypeSupported(type));
   if(!mimeType){stream.getTracks().forEach(track=>track.stop());throw new Error('This browser cannot record audio in a supported format.');}
   const recorder=new MediaRecorder(stream,{mimeType});
   const recording:VoiceRecording={recorder,stream,chunks:[],timer:null,monitor:null,audioContext:null};
   recordingRef.current=recording;
   recorder.ondataavailable=event=>{if(event.data.size)recording.chunks.push(event.data);};
   recorder.onerror=()=>{if(recordingRef.current===recording){cancelListening();setVoiceError('Microphone recording failed. Check your audio input and try again.');}};
   recorder.onstop=()=>{
    if(recordingRef.current!==recording)return;
    recordingRef.current=null;
    if(recording.timer)clearTimeout(recording.timer);
    if(recording.monitor)clearInterval(recording.monitor);
    if(recording.audioContext)void recording.audioContext.close();
    stream.getTracks().forEach(track=>track.stop());
    setListening(false);setTranscribing(true);setVoiceStatus('Transcribing your question...');
    void transcribeRecording(new Blob(recording.chunks,{type:recorder.mimeType}));
   };
   recorder.start();
   recording.timer=setTimeout(()=>{if(recordingRef.current===recording&&recorder.state==='recording')recorder.stop();},30_000);
   monitorSilence(recording);
   setVoiceStatus('Recording...');
  }catch(error){
   if(voiceAttempt.current!==attempt)return;
   cancelListening();
   const name=error instanceof DOMException?error.name:'';
   setVoiceError(name==='NotAllowedError'||name==='PermissionDeniedError'?'Microphone access was blocked. Allow it in the browser and try again.':name==='NotFoundError'?'No microphone was found. Check your audio input.':error instanceof Error?error.message:'The microphone could not start. Try again.');
  }
 };
 const toggleBrowserVoice=()=>{
  if(recognitionRef.current){try{recognitionRef.current.stop();}catch{cancelListening();setVoiceError('Voice input stopped. Try again.');}return;}
  const browser=window as SpeechRecognitionWindow;
  const Recognition=browser.SpeechRecognition??browser.webkitSpeechRecognition;
  if(!Recognition){setVoiceError('Voice input is unavailable. Use a browser with microphone recording support.');return;}
  stopSpeaking();setVoiceError('');
  const recognition=new Recognition();
  recognition.lang=document.documentElement.lang||navigator.language||'en-US';
  recognition.continuous=false;recognition.interimResults=true;recognition.maxAlternatives=1;
  let finalTranscript='',failed=false;
  recognition.onresult=event=>{
   if(recognitionRef.current!==recognition)return;
   let final='',interim='';
   for(let index=0;index<event.results.length;index++){
    const result=event.results[index],transcript=result[0]?.transcript?.trim();
    if(!transcript)continue;
    if(result.isFinal)final+=` ${transcript}`;else interim+=` ${transcript}`;
   }
   finalTranscript=final.trim();
   setQuestion(`${final} ${interim}`.trim().slice(0,600));
  };
  recognition.onerror=event=>{
   if(recognitionRef.current!==recognition)return;
   failed=true;
   setVoiceError(event.error==='not-allowed'||event.error==='service-not-allowed'?'Microphone access was blocked. Allow it in the browser and try again.':event.error==='no-speech'?'No speech heard. Try again.':event.error==='audio-capture'?'No microphone was found. Check your audio input.':event.error==='network'?'The browser speech service could not connect. Use the local app with AI configured for voice transcription.':`Voice recognition stopped (${event.error}). Try again.`);
  };
  recognition.onend=()=>{
   if(recognitionRef.current!==recognition)return;
   recognitionRef.current=null;setListening(false);setVoiceStatus('');
   if(failed)return;
   const spokenQuestion=finalTranscript.trim();
   if(!spokenQuestion){setVoiceError('No speech heard. Try again.');return;}
   if(spokenQuestion.length>600){setVoiceError('The voice question is too long. Shorten it and send it as text.');return;}
   void sendRef.current(spokenQuestion,false,false,true);
  };
  recognitionRef.current=recognition;setListening(true);setVoiceStatus('Listening...');
  try{recognition.start();}catch{cancelListening();setVoiceError('The microphone could not start. Check browser permissions and try again.');}
 };
 const toggleVoice=()=>{
  if(recordingRef.current){if(recordingRef.current.recorder.state==='recording')recordingRef.current.recorder.stop();return;}
  if(recognitionRef.current){toggleBrowserVoice();return;}
  if(listening){cancelListening();return;}
  if(request.current||transcribing)return;
  if(liveAssistant&&typeof navigator.mediaDevices?.getUserMedia==='function'&&typeof MediaRecorder!=='undefined'){void startRecording();return;}
  toggleBrowserVoice();
 };
 const openReference=(ref:NonNullable<AssistantAnswer['references']>[number])=>{
  if(ref.type==='requirement'){const item=state.requirements.find(r=>r.projectId===project.id&&r.id===ref.id);if(item){closePanel();openRequirement(item);}}
  if(ref.type==='finding'){const item=state.findings.find(f=>f.projectId===project.id&&f.id===ref.id);if(item){closePanel();openFinding(item);}}
  if(ref.type==='audit'){const item=state.audit.find(a=>a.projectId===project.id&&a.id===ref.id);if(item){closePanel();openAudit(item);}}
  if(ref.type==='run'){const event=state.audit.find(a=>a.projectId===project.id&&a.entityId===ref.id);closePanel();if(event)openAudit(event);else navigate('Audit Trail');}
 };
 const feedbackCount=useMemo(()=>getSourceInsights(state,project.id).feedbackCount,[state.datasets,project.id]);
 const requirementCount=state.requirements.filter(r=>r.projectId===project.id&&!r.synthetic).length;
 return <div className="assistant-root">
  {open&&<section className="assistant-panel" aria-label="InsightPilot assistant">
   <header className="assistant-header"><div className="assistant-avatar"><Sparkles size={18}/></div><div><strong>InsightPilot Assistant</strong><span>{liveAssistant?'Live AI':'Local project guide'} · {project.derivative} / {project.market}</span></div><button aria-label="Start a new conversation" title="Start a new conversation" disabled={busy||!messages.length} onClick={()=>{cancelListening();stopSpeaking();setVoiceError('');setConversation({projectId:project.id,messages:[]});setQuestion('');}}><Trash2 size={16}/></button><button aria-label="Close assistant panel" onClick={closePanel}><X size={18}/></button></header>
   <div className="assistant-context-strip"><span>{feedbackCount.toLocaleString()} comments · {requirementCount} requirements</span><span>{page}</span><button disabled={busy} onClick={()=>void send('Summarize the current project and what needs attention.',false,true)} title="Computed from project records without an AI request">Local summary</button></div>
   <div ref={scrollArea} className="assistant-messages" role="log" aria-live="polite">
    {!messages.length&&<div className="assistant-welcome"><div className="assistant-welcome-icon"><BookOpen size={24}/></div><h3>Understand this project</h3><p>Ask about customer themes, analysis coverage, evidence gaps, priorities, or recent decisions. Follow up naturally; I keep this conversation’s context.</p><div className="assistant-suggestions">{suggestions.map(s=><button key={s} onClick={()=>void send(s)}>{s}</button>)}</div></div>}
    {messages.map(m=><div key={m.id} className={`assistant-message ${m.role}`}><div className={`assistant-bubble ${m.error?'assistant-error':''}`}>
     {m.role==='assistant'&&<small>{m.error?'Request interrupted':m.mode}</small>}
     <AnswerText text={m.error??m.text}/>
     {m.error&&m.retryQuestion&&<button className="assistant-retry" disabled={busy} onClick={()=>void send(m.retryQuestion!,true,false,!!m.voice)}><RotateCcw size={13}/>Retry question</button>}
     {m.answer&&(m.answer.citations.length>0||!!m.answer.references?.length)&&<details className="assistant-sources">
      <summary><BookOpen size={14}/><span>{m.answer.citations.length?`View sources (${m.answer.citations.length})`:`View linked records (${m.answer.references?.length??0})`}</span><ChevronDown size={14} className="assistant-sources-chevron"/></summary>
      <div className="assistant-sources-content">
       {!!m.answer.citations.length&&<div className="assistant-sources-group"><strong>Source evidence</strong>{m.answer.citations.map((citation,index)=>{
        const source=lookupAssistantSource(state,project.id,citation.source_id);
        const location=source?sourceLocation(source):null;
        const originalId=source?.fields._originalId;
        return <button key={`${citation.source_id}-${index}`} type="button" disabled={!source} onClick={()=>{if(source){closePanel();openSource(source);}}}>
         <span className="assistant-source-title"><span>{String(originalId??citation.source_id)}</span><ExternalLink size={13}/></span>
         <span className="assistant-source-quote">“{citation.quote.slice(0,220)}{citation.quote.length>220?'…':''}”</span>
         <small>{location?.file??'Source record'}{location?` · ${location.sheet?`${location.sheet} · `:''}Row ${location.row}`:''}</small>
        </button>;
       })}</div>}
       {!!m.answer.references?.length&&<div className="assistant-sources-group"><strong>Linked records</strong>{m.answer.references.map(ref=><button key={`${ref.type}-${ref.id}`} type="button" onClick={()=>openReference(ref)}><span className="assistant-source-title"><span>{ref.label||ref.id}</span><ExternalLink size={13}/></span><small>{ref.type}</small></button>)}</div>}
      </div>
     </details>}
    </div></div>)}
    {busy&&<div className="assistant-message assistant"><div className="assistant-bubble assistant-thinking"><Loader2 className="spin" size={15}/><span>{elapsed<8?'Reading the current project and relevant evidence…':'Preparing a source-linked answer…'}<small>{elapsed}s · You can keep working</small></span></div></div>}
   </div>
   <form className="assistant-composer" onSubmit={e=>{e.preventDefault();if(!listening&&!transcribing)void send(question);}}><label className="sr-only" htmlFor="assistant-question">Ask the assistant</label><textarea id="assistant-question" value={question} onChange={e=>setQuestion(e.target.value)} readOnly={listening||transcribing} maxLength={600} rows={2} placeholder="Ask about this project or follow up…" onKeyDown={e=>{if(e.key==='Enter'&&!e.shiftKey&&!e.nativeEvent.isComposing){e.preventDefault();if(!busy&&!listening&&!transcribing)void send(question);}}}/><button type="button" className={`assistant-mic${listening?' is-listening':''}`} aria-label={listening?'Finish voice question':'Ask with microphone'} title={listening?'Finish voice question':'Ask with microphone'} aria-pressed={listening} disabled={busy||transcribing} onClick={toggleVoice}><Mic size={17}/></button>{speaking&&<button type="button" className="assistant-stop-speech" aria-label="Stop spoken answer" title="Stop spoken answer" onClick={()=>stopSpeaking()}><VolumeX size={17}/></button>}{busy?<button type="button" aria-label="Stop response" title="Stop response" onClick={stop}><Square size={15}/></button>:<button type="submit" aria-label="Send question" disabled={!question.trim()||listening||transcribing}><ArrowUp size={18}/></button>}</form>
   {(listening||transcribing||voiceError)&&<div className={`assistant-voice-status${voiceError?' is-error':''}`} role={voiceError?'alert':'status'}>{voiceError||voiceStatus}</div>}
   <div className="assistant-footnote">{liveAssistant?'Questions, context, and voice recordings use OpenAI. Spoken replies use an AI-generated voice.':'Uses local project records. Live AI needs the local server and API key.'} Decisions stay with you.</div>
  </section>}
  <button className="assistant-launcher" onClick={()=>{if(open)closePanel();else{panelOpen.current=true;setVoiceError('');setOpen(true);}}} aria-label={open?'Close assistant':'Open assistant'} aria-expanded={open}><MessageCircle size={21}/><span>Ask InsightPilot</span></button>
 </div>;
}
