import { Database } from '/home/ryan_fincapy_com/projects/squidward/packages/db/src/compat.ts';

const db = new Database('/home/ryan_fincapy_com/projects/squidward/.data/agent.db', { create: true, strict: false });

const runs = db
  .query('SELECT id, conversation_id, run_id, lane, status, error_text, created_at, updated_at FROM conversation_runs ORDER BY created_at DESC LIMIT 8')
  .all();
console.log('runs', runs);

const msgs = db
  .query("SELECT id, conversation_id, role, mode, status, run_id, substr(content,1,240) as content, updated_at FROM conversation_messages ORDER BY created_at DESC LIMIT 16")
  .all();
console.log('messages', msgs);

const queue = db
  .query("SELECT id, task_type, status, priority, source_id, substr(payload_json,1,220) as payload FROM task_queue WHERE task_type IN ('chat_reply','codex_mission') ORDER BY created_at DESC LIMIT 16")
  .all();
console.log('queue', queue);

db.close();
