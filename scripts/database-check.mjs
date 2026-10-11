import {PGlite} from '@electric-sql/pglite';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {createEmptyWorkspace} from '../src/data/empty-workspace.ts';
import assert from 'node:assert/strict';

const db=new PGlite();
const passed=[];
const ok=s=>{passed.push(s);console.log('PASS',s);};
const ws='10000000-0000-4000-8000-000000000001';
const pm='20000000-0000-4000-8000-000000000001';
const other='20000000-0000-4000-8000-000000000002';

await db.exec(`create role anon;create role authenticated;create role service_role bypassrls;create schema auth;create table auth.users(id uuid primary key);create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;grant usage on schema auth to authenticated;grant execute on function auth.uid() to authenticated;`);
const migration=(await readFile('supabase/migrations/202610100001_insightpilot.sql','utf8')).replace('create extension if not exists pgcrypto;','-- gen_random_uuid is built into this PostgreSQL test runtime.');
await db.exec(migration);
await db.exec(await readFile('supabase/migrations/202610100002_analysis_jobs.sql','utf8'));
ok('Migrations execute on PostgreSQL');

await db.query('insert into auth.users values($1),($2)',[pm,other]);
await db.query('insert into profiles(id) values($1),($2)',[pm,other]);
await db.query('insert into workspaces(id) values($1)',[ws]);
await db.query("insert into workspace_members(workspace_id,user_id,role) values($1,$2,'pm')",[ws,pm]);

const initial=createEmptyWorkspace();
await db.query('select commit_workspace($1,$2,$3::jsonb)',[ws,-1,JSON.stringify(initial)]);
const scalar=async(sql,params=[])=>(await db.query(sql,params)).rows[0];
assert.equal((await scalar('select count(*)::int n from requirements')).n,0);
assert.equal((await scalar('select count(*)::int n from source_records')).n,0);
assert.equal((await scalar('select count(*)::int n from finding_source_links')).n,0);
ok('Empty source workspace synchronizes without inserting customer or product records');

await assert.rejects(db.query('select commit_workspace($1,$2,$3::jsonb)',[ws,-1,JSON.stringify(initial)]),/Concurrent modification/);
ok('Stale revisions cannot overwrite a newer workspace');

const event={id:'DB-TEST-EVENT-1',projectId:initial.projects[0].id,at:new Date().toISOString(),actor:'PM',actorId:'Database Test',action:'Workspace reviewed',entityType:'Workspace',entityId:initial.projects[0].id,before:null,after:null,rationale:'Verify append-only audit history.',relatedIds:[]};
const withEvent={...structuredClone(initial),revision:1,audit:[event]};
await db.query('select commit_workspace($1,$2,$3::jsonb)',[ws,0,JSON.stringify(withEvent)]);
const tamper={...structuredClone(withEvent),revision:2,audit:[{...event,rationale:'Altered history'}]};
await assert.rejects(db.query('select commit_workspace($1,$2,$3::jsonb)',[ws,1,JSON.stringify(tamper)]),/Audit history/);
ok('Snapshot cannot rewrite protected audit history');

await assert.rejects(db.query("update audit_events set rationale='Changed' where id='DB-TEST-EVENT-1'"),/append-only/);
await assert.rejects(db.query("delete from audit_events where id='DB-TEST-EVENT-1'"),/append-only/);
ok('Immutable audit trigger rejects update and delete');

await db.exec(`set role authenticated;select set_config('request.jwt.claim.sub','${other}',false);`);
assert.equal((await scalar('select count(*)::int n from requirements')).n,0);
ok('Non-members cannot read another workspace');
await assert.rejects(db.query('select * from analysis_jobs'),/permission denied/);
ok('Raw AI job inputs and intermediates are not browser-readable');
await assert.rejects(db.query("update requirements set status='Approved'"),/permission denied/);
await assert.rejects(db.query('select commit_workspace($1,$2,$3::jsonb)',[ws,1,JSON.stringify(withEvent)]),/permission denied/);
ok('Authenticated browser users cannot mutate records or invoke commit RPC');

await db.exec(`select set_config('request.jwt.claim.sub','${pm}',false);`);
assert.equal((await scalar('select count(*)::int n from requirements')).n,0);
await assert.rejects(db.query("update audit_events set rationale='Changed'"),/permission denied/);
ok('Workspace members have scoped reads and no direct audit writes');
await db.exec('reset role');

const appended={id:'DB-TEST-EVENT-2',projectId:initial.projects[0].id,at:new Date().toISOString(),actor:'PM',actorId:'Database Test',action:'Workspace check completed',entityType:'Workspace',entityId:initial.projects[0].id,before:null,after:null,rationale:'Append a second immutable event.',relatedIds:[]};
const next={...withEvent,revision:2,audit:[event,appended]};
await db.query('select commit_workspace($1,$2,$3::jsonb)',[ws,1,JSON.stringify(next)]);
assert.equal((await scalar('select revision from workspaces where id=$1',[ws])).revision,2);
assert.equal((await scalar('select count(*)::int n from audit_events')).n,2);
ok('Append-only transaction commits atomically at the next revision');

await mkdir('artifacts',{recursive:true});
await writeFile('artifacts/database-results.json',JSON.stringify({passed:passed.length,tests:passed},null,2));
await db.close();
console.log(`\n${passed.length} database scenarios passed.`);
