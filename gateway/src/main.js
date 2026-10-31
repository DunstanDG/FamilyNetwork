// Starts the photo gateway. Configuration comes only from the environment (see .env.example).
import { createServer } from 'node:http';
import { createGateway } from './gateway.js';

const need = (k) => {
  const v = process.env[k];
  if (!v) { console.error(`Missing ${k}`); process.exit(1); }
  return v;
};

const gateway = createGateway({
  supabaseUrl: need('SUPABASE_URL').replace(/\/$/, ''),
  anonKey: need('SUPABASE_ANON_KEY'),
  serviceKey: need('SUPABASE_SERVICE_ROLE_KEY'),
  immichUrl: need('IMMICH_URL').replace(/\/$/, ''),
  immichKey: need('IMMICH_API_KEY'),
  allowedOrigins: need('ALLOWED_ORIGINS').split(',').map((s) => s.trim()).filter(Boolean),
  maxBytes: Number(process.env.MAX_UPLOAD_MB || 40) * 1024 * 1024,
});

const port = Number(process.env.PORT || 8080);
createServer(gateway.handler).listen(port, () => console.log(`photo gateway listening on ${port}`));

const sweepEvery = 10 * 60 * 1000;
setInterval(() => gateway.sweep().then((n) => n && console.log(`moved ${n} deleted photos to the Immich bin`), (e) => console.error('sweep failed', e)), sweepEvery);
