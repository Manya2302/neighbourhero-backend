insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'issue-photos',
  'issue-photos',
  true,
  10485760,
  array['image/jpeg', 'image/jpg', 'image/png', 'image/webp']
)
on conflict (id) do update set
  public = excluded.public,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists "Public read issue photos" on storage.objects;
create policy "Public read issue photos"
  on storage.objects
  for select
  using (bucket_id = 'issue-photos');
