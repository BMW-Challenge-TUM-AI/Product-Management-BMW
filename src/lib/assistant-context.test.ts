import {describe,it,expect} from 'vitest';
import {createTestWorkspace} from '../../tests/fixtures/legacy-workspace-fixture';
import {buildAssistantContext,lookupAssistantSource,offlineAssistantAnswer} from './assistant-context';

const importedWorkspace=()=>{
 const state=createTestWorkspace();
 for(const dataset of state.datasets)dataset.synthetic=false;
 for(const finding of state.findings)finding.synthetic=false;
 for(const requirement of state.requirements)requirement.synthetic=false;
 return state;
};

describe('assistant project grounding',()=>{
 it('uses only the selected market and exact source substrings',()=>{
  const state=importedWorkspace(),project=state.projects[0];
  const context=buildAssistantContext(state,project,'What supports REQ-002?');
   expect(context.project.market).toBe('United States');
  const answer=offlineAssistantAnswer(context);
  for(const citation of answer.citations)expect(context.sources.find(s=>s.id===citation.source_id)?.text).toContain(citation.quote);
 });
 it('does not borrow evidence from another project',()=>{
  const state=importedWorkspace(),project=state.projects[1];
  const context=buildAssistantContext(state,project,'What supports REQ-002?');
  expect(context.sources).toHaveLength(0);
  expect(offlineAssistantAnswer(context).answer).toContain('no requirements');
 });
 it('answers a product-context question from labeled reference records',()=>{
  const state=importedWorkspace(),project=state.projects[0];
  const context=buildAssistantContext(state,project,'What equipment data is available?');
  const answer=offlineAssistantAnswer(context);
  expect(answer.citations.length).toBeGreaterThan(0);
  for(const citation of answer.citations){
   const source=context.sources.find(s=>s.id===citation.source_id);
   expect(source?.source_type).not.toBe('Customer verbatims');
   expect(source?.text).toContain(citation.quote);
  }
 });
 it('answers from selected records even before requirements exist',()=>{
  const state=importedWorkspace(),project=state.projects[0];
  state.requirements=[];state.findings=[];
  const context=buildAssistantContext(state,project,'What is here?');
  const answer=offlineAssistantAnswer(context);
  expect(answer.citations.length).toBeGreaterThan(0);
  expect(answer.answer).toContain('no drafted requirements');
  expect(answer.citations.every(c=>context.sources.some(s=>s.id===c.source_id&&s.text.includes(c.quote)))).toBe(true);
 });
 it('never sends previously imported external research to the assistant',()=>{
  const state=importedWorkspace(),project=state.projects[0];
  const source=state.datasets[0];
  state.datasets.push({...source,id:'old-web',name:'Old public research',type:'External research',records:[{...source.records[0],id:'WEB-1',datasetId:'old-web',content:'External-only claim.'}]});
  const context=buildAssistantContext(state,project,'What does WEB-1 say?');
  expect(context.sources.some(s=>s.id==='WEB-1')).toBe(false);
  expect(lookupAssistantSource(state,project.id,'WEB-1')).toBeUndefined();
 });
});
