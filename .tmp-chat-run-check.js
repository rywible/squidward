import { Database } from '/home/ryan_fincapy_com/projects/squidward/packages/db/src/compat.ts';

const runId = process.argv[2];
const db = new Database('/home/ryan_fincapy_com/projects/squidward/.data/agent.db', { create: true, strict: false });
const run = db.query('SELECT run_id, status, error_text, updated_at FROM conversation_runs WHERE run_id=? LIMIT 1').get(runId);
const msg = db.query("SELECT role, status, substr(content,1,300) as content, updated_at FROM conversation_messages WHERE run_id=? AND role='assistant' ORDER BY created_at DESC LIMIT 1").get(runId);
console.log({ run, msg });
db.close();
