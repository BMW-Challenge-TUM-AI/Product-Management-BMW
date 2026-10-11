import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import {localAI} from './scripts/local-ai';
export default defineConfig(({mode})=>{
 const env={...loadEnv(mode, process.cwd(), ''), ...process.env} as Record<string,string>;
 const allowedHosts=['bmw-insightpilot-production.up.railway.app'];
 if(env.RAILWAY_PUBLIC_DOMAIN)allowedHosts.push(env.RAILWAY_PUBLIC_DOMAIN);
 return { plugins: [react(), tailwindcss(), localAI(env)], server: { host: '127.0.0.1', port: 5173 }, preview: {host:'127.0.0.1',allowedHosts}, build: {rollupOptions:{output:{manualChunks:{charts:['recharts'],spreadsheet:['xlsx'],supabase:['@supabase/supabase-js']}}}} };
});
