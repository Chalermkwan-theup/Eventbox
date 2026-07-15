# DEPLOY.md — Event Ticketing (Phase 2–4)

Production deploy checklist สำหรับระบบเต็ม: customer flow (เลือกตั๋ว → reserve → Stripe PromptPay async
payment → ออกตั๋ว + QR → waitlist) + staff flow (สแกน QR check-in + organizer dashboard). ผ่าน security
audit + code review + พิสูจน์บน Postgres จริงแล้ว เอกสารนี้เป็น single source of truth ตอน deploy —
ทำตามลำดับ ห้ามข้าม

**Stack**: Next.js App Router (v15) + Supabase (Postgres 17, Auth, Realtime, pg_cron) + Stripe
(PromptPay, async webhook) + Vercel. Currency = THB เก็บเป็น satang (integer). เวลาเก็บ UTC แสดงผล
Asia/Bangkok. Multi-tenant ผ่าน RLS.

**กติกาเหล็ก**: ห้าม deploy วันศุกร์เย็น/ก่อนวันหยุดยาวถ้าไม่มีคน on-call ดู webhook + pg_cron อย่างน้อย
2-3 ชม.แรก — payment เป็น async (PromptPay ใช้เวลาหลักวินาที-นาทีกว่าจะ confirm)

---

## 0. Pre-deploy gate (ต้องผ่านก่อนเสมอ)

⚠️ **เครื่อง dev ที่เขียนโค้ดนี้ไม่มี Node.js — คำสั่งในหัวข้อนี้ยังไม่เคยรันจริงสักครั้ง โดยเฉพาะ
frontend/API ของ Phase 3+4 (~40 ไฟล์ .tsx/.ts) ที่ยังไม่เคยผ่าน TypeScript compiler เลย** นี่คือ
**ความเสี่ยงค้างอันดับ 1** ของ release นี้ ต้องรันบน CI (GitHub Actions) หรือเครื่องที่มี Node ≥18.18
ให้ผ่านครบก่อน merge/deploy — review เป็นการอ่านโค้ด ไม่ใช่การพิสูจน์ว่า build ผ่าน

```bash
npm ci                 # 1) install ตรง lockfile
npm run typecheck      # 2) strict: true — ห้าม type error หลุด (จุดที่เสี่ยงสุดของ Phase 3+4)
npm run lint           # 3) eslint-config-next
npm run build          # 4) production build (จับ server-only import ผิดที่, RSC/CC boundary, ฯลฯ)

# 5) DB-integration tests — ต้องมี Supabase local (Docker) รันก่อน
supabase start
DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:54322/postgres npm run test:run
```

Test suite (`tests/*.test.ts`):
- `safe-redirect.test.ts` — **รันได้โดยไม่ต้องมี DB** (pure unit) — ล็อก open-redirect guard ของ
  `/auth/confirm` (audit H1) ครอบ 9 attack vector รวม tab-injection + dot-segment
- `oversell-concurrency.test.ts` — 500 concurrent buyers ต้องไม่ oversell (`DB_TEST_MAX_CONCURRENCY`
  cap connection พร้อมกัน)
- `confirm-order-paid.test.ts` — idempotency, amount mismatch, already-paid-different-intent
- `hold-expiry.test.ts`, `promo-code-concurrency.test.ts`, `waitlist-promotion.test.ts`

tests คุย DB ตรงผ่าน `pg` driver — ใช้ direct Postgres port (`54322` local) ไม่ใช่ API gateway port

**เงื่อนไข gate**: ทั้ง 5 ขั้น exit 0 ครบ ถึงเข้าสู่ deploy ได้ อันไหน fail หยุดตรงนั้น กลับไปแก้ก่อน

---

## 1. Supabase production setup

### 1.1 Link project
```bash
supabase login
supabase link --project-ref <PROD_PROJECT_REF>
```

### 1.2 Extensions
Dashboard → Database → Extensions → เปิด `pgcrypto` และ `pg_cron` ก่อน (hosted Supabase จำกัด
`pg_cron` ให้ enable บน database `postgres` เท่านั้น) ถ้า `supabase db push` fail ตรง `create extension
pg_cron` ให้ enable ผ่าน UI ก่อนแล้วรันใหม่

> ⚠️ **pgcrypto อยู่ schema `extensions`** (ไม่ใช่ `public`) บน Supabase — RPC ที่ใช้
> `hmac`/`digest`/`gen_random_bytes` (`confirm_order_paid`, `issue_ticket_qr_token`, `check_in_ticket`)
> จึงตั้ง `search_path = public, extensions` ไว้แล้ว ถ้าย้ายไป self-hosted ที่ pgcrypto อยู่ `public`
> ล้วน ให้เช็คว่ายังหาเจอ (บทเรียนบั๊ก 42883 ตอน dev)

### 1.3 Apply migrations
```bash
supabase db push
```
Apply ตามลำดับเลขไฟล์: `0001 0002 0003 0004 0005 0007 0008 0009 0010 0011 0012 0013`
- **ไม่มี `0006` ใน repo** — DB dev เดิมมี ledger entry `0006` (fix ที่ถูก `0007` full-replace ครอบแล้ว)
  prod เป็น DB ใหม่ ไม่มี ledger นั้น ใช้ไฟล์ที่มีตรงๆ ได้
- อะไรอยู่ไหน: `0001` schema, `0002` RPC+RLS+pg_cron, `0003` fix function grants (revoke anon/auth),
  `0004` fix reserve_tickets ambiguity, `0005` org_member privesc, `0007` confirm_order_paid fixes,
  `0008` rate_limit, `0009` amount check, `0010` block zero-total, `0011` QR token + realtime,
  `0012` check-in + dashboard stats, `0013` fix stats revenue bigint

ตรวจ: `supabase migration list --linked` → 12 ไฟล์ applied ตรง remote

### 1.4 Verify pg_cron job
```sql
select jobid, schedule, active from cron.job where jobname = 'expire-holds';
-- ต้องเห็น 1 row: schedule '* * * * *', active true
-- รอ ~2 นาที แล้วเช็คว่ารันจริง:
select status, start_time, return_message from cron.job_run_details
where jobid = (select jobid from cron.job where jobname = 'expire-holds')
order by start_time desc limit 5;
-- return_message succeeded ไม่ใช่ error
```

### 1.5 Enable Realtime บนตาราง `orders`
`0011` มี `alter publication supabase_realtime add table orders;` แล้ว — verify:
```sql
select 1 from pg_publication_tables where pubname='supabase_realtime' and tablename='orders';
-- ต้องได้ 1 row (checkout page + dashboard subscribe order status ผ่านตัวนี้ RLS-scoped)
```

### 1.6 Security Advisor
Dashboard → Advisors → Security → **ต้องไม่มี ERROR** WARN ที่ยอมรับได้ (by-design, verify แล้วบน dev):
- `is_org_member/admin/owner` — helper ใน RLS policy **ต้อง** ให้ anon/authenticated เรียกได้
- `reserve_tickets`, `attach_payment_intent`, `check_rate_limit`, `issue_ticket_qr_token`,
  `check_in_ticket`, `event_checkin_stats` — customer/staff-facing SECURITY DEFINER ที่มี authz guard
  ในตัว (`auth.uid()` / `is_org_member`) — พิสูจน์สดแล้วว่ากันข้าม user/org ได้
- `rate_limit` — RLS enabled no-policy = deny-by-default ตั้งใจ (เข้าผ่าน `check_rate_limit` เท่านั้น)

> ✅ ยืนยันแล้วบน dev: 4 ฟังก์ชัน service-role-only (`confirm_order_paid`, `internal_release_order`,
> `promote_waitlist`, `expire_stale_orders`) **ไม่** ปรากฏใน advisor = ล็อก anon/authenticated ถูกต้อง
> (บทเรียน Critical: `revoke from public` ไม่พอบน Supabase ต้อง revoke anon/authenticated ตรงๆ)

---

## 2. Stripe setup

1. Dashboard (**live mode**) → Developers → Webhooks → Add endpoint
   - URL: `https://<production-domain>/api/webhooks/stripe`
   - Events: `payment_intent.succeeded` (จำเป็น — handler ประมวลผลตัวนี้ตัวเดียว, อย่างอื่น ack แล้วทิ้ง)
   - แนะนำ subscribe `payment_intent.payment_failed` เพิ่มเพื่อ observability (จะถูก ack เฉยๆ แต่เห็นใน
     delivery log ว่าจ่าย fail)
2. Signing secret (`whsec_...`) → ใส่ `STRIPE_WEBHOOK_SECRET` ใน Vercel (production เท่านั้น)
3. Payment methods → เปิด **PromptPay** ให้ active ใน live mode
4. ⚠️ **Verify shape ของ `next_action.promptpay_display_qr_code` ด้วย test mode ก่อน** — `payment-panel.tsx`
   render QR จาก field นี้ (คาดว่า flat: `.image_url_svg`/`.image_url_png`/`.data`) มี TODO comment ในโค้ด
   ให้ trigger PromptPay PaymentIntent จริงใน test mode แล้ว log `next_action` ยืนยัน field name ก่อน
   production (docs Stripe ไม่ระบุ explicit — เคยเดาผิดไป Swish)
5. amount/currency ผูกแน่นในโค้ด — เช็คตรงกับ account: `paymentIntents.create({ currency:"thb",
   amount: order.total_satang })` (satang เต็มจำนวน), webhook เทียบ `amount_received` กับ `total_satang`
   ผ่าน `confirm_order_paid` (0009) ไม่ตรง → refund อัตโนมัติ ไม่ออกตั๋ว

---

## 3. Supabase Auth (magic link) setup

ระบบ login = Supabase OTP/magic link (email) — `app/login/page.tsx` + `app/auth/confirm/route.ts`

1. Dashboard → Authentication → URL Configuration:
   - **Site URL** = `https://<production-domain>`
   - **Redirect URLs allowlist** ต้องมี `https://<production-domain>/auth/confirm` (ไม่งั้น magic link
     redirect ไม่ผ่าน) — เพิ่ม preview domain ด้วยถ้าจะทดสอบบน preview
2. Email template ของ magic link ต้องส่ง `token_hash` + `type` (route ใช้ `verifyOtp({type,token_hash})`)
   — ถ้า project ตั้งเป็น PKCE `code` flow แทน ต้องเปลี่ยน `auth/confirm` ไปใช้ `exchangeCodeForSession`
   (frontend-dev flag ไว้แล้ว)
3. `next` redirect param ถูก sanitize ด้วย `safeNext` (`lib/safe-redirect.ts`) — same-origin เท่านั้น
   (audit H1 ปิดแล้ว + unit test คุม) ไม่ต้องตั้งค่าเพิ่ม

---

## 4. Vercel setup

### 4.1 Environment variables (แยก Preview / Production คนละค่า)
| Variable | Scope | หมายเหตุ |
|---|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | Preview + Production | expose client ได้ |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Preview + Production | expose client ได้ |
| `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY` | Preview + Production | `pk_live_...` — `payment-panel.tsx` ใช้ `loadStripe` |
| `SUPABASE_SERVICE_ROLE_KEY` | Production only (server) | **ห้ามขึ้นต้น `NEXT_PUBLIC_`** — bypass RLS, ใช้ใน webhook เท่านั้น (`lib/supabase/admin.ts`, มี `server-only`) |
| `STRIPE_SECRET_KEY` | Production only (server) | `sk_live_...` |
| `STRIPE_WEBHOOK_SECRET` | Production only (server) | จาก endpoint ข้อ 2 |

ก่อน deploy เปิด Vercel → Settings → Environment Variables เช็คด้วยตาว่าไม่มีตัวไหนสลับ preview-production
— จุดนี้จุดเดียวกัน incident ได้เยอะสุด

### 4.2 Build / region
- Framework Next.js (App Router), Build `npm run build`, Install `npm ci`, Node 18.x+
- Function region ใกล้ Supabase (Seoul) — เลือก APAC ที่ใกล้สุด (Singapore) ดีกว่า default us-east
- **ต้องเป็น HTTPS** (Vercel default) — scanner (`components/checkin-scanner.tsx`) ใช้ `getUserMedia`
  ที่ต้องมี secure context ถึงจะเปิดกล้องได้

### 4.3 Security headers (`next.config.mjs`)
มี `X-Frame-Options: DENY` (enforce — ปิด clickjacking หน้า staff), `X-Content-Type-Options`,
`Referrer-Policy`, `HSTS`, และ **CSP เป็น `Content-Security-Policy-Report-Only`** ก่อน
- หลัง deploy: ทดสอบ checkout (Stripe.js) + realtime (Supabase wss) ให้ครบ แล้วดู CSP violation report
- เมื่อมั่นใจว่า allowlist ครบ (เผื่อเติม `hooks.stripe.com` ใน `frame-src` ถ้า report ฟ้อง) ค่อย **flip
  header name เป็น `Content-Security-Policy`** เพื่อ enforce จริง
- ⚠️ `HSTS preload` ถอนยากภายหลัง — ยืนยันว่าตั้งใจ preload ก่อน submit ไป hstspreload.org

### 4.4 Cron
**ไม่มี Vercel Cron** — hold expiry ทำผ่าน pg_cron ฝั่ง Supabase ล้วน (ข้อ 1.4) อย่าตั้งซ้ำ

---

## 5. Deploy + post-deploy smoke test (production จริง)

```bash
git push origin main      # Vercel build+deploy อัตโนมัติ (หรือ vercel --prod)
```
หลัง deploy **อย่าเพิ่งประกาศ done** — smoke test ก่อน (Stripe test mode หรือ live+PromptPay test bank
เลือกอย่างใดอย่างหนึ่ง ไม่ปนกัน):

**Customer flow**
1. **Provision event/tier** — ยังไม่มี organizer admin UI สร้าง event/tier/quota (ดู debt) → สร้างผ่าน
   SQL/Studio: org + `event(status='published')` + `ticket_tier` + `tier_inventory(quota)`
2. **Login** — `/login` ขอ magic link → กดลิงก์ในเมล → กลับมา login สำเร็จ redirect `/events`
3. **Events → เลือกตั๋ว** — `/events/[id]` เห็น tier + "เหลือ X" (จาก `/api/events/[id]/availability`), เลือก
   qty กด "จองตั๋ว" → reserve สำเร็จไป `/checkout/[orderId]`
4. **จ่าย PromptPay** — หน้า checkout เรียก `/pay` ได้ `clientSecret`, render PromptPay QR (verify shape
   ตามข้อ 2.4), มี countdown จาก `expires_at`; จ่ายด้วย test tooling
5. **Webhook → ตั๋วออก** — order เปลี่ยนเป็น `paid` (ผ่าน realtime/poll หน้าจอเด้งเอง **ไม่ใช่จากผล
   stripe.js**), เห็นตั๋วที่ `/tickets`, เปิด `/tickets/[id]` เห็น **QR render จาก `/api/tickets/[id]/qr`**
6. **Rate limit 429** — ยิง `/api/checkout/reserve` เกิน 20/60s ต่อ user → `429 RATE_LIMITED`

**Staff flow**
7. **Check-in** — user ที่เป็น `org_member` เปิด `/manage/events/[id]/checkin` → สแกน QR ของตั๋วในข้อ 5 →
   เขียว "เช็คอินสำเร็จ"; สแกนซ้ำ → แดง "เช็คอินไปแล้ว" (first-scan-wins); token มั่ว → "ตั๋วไม่ถูกต้อง";
   user ที่ไม่ใช่ staff เปิดหน้านี้ → กดแล้วได้ "ไม่มีสิทธิ์" (403)
8. **Dashboard** — `/manage/events/[id]/dashboard` เห็นยอดลงทะเบียน/อัตราเช็คอิน (gauge)/revenue/per-tier,
   อัปเดตเองทุก 5s + เด้งเมื่อมีคนจ่ายสำเร็จ (realtime)
9. **Hold expiry** — สร้าง order ไม่จ่าย รอเกิน hold → `expire_stale_orders` (pg_cron) เปลี่ยนเป็น expired
   + คืน inventory (ดู `cron.job_run_details`)

**เงื่อนไขผ่าน**: ครบ ไม่มี error ไม่คาด — ข้อ 5 (webhook→ตั๋ว) พังคือความเสี่ยงสูงสุด (เงินเข้าตั๋วไม่ออก)

---

## 6. Rollback plan

**หลักการ**: migration ไม่มี down script → default = **forward-fix** (เขียน migration ใหม่เลขถัดไป
`0014...`) ไม่ revert schema ตรงๆ บน prod ที่มี data จริง

- **Vercel deploy (โค้ด) พัง** → เร็วสุด ปลอดภัยสุด: Dashboard → Deployments → deployment เดิมที่ healthy →
  Promote to Production (หรือ `vercel rollback <url>`) — ไม่แตะ DB, ทำได้ใน 1 นาที
- **Migration apply ไม่ผ่านกลางทาง** → Postgres rollback ทั้ง transaction อัตโนมัติ (ไฟล์ไม่มี `commit`
  แทรก) เช็ค `migration list` ว่าไม่ถูกมาร์ค applied แก้แล้ว push ใหม่
- **Migration ผ่านแต่พฤติกรรมพัง** → เขียน migration ใหม่แก้เฉพาะจุด (เหมือน `0013` ที่แก้ stats) ห้าม
  DROP/ย้อน schema บน prod ที่มี traffic
- **จุด irreversible**: `cron.unschedule('expire-holds')` (ระหว่าง unschedule hold ไม่หมดอายุ inventory
  ค้าง); Refund ที่ยิงไปแล้ว **ย้อนไม่ได้** (แก้ด้วยติดต่อลูกค้า/ออกตั๋วมือ); **ticket check-in ที่ทำไป
  แล้ว** — `status='checked_in'` ไม่มี RPC un-check-in (ถ้าสแกนผิดต้องแก้ด้วย SQL ตรง + audit
  `checked_in_by`)

**กด rollback ทันที (ไม่ debate)**: webhook 500 ต่อเนื่อง / `check_rate_limit` error สูง (fail-closed →
checkout ทั้งระบบ 500) / Security Advisor ERROR ใหม่ / orders ค้าง `pending_payment` เพิ่มไม่ลด

**Pause payment โดยไม่ rollback**: ถ้าเฉพาะ payment พังแต่ reserve/check-in ยังโอเค → ปิด PromptPay ที่
Stripe (Payment methods → deactivate) กัน PI ใหม่, order ค้างจะ expire ผ่าน pg_cron

---

## 7. Monitoring / alerting

เฝ้าด้วยตาสด **30 นาทีแรกหลัง deploy**:

| จุด | ทำไมสำคัญ | ดูที่ไหน |
|---|---|---|
| Stripe webhook failure rate | 500 ต่อเนื่อง = payment ค้างไม่ confirm | Stripe → Webhooks → delivery log |
| Auto-refund fail (`refundPayment` false) | ลูกค้าจ่ายแล้วระบบไม่คืน ไม่ออกตั๋ว | `console.error("Auto-refund failed")` Vercel log |
| `check_rate_limit` RPC error | fail-closed → checkout ทั้งระบบ 500 ทันที | `lib/rate-limit.ts` error → alert error rate ของ reserve/pay/waitlist/**qr**/**checkin** |
| pg_cron ไม่รัน | hold ไม่หมดอายุ, waitlist ไม่ promote | `cron.job_run_details` — end_time ล่าสุดไม่เกิน ~2-3 นาที |
| Orders ค้าง `pending_payment` เกินปกติ | pg_cron ตาย / webhook ไม่มา / PromptPay ช้า | นับ `orders where status='pending_payment' and expires_at<now()` ควร ~0 |
| `rate_limit` table growth | lazy purge ต่อ key เท่านั้น ไม่มี global sweep | `select count(*) from rate_limit` (ดู debt) |

Alert เร่งด่วนสุด: **check_rate_limit error** + **webhook 500** — พังแล้วกระทบทุก checkout ทันที

---

## 8. Known technical debt (ตรงๆ ไม่กลบ)

1. **Frontend ยังไม่เคย compile** — ~40 ไฟล์ Phase 3+4 ยังไม่ผ่าน typecheck/lint/build (เครื่อง dev ไม่มี
   Node) — **ต้องผ่าน CI gate ข้อ 0 ก่อน merge** ความเสี่ยงค้างอันดับ 1
2. **Stripe `next_action` shape ยังไม่ verify กับ test mode** — `payment-panel.tsx` มี TODO (ข้อ 2.4)
3. **PI สถานะ `processing` ใน `/pay`** — เรียก `/pay` ซ้ำระหว่าง PromptPay processing อาจพยายาม cancel PI
   in-flight (Stripe ปฏิเสธ, catch+log) — ยังไม่มี test คลุม race นี้
4. **Free/zero-total order ไม่รองรับ** (`0010`) — ตั๋วฟรี/promo 100% ต้อง design แยก (skip payment)
5. **PromptPay จ่ายหลัง hold หมด = auto-refund ไม่มี revive** — ลูกค้าต้องจองใหม่
6. **Waitlist notification (email/LINE) ยังไม่มี** — `/api/waitlist/join` insert อย่างเดียว, promote แล้ว
   ผู้ใช้ต้องเช็คเอง
7. **rate_limit ไม่มี global pg_cron purge** — lazy purge ต่อ key เท่านั้น, ควรเพิ่ม sweep
   (`delete from rate_limit where window_start < now() - interval '1 day'`) ถ้าปล่อยรันยาว
8. **ไม่มี organizer admin UI** — สร้าง org/event/tier/quota + provision org_member คนแรก ต้องทำผ่าน
   SQL/Studio (out of scope Phase 3+4); ไม่มีหน้า "event ที่ฉันเป็น staff" (dashboard/checkin ต้องรู้
   `eventId` ตรงๆ)
9. **iOS scanner**: `navigator.vibrate` ใช้ไม่ได้บน iOS Safari; beep (Web Audio) อาจถูก autoplay policy
   บล็อกจน user gesture แรก — พึ่งแถบสีเป็นหลัก, verify บนอุปกรณ์จริง
10. **ไม่มี frontend test suite** — vitest ตั้ง `environment: node` (ยกเว้น `safe-redirect.test.ts` ที่
    เป็น pure unit) — component test ต้องเพิ่ม jsdom + @testing-library เป็น phase แยก
11. **CSP ยัง report-only** — ต้อง verify แล้ว flip เป็น enforce (ข้อ 4.3)

---

## สรุปจุดเสี่ยงที่สุด (เรียงตามความรุนแรง)

1. **Frontend ไม่เคย compile** — ต้องผ่าน CI gate ก่อน ไม่งั้น deploy ไปหน้าขาว/build fail
2. **`check_rate_limit` fail-closed** — RPC พัง → reserve/pay/waitlist/qr/checkin 500 ทั้งระบบ (alert #1)
3. **Webhook signature/env ผิด** — `STRIPE_WEBHOOK_SECRET` สลับ/พิมพ์ผิด → ทุก payment verify fail →
   เงินเข้าตั๋วไม่ออก (เช็ค env ข้อ 4.1)
4. **Stripe `next_action` shape / PromptPay QR** — ถ้า field ไม่ตรง QR ไม่ขึ้น จ่ายไม่ได้ (verify test mode)
5. **pg_cron ไม่ enable/รันบน prod** — verify จริง ข้อ 1.4 อย่าเชื่อว่า migration ผ่าน = cron รัน
6. **Magic-link redirect allowlist** — ถ้าไม่ใส่ `/auth/confirm` ใน Supabase allowlist login พังทั้งระบบ
