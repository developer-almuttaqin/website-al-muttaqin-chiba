-- Catatan pengiriman push pengingat (PRD-07b): satu kejadian (tag, mis. adhan-dhuhr-2026-11-20)
-- hanya dikirim sekali, walau /api/push/send dipanggil dua kali di menit yang sama (retry
-- penjadwal, cron-job.org dan pg_cron aktif bersamaan, atau instance serverless berbeda).
-- Idempoten: aman dijalankan ulang.
create table if not exists push_sent_log (
  tag text primary key,
  sent_at timestamptz not null default now()
);

create index if not exists push_sent_log_sent_at_idx on push_sent_log (sent_at);

-- Tanpa policy: hanya service role (server /api/push/send) yang dapat membaca dan menulis.
alter table push_sent_log enable row level security;
