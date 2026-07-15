-- 0005_fix_org_member_privesc.sql
-- Security M1 (from the audit): org_member_write let any 'admin' write org_member rows
-- freely — an admin could set role='owner' on themselves, or remove/replace owners,
-- collapsing the owner/admin distinction. Split it: admins may only manage 'staff';
-- owners manage anyone.
create or replace function is_org_owner(p_org_id uuid)
returns boolean language sql security definer stable set search_path = public as $$
  select exists (
    select 1 from org_member
    where org_id = p_org_id and user_id = auth.uid() and role = 'owner'
  );
$$;
revoke execute on function is_org_owner(uuid) from public;
grant execute on function is_org_owner(uuid) to anon, authenticated;

drop policy if exists org_member_write on org_member;

create policy org_member_admin_manage_staff on org_member
  for all
  using (is_org_admin(org_id) and role = 'staff')
  with check (is_org_admin(org_id) and role = 'staff');

create policy org_member_owner_manage_all on org_member
  for all
  using (is_org_owner(org_id))
  with check (is_org_owner(org_id));
