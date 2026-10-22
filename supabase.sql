create table if not exists quizzes (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  questions jsonb not null,
  created_at timestamptz default now()
);
alter table quizzes enable row level security; -- server dùng service_role key nên vẫn ghi/đọc được
