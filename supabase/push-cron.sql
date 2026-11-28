-- Pemicu notifikasi adzan TIAP MENIT langsung dari Supabase (pg_cron + pg_net), tanpa layanan luar.
-- Supabase memanggil https://<domain>/api/push/send setiap menit; server mengirim Web Push tepat
-- pada menit adzan ke semua HP yang berlangganan, walau App tertutup.
--
-- Langkah 1: Supabase Dashboard > SQL Editor > New query > tempel seluruh isi berkas ini, ganti
--            GANTI_DOMAIN (domain produksi tanpa https://, mis. almuttaqin.dekatlokal.com) > Run.
--            Berkas ini TIDAK memuat rahasia, aman disimpan di repo dan dijalankan ulang.
-- Langkah 2: isi rahasia (SAMA PERSIS dengan PUSH_CRON_SECRET di Vercel) ke Supabase Vault, salah satu:
--   a. dari terminal (memakai service role di .env.local):
--      curl -X POST "$NEXT_PUBLIC_SUPABASE_URL/rest/v1/rpc/set_push_cron_secret" \
--        -H "apikey: $SUPABASE_SERVICE_ROLE_KEY" -H "Authorization: Bearer $SUPABASE_SERVICE_ROLE_KEY" \
--        -H "Content-Type: application/json" -d "{\"secret\":\"$PUSH_CRON_SECRET\"}"
--   b. atau di SQL Editor: select public.set_push_cron_secret('<PUSH_CRON_SECRET>');

-- 1. Catatan anti kirim ganda (isi migrations/0004_push_sent_log.sql).
create table if not exists push_sent_log (
  tag text primary key,
  sent_at timestamptz not null default now()
);
create index if not exists push_sent_log_sent_at_idx on push_sent_log (sent_at);
alter table push_sent_log enable row level security;

-- 2. Ekstensi penjadwal & HTTP.
create extension if not exists pg_cron with schema pg_catalog;
create extension if not exists pg_net with schema extensions;

-- 3. Pengisi rahasia di Vault (terenkripsi). Hanya service role yang boleh memanggilnya.
create or replace function public.set_push_cron_secret(secret text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  existing uuid;
begin
  if secret is null or length(secret) < 32 then
    raise exception 'secret terlalu pendek (minimal 32 karakter)';
  end if;
  select id into existing from vault.secrets where name = 'push_cron_secret';
  if existing is null then
    perform vault.create_secret(secret, 'push_cron_secret', 'Bearer token untuk /api/push/send');
  else
    perform vault.update_secret(existing, secret);
  end if;
end;
$$;
revoke all on function public.set_push_cron_secret(text) from public, anon, authenticated;
grant execute on function public.set_push_cron_secret(text) to service_role;
notify pgrst, 'reload schema';

-- 4. Jadwal tiap menit. Nama yang sama memperbarui jadwal lama. Sebelum rahasia diisi,
--    panggilan ditolak 401 (aman, tidak ada yang terkirim).
select cron.schedule(
  'acc-push-adhan',
  '* * * * *',
  $cron$
  select net.http_get(
    url := 'https://GANTI_DOMAIN/api/push/send',
    headers := jsonb_build_object(
      'Authorization',
      'Bearer ' || coalesce((select decrypted_secret from vault.decrypted_secrets where name = 'push_cron_secret'), '')
    ),
    timeout_milliseconds := 30000
  );
  $cron$
);

-- 5. Periksa setelah 2-3 menit (jalankan terpisah):
--   select status, return_message, start_time from cron.job_run_details order by start_time desc limit 5;
--   select status_code, content::text, created from net._http_response order by created desc limit 5;
-- Benar: status_code 200 dan {"ok":true,...,"reason":"no-events"} di luar menit adzan.
-- 401 = rahasia di Vault tidak sama dengan PUSH_CRON_SECRET di Vercel (atau Vercel belum di-redeploy).
-- Menghentikan: select cron.unschedule('acc-push-adhan');
