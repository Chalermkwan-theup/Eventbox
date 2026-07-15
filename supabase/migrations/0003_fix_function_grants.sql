-- 0003_fix_function_grants.sql
-- CRITICAL FIX (found by running against a real Supabase project, not source review).
--
-- Supabase ships an `ALTER DEFAULT PRIVILEGES ... GRANT EXECUTE ON FUNCTIONS TO
-- anon, authenticated, service_role` for the public schema. That grant is made to
-- those roles *explicitly*, not via PUBLIC. So the `REVOKE EXECUTE ... FROM public`
-- statements in 0002 were effectively no-ops for anon/authenticated: the
-- service-role-only RPCs stayed callable via PostgREST (/rest/v1/rpc/...) by any
-- signed-in — or even anonymous — user.
--
-- Impact before this fix (verified with has_function_privilege on the live DB):
--   * confirm_order_paid  -> a signed-in user could mark their own pending order
--                            'paid' and have tickets issued WITHOUT paying.
--   * internal_release_order -> cancel/expire arbitrary pending orders (griefing).
--   * promote_waitlist / expire_stale_orders -> trigger internal scheduling logic.
--
-- Fix: revoke EXECUTE from anon + authenticated explicitly. service_role keeps it.

revoke execute on function confirm_order_paid(uuid, text)             from anon, authenticated;
revoke execute on function internal_release_order(uuid, order_status) from anon, authenticated;
revoke execute on function promote_waitlist(uuid)                     from anon, authenticated;
revoke execute on function expire_stale_orders()                      from anon, authenticated;

-- reserve_tickets / attach_payment_intent are for signed-in users only. They fail
-- safe for anon (auth.uid() is null), but revoke anon anyway (least privilege).
revoke execute on function reserve_tickets(uuid, jsonb, text)         from anon;
revoke execute on function attach_payment_intent(uuid, text)         from anon;
